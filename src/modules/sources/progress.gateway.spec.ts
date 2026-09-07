jest.mock('better-auth', () => ({ betterAuth: jest.fn() }));
jest.mock('better-auth/plugins', () => ({ anonymous: jest.fn() }));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn() }));
jest.mock('../../auth.js', () => ({
  auth: {
    api: {
      getSession: jest.fn(),
    },
  },
  authDatabase: {
    query: jest.fn(),
    end: jest.fn(),
  },
}));

import type { Server } from 'socket.io';

import { auth } from '../../auth.js';
import type { DatabaseService } from '../../common/services/database.service.js';
import type { RedisService } from '../../common/services/redis.service.js';
import { ProgressGateway, type ProgressPayload } from './progress.gateway.js';

describe('ProgressGateway', () => {
  let gateway: ProgressGateway;
  let mockRedisService: Partial<RedisService>;
  let mockDatabaseService: { one: jest.Mock };
  let mockSubscriber: any;
  let mockServer: any;
  let mockRoom: any;

  beforeEach(() => {
    mockSubscriber = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(1),
      unsubscribe: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
      on: jest.fn(),
    };

    mockRedisService = {
      createSubscriber: jest.fn().mockReturnValue(mockSubscriber),
    };

    mockDatabaseService = {
      one: jest.fn(),
    };

    mockRoom = {
      emit: jest.fn(),
    };

    mockServer = {
      emit: jest.fn(),
      to: jest.fn().mockReturnValue(mockRoom),
    };

    gateway = new ProgressGateway(
      mockRedisService as RedisService,
      mockDatabaseService as unknown as DatabaseService,
    );
    (gateway as any).server = mockServer;
  });

  it('emits progress:update event to specific graph room when graphId is present', () => {
    const payload: ProgressPayload = {
      sourceId: 'src-123',
      graphId: 'graph-123',
      nodeId: 'node-123',
      status: 'PROCESSING',
      progress: 45,
    };

    gateway.emitUpdate(payload);

    expect(mockServer.to).toHaveBeenCalledWith('graph:graph-123');
    expect(mockRoom.emit).toHaveBeenCalledWith('progress:update', payload);
  });

  it('falls back to server broadcast when graphId is absent', () => {
    const payload: ProgressPayload = {
      sourceId: 'src-123',
      graphId: '',
      nodeId: 'node-123',
      status: 'PROCESSING',
      progress: 45,
    };

    gateway.emitUpdate(payload);

    expect(mockServer.emit).toHaveBeenCalledWith('progress:update', payload);
  });

  it('authenticates client session during handleConnection', async () => {
    (auth.api.getSession as unknown as jest.Mock).mockResolvedValueOnce({
      user: {
        id: 'user-42',
        email: 'user@example.com',
        name: 'Alice',
        isAnonymous: false,
        subscriptionTier: 'PRO',
      },
    });

    const mockSocket: any = {
      id: 'socket-1',
      handshake: {
        headers: { cookie: 'better-auth.session_token=valid-token' },
        auth: {},
      },
      data: {},
      join: jest.fn().mockResolvedValue(undefined),
    };

    await gateway.handleConnection(mockSocket);

    expect(mockSocket.data.identity).toEqual({
      userId: 'user-42',
      email: 'user@example.com',
      username: 'Alice',
      isGuest: false,
      tier: 'PRO',
    });
    expect(mockSocket.join).toHaveBeenCalledWith('user:user-42');
  });

  it('assigns guest identity during handleConnection when unauthenticated or session fails', async () => {
    (auth.api.getSession as unknown as jest.Mock).mockResolvedValueOnce(null);

    const mockSocket: any = {
      id: 'socket-guest',
      handshake: {
        headers: {},
        auth: {},
      },
      data: {},
    };

    await gateway.handleConnection(mockSocket);

    expect(mockSocket.data.identity).toEqual({
      userId: 'anon-socket-guest',
      email: null,
      username: 'Guest',
      isGuest: true,
      tier: 'ANONYMOUS',
    });
  });

  it('allows joining room when graph is public', async () => {
    mockDatabaseService.one.mockResolvedValueOnce({
      id: 'graph-pub',
      userId: 'owner-99',
      isPublic: true,
    });

    const mockSocket: any = {
      id: 'socket-1',
      data: { identity: { userId: 'any-user' } },
      join: jest.fn().mockResolvedValue(undefined),
    };

    const res = await gateway.handleJoinGraph(mockSocket, {
      graphId: 'graph-pub',
    });

    expect(res).toEqual({ success: true, graphId: 'graph-pub' });
    expect(mockSocket.join).toHaveBeenCalledWith('graph:graph-pub');
  });

  it('allows owner to join private graph room', async () => {
    mockDatabaseService.one.mockResolvedValueOnce({
      id: 'graph-priv',
      userId: 'owner-1',
      isPublic: false,
    });

    const mockSocket: any = {
      id: 'socket-owner',
      data: { identity: { userId: 'owner-1' } },
      join: jest.fn().mockResolvedValue(undefined),
    };

    const res = await gateway.handleJoinGraph(mockSocket, {
      graphId: 'graph-priv',
    });

    expect(res).toEqual({ success: true, graphId: 'graph-priv' });
    expect(mockSocket.join).toHaveBeenCalledWith('graph:graph-priv');
  });

  it('rejects unauthorized user from joining private graph room', async () => {
    mockDatabaseService.one.mockResolvedValueOnce({
      id: 'graph-priv',
      userId: 'owner-1',
      isPublic: false,
    });

    const mockSocket: any = {
      id: 'socket-stranger',
      data: { identity: { userId: 'stranger-2' } },
      join: jest.fn(),
    };

    const res = await gateway.handleJoinGraph(mockSocket, {
      graphId: 'graph-priv',
    });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Forbidden/);
    expect(mockSocket.join).not.toHaveBeenCalled();
  });

  it('returns error when joining non-existent graph room', async () => {
    mockDatabaseService.one.mockResolvedValueOnce(null);

    const mockSocket: any = {
      id: 'socket-1',
      data: {},
      join: jest.fn(),
    };

    const res = await gateway.handleJoinGraph(mockSocket, {
      graphId: 'non-existent',
    });

    expect(res).toEqual({ success: false, error: 'Graph not found' });
    expect(mockSocket.join).not.toHaveBeenCalled();
  });

  it('leaves room on leave:graph message', async () => {
    const mockSocket: any = {
      id: 'socket-1',
      leave: jest.fn().mockResolvedValue(undefined),
    };

    const res = await gateway.handleLeaveGraph(mockSocket, {
      graphId: 'graph-123',
    });

    expect(res).toEqual({ success: true, graphId: 'graph-123' });
    expect(mockSocket.leave).toHaveBeenCalledWith('graph:graph-123');
  });

  it('subscribes to Redis channels on module init and forwards messages to graph room and user room', async () => {
    let messageHandler:
      ((channel: string, message: string) => void) | undefined;
    mockSubscriber.on.mockImplementation((event: string, handler: any) => {
      if (event === 'message') {
        messageHandler = handler;
      }
    });

    await gateway.onModuleInit();

    expect(mockRedisService.createSubscriber).toHaveBeenCalled();
    expect(mockSubscriber.subscribe).toHaveBeenCalledWith(
      'source:progress',
      'notification:new',
    );
    expect(messageHandler).toBeDefined();

    const incoming: ProgressPayload = {
      sourceId: 'src-456',
      graphId: 'graph-456',
      nodeId: 'node-456',
      status: 'READY',
      progress: 100,
    };

    messageHandler!('source:progress', JSON.stringify(incoming));

    expect(mockServer.to).toHaveBeenCalledWith('graph:graph-456');
    expect(mockRoom.emit).toHaveBeenCalledWith('progress:update', incoming);

    const incomingNotif = {
      userId: 'user-999',
      notification: { id: 'notif-99', title: 'Sweep Warning' },
    };

    messageHandler!('notification:new', JSON.stringify(incomingNotif));

    expect(mockServer.to).toHaveBeenCalledWith('user:user-999');
    expect(mockRoom.emit).toHaveBeenCalledWith(
      'notification:new',
      incomingNotif.notification,
    );
  });

  it('ignores messages on other channels or with invalid JSON', async () => {
    let messageHandler:
      ((channel: string, message: string) => void) | undefined;
    mockSubscriber.on.mockImplementation((event: string, handler: any) => {
      if (event === 'message') {
        messageHandler = handler;
      }
    });

    await gateway.onModuleInit();

    // Wrong channel
    messageHandler!('other:channel', JSON.stringify({ progress: 50 }));
    expect(mockRoom.emit).not.toHaveBeenCalled();

    // Malformed JSON on progress
    messageHandler!('source:progress', 'not-json');
    expect(mockRoom.emit).not.toHaveBeenCalled();

    // Malformed JSON on notification
    messageHandler!('notification:new', 'not-json');
    expect(mockRoom.emit).not.toHaveBeenCalled();
  });

  it('unsubscribes and quits Redis subscriber on module destroy', async () => {
    await gateway.onModuleInit();
    await gateway.onModuleDestroy();

    expect(mockSubscriber.unsubscribe).toHaveBeenCalledWith(
      'source:progress',
      'notification:new',
    );
    expect(mockSubscriber.quit).toHaveBeenCalled();
  });
});

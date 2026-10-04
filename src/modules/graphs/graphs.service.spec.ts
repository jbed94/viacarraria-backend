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

import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthorizationService } from '../../common/authorization/ability.js';
import { DatabaseService } from '../../common/services/database.service.js';
import type { ViewerIdentity } from '../../common/types.js';
import { AuthService } from '../auth/auth.service.js';
import { GraphsService } from './graphs.service.js';

describe('GraphsService', () => {
  let service: GraphsService;
  let mockDb: {
    query: jest.Mock;
    one: jest.Mock;
  };
  let mockAuth: {
    requireIdentity: jest.Mock;
    requireRegistered: jest.Mock;
  };
  let mockAuthorization: AuthorizationService;

  const freeUser: ViewerIdentity = {
    userId: 'user-free',
    tier: 'REGISTERED',
    email: 'free@example.com',
    username: 'freeuser',
    isGuest: false,
  };

  const proUser: ViewerIdentity = {
    userId: 'user-pro',
    tier: 'REGISTERED',
    email: 'pro@example.com',
    username: 'prouser',
    isGuest: false,
  };

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
      one: jest.fn(),
    };
    mockAuth = {
      requireIdentity: jest.fn((id: ViewerIdentity): ViewerIdentity => id),
      requireRegistered: jest.fn((id: ViewerIdentity): ViewerIdentity => id),
    };
    mockAuthorization = {
      can: jest.fn().mockReturnValue(true),
      assertCan: jest.fn(),
    };

    const config = {
      get: jest.fn().mockReturnValue('/tmp/uploads'),
    } as unknown as ConfigService;

    service = new GraphsService(
      mockDb as unknown as DatabaseService,
      mockAuth as unknown as AuthService,
      mockAuthorization,
      config,
    );
  });

  describe('create and quota validation', () => {
    it('creates a private graph when user has not exceeded the 2 private graphs quota', async () => {
      mockDb.one.mockImplementation((sql: string) => {
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve({ total: '1', privateCount: '1' });
        }
        if (sql.includes('FROM "Graph" WHERE "id" = $1')) {
          return Promise.resolve({
            id: 'graph-new',
            title: 'Private Graph',
            description: null,
            userId: freeUser.userId,
            isPublic: false,
            isPrepared: false,
            nodes: [],
            edges: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        if (sql.includes('FROM "GraphAttachment"')) {
          return Promise.resolve({ count: '0' });
        }
        if (sql.includes('FROM "User"')) {
          return Promise.resolve({ name: 'Free User' });
        }
        return Promise.resolve(undefined);
      });
      mockDb.query.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO "Graph"')) {
          return Promise.resolve([
            {
              id: 'graph-new',
              title: 'Private Graph',
              description: null,
              userId: freeUser.userId,
              isPublic: false,
              isPrepared: false,
              nodes: [],
              edges: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.create(freeUser, {
        title: 'Private Graph',
        isPublic: false,
      });
      expect(result.id).toBe('graph-new');
      expect(result.isPublic).toBe(false);
    });

    it('allows creating a public graph for registered user', async () => {
      mockDb.one.mockImplementation((sql: string) => {
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve({ total: '10', privateCount: '5' });
        }
        if (sql.includes('FROM "Graph" WHERE "id" = $1')) {
          return Promise.resolve({
            id: 'graph-public',
            title: 'Public Graph',
            description: null,
            userId: freeUser.userId,
            isPublic: true,
            isPrepared: false,
            nodes: [],
            edges: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        if (sql.includes('FROM "GraphAttachment"')) {
          return Promise.resolve({ count: '0' });
        }
        if (sql.includes('FROM "User"')) {
          return Promise.resolve({ name: 'Registered User' });
        }
        return Promise.resolve(undefined);
      });
      mockDb.query.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO "Graph"')) {
          return Promise.resolve([
            {
              id: 'graph-public',
              title: 'Public Graph',
              description: null,
              userId: freeUser.userId,
              isPublic: true,
              isPrepared: false,
              nodes: [],
              edges: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.create(freeUser, {
        title: 'Public Graph',
        isPublic: true,
      });
      expect(result.id).toBe('graph-public');
      expect(result.isPublic).toBe(true);
    });

    it('rejects creating graphs for anonymous guests', async () => {
      mockAuth.requireRegistered.mockImplementationOnce(() => {
        throw new ForbiddenException(
          'Anonymous guests cannot create or own graphs. Create a free registered account to build unlimited knowledge graphs.',
        );
      });
      const guestViewer: ViewerIdentity = {
        userId: 'guest-id',
        tier: 'ANONYMOUS',
        email: null,
        username: null,
        isGuest: true,
      };

      await expect(
        service.create(guestViewer, {
          title: 'Guest Graph',
          isPublic: false,
        }),
      ).rejects.toThrow('Anonymous guests cannot create or own graphs');
    });
  });

  describe('updateVisibility and viewer detachment', () => {
    it('deletes all attached viewers when visibility changes from Public to Private', async () => {
      let currentIsPublic = true;
      mockDb.one.mockImplementation((sql: string) => {
        if (sql.includes('FROM "Graph" WHERE "id" = $1')) {
          return Promise.resolve({
            id: 'graph-1',
            title: 'My Graph',
            userId: freeUser.userId,
            isPublic: currentIsPublic,
            isPrepared: false,
            nodes: [],
            edges: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return Promise.resolve({ privateCount: '0' });
        }
        if (sql.includes('FROM "GraphAttachment"')) {
          return Promise.resolve({ count: '0' });
        }
        if (sql.includes('FROM "User"')) {
          return Promise.resolve({ name: 'Free User' });
        }
        return Promise.resolve(undefined);
      });

      mockDb.query.mockImplementation((sql: string) => {
        if (sql.includes('UPDATE "Graph"')) {
          currentIsPublic = false;
          return Promise.resolve([
            {
              id: 'graph-1',
              title: 'My Graph',
              userId: freeUser.userId,
              isPublic: false,
              isPrepared: false,
              nodes: [],
              edges: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const updated = await service.updateVisibility(
        freeUser,
        'graph-1',
        false,
      );
      expect(updated.isPublic).toBe(false);

      const deleteAttachmentsCall = (
        mockDb.query.mock.calls as unknown as [string, string[]][]
      ).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes(
            'DELETE FROM "GraphAttachment" WHERE "graphId" = $1',
          ),
      );
      expect(deleteAttachmentsCall).toBeDefined();
      expect(deleteAttachmentsCall?.[1]).toEqual(['graph-1']);
    });

    it('allows registered users to enable retention exemption', async () => {
      mockDb.one.mockImplementation((sql: string) => {
        if (sql.includes('FROM "Graph" WHERE "id" = $1')) {
          return Promise.resolve({
            id: 'graph-pro-1',
            title: 'PRO Graph',
            userId: proUser.userId,
            isPublic: false,
            isPrepared: false,
            isExemptFromRetention: false,
            nodes: [],
            edges: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        if (sql.includes('FROM "GraphAttachment"')) {
          return Promise.resolve({ count: '0' });
        }
        if (sql.includes('FROM "User"')) {
          return Promise.resolve({ name: 'Pro User' });
        }
        return Promise.resolve(undefined);
      });

      mockDb.query.mockImplementation((sql: string) => {
        if (sql.includes('UPDATE "Graph"')) {
          return Promise.resolve([
            {
              id: 'graph-pro-1',
              title: 'PRO Graph',
              userId: proUser.userId,
              isPublic: false,
              isPrepared: false,
              isExemptFromRetention: true,
              nodes: [],
              edges: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const updated = await service.updateSettings(proUser, 'graph-pro-1', {
        isExemptFromRetention: true,
      });
      expect(updated.id).toBe('graph-pro-1');
    });
  });

  describe('attach and detach', () => {
    it('attaches a user to a public graph', async () => {
      mockDb.one.mockImplementation((sql: string) => {
        if (sql.includes('FROM "Graph" WHERE "id" = $1')) {
          return Promise.resolve({
            id: 'graph-pub',
            title: 'Shared Graph',
            userId: 'other-user',
            isPublic: true,
            isPrepared: false,
            nodes: [],
            edges: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        if (sql.includes('FROM "GraphAttachment" WHERE "graphId" = $1')) {
          return Promise.resolve({ count: '3' });
        }
        if (sql.includes('SELECT 1 FROM "GraphAttachment"')) {
          return Promise.resolve({ 1: 1 });
        }
        if (sql.includes('FROM "User"')) {
          return Promise.resolve({ name: 'Author' });
        }
        return Promise.resolve(undefined);
      });

      mockDb.query.mockResolvedValue([]);

      const result = await service.attach(freeUser, 'graph-pub');
      expect(result.id).toBe('graph-pub');

      const insertCall = (
        mockDb.query.mock.calls as unknown as [string, string[]][]
      ).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('INSERT INTO "GraphAttachment"'),
      );
      expect(insertCall).toBeDefined();
    });

    it('rejects attaching to a private graph', async () => {
      mockDb.one.mockResolvedValueOnce({
        id: 'graph-priv',
        title: 'Secret Graph',
        userId: 'other-user',
        isPublic: false,
        isPrepared: false,
        nodes: [],
        edges: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expect(service.attach(freeUser, 'graph-priv')).rejects.toThrow(
        'Cannot attach to a private graph.',
      );
    });

    it('detaches a user from a graph', async () => {
      mockDb.query.mockResolvedValue([]);
      await service.detach(freeUser, 'graph-pub');

      const deleteCall = (
        mockDb.query.mock.calls as unknown as [string, string[]][]
      ).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('DELETE FROM "GraphAttachment" WHERE "userId" = $1'),
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall?.[1]).toEqual([freeUser.userId, 'graph-pub']);
    });
  });

  describe('list', () => {
    it('queries graphs with user isolation ensuring private graphs of other users are excluded', async () => {
      mockDb.query.mockResolvedValueOnce([
        {
          id: 'graph-owned',
          title: 'My Custom Graph',
          description: 'Personal notes',
          userId: freeUser.userId,
          isPublic: false,
          isPrepared: false,
          nodes: [],
          edges: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      mockDb.one.mockResolvedValue(null);

      const result = await service.list(freeUser);

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('graph-owned');
      expect(result[0]!.isOwned).toBe(true);

      const querySql = mockDb.query.mock.calls[0][0] as string;
      const params = mockDb.query.mock.calls[0][1] as string[];
      expect(querySql).toContain('g."userId" = $1');
      expect(querySql).toContain('g."isPublic" = true');
      expect(querySql).not.toContain('OR (g."isPrepared" = true)');
      expect(params).toEqual([freeUser.userId]);
    });
  });

  describe('listPublic', () => {
    it('returns public graphs with viewerCount, nodeCount, and sourceCount', async () => {
      mockDb.query.mockResolvedValueOnce([
        {
          id: 'graph-1',
          title: 'Data Structures',
          description: 'Trees and Graphs',
          userId: 'author-1',
          isPublic: true,
          isPrepared: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          nodeCount: 8,
          sourceCount: 2,
          viewerCount: 5,
          isOwned: false,
          isAttached: true,
          ownerName: 'Alice',
        },
      ]);

      const list = await service.listPublic(freeUser, 'Data');
      expect(list).toHaveLength(1);
      expect(list[0]!.title).toBe('Data Structures');
      expect(list[0]!.viewerCount).toBe(5);
      expect(list[0]!.nodeCount).toBe(8);
      expect(list[0]!.sourceCount).toBe(2);
      expect(list[0]!.isAttached).toBe(true);
      expect(list[0]!.canQuery).toBe(true);
    });
  });

  describe('touchAccess and activity tracking', () => {
    it('executes throttled UPDATE on Graph table with lastAccessedAt and resets scheduledForDeletionAt', async () => {
      mockDb.query.mockResolvedValueOnce([]);
      await service.touchAccess('graph-123');

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('SET "lastAccessedAt" = CURRENT_TIMESTAMP'),
        ['graph-123'],
      );
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('"scheduledForDeletionAt" = NULL'),
        ['graph-123'],
      );
    });

    it('triggers touchAccess on findAccessible', async () => {
      mockDb.one.mockResolvedValueOnce({
        id: 'graph-123',
        title: 'Active Graph',
        userId: 'user-free',
        isPublic: false,
        isPrepared: false,
        nodes: [],
        edges: [],
        lastAccessedAt: new Date(),
        scheduledForDeletionAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDb.query.mockResolvedValueOnce([]);

      const graph = await service.findAccessible(freeUser, 'graph-123');
      expect(graph.id).toBe('graph-123');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE "Graph"'),
        ['graph-123'],
      );
    });
  });

  describe('downloadArchive', () => {
    let mockRetention: any;
    let mockStorage: any;
    let mockRes: any;

    beforeEach(() => {
      mockRetention = {
        getArchiveByGraphId: jest.fn(),
      };
      mockStorage = {
        getObject: jest.fn(),
      };
      mockRes = {
        set: jest.fn(),
      };
      service = new GraphsService(
        mockDb as unknown as DatabaseService,
        mockAuth as unknown as AuthService,
        mockAuthorization,
        { get: jest.fn().mockReturnValue('/tmp/uploads') } as any,
        mockStorage as any,
        undefined,
        mockRetention as any,
      );
    });

    it('throws NotFoundException if no archive found', async () => {
      mockRetention.getArchiveByGraphId.mockResolvedValueOnce(null);
      await expect(
        service.downloadArchive(freeUser, 'graph-missing', mockRes),
      ).rejects.toThrow('No archive available');
    });

    it('throws ForbiddenException if archive does not belong to user', async () => {
      mockRetention.getArchiveByGraphId.mockResolvedValueOnce({
        id: 'arch-1',
        graphId: 'graph-1',
        userId: 'other-user',
        title: 'Other Graph',
        archiveUrl: 'archives/graphs/graph-1.tar.gz',
      });
      await expect(
        service.downloadArchive(freeUser, 'graph-1', mockRes),
      ).rejects.toThrow('You do not own this graph archive');
    });

    it('streams archive and sets attachment headers when user is owner', async () => {
      mockRetention.getArchiveByGraphId.mockResolvedValueOnce({
        id: 'arch-1',
        graphId: 'graph-1',
        userId: freeUser.userId,
        title: 'My Cool Graph',
        archiveUrl: 'archives/graphs/graph-1.tar.gz',
      });
      mockStorage.getObject.mockResolvedValueOnce({
        buffer: Buffer.from('mock tar.gz'),
        contentLength: 11,
      });

      const streamable = await service.downloadArchive(
        freeUser,
        'graph-1',
        mockRes,
      );
      expect(streamable).toBeDefined();
      expect(mockRes.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Type': 'application/gzip',
          'Content-Disposition':
            'attachment; filename="My_Cool_Graph_archive.tar.gz"',
          'Content-Length': '11',
        }),
      );
    });
  });

  describe('restoreArchive', () => {
    it('calls retentionService.restoreGraphFromArchive with userId', async () => {
      const mockRetention = {
        restoreGraphFromArchive: jest.fn().mockResolvedValue({
          id: 'graph-1',
          title: 'Restored',
          userId: freeUser.userId,
          sourceCount: 1,
          restored: true,
        }),
      };

      service = new GraphsService(
        mockDb as unknown as DatabaseService,
        mockAuth as unknown as AuthService,
        mockAuthorization,
        { get: jest.fn().mockReturnValue('/tmp/uploads') } as any,
        undefined,
        undefined,
        mockRetention as any,
      );

      const res = await service.restoreArchive(freeUser, 'graph-1');
      expect(res.restored).toBe(true);
      expect(mockRetention.restoreGraphFromArchive).toHaveBeenCalledWith(
        'graph-1',
        freeUser.userId,
        false,
      );
    });
  });

  describe('keepActive', () => {
    it('cancels scheduled deletion, updates lastAccessedAt, and returns graph', async () => {
      const mockRetention = {
        cancelScheduledDeletion: jest.fn().mockResolvedValue(true),
      };

      mockDb.one.mockResolvedValueOnce({
        id: 'graph-1',
        title: 'Expiring Graph',
        userId: freeUser.userId,
        isPublic: false,
        isPrepared: true,
        nodes: [],
        edges: [],
        lastAccessedAt: new Date(Date.now() - 95 * 24 * 60 * 60 * 1000),
        scheduledForDeletionAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDb.query.mockResolvedValueOnce([]); // UPDATE query

      service = new GraphsService(
        mockDb as unknown as DatabaseService,
        mockAuth as unknown as AuthService,
        mockAuthorization,
        { get: jest.fn().mockReturnValue('/tmp/uploads') } as any,
        undefined,
        undefined,
        mockRetention as any,
      );

      // mock get
      jest.spyOn(service, 'get').mockResolvedValueOnce({
        id: 'graph-1',
        title: 'Expiring Graph',
        description: null,
        userId: freeUser.userId,
        isPublic: false,
        isPrepared: true,
        nodes: [],
        edges: [],
        isOwned: true,
        permission: 'OWNER',
        canEdit: true,
        accessCount: 1,
        viewerCount: 1,
        ownerName: 'Free User',
        isAttached: false,
        canQuery: true,
        scheduledForDeletionAt: null,
        sources: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await service.keepActive(freeUser, 'graph-1');
      expect(res.id).toBe('graph-1');
      expect(mockRetention.cancelScheduledDeletion).toHaveBeenCalledWith(
        'graph-1',
      );
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('"scheduledForDeletionAt" = NULL'),
        ['graph-1'],
      );
    });

    it('throws NotFoundException if graph is missing', async () => {
      mockDb.one.mockResolvedValueOnce(null);
      await expect(service.keepActive(freeUser, 'graph-404')).rejects.toThrow(
        'Graph not found.',
      );
    });
  });

  describe('vocabulary cache invalidation', () => {
    let mockRedis: { del: jest.Mock };
    let serviceWithRedis: GraphsService;

    beforeEach(() => {
      mockRedis = {
        del: jest.fn().mockResolvedValue(1),
      };
      const config = {
        get: jest.fn().mockReturnValue('/tmp/uploads'),
      } as unknown as ConfigService;

      serviceWithRedis = new GraphsService(
        mockDb as unknown as DatabaseService,
        mockAuth as unknown as AuthService,
        mockAuthorization,
        config,
        undefined,
        undefined,
        undefined,
        mockRedis as any,
      );
    });

    it('invalidates graph vocabulary cache when canvas is updated', async () => {
      mockDb.one.mockResolvedValue({
        id: 'graph-1',
        title: 'Test Graph',
        description: null,
        userId: freeUser.userId,
        isPublic: false,
        isPrepared: false,
        nodes: [{ id: 'node-1', label: 'Node 1' }],
        edges: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDb.query.mockImplementation((sql: string) => {
        if (sql.includes('UPDATE "Graph" SET "nodes"')) {
          return Promise.resolve([
            {
              id: 'graph-1',
              title: 'Test Graph',
              description: null,
              userId: freeUser.userId,
              isPublic: false,
              isPrepared: false,
              nodes: [{ id: 'node-1', label: 'Updated Node' }],
              edges: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]);
        }
        return Promise.resolve([]);
      });
      jest
        .spyOn(serviceWithRedis, 'get')
        .mockResolvedValue({ id: 'graph-1' } as any);

      await serviceWithRedis.update(freeUser, 'graph-1', {
        nodes: [
          {
            id: 'node-1',
            position: { x: 0, y: 0 },
            data: { title: 'Updated Node' },
          } as any,
        ],
        edges: [],
      });

      expect(mockRedis.del).toHaveBeenCalledWith('graph:graph-1:vocabulary');
    });

    it('invalidates graph and source vocabulary cache on graph deletion', async () => {
      mockDb.one.mockResolvedValue({
        id: 'graph-1',
        title: 'Test Graph',
        description: null,
        userId: freeUser.userId,
        isPublic: false,
        isPrepared: false,
        nodes: [],
        edges: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDb.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM "NodeSource" WHERE "graphId" = $1')) {
          return Promise.resolve([
            { id: 'src-1', fileUrl: 'seed://test' },
            { id: 'src-2', fileUrl: 'seed://test2' },
          ]);
        }
        return Promise.resolve([]);
      });

      await serviceWithRedis.delete(freeUser, 'graph-1');

      expect(mockRedis.del).toHaveBeenCalledWith('graph:graph-1:vocabulary');
      expect(mockRedis.del).toHaveBeenCalledWith('source:src-1:vocabulary');
      expect(mockRedis.del).toHaveBeenCalledWith('source:src-2:vocabulary');
    });
  });
});

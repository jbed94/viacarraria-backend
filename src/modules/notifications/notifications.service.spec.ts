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

import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { DatabaseService } from '../../common/services/database.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import type { ViewerIdentity } from '../../common/types.js';
import { AuthService } from '../auth/auth.service.js';
import { NotificationsService } from './notifications.service.js';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let database: {
    query: jest.Mock;
    one: jest.Mock;
  };
  let auth: {
    requireIdentity: jest.Mock;
    requireRegistered: jest.Mock;
  };
  let redis: {
    publish: jest.Mock;
  };

  const mockUser: ViewerIdentity = {
    userId: 'user-123',
    email: 'user@example.com',
    username: 'user123',
    isGuest: false,
    tier: 'REGISTERED',
  };

  const mockGuest: ViewerIdentity = {
    userId: 'guest-123',
    email: null,
    username: null,
    isGuest: true,
    tier: 'ANONYMOUS',
  };

  beforeEach(async () => {
    database = {
      query: jest.fn(),
      one: jest.fn(),
    };
    auth = {
      requireIdentity: jest.fn((id) => id),
      requireRegistered: jest.fn((id) => {
        if (!id || id.isGuest) throw new UnauthorizedException();
        return id;
      }),
    };
    redis = {
      publish: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: DatabaseService, useValue: database },
        { provide: AuthService, useValue: auth },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it('returns empty list and 0 unread for guest or undefined identity', async () => {
    const result = await service.list(mockGuest);
    expect(result).toEqual({ items: [], unreadCount: 0 });
    expect(database.query).not.toHaveBeenCalled();
  });

  it('lists notifications and unread count for registered user', async () => {
    const now = new Date();
    database.query.mockResolvedValue([
      {
        id: 'notif-1',
        userId: 'user-123',
        type: 'GRAPH_INACTIVITY_WARNING',
        title: 'Graph scheduled for deletion',
        message: 'Graph Test is scheduled for deletion.',
        data: { graphId: 'g-1' },
        isRead: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    database.one.mockResolvedValue({ count: '1' });

    const result = await service.list(mockUser);
    expect(result.unreadCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe('notif-1');
  });

  it('marks a notification as read', async () => {
    const now = new Date();
    database.query.mockResolvedValue([
      {
        id: 'notif-1',
        userId: 'user-123',
        type: 'SYSTEM',
        title: 'Welcome',
        message: 'Welcome!',
        data: null,
        isRead: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await service.markAsRead(mockUser, 'notif-1');
    expect(result.isRead).toBe(true);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "Notification"'),
      ['notif-1', 'user-123'],
    );
  });

  it('throws NotFoundException when marking nonexistent notification as read', async () => {
    database.query.mockResolvedValue([]);
    await expect(service.markAsRead(mockUser, 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('marks all notifications as read', async () => {
    database.query.mockResolvedValue([{ id: 'notif-1' }, { id: 'notif-2' }]);
    const result = await service.markAllAsRead(mockUser);
    expect(result.count).toBe(2);
  });

  it('deletes a notification', async () => {
    database.query.mockResolvedValue([]);
    await service.delete(mockUser, 'notif-1');
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "Notification"'),
      ['notif-1', 'user-123'],
    );
  });

  it('creates an in-app notification', async () => {
    const now = new Date();
    database.query.mockResolvedValue([
      {
        id: 'new-notif',
        userId: 'user-123',
        type: 'GRAPH_INACTIVITY_WARNING',
        title: 'Warning',
        message: 'Inactive graph',
        data: { graphId: 'g-1' },
        isRead: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await service.createNotification('user-123', {
      type: 'GRAPH_INACTIVITY_WARNING',
      title: 'Warning',
      message: 'Inactive graph',
      data: { graphId: 'g-1' },
    });

    expect(result.id).toBe('new-notif');
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "Notification"'),
      expect.arrayContaining([
        'user-123',
        'GRAPH_INACTIVITY_WARNING',
        'Warning',
      ]),
    );
    expect(redis.publish).toHaveBeenCalledWith(
      'notification:new',
      expect.stringContaining('"userId":"user-123"'),
    );
  });

  it('checks for recent warnings correctly', async () => {
    database.one.mockResolvedValue({ count: '1' });
    const hasRecent = await service.hasRecentWarning('user-123', 'g-1', 7);
    expect(hasRecent).toBe(true);
    expect(database.one).toHaveBeenCalledWith(
      expect.stringContaining('WHERE "userId" = $1'),
      ['user-123', 'g-1', '7'],
    );
  });
});

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

import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
  let mockAuthorization: {
    can: jest.Mock;
    assertCan: jest.Mock;
  };

  const freeUser: ViewerIdentity = {
    userId: 'user-free',
    tier: 'FREE',
    email: 'free@example.com',
    username: 'freeuser',
    isGuest: false,
  };

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
      one: jest.fn(),
    };
    mockAuth = {
      requireIdentity: jest.fn((id) => id),
      requireRegistered: jest.fn((id) => id),
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
      mockAuthorization as unknown as AuthorizationService,
      config,
    );
  });

  describe('create and quota validation', () => {
    it('creates a private graph when user has not exceeded the 2 private graphs quota', async () => {
      mockDb.one.mockImplementation(async (sql: string) => {
        if (sql.includes('COUNT(*)')) {
          return { total: '1', privateCount: '1' };
        }
        if (sql.includes('FROM "Graph" WHERE "id" = $1')) {
          return {
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
          };
        }
        if (sql.includes('FROM "GraphAttachment"')) {
          return { count: '0' };
        }
        if (sql.includes('FROM "User"')) {
          return { name: 'Free User' };
        }
        return undefined;
      });
      mockDb.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO "Graph"')) {
          return [
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
          ];
        }
        return [];
      });

      const result = await service.create(freeUser, {
        title: 'Private Graph',
        isPublic: false,
      });
      expect(result.id).toBe('graph-new');
      expect(result.isPublic).toBe(false);
    });

    it('rejects creating a private graph if Free user already has 2 private graphs', async () => {
      mockDb.one.mockResolvedValueOnce({ total: '2', privateCount: '2' });

      await expect(
        service.create(freeUser, {
          title: 'Third Private Graph',
          isPublic: false,
        }),
      ).rejects.toThrow(
        'Free accounts can have up to two private graphs. Upgrade to Pro for unlimited private graphs.',
      );
    });

    it('allows creating a public graph if Free user has 2 private graphs but under 5 total graphs', async () => {
      mockDb.one.mockImplementation(async (sql: string) => {
        if (sql.includes('COUNT(*)')) {
          return { total: '2', privateCount: '2' };
        }
        if (sql.includes('FROM "Graph" WHERE "id" = $1')) {
          return {
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
          };
        }
        if (sql.includes('FROM "GraphAttachment"')) {
          return { count: '0' };
        }
        if (sql.includes('FROM "User"')) {
          return { name: 'Free User' };
        }
        return undefined;
      });
      mockDb.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO "Graph"')) {
          return [
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
          ];
        }
        return [];
      });

      const result = await service.create(freeUser, {
        title: 'Public Graph',
        isPublic: true,
      });
      expect(result.id).toBe('graph-public');
      expect(result.isPublic).toBe(true);
    });

    it('rejects creating any graph if Free user has reached 5 total graphs', async () => {
      mockDb.one.mockResolvedValueOnce({ total: '5', privateCount: '1' });

      await expect(
        service.create(freeUser, {
          title: 'Sixth Graph',
          isPublic: true,
        }),
      ).rejects.toThrow('Your plan supports up to 5 custom graphs.');
    });
  });

  describe('updateVisibility and viewer detachment', () => {
    it('deletes all attached viewers when visibility changes from Public to Private', async () => {
      let currentIsPublic = true;
      mockDb.one.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM "Graph" WHERE "id" = $1')) {
          return {
            id: 'graph-1',
            title: 'My Graph',
            userId: freeUser.userId,
            isPublic: currentIsPublic,
            isPrepared: false,
            nodes: [],
            edges: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        if (sql.includes('COUNT(*) FILTER')) {
          return { privateCount: '0' };
        }
        if (sql.includes('FROM "GraphAttachment"')) {
          return { count: '0' };
        }
        if (sql.includes('FROM "User"')) {
          return { name: 'Free User' };
        }
        return undefined;
      });

      mockDb.query.mockImplementation(async (sql: string) => {
        if (sql.includes('UPDATE "Graph"')) {
          currentIsPublic = false;
          return [
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
          ];
        }
        return [];
      });

      const updated = await service.updateVisibility(
        freeUser,
        'graph-1',
        false,
      );
      expect(updated.isPublic).toBe(false);

      const deleteAttachmentsCall = mockDb.query.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          call[0].includes(
            'DELETE FROM "GraphAttachment" WHERE "graphId" = $1',
          ),
      );
      expect(deleteAttachmentsCall).toBeDefined();
      expect(deleteAttachmentsCall[1]).toEqual(['graph-1']);
    });
  });

  describe('attach and detach', () => {
    it('attaches a user to a public graph', async () => {
      mockDb.one.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM "Graph" WHERE "id" = $1')) {
          return {
            id: 'graph-pub',
            title: 'Shared Graph',
            userId: 'other-user',
            isPublic: true,
            isPrepared: false,
            nodes: [],
            edges: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        if (sql.includes('FROM "GraphAttachment" WHERE "graphId" = $1')) {
          return { count: '3' };
        }
        if (sql.includes('SELECT 1 FROM "GraphAttachment"')) {
          return { 1: 1 };
        }
        if (sql.includes('FROM "User"')) {
          return { name: 'Author' };
        }
        return undefined;
      });

      mockDb.query.mockResolvedValue([]);

      const result = await service.attach(freeUser, 'graph-pub');
      expect(result.id).toBe('graph-pub');

      const insertCall = mockDb.query.mock.calls.find(
        (call: unknown[]) =>
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

      const deleteCall = mockDb.query.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          call[0].includes('DELETE FROM "GraphAttachment" WHERE "userId" = $1'),
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall[1]).toEqual([freeUser.userId, 'graph-pub']);
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
});

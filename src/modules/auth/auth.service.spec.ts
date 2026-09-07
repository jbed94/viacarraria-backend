jest.mock('better-auth', () => ({ betterAuth: jest.fn() }));
jest.mock('better-auth/plugins', () => ({ anonymous: jest.fn() }));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn() }));
jest.mock('../../auth.js', () => ({
  auth: {
    api: {
      getSession: jest.fn(),
      changePassword: jest.fn(),
      revokeSession: jest.fn(),
      deleteUser: jest.fn(),
    },
  },
}));

import {
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { auth } from '../../auth.js';
import type { DatabaseService } from '../../common/services/database.service.js';
import type { RedisService } from '../../common/services/redis.service.js';
import type {
  AuthenticatedRequest,
  ViewerIdentity,
} from '../../common/types.js';
import { AuthService } from './auth.service.js';

describe('AuthService', () => {
  let service: AuthService;
  let mockDatabase: Partial<DatabaseService>;
  let mockRedis: Partial<RedisService>;

  const guestIdentity: ViewerIdentity = {
    userId: 'guest-anon-1',
    email: 'guest-anon-1@anonymous.local',
    username: 'Guest',
    isGuest: true,
    tier: 'ANONYMOUS',
  };

  const freeIdentity: ViewerIdentity = {
    userId: 'user-free-1',
    email: 'free@example.com',
    username: 'FreeUser',
    isGuest: false,
    tier: 'FREE',
  };

  const proIdentity: ViewerIdentity = {
    userId: 'user-pro-1',
    email: 'pro@example.com',
    username: 'ProUser',
    isGuest: false,
    tier: 'PRO',
  };

  beforeEach(() => {
    mockDatabase = {
      one: jest.fn(),
      query: jest.fn(),
    };

    mockRedis = {
      consumeQuota: jest.fn(),
      getDailyUsage: jest.fn(),
      getHourlyUploadUsage: jest.fn(),
    };

    service = new AuthService(
      mockDatabase as DatabaseService,
      mockRedis as RedisService,
    );
  });

  describe('consumeQueryQuota', () => {
    it('enforces limit of 3 queries per day for ANONYMOUS users', async () => {
      (mockRedis.consumeQuota as jest.Mock).mockResolvedValue({
        allowed: true,
        remaining: 2,
      });

      const result = await service.consumeQueryQuota(guestIdentity);

      expect(mockRedis.consumeQuota).toHaveBeenCalledWith('guest-anon-1', 3);
      expect(result).toEqual({ remaining: 2 });
    });

    it('enforces limit of 20 queries per day for FREE users', async () => {
      (mockRedis.consumeQuota as jest.Mock).mockResolvedValue({
        allowed: true,
        remaining: 15,
      });

      const result = await service.consumeQueryQuota(freeIdentity);

      expect(mockRedis.consumeQuota).toHaveBeenCalledWith('user-free-1', 20);
      expect(result).toEqual({ remaining: 15 });
    });

    it('enforces limit of 1000 queries per day for PRO users', async () => {
      (mockRedis.consumeQuota as jest.Mock).mockResolvedValue({
        allowed: true,
        remaining: 990,
      });

      const result = await service.consumeQueryQuota(proIdentity);

      expect(mockRedis.consumeQuota).toHaveBeenCalledWith('user-pro-1', 1000);
      expect(result).toEqual({ remaining: 990 });
    });

    it('throws HTTP 429 Too Many Requests when daily quota is exceeded', async () => {
      (mockRedis.consumeQuota as jest.Mock).mockResolvedValue({
        allowed: false,
        remaining: 0,
      });

      await expect(service.consumeQueryQuota(freeIdentity)).rejects.toThrow(
        new HttpException(
          'Daily query budget reached.',
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
    });
  });

  describe('limits', () => {
    it('returns limits summary with guest restrictions for ANONYMOUS users', async () => {
      (mockDatabase.one as jest.Mock)
        .mockResolvedValueOnce({ total: '0', privateCount: '0' })
        .mockResolvedValueOnce({ maxCount: '0' })
        .mockResolvedValueOnce({ maxCount: '0' });
      (mockRedis.getDailyUsage as jest.Mock).mockResolvedValue(1);
      (mockRedis.getHourlyUploadUsage as jest.Mock).mockResolvedValue(0);

      const limits = await service.limits(guestIdentity);

      expect(limits.tier).toBe('ANONYMOUS');
      expect(limits.graphs).toEqual({ used: 0, limit: 0, exceeded: true });
      expect(limits.privateGraphs).toEqual({
        used: 0,
        limit: 0,
        exceeded: true,
      });
      expect(limits.queries).toEqual({ used: 1, limit: 3, exceeded: false });
      expect(limits.uploads).toEqual({ used: 0, limit: 0, exceeded: true });
      expect(limits.selectedNodes).toEqual({
        used: 0,
        limit: 2,
        exceeded: false,
      });
      expect(limits.nodesPerGraph).toEqual({
        used: 0,
        limit: 0,
        exceeded: true,
      });
      expect(limits.sourcesPerNode).toEqual({
        used: 0,
        limit: 0,
        exceeded: true,
      });
      expect(limits.sourceSizeBytes).toEqual({
        used: 0,
        limit: 0,
        exceeded: true,
      });
      expect(limits.extendedContext).toEqual({
        used: 0,
        limit: 0,
        exceeded: true,
      });
    });

    it('returns Free tier quota limits with exceeded flags when caps are hit', async () => {
      (mockDatabase.one as jest.Mock)
        .mockResolvedValueOnce({ total: '5', privateCount: '2' })
        .mockResolvedValueOnce({ maxCount: '3' })
        .mockResolvedValueOnce({ maxCount: '10' });
      (mockRedis.getDailyUsage as jest.Mock).mockResolvedValue(20);
      (mockRedis.getHourlyUploadUsage as jest.Mock).mockResolvedValue(10);

      const limits = await service.limits(freeIdentity);

      expect(limits.tier).toBe('FREE');
      expect(limits.graphs).toEqual({ used: 5, limit: 5, exceeded: true });
      expect(limits.privateGraphs).toEqual({
        used: 2,
        limit: 2,
        exceeded: true,
      });
      expect(limits.queries).toEqual({ used: 20, limit: 20, exceeded: true });
      expect(limits.uploads).toEqual({ used: 10, limit: 10, exceeded: true });
      expect(limits.selectedNodes).toEqual({
        used: 0,
        limit: 10,
        exceeded: false,
      });
      expect(limits.nodesPerGraph).toEqual({
        used: 10,
        limit: 10,
        exceeded: true,
      });
      expect(limits.sourcesPerNode).toEqual({
        used: 3,
        limit: 3,
        exceeded: true,
      });
      expect(limits.sourceSizeBytes).toEqual({
        used: 0,
        limit: 2 * 1024 * 1024,
        exceeded: false,
      });
      expect(limits.extendedContext).toEqual({
        used: 0,
        limit: 3,
        exceeded: false,
      });
    });

    it('returns Pro tier expanded limits without caps on nodes and sources', async () => {
      (mockDatabase.one as jest.Mock)
        .mockResolvedValueOnce({ total: '12', privateCount: '8' })
        .mockResolvedValueOnce({ maxCount: '25' })
        .mockResolvedValueOnce({ maxCount: '80' });
      (mockRedis.getDailyUsage as jest.Mock).mockResolvedValue(45);
      (mockRedis.getHourlyUploadUsage as jest.Mock).mockResolvedValue(2);

      const limits = await service.limits(proIdentity);

      expect(limits.tier).toBe('PRO');
      expect(limits.graphs).toEqual({ used: 12, limit: 100, exceeded: false });
      expect(limits.privateGraphs).toEqual({
        used: 8,
        limit: 100,
        exceeded: false,
      });
      expect(limits.queries).toEqual({
        used: 45,
        limit: 1000,
        exceeded: false,
      });
      expect(limits.uploads).toEqual({ used: 2, limit: 10, exceeded: false });
      expect(limits.selectedNodes).toEqual({
        used: 0,
        limit: null,
        exceeded: false,
      });
      expect(limits.nodesPerGraph).toEqual({
        used: 80,
        limit: null,
        exceeded: false,
      });
      expect(limits.sourcesPerNode).toEqual({
        used: 25,
        limit: null,
        exceeded: false,
      });
      expect(limits.sourceSizeBytes).toEqual({
        used: 0,
        limit: 1024 * 1024 * 1024,
        exceeded: false,
      });
      expect(limits.extendedContext).toEqual({
        used: 0,
        limit: 15,
        exceeded: false,
      });
    });
  });

  describe('profile & updateProfile', () => {
    it('returns user profile including preferred language', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValue({
        id: 'user-free-1',
        email: 'free@example.com',
        name: 'Free User',
        username: 'freeuser',
        isAnonymous: false,
        subscriptionTier: 'FREE',
        preferredLanguage: 'pl',
      });

      const profile = await service.profile(freeIdentity);

      expect(profile).toEqual({
        userId: 'user-free-1',
        email: 'free@example.com',
        username: 'freeuser',
        isGuest: false,
        tier: 'FREE',
        role: 'user',
        preferredLanguage: 'pl',
      });
    });

    it('rejects guest user attempting to fetch profile', async () => {
      await expect(service.profile(guestIdentity)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException if profile row is missing from DB', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValue(null);

      await expect(service.profile(freeIdentity)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('updates user username and normalized preferred language', async () => {
      // Mock profile() call
      (mockDatabase.one as jest.Mock).mockResolvedValue({
        id: 'user-free-1',
        email: 'free@example.com',
        name: 'Free User',
        username: 'freeuser',
        isAnonymous: false,
        subscriptionTier: 'FREE',
        preferredLanguage: 'en',
      });

      (mockDatabase.query as jest.Mock).mockResolvedValue([
        {
          id: 'user-free-1',
          email: 'free@example.com',
          name: 'updated-name',
          username: 'updated-name',
          isAnonymous: false,
          subscriptionTier: 'FREE',
          preferredLanguage: 'de',
        },
      ]);

      const result = await service.updateProfile(freeIdentity, {
        username: '  updated-name  ',
        preferredLanguage: ' DE ',
      });

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'UPDATE "User" SET "name" = $1, "username" = $1, "preferredLanguage" = $2',
        ),
        ['updated-name', 'de', 'user-free-1'],
      );
      expect(result.username).toBe('updated-name');
      expect(result.preferredLanguage).toBe('de');
    });
  });

  describe('sessions & session management', () => {
    it('returns active non-expired sessions for registered user', async () => {
      const now = new Date();
      const mockSessions = [
        { id: 'sess-1', expiresAt: now, lastUsedAt: now, createdAt: now },
      ];
      (mockDatabase.query as jest.Mock).mockResolvedValue(mockSessions);

      const result = await service.sessions(freeIdentity);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'SELECT "id", "expiresAt", "updatedAt" AS "lastUsedAt"',
        ),
        ['user-free-1'],
      );
      expect(result).toEqual(mockSessions);
    });

    it('revokes an existing user session token', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValue({
        token: 'sess-token-abc',
      });
      (auth.api.revokeSession as unknown as jest.Mock).mockResolvedValue({
        status: true,
      });

      const dummyReq = { headers: {} } as AuthenticatedRequest;
      await service.revokeSession(freeIdentity, dummyReq, 'sess-1');

      expect(mockDatabase.one).toHaveBeenCalledWith(
        expect.stringContaining(
          'SELECT "token" FROM "Session" WHERE "id" = $1 AND "userId" = $2',
        ),
        ['sess-1', 'user-free-1'],
      );
      expect(auth.api.revokeSession).toHaveBeenCalledWith(
        expect.objectContaining({ body: { token: 'sess-token-abc' } }),
      );
    });

    it('throws NotFoundException when revoking a non-existent or other user session', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValue(null);

      const dummyReq = { headers: {} } as AuthenticatedRequest;
      await expect(
        service.revokeSession(freeIdentity, dummyReq, 'non-existent-sess'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('changePassword & deleteProfile', () => {
    it('changes password successfully through auth.api', async () => {
      (auth.api.changePassword as unknown as jest.Mock).mockResolvedValue({
        status: true,
      });
      const dummyReq = { headers: {} } as AuthenticatedRequest;

      await service.changePassword(freeIdentity, dummyReq, {
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword456',
      });

      expect(auth.api.changePassword).toHaveBeenCalledWith(
        expect.objectContaining({
          body: {
            currentPassword: 'oldPassword123',
            newPassword: 'newPassword456',
            revokeOtherSessions: true,
          },
        }),
      );
    });

    it('throws UnauthorizedException when current password is wrong', async () => {
      (auth.api.changePassword as unknown as jest.Mock).mockRejectedValue(
        new Error('Invalid password'),
      );
      const dummyReq = { headers: {} } as AuthenticatedRequest;

      await expect(
        service.changePassword(freeIdentity, dummyReq, {
          currentPassword: 'wrongPassword',
          newPassword: 'newPassword456',
        }),
      ).rejects.toThrow(
        new UnauthorizedException('Current password is incorrect.'),
      );
    });

    it('deletes user profile through auth.api', async () => {
      (auth.api.deleteUser as unknown as jest.Mock).mockResolvedValue({
        status: true,
      });
      const dummyReq = { headers: {} } as AuthenticatedRequest;

      await service.deleteProfile(freeIdentity, dummyReq);

      expect(auth.api.deleteUser).toHaveBeenCalledWith(
        expect.objectContaining({ body: {} }),
      );
    });
  });

  describe('requireIdentity & requireRegistered', () => {
    it('requireIdentity rejects undefined identity', () => {
      expect(() => service.requireIdentity(undefined)).toThrow(
        new UnauthorizedException('A session is required for this action.'),
      );
    });

    it('requireRegistered rejects guest users', () => {
      expect(() => service.requireRegistered(guestIdentity)).toThrow(
        new UnauthorizedException('Create an account to access this action.'),
      );
    });

    it('requireRegistered accepts non-guest users', () => {
      expect(service.requireRegistered(freeIdentity)).toEqual(freeIdentity);
    });
  });
});

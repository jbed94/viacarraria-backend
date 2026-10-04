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

import { NotFoundException, UnauthorizedException } from '@nestjs/common';

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

  const registeredIdentity: ViewerIdentity = {
    userId: 'user-reg-1',
    email: 'reg@example.com',
    username: 'RegUser',
    isGuest: false,
    tier: 'REGISTERED',
  };

  beforeEach(() => {
    mockDatabase = {
      one: jest.fn(),
      query: jest.fn(),
    };

    mockRedis = {
      get: jest.fn().mockResolvedValue('low'),
      set: jest.fn().mockResolvedValue(undefined),
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
    it('returns unblocked query quota for ANONYMOUS users', async () => {
      const result = await service.consumeQueryQuota(guestIdentity);
      expect(result).toEqual({
        remaining: 999999,
        deducted: 0,
        searchSpaceMultiplier: 1.0,
      });
    });

    it('returns unblocked query quota for REGISTERED users', async () => {
      const result = await service.consumeQueryQuota(registeredIdentity);
      expect(result).toEqual({
        remaining: 999999,
        deducted: 0,
        searchSpaceMultiplier: 1.0,
      });
    });
  });

  describe('limits', () => {
    it('returns limits summary with guest restrictions for ANONYMOUS users', async () => {
      (mockDatabase.one as jest.Mock)
        .mockResolvedValueOnce({ total: '0', privateCount: '0' })
        .mockResolvedValueOnce({ maxCount: '0' })
        .mockResolvedValueOnce({ totalBytes: '0' })
        .mockResolvedValueOnce({ value: { defaultStorageLimitMb: 100 } })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ maxCount: '0' });

      (mockRedis.get as jest.Mock).mockResolvedValueOnce('low');

      const limits = await service.limits(guestIdentity);

      expect(limits.tier).toBe('ANONYMOUS');
      expect(limits.canCreateGraphs).toBe(false);
      expect(limits.storage).toEqual({
        usedBytes: 0,
        limitBytes: 0,
        usedMb: 0,
        limitMb: 0,
        exceeded: false,
      });
      expect(limits.queueOccupation).toBe('low');
      expect(limits.crawl).toEqual({
        allowedDepths: ['shallow'],
        maxStartingPoints: 1,
        comparativeModeAllowed: false,
      });
      expect(limits.graphs).toEqual({ used: 0, limit: 0, exceeded: true });
      expect(limits.selectedNodes).toEqual({
        used: 0,
        limit: 2,
        exceeded: false,
      });
      expect(limits.sourceSizeBytes).toEqual({
        used: 0,
        limit: 0,
        exceeded: true,
      });
    });

    it('returns Registered tier limits with storage and graph creation unlocked', async () => {
      (mockDatabase.one as jest.Mock)
        .mockResolvedValueOnce({ total: '5', privateCount: '2' })
        .mockResolvedValueOnce({ maxCount: '3' })
        .mockResolvedValueOnce({ totalBytes: `${50 * 1024 * 1024}` })
        .mockResolvedValueOnce({ value: { defaultStorageLimitMb: 100 } })
        .mockResolvedValueOnce({ storageLimitMb: 100 })
        .mockResolvedValueOnce({ maxCount: '10' });

      (mockRedis.get as jest.Mock).mockResolvedValueOnce('mid');

      const limits = await service.limits(registeredIdentity);

      expect(limits.tier).toBe('REGISTERED');
      expect(limits.canCreateGraphs).toBe(true);
      expect(limits.storage.usedMb).toBe(50);
      expect(limits.storage.limitMb).toBe(100);
      expect(limits.storage.exceeded).toBe(false);
      expect(limits.queueOccupation).toBe('mid');
      expect(limits.crawl).toEqual({
        allowedDepths: ['shallow', 'default', 'deep'],
        maxStartingPoints: 100,
        comparativeModeAllowed: true,
      });
      expect(limits.graphs).toEqual({ used: 5, limit: null, exceeded: false });
      expect(limits.selectedNodes).toEqual({
        used: 0,
        limit: null,
        exceeded: false,
      });
      expect(limits.nodesPerGraph).toEqual({
        used: 10,
        limit: null,
        exceeded: false,
      });
      expect(limits.sourceSizeBytes).toEqual({
        used: 0,
        limit: 50 * 1024 * 1024,
        exceeded: false,
      });
    });
  });

  describe('profile & updateProfile', () => {
    it('returns user profile including preferred language', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValue({
        id: 'user-reg-1',
        email: 'reg@example.com',
        name: 'Registered User',
        username: 'reguser',
        isAnonymous: false,
        subscriptionTier: 'REGISTERED',
        preferredLanguage: 'pl',
      });

      const profile = await service.profile(registeredIdentity);

      expect(profile).toEqual({
        userId: 'user-reg-1',
        email: 'reg@example.com',
        username: 'reguser',
        isGuest: false,
        tier: 'REGISTERED',
        role: 'user',
        preferredLanguage: 'pl',
        storageLimitMb: null,
      });
    });

    it('rejects guest user attempting to fetch profile', async () => {
      await expect(service.profile(guestIdentity)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException if profile row is missing from DB', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValue(null);

      await expect(service.profile(registeredIdentity)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('updates user username and normalized preferred language', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValue({
        id: 'user-reg-1',
        email: 'reg@example.com',
        name: 'Reg User',
        username: 'reguser',
        isAnonymous: false,
        subscriptionTier: 'REGISTERED',
        preferredLanguage: 'en',
      });

      (mockDatabase.query as jest.Mock).mockResolvedValue([
        {
          id: 'user-reg-1',
          email: 'reg@example.com',
          name: 'updated-name',
          username: 'updated-name',
          isAnonymous: false,
          subscriptionTier: 'REGISTERED',
          preferredLanguage: 'de',
        },
      ]);

      const result = await service.updateProfile(registeredIdentity, {
        username: '  updated-name  ',
        preferredLanguage: ' DE ',
      });

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'UPDATE "User" SET "name" = $1, "username" = $1, "preferredLanguage" = $2',
        ),
        ['updated-name', 'de', 'user-reg-1'],
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

      const result = await service.sessions(registeredIdentity);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'SELECT "id", "expiresAt", "updatedAt" AS "lastUsedAt"',
        ),
        ['user-reg-1'],
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
      await service.revokeSession(registeredIdentity, dummyReq, 'sess-1');

      expect(mockDatabase.one).toHaveBeenCalledWith(
        expect.stringContaining(
          'SELECT "token" FROM "Session" WHERE "id" = $1 AND "userId" = $2',
        ),
        ['sess-1', 'user-reg-1'],
      );
      expect(auth.api.revokeSession).toHaveBeenCalledWith(
        expect.objectContaining({ body: { token: 'sess-token-abc' } }),
      );
    });

    it('throws NotFoundException when revoking a non-existent or other user session', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValue(null);

      const dummyReq = { headers: {} } as AuthenticatedRequest;
      await expect(
        service.revokeSession(
          registeredIdentity,
          dummyReq,
          'non-existent-sess',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('changePassword & deleteProfile', () => {
    it('changes password successfully through auth.api', async () => {
      (auth.api.changePassword as unknown as jest.Mock).mockResolvedValue({
        status: true,
      });
      const dummyReq = { headers: {} } as AuthenticatedRequest;

      await service.changePassword(registeredIdentity, dummyReq, {
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
        service.changePassword(registeredIdentity, dummyReq, {
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

      await service.deleteProfile(registeredIdentity, dummyReq);

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
      expect(service.requireRegistered(registeredIdentity)).toEqual(
        registeredIdentity,
      );
    });
  });
});

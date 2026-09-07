jest.mock('better-auth', () => ({ betterAuth: jest.fn() }));
jest.mock('better-auth/plugins', () => ({ anonymous: jest.fn() }));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn() }));
jest.mock('../../auth.js', () => ({
  auth: {
    api: {
      getSession: jest.fn(),
    },
  },
}));

import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';

import type { DatabaseService } from '../../common/services/database.service.js';
import type { ViewerIdentity } from '../../common/types.js';
import type { AuthService } from '../auth/auth.service.js';
import { BillingService } from './billing.service.js';

describe('BillingService', () => {
  let service: BillingService;
  let mockDatabase: Partial<DatabaseService>;
  let mockAuth: Partial<AuthService>;
  let configMap: Record<string, string | undefined>;
  let mockConfig: Partial<ConfigService>;

  const registeredUser: ViewerIdentity = {
    userId: 'user-123',
    email: 'test@example.com',
    username: 'testuser',
    isGuest: false,
    tier: 'FREE',
  };

  const guestUser: ViewerIdentity = {
    userId: 'guest-456',
    email: 'guest-456@anonymous.local',
    username: 'Guest',
    isGuest: true,
    tier: 'ANONYMOUS',
  };

  beforeEach(() => {
    mockDatabase = {
      one: jest.fn(),
      query: jest.fn(),
    };

    mockAuth = {
      requireIdentity: jest.fn((identity) => {
        if (!identity) {
          throw new UnauthorizedException(
            'A session is required for this action.',
          );
        }
        return identity;
      }),
      requireRegistered: jest.fn((identity) => {
        if (identity.isGuest) {
          throw new UnauthorizedException(
            'Create an account to access this action.',
          );
        }
        return identity;
      }),
    };

    configMap = {
      NODE_ENV: 'development',
      LEMON_SQUEEZY_VARIANT_ID: undefined,
      LEMON_SQUEEZY_WEBHOOK_SECRET: 'test-secret-key-123',
    };

    mockConfig = {
      get: jest.fn((key: string) => configMap[key]),
    };

    service = new BillingService(
      mockDatabase as DatabaseService,
      mockAuth as AuthService,
      mockConfig as ConfigService,
    );
  });

  describe('subscription', () => {
    it('returns subscription tier and expiration for registered user', async () => {
      const expiresAt = new Date(Date.now() + 100000);
      (mockDatabase.one as jest.Mock).mockResolvedValue({
        subscriptionTier: 'PRO',
        subscriptionExpiresAt: expiresAt,
      });

      const result = await service.subscription(registeredUser);

      expect(mockDatabase.one).toHaveBeenCalledWith(
        expect.stringContaining('SELECT "subscriptionTier"'),
        ['user-123'],
      );
      expect(result).toEqual({ tier: 'PRO', expiresAt });
    });

    it('rejects unauthenticated requests', async () => {
      await expect(service.subscription(undefined)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects guest anonymous users', async () => {
      await expect(service.subscription(guestUser)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws NotFoundException when user record does not exist in DB', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValue(null);

      await expect(service.subscription(registeredUser)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('checkout', () => {
    it('provides development 30-day PRO auto-upgrade when variant ID is not set', async () => {
      configMap.NODE_ENV = 'development';
      configMap.LEMON_SQUEEZY_VARIANT_ID = undefined;

      const result = await service.checkout(registeredUser, { planId: 'pro' });

      expect(result.checkoutUrl).toBeNull();
      expect(result.subscription.tier).toBe('PRO');
      expect(result.subscription.expiresAt).toBeInstanceOf(Date);

      // Verify DB update
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'UPDATE "User" SET "subscriptionTier" = \'PRO\'',
        ),
        expect.arrayContaining(['user-123']),
      );

      // Verify local billing event record
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "BillingEvent"'),
        expect.arrayContaining([
          'user-123',
          'LOCAL',
          null,
          'development.upgrade',
          JSON.stringify({ planId: 'pro' }),
        ]),
      );
    });

    it('throws ForbiddenException in production when variant ID is missing', async () => {
      configMap.NODE_ENV = 'production';
      configMap.LEMON_SQUEEZY_VARIANT_ID = undefined;

      await expect(
        service.checkout(registeredUser, { planId: 'pro' }),
      ).rejects.toThrow(new ForbiddenException('Billing is not configured.'));
    });

    it('generates Lemon Squeezy checkout URL with user_id parameter when variant ID is configured', async () => {
      configMap.LEMON_SQUEEZY_VARIANT_ID = 'variant_99999';

      (mockDatabase.one as jest.Mock).mockResolvedValue({
        subscriptionTier: 'FREE',
        subscriptionExpiresAt: null,
      });

      const result = await service.checkout(registeredUser, { planId: 'pro' });

      expect(result.checkoutUrl).toBe(
        'https://app.lemonsqueezy.com/checkout/buy/variant_99999?checkout%5Bcustom%5D%5Buser_id%5D=user-123',
      );
      expect(result.subscription).toEqual({ tier: 'FREE', expiresAt: null });

      // Verify Lemon Squeezy billing event record
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "BillingEvent"'),
        expect.arrayContaining([
          'user-123',
          'LEMON_SQUEEZY',
          null,
          'checkout.created',
          JSON.stringify({ planId: 'pro' }),
        ]),
      );
    });
  });

  describe('webhook', () => {
    const webhookSecret = 'test-secret-key-123';

    function signPayload(body: string | Buffer): string {
      return createHmac('sha256', webhookSecret).update(body).digest('hex');
    }

    it('throws ForbiddenException when webhook secret is not configured', async () => {
      configMap.LEMON_SQUEEZY_WEBHOOK_SECRET = undefined;

      await expect(
        service.webhook('any-signature', { data: {} }),
      ).rejects.toThrow(
        new ForbiddenException('Billing webhook is not configured.'),
      );
    });

    it('throws ForbiddenException when signature is missing', async () => {
      await expect(service.webhook(undefined, { data: {} })).rejects.toThrow(
        new ForbiddenException('Invalid billing webhook signature.'),
      );
    });

    it('throws ForbiddenException when signature does not match expected HMAC', async () => {
      const payload = { test: true };
      const raw = Buffer.from(JSON.stringify(payload));
      const invalidSignature = 'a'.repeat(64); // valid length, invalid hash

      await expect(
        service.webhook(invalidSignature, payload, raw),
      ).rejects.toThrow(
        new ForbiddenException('Invalid billing webhook signature.'),
      );
    });

    it('throws ForbiddenException when signature length does not match expected HMAC', async () => {
      const payload = { test: true };
      const invalidLengthSig = 'invalid-short-sig';

      await expect(service.webhook(invalidLengthSig, payload)).rejects.toThrow(
        new ForbiddenException('Invalid billing webhook signature.'),
      );
    });

    it('processes valid webhook and upgrades user to PRO on subscription creation/payment', async () => {
      const payload = {
        meta: {
          custom_data: { user_id: 'user-123' },
        },
        data: {
          id: 'ls_sub_001',
          attributes: { status: 'active' },
        },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const signature = signPayload(rawBody);

      const result = await service.webhook(signature, payload, rawBody);

      expect(result).toEqual({ received: true });
      // Upgrades user to PRO
      expect(mockDatabase.query).toHaveBeenCalledWith(
        'UPDATE "User" SET "subscriptionTier" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2',
        ['PRO', 'user-123'],
      );
      // Records event with externalEventId
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "BillingEvent"'),
        expect.arrayContaining([
          'user-123',
          'LEMON_SQUEEZY',
          'ls_sub_001',
          'webhook.active',
          JSON.stringify(payload),
        ]),
      );
    });

    it('downgrades user to FREE when webhook status is cancelled or expired', async () => {
      const payload = {
        meta: {
          custom_data: { user_id: 'user-123' },
        },
        data: {
          id: 'ls_sub_002',
          attributes: { status: 'cancelled' },
        },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const signature = signPayload(rawBody);

      const result = await service.webhook(signature, payload, rawBody);

      expect(result).toEqual({ received: true });
      expect(mockDatabase.query).toHaveBeenCalledWith(
        'UPDATE "User" SET "subscriptionTier" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2',
        ['FREE', 'user-123'],
      );
    });

    it('safely handles webhook without user_id in custom_data', async () => {
      const payload = {
        meta: {},
        data: { id: 'ls_event_999' },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const signature = signPayload(rawBody);

      const result = await service.webhook(signature, payload, rawBody);

      expect(result).toEqual({ received: true });
      expect(mockDatabase.query).not.toHaveBeenCalled();
    });
  });
});

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

import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';

import type { DatabaseService } from '../../common/services/database.service.js';
import type { AuthService } from '../auth/auth.service.js';
import { BillingService } from './billing.service.js';
import {
  generateWebhookPayload,
  parseArgs,
  sendWebhook,
  signWebhookPayload,
} from '../../scripts/simulate-webhook.js';

describe('Webhook Simulator & Developer Tooling', () => {
  const secret = 'sim-test-secret-key-456';

  describe('generateWebhookPayload', () => {
    it('creates a subscription_created payload with active status', () => {
      const payload = generateWebhookPayload({
        userId: 'user-sim-1',
        eventType: 'subscription_created',
        variantId: 'var-pro-1',
      });

      expect(payload.meta.event_name).toBe('subscription_created');
      expect(payload.meta.custom_data.user_id).toBe('user-sim-1');
      expect(payload.data.type).toBe('subscriptions');
      expect(payload.data.attributes.status).toBe('active');
      expect(payload.data.attributes.variant_id).toBe('var-pro-1');
    });

    it('creates a subscription_cancelled payload with cancelled status', () => {
      const payload = generateWebhookPayload({
        userId: 'user-sim-2',
        eventType: 'subscription_cancelled',
      });

      expect(payload.meta.event_name).toBe('subscription_cancelled');
      expect(payload.meta.custom_data.user_id).toBe('user-sim-2');
      expect(payload.data.attributes.status).toBe('cancelled');
    });

    it('creates an order_created payload with paid status and orders type', () => {
      const payload = generateWebhookPayload({
        userId: 'user-sim-3',
        eventType: 'order_created',
      });

      expect(payload.meta.event_name).toBe('order_created');
      expect(payload.data.type).toBe('orders');
      expect(payload.data.attributes.status).toBe('paid');
    });
  });

  describe('signWebhookPayload', () => {
    it('generates a valid 64-character HMAC-SHA256 signature', () => {
      const payload = { test: 'data', timestamp: Date.now() };
      const { rawBody, signature } = signWebhookPayload(payload, secret);

      expect(signature).toHaveLength(64);
      expect(signature).toMatch(/^[0-9a-f]{64}$/);

      // Verify signature manually using crypto
      const expected = createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
      expect(signature).toBe(expected);
    });

    it('produces different signatures for different payloads or secrets', () => {
      const payload1 = { user: 'a' };
      const payload2 = { user: 'b' };

      const sig1 = signWebhookPayload(payload1, secret).signature;
      const sig2 = signWebhookPayload(payload2, secret).signature;
      const sigDifferentSecret = signWebhookPayload(
        payload1,
        'different-secret',
      ).signature;

      expect(sig1).not.toBe(sig2);
      expect(sig1).not.toBe(sigDifferentSecret);
    });
  });

  describe('parseArgs', () => {
    it('parses custom arguments from command line flags', () => {
      const args = [
        '--event',
        'subscription_cancelled',
        '--user',
        'user-abc-123',
        '--url',
        'http://localhost:4000/webhook',
        '--secret',
        'my-secret',
        '--dry-run',
      ];

      const parsed = parseArgs(args);
      expect(parsed.event).toBe('subscription_cancelled');
      expect(parsed.userId).toBe('user-abc-123');
      expect(parsed.url).toBe('http://localhost:4000/webhook');
      expect(parsed.secret).toBe('my-secret');
      expect(parsed.dryRun).toBe(true);
    });

    it('supplies defaults when optional arguments are omitted', () => {
      const parsed = parseArgs([]);
      expect(parsed.event).toBe('subscription_created');
      expect(parsed.userId).toBe('user-dev-demo');
      expect(parsed.dryRun).toBe(false);
    });
  });

  describe('sendWebhook network dispatch', () => {
    it('sends POST request with X-Signature header and JSON body', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        status: 200,
        text: jest.fn().mockResolvedValue(JSON.stringify({ received: true })),
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const payload = { event: 'test' };
        const result = await sendWebhook(
          'http://localhost:3000/test',
          secret,
          payload,
        );

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ received: true });

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:3000/test',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              'Content-Type': 'application/json',
              'X-Signature': expect.stringMatching(/^[0-9a-f]{64}$/),
            }),
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('Integration with BillingService', () => {
    it('successfully validates and processes simulated webhook in BillingService', async () => {
      const mockDatabase: Partial<DatabaseService> = {
        query: jest.fn().mockResolvedValue([]),
      };
      const config = new ConfigService({
        LEMON_SQUEEZY_WEBHOOK_SECRET: secret,
      });

      const billingService = new BillingService(
        mockDatabase as DatabaseService,
        {} as AuthService,
        config,
      );

      // 1. Generate payload using simulator
      const payload = generateWebhookPayload({
        userId: 'user-integrated-100',
        eventType: 'subscription_created',
        externalEventId: 'ls_ext_test_999',
      });

      // 2. Sign payload using simulator
      const { rawBody, signature } = signWebhookPayload(payload, secret);

      // 3. Process via BillingService.webhook
      const result = await billingService.webhook(
        signature,
        payload,
        Buffer.from(rawBody),
      );

      expect(result).toEqual({ received: true });
      expect(mockDatabase.query).toHaveBeenCalledWith(
        'UPDATE "User" SET "subscriptionTier" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2',
        ['PRO', 'user-integrated-100'],
      );
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "BillingEvent"'),
        expect.arrayContaining([
          'user-integrated-100',
          'LEMON_SQUEEZY',
          'ls_ext_test_999',
        ]),
      );
    });
  });
});

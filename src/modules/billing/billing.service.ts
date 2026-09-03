import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

import { DatabaseService } from '../../common/services/database.service.js';
import type { ViewerIdentity } from '../../common/types.js';
import { AuthService } from '../auth/auth.service.js';
import type { CheckoutDto } from './billing.dto.js';

type Subscription = {
  tier: 'ANONYMOUS' | 'FREE' | 'PRO';
  expiresAt: Date | null;
};

@Injectable()
export class BillingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  async subscription(
    identity: ViewerIdentity | undefined,
  ): Promise<Subscription> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    const row = await this.database.one<{
      subscriptionTier: Subscription['tier'];
      subscriptionExpiresAt: Date | null;
    }>(
      'SELECT "subscriptionTier", "subscriptionExpiresAt" FROM "User" WHERE "id" = $1',
      [viewer.userId],
    );
    if (!row) {
      throw new NotFoundException('User not found.');
    }
    return { tier: row.subscriptionTier, expiresAt: row.subscriptionExpiresAt };
  }

  async checkout(
    identity: ViewerIdentity | undefined,
    dto: CheckoutDto,
  ): Promise<{ checkoutUrl: string | null; subscription: Subscription }> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    const variantId = this.config.get<string>('LEMON_SQUEEZY_VARIANT_ID');
    if (!variantId) {
      if (this.config.get<string>('NODE_ENV') === 'production') {
        throw new ForbiddenException('Billing is not configured.');
      }
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await this.database.query(
        `UPDATE "User" SET "subscriptionTier" = 'PRO', "subscriptionExpiresAt" = $1, "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $2`,
        [expiresAt, viewer.userId],
      );
      await this.record(viewer.userId, 'LOCAL', 'development.upgrade', {
        planId: dto.planId ?? 'pro',
      });
      return { checkoutUrl: null, subscription: { tier: 'PRO', expiresAt } };
    }
    await this.record(viewer.userId, 'LEMON_SQUEEZY', 'checkout.created', {
      planId: dto.planId ?? 'pro',
    });
    const query = new URLSearchParams({
      'checkout[custom][user_id]': viewer.userId,
    });
    return {
      checkoutUrl: `https://app.lemonsqueezy.com/checkout/buy/${encodeURIComponent(variantId)}?${query.toString()}`,
      subscription: await this.subscription(viewer),
    };
  }

  async webhook(
    signature: string | undefined,
    payload: unknown,
  ): Promise<{ received: boolean }> {
    const secret = this.config.get<string>('LEMON_SQUEEZY_WEBHOOK_SECRET');
    const serialized = JSON.stringify(payload);
    if (secret) {
      const expected = createHmac('sha256', secret)
        .update(serialized)
        .digest('hex');
      if (
        !signature ||
        signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ) {
        throw new ForbiddenException('Invalid billing webhook signature.');
      }
    } else if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new ForbiddenException('Billing webhook is not configured.');
    }

    const event = payload as {
      meta?: { custom_data?: { user_id?: string } };
      data?: { id?: string; attributes?: { status?: string } };
    };
    const userId = event.meta?.custom_data?.user_id;
    if (!userId) {
      return { received: true };
    }
    const status = event.data?.attributes?.status;
    const tier =
      status === 'cancelled' || status === 'expired' ? 'FREE' : 'PRO';
    await this.database.query(
      `UPDATE "User" SET "subscriptionTier" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2`,
      [tier, userId],
    );
    await this.record(
      userId,
      'LEMON_SQUEEZY',
      `webhook.${status ?? 'received'}`,
      payload,
      event.data?.id,
    );
    return { received: true };
  }

  private async record(
    userId: string,
    provider: 'LOCAL' | 'LEMON_SQUEEZY',
    eventType: string,
    payload: unknown,
    externalEventId?: string,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO "BillingEvent" ("id", "userId", "provider", "externalEventId", "eventType", "payload")
       VALUES ($1, $2, $3::"BillingProvider", $4, $5, $6::jsonb)
       ON CONFLICT ("externalEventId") DO NOTHING`,
      [
        randomUUID(),
        userId,
        provider,
        externalEventId ?? null,
        eventType,
        JSON.stringify(payload),
      ],
    );
  }
}

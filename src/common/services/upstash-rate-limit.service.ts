import { Ratelimit } from '@upstash/ratelimit';
import { Redis as UpstashRedis } from '@upstash/redis';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RedisService } from './redis.service.js';

type LimitKind = 'request' | 'search' | 'guest';

type LimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
};

type RateLimitRule = {
  limit: number;
  windowSeconds: number;
  prefix: string;
};

export const RATE_LIMIT_RULES: Record<LimitKind, RateLimitRule> = {
  request: {
    limit: 120,
    windowSeconds: 60,
    prefix: 'via-carraria:requests',
  },
  search: {
    limit: 30,
    windowSeconds: 60,
    prefix: 'via-carraria:search',
  },
  guest: {
    limit: 10,
    windowSeconds: 3600,
    prefix: 'via-carraria:guest-sessions',
  },
};

@Injectable()
export class UpstashRateLimitService {
  private readonly logger = new Logger(UpstashRateLimitService.name);
  private readonly requestLimiter?: Ratelimit;
  private readonly searchLimiter?: Ratelimit;
  private readonly guestLimiter?: Ratelimit;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    const url = config.get<string>('UPSTASH_REDIS_REST_URL');
    const token = config.get<string>('UPSTASH_REDIS_REST_TOKEN');
    if (!url || !token) {
      this.logger.log('Using self-hosted Redis for rate limiting.');
      return;
    }

    const client = new UpstashRedis({ url, token });
    this.requestLimiter = new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(RATE_LIMIT_RULES.request.limit, '1 m'),
      prefix: RATE_LIMIT_RULES.request.prefix,
      analytics: true,
      timeout: 1500,
    });
    this.searchLimiter = new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(RATE_LIMIT_RULES.search.limit, '1 m'),
      prefix: RATE_LIMIT_RULES.search.prefix,
      analytics: true,
      timeout: 1500,
    });
    this.guestLimiter = new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(RATE_LIMIT_RULES.guest.limit, '1 h'),
      prefix: RATE_LIMIT_RULES.guest.prefix,
      analytics: true,
      timeout: 1500,
    });
    this.logger.log('Upstash REST rate limiters initialized.');
  }

  async limit(
    kind: LimitKind,
    identifier: string,
    ip: string,
    userAgent?: string,
  ): Promise<LimitResult> {
    const rule = RATE_LIMIT_RULES[kind];
    const effectiveLimit = await this.getEffectiveLimit(kind);
    const limiter =
      kind === 'search'
        ? this.searchLimiter
        : kind === 'guest'
          ? this.guestLimiter
          : this.requestLimiter;

    if (!limiter) {
      return await this.redis.consumeRateLimit(
        kind,
        identifier,
        effectiveLimit,
        rule.windowSeconds,
      );
    }

    try {
      const result = await limiter.limit(identifier, { ip, userAgent });
      return {
        success: result.success,
        limit: result.limit,
        remaining: result.remaining,
        reset: result.reset,
      };
    } catch (error: unknown) {
      this.logger.warn(
        `Upstash rate limiting unavailable; falling back to self-hosted Redis: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return await this.redis.consumeRateLimit(
        kind,
        identifier,
        effectiveLimit,
        rule.windowSeconds,
      );
    }
  }

  private async getEffectiveLimit(kind: LimitKind): Promise<number> {
    try {
      const raw = await this.redis.get('system:settings');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.rateLimits) {
          if (kind === 'request') {
            return (
              Number(parsed.rateLimits.authenticatedPerMinute) ||
              RATE_LIMIT_RULES.request.limit
            );
          }
          if (kind === 'search') {
            return Math.max(
              5,
              Math.floor(
                (Number(parsed.rateLimits.authenticatedPerMinute) || 120) / 4,
              ),
            );
          }
          if (kind === 'guest') {
            return (
              Number(parsed.rateLimits.anonymousPerMinute) ||
              RATE_LIMIT_RULES.guest.limit
            );
          }
        }
      }
    } catch {
      // ignore fallback
    }
    return RATE_LIMIT_RULES[kind].limit;
  }
}

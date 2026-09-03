import { Ratelimit } from '@upstash/ratelimit';
import { Redis as UpstashRedis } from '@upstash/redis';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RedisService } from './redis.service.js';

type LimitKind = 'request' | 'search' | 'guest';

type LimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
};

@Injectable()
export class UpstashRateLimitService {
  private readonly requestLimiter?: Ratelimit;
  private readonly searchLimiter?: Ratelimit;
  private readonly guestLimiter?: Ratelimit;
  private readonly production: boolean;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.production = config.get<string>('NODE_ENV') === 'production';
    const url = config.get<string>('UPSTASH_REDIS_REST_URL');
    const token = config.get<string>('UPSTASH_REDIS_REST_TOKEN');
    if (!url || !token) return;

    const client = new UpstashRedis({ url, token });
    this.requestLimiter = new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(120, '1 m'),
      prefix: 'via-carraria:requests',
      analytics: true,
      timeout: 1500,
    });
    this.searchLimiter = new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(30, '1 m'),
      prefix: 'via-carraria:search',
      analytics: true,
      timeout: 1500,
    });
    this.guestLimiter = new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(10, '1 h'),
      prefix: 'via-carraria:guest-sessions',
      analytics: true,
      timeout: 1500,
    });
  }

  async limit(
    kind: LimitKind,
    identifier: string,
    ip: string,
    userAgent?: string,
  ): Promise<LimitResult> {
    const limiter =
      kind === 'search'
        ? this.searchLimiter
        : kind === 'guest'
          ? this.guestLimiter
          : this.requestLimiter;
    const limit = kind === 'search' ? 30 : kind === 'guest' ? 10 : 120;
    if (!limiter) {
      if (this.production) {
        throw new ServiceUnavailableException(
          'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required in production.',
        );
      }
      const fallback = await this.redis.consumeRateLimit(
        kind,
        identifier,
        limit,
        kind === 'guest' ? 3600 : 60,
      );
      return fallback;
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
      if (!this.production) {
        return {
          success: true,
          limit,
          remaining: limit,
          reset: Date.now() + (kind === 'guest' ? 3600_000 : 60_000),
        };
      }
      throw new ServiceUnavailableException(
        'Distributed rate limiting is temporarily unavailable.',
        { cause: error },
      );
    }
  }
}

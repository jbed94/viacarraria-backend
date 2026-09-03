import { ConfigService } from '@nestjs/config';

import { UpstashRateLimitService } from './upstash-rate-limit.service.js';
import type { RedisService } from './redis.service.js';

describe('UpstashRateLimitService', () => {
  it('uses the local Redis limiter when Upstash is not configured in development', async () => {
    const consumeRateLimit = jest.fn().mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: 123,
    });
    const redis = {
      consumeRateLimit,
    } as unknown as RedisService;
    const config = {
      get: jest.fn((key: string) =>
        key === 'NODE_ENV' ? 'development' : undefined,
      ),
    } as unknown as ConfigService;
    const service = new UpstashRateLimitService(config, redis);

    await expect(
      service.limit('search', 'guest-1', '127.0.0.1'),
    ).resolves.toEqual({
      success: true,
      limit: 30,
      remaining: 29,
      reset: 123,
    });
    expect(consumeRateLimit.mock.calls[0]).toEqual([
      'search',
      'guest-1',
      30,
      60,
    ]);
  });

  it('fails closed in production when Upstash credentials are missing', async () => {
    const consumeRateLimit = jest.fn();
    const redis = {
      consumeRateLimit,
    } as unknown as RedisService;
    const config = {
      get: jest.fn((key: string) =>
        key === 'NODE_ENV' ? 'production' : undefined,
      ),
    } as unknown as ConfigService;
    const service = new UpstashRateLimitService(config, redis);

    await expect(
      service.limit('request', 'ip:127.0.0.1', '127.0.0.1'),
    ).rejects.toThrow(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required in production.',
    );
    expect(consumeRateLimit.mock.calls).toHaveLength(0);
  });
});

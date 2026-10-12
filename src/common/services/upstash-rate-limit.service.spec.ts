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

  it('uses self-hosted Redis limiter when Upstash credentials are not set in production', async () => {
    const consumeRateLimit = jest.fn().mockResolvedValue({
      success: true,
      limit: 120,
      remaining: 119,
      reset: 123,
    });
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
    ).resolves.toEqual({
      success: true,
      limit: 120,
      remaining: 119,
      reset: 123,
    });
    expect(consumeRateLimit.mock.calls[0]).toEqual([
      'request',
      'ip:127.0.0.1',
      120,
      60,
    ]);
  });

  it('enforces verification rate limit with 5 requests per hour ceiling', async () => {
    const consumeRateLimit = jest.fn().mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: 3600,
    });
    const redis = {
      consumeRateLimit,
    } as unknown as RedisService;
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const service = new UpstashRateLimitService(config, redis);

    await expect(
      service.limit('verification', 'verification:127.0.0.1', '127.0.0.1'),
    ).resolves.toEqual({
      success: true,
      limit: 5,
      remaining: 4,
      reset: 3600,
    });
    expect(consumeRateLimit.mock.calls[0]).toEqual([
      'verification',
      'verification:127.0.0.1',
      5,
      3600,
    ]);
  });
});

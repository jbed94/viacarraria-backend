import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { RedisService } from './redis.service.js';

jest.mock('ioredis', () => {
  const mRedis = {
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue('OK'),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    mget: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    duplicate: jest.fn(),
  };
  return {
    Redis: jest.fn().mockImplementation(() => mRedis),
  };
});

describe('RedisService', () => {
  let service: RedisService;
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379'),
    } as unknown as ConfigService;
    service = new RedisService(config);
    mockClient = (service as any).client;
  });

  describe('mget', () => {
    it('returns empty array when keys array is empty or undefined', async () => {
      const res = await service.mget([]);
      expect(res).toEqual([]);
      expect(mockClient.mget).not.toHaveBeenCalled();
    });

    it('retrieves values using client.mget when Redis is available', async () => {
      (service as any).available = true;
      mockClient.mget.mockResolvedValue(['value-1', null, 'value-3']);

      const results = await service.mget(['key1', 'key2', 'key3']);

      expect(results).toEqual(['value-1', null, 'value-3']);
      expect(mockClient.mget).toHaveBeenCalledWith('key1', 'key2', 'key3');
    });

    it('falls back to local in-memory values when Redis is unavailable', async () => {
      (service as any).available = false;

      // Seed local values
      await service.set('localKey1', 'val1', 3600);
      await service.set('localKey2', 'val2', 3600);

      const results = await service.mget([
        'localKey1',
        'missingKey',
        'localKey2',
      ]);

      expect(results).toEqual(['val1', null, 'val2']);
      expect(mockClient.mget).not.toHaveBeenCalled();
    });

    it('falls back to local values when client.mget throws an error', async () => {
      (service as any).available = true;
      mockClient.mget.mockRejectedValue(new Error('Connection lost'));

      (service as any).localValues.set('key-a', {
        value: 'alpha',
        expiresAt: Date.now() + 3600_000,
      });

      const results = await service.mget(['key-a', 'key-b']);

      expect(results).toEqual(['alpha', null]);
      expect((service as any).available).toBe(false);
    });

    it('returns null for expired local values in mget fallback', async () => {
      (service as any).available = false;

      // Seed an expired key directly into localValues
      (service as any).localValues.set('expiredKey', {
        value: 'oldValue',
        expiresAt: Date.now() - 1000,
      });

      const results = await service.mget(['expiredKey']);
      expect(results).toEqual([null]);
    });
  });

  describe('createSubscriber', () => {
    it('returns null when Redis is unavailable', () => {
      (service as any).available = false;
      const subscriber = service.createSubscriber();
      expect(subscriber).toBeNull();
      expect(mockClient.duplicate).not.toHaveBeenCalled();
    });

    it('creates duplicate client with enableOfflineQueue and maxRetriesPerRequest null when available', () => {
      (service as any).available = true;
      const mockSub = { on: jest.fn() };
      mockClient.duplicate.mockReturnValue(mockSub);

      const subscriber = service.createSubscriber();

      expect(subscriber).toBe(mockSub);
      expect(mockClient.duplicate).toHaveBeenCalledWith({
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
        lazyConnect: true,
      });
      expect(mockSub.on).toHaveBeenCalledWith('error', expect.any(Function));

      // Trigger error handler to verify graceful logging
      const errorHandler = mockSub.on.mock.calls.find(
        (call: [string, Function]) => call[0] === 'error',
      )?.[1];
      expect(errorHandler).toBeDefined();
      expect(() => errorHandler(new Error('Connection dropped'))).not.toThrow();
    });
  });
});

jest.mock('better-auth', () => ({ betterAuth: jest.fn() }));
jest.mock('better-auth/plugins', () => ({ anonymous: jest.fn() }));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn() }));
jest.mock('../../auth.js', () => ({
  auth: { api: {} },
  authDatabase: { query: jest.fn() },
}));

import { SimilarityQueueService } from './similarity-queue.service.js';
import type { DatabaseService } from './database.service.js';
import type { RedisService } from './redis.service.js';

describe('SimilarityQueueService', () => {
  let service: SimilarityQueueService;
  let mockDatabase: jest.Mocked<Partial<DatabaseService>>;
  let mockRedis: jest.Mocked<Partial<RedisService>>;

  beforeEach(() => {
    jest.useFakeTimers();

    mockDatabase = {
      one: jest.fn().mockResolvedValue(null),
    };

    mockRedis = {
      set: jest.fn().mockResolvedValue(undefined),
    };

    service = new SimilarityQueueService(
      mockDatabase as DatabaseService,
      mockRedis as RedisService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('configuration & initialization', () => {
    it('uses default throughputs when database has no saved configuration', async () => {
      const config = await service.loadConfig();
      expect(config.anonymousThroughputPerMinute).toBe(30);
      expect(config.registeredThroughputPerMinute).toBe(120);
    });

    it('loads custom quotas from SystemSettings', async () => {
      mockDatabase.one = jest.fn().mockResolvedValueOnce({
        value: {
          anonymousThroughputPerMinute: 45,
          registeredThroughputPerMinute: 180,
        },
      });

      await service.onModuleInit();
      const config = await service.loadConfig();
      expect(config.anonymousThroughputPerMinute).toBe(45);
      expect(config.registeredThroughputPerMinute).toBe(180);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'queue:similarity:occupation',
        'low',
        300,
      );
    });

    it('updates in-memory configuration dynamically', () => {
      service.updateConfig({
        anonymousThroughputPerMinute: 60,
        registeredThroughputPerMinute: 240,
      });

      expect(service['anonymousThroughput']).toBe(60);
      expect(service['registeredThroughput']).toBe(240);
    });
  });

  describe('queue occupation calculation', () => {
    it('reports low occupation when queue size is <= 2', () => {
      expect(service.getOccupation('ANONYMOUS')).toBe('low');
      expect(service.getOccupation('REGISTERED')).toBe('low');
      expect(service.getSystemOccupation()).toBe('low');
    });

    it('reports mid occupation when queue size is between 3 and 8', () => {
      // simulate 4 items in registered queue
      for (let i = 0; i < 4; i++) {
        service['registeredQueue'].push({
          execute: jest.fn(),
          resolve: jest.fn(),
          reject: jest.fn(),
          enqueuedAt: Date.now(),
        });
      }

      expect(service.getOccupation('REGISTERED')).toBe('mid');
      expect(service.getSystemOccupation()).toBe('mid');
      expect(service.getOccupation('ANONYMOUS')).toBe('low');
    });

    it('reports high occupation when queue size exceeds 8', () => {
      for (let i = 0; i < 9; i++) {
        service['anonymousQueue'].push({
          execute: jest.fn(),
          resolve: jest.fn(),
          reject: jest.fn(),
          enqueuedAt: Date.now(),
        });
      }

      expect(service.getOccupation('ANONYMOUS')).toBe('high');
      expect(service.getSystemOccupation()).toBe('high');
    });
  });

  describe('enqueue and FIFO execution', () => {
    it('executes task immediately on first call', async () => {
      const task = jest.fn().mockResolvedValue('search-result-1');

      const promise = service.enqueue('REGISTERED', task);
      await Promise.resolve(); // allow microtasks to flush

      const result = await promise;
      expect(result).toBe('search-result-1');
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('postpones subsequent tasks according to throughput rate limit without dropping them', async () => {
      // 120 req/min = 500ms between requests
      service.updateConfig({ registeredThroughputPerMinute: 120 });

      const task1 = jest.fn().mockResolvedValue('result-1');
      const task2 = jest.fn().mockResolvedValue('result-2');

      const p1 = service.enqueue('REGISTERED', task1);
      const p2 = service.enqueue('REGISTERED', task2);

      // p1 executes immediately
      await Promise.resolve();
      expect(task1).toHaveBeenCalledTimes(1);
      expect(task2).not.toHaveBeenCalled();

      // Advance time by 500ms for p2
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe('result-1');
      expect(r2).toBe('result-2');
      expect(task2).toHaveBeenCalledTimes(1);
    });

    it('processes anonymous queue with anonymous rate limit (30/min = 2000ms delay)', async () => {
      service.updateConfig({ anonymousThroughputPerMinute: 30 });

      const task1 = jest.fn().mockResolvedValue('anon-1');
      const task2 = jest.fn().mockResolvedValue('anon-2');

      const p1 = service.enqueue('ANONYMOUS', task1);
      const p2 = service.enqueue(undefined, task2); // undefined defaults to anon

      await Promise.resolve();
      expect(task1).toHaveBeenCalledTimes(1);
      expect(task2).not.toHaveBeenCalled();

      // Advance 1000ms (not yet 2000ms)
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(task2).not.toHaveBeenCalled();

      // Advance remaining 1000ms
      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe('anon-1');
      expect(r2).toBe('anon-2');
      expect(task2).toHaveBeenCalledTimes(1);
    });

    it('rejects the returned promise if task throws an error and continues queue processing', async () => {
      service.updateConfig({ registeredThroughputPerMinute: 120 });

      const failingTask = jest
        .fn()
        .mockRejectedValue(new Error('Weaviate timeout'));
      const successfulTask = jest.fn().mockResolvedValue('recovered');

      const p1 = service.enqueue('REGISTERED', failingTask);
      const p2 = service.enqueue('REGISTERED', successfulTask);

      await Promise.resolve();
      await expect(p1).rejects.toThrow('Weaviate timeout');

      // Next task should proceed after interval
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      const r2 = await p2;
      expect(r2).toBe('recovered');
      expect(successfulTask).toHaveBeenCalledTimes(1);
    });
  });
});

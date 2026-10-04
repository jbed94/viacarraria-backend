jest.mock('better-auth', () => ({ betterAuth: jest.fn() }));
jest.mock('better-auth/plugins', () => ({ anonymous: jest.fn() }));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn() }));
jest.mock('../../auth.js', () => ({
  auth: {
    api: {
      getSession: jest.fn(),
    },
  },
  authDatabase: {
    query: jest.fn(),
    end: jest.fn(),
  },
}));

import { AdminService } from './admin.service.js';
import type { DatabaseService } from '../../common/services/database.service.js';
import type { RedisService } from '../../common/services/redis.service.js';
import type { RabbitMqService } from '../../common/services/rabbitmq.service.js';
import type { WeaviateService } from '../../common/services/weaviate.service.js';
import type { StorageService } from '../../common/services/storage.service.js';

describe('AdminService - Settings Pub/Sub', () => {
  let service: AdminService;
  let mockDb: Partial<DatabaseService>;
  let mockRedis: Partial<RedisService>;
  let mockRabbit: Partial<RabbitMqService>;
  let mockWeaviate: Partial<WeaviateService>;
  let mockStorage: Partial<StorageService>;

  beforeEach(() => {
    mockDb = {
      query: jest.fn().mockResolvedValue([]),
    };
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      publish: jest.fn().mockResolvedValue(1),
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
    };
    mockRabbit = {
      isAvailable: jest.fn().mockResolvedValue(true),
    };
    mockWeaviate = {
      isReady: jest.fn().mockResolvedValue(true),
    };
    mockStorage = {};

    service = new AdminService(
      mockDb as DatabaseService,
      mockRedis as RedisService,
      mockRabbit as RabbitMqService,
      mockWeaviate as WeaviateService,
      mockStorage as StorageService,
    );
  });

  it('publishes system:settings:updated to Redis Pub/Sub when settings are updated', async () => {
    const updated = await service.updateSystemSettings(
      {
        synonymsConfig: {
          k8s: ['kubernetes', 'container orchestration'],
        },
      },
      { userId: 'admin-1', email: 'admin@example.com' } as any,
    );

    expect(mockDb.query).toHaveBeenCalled();
    expect(mockRedis.set).toHaveBeenCalledWith(
      'system:settings',
      expect.stringContaining('synonymsConfig'),
    );
    expect(mockRedis.publish).toHaveBeenCalledWith(
      'system:settings:updated',
      expect.stringContaining('system:settings:updated'),
    );
    expect(updated.synonymsConfig).toEqual({
      k8s: ['kubernetes', 'container orchestration'],
    });
  });
});

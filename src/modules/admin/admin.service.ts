import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../common/services/database.service.js';
import { RabbitMqService } from '../../common/services/rabbitmq.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import { WeaviateService } from '../../common/services/weaviate.service.js';

@Injectable()
export class AdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly rabbitMq: RabbitMqService,
    private readonly weaviate: WeaviateService,
  ) {}

  async health(): Promise<{
    status: 'ok' | 'degraded';
    services: Record<string, boolean>;
  }> {
    const database = await this.database
      .query<{ ok: number }>('SELECT 1 AS ok')
      .then(() => true)
      .catch(() => false);
    const [redis, rabbitMq, weaviate] = await Promise.all([
      this.redis.ping(),
      this.rabbitMq.isAvailable(),
      this.weaviate.isReady(),
    ]);
    const services = { database, redis, rabbitMq, weaviate };
    return { status: database ? 'ok' : 'degraded', services };
  }
}

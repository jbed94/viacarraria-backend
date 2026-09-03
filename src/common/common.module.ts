import { Global, Module } from '@nestjs/common';

import { AuthorizationService } from './authorization/ability.js';
import { DatabaseService } from './services/database.service.js';
import { EmbeddingService } from './services/embedding.service.js';
import { RabbitMqService } from './services/rabbitmq.service.js';
import { RedisService } from './services/redis.service.js';
import { UpstashRateLimitService } from './services/upstash-rate-limit.service.js';
import { WeaviateService } from './services/weaviate.service.js';

@Global()
@Module({
  providers: [
    AuthorizationService,
    DatabaseService,
    EmbeddingService,
    RedisService,
    RabbitMqService,
    WeaviateService,
    UpstashRateLimitService,
  ],
  exports: [
    AuthorizationService,
    DatabaseService,
    EmbeddingService,
    RedisService,
    RabbitMqService,
    WeaviateService,
    UpstashRateLimitService,
  ],
})
export class CommonModule {}

import { Global, Module } from '@nestjs/common';

import { AuthorizationService } from './authorization/ability.js';
import { DatabaseService } from './services/database.service.js';
import { EmbeddingService } from './services/embedding.service.js';
import { RabbitMqService } from './services/rabbitmq.service.js';
import { RedisService } from './services/redis.service.js';
import { RerankService } from './services/rerank.service.js';
import { StorageService } from './services/storage.service.js';
import { UpstashRateLimitService } from './services/upstash-rate-limit.service.js';
import { WeaviateService } from './services/weaviate.service.js';

@Global()
@Module({
  providers: [
    AuthorizationService,
    DatabaseService,
    EmbeddingService,
    RerankService,
    RedisService,
    RabbitMqService,
    StorageService,
    WeaviateService,
    UpstashRateLimitService,
  ],
  exports: [
    AuthorizationService,
    DatabaseService,
    EmbeddingService,
    RerankService,
    RedisService,
    RabbitMqService,
    StorageService,
    WeaviateService,
    UpstashRateLimitService,
  ],
})
export class CommonModule {}

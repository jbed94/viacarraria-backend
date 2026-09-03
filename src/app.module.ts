import { APP_GUARD } from '@nestjs/core';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { CommonModule } from './common/common.module.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';
import { AuthMiddleware } from './common/middleware/auth.middleware.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { GraphsModule } from './modules/graphs/graphs.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { SourcesModule } from './modules/sources/sources.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommonModule,
    AuthModule,
    GraphsModule,
    SourcesModule,
    SearchModule,
    BillingModule,
    AdminModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}

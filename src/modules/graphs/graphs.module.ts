import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { GraphRetentionService } from './graph-retention.service.js';
import { GraphsController } from './graphs.controller.js';
import { GraphsService } from './graphs.service.js';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [GraphsController],
  providers: [GraphsService, GraphRetentionService],
  exports: [GraphsService, GraphRetentionService],
})
export class GraphsModule {}

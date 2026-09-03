import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { GraphsModule } from '../graphs/graphs.module.js';
import { SourcesController } from './sources.controller.js';
import { ProgressGateway } from './progress.gateway.js';
import { SourcesService } from './sources.service.js';

@Module({
  imports: [AuthModule, GraphsModule],
  controllers: [SourcesController],
  providers: [SourcesService, ProgressGateway],
})
export class SourcesModule {}

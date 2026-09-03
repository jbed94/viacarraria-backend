import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { GraphsController } from './graphs.controller.js';
import { GraphsService } from './graphs.service.js';

@Module({
  imports: [AuthModule],
  controllers: [GraphsController],
  providers: [GraphsService],
  exports: [GraphsService],
})
export class GraphsModule {}

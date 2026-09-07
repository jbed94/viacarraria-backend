import { Module } from '@nestjs/common';

import { GraphsModule } from '../graphs/graphs.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [GraphsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}

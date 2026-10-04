import { Module } from '@nestjs/common';

import { AdContextService } from './ad-context.service.js';
import { PlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';

@Module({
  controllers: [PlansController],
  providers: [PlansService, AdContextService],
  exports: [PlansService, AdContextService],
})
export class PlansModule {}

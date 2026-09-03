import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';

@Module({
  imports: [AuthModule],
  controllers: [BillingController],
  providers: [BillingService],
})
export class BillingModule {}

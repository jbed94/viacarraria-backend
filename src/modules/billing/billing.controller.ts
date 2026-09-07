import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedRequest } from '../../common/types.js';
import { CheckoutDto } from './billing.dto.js';
import { BillingService } from './billing.service.js';

@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('subscription')
  async subscription(@Req() request: AuthenticatedRequest) {
    return this.billingService.subscription(request.identity);
  }

  @Post('checkout')
  async checkout(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CheckoutDto,
  ) {
    return this.billingService.checkout(request.identity, dto);
  }

  @Post('webhook')
  async webhook(
    @Req() request: Request,
    @Headers('x-signature') signature: string | undefined,
    @Body() payload: unknown,
  ) {
    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
    return this.billingService.webhook(signature, payload, rawBody);
  }
}

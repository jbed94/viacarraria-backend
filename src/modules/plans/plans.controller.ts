import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../../common/types.js';
import { AdContextService } from './ad-context.service.js';
import { AdTelemetryDto } from './plans.dto.js';
import { PlansService } from './plans.service.js';

@Controller('plans')
export class PlansController {
  constructor(
    private readonly plansService: PlansService,
    private readonly adContextService: AdContextService,
  ) {}

  @Get()
  async getPlans() {
    return this.plansService.getPlanDefinitions();
  }

  @Get('transactions')
  async getTransactions() {
    return [];
  }

  @Get('my')
  async getMyPlan(@Req() request: AuthenticatedRequest) {
    const identity = request.identity;
    if (!identity) {
      throw new UnauthorizedException('Authentication required.');
    }
    return this.plansService.getPlanDefinition(identity.tier);
  }

  @Post('ads/telemetry')
  async postAdTelemetry(@Body() dto: AdTelemetryDto) {
    return this.plansService.recordAdTelemetry(dto);
  }

  @Get('ads/config')
  async getAdConfig() {
    return this.plansService.getAdConfig();
  }

  @Get('ads/analytics')
  async getAdAnalytics(@Query('range') range?: string) {
    return this.plansService.getAdAnalytics({ range: range as any });
  }

  @Get('ads/tags/active')
  async getActiveTags() {
    return this.adContextService.getActiveTags();
  }

  @Get('ads/context')
  async getAdContext(@Query('graphId') graphId?: string) {
    if (!graphId) {
      return { graphId: '', tags: [], details: [] };
    }
    return this.adContextService.getGraphContextualTags(graphId);
  }
}

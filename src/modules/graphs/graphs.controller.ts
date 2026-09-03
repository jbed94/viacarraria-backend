import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../../common/types.js';
import {
  CopyGraphDto,
  CreateGraphDto,
  UpdateGraphDto,
} from './graphs.dto.js';
import { GraphsService } from './graphs.service.js';

@Controller('graphs')
export class GraphsController {
  constructor(private readonly graphsService: GraphsService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    return this.graphsService.list(request.identity);
  }

  @Get(':id')
  async get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.graphsService.get(request.identity, id);
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateGraphDto,
  ) {
    return this.graphsService.create(request.identity, dto);
  }

  @Put(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateGraphDto,
  ) {
    return this.graphsService.update(request.identity, id, dto);
  }

  @Post(':id/finalize')
  async finalize(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.graphsService.finalize(request.identity, id);
  }

  @Post(':id/copy')
  async copy(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CopyGraphDto,
  ) {
    return this.graphsService.copy(request.identity, id, dto);
  }

  @HttpCode(204)
  @Delete(':id')
  async delete(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.graphsService.delete(request.identity, id);
  }
}

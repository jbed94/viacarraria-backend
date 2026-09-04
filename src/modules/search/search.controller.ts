import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';

import type { AuthenticatedRequest } from '../../common/types.js';
import { SearchDto, UpdateQueryDto } from './search.dto.js';
import { SearchService } from './search.service.js';

@Controller()
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post('search')
  async search(@Req() request: AuthenticatedRequest, @Body() dto: SearchDto) {
    return this.searchService.search(request.identity, dto);
  }

  @Get('search/:id')
  async get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.searchService.get(request.identity, id);
  }

  @Get('queries')
  async history(@Req() request: AuthenticatedRequest) {
    return this.searchService.history(request.identity);
  }

  @Patch('queries/:id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateQueryDto,
  ) {
    return this.searchService.update(request.identity, id, dto);
  }

  @Post('graphs/:id/index')
  async indexGraph(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const internalToken = request.headers['x-internal-token'];
    const expectedToken = process.env.INTERNAL_SERVICE_TOKEN;
    if (internalToken && expectedToken && internalToken === expectedToken) {
      return this.searchService.indexGraphSources(id);
    }
    return this.searchService.indexGraph(request.identity, id);
  }
}

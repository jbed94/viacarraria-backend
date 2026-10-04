import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../../common/types.js';
import { CrawlDto, SearchDto, UpdateQueryDto } from './search.dto.js';
import { SearchService } from './search.service.js';

@Controller()
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post('search')
  async search(@Req() request: AuthenticatedRequest, @Body() dto: SearchDto) {
    return this.searchService.search(request.identity, dto);
  }

  @Post('search/crawl')
  async crawl(@Req() request: AuthenticatedRequest, @Body() dto: CrawlDto) {
    return this.searchService.crawl(request.identity, dto);
  }

  @Post('search/crawl/:jobId/cancel')
  async cancelCrawl(
    @Req() request: AuthenticatedRequest,
    @Param('jobId') jobId: string,
  ) {
    return this.searchService.cancelCrawl(request.identity, jobId);
  }

  @Get('search/suggestions')
  async getSuggestions(
    @Req() request: AuthenticatedRequest,
    @Query('graphId') graphId: string,
    @Query('nodeIds') nodeIdsParam?: string,
    @Query('query') queryParam?: string,
    @Query('limit') limitParam?: string,
  ) {
    if (!graphId) {
      throw new BadRequestException('graphId query parameter is required.');
    }
    const nodeIds = nodeIdsParam
      ? nodeIdsParam
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : [];
    const query = queryParam ? queryParam.trim() : '';
    const limit = Math.min(Number(limitParam) || 8, 20);

    return this.searchService.getSuggestions(
      request.identity,
      graphId,
      nodeIds,
      query,
      limit,
    );
  }

  @Get('graphs/:id/vocabulary')
  async getVocabulary(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('nodeIds') nodeIdsParam?: string,
  ) {
    const nodeIds = nodeIdsParam
      ? nodeIdsParam
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    return this.searchService.getVocabulary(request.identity, id, nodeIds);
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
    const isInternalValid =
      typeof internalToken === 'string' &&
      typeof expectedToken === 'string' &&
      internalToken.length === expectedToken.length &&
      timingSafeEqual(Buffer.from(internalToken), Buffer.from(expectedToken));

    if (isInternalValid) {
      return this.searchService.indexGraphSources(id);
    }
    return this.searchService.indexGraph(request.identity, id);
  }
}

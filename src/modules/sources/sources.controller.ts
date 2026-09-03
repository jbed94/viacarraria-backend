import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import type { AuthenticatedRequest } from '../../common/types.js';
import {
  UpdateSourceStatusDto,
  type UploadedDocument,
  UploadSourceDto,
} from './sources.dto.js';
import { SourcesService } from './sources.service.js';

@Controller('sources')
export class SourcesController {
  constructor(private readonly sourcesService: SourcesService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  async upload(
    @Req() request: AuthenticatedRequest,
    @Body() dto: UploadSourceDto,
    @UploadedFile() file: UploadedDocument | undefined,
  ) {
    return this.sourcesService.upload(request.identity, dto, file);
  }

  @Get(':id')
  async get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.sourcesService.get(request.identity, id);
  }

  @Get(':id/progress')
  async progress(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.sourcesService.progress(request.identity, id);
  }

  @HttpCode(204)
  @Delete(':id')
  async delete(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.sourcesService.delete(request.identity, id);
  }

  @Patch(':id/status')
  async updateFromWorker(
    @Headers('x-internal-token') token: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateSourceStatusDto,
  ) {
    return this.sourcesService.updateFromWorker(token, id, dto);
  }
}

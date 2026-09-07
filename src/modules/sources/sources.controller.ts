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
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../../common/types.js';
import {
  AbortUploadDto,
  CompleteUploadDto,
  PresignedUploadDto,
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

  @Post('presigned-upload')
  async presignedUpload(
    @Req() request: AuthenticatedRequest,
    @Body() dto: PresignedUploadDto,
  ) {
    return this.sourcesService.presignedUpload(request.identity, dto);
  }

  @Post('complete-upload')
  async completeUpload(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.sourcesService.completeUpload(request.identity, dto);
  }

  @HttpCode(204)
  @Post('abort-upload')
  async abortUpload(
    @Req() request: AuthenticatedRequest,
    @Body() dto: AbortUploadDto,
  ): Promise<void> {
    await this.sourcesService.abortUpload(request.identity, dto);
  }

  @Put('direct-upload/*')
  async directUpload(
    @Req() request: AuthenticatedRequest & { body: Buffer },
    @Query('uploadId') uploadId?: string,
    @Query('partNumber') partNumberStr?: string,
  ) {
    const rawKey = (request.params as any)[0] || '';
    const key = decodeURIComponent(rawKey);
    const buffer = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(request.body || '');
    const partNumber = partNumberStr
      ? Number.parseInt(partNumberStr, 10)
      : undefined;
    return this.sourcesService.handleDirectUpload(
      key,
      buffer,
      uploadId,
      partNumber,
    );
  }

  @Get(':id')
  async get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.sourcesService.get(request.identity, id);
  }

  @Get(':id/download')
  async download(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('range') range: string | undefined,
    @Headers('x-internal-token') token: string | undefined,
    @Res() res: Response,
  ) {
    const file = await this.sourcesService.download(
      request.identity,
      id,
      range,
      token,
    );
    res.status(file.status);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', file.contentLength);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(file.fileName)}"`,
    );
    res.setHeader('Accept-Ranges', file.acceptRanges || 'bytes');
    if (file.contentRange) {
      res.setHeader('Content-Range', file.contentRange);
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self' data: blob: *; object-src 'self' blob: *; frame-ancestors *",
    );
    res.removeHeader('X-Frame-Options');
    res.send(file.buffer);
  }

  @Get(':id/file-url')
  async fileUrl(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.sourcesService.getFileUrl(request.identity, id);
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

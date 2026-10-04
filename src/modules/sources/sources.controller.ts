import {
  BadRequestException,
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
import { randomUUID } from 'crypto';
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../../common/types.js';
import {
  AbortUploadDto,
  CompleteUploadDto,
  CreateNoteDto,
  PresignedUploadDto,
  SetSourceAdTagsDto,
  UpdateSourceDto,
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

  @Post('note')
  async createNote(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateNoteDto,
  ) {
    return this.sourcesService.createNote(request.identity, dto);
  }

  @Put(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateSourceDto,
  ) {
    return this.sourcesService.update(request.identity, id, dto);
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

  @Put(':id/ad-tags')
  async setSourceAdTagsFromWorker(
    @Headers('x-internal-token') token: string | undefined,
    @Param('id') id: string,
    @Body() dto: SetSourceAdTagsDto,
  ) {
    return this.sourcesService.setAdTagsFromWorker(token, id, dto);
  }

  @Post(':id/assets')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }),
  )
  async uploadAsset(
    @Headers('x-internal-token') token: string | undefined,
    @Headers('content-type') rawContentType: string | undefined,
    @Param('id') sourceId: string,
    @UploadedFile() file: UploadedDocument | undefined,
    @Query('name') queryName?: string,
    @Body() body?: any,
    @Req() req?: any,
  ) {
    let buffer: Buffer | undefined;
    let contentType = 'image/png';
    let assetName =
      queryName || (body && typeof body === 'object' ? body.name : undefined);

    if (file && file.buffer) {
      buffer = file.buffer;
      contentType = file.mimetype || 'image/png';
      assetName = assetName || file.originalname;
    } else if (Buffer.isBuffer(body)) {
      buffer = body;
      contentType = rawContentType || 'image/png';
    } else if (req && Buffer.isBuffer(req.body)) {
      buffer = req.body;
      contentType = rawContentType || 'image/png';
    } else if (body && body.data && typeof body.data === 'string') {
      buffer = Buffer.from(body.data, 'base64');
      contentType = body.contentType || 'image/png';
      assetName = assetName || body.name;
    }

    if (!buffer || buffer.length === 0) {
      throw new BadRequestException(
        'Asset file or payload buffer is required.',
      );
    }

    assetName =
      assetName ||
      `${randomUUID()}.${contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png'}`;

    return this.sourcesService.uploadAsset(
      token,
      sourceId,
      assetName,
      buffer,
      contentType,
    );
  }

  @Get(':id/assets/:assetId')
  async getAsset(
    @Param('id') sourceId: string,
    @Param('assetId') assetId: string,
    @Headers('x-internal-token') token: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    const asset = await this.sourcesService.getAsset(
      sourceId,
      assetId,
      token,
      request.identity,
    );
    res.status(asset.status || 200);
    res.setHeader('Content-Type', asset.contentType || 'image/png');
    res.setHeader('Content-Length', asset.contentLength);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(asset.buffer);
  }
}

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { basename, extname, join } from 'path';

import { DatabaseService } from '../../common/services/database.service.js';
import { AuthorizationService } from '../../common/authorization/ability.js';
import { RabbitMqService } from '../../common/services/rabbitmq.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import { StorageService } from '../../common/services/storage.service.js';
import type { ViewerIdentity } from '../../common/types.js';
import { AuthService } from '../auth/auth.service.js';
import { GraphsService, type SourceSummary } from '../graphs/graphs.service.js';
import type {
  AbortUploadDto,
  CompleteUploadDto,
  CreateNoteDto,
  PresignedUploadDto,
  SetSourceAdTagsDto,
  UpdateSourceDto,
  UpdateSourceStatusDto,
  UploadedDocument,
  UploadSourceDto,
} from './sources.dto.js';
import { extractVocabularyFromSource } from '../search/vocabulary.utils.js';
import { AdContextService } from '../plans/ad-context.service.js';
import { ProgressGateway } from './progress.gateway.js';

type SourceRecord = SourceSummary & {
  graphId: string;
  content: string | null;
  error: string | null;
};

@Injectable()
export class SourcesService {
  private readonly uploadDirectory: string;
  private readonly internalToken: string;

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly rabbitMq: RabbitMqService,
    private readonly storage: StorageService,
    private readonly graphs: GraphsService,
    private readonly auth: AuthService,
    private readonly authorization: AuthorizationService,
    private readonly progressGateway: ProgressGateway,
    config: ConfigService,
    @Optional() private readonly adContextService?: AdContextService,
  ) {
    this.uploadDirectory =
      config.get<string>('UPLOAD_DIR') ?? join(process.cwd(), 'uploads');
    this.internalToken = config.getOrThrow<string>('INTERNAL_SERVICE_TOKEN');
  }

  private isValidInternalToken(token: string | undefined): boolean {
    if (!token || typeof token !== 'string' || !this.internalToken) {
      return false;
    }
    const tokenBuffer = Buffer.from(token);
    const expectedBuffer = Buffer.from(this.internalToken);
    if (tokenBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return timingSafeEqual(tokenBuffer, expectedBuffer);
  }

  async upload(
    identity: ViewerIdentity | undefined,
    dto: UploadSourceDto,
    file: UploadedDocument | undefined,
  ): Promise<SourceSummary> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    const graph = await this.graphs.findEditable(viewer, dto.graphId);
    this.authorization.assertCan(viewer, 'upload', 'Source', {
      graphUserId: graph.userId,
      graphIsPublic: graph.isPublic,
    });
    if (!graph.nodes.some((node) => node.id === dto.nodeId)) {
      throw new NotFoundException(
        'The selected node does not exist in this graph.',
      );
    }
    if (!file) {
      throw new UnsupportedMediaTypeException(
        'Choose a PDF, Markdown, or text file to upload.',
      );
    }
    const uploadLimit = 50;
    const uploadQuota = await this.redis.consumeUploadQuota(
      viewer.userId,
      uploadLimit,
    );
    if (!uploadQuota.allowed) {
      throw new HttpException(
        'Hourly upload limit reached (50/hour). Please try again in the next hour.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const fileType = this.fileType(file);
    const maxSingleFileBytes = 50 * 1024 * 1024; // 50 MB single file cap
    if (file.size > maxSingleFileBytes) {
      throw new ForbiddenException('Single file size is limited to 50 MB.');
    }

    // Check user's total source storage limit (default 100 MB or custom admin limit)
    const userStorage = await this.database.one<{ totalBytes: string }>(
      `SELECT COALESCE(SUM(s."sizeBytes"), 0)::text as "totalBytes"
       FROM "NodeSource" s
       JOIN "Graph" g ON g."id" = s."graphId"
       WHERE g."userId" = $1`,
      [viewer.userId],
    );
    const currentUsedBytes = Number(userStorage?.totalBytes || 0);

    const settingsRow = await this.database.one<{ value: any }>(
      `SELECT "value" FROM "SystemSettings" WHERE "key" = 'storageConfig'`,
    );
    const globalDefaultMb = Number(
      settingsRow?.value?.defaultStorageLimitMb ?? 100,
    );

    const userRow = await this.database.one<{ storageLimitMb: number | null }>(
      'SELECT "storageLimitMb" FROM "User" WHERE "id" = $1',
      [viewer.userId],
    );
    const limitMb = userRow?.storageLimitMb ?? globalDefaultMb;
    const limitBytes = limitMb * 1024 * 1024;

    if (currentUsedBytes + file.size > limitBytes) {
      const usedMbStr = (currentUsedBytes / (1024 * 1024)).toFixed(1);
      throw new ForbiddenException(
        `Storage quota exceeded. You are using ${usedMbStr} MB of your ${limitMb} MB limit. Delete existing sources or contact administrator for more space.`,
      );
    }

    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const sourceId = randomUUID();
    const jobId = randomUUID();
    const extension =
      extname(file.originalname).toLowerCase() || this.extensionFor(fileType);
    const fileName = `${sourceId}${extension}`;
    const storageKey = `sources/${graph.id}/${sourceId}/${fileName}`;

    const stored = await this.storage.putObject(
      storageKey,
      file.buffer,
      fileType,
    );
    const fileUrl = stored.location;
    if (stored.storageDriver === 's3') {
      void this.storage
        .putObjectTagging(storageKey, {
          Tier: viewer.tier,
          GraphId: graph.id,
          SourceId: sourceId,
        })
        .catch(() => undefined);
    }

    const content = fileType.startsWith('text/')
      ? file.buffer.toString('utf8')
      : null;
    let source: SourceRecord | undefined;
    try {
      [source] = await this.database.query<SourceRecord>(
        `INSERT INTO "NodeSource" (
           "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "fileHash", "sizeBytes", "status", "jobId", "content", "updatedAt"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9, $10, CURRENT_TIMESTAMP)
         RETURNING "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "sizeBytes", "status", "jobId", "content", "error", "createdAt", "updatedAt"`,
        [
          sourceId,
          dto.nodeId,
          graph.id,
          basename(file.originalname),
          fileType,
          fileUrl,
          fileHash,
          file.size,
          jobId,
          content,
        ],
      );
      await this.redis.set(`JOB_${jobId}:PROGRESS`, '0', 3600);
      this.progressGateway.emitUpdate({
        sourceId,
        graphId: graph.id,
        nodeId: dto.nodeId,
        status: 'PENDING',
        progress: 0,
      });
      let storageUrl: string | undefined;
      if (stored.storageDriver === 's3' || this.storage.getDriver() === 's3') {
        storageUrl = await this.storage
          .getPresignedGetUrl(storageKey, 7200)
          .catch(() => undefined);
      }
      await this.rabbitMq.publishParsingJob({
        jobId,
        sourceId,
        graphId: graph.id,
        nodeId: dto.nodeId,
        filePath: fileUrl,
        fileName: source?.name ?? file.originalname,
        fileHash,
        priority: 5,
        storageKey,
        storageUrl,
      });
    } catch (error: unknown) {
      await this.database.query('DELETE FROM "NodeSource" WHERE "id" = $1', [
        sourceId,
      ]);
      await this.storage.deleteObject(storageKey);
      throw error;
    }
    if (!source) {
      throw new NotFoundException('Source could not be created.');
    }
    return source;
  }

  async presignedUpload(
    identity: ViewerIdentity | undefined,
    dto: PresignedUploadDto,
  ): Promise<{
    sourceId: string;
    jobId: string;
    storageKey: string;
    storageDriver: string;
    isMultipart: boolean;
    uploadUrl?: string;
    headers?: Record<string, string>;
    uploadId?: string;
    parts?: Array<{
      uploadUrl: string;
      partNumber: number;
      headers: Record<string, string>;
    }>;
  }> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    const graph = await this.graphs.findEditable(viewer, dto.graphId);
    this.authorization.assertCan(viewer, 'upload', 'Source', {
      graphUserId: graph.userId,
      graphIsPublic: graph.isPublic,
    });
    if (!graph.nodes.some((node) => node.id === dto.nodeId)) {
      throw new NotFoundException(
        'The selected node does not exist in this graph.',
      );
    }
    const usedBytesRow = await this.database.one<{ totalBytes: string }>(
      `SELECT COALESCE(SUM(s."sizeBytes"), 0)::text AS "totalBytes"
       FROM "NodeSource" s
       JOIN "Graph" g ON g."id" = s."graphId"
       WHERE g."userId" = $1`,
      [viewer.userId],
    );
    const usedBytes = Number(usedBytesRow?.totalBytes ?? '0');
    let limitMb: number = viewer.storageLimitMb ?? 100;
    if (viewer.storageLimitMb === undefined || viewer.storageLimitMb === null) {
      const setting = await this.database.one<{ value: any }>(
        `SELECT "value" FROM "SystemSettings" WHERE "key" = 'storageConfig'`,
      );
      limitMb = setting?.value?.defaultStorageLimitMb ?? 100;
    }
    const maxAllowedBytes = limitMb * 1024 * 1024;
    if (usedBytes + dto.fileSize > maxAllowedBytes) {
      throw new ForbiddenException(
        `Storage quota exceeded. Your current storage limit is ${limitMb} MB. Please delete unused sources or request a storage limit increase.`,
      );
    }

    const uploadLimit = 50;
    const uploadQuota = await this.redis.consumeUploadQuota(
      viewer.userId,
      uploadLimit,
    );
    if (!uploadQuota.allowed) {
      throw new HttpException(
        'Hourly upload limit reached (50/hour). Please try again in the next hour.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const maxBytes = 50 * 1024 * 1024;
    if (dto.fileSize > maxBytes) {
      throw new ForbiddenException('Files are limited to 50 MB.');
    }

    const sourceId = randomUUID();
    const jobId = randomUUID();
    const extension =
      extname(dto.fileName).toLowerCase() || this.extensionFor(dto.fileType);
    const fileName = `${sourceId}${extension}`;
    const storageKey = `sources/${graph.id}/${sourceId}/${fileName}`;

    const presigned = await this.storage.getPresignedUploadUrl({
      key: storageKey,
      contentType: dto.fileType,
      fileSize: dto.fileSize,
      isMultipart: dto.isMultipart ?? false,
      partCount: dto.partCount,
      checksumSha256: dto.checksumSha256,
    });

    return {
      sourceId,
      jobId,
      storageKey: presigned.key,
      storageDriver: presigned.storageDriver,
      isMultipart: presigned.isMultipart,
      uploadUrl: presigned.uploadUrl,
      headers: presigned.headers,
      uploadId: presigned.uploadId,
      parts: presigned.parts,
    };
  }

  async completeUpload(
    identity: ViewerIdentity | undefined,
    dto: CompleteUploadDto,
  ): Promise<SourceSummary> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    const graph = await this.graphs.findEditable(viewer, dto.graphId);
    this.authorization.assertCan(viewer, 'upload', 'Source', {
      graphUserId: graph.userId,
      graphIsPublic: graph.isPublic,
    });
    if (!graph.nodes.some((node) => node.id === dto.nodeId)) {
      throw new NotFoundException(
        'The selected node does not exist in this graph.',
      );
    }

    if (dto.uploadId && dto.parts && dto.parts.length > 0) {
      await this.storage.completeMultipartUpload(
        dto.storageKey,
        dto.uploadId,
        dto.parts,
      );
    }

    const head = await this.storage.headObject(dto.storageKey);
    if (!head.exists) {
      throw new NotFoundException('Uploaded file not found in storage.');
    }

    let fileHash = dto.checksumSha256?.toLowerCase();
    let content: string | null = null;
    const finalSize = head.contentLength || dto.fileSize;

    const isSmallFile = (head.contentLength ?? 0) <= 2 * 1024 * 1024;
    const isTextFile = dto.fileType.startsWith('text/');

    if (isSmallFile && (!fileHash || isTextFile)) {
      const objectData = await this.storage.getObject(dto.storageKey);
      const computedHash = createHash('sha256')
        .update(objectData.buffer)
        .digest('hex');
      if (fileHash && computedHash.toLowerCase() !== fileHash) {
        await this.storage.deleteObject(dto.storageKey);
        throw new HttpException(
          'File checksum validation failed. Corrupted upload.',
          HttpStatus.BAD_REQUEST,
        );
      }
      fileHash = computedHash;
      if (isTextFile) {
        content = objectData.buffer.toString('utf8');
      }
    } else if (!fileHash) {
      fileHash =
        head.eTag || createHash('sha256').update(dto.storageKey).digest('hex');
    }

    const fileUrl =
      this.storage.getDriver() === 's3'
        ? `s3://${this.storage.getBucketName()}/${dto.storageKey}`
        : join(this.uploadDirectory, basename(dto.storageKey));

    if (this.storage.getDriver() === 's3') {
      void this.storage
        .putObjectTagging(dto.storageKey, {
          Tier: viewer.tier,
          GraphId: graph.id,
          SourceId: dto.sourceId,
        })
        .catch(() => undefined);
    }

    let source: SourceRecord | undefined;
    try {
      [source] = await this.database.query<SourceRecord>(
        `INSERT INTO "NodeSource" (
           "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "fileHash", "sizeBytes", "status", "jobId", "content", "updatedAt"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9, $10, CURRENT_TIMESTAMP)
         RETURNING "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "sizeBytes", "status", "jobId", "content", "error", "createdAt", "updatedAt"`,
        [
          dto.sourceId,
          dto.nodeId,
          graph.id,
          basename(dto.fileName),
          dto.fileType,
          fileUrl,
          fileHash,
          finalSize,
          dto.jobId,
          content,
        ],
      );
      await this.redis.set(`JOB_${dto.jobId}:PROGRESS`, '0', 3600);
      this.progressGateway.emitUpdate({
        sourceId: dto.sourceId,
        graphId: graph.id,
        nodeId: dto.nodeId,
        status: 'PENDING',
        progress: 0,
      });
      let storageUrl: string | undefined;
      if (this.storage.getDriver() === 's3') {
        storageUrl = await this.storage
          .getPresignedGetUrl(dto.storageKey, 7200)
          .catch(() => undefined);
      }
      await this.rabbitMq.publishParsingJob({
        jobId: dto.jobId,
        sourceId: dto.sourceId,
        graphId: graph.id,
        nodeId: dto.nodeId,
        filePath: fileUrl,
        fileName: source?.name ?? dto.fileName,
        fileHash,
        priority: 5,
        storageKey: dto.storageKey,
        storageUrl,
      });
    } catch (error: unknown) {
      await this.database.query('DELETE FROM "NodeSource" WHERE "id" = $1', [
        dto.sourceId,
      ]);
      await this.storage.deleteObject(dto.storageKey);
      throw error;
    }

    if (!source) {
      throw new NotFoundException('Source could not be created.');
    }
    return source;
  }

  async abortUpload(
    identity: ViewerIdentity | undefined,
    dto: AbortUploadDto,
  ): Promise<void> {
    this.auth.requireRegistered(this.auth.requireIdentity(identity));
    if (dto.uploadId) {
      await this.storage.abortMultipartUpload(dto.storageKey, dto.uploadId);
    }
    await this.storage.deleteObject(dto.storageKey);
  }

  async handleDirectUpload(
    key: string,
    buffer: Buffer,
    uploadId?: string,
    partNumber?: number,
  ): Promise<{ success: boolean; eTag?: string; partNumber?: number }> {
    if (uploadId && partNumber) {
      const part = await this.storage.saveLocalPart(
        uploadId,
        partNumber,
        buffer,
      );
      return { success: true, eTag: part.eTag, partNumber: part.partNumber };
    }
    await this.storage.putObject(key, buffer);
    const eTag = createHash('md5').update(buffer).digest('hex');
    return { success: true, eTag };
  }

  async get(
    identity: ViewerIdentity | undefined,
    sourceId: string,
    token?: string,
  ): Promise<SourceRecord> {
    const source = await this.database.one<SourceRecord>(
      `SELECT "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "sizeBytes", "status", "jobId", "content", "error", "createdAt", "updatedAt"
       FROM "NodeSource" WHERE "id" = $1`,
      [sourceId],
    );
    if (!source) {
      throw new NotFoundException('Source not found.');
    }
    if (!this.isValidInternalToken(token)) {
      const graph = await this.graphs.findAccessible(identity, source.graphId);
      this.authorization.assertCan(identity, 'read', 'Source', {
        graphUserId: graph.userId,
        graphIsPublic: graph.isPublic,
      });
    }
    return source;
  }

  async progress(
    identity: ViewerIdentity | undefined,
    sourceId: string,
  ): Promise<{
    jobId: string | null;
    progress: number;
    status: SourceRecord['status'];
  }> {
    const source = await this.get(identity, sourceId);
    const progress = source.jobId
      ? Number.parseInt(
          (await this.redis.get(`JOB_${source.jobId}`)) ?? '0',
          10,
        )
      : 100;
    return {
      jobId: source.jobId,
      progress: Number.isFinite(progress) ? progress : 0,
      status: source.status,
    };
  }

  async download(
    identity: ViewerIdentity | undefined,
    sourceId: string,
    rangeHeader?: string,
    token?: string,
  ): Promise<{
    buffer: Buffer;
    contentType: string;
    contentLength: number;
    fileName: string;
    status: number;
    contentRange?: string;
    acceptRanges?: string;
  }> {
    const source = await this.get(identity, sourceId, token);
    if (source.fileUrl.startsWith('seed://')) {
      const isPdf =
        source.fileType === 'application/pdf' ||
        source.name.toLowerCase().endsWith('.pdf');

      let buffer: Buffer;
      let contentType: string;
      let fileName: string;

      if (isPdf) {
        contentType = 'application/pdf';
        fileName = source.name.toLowerCase().endsWith('.pdf')
          ? source.name
          : `${source.name}.pdf`;

        const candidatePaths = [
          join(this.uploadDirectory, `${source.id}.pdf`),
          join(this.uploadDirectory, fileName),
          join(
            process.cwd(),
            '..',
            'viacarraria-database',
            'prisma',
            'seed-data',
            'pdfs',
            `${source.id}.pdf`,
          ),
        ];

        const existingPath = candidatePaths.find((p) => existsSync(p));
        if (existingPath) {
          buffer = await readFile(existingPath);
        } else {
          buffer = this.generateSeedPdf(source.name, source.content || '');
        }
      } else {
        buffer = Buffer.from(source.content || '', 'utf8');
        contentType = 'text/markdown';
        fileName = `${source.name.replace(/\.[^.]+$/, '')}.md`;
      }

      if (rangeHeader && rangeHeader.startsWith('bytes=')) {
        const rangeParts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = Number.parseInt(rangeParts[0] ?? '0', 10) || 0;
        const end = rangeParts[1]
          ? Number.parseInt(rangeParts[1], 10)
          : buffer.length - 1;
        const slice = buffer.subarray(start, end + 1);
        return {
          buffer: slice,
          contentType,
          contentLength: slice.length,
          fileName,
          status: 206,
          contentRange: `bytes ${start}-${end}/${buffer.length}`,
          acceptRanges: 'bytes',
        };
      }

      return {
        buffer,
        contentType,
        contentLength: buffer.length,
        fileName,
        status: 200,
        acceptRanges: 'bytes',
      };
    }

    const result = await this.storage.getObject(source.fileUrl, rangeHeader);
    return {
      ...result,
      fileName: source.name,
    };
  }

  async getFileUrl(
    identity: ViewerIdentity | undefined,
    sourceId: string,
  ): Promise<{ url: string; direct: boolean; fileName: string }> {
    const source = await this.get(identity, sourceId);
    if (source.fileUrl.startsWith('seed://')) {
      return {
        url: `/api/sources/${source.id}/download`,
        direct: false,
        fileName: source.name,
      };
    }

    if (this.storage.getDriver() === 's3') {
      try {
        const presignedUrl = await this.storage.getSignedUrl(
          source.fileUrl,
          3600,
        );
        return { url: presignedUrl, direct: true, fileName: source.name };
      } catch {
        return {
          url: `/api/sources/${source.id}/download`,
          direct: false,
          fileName: source.name,
        };
      }
    }

    return {
      url: `/api/sources/${source.id}/download`,
      direct: false,
      fileName: source.name,
    };
  }

  async createNote(
    identity: ViewerIdentity | undefined,
    dto: CreateNoteDto,
  ): Promise<SourceRecord> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    const graph = await this.graphs.findEditable(viewer, dto.graphId);
    this.authorization.assertCan(viewer, 'upload', 'Source', {
      graphUserId: graph.userId,
      graphIsPublic: graph.isPublic,
    });
    if (!graph.nodes.some((node) => node.id === dto.nodeId)) {
      throw new NotFoundException(
        'The selected node does not exist in this graph.',
      );
    }

    const noteContent = dto.content ?? '';
    const noteBuffer = Buffer.from(noteContent, 'utf8');
    const sizeBytes = noteBuffer.length;

    const userStorage = await this.database.one<{ totalBytes: string }>(
      `SELECT COALESCE(SUM(s."sizeBytes"), 0)::text as "totalBytes"
       FROM "NodeSource" s
       JOIN "Graph" g ON g."id" = s."graphId"
       WHERE g."userId" = $1`,
      [viewer.userId],
    );
    const currentUsedBytes = Number(userStorage?.totalBytes || 0);

    const settingsRow = await this.database.one<{ value: any }>(
      `SELECT "value" FROM "SystemSettings" WHERE "key" = 'storageConfig'`,
    );
    const globalDefaultMb = Number(
      settingsRow?.value?.defaultStorageLimitMb ?? 100,
    );
    const userRow = await this.database.one<{ storageLimitMb: number | null }>(
      'SELECT "storageLimitMb" FROM "User" WHERE "id" = $1',
      [viewer.userId],
    );
    const limitMb = userRow?.storageLimitMb ?? globalDefaultMb;
    const limitBytes = limitMb * 1024 * 1024;

    if (currentUsedBytes + sizeBytes > limitBytes) {
      const usedMbStr = (currentUsedBytes / (1024 * 1024)).toFixed(1);
      throw new ForbiddenException(
        `Storage quota exceeded. You are using ${usedMbStr} MB of your ${limitMb} MB limit.`,
      );
    }

    const fileHash = createHash('sha256').update(noteBuffer).digest('hex');
    const sourceId = randomUUID();
    const jobId = randomUUID();
    const rawTitle = dto.title.trim() || 'Untitled Note';
    const fileName = rawTitle.endsWith('.md') ? rawTitle : `${rawTitle}.md`;
    const storageKey = `sources/${graph.id}/${sourceId}/${fileName}`;

    const stored = await this.storage.putObject(
      storageKey,
      noteBuffer,
      'text/markdown',
    );
    const fileUrl = stored.location;
    if (stored.storageDriver === 's3') {
      void this.storage
        .putObjectTagging(storageKey, {
          Tier: viewer.tier,
          GraphId: graph.id,
          SourceId: sourceId,
        })
        .catch(() => undefined);
    }

    let source: SourceRecord | undefined;
    try {
      [source] = await this.database.query<SourceRecord>(
        `INSERT INTO "NodeSource" (
           "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "fileHash", "sizeBytes", "status", "jobId", "content", "updatedAt"
         ) VALUES ($1, $2, $3, $4, 'text/markdown', $5, $6, $7, 'READY', $8, $9, CURRENT_TIMESTAMP)
         RETURNING "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "sizeBytes", "status", "jobId", "content", "error", "createdAt", "updatedAt"`,
        [
          sourceId,
          dto.nodeId,
          graph.id,
          fileName,
          fileUrl,
          fileHash,
          sizeBytes,
          jobId,
          noteContent,
        ],
      );
      await this.redis.set(`JOB_${jobId}:PROGRESS`, '100', 3600);
      void this.redis.del(`graph:${graph.id}:vocabulary`).catch(() => {});
      const vocabItems = extractVocabularyFromSource({
        id: sourceId,
        nodeId: dto.nodeId,
        name: fileName,
        content: noteContent,
      });
      if (vocabItems.length > 0) {
        void this.redis
          .set(
            `source:${sourceId}:vocabulary`,
            JSON.stringify(vocabItems),
            604800,
          )
          .catch(() => {});
      }
      void this.dispatchTagMatching(
        sourceId,
        graph.id,
        fileName,
        noteContent,
        vocabItems,
        5,
      ).catch(() => {});
      this.progressGateway.emitUpdate({
        sourceId,
        graphId: graph.id,
        nodeId: dto.nodeId,
        status: 'READY',
        progress: 100,
      });

      let storageUrl: string | undefined;
      if (stored.storageDriver === 's3' || this.storage.getDriver() === 's3') {
        storageUrl = await this.storage
          .getPresignedGetUrl(storageKey, 7200)
          .catch(() => undefined);
      }
      await this.rabbitMq.publishParsingJob({
        jobId,
        sourceId,
        graphId: graph.id,
        nodeId: dto.nodeId,
        filePath: fileUrl,
        fileName,
        fileHash,
        priority: 5,
        storageKey,
        storageUrl,
      });
    } catch (error: unknown) {
      await this.database.query('DELETE FROM "NodeSource" WHERE "id" = $1', [
        sourceId,
      ]);
      await this.storage.deleteObject(storageKey);
      throw error;
    }

    if (!source) {
      throw new NotFoundException('Note could not be created.');
    }
    return source;
  }

  async update(
    identity: ViewerIdentity | undefined,
    sourceId: string,
    dto: UpdateSourceDto,
  ): Promise<SourceRecord> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    const existing = await this.get(identity, sourceId);
    const graph = await this.graphs.findEditable(viewer, existing.graphId);
    this.authorization.assertCan(viewer, 'upload', 'Source', {
      graphUserId: graph.userId,
      graphIsPublic: graph.isPublic,
    });

    const newContent =
      dto.content !== undefined ? dto.content : (existing.content ?? '');
    const newName =
      dto.name !== undefined && dto.name.trim()
        ? dto.name.trim()
        : existing.name;
    const noteBuffer = Buffer.from(newContent, 'utf8');
    const sizeBytes = noteBuffer.length;
    const fileHash = createHash('sha256').update(noteBuffer).digest('hex');
    const jobId = randomUUID();

    let storageKey = `sources/${graph.id}/${existing.id}/${existing.id}.md`;
    if (!existing.fileUrl.startsWith('seed://')) {
      const match = existing.fileUrl.match(/sources\/[^/]+\/[^/]+\/[^/]+/);
      if (match) {
        storageKey = match[0];
      }
    }

    await this.storage.putObject(storageKey, noteBuffer, 'text/markdown');

    const [updated] = await this.database.query<SourceRecord>(
      `UPDATE "NodeSource"
       SET "name" = $1, "content" = $2, "sizeBytes" = $3, "fileHash" = $4, "jobId" = $5, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $6
       RETURNING "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "sizeBytes", "status", "jobId", "content", "error", "createdAt", "updatedAt"`,
      [newName, newContent, sizeBytes, fileHash, jobId, sourceId],
    );

    if (!updated) {
      throw new NotFoundException('Source could not be updated.');
    }

    void this.redis.del(`graph:${existing.graphId}:vocabulary`).catch(() => {});
    void this.redis.del(`source:${existing.id}:vocabulary`).catch(() => {});
    if (this.adContextService) {
      void this.adContextService
        .invalidateGraphContext(existing.graphId)
        .catch(() => {});
    }

    let storageUrl: string | undefined;
    if (this.storage.getDriver() === 's3') {
      storageUrl = await this.storage
        .getPresignedGetUrl(storageKey, 7200)
        .catch(() => undefined);
    }

    await this.rabbitMq.publishParsingJob({
      jobId,
      sourceId: existing.id,
      graphId: existing.graphId,
      nodeId: existing.nodeId,
      filePath: updated.fileUrl,
      fileName: newName,
      fileHash,
      priority: 5,
      storageKey,
      storageUrl,
    });

    this.progressGateway.emitUpdate({
      sourceId: existing.id,
      graphId: existing.graphId,
      nodeId: existing.nodeId,
      status: updated.status,
      progress: 100,
    });

    return updated;
  }

  async delete(
    identity: ViewerIdentity | undefined,
    sourceId: string,
  ): Promise<void> {
    const source = await this.get(identity, sourceId);
    await this.graphs.findEditable(identity, source.graphId);
    await this.database.query('DELETE FROM "NodeSource" WHERE "id" = $1', [
      source.id,
    ]);
    if (!source.fileUrl.startsWith('seed://')) {
      await this.storage.deleteObject(source.fileUrl);
    }
    void this.redis.del(`graph:${source.graphId}:vocabulary`).catch(() => {});
    void this.redis.del(`source:${source.id}:vocabulary`).catch(() => {});
    if (this.adContextService) {
      void this.adContextService
        .invalidateGraphContext(source.graphId)
        .catch(() => {});
      void this.adContextService.recalculateMatchCounts().catch(() => {});
    }
  }

  async updateFromWorker(
    token: string | undefined,
    sourceId: string,
    dto: UpdateSourceStatusDto,
  ): Promise<SourceRecord> {
    if (!this.isValidInternalToken(token)) {
      throw new ForbiddenException('Invalid internal service token.');
    }
    const [source] = await this.database.query<SourceRecord>(
      `UPDATE "NodeSource"
       SET "status" = $1, "error" = $2, "content" = COALESCE($3, "content"), "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $4
       RETURNING "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "sizeBytes", "status", "jobId", "content", "error", "createdAt", "updatedAt"`,
      [dto.status, dto.error ?? null, dto.content ?? null, sourceId],
    );
    if (!source) {
      throw new NotFoundException('Source not found.');
    }
    const progress =
      dto.progress ??
      (dto.status === 'READY' ? 100 : dto.status === 'ERROR' ? 0 : 0);
    if (source.jobId) {
      await this.redis.set(
        `JOB_${source.jobId}:PROGRESS`,
        String(progress),
        3600,
      );
    }
    if (source.status === 'READY') {
      void this.redis.del(`graph:${source.graphId}:vocabulary`).catch(() => {});
      const vocabItems = extractVocabularyFromSource({
        id: source.id,
        nodeId: source.nodeId,
        name: source.name,
        content: source.content,
      });
      if (vocabItems.length > 0) {
        void this.redis
          .set(
            `source:${source.id}:vocabulary`,
            JSON.stringify(vocabItems),
            604800,
          )
          .catch(() => {});
      }
      void this.dispatchTagMatching(
        source.id,
        source.graphId,
        source.name,
        source.content,
        vocabItems,
        5,
      ).catch(() => {});
    } else if (source.status === 'ERROR') {
      void this.redis.del(`graph:${source.graphId}:vocabulary`).catch(() => {});
      void this.redis.del(`source:${source.id}:vocabulary`).catch(() => {});
      if (this.adContextService) {
        void this.adContextService
          .invalidateGraphContext(source.graphId)
          .catch(() => {});
      }
    }
    this.progressGateway.emitUpdate({
      sourceId: source.id,
      graphId: source.graphId,
      nodeId: source.nodeId,
      status: source.status,
      progress,
    });
    return source;
  }

  private fileType(file: UploadedDocument): string {
    const extension = extname(file.originalname).toLowerCase();
    if (file.mimetype === 'application/pdf' || extension === '.pdf') {
      if (!file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        throw new UnsupportedMediaTypeException(
          'PDF files must contain a valid PDF signature.',
        );
      }
      return 'application/pdf';
    }
    if (
      file.mimetype === 'text/markdown' ||
      ['.md', '.markdown'].includes(extension)
    ) {
      return 'text/markdown';
    }
    if (
      file.mimetype === 'text/html' ||
      ['.html', '.htm'].includes(extension)
    ) {
      return 'text/html';
    }
    if (
      file.mimetype ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      extension === '.docx'
    ) {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    if (
      file.mimetype ===
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      extension === '.pptx'
    ) {
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    }
    if (
      file.mimetype ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      extension === '.xlsx'
    ) {
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    if (
      file.mimetype === 'text/asciidoc' ||
      ['.adoc', '.asciidoc'].includes(extension)
    ) {
      return 'text/asciidoc';
    }
    if (
      file.mimetype === 'application/rtf' ||
      file.mimetype === 'text/rtf' ||
      extension === '.rtf'
    ) {
      return 'application/rtf';
    }
    if (
      file.mimetype === 'application/vnd.oasis.opendocument.text' ||
      extension === '.odt'
    ) {
      return 'application/vnd.oasis.opendocument.text';
    }
    if (file.mimetype.startsWith('text/') || extension === '.txt') {
      if (file.buffer.includes(0)) {
        throw new UnsupportedMediaTypeException(
          'Text files cannot contain binary data.',
        );
      }
      return 'text/plain';
    }
    throw new UnsupportedMediaTypeException(
      'Unsupported document format. Supported types: PDF, Markdown, Text, Word (docx), PowerPoint (pptx), Excel (xlsx), HTML.',
    );
  }

  private extensionFor(fileType: string): string {
    switch (fileType) {
      case 'application/pdf':
        return '.pdf';
      case 'text/markdown':
        return '.md';
      case 'text/html':
        return '.html';
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return '.docx';
      case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        return '.pptx';
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return '.xlsx';
      case 'text/asciidoc':
        return '.adoc';
      case 'application/rtf':
      case 'text/rtf':
        return '.rtf';
      case 'application/vnd.oasis.opendocument.text':
        return '.odt';
      default:
        return '.txt';
    }
  }

  private generateSeedPdf(title: string, description: string): Buffer {
    const cleanTitle = title.replace(/\.pdf$/i, '').trim();
    const cleanDesc =
      description
        .replace(/[#*`_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() ||
      'Official curriculum syllabus, reading guide, and core lecture outline.';

    const page1Text = [
      'BT',
      '/F1 16 Tf',
      '50 730 Td',
      `(${this.escapePdfText(cleanTitle)} - Syllabus) Tj`,
      '/F2 10 Tf',
      '0 -24 Td',
      '(Via Carraria Academic Curriculum - Spatial GraphRAG) Tj',
      '0 -20 Td',
      '(--------------------------------------------------------------------------------) Tj',
      '/F1 12 Tf',
      '0 -26 Td',
      '(1. Course Overview & Description) Tj',
      '/F2 10 Tf',
      '0 -18 Td',
      `(${this.escapePdfText(cleanDesc.slice(0, 85))}) Tj`,
      '0 -14 Td',
      `(${this.escapePdfText(cleanDesc.slice(85, 170) || 'Comprehensive coverage of core principles and analytical methods.')}) Tj`,
      '0 -24 Td',
      '/F1 12 Tf',
      '(2. Core Modules & Competencies) Tj',
      '/F2 10 Tf',
      '0 -18 Td',
      '(* Module 1: Theoretical Foundations and Prerequisites) Tj',
      '0 -18 Td',
      '(* Module 2: Structural Modeling and Systematic Exploration) Tj',
      '0 -18 Td',
      '(* Module 3: Applied Methodologies, Spatial Reasoning, and Practice) Tj',
      '0 -24 Td',
      '/F1 12 Tf',
      '(3. Assessment & Examination Structure) Tj',
      '/F2 10 Tf',
      '0 -18 Td',
      '(Practical Labs: 40% | Midterm Assessment: 25% | Final Capstone: 35%) Tj',
      'ET',
    ].join('\n');

    const page2Text = [
      'BT',
      '/F1 16 Tf',
      '50 730 Td',
      `(${this.escapePdfText(cleanTitle)} - Reading & Reference Guide) Tj`,
      '/F2 10 Tf',
      '0 -24 Td',
      '(Recommended Bibliography & Primary Literature) Tj',
      '0 -20 Td',
      '(--------------------------------------------------------------------------------) Tj',
      '/F1 12 Tf',
      '0 -26 Td',
      '(4. Primary Reference Literature) Tj',
      '/F2 10 Tf',
      '0 -20 Td',
      `([1] Standard Reference Handbook for ${this.escapePdfText(cleanTitle)}) Tj`,
      '0 -14 Td',
      '(    Fundamental textbook covering theoretical foundations and proof techniques.) Tj',
      '0 -20 Td',
      '([2] Contemporary Applied Case Studies and Research Publications) Tj',
      '0 -14 Td',
      '(    Empirical analysis, domain benchmarks, and algorithmic implementations.) Tj',
      '0 -30 Td',
      '/F1 12 Tf',
      '(5. Academic Integrity & Study Directives) Tj',
      '/F2 10 Tf',
      '0 -18 Td',
      '(Students must connect prerequisites visually on the knowledge canvas.) Tj',
      '0 -14 Td',
      '(Review prompts and core notes should be cross-referenced regularly.) Tj',
      'ET',
    ].join('\n');

    const stream1Length = Buffer.byteLength(page1Text, 'latin1');
    const stream2Length = Buffer.byteLength(page2Text, 'latin1');

    const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
    const obj2 =
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n';
    const obj3 =
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 7 0 R >>\nendobj\n';
    const obj4 =
      '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 8 0 R >>\nendobj\n';
    const obj5 =
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n';
    const obj6 =
      '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
    const obj7 = `7 0 obj\n<< /Length ${stream1Length} >>\nstream\n${page1Text}\nendstream\nendobj\n`;
    const obj8 = `8 0 obj\n<< /Length ${stream2Length} >>\nstream\n${page2Text}\nendstream\nendobj\n`;

    const objects = [obj1, obj2, obj3, obj4, obj5, obj6, obj7, obj8];

    let currentOffset = Buffer.byteLength(header, 'latin1');
    const offsets: number[] = [];

    for (const obj of objects) {
      offsets.push(currentOffset);
      currentOffset += Buffer.byteLength(obj, 'latin1');
    }

    const xrefOffset = currentOffset;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      xref += `${off.toString().padStart(10, '0')} 00000 n \n`;
    }

    const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    const fullPdf = header + objects.join('') + xref + trailer;
    return Buffer.from(fullPdf, 'latin1');
  }

  private escapePdfText(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/[^\x20-\x7E]/g, ' ');
  }

  async uploadAsset(
    token: string | undefined,
    sourceId: string,
    assetName: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<{ assetId: string; url: string; sizeBytes: number }> {
    if (!this.isValidInternalToken(token)) {
      throw new ForbiddenException('Invalid internal service token.');
    }
    const source = await this.database.one<SourceRecord>(
      'SELECT "id", "graphId" FROM "NodeSource" WHERE "id" = $1',
      [sourceId],
    );
    if (!source) {
      throw new NotFoundException('Source not found.');
    }
    const cleanName = basename(assetName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `assets/${sourceId}/${cleanName}`;
    await this.storage.putObject(storageKey, buffer, contentType);
    return {
      assetId: cleanName,
      url: `/api/sources/${sourceId}/assets/${cleanName}`,
      sizeBytes: buffer.length,
    };
  }

  async getAsset(
    sourceId: string,
    assetName: string,
    token?: string,
    identity?: ViewerIdentity,
  ): Promise<{
    buffer: Buffer;
    contentType: string;
    contentLength: number;
    status: number;
  }> {
    const cleanName = basename(assetName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `assets/${sourceId}/${cleanName}`;
    try {
      const result = await this.storage.getObject(storageKey);
      return result;
    } catch {
      throw new NotFoundException('Source asset not found.');
    }
  }

  async setAdTagsFromWorker(
    token: string | undefined,
    sourceId: string,
    dto: SetSourceAdTagsDto,
  ): Promise<{ success: boolean; count: number }> {
    if (!this.isValidInternalToken(token)) {
      throw new ForbiddenException('Invalid internal service token.');
    }
    const [source] = await this.database.query<{ id: string; graphId: string }>(
      `SELECT "id", "graphId" FROM "NodeSource" WHERE "id" = $1`,
      [sourceId],
    );
    if (!source) {
      throw new NotFoundException('Source not found.');
    }
    if (this.adContextService) {
      await this.adContextService.setSourceAdTags(
        sourceId,
        source.graphId,
        dto.matches,
      );
    }
    return { success: true, count: dto.matches.length };
  }

  private async dispatchTagMatching(
    sourceId: string,
    graphId: string,
    sourceName: string,
    sourceContent?: string | null,
    vocabItems?: Array<{ term: string; weight: number }>,
    priority = 5,
  ): Promise<void> {
    try {
      const isAvailable = await this.rabbitMq.isAvailable();
      if (isAvailable) {
        await this.rabbitMq.publishTagMatchingJob({
          jobId: randomUUID(),
          sourceId,
          graphId,
          sourceName,
          sourceContent: sourceContent ?? undefined,
          vocabItems,
          priority,
        });
        return;
      }
    } catch {
      // RabbitMQ unavailable, fallback below
    }

    if (this.adContextService) {
      await this.adContextService.matchSourceWithTags(
        sourceId,
        graphId,
        sourceName,
        sourceContent ?? undefined,
        vocabItems,
      );
    }
  }
}

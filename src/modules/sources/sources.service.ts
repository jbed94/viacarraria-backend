import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import { basename, extname, join } from 'path';

import { DatabaseService } from '../../common/services/database.service.js';
import { AuthorizationService } from '../../common/authorization/ability.js';
import { RabbitMqService } from '../../common/services/rabbitmq.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import type { ViewerIdentity } from '../../common/types.js';
import { AuthService } from '../auth/auth.service.js';
import { GraphsService, type SourceSummary } from '../graphs/graphs.service.js';
import type {
  UpdateSourceStatusDto,
  UploadedDocument,
  UploadSourceDto,
} from './sources.dto.js';
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
    private readonly graphs: GraphsService,
    private readonly auth: AuthService,
    private readonly authorization: AuthorizationService,
    private readonly progressGateway: ProgressGateway,
    config: ConfigService,
  ) {
    this.uploadDirectory =
      config.get<string>('UPLOAD_DIR') ?? join(process.cwd(), 'uploads');
    this.internalToken = config.getOrThrow<string>('INTERNAL_SERVICE_TOKEN');
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
    const uploadQuota = await this.redis.consumeUploadQuota(viewer.userId);
    if (!uploadQuota.allowed) {
      throw new HttpException(
        'Upload limit reached. Try again next hour.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const fileType = this.fileType(file);
    const maxBytes =
      viewer.tier === 'FREE' ? 2 * 1024 * 1024 : 25 * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new ForbiddenException(
        `Files are limited to ${maxBytes / 1024 / 1024} MB for your plan.`,
      );
    }
    if (viewer.tier === 'FREE' && fileType === 'application/pdf') {
      throw new ForbiddenException('PDF uploads require a Pro subscription.');
    }
    if (viewer.tier === 'FREE') {
      const count = await this.database.one<{ count: string }>(
        'SELECT COUNT(*)::text AS "count" FROM "NodeSource" WHERE "graphId" = $1 AND "nodeId" = $2',
        [graph.id, dto.nodeId],
      );
      if (Number(count?.count ?? '0') >= 3) {
        throw new ForbiddenException(
          'Free graphs allow three source documents per node.',
        );
      }
    }

    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const sourceId = randomUUID();
    const jobId = randomUUID();
    const extension =
      extname(file.originalname).toLowerCase() || this.extensionFor(fileType);
    const fileName = `${sourceId}${extension}`;
    const filePath = join(this.uploadDirectory, fileName);
    await mkdir(this.uploadDirectory, { recursive: true });
    await writeFile(filePath, file.buffer);

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
          filePath,
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
      await this.rabbitMq.publishParsingJob({
        jobId,
        sourceId,
        graphId: graph.id,
        nodeId: dto.nodeId,
        filePath,
        fileName: source?.name ?? file.originalname,
        fileHash,
        priority: viewer.tier === 'PRO' ? 10 : 1,
      });
    } catch (error: unknown) {
      await this.database.query('DELETE FROM "NodeSource" WHERE "id" = $1', [
        sourceId,
      ]);
      await rm(filePath, { force: true });
      throw error;
    }
    if (!source) {
      throw new NotFoundException('Source could not be created.');
    }
    return source;
  }

  async get(
    identity: ViewerIdentity | undefined,
    sourceId: string,
  ): Promise<SourceRecord> {
    const source = await this.database.one<SourceRecord>(
      `SELECT "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "sizeBytes", "status", "jobId", "content", "error", "createdAt", "updatedAt"
       FROM "NodeSource" WHERE "id" = $1`,
      [sourceId],
    );
    if (!source) {
      throw new NotFoundException('Source not found.');
    }
    const graph = await this.graphs.findAccessible(identity, source.graphId);
    this.authorization.assertCan(identity, 'read', 'Source', {
      graphUserId: graph.userId,
      graphIsPublic: graph.isPublic,
    });
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
      await rm(source.fileUrl, { force: true });
    }
  }

  async updateFromWorker(
    token: string | undefined,
    sourceId: string,
    dto: UpdateSourceStatusDto,
  ): Promise<SourceRecord> {
    if (!token || token !== this.internalToken) {
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
    this.progressGateway.emitUpdate({
      sourceId: source.id,
      graphId: source.graphId,
      nodeId: source.nodeId,
      status: source.status,
      progress,
    });
    return source;
  }

  private fileType(
    file: UploadedDocument,
  ): 'application/pdf' | 'text/markdown' | 'text/plain' {
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
    if (file.mimetype.startsWith('text/') || extension === '.txt') {
      if (file.buffer.includes(0)) {
        throw new UnsupportedMediaTypeException(
          'Text files cannot contain binary data.',
        );
      }
      return 'text/plain';
    }
    throw new UnsupportedMediaTypeException(
      'Only PDF, Markdown, and text files are supported.',
    );
  }

  private extensionFor(fileType: string): string {
    return fileType === 'application/pdf'
      ? '.pdf'
      : fileType === 'text/markdown'
        ? '.md'
        : '.txt';
  }
}

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
    private readonly storage: StorageService,
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
    const storageKey = `sources/${graph.id}/${sourceId}/${fileName}`;

    const stored = await this.storage.putObject(
      storageKey,
      file.buffer,
      fileType,
    );
    const fileUrl = stored.location;

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
      await this.rabbitMq.publishParsingJob({
        jobId,
        sourceId,
        graphId: graph.id,
        nodeId: dto.nodeId,
        filePath: fileUrl,
        fileName: source?.name ?? file.originalname,
        fileHash,
        priority: viewer.tier === 'PRO' ? 10 : 1,
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
    if (!token || token !== this.internalToken) {
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
}

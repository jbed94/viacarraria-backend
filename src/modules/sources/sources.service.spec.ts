import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';

jest.mock('better-auth', () => ({ betterAuth: jest.fn() }));
jest.mock('better-auth/plugins', () => ({ anonymous: jest.fn() }));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn() }));
jest.mock('../../auth.js', () => ({
  auth: {
    api: {
      getSession: jest.fn(),
    },
  },
}));

import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';

import { SourcesService } from './sources.service.js';
import type { DatabaseService } from '../../common/services/database.service.js';
import type { RedisService } from '../../common/services/redis.service.js';
import type { RabbitMqService } from '../../common/services/rabbitmq.service.js';
import type { StorageService } from '../../common/services/storage.service.js';
import type { GraphsService } from '../graphs/graphs.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { AuthorizationService } from '../../common/authorization/ability.js';
import type { ProgressGateway } from './progress.gateway.js';
import type { UploadedDocument } from './sources.dto.js';
import type { ViewerIdentity } from '../../common/types.js';

describe('SourcesService', () => {
  let service: SourcesService;
  let mockDatabase: Partial<DatabaseService>;
  let mockStorage: Partial<StorageService>;
  let mockGraphs: Partial<GraphsService>;
  let mockRedis: Partial<RedisService>;
  let mockRabbitMq: Partial<RabbitMqService>;
  let mockAuth: Partial<AuthService>;
  let mockAuthorization: Partial<AuthorizationService>;
  let mockProgressGateway: Partial<ProgressGateway>;

  beforeEach(() => {
    mockDatabase = {
      one: jest.fn(),
      query: jest.fn(),
    };
    mockStorage = {
      getDriver: jest.fn().mockReturnValue('s3'),
      getBucketName: jest.fn().mockReturnValue('viacarraria-sources'),
      getObject: jest.fn(),
      getSignedUrl: jest.fn(),
      getPresignedPutUrl: jest.fn().mockResolvedValue({
        uploadUrl: 'https://s3.amazonaws.com/bucket/source.pdf?sig=123',
        key: 'sources/graph-1/src-1/source.pdf',
        storageDriver: 's3',
        headers: { 'Content-Type': 'application/pdf' },
        expiresInSeconds: 900,
      }),
      getPresignedUploadUrl: jest.fn().mockImplementation((options) => {
        if (options.isMultipart) {
          return Promise.resolve({
            key: options.key,
            storageDriver: 's3',
            isMultipart: true,
            uploadId: 'upload-id-999',
            parts: Array.from({ length: options.partCount || 3 }, (_, i) => ({
              uploadUrl: `https://s3.amazonaws.com/bucket/part-${i + 1}?uploadId=upload-id-999`,
              partNumber: i + 1,
              headers: {},
              expiresInSeconds: 900,
            })),
            expiresInSeconds: 900,
          });
        }
        return Promise.resolve({
          uploadUrl: 'https://s3.amazonaws.com/bucket/source.pdf?sig=123',
          key: options.key,
          storageDriver: 's3',
          isMultipart: false,
          headers: { 'Content-Type': options.contentType || 'application/pdf' },
          expiresInSeconds: 900,
        });
      }),
      initiateMultipartUpload: jest.fn().mockResolvedValue({
        uploadId: 'upload-id-999',
        key: 'sources/graph-1/src-1/large.pdf',
      }),
      getPresignedPartUploadUrl: jest
        .fn()
        .mockImplementation((key, uploadId, partNumber) =>
          Promise.resolve({
            uploadUrl: `https://s3.amazonaws.com/bucket/part-${partNumber}?uploadId=${uploadId}`,
            partNumber,
            headers: {},
            expiresInSeconds: 900,
          }),
        ),
      completeMultipartUpload: jest.fn().mockResolvedValue({
        key: 'sources/graph-1/src-1/large.pdf',
        location: 's3://viacarraria-sources/sources/graph-1/src-1/large.pdf',
        storageDriver: 's3',
      }),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      putObjectTagging: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({
        exists: true,
        contentLength: 4096,
        contentType: 'application/pdf',
      }),
      putObject: jest.fn().mockResolvedValue({
        location: 's3://viacarraria-sources/sources/graph-1/source-1.md',
      }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    mockGraphs = {
      findAccessible: jest.fn().mockResolvedValue({
        id: 'graph-1',
        userId: 'user-1',
        isPublic: true,
      }),
      findEditable: jest.fn().mockResolvedValue({
        id: 'graph-1',
        userId: 'user-1',
        isPublic: false,
        nodes: [{ id: 'node-1', label: 'Topic 1' }],
      }),
    };
    mockRedis = {
      consumeUploadQuota: jest
        .fn()
        .mockResolvedValue({ allowed: true, remaining: 9 }),
      set: jest.fn().mockResolvedValue('OK'),
    };
    mockRabbitMq = {
      publishParsingJob: jest.fn().mockResolvedValue(undefined),
    };
    mockAuth = {
      requireIdentity: jest.fn(
        (id: ViewerIdentity | undefined): ViewerIdentity => {
          if (!id)
            throw new UnauthorizedException(
              'A session is required for this action.',
            );
          return id;
        },
      ),
      requireRegistered: jest.fn((id: ViewerIdentity): ViewerIdentity => {
        if (id.isGuest)
          throw new UnauthorizedException(
            'Create an account to access this action.',
          );
        return id;
      }),
    };
    mockAuthorization = {
      assertCan: jest.fn(),
    };
    mockProgressGateway = {
      emitUpdate: jest.fn(),
    };

    const config = new ConfigService({
      UPLOAD_DIR: '/tmp/test-uploads',
      INTERNAL_SERVICE_TOKEN: 'test-internal-token',
    });

    service = new SourcesService(
      mockDatabase as DatabaseService,
      mockRedis as RedisService,
      mockRabbitMq as RabbitMqService,
      mockStorage as StorageService,
      mockGraphs as GraphsService,
      mockAuth as AuthService,
      mockAuthorization as AuthorizationService,
      mockProgressGateway as ProgressGateway,
      config,
    );
  });

  it('should serve seed PDF sources with application/pdf and valid PDF-1.4 header', async () => {
    (mockDatabase.one as jest.Mock).mockResolvedValue({
      id: 'source-cs-intro-pdf',
      nodeId: 'cs-intro',
      graphId: 'graph-1',
      name: 'Computer Systems - Syllabus.pdf',
      fileType: 'application/pdf',
      fileUrl: 'seed://source-cs-intro-pdf',
      content: '# Computer Systems Syllabus\nDetailed lecture notes.',
      status: 'READY',
    });

    const result = await service.download(undefined, 'source-cs-intro-pdf');

    expect(result.status).toBe(200);
    expect(result.contentType).toBe('application/pdf');
    expect(result.fileName).toBe('Computer Systems - Syllabus.pdf');
    expect(result.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(result.acceptRanges).toBe('bytes');
  });

  it('should support HTTP Range requests for seed PDFs (HTTP 206)', async () => {
    (mockDatabase.one as jest.Mock).mockResolvedValue({
      id: 'source-cs-intro-pdf',
      nodeId: 'cs-intro',
      graphId: 'graph-1',
      name: 'Computer Systems - Syllabus.pdf',
      fileType: 'application/pdf',
      fileUrl: 'seed://source-cs-intro-pdf',
      content: '# Computer Systems Syllabus\nDetailed lecture notes.',
      status: 'READY',
    });

    const result = await service.download(
      undefined,
      'source-cs-intro-pdf',
      'bytes=0-9',
    );

    expect(result.status).toBe(206);
    expect(result.contentType).toBe('application/pdf');
    expect(result.contentLength).toBe(10);
    expect(result.buffer.length).toBe(10);
    expect(result.contentRange).toMatch(/^bytes 0-9\/\d+$/);
  });

  it('should serve seed Markdown sources as text/markdown', async () => {
    (mockDatabase.one as jest.Mock).mockResolvedValue({
      id: 'source-cs-intro-core',
      nodeId: 'cs-intro',
      graphId: 'graph-1',
      name: 'Core Notes.md',
      fileType: 'text/markdown',
      fileUrl: 'seed://source-cs-intro-core',
      content: '# Core Notes Content',
      status: 'READY',
    });

    const result = await service.download(undefined, 'source-cs-intro-core');

    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/markdown');
    expect(result.fileName).toBe('Core Notes.md');
    expect(result.buffer.toString('utf8')).toBe('# Core Notes Content');
  });

  it('should delegate non-seed sources to StorageService', async () => {
    (mockDatabase.one as jest.Mock).mockResolvedValue({
      id: 'source-custom-1',
      nodeId: 'cs-intro',
      graphId: 'graph-1',
      name: 'Uploaded.pdf',
      fileType: 'application/pdf',
      fileUrl: 's3://viacarraria-sources/sources/graph-1/custom.pdf',
      status: 'READY',
    });

    (mockStorage.getObject as jest.Mock).mockResolvedValue({
      buffer: Buffer.from('%PDF-1.4 test'),
      contentType: 'application/pdf',
      contentLength: 13,
      status: 200,
      acceptRanges: 'bytes',
    });

    const result = await service.download(undefined, 'source-custom-1');

    expect(mockStorage.getObject).toHaveBeenCalledWith(
      's3://viacarraria-sources/sources/graph-1/custom.pdf',
      undefined,
    );
    expect(result.status).toBe(200);
    expect(result.fileName).toBe('Uploaded.pdf');
  });

  describe('upload validation & quotas', () => {
    const freeViewer: ViewerIdentity = {
      userId: 'user-free-1',
      email: 'free@example.com',
      username: 'freeuser',
      isGuest: false,
      tier: 'FREE',
    };

    const proViewer: ViewerIdentity = {
      userId: 'user-pro-1',
      email: 'pro@example.com',
      username: 'prouser',
      isGuest: false,
      tier: 'PRO',
    };

    const uploadDto = {
      graphId: 'graph-1',
      nodeId: 'node-1',
    };

    it('rejects upload if selected node does not exist in target graph', async () => {
      await expect(
        service.upload(
          freeViewer,
          { graphId: 'graph-1', nodeId: 'non-existent-node' },
          {
            originalname: 'notes.md',
            mimetype: 'text/markdown',
            size: 100,
            buffer: Buffer.from('# Hello'),
          },
        ),
      ).rejects.toThrow(
        new NotFoundException(
          'The selected node does not exist in this graph.',
        ),
      );
    });

    it('rejects upload if file object is undefined', async () => {
      await expect(
        service.upload(freeViewer, uploadDto, undefined),
      ).rejects.toThrow(
        new UnsupportedMediaTypeException(
          'Choose a PDF, Markdown, or text file to upload.',
        ),
      );
    });

    it('throws HTTP 429 when hourly upload quota is exhausted', async () => {
      (mockRedis.consumeUploadQuota as jest.Mock).mockResolvedValue({
        allowed: false,
        remaining: 0,
      });

      const file: UploadedDocument = {
        originalname: 'notes.md',
        mimetype: 'text/markdown',
        size: 500,
        buffer: Buffer.from('# Test notes'),
      };

      await expect(service.upload(freeViewer, uploadDto, file)).rejects.toThrow(
        new HttpException(
          'Upload limit reached. Try again next hour.',
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
    });

    it('rejects PDF uploads on Free tier with ForbiddenException', async () => {
      const pdfFile: UploadedDocument = {
        originalname: 'paper.pdf',
        mimetype: 'application/pdf',
        size: 1024,
        buffer: Buffer.from('%PDF-1.4 sample content'),
      };

      await expect(
        service.upload(freeViewer, uploadDto, pdfFile),
      ).rejects.toThrow(
        new ForbiddenException('PDF uploads require a Pro subscription.'),
      );
    });

    it('rejects files larger than 2MB on Free tier', async () => {
      const largeFile: UploadedDocument = {
        originalname: 'large.md',
        mimetype: 'text/markdown',
        size: 2 * 1024 * 1024 + 1, // 2MB + 1 byte
        buffer: Buffer.from('# Very large content'),
      };

      await expect(
        service.upload(freeViewer, uploadDto, largeFile),
      ).rejects.toThrow(
        new ForbiddenException('Files are limited to 2 MB for your plan.'),
      );
    });

    it('rejects files larger than 25MB on Pro tier', async () => {
      const hugeFile: UploadedDocument = {
        originalname: 'huge.pdf',
        mimetype: 'application/pdf',
        size: 25 * 1024 * 1024 + 1, // 25MB + 1 byte
        buffer: Buffer.from('%PDF-1.4 huge content'),
      };

      await expect(
        service.upload(proViewer, uploadDto, hugeFile),
      ).rejects.toThrow(
        new ForbiddenException('Files are limited to 25 MB for your plan.'),
      );
    });

    it('enforces maximum 3 sources per node on Free tier', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValue({ count: '3' });

      const file: UploadedDocument = {
        originalname: 'fourth-source.md',
        mimetype: 'text/markdown',
        size: 1024,
        buffer: Buffer.from('# Fourth source'),
      };

      await expect(service.upload(freeViewer, uploadDto, file)).rejects.toThrow(
        new ForbiddenException(
          'Free graphs allow three source documents per node.',
        ),
      );
    });

    it('rejects malformed PDF lacking %PDF- header signature', async () => {
      const corruptPdf: UploadedDocument = {
        originalname: 'fake.pdf',
        mimetype: 'application/pdf',
        size: 512,
        buffer: Buffer.from('NOT A REAL PDF FILE HEADER'),
      };

      await expect(
        service.upload(proViewer, uploadDto, corruptPdf),
      ).rejects.toThrow(
        new UnsupportedMediaTypeException(
          'PDF files must contain a valid PDF signature.',
        ),
      );
    });

    it('processes Markdown upload for Free tier with priority 1 job', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValue({ count: '1' });
      (mockDatabase.query as jest.Mock).mockResolvedValue([
        {
          id: 'source-new-1',
          nodeId: 'node-1',
          graphId: 'graph-1',
          name: 'notes.md',
          fileType: 'text/markdown',
          fileUrl:
            's3://viacarraria-sources/sources/graph-1/source-new-1/source-new-1.md',
          sizeBytes: 256,
          status: 'PENDING',
          jobId: 'job-123',
          content: '# Notes content',
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const file: UploadedDocument = {
        originalname: 'notes.md',
        mimetype: 'text/markdown',
        size: 256,
        buffer: Buffer.from('# Notes content'),
      };

      const result = await service.upload(freeViewer, uploadDto, file);

      expect(mockStorage.putObject).toHaveBeenCalled();
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "NodeSource"'),
        expect.any(Array),
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^JOB_.*:PROGRESS$/),
        '0',
        3600,
      );
      expect(mockProgressGateway.emitUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: 'graph-1',
          nodeId: 'node-1',
          status: 'PENDING',
          progress: 0,
        }),
      );
      expect(mockRabbitMq.publishParsingJob).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: 'graph-1',
          nodeId: 'node-1',
          fileName: 'notes.md',
          priority: 1, // Free tier priority 1
        }),
      );
      expect(result.id).toBe('source-new-1');
    });

    it('processes PDF upload for Pro tier with priority 10 job', async () => {
      (mockDatabase.query as jest.Mock).mockResolvedValue([
        {
          id: 'source-pdf-1',
          nodeId: 'node-1',
          graphId: 'graph-1',
          name: 'research.pdf',
          fileType: 'application/pdf',
          fileUrl:
            's3://viacarraria-sources/sources/graph-1/source-pdf-1/source-pdf-1.pdf',
          sizeBytes: 2048,
          status: 'PENDING',
          jobId: 'job-pdf-1',
          content: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const pdfFile: UploadedDocument = {
        originalname: 'research.pdf',
        mimetype: 'application/pdf',
        size: 2048,
        buffer: Buffer.from('%PDF-1.4 mock research paper binary stream'),
      };

      const result = await service.upload(proViewer, uploadDto, pdfFile);

      expect(mockRabbitMq.publishParsingJob).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: 'graph-1',
          nodeId: 'node-1',
          priority: 10, // Pro tier priority 10
        }),
      );
      expect(result.id).toBe('source-pdf-1');
    });
  });

  describe('Resumable Multipart & Presigned Uploads', () => {
    const freeViewer: ViewerIdentity = {
      userId: 'user-free-1',
      email: 'free@example.com',
      username: 'freeuser',
      isGuest: false,
      tier: 'FREE',
    };

    const proViewer: ViewerIdentity = {
      userId: 'user-pro-1',
      email: 'pro@example.com',
      username: 'prouser',
      isGuest: false,
      tier: 'PRO',
    };

    it('generates presigned PUT upload URL for single document', async () => {
      const presignedDto = {
        graphId: 'graph-1',
        nodeId: 'node-1',
        fileName: 'dataset.csv',
        fileSize: 1024 * 50,
        fileType: 'text/csv',
        checksumSha256:
          'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
      };

      const result = await service.presignedUpload(freeViewer, presignedDto);

      expect(result.sourceId).toBeDefined();
      expect(result.jobId).toBeDefined();
      expect(result.isMultipart).toBe(false);
      expect(result.uploadUrl).toBeDefined();
      expect(mockStorage.getPresignedUploadUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          isMultipart: false,
          contentType: 'text/csv',
        }),
      );
    });

    it('initiates multipart upload and returns part URLs when isMultipart is true', async () => {
      const multipartDto = {
        graphId: 'graph-1',
        nodeId: 'node-1',
        fileName: 'huge-archive.pdf',
        fileSize: 1024 * 1024 * 20,
        fileType: 'application/pdf',
        isMultipart: true,
        partCount: 3,
      };

      const result = await service.presignedUpload(proViewer, multipartDto);

      expect(result.isMultipart).toBe(true);
      expect(result.uploadId).toBe('upload-id-999');
      expect(result.parts).toHaveLength(3);
      expect(mockStorage.getPresignedUploadUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          isMultipart: true,
          partCount: 3,
        }),
      );
    });

    it('allows PRO tier presigned uploads larger than 100MB up to 1GB', async () => {
      const largeDto = {
        graphId: 'graph-1',
        nodeId: 'node-1',
        fileName: 'massive-dataset.zip',
        fileSize: 500 * 1024 * 1024, // 500MB
        fileType: 'application/zip',
        isMultipart: true,
        partCount: 25,
      };

      const result = await service.presignedUpload(proViewer, largeDto);
      expect(result.isMultipart).toBe(true);
      expect(result.uploadId).toBeDefined();
    });

    it('rejects presigned uploads larger than 1GB on PRO tier', async () => {
      const oversizedDto = {
        graphId: 'graph-1',
        nodeId: 'node-1',
        fileName: 'too-big.zip',
        fileSize: 1024 * 1024 * 1024 + 1, // 1GB + 1 byte
        fileType: 'application/zip',
        isMultipart: true,
      };

      await expect(
        service.presignedUpload(proViewer, oversizedDto),
      ).rejects.toThrow(
        new ForbiddenException('Files are limited to 1024 MB for your plan.'),
      );
    });

    it('completes upload, verifies checksum sha256, inserts source, and dispatches job', async () => {
      const dummyBuffer = Buffer.from(
        'Reliable high integrity dataset content',
      );
      const expectedChecksum = createHash('sha256')
        .update(dummyBuffer)
        .digest('hex');

      (mockStorage.getObject as jest.Mock).mockResolvedValueOnce({
        buffer: dummyBuffer,
        contentType: 'text/plain',
        contentLength: dummyBuffer.length,
        status: 200,
      });

      (mockDatabase.query as jest.Mock).mockResolvedValueOnce([
        {
          id: 'src-complete-1',
          nodeId: 'node-1',
          graphId: 'graph-1',
          name: 'data.txt',
          fileType: 'text/plain',
          fileUrl:
            's3://viacarraria-sources/sources/graph-1/src-complete-1/data.txt',
          sizeBytes: dummyBuffer.length,
          status: 'PENDING',
          jobId: 'job-complete-1',
          content: dummyBuffer.toString('utf8'),
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const completeDto = {
        sourceId: 'src-complete-1',
        jobId: 'job-complete-1',
        graphId: 'graph-1',
        nodeId: 'node-1',
        fileName: 'data.txt',
        fileSize: dummyBuffer.length,
        fileType: 'text/plain',
        storageKey: 'sources/graph-1/src-complete-1/data.txt',
        checksumSha256: expectedChecksum,
      };

      const res = await service.completeUpload(freeViewer, completeDto);

      expect(res.id).toBe('src-complete-1');
      expect(mockProgressGateway.emitUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'src-complete-1',
          status: 'PENDING',
          progress: 0,
        }),
      );
      expect(mockRabbitMq.publishParsingJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-complete-1',
          fileHash: expectedChecksum,
        }),
      );
    });

    it('rejects completeUpload if SHA-256 checksum mismatches', async () => {
      const corruptedBuffer = Buffer.from('Corrupted payload');

      (mockStorage.getObject as jest.Mock).mockResolvedValueOnce({
        buffer: corruptedBuffer,
        contentType: 'text/plain',
        contentLength: corruptedBuffer.length,
        status: 200,
      });

      const completeDto = {
        sourceId: 'src-corrupted-1',
        jobId: 'job-corrupted-1',
        graphId: 'graph-1',
        nodeId: 'node-1',
        fileName: 'corrupted.txt',
        fileSize: corruptedBuffer.length,
        fileType: 'text/plain',
        storageKey: 'sources/graph-1/src-corrupted-1/corrupted.txt',
        checksumSha256:
          '0000000000000000000000000000000000000000000000000000000000000000',
      };

      await expect(
        service.completeUpload(freeViewer, completeDto),
      ).rejects.toThrow(HttpException);
      expect(mockStorage.deleteObject).toHaveBeenCalledWith(
        completeDto.storageKey,
      );
    });

    it('completes large file (>100MB) multipart upload without buffering file data in memory via getObject', async () => {
      const largeFileSize = 250 * 1024 * 1024; // 250MB
      const sha256 =
        'abc123def456789012345678901234567890123456789012345678901234abcd';

      (mockStorage.headObject as jest.Mock).mockResolvedValueOnce({
        exists: true,
        contentLength: largeFileSize,
        contentType: 'application/pdf',
        eTag: 's3-etag-multi-part-12345',
      });

      (mockDatabase.query as jest.Mock).mockResolvedValueOnce([
        {
          id: 'src-large-1',
          nodeId: 'node-1',
          graphId: 'graph-1',
          name: 'large-corpus.pdf',
          fileType: 'application/pdf',
          fileUrl:
            's3://viacarraria-sources/sources/graph-1/src-large-1/large-corpus.pdf',
          sizeBytes: largeFileSize,
          status: 'PENDING',
          jobId: 'job-large-1',
          content: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const completeDto = {
        sourceId: 'src-large-1',
        jobId: 'job-large-1',
        graphId: 'graph-1',
        nodeId: 'node-1',
        fileName: 'large-corpus.pdf',
        fileSize: largeFileSize,
        fileType: 'application/pdf',
        storageKey: 'sources/graph-1/src-large-1/large-corpus.pdf',
        uploadId: 'upload-id-large',
        parts: [
          { partNumber: 1, eTag: 'etag-1' },
          { partNumber: 2, eTag: 'etag-2' },
        ],
        checksumSha256: sha256,
      };

      const res = await service.completeUpload(proViewer, completeDto);

      expect(res.id).toBe('src-large-1');
      expect(mockStorage.completeMultipartUpload).toHaveBeenCalledWith(
        completeDto.storageKey,
        'upload-id-large',
        completeDto.parts,
      );
      expect(mockStorage.headObject).toHaveBeenCalledWith(
        completeDto.storageKey,
      );
      // Ensure getObject was NOT called, completely bypassing memory buffers!
      expect(mockStorage.getObject).not.toHaveBeenCalled();
      expect(mockRabbitMq.publishParsingJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-large-1',
          fileHash: sha256,
        }),
      );
    });

    it('aborts upload and cleans up storage', async () => {
      await service.abortUpload(freeViewer, {
        storageKey: 'sources/graph-1/temp/file.pdf',
        uploadId: 'upload-id-999',
      });

      expect(mockStorage.abortMultipartUpload).toHaveBeenCalledWith(
        'sources/graph-1/temp/file.pdf',
        'upload-id-999',
      );
      expect(mockStorage.deleteObject).toHaveBeenCalledWith(
        'sources/graph-1/temp/file.pdf',
      );
    });
  });
});

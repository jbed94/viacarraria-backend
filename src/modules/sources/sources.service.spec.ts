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

import { SourcesService } from './sources.service.js';
import type { DatabaseService } from '../../common/services/database.service.js';
import type { RedisService } from '../../common/services/redis.service.js';
import type { RabbitMqService } from '../../common/services/rabbitmq.service.js';
import type { StorageService } from '../../common/services/storage.service.js';
import type { GraphsService } from '../graphs/graphs.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { AuthorizationService } from '../../common/authorization/ability.js';
import type { ProgressGateway } from './progress.gateway.js';

describe('SourcesService - PDF & Seed Storage', () => {
  let service: SourcesService;
  let mockDatabase: Partial<DatabaseService>;
  let mockStorage: Partial<StorageService>;
  let mockGraphs: Partial<GraphsService>;

  beforeEach(() => {
    mockDatabase = {
      one: jest.fn(),
      query: jest.fn(),
    };
    mockStorage = {
      getDriver: jest.fn().mockReturnValue('s3'),
      getObject: jest.fn(),
      getSignedUrl: jest.fn(),
      putObject: jest.fn(),
      deleteObject: jest.fn(),
    };
    mockGraphs = {
      findAccessible: jest.fn().mockResolvedValue({
        id: 'graph-1',
        userId: 'user-1',
        isPublic: true,
      }),
    };

    const config = new ConfigService({
      UPLOAD_DIR: '/tmp/test-uploads',
      INTERNAL_SERVICE_TOKEN: 'test-internal-token',
    });

    service = new SourcesService(
      mockDatabase as DatabaseService,
      {} as RedisService,
      {} as RabbitMqService,
      mockStorage as StorageService,
      mockGraphs as GraphsService,
      {} as AuthService,
      { assertCan: jest.fn() } as unknown as AuthorizationService,
      {} as ProgressGateway,
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
});

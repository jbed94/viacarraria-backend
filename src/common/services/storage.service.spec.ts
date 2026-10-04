import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { StorageService } from './storage.service.js';

describe('StorageService', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'viacarraria-storage-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('Local storage driver', () => {
    it('should initialize with local driver when STORAGE_DRIVER is local', () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 'local',
        UPLOAD_DIR: tempDir,
      });
      const storage = new StorageService(config);

      expect(storage.getDriver()).toBe('local');
      expect(storage.getUploadDirectory()).toBe(tempDir);
    });

    it('should store, retrieve, and delete files locally', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 'local',
        UPLOAD_DIR: tempDir,
      });
      const storage = new StorageService(config);

      const content = Buffer.from('Hello, Via Carraria persistent storage!');
      const key = 'test-doc.txt';

      const putResult = await storage.putObject(key, content, 'text/plain');
      expect(putResult.key).toBe(key);
      expect(putResult.storageDriver).toBe('local');
      expect(putResult.location).toContain(tempDir);

      const savedOnDisk = await readFile(putResult.location);
      expect(savedOnDisk.toString()).toBe(content.toString());

      const getResult = await storage.getObject(key);
      expect(getResult.status).toBe(200);
      expect(getResult.contentType).toBe('text/plain');
      expect(getResult.buffer.toString()).toBe(content.toString());
      expect(getResult.contentLength).toBe(content.length);

      await storage.deleteObject(key);
      await expect(storage.getObject(key)).rejects.toThrow();
    });

    it('should support HTTP Range requests for partial content', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 'local',
        UPLOAD_DIR: tempDir,
      });
      const storage = new StorageService(config);

      const content = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      const key = 'range-test.bin';
      await storage.putObject(key, content, 'application/octet-stream');

      // Request bytes 0 to 9
      const rangeResult = await storage.getObject(key, 'bytes=0-9');
      expect(rangeResult.status).toBe(206);
      expect(rangeResult.buffer.toString()).toBe('0123456789');
      expect(rangeResult.contentLength).toBe(10);
      expect(rangeResult.contentRange).toBe(`bytes 0-9/${content.length}`);

      // Request bytes 10 to 19
      const rangeResult2 = await storage.getObject(key, 'bytes=10-19');
      expect(rangeResult2.status).toBe(206);
      expect(rangeResult2.buffer.toString()).toBe('ABCDEFGHIJ');
    });
  });

  describe('S3 storage driver & SigV4 presigned URLs', () => {
    it('should configure S3 driver and generate valid AWS SigV4 presigned URLs', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        S3_BUCKET: 'viacarraria-sources',
        S3_FORCE_PATH_STYLE: 'true',
        S3_PUBLIC_URL: 'https://storage.viacarraria.internal',
      });
      const storage = new StorageService(config);

      expect(storage.getDriver()).toBe('s3');
      expect(storage.getBucketName()).toBe('viacarraria-sources');

      const presignedUrl = await storage.getSignedUrl(
        'sources/graph-1/doc.pdf',
        1800,
      );

      expect(presignedUrl).toContain(
        'https://storage.viacarraria.internal/viacarraria-sources/sources/graph-1/doc.pdf',
      );
      expect(presignedUrl).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
      expect(presignedUrl).toContain('X-Amz-Credential=minioadmin');
      expect(presignedUrl).toContain('X-Amz-Expires=1800');
      expect(presignedUrl).toContain('X-Amz-Signature=');

      const presignedGetUrl = await storage.getPresignedGetUrl(
        'sources/graph-1/doc.pdf',
        3600,
      );
      expect(presignedGetUrl).toContain('X-Amz-Expires=3600');
      expect(presignedGetUrl).toContain('X-Amz-Signature=');
    });

    it('should generate valid AWS SigV4 presigned PUT URLs for direct uploads', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        S3_BUCKET: 'viacarraria-sources',
        S3_FORCE_PATH_STYLE: 'true',
        S3_PUBLIC_URL: 'https://storage.viacarraria.internal',
      });
      const storage = new StorageService(config);

      const result = await storage.getPresignedPutUrl(
        'sources/graph-1/upload.pdf',
        'application/pdf',
        900,
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );

      expect(result.storageDriver).toBe('s3');
      expect(result.key).toBe('sources/graph-1/upload.pdf');
      expect(result.uploadUrl).toContain(
        'https://storage.viacarraria.internal',
      );
      expect(result.uploadUrl).toContain('X-Amz-Signature=');
      expect(result.headers['Content-Type']).toBe('application/pdf');
      expect(result.headers['x-amz-checksum-sha256']).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    it('should fallback to local gracefully when S3_ENDPOINT is omitted', () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: '',
        UPLOAD_DIR: tempDir,
      });
      const storage = new StorageService(config);

      expect(storage.getDriver()).toBe('local');
    });

    it('should configure S3 bucket lifecycle policy with SigV4 authentication and XML payload', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        S3_BUCKET: 'viacarraria-sources',
        S3_FORCE_PATH_STYLE: 'true',
        S3_ABORT_INCOMPLETE_DAYS: '2',
      });
      const storage = new StorageService(config);

      const originalFetch = globalThis.fetch;
      let capturedUrl = '';
      let capturedMethod = '';
      let capturedHeaders: Record<string, string> = {};
      let capturedBody = '';

      globalThis.fetch = (async (url: string, init?: any) => {
        capturedUrl = url;
        capturedMethod = init?.method;
        capturedHeaders = init?.headers;
        capturedBody = Buffer.isBuffer(init?.body)
          ? init.body.toString('utf-8')
          : init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString('utf-8')
            : String(init?.body || '');
        return {
          ok: true,
          status: 200,
          text: async () => '',
        };
      }) as any;

      try {
        await storage.ensureBucketLifecycle();

        expect(capturedUrl).toBe(
          'http://localhost:9000/viacarraria-sources?lifecycle',
        );
        expect(capturedMethod).toBe('PUT');
        expect(capturedHeaders['Authorization']).toContain('AWS4-HMAC-SHA256');
        expect(capturedHeaders['Authorization']).toContain(
          'Credential=minioadmin',
        );
        expect(capturedHeaders['content-type']).toBe('application/xml');
        expect(capturedBody).toContain('<LifecycleConfiguration>');
        expect(capturedBody).toContain(
          '<DaysAfterInitiation>2</DaysAfterInitiation>',
        );
        expect(capturedBody).toContain(
          '<ID>AbortIncompleteMultipartUploads</ID>',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should automatically invoke ensureBucketLifecycle when ensureBucket creates or verifies bucket', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        S3_BUCKET: 'viacarraria-sources',
        S3_FORCE_PATH_STYLE: 'true',
      });
      const storage = new StorageService(config);

      const lifecycleSpy = jest.spyOn(storage, 'ensureBucketLifecycle');
      const originalFetch = globalThis.fetch;

      globalThis.fetch = (async (url: string, init?: any) => {
        if (init?.method === 'HEAD') {
          return { ok: true, status: 200 };
        }
        return { ok: true, status: 200, text: async () => '' };
      }) as any;

      try {
        await storage.ensureBucket();
        expect(lifecycleSpy).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
        lifecycleSpy.mockRestore();
      }
    });

    it('should configure multi-rule lifecycle policies including IA and Glacier transitions', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        S3_BUCKET: 'viacarraria-sources',
        S3_FORCE_PATH_STYLE: 'true',
        S3_TRANSITION_IA_DAYS: '90',
        S3_TRANSITION_GLACIER_DAYS: '365',
      });
      const storage = new StorageService(config);

      const originalFetch = globalThis.fetch;
      let capturedBody = '';

      globalThis.fetch = (async (_url: string, init?: any) => {
        capturedBody = Buffer.isBuffer(init?.body)
          ? init.body.toString('utf-8')
          : init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString('utf-8')
            : String(init?.body || '');
        return { ok: true, status: 200, text: async () => '' };
      }) as any;

      try {
        await storage.ensureBucketLifecycle();

        expect(capturedBody).toContain(
          '<ID>AbortIncompleteMultipartUploads</ID>',
        );
        expect(capturedBody).toContain(
          '<ID>TransitionSourcesToInfrequentAccess</ID>',
        );
        expect(capturedBody).toContain(
          '<StorageClass>STANDARD_IA</StorageClass>',
        );
        expect(capturedBody).toContain('<Days>90</Days>');
        expect(capturedBody).toContain(
          '<ID>TransitionSourcesToGlacierArchive</ID>',
        );
        expect(capturedBody).toContain('<StorageClass>GLACIER</StorageClass>');
        expect(capturedBody).toContain('<Days>365</Days>');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should sign and dispatch S3 object tagging PUT request with XML TagSet', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        S3_BUCKET: 'viacarraria-sources',
        S3_FORCE_PATH_STYLE: 'true',
      });
      const storage = new StorageService(config);

      const originalFetch = globalThis.fetch;
      let capturedUrl = '';
      let capturedMethod = '';
      let capturedBody = '';

      globalThis.fetch = (async (url: string, init?: any) => {
        capturedUrl = url;
        capturedMethod = init?.method;
        capturedBody = Buffer.isBuffer(init?.body)
          ? init.body.toString('utf-8')
          : init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString('utf-8')
            : String(init?.body || '');
        return { ok: true, status: 200, text: async () => '' };
      }) as any;

      try {
        await storage.putObjectTagging('sources/g-1/doc.pdf', {
          Tier: 'PRO',
          GraphId: 'g-1',
        });

        expect(capturedUrl).toBe(
          'http://localhost:9000/viacarraria-sources/sources/g-1/doc.pdf?tagging',
        );
        expect(capturedMethod).toBe('PUT');
        expect(capturedBody).toContain('<Tagging>');
        expect(capturedBody).toContain(
          '<Tag><Key>Tier</Key><Value>PRO</Value></Tag>',
        );
        expect(capturedBody).toContain(
          '<Tag><Key>GraphId</Key><Value>g-1</Value></Tag>',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('Multipart uploads & Checksum support (local driver)', () => {
    it('should handle multipart chunking, save parts, and concatenate on complete', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 'local',
        UPLOAD_DIR: tempDir,
      });
      const storage = new StorageService(config);

      const key = 'multipart-test.bin';
      const init = await storage.initiateMultipartUpload(key);
      expect(init.uploadId).toBeDefined();

      const part1 = Buffer.from('Chunk1-Header-');
      const part2 = Buffer.from('Chunk2-Payload-');
      const part3 = Buffer.from('Chunk3-Footer');

      const res1 = await storage.saveLocalPart(init.uploadId, 1, part1);
      const res2 = await storage.saveLocalPart(init.uploadId, 2, part2);
      const res3 = await storage.saveLocalPart(init.uploadId, 3, part3);

      expect(res1.partNumber).toBe(1);
      expect(res1.eTag).toBeDefined();

      const completed = await storage.completeMultipartUpload(
        key,
        init.uploadId,
        [
          { partNumber: 2, eTag: res2.eTag },
          { partNumber: 1, eTag: res1.eTag },
          { partNumber: 3, eTag: res3.eTag },
        ],
      );

      expect(completed.storageDriver).toBe('local');
      const finalDoc = await storage.getObject(key);
      expect(finalDoc.buffer.toString()).toBe(
        'Chunk1-Header-Chunk2-Payload-Chunk3-Footer',
      );

      const head = await storage.headObject(key);
      expect(head.exists).toBe(true);
      expect(head.contentLength).toBe(
        Buffer.from('Chunk1-Header-Chunk2-Payload-Chunk3-Footer').length,
      );
    });

    it('should abort multipart upload and clean up temporary parts', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 'local',
        UPLOAD_DIR: tempDir,
      });
      const storage = new StorageService(config);

      const key = 'aborted-multipart.bin';
      const init = await storage.initiateMultipartUpload(key);
      await storage.saveLocalPart(init.uploadId, 1, Buffer.from('PartData'));

      await storage.abortMultipartUpload(key, init.uploadId);
      const head = await storage.headObject(key);
      expect(head.exists).toBe(false);
    });

    it('should delete all objects under a directory prefix for local storage', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 'local',
        UPLOAD_DIR: tempDir,
      });
      const storage = new StorageService(config);

      await storage.putObject(
        'sources/graph-purge/sub/file1.txt',
        Buffer.from('data1'),
      );
      await storage.putObject(
        'sources/graph-purge/sub/file2.txt',
        Buffer.from('data2'),
      );

      const count = await storage.deletePrefix('sources/graph-purge');
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('should list and delete all objects under prefix in S3 mode', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        S3_BUCKET: 'viacarraria-sources',
        S3_FORCE_PATH_STYLE: 'true',
      });
      const storage = new StorageService(config);
      const originalFetch = globalThis.fetch;

      const deletedKeys: string[] = [];
      globalThis.fetch = (async (url: string, init?: any) => {
        if (init?.method === 'GET' && url.includes('list-type=2')) {
          const xml = `<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult>
            <Contents><Key>sources/graph-100/file1.pdf</Key></Contents>
            <Contents><Key>sources/graph-100/file2.pdf</Key></Contents>
          </ListBucketResult>`;
          return { ok: true, status: 200, text: async () => xml };
        }
        if (init?.method === 'DELETE') {
          deletedKeys.push(url);
          return { ok: true, status: 204 };
        }
        return { ok: true, status: 200, text: async () => '' };
      }) as any;

      try {
        const deletedCount = await storage.deletePrefix('sources/graph-100');
        expect(deletedCount).toBe(2);
        expect(deletedKeys).toHaveLength(2);
        expect(deletedKeys[0]).toContain('file1.pdf');
        expect(deletedKeys[1]).toContain('file2.pdf');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('creates, streams, and extracts POSIX ustar tar.gz files faithfully', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 'local',
        UPLOAD_DIR: tempDir,
      });
      const storage = new StorageService(config);

      const files = [
        {
          name: 'manifest.json',
          buffer: Buffer.from(
            JSON.stringify({ title: 'Test Archive', nodes: [1, 2] }),
          ),
        },
        {
          name: 'sources/doc1.txt',
          buffer: Buffer.from('Hello world from document 1!'.repeat(50)),
        },
        {
          name: 'sources/empty.txt',
          buffer: Buffer.alloc(0),
        },
      ];

      // 1. Synchronous createTarGz and extractTarGz round-trip
      const tarGz = storage.createTarGz(files);
      expect(tarGz.length).toBeGreaterThan(0);

      const extracted = storage.extractTarGz(tarGz);
      expect(extracted).toHaveLength(3);
      expect(extracted[0]?.name).toBe('manifest.json');
      expect(JSON.parse(extracted[0]!.buffer.toString('utf8')).title).toBe(
        'Test Archive',
      );
      expect(extracted[1]?.name).toBe('sources/doc1.txt');
      expect(extracted[1]?.buffer.toString('utf8')).toBe(
        files[1]!.buffer.toString('utf8'),
      );
      expect(extracted[2]?.name).toBe('sources/empty.txt');
      expect(extracted[2]?.buffer.length).toBe(0);

      // 2. Streaming createTarGzStream test
      const stream = storage.createTarGzStream(files);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const streamedTarGz = Buffer.concat(chunks);
      expect(streamedTarGz.length).toBeGreaterThan(0);

      const extractedStream = storage.extractTarGz(streamedTarGz);
      expect(extractedStream).toHaveLength(3);
      expect(extractedStream[0]?.name).toBe('manifest.json');
      expect(extractedStream[1]?.name).toBe('sources/doc1.txt');

      // 3. Brotli createTarBr and extractTarBr round-trip
      const tarBr = storage.createTarBr(files);
      expect(tarBr.length).toBeGreaterThan(0);
      const extractedBr = storage.extractTarBr(tarBr);
      expect(extractedBr).toHaveLength(3);
      expect(extractedBr[0]?.name).toBe('manifest.json');
      expect(extractedBr[1]?.name).toBe('sources/doc1.txt');
      expect(extractedBr[2]?.name).toBe('sources/empty.txt');

      // 4. Auto-detecting extractArchive with both Gzip and Brotli
      expect(storage.extractArchive(tarGz)).toHaveLength(3);
      expect(storage.extractArchive(tarBr)).toHaveLength(3);

      // 5. archiveGraphData with Brotli (default)
      const archiveResultBr = await storage.archiveGraphData(
        'graph-brotli',
        { title: 'Graph Brotli' },
        [{ filename: 'source1.pdf', buffer: Buffer.from('pdf data') }],
      );
      expect(archiveResultBr.key).toBe('archives/graphs/graph-brotli.tar.br');
      expect(archiveResultBr.format).toBe('brotli');
      expect(archiveResultBr.sizeBytes).toBeGreaterThan(0);

      const retrievedBr = await storage.getObject(archiveResultBr.key);
      const unpackedBr = storage.extractArchive(retrievedBr.buffer);
      expect(unpackedBr).toHaveLength(2);
      expect(unpackedBr[0]?.name).toBe('manifest.json');
      expect(unpackedBr[1]?.name).toBe('sources/source1.pdf');

      // 6. archiveGraphData with Gzip
      const archiveResultGz = await storage.archiveGraphData(
        'graph-gzip',
        { title: 'Graph Gzip' },
        [{ filename: 'source1.pdf', buffer: Buffer.from('pdf data') }],
        'gzip',
      );
      expect(archiveResultGz.key).toBe('archives/graphs/graph-gzip.tar.gz');
      expect(archiveResultGz.format).toBe('gzip');

      const retrievedGz = await storage.getObject(archiveResultGz.key);
      const unpackedGz = storage.extractTarGz(retrievedGz.buffer);
      expect(unpackedGz).toHaveLength(2);
    });
  });

  describe('MinIO storage proxy and upstream provider', () => {
    it('reports proxy status with AWS S3 upstream configuration', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 's3',
        STORAGE_PROXY_ENDPOINT: 'http://minio:9000',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        S3_BUCKET: 'viacarraria-sources',
        STORAGE_UPSTREAM_PROVIDER: 's3',
        UPSTREAM_S3_BUCKET: 'production-cloud-storage',
      });
      const storage = new StorageService(config);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200 }) as any;

      try {
        const status = await storage.getStorageProxyStatus();
        expect(status.isProxy).toBe(true);
        expect(status.proxyEndpoint).toBe('http://minio:9000');
        expect(status.upstreamProvider).toBe('s3');
        expect(status.upstreamBucket).toBe('production-cloud-storage');
        expect(status.connected).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('reports proxy status with GCP upstream provider', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 's3',
        STORAGE_PROXY_ENDPOINT: 'http://minio:9000',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        S3_BUCKET: 'viacarraria-sources',
        STORAGE_UPSTREAM_PROVIDER: 'gcs',
        UPSTREAM_GCS_BUCKET: 'production-gcs-bucket',
      });
      const storage = new StorageService(config);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200 }) as any;

      try {
        const status = await storage.getStorageProxyStatus();
        expect(status.isProxy).toBe(true);
        expect(status.upstreamProvider).toBe('gcs');
        expect(status.upstreamBucket).toBe('production-gcs-bucket');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('reports local driver status when S3 credentials are not configured', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 'local',
        UPLOAD_DIR: tempDir,
      });
      const storage = new StorageService(config);

      const status = await storage.getStorageProxyStatus();
      expect(status.driver).toBe('local');
      expect(status.isProxy).toBe(false);
      expect(status.upstreamProvider).toBe('none');
      expect(status.connected).toBe(true);
    });
  });

  describe('getPresignedUploadUrl', () => {
    it('generates a single presigned upload URL when isMultipart is false', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        S3_BUCKET: 'viacarraria-sources',
        S3_FORCE_PATH_STYLE: 'true',
      });
      const storage = new StorageService(config);

      const result = await storage.getPresignedUploadUrl({
        key: 'sources/single.pdf',
        contentType: 'application/pdf',
        fileSize: 10 * 1024 * 1024,
        isMultipart: false,
      });

      expect(result.isMultipart).toBe(false);
      expect(result.key).toBe('sources/single.pdf');
      expect(result.uploadUrl).toBeDefined();
      expect(result.uploadUrl).toContain('X-Amz-Signature=');
      expect(result.storageDriver).toBe('s3');
    });

    it('generates presigned part URLs dynamically based on fileSize and chunkSize for multipart uploads', async () => {
      const config = new ConfigService({
        STORAGE_DRIVER: 'local',
        UPLOAD_DIR: tempDir,
      });
      const storage = new StorageService(config);

      // 120MB file with 20MB chunk size = 6 parts
      const result = await storage.getPresignedUploadUrl({
        key: 'sources/large-120mb.bin',
        contentType: 'application/octet-stream',
        fileSize: 120 * 1024 * 1024,
        chunkSize: 20 * 1024 * 1024,
        isMultipart: true,
      });

      expect(result.isMultipart).toBe(true);
      expect(result.uploadId).toBeDefined();
      expect(result.parts).toHaveLength(6);
      expect(result.parts?.[0]?.partNumber).toBe(1);
      expect(result.parts?.[5]?.partNumber).toBe(6);
      expect(result.parts?.[0]?.uploadUrl).toContain('uploadId=');
    });
  });
});

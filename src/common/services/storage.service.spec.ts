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
  });
});

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { Readable } from 'stream';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  createGzip,
  gunzipSync,
  gzipSync,
} from 'zlib';

export type StorageDriver = 's3' | 'local';

export type StorageUpstreamProvider = 'none' | 's3' | 'gcs';

export type StorageProxyStatus = {
  driver: StorageDriver;
  proxyEndpoint: string;
  bucket: string;
  isProxy: boolean;
  upstreamProvider: StorageUpstreamProvider;
  upstreamBucket?: string;
  connected: boolean;
};

export type PutObjectResult = {
  key: string;
  location: string;
  storageDriver: StorageDriver;
};

export type GetObjectResult = {
  buffer: Buffer;
  contentType: string;
  contentLength: number;
  status: number;
  contentRange?: string;
  acceptRanges?: string;
};

export type PresignedPutResult = {
  uploadUrl: string;
  key: string;
  storageDriver: StorageDriver;
  headers: Record<string, string>;
  expiresInSeconds: number;
};

export type PresignedPartUploadResult = {
  uploadUrl: string;
  partNumber: number;
  headers: Record<string, string>;
  expiresInSeconds: number;
};

export type PresignedUploadOptions = {
  key: string;
  contentType?: string;
  fileSize?: number;
  isMultipart?: boolean;
  partCount?: number;
  chunkSize?: number;
  expiresInSeconds?: number;
  checksumSha256?: string;
};

export type PresignedUploadResult = {
  key: string;
  storageDriver: StorageDriver;
  isMultipart: boolean;
  uploadUrl?: string;
  headers?: Record<string, string>;
  uploadId?: string;
  parts?: PresignedPartUploadResult[];
  expiresInSeconds: number;
};

export type HeadObjectResult = {
  exists: boolean;
  contentLength: number;
  contentType: string;
  eTag?: string;
};

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: StorageDriver;
  private readonly uploadDirectory: string;

  // S3 Configuration
  private readonly s3Endpoint: string;
  private readonly s3Region: string;
  private readonly s3AccessKey: string;
  private readonly s3SecretKey: string;
  private readonly s3Bucket: string;
  private readonly s3ForcePathStyle: boolean;
  private readonly s3PublicUrl: string;
  private readonly s3AbortIncompleteDays: number;
  private readonly s3TransitionIaDays: number;
  private readonly s3TransitionGlacierDays: number;
  private readonly upstreamProvider: StorageUpstreamProvider;
  private readonly upstreamBucket: string;

  private bucketInitialized = false;

  constructor(config: ConfigService) {
    const rawDriver = config.get<string>('STORAGE_DRIVER', 's3').toLowerCase();
    this.s3Endpoint = (
      config.get<string>('STORAGE_PROXY_ENDPOINT') ??
      config.get<string>('S3_ENDPOINT') ??
      config.get<string>('MINIO_ENDPOINT') ??
      ''
    ).replace(/\/$/, '');
    this.s3Region = config.get<string>('S3_REGION', 'us-east-1');
    this.s3AccessKey = config.get<string>('S3_ACCESS_KEY') ?? '';
    this.s3SecretKey = config.get<string>('S3_SECRET_KEY') ?? '';
    this.s3Bucket = config.get<string>('S3_BUCKET', 'viacarraria-sources');
    this.s3ForcePathStyle =
      config.get<string>('S3_FORCE_PATH_STYLE', 'true') === 'true';
    this.s3PublicUrl = (
      config.get<string>('S3_PUBLIC_URL') || this.s3Endpoint
    ).replace(/\/$/, '');
    this.s3AbortIncompleteDays =
      Number(config.get<string>('S3_ABORT_INCOMPLETE_DAYS', '1')) || 1;
    this.s3TransitionIaDays =
      Number(config.get<string>('S3_TRANSITION_IA_DAYS', '0')) || 0;
    this.s3TransitionGlacierDays =
      Number(config.get<string>('S3_TRANSITION_GLACIER_DAYS', '0')) || 0;

    const rawUpstream = (
      config.get<string>('STORAGE_UPSTREAM_PROVIDER') ?? 'none'
    ).toLowerCase();
    this.upstreamProvider =
      rawUpstream === 's3' || rawUpstream === 'aws'
        ? 's3'
        : rawUpstream === 'gcs' || rawUpstream === 'google'
          ? 'gcs'
          : 'none';
    this.upstreamBucket =
      config.get<string>('UPSTREAM_S3_BUCKET') ??
      config.get<string>('UPSTREAM_GCS_BUCKET') ??
      '';

    this.uploadDirectory =
      config.get<string>('UPLOAD_DIR') ?? join(process.cwd(), 'uploads');

    // If S3 endpoint or credentials are missing and driver is s3, fallback gracefully to local
    if (
      rawDriver === 's3' &&
      (!this.s3Endpoint || !this.s3AccessKey || !this.s3SecretKey)
    ) {
      this.driver = 'local';
      this.logger.warn(
        'STORAGE_DRIVER set to s3 but S3_ENDPOINT, S3_ACCESS_KEY, or S3_SECRET_KEY is missing; falling back to local driver.',
      );
    } else {
      this.driver = rawDriver === 'local' ? 'local' : 's3';
    }

    const upstreamDetail =
      this.upstreamProvider !== 'none'
        ? ` -> Upstream ${this.upstreamProvider.toUpperCase()} (${this.upstreamBucket || 'default'})`
        : '';
    this.logger.log(
      `Storage initialized with driver: ${this.driver} (MinIO Proxy: ${this.s3Endpoint || 'disabled'}, bucket: ${this.s3Bucket}${upstreamDetail}, upload dir: ${this.uploadDirectory})`,
    );
  }

  getDriver(): StorageDriver {
    return this.driver;
  }

  getBucketName(): string {
    return this.s3Bucket;
  }

  getUploadDirectory(): string {
    return this.uploadDirectory;
  }

  async getStorageProxyStatus(): Promise<StorageProxyStatus> {
    let connected = false;
    if (this.driver === 's3') {
      try {
        await this.ensureBucket();
        connected = this.bucketInitialized;
      } catch {
        connected = false;
      }
    } else {
      connected = existsSync(this.uploadDirectory);
    }

    return {
      driver: this.driver,
      proxyEndpoint: this.s3Endpoint,
      bucket: this.s3Bucket,
      isProxy: this.driver === 's3',
      upstreamProvider: this.upstreamProvider,
      upstreamBucket: this.upstreamBucket || undefined,
      connected,
    };
  }

  async putObject(
    key: string,
    buffer: Buffer,
    contentType = 'application/octet-stream',
    storageClass?: string,
  ): Promise<PutObjectResult> {
    const sanitizedKey = this.sanitizeKey(key);

    if (this.driver === 's3') {
      try {
        await this.ensureBucket();
        const url = this.buildObjectUrl(this.s3Endpoint, sanitizedKey);
        const customHeaders: Record<string, string> = {};
        if (storageClass) {
          customHeaders['x-amz-storage-class'] = storageClass;
        }

        const headers = this.signRequest({
          method: 'PUT',
          url,
          body: buffer,
          contentType,
          customHeaders,
        });

        const response = await fetch(url, {
          method: 'PUT',
          headers,
          body: new Uint8Array(buffer),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          throw new Error(
            `S3 PUT failed with status ${response.status}: ${errorBody}`,
          );
        }

        const location = `s3://${this.s3Bucket}/${sanitizedKey}`;
        return { key: sanitizedKey, location, storageDriver: 's3' };
      } catch (error) {
        this.logger.warn(
          `Failed to put object to S3, falling back to local file storage: ${String(error)}`,
        );
        return this.putLocalObject(sanitizedKey, buffer);
      }
    }

    return this.putLocalObject(sanitizedKey, buffer);
  }

  createTarHeader(name: string, sizeBytes: number): Buffer {
    const header = Buffer.alloc(512, 0);
    header.write(name.slice(0, 100), 0, 'utf8');
    header.write('0000644\0', 100, 'utf8');
    header.write('0000000\0', 108, 'utf8');
    header.write('0000000\0', 116, 'utf8');
    header.write(sizeBytes.toString(8).padStart(11, '0') + ' ', 124, 'utf8');
    header.write(
      Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, '0') + ' ',
      136,
      'utf8',
    );
    header.write('        ', 148, 'utf8');
    header.write('0', 156, 'utf8');
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');

    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i]!;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
    return header;
  }

  createTar(files: Array<{ name: string; buffer: Buffer }>): Buffer {
    const buffers: Buffer[] = [];
    for (const file of files) {
      buffers.push(this.createTarHeader(file.name, file.buffer.length));
      buffers.push(file.buffer);
      const padding = (512 - (file.buffer.length % 512)) % 512;
      if (padding > 0) buffers.push(Buffer.alloc(padding, 0));
    }
    buffers.push(Buffer.alloc(1024, 0));
    return Buffer.concat(buffers);
  }

  createTarGz(files: Array<{ name: string; buffer: Buffer }>): Buffer {
    const tarBuf = this.createTar(files);
    return gzipSync(tarBuf, { level: 9 });
  }

  createTarBr(files: Array<{ name: string; buffer: Buffer }>): Buffer {
    const tarBuf = this.createTar(files);
    return brotliCompressSync(tarBuf, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    });
  }

  createTarGzStream(files: Array<{ name: string; buffer: Buffer }>): Readable {
    const gzip = createGzip({ level: 9 });
    const readable = Readable.from(this.generateTarBlocks(files));
    return readable.pipe(gzip);
  }

  private async *generateTarBlocks(
    files: Array<{ name: string; buffer: Buffer }>,
  ): AsyncGenerator<Buffer> {
    for (const file of files) {
      yield this.createTarHeader(file.name, file.buffer.length);
      yield file.buffer;
      const padding = (512 - (file.buffer.length % 512)) % 512;
      if (padding > 0) {
        yield Buffer.alloc(padding, 0);
      }
    }
    yield Buffer.alloc(1024, 0);
  }

  extractTar(tarBuf: Buffer): Array<{ name: string; buffer: Buffer }> {
    const files: Array<{ name: string; buffer: Buffer }> = [];
    let offset = 0;

    while (offset + 512 <= tarBuf.length) {
      const header = tarBuf.subarray(offset, offset + 512);
      let isZero = true;
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) {
          isZero = false;
          break;
        }
      }
      if (isZero) {
        break;
      }

      let nameEnd = 0;
      while (nameEnd < 100 && header[nameEnd] !== 0) {
        nameEnd++;
      }
      const name = header.subarray(0, nameEnd).toString('utf8');

      let sizeEnd = 124;
      while (sizeEnd < 136 && header[sizeEnd] !== 0 && header[sizeEnd] !== 32) {
        sizeEnd++;
      }
      const sizeStr = header.subarray(124, sizeEnd).toString('utf8').trim();
      const size = sizeStr ? Number.parseInt(sizeStr, 8) : 0;

      const contentStart = offset + 512;
      const contentEnd = contentStart + size;
      if (contentEnd > tarBuf.length) {
        break;
      }
      const fileBuffer = Buffer.from(tarBuf.subarray(contentStart, contentEnd));

      if (name) {
        files.push({ name, buffer: fileBuffer });
      }

      const padding = (512 - (size % 512)) % 512;
      offset = contentEnd + padding;
    }

    return files;
  }

  extractTarGz(tarGzBuffer: Buffer): Array<{ name: string; buffer: Buffer }> {
    try {
      const tarBuf = gunzipSync(tarGzBuffer);
      return this.extractTar(tarBuf);
    } catch (gzipErr) {
      try {
        const tarBuf = brotliDecompressSync(tarGzBuffer);
        return this.extractTar(tarBuf);
      } catch {
        throw gzipErr;
      }
    }
  }

  extractTarBr(tarBrBuffer: Buffer): Array<{ name: string; buffer: Buffer }> {
    const tarBuf = brotliDecompressSync(tarBrBuffer);
    return this.extractTar(tarBuf);
  }

  extractArchive(
    archiveBuffer: Buffer,
  ): Array<{ name: string; buffer: Buffer }> {
    if (archiveBuffer[0] === 0x1f && archiveBuffer[1] === 0x8b) {
      return this.extractTarGz(archiveBuffer);
    }
    return this.extractTarBr(archiveBuffer);
  }

  async archiveGraphData(
    graphId: string,
    manifest: Record<string, unknown>,
    sources: Array<{ filename: string; buffer: Buffer }>,
    format: 'gzip' | 'brotli' = 'brotli',
  ): Promise<{
    key: string;
    location: string;
    sizeBytes: number;
    format: 'gzip' | 'brotli';
  }> {
    const filesToArchive: Array<{ name: string; buffer: Buffer }> = [
      {
        name: 'manifest.json',
        buffer: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      },
      ...sources.map((s) => ({
        name: `sources/${s.filename}`,
        buffer: s.buffer,
      })),
    ];

    const isBrotli = format === 'brotli';
    const compressedBuffer = isBrotli
      ? this.createTarBr(filesToArchive)
      : this.createTarGz(filesToArchive);
    const ext = isBrotli ? 'tar.br' : 'tar.gz';
    const contentType = isBrotli ? 'application/x-brotli' : 'application/gzip';
    const archiveKey = `archives/graphs/${graphId}.${ext}`;
    const putResult = await this.putObject(
      archiveKey,
      compressedBuffer,
      contentType,
      'GLACIER',
    );

    return {
      key: archiveKey,
      location: putResult.location,
      sizeBytes: compressedBuffer.length,
      format,
    };
  }

  async getObject(key: string, rangeHeader?: string): Promise<GetObjectResult> {
    const sanitizedKey = this.sanitizeKey(key);

    if (this.driver === 's3') {
      try {
        const url = this.buildObjectUrl(this.s3Endpoint, sanitizedKey);
        const customHeaders: Record<string, string> = {};
        if (rangeHeader) {
          customHeaders.Range = rangeHeader;
        }

        const headers = this.signRequest({
          method: 'GET',
          url,
          customHeaders,
        });

        const response = await fetch(url, {
          method: 'GET',
          headers,
        });

        if (response.status === 404) {
          // If not in S3, check local storage before failing
          if (existsSync(join(this.uploadDirectory, basename(sanitizedKey)))) {
            return this.getLocalObject(sanitizedKey, rangeHeader);
          }
          throw new Error(`Object not found in storage: ${sanitizedKey}`);
        }

        if (!response.ok && response.status !== 206) {
          throw new Error(`S3 GET failed with status ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return {
          buffer,
          contentType:
            response.headers.get('content-type') || 'application/octet-stream',
          contentLength: buffer.length,
          status: response.status,
          contentRange: response.headers.get('content-range') ?? undefined,
          acceptRanges: response.headers.get('accept-ranges') ?? 'bytes',
        };
      } catch (error) {
        this.logger.warn(
          `S3 getObject failed, trying local fallback: ${String(error)}`,
        );
        return this.getLocalObject(sanitizedKey, rangeHeader);
      }
    }

    return this.getLocalObject(sanitizedKey, rangeHeader);
  }

  async deleteObject(key: string): Promise<void> {
    const sanitizedKey = this.sanitizeKey(key);

    if (this.driver === 's3') {
      try {
        const url = this.buildObjectUrl(this.s3Endpoint, sanitizedKey);
        const headers = this.signRequest({
          method: 'DELETE',
          url,
        });
        await fetch(url, { method: 'DELETE', headers }).catch(() => undefined);
      } catch (error) {
        this.logger.warn(`S3 DELETE failed: ${String(error)}`);
      }
    }

    // Also clean up local file if present
    const localPath = join(this.uploadDirectory, basename(sanitizedKey));
    await rm(localPath, { force: true }).catch(() => undefined);
  }

  async deletePrefix(prefix: string): Promise<number> {
    const sanitizedPrefix = this.sanitizeKey(prefix).replace(/^\/+/, '');
    let deletedCount = 0;

    if (this.driver === 's3') {
      try {
        const bucketUrl = this.buildBucketUrl(this.s3Endpoint);
        const listUrl = `${bucketUrl}?list-type=2&prefix=${encodeURIComponent(sanitizedPrefix)}`;
        const headers = this.signRequest({
          method: 'GET',
          url: listUrl,
        });
        const res = await fetch(listUrl, { method: 'GET', headers });
        if (res.ok) {
          const text = await res.text();
          const keyMatches = Array.from(
            text.matchAll(/<Key>([^<]+)<\/Key>/g),
          ).map((m) => m[1]!);
          for (const key of keyMatches) {
            await this.deleteObject(key);
            deletedCount++;
          }
        }
      } catch (err) {
        this.logger.warn(
          `S3 deletePrefix failed for ${sanitizedPrefix}: ${String(err)}`,
        );
      }
    }

    // Local directory cleanup
    const localDir = join(this.uploadDirectory, sanitizedPrefix);
    try {
      if (existsSync(localDir)) {
        await rm(localDir, { recursive: true, force: true });
        deletedCount++;
      }
      if (existsSync(this.uploadDirectory)) {
        const basePrefix = basename(sanitizedPrefix);
        const entries = await readdir(this.uploadDirectory);
        for (const entry of entries) {
          if (
            entry.startsWith(basePrefix) ||
            entry.startsWith(sanitizedPrefix.replace(/\//g, '_'))
          ) {
            await rm(join(this.uploadDirectory, entry), {
              recursive: true,
              force: true,
            }).catch(() => undefined);
            deletedCount++;
          }
        }
      }
    } catch {
      // Ignore
    }

    return deletedCount;
  }

  async copyObject(
    sourceKey: string,
    destinationKey: string,
  ): Promise<PutObjectResult> {
    const { buffer, contentType } = await this.getObject(sourceKey);
    return this.putObject(destinationKey, buffer, contentType);
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const sanitizedKey = this.sanitizeKey(key);

    if (this.driver === 's3') {
      const baseUrl = this.s3PublicUrl || this.s3Endpoint;
      const parsedUrl = new URL(this.buildObjectUrl(baseUrl, sanitizedKey));

      const now = new Date();
      const amzDate = this.toAmzDate(now);
      const dateStamp = amzDate.substring(0, 8);

      const credentialScope = `${dateStamp}/${this.s3Region}/s3/aws4_request`;
      const queryParams: Record<string, string> = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${this.s3AccessKey}/${credentialScope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': expiresInSeconds.toString(),
        'X-Amz-SignedHeaders': 'host',
      };

      const sortedQueryKeys = Object.keys(queryParams).sort();
      const canonicalQueryString = sortedQueryKeys
        .map(
          (k) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k] ?? '')}`,
        )
        .join('&');

      const canonicalHeaders = `host:${parsedUrl.host}\n`;
      const signedHeaders = 'host';
      const canonicalRequest = [
        'GET',
        parsedUrl.pathname,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        'UNSIGNED-PAYLOAD',
      ].join('\n');

      const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        this.sha256(canonicalRequest),
      ].join('\n');

      const signingKey = this.getSignatureKey(
        this.s3SecretKey,
        dateStamp,
        this.s3Region,
        's3',
      );
      const signature = this.hmacHex(signingKey, stringToSign);

      return Promise.resolve(
        `${parsedUrl.origin}${parsedUrl.pathname}?${canonicalQueryString}&X-Amz-Signature=${signature}`,
      );
    }

    // Local fallback: return relative API download link
    return Promise.resolve(`/api/sources/file/${sanitizedKey}`);
  }

  async getPresignedGetUrl(
    key: string,
    expiresInSeconds = 3600,
  ): Promise<string> {
    return this.getSignedUrl(key, expiresInSeconds);
  }

  async getPresignedPutUrl(
    key: string,
    contentType = 'application/octet-stream',
    expiresInSeconds = 900,
    checksumSha256?: string,
  ): Promise<PresignedPutResult> {
    const sanitizedKey = this.sanitizeKey(key);

    if (this.driver === 's3') {
      await this.ensureBucket();
      const baseUrl = this.s3PublicUrl || this.s3Endpoint;
      const parsedUrl = new URL(this.buildObjectUrl(baseUrl, sanitizedKey));

      const now = new Date();
      const amzDate = this.toAmzDate(now);
      const dateStamp = amzDate.substring(0, 8);

      const credentialScope = `${dateStamp}/${this.s3Region}/s3/aws4_request`;
      const queryParams: Record<string, string> = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${this.s3AccessKey}/${credentialScope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': expiresInSeconds.toString(),
        'X-Amz-SignedHeaders': 'host',
      };

      const sortedQueryKeys = Object.keys(queryParams).sort();
      const canonicalQueryString = sortedQueryKeys
        .map(
          (k) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k] ?? '')}`,
        )
        .join('&');

      const canonicalHeaders = `host:${parsedUrl.host}\n`;
      const signedHeaders = 'host';
      const canonicalRequest = [
        'PUT',
        parsedUrl.pathname,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        'UNSIGNED-PAYLOAD',
      ].join('\n');

      const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        this.sha256(canonicalRequest),
      ].join('\n');

      const signingKey = this.getSignatureKey(
        this.s3SecretKey,
        dateStamp,
        this.s3Region,
        's3',
      );
      const signature = this.hmacHex(signingKey, stringToSign);

      const uploadUrl = `${parsedUrl.origin}${parsedUrl.pathname}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
      const headers: Record<string, string> = {
        'Content-Type': contentType,
      };
      if (checksumSha256) {
        headers['x-amz-checksum-sha256'] = checksumSha256;
      }

      return {
        uploadUrl,
        key: sanitizedKey,
        storageDriver: 's3',
        headers,
        expiresInSeconds,
      };
    }

    return {
      uploadUrl: `/api/sources/direct-upload/${sanitizedKey}`,
      key: sanitizedKey,
      storageDriver: 'local',
      headers: { 'Content-Type': contentType },
      expiresInSeconds,
    };
  }

  async getPresignedUploadUrl(
    options: PresignedUploadOptions,
  ): Promise<PresignedUploadResult> {
    const {
      key,
      contentType = 'application/octet-stream',
      fileSize,
      isMultipart = false,
      partCount,
      chunkSize = 5 * 1024 * 1024,
      expiresInSeconds = 900,
      checksumSha256,
    } = options;

    if (isMultipart) {
      const calculatedPartCount =
        partCount ??
        (fileSize ? Math.max(1, Math.ceil(fileSize / chunkSize)) : 1);
      const init = await this.initiateMultipartUpload(key, contentType);
      const parts = await Promise.all(
        Array.from({ length: calculatedPartCount }, (_, i) =>
          this.getPresignedPartUploadUrl(
            key,
            init.uploadId,
            i + 1,
            expiresInSeconds,
          ),
        ),
      );

      return {
        key: init.key,
        storageDriver: this.driver,
        isMultipart: true,
        uploadId: init.uploadId,
        parts,
        expiresInSeconds,
      };
    }

    const single = await this.getPresignedPutUrl(
      key,
      contentType,
      expiresInSeconds,
      checksumSha256,
    );

    return {
      key: single.key,
      storageDriver: single.storageDriver,
      isMultipart: false,
      uploadUrl: single.uploadUrl,
      headers: single.headers,
      expiresInSeconds,
    };
  }

  async initiateMultipartUpload(
    key: string,
    contentType = 'application/octet-stream',
  ): Promise<{ uploadId: string; key: string }> {
    const sanitizedKey = this.sanitizeKey(key);

    if (this.driver === 's3') {
      await this.ensureBucket();
      const objectUrl = this.buildObjectUrl(this.s3Endpoint, sanitizedKey);
      const urlWithQuery = `${objectUrl}?uploads`;

      const headers = this.signRequest({
        method: 'POST',
        url: urlWithQuery,
        contentType,
      });

      const response = await fetch(urlWithQuery, {
        method: 'POST',
        headers,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Failed to initiate S3 multipart upload (status ${response.status}): ${text}`,
        );
      }

      const xml = await response.text();
      const match = /<UploadId>([\s\S]*?)<\/UploadId>/.exec(xml);
      if (!match || !match[1]) {
        throw new Error(
          `S3 multipart initiate did not return UploadId: ${xml}`,
        );
      }

      return {
        uploadId: match[1].trim(),
        key: sanitizedKey,
      };
    }

    // Local fallback: create multipart scratch dir
    const uploadId = randomUUID();
    const partDir = join(this.uploadDirectory, '.multipart', uploadId);
    await mkdir(partDir, { recursive: true });
    return { uploadId, key: sanitizedKey };
  }

  async getPresignedPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds = 900,
  ): Promise<PresignedPartUploadResult> {
    const sanitizedKey = this.sanitizeKey(key);

    if (this.driver === 's3') {
      const baseUrl = this.s3PublicUrl || this.s3Endpoint;
      const parsedUrl = new URL(this.buildObjectUrl(baseUrl, sanitizedKey));

      const now = new Date();
      const amzDate = this.toAmzDate(now);
      const dateStamp = amzDate.substring(0, 8);

      const credentialScope = `${dateStamp}/${this.s3Region}/s3/aws4_request`;
      const queryParams: Record<string, string> = {
        partNumber: partNumber.toString(),
        uploadId: uploadId,
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${this.s3AccessKey}/${credentialScope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': expiresInSeconds.toString(),
        'X-Amz-SignedHeaders': 'host',
      };

      const sortedQueryKeys = Object.keys(queryParams).sort();
      const canonicalQueryString = sortedQueryKeys
        .map(
          (k) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k] ?? '')}`,
        )
        .join('&');

      const canonicalHeaders = `host:${parsedUrl.host}\n`;
      const signedHeaders = 'host';
      const canonicalRequest = [
        'PUT',
        parsedUrl.pathname,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        'UNSIGNED-PAYLOAD',
      ].join('\n');

      const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        this.sha256(canonicalRequest),
      ].join('\n');

      const signingKey = this.getSignatureKey(
        this.s3SecretKey,
        dateStamp,
        this.s3Region,
        's3',
      );
      const signature = this.hmacHex(signingKey, stringToSign);

      return {
        uploadUrl: `${parsedUrl.origin}${parsedUrl.pathname}?${canonicalQueryString}&X-Amz-Signature=${signature}`,
        partNumber,
        headers: {},
        expiresInSeconds,
      };
    }

    return {
      uploadUrl: `/api/sources/direct-upload/${sanitizedKey}?uploadId=${uploadId}&partNumber=${partNumber}`,
      partNumber,
      headers: {},
      expiresInSeconds,
    };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; eTag: string }>,
  ): Promise<PutObjectResult> {
    const sanitizedKey = this.sanitizeKey(key);

    if (this.driver === 's3') {
      const sortedParts = [...parts].sort(
        (a, b) => a.partNumber - b.partNumber,
      );
      const xmlBody = [
        '<CompleteMultipartUpload>',
        ...sortedParts.map(
          (p) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.eTag.replace(/"/g, '&quot;')}</ETag></Part>`,
        ),
        '</CompleteMultipartUpload>',
      ].join('');

      const objectUrl = this.buildObjectUrl(this.s3Endpoint, sanitizedKey);
      const urlWithQuery = `${objectUrl}?uploadId=${encodeURIComponent(uploadId)}`;
      const bodyBuffer = Buffer.from(xmlBody, 'utf8');

      const headers = this.signRequest({
        method: 'POST',
        url: urlWithQuery,
        body: bodyBuffer,
        contentType: 'application/xml',
      });

      const response = await fetch(urlWithQuery, {
        method: 'POST',
        headers,
        body: new Uint8Array(bodyBuffer),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Failed to complete S3 multipart upload (status ${response.status}): ${text}`,
        );
      }

      return {
        key: sanitizedKey,
        location: `s3://${this.s3Bucket}/${sanitizedKey}`,
        storageDriver: 's3',
      };
    }

    // Local fallback: concatenate chunks
    const partDir = join(this.uploadDirectory, '.multipart', uploadId);
    const destinationPath = join(this.uploadDirectory, basename(sanitizedKey));
    await mkdir(this.uploadDirectory, { recursive: true });

    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const partBuffers: Buffer[] = [];
    for (const part of sortedParts) {
      const partPath = join(partDir, `part-${part.partNumber}`);
      if (existsSync(partPath)) {
        partBuffers.push(await readFile(partPath));
      }
    }
    await writeFile(destinationPath, Buffer.concat(partBuffers));
    await rm(partDir, { recursive: true, force: true }).catch(() => {});

    return {
      key: sanitizedKey,
      location: destinationPath,
      storageDriver: 'local',
    };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const sanitizedKey = this.sanitizeKey(key);

    if (this.driver === 's3') {
      const objectUrl = this.buildObjectUrl(this.s3Endpoint, sanitizedKey);
      const urlWithQuery = `${objectUrl}?uploadId=${encodeURIComponent(uploadId)}`;

      const headers = this.signRequest({
        method: 'DELETE',
        url: urlWithQuery,
      });

      await fetch(urlWithQuery, { method: 'DELETE', headers }).catch(() => {});
    }

    const partDir = join(this.uploadDirectory, '.multipart', uploadId);
    await rm(partDir, { recursive: true, force: true }).catch(() => {});
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const sanitizedKey = this.sanitizeKey(key);

    if (this.driver === 's3') {
      try {
        const url = this.buildObjectUrl(this.s3Endpoint, sanitizedKey);
        const headers = this.signRequest({
          method: 'HEAD',
          url,
        });

        const response = await fetch(url, { method: 'HEAD', headers });
        if (response.ok || response.status === 200) {
          return {
            exists: true,
            contentLength: Number.parseInt(
              response.headers.get('content-length') ?? '0',
              10,
            ),
            contentType:
              response.headers.get('content-type') ??
              'application/octet-stream',
            eTag: (response.headers.get('etag') ?? '').replace(/"/g, ''),
          };
        }
      } catch (err) {
        this.logger.warn(`S3 HEAD failed: ${err}`);
      }
    }

    // Local check
    const localPath = join(this.uploadDirectory, basename(sanitizedKey));
    if (existsSync(localPath)) {
      const s = await stat(localPath);
      return {
        exists: true,
        contentLength: s.size,
        contentType: this.guessContentType(sanitizedKey),
      };
    }

    return {
      exists: false,
      contentLength: 0,
      contentType: '',
    };
  }

  async saveLocalPart(
    uploadId: string,
    partNumber: number,
    buffer: Buffer,
  ): Promise<{ partNumber: number; eTag: string }> {
    const partDir = join(this.uploadDirectory, '.multipart', uploadId);
    await mkdir(partDir, { recursive: true });
    const partPath = join(partDir, `part-${partNumber}`);
    await writeFile(partPath, buffer);
    const eTag = createHash('md5').update(buffer).digest('hex');
    return { partNumber, eTag };
  }

  async ensureBucket(): Promise<void> {
    if (this.bucketInitialized || this.driver !== 's3') return;

    try {
      const bucketUrl = this.s3ForcePathStyle
        ? `${this.s3Endpoint}/${this.s3Bucket}`
        : `${this.s3Endpoint}`;

      // Check if bucket exists with HEAD request
      const headHeaders = this.signRequest({
        method: 'HEAD',
        url: bucketUrl,
      });

      const headRes = await fetch(bucketUrl, {
        method: 'HEAD',
        headers: headHeaders,
      });

      if (headRes.ok || headRes.status === 200) {
        this.bucketInitialized = true;
        await this.ensureBucketLifecycle();
        return;
      }

      // If bucket doesn't exist, create it via PUT
      const putHeaders = this.signRequest({
        method: 'PUT',
        url: bucketUrl,
      });

      const putRes = await fetch(bucketUrl, {
        method: 'PUT',
        headers: putHeaders,
      });

      if (putRes.ok || putRes.status === 200 || putRes.status === 409) {
        this.bucketInitialized = true;
        await this.ensureBucketLifecycle();
      } else {
        this.logger.warn(
          `Could not auto-create S3 bucket "${this.s3Bucket}" (status: ${putRes.status}). Ensure it is created in MinIO.`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not connect to S3 to verify bucket: ${String(error)}`,
      );
    }
  }

  async ensureBucketLifecycle(
    options: {
      abortIncompleteMultipartDays?: number;
      transitionIaDays?: number;
      transitionGlacierDays?: number;
    } = {},
  ): Promise<void> {
    if (this.driver !== 's3') return;

    const abortDays =
      options.abortIncompleteMultipartDays ?? this.s3AbortIncompleteDays;
    const iaDays = options.transitionIaDays ?? this.s3TransitionIaDays;
    const glacierDays =
      options.transitionGlacierDays ?? this.s3TransitionGlacierDays;

    try {
      const bucketUrl = this.s3ForcePathStyle
        ? `${this.s3Endpoint}/${this.s3Bucket}`
        : `${this.s3Endpoint}`;
      const lifecycleUrl = `${bucketUrl}?lifecycle`;

      const rules: string[] = [
        '  <Rule>',
        '    <ID>AbortIncompleteMultipartUploads</ID>',
        '    <Status>Enabled</Status>',
        '    <Prefix></Prefix>',
        '    <AbortIncompleteMultipartUpload>',
        `      <DaysAfterInitiation>${abortDays}</DaysAfterInitiation>`,
        '    </AbortIncompleteMultipartUpload>',
        '  </Rule>',
      ];

      if (iaDays > 0) {
        rules.push(
          '  <Rule>',
          '    <ID>TransitionSourcesToInfrequentAccess</ID>',
          '    <Status>Enabled</Status>',
          '    <Prefix>sources/</Prefix>',
          '    <Transition>',
          `      <Days>${iaDays}</Days>`,
          '      <StorageClass>STANDARD_IA</StorageClass>',
          '    </Transition>',
          '  </Rule>',
        );
      }

      if (glacierDays > 0) {
        rules.push(
          '  <Rule>',
          '    <ID>TransitionSourcesToGlacierArchive</ID>',
          '    <Status>Enabled</Status>',
          '    <Prefix>sources/</Prefix>',
          '    <Transition>',
          `      <Days>${glacierDays}</Days>`,
          '      <StorageClass>GLACIER</StorageClass>',
          '    </Transition>',
          '  </Rule>',
        );
      }

      const lifecycleXml = [
        '<LifecycleConfiguration>',
        ...rules,
        '</LifecycleConfiguration>',
      ].join('\n');

      const body = Buffer.from(lifecycleXml, 'utf-8');
      const headers = this.signRequest({
        method: 'PUT',
        url: lifecycleUrl,
        body,
        contentType: 'application/xml',
      });

      const res = await fetch(lifecycleUrl, {
        method: 'PUT',
        headers,
        body: new Uint8Array(body),
      });

      if (res.ok || res.status === 200 || res.status === 204) {
        this.logger.log(
          `S3 lifecycle rule configured: Abort incomplete (${abortDays}d), IA (${iaDays || 'disabled'}d), Glacier (${glacierDays || 'disabled'}d).`,
        );
      } else {
        const errorText = await res.text().catch(() => '');
        this.logger.warn(
          `Could not configure S3 lifecycle policy (status: ${res.status}): ${errorText}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to set S3 bucket lifecycle policy: ${String(error)}`,
      );
    }
  }

  async putObjectTagging(
    key: string,
    tags: Record<string, string>,
  ): Promise<void> {
    if (this.driver !== 's3') return;

    try {
      const sanitizedKey = this.sanitizeKey(key);
      const objectUrl = this.buildObjectUrl(this.s3Endpoint, sanitizedKey);
      const taggingUrl = `${objectUrl}?tagging`;

      const tagEntries = Object.entries(tags).map(
        ([k, v]) => `    <Tag><Key>${k}</Key><Value>${v}</Value></Tag>`,
      );

      const taggingXml = [
        '<Tagging>',
        '  <TagSet>',
        ...tagEntries,
        '  </TagSet>',
        '</Tagging>',
      ].join('\n');

      const body = Buffer.from(taggingXml, 'utf-8');
      const headers = this.signRequest({
        method: 'PUT',
        url: taggingUrl,
        body,
        contentType: 'application/xml',
      });

      const res = await fetch(taggingUrl, {
        method: 'PUT',
        headers,
        body: new Uint8Array(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.warn(
          `Failed to set S3 object tags on ${sanitizedKey} (status ${res.status}): ${text}`,
        );
      }
    } catch (error) {
      this.logger.warn(`Error tagging S3 object ${key}: ${String(error)}`);
    }
  }

  private async putLocalObject(
    key: string,
    buffer: Buffer,
  ): Promise<PutObjectResult> {
    const sanitizedKey = this.sanitizeKey(key);
    await mkdir(this.uploadDirectory, { recursive: true });

    const hierarchicalPath = join(this.uploadDirectory, sanitizedKey);
    await mkdir(dirname(hierarchicalPath), { recursive: true });
    await writeFile(hierarchicalPath, buffer);

    const flatPath = join(this.uploadDirectory, basename(sanitizedKey));
    if (flatPath !== hierarchicalPath) {
      await writeFile(flatPath, buffer).catch(() => undefined);
    }

    return {
      key: sanitizedKey,
      location: hierarchicalPath,
      storageDriver: 'local',
    };
  }

  private async getLocalObject(
    key: string,
    rangeHeader?: string,
  ): Promise<GetObjectResult> {
    const filename = basename(key);
    const localPath = join(this.uploadDirectory, filename);

    if (!existsSync(localPath)) {
      throw new Error(`File not found: ${localPath}`);
    }

    const fileStats = await stat(localPath);
    const fullBuffer = await readFile(localPath);

    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const rangeParts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = Number.parseInt(rangeParts[0] ?? '0', 10) || 0;
      const end = rangeParts[1]
        ? Number.parseInt(rangeParts[1], 10)
        : fileStats.size - 1;

      const chunk = fullBuffer.subarray(start, end + 1);
      return {
        buffer: chunk,
        contentType: this.guessContentType(filename),
        contentLength: chunk.length,
        status: 206,
        contentRange: `bytes ${start}-${end}/${fileStats.size}`,
        acceptRanges: 'bytes',
      };
    }

    return {
      buffer: fullBuffer,
      contentType: this.guessContentType(filename),
      contentLength: fileStats.size,
      status: 200,
      acceptRanges: 'bytes',
    };
  }

  private buildObjectUrl(endpoint: string, key: string): string {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');

    if (this.s3ForcePathStyle) {
      return `${endpoint}/${this.s3Bucket}/${encodedKey}`;
    }
    const url = new URL(endpoint);
    return `${url.protocol}//${this.s3Bucket}.${url.host}/${encodedKey}`;
  }

  private buildBucketUrl(endpoint: string): string {
    if (this.s3ForcePathStyle) {
      return `${endpoint}/${this.s3Bucket}`;
    }
    const url = new URL(endpoint);
    return `${url.protocol}//${this.s3Bucket}.${url.host}`;
  }

  private signRequest(options: {
    method: string;
    url: string;
    body?: Buffer;
    contentType?: string;
    customHeaders?: Record<string, string>;
  }): Record<string, string> {
    const { method, url, body, contentType, customHeaders } = options;
    const parsedUrl = new URL(url);
    const now = new Date();
    const amzDate = this.toAmzDate(now);
    const dateStamp = amzDate.substring(0, 8);

    const payloadHash = body ? this.sha256(body) : this.sha256('');

    const headersToSign: Record<string, string> = {
      host: parsedUrl.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(customHeaders || {}),
    };

    const sortedHeaderNames = Object.keys(headersToSign)
      .map((h) => h.toLowerCase())
      .sort();

    const canonicalHeaders = sortedHeaderNames
      .map((h) => `${h}:${(headersToSign[h] ?? '').trim()}\n`)
      .join('');

    const signedHeaders = sortedHeaderNames.join(';');

    const canonicalRequest = [
      method,
      parsedUrl.pathname,
      parsedUrl.search.replace(/^\?/, ''),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.s3Region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      this.sha256(canonicalRequest),
    ].join('\n');

    const signingKey = this.getSignatureKey(
      this.s3SecretKey,
      dateStamp,
      this.s3Region,
      's3',
    );
    const signature = this.hmacHex(signingKey, stringToSign);

    const authHeader = `AWS4-HMAC-SHA256 Credential=${this.s3AccessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      ...headersToSign,
      Authorization: authHeader,
    };
  }

  private sanitizeKey(key: string): string {
    const stripped = key.replace(/^(s3:\/\/[^/]+\/|\/+)/, '').trim();
    return stripped
      .split(/[/\\]+/)
      .filter((part) => part !== '..' && part !== '.')
      .join('/');
  }

  private guessContentType(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.pdf')) return 'application/pdf';
    if (lower.endsWith('.md') || lower.endsWith('.markdown'))
      return 'text/markdown';
    if (lower.endsWith('.txt')) return 'text/plain';
    return 'application/octet-stream';
  }

  private toAmzDate(date: Date): string {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  }

  private sha256(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  private hmac(key: Buffer | string, data: string): Buffer {
    return createHmac('sha256', key).update(data, 'utf8').digest();
  }

  private hmacHex(key: Buffer, data: string): string {
    return createHmac('sha256', key).update(data, 'utf8').digest('hex');
  }

  private getSignatureKey(
    key: string,
    dateStamp: string,
    regionName: string,
    serviceName: string,
  ): Buffer {
    const kDate = this.hmac(`AWS4${key}`, dateStamp);
    const kRegion = this.hmac(kDate, regionName);
    const kService = this.hmac(kRegion, serviceName);
    return this.hmac(kService, 'aws4_request');
  }
}

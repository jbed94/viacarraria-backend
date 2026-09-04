import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { basename, join } from 'path';

export type StorageDriver = 's3' | 'local';

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

  private bucketInitialized = false;

  constructor(config: ConfigService) {
    const rawDriver = config.get<string>('STORAGE_DRIVER', 's3').toLowerCase();
    this.s3Endpoint = (config.get<string>('S3_ENDPOINT') ?? '').replace(
      /\/$/,
      '',
    );
    this.s3Region = config.get<string>('S3_REGION', 'us-east-1');
    this.s3AccessKey = config.get<string>('S3_ACCESS_KEY', 'minioadmin');
    this.s3SecretKey = config.get<string>('S3_SECRET_KEY', 'minioadmin');
    this.s3Bucket = config.get<string>('S3_BUCKET', 'viacarraria-sources');
    this.s3ForcePathStyle =
      config.get<string>('S3_FORCE_PATH_STYLE', 'true') === 'true';
    this.s3PublicUrl = (
      config.get<string>('S3_PUBLIC_URL') || this.s3Endpoint
    ).replace(/\/$/, '');

    this.uploadDirectory =
      config.get<string>('UPLOAD_DIR') ?? join(process.cwd(), 'uploads');

    // If S3 endpoint is missing and driver is s3, fallback gracefully to local
    if (rawDriver === 's3' && !this.s3Endpoint) {
      this.driver = 'local';
      this.logger.warn(
        'STORAGE_DRIVER set to s3 but S3_ENDPOINT is empty; falling back to local driver.',
      );
    } else {
      this.driver = rawDriver === 'local' ? 'local' : 's3';
    }

    this.logger.log(
      `Storage initialized with driver: ${this.driver} (S3 bucket: ${this.s3Bucket}, upload dir: ${this.uploadDirectory})`,
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

  async putObject(
    key: string,
    buffer: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<PutObjectResult> {
    const sanitizedKey = this.sanitizeKey(key);

    if (this.driver === 's3') {
      try {
        await this.ensureBucket();
        const url = this.buildObjectUrl(this.s3Endpoint, sanitizedKey);
        const headers = this.signRequest({
          method: 'PUT',
          url,
          body: buffer,
          contentType,
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

  private async putLocalObject(
    key: string,
    buffer: Buffer,
  ): Promise<PutObjectResult> {
    await mkdir(this.uploadDirectory, { recursive: true });
    const localFilePath = join(this.uploadDirectory, basename(key));
    await writeFile(localFilePath, buffer);
    return {
      key,
      location: localFilePath,
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
    return key.replace(/^(s3:\/\/[^/]+\/|\/+)/, '').trim();
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

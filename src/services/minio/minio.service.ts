import { Injectable, OnModuleInit, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as Minio from 'minio';
import { extname } from 'path';
import type { Express } from 'express';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private client: Minio.Client;
  private bucket: string;
  // FIX: was read from process.env.DURATION_OF_PRE_SIGNED_DOCUMENT directly
  // inside each presign method, bypassing ConfigService/Joi entirely — a
  // non-numeric value would silently become NaN at request time instead of
  // failing fast at boot. Now resolved once here from configuration.ts's
  // minio.presignDurationSeconds, same pattern as every other config value.
  private presignDurationSeconds: number;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const endpoint = this.configService.get<string>('minio.endpoint');
    const accessKey = this.configService.get<string>('minio.accessKey');
    const secretKey = this.configService.get<string>('minio.secretKey');

    // FIX: was `minio.bucketName ?? 'ehte-media'`, but configuration.ts used
    // to expose this value under the key `minio.bucket` (not `bucketName`),
    // so this lookup always returned undefined and silently fell back to
    // 'ehte-media' regardless of what MINIO_BUCKET_NAME was set to. Fixed at
    // the source in configuration.ts; this line is unchanged but now
    // actually resolves the configured bucket name correctly.
    this.bucket = this.configService.get<string>('minio.bucketName') ?? 'ehte-media';

    this.presignDurationSeconds =
      this.configService.get<number>('minio.presignDurationSeconds') ?? 120;

    if (!endpoint || !accessKey || !secretKey) {
      this.logger.warn(
        'MinIO is not configured (missing endpoint/accessKey/secretKey). File uploads will be disabled.',
      );
      return;
    }

    try {
      this.client = new Minio.Client({
        endPoint: endpoint,
        port: this.configService.get<number>('minio.port') ?? 9000,
        useSSL: this.configService.get<boolean>('minio.useSSL') ?? false,
        accessKey,
        secretKey,
      });
      this.logger.log('MinIO client initialized');

      await this.ensureBucket(this.bucket);
    } catch (e) {
      this.logger.error('Failed to initialize MinIO', e);
    }
  }

  private assertClient(): void {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'MinIO is not configured or failed to start. Check MINIO_* environment variables.',
      );
    }
  }

  async ensureBucket(bucketName: string = this.bucket): Promise<void> {
    this.assertClient();
    try {
      const exists = await this.client.bucketExists(bucketName);
      if (!exists) {
        await this.client.makeBucket(bucketName, 'us-east-1');
        this.logger.log(`Bucket "${bucketName}" created`);
      }
    } catch (err: any) {
      if (err.code === 'BucketAlreadyOwnedByYou') {
        return;
      }
      throw err;
    }
  }

  // FIX (per mentor review): MinioService no longer decides object-key naming.
  // Every method below now takes a finished `key: string` and just stores/reads/
  // signs it — key construction (UUID, folder prefix, extension, etc.) is the
  // caller's responsibility. This collapses the old uploadBuffer()/uploadFile()
  // duplication into one method and matches generatePresignedUploadUrl(), which
  // already built its key the same way (randomUUID() + extname(...)).

  async uploadFile(
    key: string,
    buffer: Buffer,
    contentType: string = 'application/octet-stream',
  ): Promise<string> {
    this.assertClient();
    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': contentType,
    });
    this.logger.log(`Uploaded: ${this.bucket}/${key}`);
    return key;
  }

  // Convenience helper for callers that still have a raw Multer file and just
  // want a safe, unique key generated for them. Not required — callers are
  // free to build their own key and call uploadFile() directly instead.
  buildObjectKey(originalname: string, folder: string): string {
    return `${folder}/${randomUUID()}${extname(originalname)}`;
  }

  async uploadMulterFile(
    file: Express.Multer.File,
    folder: string,
  ): Promise<string> {
    const key = this.buildObjectKey(file.originalname, folder);
    return this.uploadFile(key, file.buffer, file.mimetype);
  }

  async getUrl(key: string, expirySeconds: number = 24 * 60 * 60): Promise<string> {
    this.assertClient();
    return this.client.presignedGetObject(this.bucket, key, expirySeconds);
  }

  async deleteFile(key: string): Promise<void> {
    this.assertClient();
    await this.client.removeObject(this.bucket, key);
  }

  // Confirms an object actually exists in the bucket before some
  // other entity (Post, Report, etc.) is allowed to reference its
  // filepath. Used by PostService/ReportService to validate
  // incoming media filepaths on create/update, so a record can
  // never point at an object that was never uploaded.
  async objectExists(key: string): Promise<boolean> {
    this.assertClient();
    try {
      await this.client.statObject(this.bucket, key);
      return true;
    } catch (err: any) {
      if (err.code === 'NotFound') {
        return false;
      }
      throw err;
    }
  }

  async generatePresignedUploadUrl(fileInfo: {
    originalname: string;
    contentType?: string;
    folder?: string;
  }): Promise<{ presignedUrl: string; file: Record<string, string | undefined> }> {
    this.assertClient();
    const key = this.buildObjectKey(fileInfo.originalname, fileInfo.folder ?? 'uploads');
    const presignedUrl = await this.client.presignedPutObject(
      this.bucket,
      key,
      this.presignDurationSeconds,
    );

    return {
      presignedUrl,
      file: {
        filepath: key,
        bucketName: this.bucket,
        contentType: fileInfo.contentType,
        originalname: fileInfo.originalname,
      },
    };
  }

  async generatePresignedDownloadUrl(key: string): Promise<string> {
    this.assertClient();
    return this.client.presignedGetObject(this.bucket, key, this.presignDurationSeconds);
  }
}
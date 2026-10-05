import { Injectable, OnModuleInit, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as Minio from 'minio';
import { extname } from 'path';
import type { Express } from 'express';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  // Internal client: all server-side traffic (put/stat/remove/bucket checks)
  // goes over the docker network, e.g. http://shared-minio:9000.
  private client: Minio.Client;
  private presignClient: Minio.Client;
  private bucket: string;
  private presignDurationSeconds: number;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const endpoint = this.configService.get<string>('minio.endpoint');
    const accessKey = this.configService.get<string>('minio.accessKey');
    const secretKey = this.configService.get<string>('minio.secretKey');

    this.bucket = this.configService.get<string>('minio.bucketName') ?? 'ehte-media';

    this.presignDurationSeconds =
      this.configService.get<number>('minio.presignDurationSeconds') ?? 600;

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
        region: this.configService.get<string>('minio.region') ?? 'us-east-1',
        accessKey,
        secretKey,
      });
      this.presignClient = this.buildPresignClient(accessKey, secretKey);
      this.logger.log('MinIO client initialized');

      await this.ensureBucket(this.bucket);
    } catch (e: any) {
      this.logger.error(
        `Failed to initialize MinIO: code=${e?.code ?? 'unknown'} status=${e?.statusCode ?? 'unknown'} message=${e?.message ?? 'unknown'}`,
      );
    }
  }

  private buildPresignClient(accessKey: string, secretKey: string): Minio.Client {
    const publicUrl = this.configService.get<string>('minio.publicUrl');
    if (!publicUrl) {
      return this.client;
    }

    const url = new URL(publicUrl);
    if (url.pathname !== '/' && url.pathname !== '') {
      this.logger.warn(
        `MINIO_PUBLIC_URL has a path (${url.pathname}); the MinIO SDK only signs host-rooted URLs, so the path is ignored.`,
      );
    }
    const useSSL = url.protocol === 'https:';

    this.logger.log(`Presigned URLs will be signed for ${url.protocol}//${url.host}`);
    return new Minio.Client({
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : useSSL ? 443 : 80,
      useSSL,
      region: this.configService.get<string>('minio.region') ?? 'us-east-1',
      accessKey,
      secretKey,
    });
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

  buildObjectKey(originalname: string, folder: string): string {
    return `${folder}/${randomUUID()}${extname(originalname)}`;
  }

  async uploadMulterFile(file: Express.Multer.File, folder: string): Promise<string> {
    const key = this.buildObjectKey(file.originalname, folder);
    return this.uploadFile(key, file.buffer, file.mimetype);
  }

  async getUrl(key: string, expirySeconds: number = 24 * 60 * 60): Promise<string> {
    this.assertClient();
    return this.presignClient.presignedGetObject(this.bucket, key, expirySeconds);
  }

  async deleteFile(key: string): Promise<void> {
    this.assertClient();
    await this.client.removeObject(this.bucket, key);
  }

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

  async statObject(key: string): Promise<{ size: number; contentType: string }> {
    this.assertClient();
    const stat = await this.client.statObject(this.bucket, key);
    return {
      size: stat.size,
      contentType: stat.metaData?.['content-type'] ?? 'application/octet-stream',
    };
  }

  async generatePresignedUploadUrl(fileInfo: {
    originalname: string;
    contentType?: string;
    folder?: string;
  }): Promise<{ presignedUrl: string; file: Record<string, string | undefined> }> {
    this.assertClient();
    const key = this.buildObjectKey(fileInfo.originalname, fileInfo.folder ?? 'uploads');
    const presignedUrl = await this.presignClient.presignedPutObject(
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
    return this.presignClient.presignedGetObject(this.bucket, key, this.presignDurationSeconds);
  }
}

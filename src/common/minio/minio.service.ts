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

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const endpoint = this.configService.get<string>('minio.endpoint');
    const accessKey = this.configService.get<string>('minio.accessKey');
    const secretKey = this.configService.get<string>('minio.secretKey');

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

      const bucket =
        this.configService.get<string>('minio.bucketName') ?? 'ehte-media';
      await this.ensureBucket(bucket);
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

  async ensureBucket(bucketName: string): Promise<void> {
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

  async uploadBuffer(
    bucketName: string,
    objectName: string,
    buffer: Buffer,
    contentType: string = 'application/octet-stream',
  ): Promise<string> {
    this.assertClient();
    await this.client.putObject(bucketName, objectName, buffer, buffer.length, {
      'Content-Type': contentType,
    });
    this.logger.log(`Uploaded: ${bucketName}/${objectName}`);
    return objectName;
  }

  async uploadFile(
    bucketName: string,
    file: Express.Multer.File,
    folder: string,
  ): Promise<string> {
    this.assertClient();
    const today = new Date();
    const day = String(today.getDate()).padStart(2, '0');
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const year = String(today.getFullYear()).slice(-2);
    const datePrefix = `${day}-${month}-${year}`;
    const cleanName = file.originalname.replace(/\s+/g, '_');
    const objectName = `${folder}/${datePrefix}-${cleanName}`;

    await this.client.putObject(
      bucketName,
      objectName,
      file.buffer,
      file.size,
      { 'Content-Type': file.mimetype },
    );

    return objectName;
  }

  async getUrl(bucketName: string, objectName: string): Promise<string> {
    this.assertClient();
    return this.client.presignedGetObject(bucketName, objectName, 24 * 60 * 60);
  }

  async deleteFile(bucketName: string, objectName: string): Promise<void> {
    this.assertClient();
    await this.client.removeObject(bucketName, objectName);
  }

  // Confirms an object actually exists in the bucket before some
  // other entity (Post, Report, etc.) is allowed to reference its
  // filepath. Used by PostService/ReportService to validate
  // incoming media filepaths on create/update, so a record can
  // never point at an object that was never uploaded.
  async objectExists(bucketName: string, objectName: string): Promise<boolean> {
    this.assertClient();
    try {
      await this.client.statObject(bucketName, objectName);
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
  }): Promise<{ presignedUrl: string; file: Record<string, string | undefined> }> {
    this.assertClient();
    const filepath = randomUUID() + extname(fileInfo.originalname);
    const bucketName =
      this.configService.get<string>('minio.bucketName') ?? 'ehte-media';
    const duration = Number(process.env.DURATION_OF_PRE_SIGNED_DOCUMENT ?? 120);
    const presignedUrl = await this.client.presignedPutObject(
      bucketName,
      filepath,
      duration,
    );

    return {
      presignedUrl,
      file: {
        filepath,
        bucketName,
        contentType: fileInfo.contentType,
        originalname: fileInfo.originalname,
      },
    };
  }

  async generatePresignedDownloadUrl(fileInfo: {
    bucketName: string;
    filepath: string;
  }): Promise<string> {
    this.assertClient();
    const duration = Number(process.env.DURATION_OF_PRE_SIGNED_DOCUMENT ?? 120);
    return this.client.presignedGetObject(fileInfo.bucketName, fileInfo.filepath, duration);
  }
}
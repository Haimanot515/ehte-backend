import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
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

  async onModuleInit(): Promise<void> {
    const endpoint = this.configService.get<string>('minio.endpoint');

    const accessKey = this.configService.get<string>('minio.accessKey');

    const secretKey = this.configService.get<string>('minio.secretKey');

    if (!endpoint || !accessKey || !secretKey) {
      this.logger.warn('MinIO is not configured. File uploads will be disabled.');
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

      this.logger.log('Ehte MinIO client initialized');

      const bucket = this.configService.get<string>('minio.bucketName') ?? 'ehte-media';

      await this.ensureBucket(bucket);
    } catch (error) {
      this.logger.error('Failed to initialize Ehte MinIO', error);
    }
  }

  /**
   * Make sure the Ehte storage bucket exists.
   */
  async ensureBucket(bucketName: string): Promise<void> {
    this.assertClient();

    try {
      const exists = await this.client.bucketExists(bucketName);

      if (!exists) {
        await this.client.makeBucket(bucketName, 'us-east-1');

        this.logger.log(`Ehte MinIO bucket "${bucketName}" created`);
      }
    } catch (error: any) {
      if (error.code === 'BucketAlreadyOwnedByYou') {
        return;
      }

      throw error;
    }
  }

  /**
   * Upload a Buffer to MinIO.
   */
  async uploadBuffer(
    bucketName: string,
    objectName: string,
    buffer: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<string> {
    this.assertClient();

    await this.client.putObject(bucketName, objectName, buffer, buffer.length, {
      'Content-Type': contentType,
    });

    this.logger.log(`Uploaded Ehte file: ${bucketName}/${objectName}`);

    return objectName;
  }

  /**
   * Upload a file received through Multer.
   */
  async uploadFile(bucketName: string, file: Express.Multer.File, folder: string): Promise<string> {
    this.assertClient();

    const extension = extname(file.originalname);

    const safeFileName = `${randomUUID()}${extension}`;

    const objectName = `${folder}/${safeFileName}`;

    await this.client.putObject(bucketName, objectName, file.buffer, file.size, {
      'Content-Type': file.mimetype,
    });

    this.logger.log(`Uploaded Ehte file: ${objectName}`);

    return objectName;
  }

  /**
   * Generate a temporary private download URL.
   */
  async getUrl(bucketName: string, objectName: string): Promise<string> {
    this.assertClient();

    return this.client.presignedGetObject(bucketName, objectName, 24 * 60 * 60);
  }

  /**
   * Delete a file from MinIO.
   */
  async deleteFile(bucketName: string, objectName: string): Promise<void> {
    this.assertClient();

    await this.client.removeObject(bucketName, objectName);

    this.logger.log(`Deleted Ehte file: ${bucketName}/${objectName}`);
  }

  /**
   * Generate a temporary URL that allows
   * the mobile application to upload directly
   * to MinIO.
   */
  async generatePresignedUploadUrl(fileInfo: {
    originalname: string;
    contentType?: string;
  }): Promise<{
    presignedUrl: string;
    file: Record<string, string | undefined>;
  }> {
    this.assertClient();

    const extension = extname(fileInfo.originalname);

    const filepath = `${randomUUID()}${extension}`;

    const bucketName = this.configService.get<string>('minio.bucketName') ?? 'ehte-media';

    const duration = Number(process.env.DURATION_OF_PRE_SIGNED_DOCUMENT ?? 120);

    const presignedUrl = await this.client.presignedPutObject(bucketName, filepath, duration);

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

  /**
   * Generate a temporary private download URL.
   */
  async generatePresignedDownloadUrl(fileInfo: {
    bucketName: string;
    filepath: string;
  }): Promise<string> {
    this.assertClient();

    const duration = Number(process.env.DURATION_OF_PRE_SIGNED_DOCUMENT ?? 120);

    return this.client.presignedGetObject(fileInfo.bucketName, fileInfo.filepath, duration);
  }

  /**
   * Make sure the MinIO client is available
   * before performing a storage operation.
   */
  private assertClient(): void {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'MinIO is not configured or failed to start. Check MINIO_* environment variables.',
      );
    }
  }
}

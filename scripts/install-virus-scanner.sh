#!/usr/bin/env bash
set -e

if [ ! -d src ] || [ ! -d prisma ]; then
  echo "Run this from the project root (the folder that contains src and prisma)."
  exit 1
fi

put() {
  mkdir -p "$(dirname "$1")"
  if [ -f "$1" ]; then cp "$1" "$1.bak"; fi
  cat > "$1"
  echo "written: $1"
}

put "prisma/schema/media-scan.prisma" <<'EOF_FILE'
/// One row per uploaded object. status: PENDING | CLEAN | INFECTED | REJECTED | FAILED.
model MediaScan {
  id        String    @id @default(uuid())
  objectKey String    @unique
  status    String    @default("PENDING")
  signature String?
  attempts  Int       @default(0)
  lockedAt  DateTime?
  scannedAt DateTime?
  expiresAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @default(now()) @updatedAt

  @@index([status, updatedAt])
  @@map("media_scan")
}
EOF_FILE

put "prisma/migrations/20261008120000_add_media_scan/migration.sql" <<'EOF_FILE'
-- CreateTable
CREATE TABLE "media_scan" (
    "id" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "signature" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "scannedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_scan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_scan_objectKey_key" ON "media_scan"("objectKey");

-- CreateIndex
CREATE INDEX "media_scan_status_updatedAt_idx" ON "media_scan"("status", "updatedAt");
EOF_FILE

put "src/infrastructure/clamav/clamav.service.ts" <<'EOF_FILE'
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { once } from 'events';
import * as net from 'net';

const CHUNK_SIZE = 64 * 1024;

export interface ClamavScanResult {
  clean: boolean;
  signature?: string;
}

@Injectable()
export class ClamavService {
  private readonly logger = new Logger(ClamavService.name);

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return this.config.get<string>('CLAMAV_ENABLED') === 'true';
  }

  async scanBuffer(buffer: Buffer): Promise<ClamavScanResult> {
    const reply = await this.stream(buffer);
    const found = /^stream:\s*(.+?)\s+FOUND$/.exec(reply);
    if (found) return { clean: false, signature: found[1] };
    if (reply.endsWith('OK')) return { clean: true };
    throw new Error(`clamav_unexpected_reply:${reply}`);
  }

  async assertClean(buffer: Buffer): Promise<void> {
    let result: ClamavScanResult;
    try {
      result = await this.scanBuffer(buffer);
    } catch (err) {
      this.logger.error(`Scanner unavailable: ${(err as Error).message}`);
      throw new ServiceUnavailableException('file_scan_unavailable');
    }
    if (!result.clean) {
      this.logger.warn(`Upload blocked, signature=${result.signature}`);
      throw new BadRequestException('file_infected');
    }
  }

  private stream(buffer: Buffer): Promise<string> {
    const host = this.config.get<string>('CLAMAV_HOST') ?? '127.0.0.1';
    const port = Number(this.config.get<string>('CLAMAV_PORT') ?? 3310);
    const timeoutMs = Number(this.config.get<string>('CLAMAV_TIMEOUT_MS') ?? 120000);

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const parts: Buffer[] = [];

      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => socket.destroy(new Error('clamav_timeout')));
      socket.on('error', reject);
      socket.on('data', (data) => parts.push(data));
      socket.on('close', () =>
        resolve(Buffer.concat(parts).toString('utf8').replace(/\0/g, '').trim()),
      );
      socket.on('connect', () => {
        this.send(socket, buffer).catch((err) => socket.destroy(err));
      });
    });
  }

  private async send(socket: net.Socket, buffer: Buffer): Promise<void> {
    socket.write('zINSTREAM\0');

    for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
      if (socket.destroyed) return;
      const part = buffer.subarray(offset, offset + CHUNK_SIZE);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(part.length, 0);

      if (!socket.write(Buffer.concat([header, part]))) {
        const stop = new AbortController();
        await Promise.race([
          once(socket, 'drain', { signal: stop.signal }),
          once(socket, 'close', { signal: stop.signal }),
        ]).finally(() => stop.abort());
      }
    }

    socket.write(Buffer.alloc(4));
  }
}
EOF_FILE

put "src/infrastructure/clamav/media-scan.service.ts" <<'EOF_FILE'
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/prisma/prisma.service';

const LOCK_STALE_MS = 5 * 60 * 1000;

@Injectable()
export class MediaScanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.get<string>('CLAMAV_ENABLED') === 'true';
  }

  async registerPending(key: string): Promise<void> {
    if (!this.enabled) return;
    const ttlHours = Number(this.config.get<string>('MEDIA_SCAN_PENDING_TTL_HOURS') ?? 2);
    await this.prisma.mediaScan.upsert({
      where: { objectKey: key },
      update: {},
      create: {
        objectKey: key,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
      },
    });
  }

  async registerClean(key: string): Promise<void> {
    if (!this.enabled) return;
    await this.prisma.mediaScan.upsert({
      where: { objectKey: key },
      update: { status: 'CLEAN', scannedAt: new Date() },
      create: { objectKey: key, status: 'CLEAN', scannedAt: new Date() },
    });
  }

  async assertUsable(key: string): Promise<void> {
    if (!this.enabled) return;
    const row = await this.prisma.mediaScan.findUnique({
      where: { objectKey: key },
      select: { status: true },
    });
    if (!row || row.status === 'CLEAN') return;
    throw new BadRequestException(`media_scan_${row.status.toLowerCase()}:${key}`);
  }

  findDue(limit: number) {
    return this.prisma.mediaScan.findMany({
      where: { status: 'PENDING', OR: [{ lockedAt: null }, { lockedAt: { lt: this.staleLock() } }] },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true, objectKey: true, expiresAt: true },
    });
  }

  async claim(id: string): Promise<boolean> {
    const result = await this.prisma.mediaScan.updateMany({
      where: {
        id,
        status: 'PENDING',
        OR: [{ lockedAt: null }, { lockedAt: { lt: this.staleLock() } }],
      },
      data: { lockedAt: new Date() },
    });
    return result.count === 1;
  }

  async release(id: string): Promise<void> {
    await this.prisma.mediaScan.update({ where: { id }, data: { lockedAt: null } });
  }

  async markClean(id: string): Promise<void> {
    await this.prisma.mediaScan.update({
      where: { id },
      data: { status: 'CLEAN', lockedAt: null, scannedAt: new Date() },
    });
  }

  async markBlocked(id: string, status: 'INFECTED' | 'REJECTED', signature: string): Promise<void> {
    await this.prisma.mediaScan.update({
      where: { id },
      data: { status, signature, lockedAt: null, scannedAt: new Date() },
    });
  }

  async recordFailure(id: string, maxAttempts: number): Promise<void> {
    const row = await this.prisma.mediaScan.update({
      where: { id },
      data: { attempts: { increment: 1 }, lockedAt: null },
    });
    if (row.attempts >= maxAttempts) {
      await this.prisma.mediaScan.update({ where: { id }, data: { status: 'FAILED' } });
    }
  }

  async remove(id: string): Promise<void> {
    await this.prisma.mediaScan.delete({ where: { id } });
  }

  private staleLock(): Date {
    return new Date(Date.now() - LOCK_STALE_MS);
  }
}
EOF_FILE

put "src/infrastructure/clamav/clamav.module.ts" <<'EOF_FILE'
import { Global, Module } from '@nestjs/common';

import { ClamavService } from './clamav.service';
import { MediaScanService } from './media-scan.service';

@Global()
@Module({
  providers: [ClamavService, MediaScanService],
  exports: [ClamavService, MediaScanService],
})
export class ClamavModule {}
EOF_FILE

put "src/modules/media/service/media-scan.worker.ts" <<'EOF_FILE'
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditSeverity } from '@prisma/client';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { ClamavService } from 'src/infrastructure/clamav/clamav.service';
import { MediaScanService } from 'src/infrastructure/clamav/media-scan.service';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';

interface DueItem {
  id: string;
  objectKey: string;
  expiresAt: Date | null;
}

@Injectable()
export class MediaScanWorker {
  private readonly logger = new Logger(MediaScanWorker.name);
  private running = false;

  constructor(
    private readonly scans: MediaScanService,
    private readonly clamav: ClamavService,
    private readonly minio: MinioService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async run(): Promise<void> {
    if (!this.scans.enabled || this.running) return;
    this.running = true;
    try {
      const due = await this.scans.findDue(10);
      for (const item of due) {
        if (await this.scans.claim(item.id)) await this.processOne(item);
      }
    } catch (err) {
      this.logger.error(`Scan cycle failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async processOne(item: DueItem): Promise<void> {
    try {
      const stat = await this.statOrNull(item.objectKey);

      if (!stat) {
        if (item.expiresAt && item.expiresAt < new Date()) await this.scans.remove(item.id);
        else await this.scans.release(item.id);
        return;
      }

      const maxBytes = Number(this.config.get<string>('MEDIA_MAX_FILE_SIZE') ?? 52428800);
      if (stat.size > maxBytes) {
        await this.block(item, 'REJECTED', 'too_large');
        return;
      }

      const buffer = await this.minio.getObjectBuffer(item.objectKey);
      const result = await this.clamav.scanBuffer(buffer);

      if (result.clean) await this.scans.markClean(item.id);
      else await this.block(item, 'INFECTED', result.signature ?? 'unknown');
    } catch (err) {
      this.logger.warn(`Scan failed for ${item.objectKey}: ${(err as Error).message}`);
      const maxAttempts = Number(this.config.get<string>('MEDIA_SCAN_MAX_ATTEMPTS') ?? 100);
      await this.scans.recordFailure(item.id, maxAttempts).catch(() => undefined);
    }
  }

  private async statOrNull(key: string): Promise<{ size: number } | null> {
    try {
      return await this.minio.statObject(key);
    } catch (err) {
      if ((err as { code?: string }).code === 'NotFound') return null;
      throw err;
    }
  }

  private async block(
    item: DueItem,
    status: 'INFECTED' | 'REJECTED',
    signature: string,
  ): Promise<void> {
    await this.minio.deleteFile(item.objectKey);
    await this.scans.markBlocked(item.id, status, signature);

    const payload: AuditEventPayload = {
      actorType: 'SYSTEM',
      action: AuditEventEnum.MEDIA_DELETED,
      entity: 'Media',
      entityId: item.objectKey,
      severity: AuditSeverity.WARNING,
      reason: `malware_scan_${status.toLowerCase()}`,
      metadata: { signature },
    };
    this.events.emit(payload.action, payload);
    this.logger.warn(`Removed ${item.objectKey}: ${status} (${signature})`);
  }
}
EOF_FILE

put "src/modules/media/service/media.service.ts" <<'EOF_FILE'
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Express } from 'express';

import { MediaScanService } from 'src/infrastructure/clamav/media-scan.service';
import { MinioService } from 'src/infrastructure/minio/minio.service';

import { PresignedUploadDto } from '../dto/presigned-upload.dto';
import { MediaFolder } from '../../../common/enums/media-folder.enum';

// Domain-agnostic on purpose: downloads stay in each domain service so visibility rules are enforced there.

@Injectable()
export class MediaService {
  constructor(
    private readonly minioService: MinioService,
    private readonly mediaScans: MediaScanService,
  ) {}

  async createPresignedUpload(
    dto: PresignedUploadDto,
  ): Promise<{ presignedUrl: string; key: string }> {
    const { presignedUrl, file } = await this.minioService.generatePresignedUploadUrl({
      originalname: dto.originalname,
      contentType: dto.contentType,
      folder: dto.folder,
    });

    const key = file.filepath as string;
    await this.mediaScans.registerPending(key);

    return { presignedUrl, key };
  }

  async uploadFile(
    file: Express.Multer.File | undefined,
    folder: MediaFolder,
  ): Promise<{ key: string; contentType: string; size: number }> {
    if (!file) {
      throw new BadRequestException('file_required');
    }

    const key = await this.minioService.uploadMulterFile(file, folder);

    return { key, contentType: file.mimetype, size: file.size };
  }

  async deleteObject(key: string): Promise<{ message: string; key: string }> {
    await this.minioService.deleteFile(key);
    return { message: 'media_deleted', key };
  }
}
EOF_FILE

put "src/modules/media/media.module.ts" <<'EOF_FILE'
import { Module } from '@nestjs/common';

import { ClamavModule } from '../../infrastructure/clamav/clamav.module';
import { MediaController } from './controller/media.controller';
import { MediaService } from './service/media.service';
import { MediaScanWorker } from './service/media-scan.worker';

@Module({
  imports: [ClamavModule],
  controllers: [MediaController],
  providers: [MediaService, MediaScanWorker],
})
export class MediaModule {}
EOF_FILE

put "src/infrastructure/minio/minio.service.ts" <<'EOF_FILE'
import {
  Injectable,
  OnModuleInit,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as Minio from 'minio';
import { extname } from 'path';
import type { Express } from 'express';

import { ClamavService } from '../clamav/clamav.service';
import { MediaScanService } from '../clamav/media-scan.service';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  // Internal client for all server-side traffic; the presign client signs browser-facing URLs.
  private client: Minio.Client;
  private presignClient: Minio.Client;
  private bucket: string;
  private presignDurationSeconds: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly clamav: ClamavService,
    private readonly mediaScans: MediaScanService,
  ) {}

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
    if (this.clamav.enabled) {
      await this.clamav.assertClean(file.buffer);
    }

    const key = this.buildObjectKey(file.originalname, folder);
    await this.uploadFile(key, file.buffer, file.mimetype);
    await this.mediaScans.registerClean(key);
    return key;
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
    } catch (err: any) {
      if (err.code === 'NotFound') {
        return false;
      }
      throw err;
    }

    await this.mediaScans.assertUsable(key);
    return true;
  }

  async statObject(key: string): Promise<{ size: number; contentType: string }> {
    this.assertClient();
    const stat = await this.client.statObject(this.bucket, key);
    return {
      size: stat.size,
      contentType: stat.metaData?.['content-type'] ?? 'application/octet-stream',
    };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    this.assertClient();
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
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
EOF_FILE

put "docker-compose.clamav.yml" <<'EOF_FILE'
services:
  clamav:
    image: clamav/clamav:stable
    restart: unless-stopped
    ports:
      - "3310:3310"
    environment:
      CLAMD_CONF_StreamMaxLength: 100M
      CLAMD_CONF_MaxFileSize: 100M
    volumes:
      - clamav_db:/var/lib/clamav

volumes:
  clamav_db:
EOF_FILE

echo
echo "All files created. Existing files that were replaced have a .bak copy next to them."
echo "Next: npx prisma generate && npx prisma migrate deploy, then set CLAMAV_ENABLED, CLAMAV_HOST, CLAMAV_PORT."
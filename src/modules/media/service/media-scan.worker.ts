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

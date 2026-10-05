import { Inject, Injectable, Logger, NotFoundException, ConflictException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MiscExportJob, Prisma } from '@prisma/client';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { PrismaService } from 'src/prisma/prisma.service';

import type { ExportJobFinishedEvent } from '../events/notification.events';

import { MISC_OBJECT_STORAGE, MiscObjectStorage } from './misc-object-storage';

/** Excel needs a BOM to read UTF-8 (Amharic) correctly. */
export const CSV_BOM = '\uFEFF';

export const EXPORT_SCOPE = {
  NOTIFICATIONS: 'NOTIFICATIONS',
  AUDIT_LOGS: 'AUDIT_LOGS',
} as const;
export type ExportScope = (typeof EXPORT_SCOPE)[keyof typeof EXPORT_SCOPE];

const PART_ROWS = 100_000;
const MAX_JOB_ROWS = 5_000_000;
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_LINK_TTL_SECONDS = 300;
const STALE_RUNNING_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * One CSV cell. Neutralises spreadsheet formulas (CSV injection) and quotes
 * whenever the value could break the structure.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text =
    typeof value === 'string'
      ? value
      : value instanceof Date
        ? value.toISOString()
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export interface ExportProducer {
  header: string[];
  /** Yields batches of rows. Each row is a list of cell values in header order. */
  batches(): AsyncGenerator<unknown[][]>;
}

/**
 * Background CSV exports. The caller supplies a producer (what to read);
 * this service runs it in the background, writes numbered CSV parts to object
 * storage and tracks progress in MiscExportJob.
 *
 * Runs inside this process. If the process dies, a job that stops updating is
 * reported as FAILED after 15 minutes and can simply be started again.
 */
@Injectable()
export class ExportJobService {
  private readonly logger = new Logger(ExportJobService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MISC_OBJECT_STORAGE) private readonly storage: MiscObjectStorage,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  private emitFinished(job: MiscExportJob, status: 'COMPLETED' | 'FAILED') {
    try {
      const payload: ExportJobFinishedEvent = {
        userId: job.requestedById,
        jobId: job.id,
        scope: job.scope as ExportJobFinishedEvent['scope'],
        status,
        rowCount: job.rowCount,
      };
      this.eventEmitter?.emit(NotificationEventEnum.EXPORT_JOB_FINISHED, payload);
    } catch (err) {
      this.logger.error(`Could not emit export event for ${job.id}: ${this.msg(err)}`);
    }
  }

  async start(args: {
    scope: ExportScope;
    requestedById: string;
    filter: Record<string, unknown>;
    producer: ExportProducer;
    /** Called once when the job completes (used to write the audit export record). */
    onCompleted?: (job: MiscExportJob) => Promise<void>;
  }): Promise<MiscExportJob> {
    const job = await this.prisma.miscExportJob.create({
      data: {
        scope: args.scope,
        requestedById: args.requestedById,
        filter: args.filter as Prisma.InputJsonValue,
        status: 'QUEUED',
      },
    });

    void this.execute(job.id, args.scope, args.producer, args.onCompleted).catch((err) =>
      this.logger.error(`Export job ${job.id} crashed: ${this.msg(err)}`),
    );

    return job;
  }

  async list(scope: ExportScope, requestedById: string, dto: { page?: number; limit?: number }) {
    const page = dto.page ?? 1;
    const limit = Math.min(Math.max(dto.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const where: Prisma.MiscExportJobWhereInput = { scope, requestedById };

    const [rows, total] = await Promise.all([
      this.prisma.miscExportJob.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.miscExportJob.count({ where }),
    ]);

    return {
      data: await Promise.all(rows.map((r) => this.present(r))),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total },
    };
  }

  /** Someone else's job and an unknown id look the same. */
  async get(scope: ExportScope, id: string, requestedById: string) {
    const job = await this.prisma.miscExportJob.findFirst({ where: { id, scope, requestedById } });
    if (!job) throw new NotFoundException('Export job not found');
    return this.present(job);
  }

  /** Short-lived links, one per CSV part. The caller must audit this. */
  async downloadLinks(scope: ExportScope, id: string, requestedById: string) {
    const raw = await this.prisma.miscExportJob.findFirst({ where: { id, scope, requestedById } });
    if (!raw) throw new NotFoundException('Export job not found');

    const job = await this.present(raw);
    if (job.status !== 'COMPLETED') {
      throw new ConflictException(`export_job_is_${String(job.status).toLowerCase()}`);
    }

    const keys = Array.isArray(raw.fileKeys) ? (raw.fileKeys as string[]) : [];
    const files = await Promise.all(
      keys.map(async (key, i) => ({
        name: `part-${String(i + 1).padStart(3, '0')}.csv`,
        url: await this.storage.presignGet(key, DOWNLOAD_LINK_TTL_SECONDS),
      })),
    );

    return {
      job,
      files,
      linkExpiresAt: new Date(Date.now() + DOWNLOAD_LINK_TTL_SECONDS * 1000).toISOString(),
    };
  }

  // ───────────────────────────────────────────

  private async execute(
    jobId: string,
    scope: ExportScope,
    producer: ExportProducer,
    onCompleted?: (job: MiscExportJob) => Promise<void>,
  ): Promise<void> {
    await this.prisma.miscExportJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    const headerLine = producer.header.map(csvCell).join(',');
    const keys: string[] = [];
    let buffer: string[] = [];
    let rows = 0;
    let truncated = false;

    const flush = async () => {
      if (buffer.length === 0) return;
      const key = `exports/${scope.toLowerCase()}/${jobId}/part-${String(keys.length + 1).padStart(3, '0')}.csv`;
      const body = Buffer.from(`${CSV_BOM}${headerLine}\r\n${buffer.join('\r\n')}\r\n`, 'utf8');
      await this.storage.put(key, body, 'text/csv; charset=utf-8');
      keys.push(key);
      buffer = [];
    };

    try {
      outer: for await (const batch of producer.batches()) {
        for (const row of batch) {
          if (rows >= MAX_JOB_ROWS) {
            truncated = true;
            break outer;
          }
          buffer.push(row.map(csvCell).join(','));
          rows += 1;
          if (buffer.length >= PART_ROWS) await flush();
        }
        // Progress, and proof of life for the stale check.
        await this.prisma.miscExportJob.update({ where: { id: jobId }, data: { rowCount: rows } });
      }
      await flush();

      const done = await this.prisma.miscExportJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          rowCount: rows,
          truncated,
          partCount: keys.length,
          fileKeys: keys as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
          expiresAt: new Date(Date.now() + FILE_TTL_MS),
        },
      });

      this.emitFinished(done, 'COMPLETED');

      if (onCompleted) {
        await onCompleted(done).catch((err) =>
          this.logger.error(`Export job ${jobId} completion hook failed: ${this.msg(err)}`),
        );
      }
    } catch (err) {
      this.logger.error(`Export job ${jobId} failed: ${this.msg(err)}`);
      const failed = await this.prisma.miscExportJob
        .update({
          where: { id: jobId },
          data: { status: 'FAILED', error: this.msg(err).slice(0, 300), finishedAt: new Date() },
        })
        .catch(() => null);
      if (failed) this.emitFinished(failed, 'FAILED');
    }
  }

  /** Lazily marks dead and expired jobs so callers never see a job that is stuck forever. */
  private async present(job: MiscExportJob) {
    const now = Date.now();

    if (
      (job.status === 'RUNNING' || job.status === 'QUEUED') &&
      now - job.updatedAt.getTime() > STALE_RUNNING_MS
    ) {
      const failed = await this.prisma.miscExportJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: 'job_stopped_updating', finishedAt: new Date() },
      });
      return this.shape(failed);
    }

    if (job.status === 'COMPLETED' && job.expiresAt && job.expiresAt.getTime() < now) {
      const expired = await this.prisma.miscExportJob.update({
        where: { id: job.id },
        data: { status: 'EXPIRED' },
      });
      return this.shape(expired);
    }

    return this.shape(job);
  }

  private shape(job: MiscExportJob) {
    return {
      id: job.id,
      scope: job.scope,
      status: job.status,
      rowCount: job.rowCount,
      truncated: job.truncated,
      partCount: job.partCount,
      filter: job.filter,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      expiresAt: job.expiresAt,
      requestedById: job.requestedById,
    };
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

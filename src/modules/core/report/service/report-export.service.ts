import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import {
  PageQueryDto,
  ReportStatsQueryDto,
  ExportReportsQueryDto,
  StartExportJobDto,
} from '../dto/report.dto';
import { act, NEW_EVENTS } from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  // ── CSV export ──────────────────────────────

  private csvCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    let s = value instanceof Date ? value.toISOString() : String(value);
    // Neutralise spreadsheet formula injection
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // Builds the CSV for the caller's visible reports. Reporter identity is never exported.
  // REPORT_EXPORT_INCLUDE_DESCRIPTION=true adds the free-text description column.
  private async buildCsv(admin: CurrentUserDto, filters: ReportStatsQueryDto, maxRows: number) {
    const includeDescription =
      this.configService.get<string>('REPORT_EXPORT_INCLUDE_DESCRIPTION') === 'true';
    const where = this.reportCommonService.statsWhere(filters, admin);

    const header = [
      'caseReference',
      'createdAt',
      'status',
      'category',
      'priority',
      'sensitivity',
      'channel',
      'region',
      'location',
      'assignedToId',
      'assignedTeamId',
      'dueAt',
      'closedAt',
      'resolutionOutcome',
      'integrityFlag',
      'isAnonymous',
      ...(includeDescription ? ['description'] : []),
    ];
    const lines: string[] = [header.join(',')];

    let cursor: string | undefined;
    let rowCount = 0;
    let truncated = false;
    while (rowCount < maxRows) {
      const batch = await this.prisma.report.findMany({
        where,
        orderBy: { id: 'asc' },
        take: Math.min(1000, maxRows - rowCount),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!batch.length) break;
      for (const r of batch) {
        lines.push(
          [
            r.caseReference,
            r.createdAt,
            r.status,
            r.category,
            r.priority,
            r.sensitivity,
            r.channel,
            r.region,
            r.location,
            r.assignedToId,
            r.assignedTeamId,
            r.dueAt,
            r.closedAt,
            r.resolutionOutcome,
            r.integrityFlag,
            r.isAnonymous,
            ...(includeDescription ? [r.description] : []),
          ]
            .map((v) => this.csvCell(v))
            .join(','),
        );
      }
      rowCount += batch.length;
      cursor = batch[batch.length - 1].id;
      if (batch.length < 1000) break;
    }
    if (rowCount >= maxRows) {
      truncated = (await this.prisma.report.count({ where })) > rowCount;
    }

    return { csv: lines.join('\r\n') + '\r\n', rowCount, truncated };
  }

  // RPT-11 GET /reports/export   (REPORT_EXPORT, row-capped CSV)
  async exportReports(admin: CurrentUserDto, query: ExportReportsQueryDto) {
    const cap = Number(this.configService.get<string>('REPORT_EXPORT_MAX_ROWS') ?? 5000);
    const { csv, rowCount, truncated } = await this.buildCsv(admin, query, cap);

    this.reportCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: act('REPORT_EXPORTED'),
      entity: 'Report',
      entityId: 'export',
      diff: {
        result: 'success',
        rowCount,
        truncated,
        filters: query as unknown as Record<string, unknown>,
      },
    });

    return {
      csv,
      rowCount,
      truncated,
      filename: `reports-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv; charset=utf-8',
    };
  }

  private async uploadBuffer(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.minioService.uploadFile(key, data, contentType);
  }

  // RPT-133 POST /reports/export-jobs
  async startExportJob(admin: CurrentUserDto, dto: StartExportJobDto) {
    const { format, ...filters } = dto;
    if ((format ?? 'csv') !== 'csv') throw new BadRequestException('xlsx_export_not_available');
    this.reportCommonService.normChannel(filters.channel); // fail fast on a bad filter

    const running = await this.prisma.reportExportJob.count({
      where: { requestedById: admin.id, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (running >= 3) throw new BadRequestException('too_many_export_jobs');

    const job = await this.prisma.reportExportJob.create({
      data: {
        requestedById: admin.id,
        format: 'csv',
        filters: filters as unknown as Prisma.InputJsonValue,
        status: 'QUEUED',
      },
    });

    this.eventEmitter.emit(NEW_EVENTS.EXPORT_JOB_CREATED, {
      jobId: job.id,
      requestedById: admin.id,
    });
    // In-process worker. For multi-instance deployments move this behind your queue.
    setImmediate(() => {
      void this.runExportJob(job.id);
    });
    return job;
  }

  private async runExportJob(jobId: string): Promise<void> {
    const job = await this.prisma.reportExportJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'QUEUED') return;

    await this.prisma.reportExportJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    try {
      // Re-resolve the requester's roles so sensitivity visibility is enforced as them
      const requester = await this.prisma.user.findUnique({
        where: { id: job.requestedById },
        include: { userRoles: { include: { role: true } } },
      });
      if (!requester) throw new Error('requester_not_found');
      const actor = {
        id: requester.id,
        roles: requester.userRoles.map((ur) => ur.role.name),
      } as unknown as CurrentUserDto;

      const maxRows = Number(
        this.configService.get<string>('REPORT_EXPORT_JOB_MAX_ROWS') ?? 100000,
      );
      const { csv, rowCount } = await this.buildCsv(
        actor,
        (job.filters ?? {}) as ReportStatsQueryDto,
        maxRows,
      );

      const storageKey = `exports/reports/${job.id}.csv`;
      await this.uploadBuffer(storageKey, Buffer.from(csv, 'utf8'), 'text/csv');

      const ttlDays = Number(this.configService.get<string>('REPORT_EXPORT_TTL_DAYS') ?? 7);
      await this.prisma.reportExportJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          storageKey,
          rowCount,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + ttlDays * 86400000),
        },
      });
    } catch (err) {
      await this.prisma.reportExportJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          error: this.reportCommonService.errMsg(err).slice(0, 500),
          completedAt: new Date(),
        },
      });
    }
  }

  // Call from a scheduler (e.g. hourly) to delete expired export files
  async expireExportJobs(): Promise<number> {
    const expired = await this.prisma.reportExportJob.findMany({
      where: { status: 'COMPLETED', expiresAt: { lt: new Date() } },
      select: { id: true, storageKey: true },
      take: 200,
    });
    for (const j of expired) {
      if (j.storageKey) await this.reportCommonService.deleteMediaFiles([j.storageKey]);
      await this.prisma.reportExportJob.update({
        where: { id: j.id },
        data: { status: 'EXPIRED', storageKey: null },
      });
    }
    return expired.length;
  }

  // RPT-134 GET /reports/export-jobs   (mine)
  async listExportJobs(admin: CurrentUserDto, query: PageQueryDto) {
    const { page, limit, skip, take } = this.reportCommonService.paging(query);
    const where = { requestedById: admin.id };
    const [items, total] = await Promise.all([
      this.prisma.reportExportJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true,
          format: true,
          filters: true,
          status: true,
          rowCount: true,
          error: true,
          startedAt: true,
          completedAt: true,
          expiresAt: true,
          createdAt: true,
        },
      }),
      this.prisma.reportExportJob.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  // RPT-135 GET /reports/export-jobs/:id
  async getExportJob(admin: CurrentUserDto, jobId: string) {
    const job = await this.prisma.reportExportJob.findFirst({
      where: { id: jobId, requestedById: admin.id },
      select: {
        id: true,
        format: true,
        filters: true,
        status: true,
        rowCount: true,
        error: true,
        startedAt: true,
        completedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    if (!job) throw new NotFoundException('export_job_not_found');
    return job;
  }

  // RPT-136 GET /reports/export-jobs/:id/download   (audited)
  async getExportDownload(admin: CurrentUserDto, jobId: string) {
    const job = await this.prisma.reportExportJob.findFirst({
      where: { id: jobId, requestedById: admin.id },
    });
    if (!job) throw new NotFoundException('export_job_not_found');
    if (job.status !== 'COMPLETED' || !job.storageKey) {
      throw new BadRequestException(`export_not_ready:${job.status}`);
    }
    if (job.expiresAt && job.expiresAt.getTime() < Date.now()) {
      await this.prisma.reportExportJob.update({
        where: { id: jobId },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException('export_expired');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(job.storageKey);
    this.reportCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: act('REPORT_EXPORT_DOWNLOADED'),
      entity: 'ReportExportJob',
      entityId: jobId,
      diff: { result: 'success', rowCount: job.rowCount },
    });
    return { url, expiresAt: job.expiresAt, rowCount: job.rowCount };
  }
}

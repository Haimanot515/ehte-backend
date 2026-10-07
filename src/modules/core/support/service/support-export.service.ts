import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditSeverity, Prisma, SupportExportJobStatus, ActorType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { SupportExportQueryDto } from '../dto/support.dto';
import {
  EXPORT_SYNC_ROW_CAP,
  EXPORT_JOB_ROW_CAP,
  EXPORT_JOB_TTL_HOURS,
  MAX_ACTIVE_EXPORT_JOBS_PER_ADMIN,
} from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportExportService {
  private readonly logger = new Logger(SupportExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supportCommonService: SupportCommonService,
  ) {}

  private csvCell(v: unknown): string {
    if (v === null || v === undefined) return '';
    let s: string;
    if (v instanceof Date) s = v.toISOString();
    else if (Prisma.Decimal.isDecimal(v)) s = (v as Prisma.Decimal).toFixed(2);
    else if (Array.isArray(v)) s = v.join('|');
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    // Stops a spreadsheet from running a cell as a formula.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  private async buildExportCsv(q: SupportExportQueryDto, cap: number) {
    const rows = await this.prisma.support.findMany({
      where: this.supportCommonService.buildStatsWhere(q),
      select: {
        id: true,
        createdAt: true,
        type: true,
        status: true,
        victimProfileId: true,
        userId: true,
        anonymous: true,
        categories: true,
        amount: true,
        recipientAmount: true,
        organizationAmount: true,
        platformAmount: true,
        transferReference: true,
        contactMayBeShared: true,
        victimConfirmedReceiptAt: true,
        completedAt: true,
        victimProfile: { select: { name: true } },
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: cap + 1,
    });

    const truncated = rows.length > cap;
    const slice = truncated ? rows.slice(0, cap) : rows;

    // Contact details are deliberately not exported.
    const header = [
      'id',
      'createdAt',
      'type',
      'status',
      'victimProfileId',
      'victimProfileName',
      'supporterId',
      'supporterName',
      'anonymous',
      'categories',
      'amount',
      'recipientAmount',
      'organizationAmount',
      'platformAmount',
      'transferReference',
      'contactMayBeShared',
      'receiptConfirmedAt',
      'completedAt',
    ];
    const lines = [header.join(',')];
    for (const r of slice) {
      lines.push(
        [
          r.id,
          r.createdAt,
          r.type,
          r.status,
          r.victimProfileId,
          r.victimProfile?.name,
          r.userId,
          r.user?.name,
          r.anonymous,
          r.categories,
          r.amount,
          r.recipientAmount,
          r.organizationAmount,
          r.platformAmount,
          r.transferReference,
          r.contactMayBeShared,
          r.victimConfirmedReceiptAt,
          r.completedAt,
        ]
          .map((v) => this.csvCell(v))
          .join(','),
      );
    }
    return { csv: lines.join('\n') + '\n', rowCount: slice.length, truncated };
  }

  private exportFilename(): string {
    return `support-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  }

  // SP-57. Small, immediate export; use the job route for anything bigger.
  async exportSupportsCsv(admin: CurrentUserDto, query: SupportExportQueryDto) {
    const { csv, rowCount, truncated } = await this.buildExportCsv(query, EXPORT_SYNC_ROW_CAP);

    this.supportCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.supportCommonService.getRoles(admin)),
      action: AuditEventEnum.SUPPORT_EXPORTED,
      severity: AuditSeverity.WARNING,
      entity: 'Support',
      diff: { result: 'success', rowCount, truncated },
      metadata: { filters: JSON.parse(JSON.stringify(query)), mode: 'sync' },
    } as AuditEventPayload);

    return {
      filename: this.exportFilename(),
      contentType: 'text/csv',
      rowCount,
      truncated,
      rowCap: EXPORT_SYNC_ROW_CAP,
      content: csv,
    };
  }

  // SP-58
  async createSupportExportJob(admin: CurrentUserDto, data: SupportExportQueryDto) {
    const active = await this.prisma.supportExportJob.count({
      where: {
        requestedById: admin.id,
        status: { in: [SupportExportJobStatus.QUEUED, SupportExportJobStatus.RUNNING] },
      },
    });
    if (active >= MAX_ACTIVE_EXPORT_JOBS_PER_ADMIN) {
      throw new BadRequestException('too_many_active_export_jobs');
    }

    const filters = JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
    const job = await this.prisma.supportExportJob.create({
      data: { requestedById: admin.id, filters },
      select: { id: true, status: true, createdAt: true },
    });

    this.supportCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.supportCommonService.getRoles(admin)),
      action: AuditEventEnum.SUPPORT_EXPORTED,
      severity: AuditSeverity.WARNING,
      entity: 'SupportExportJob',
      entityId: job.id,
      diff: { result: 'queued' },
      metadata: { filters, mode: 'job' },
    } as AuditEventPayload);

    setImmediate(() => {
      void this.runSupportExportJob(job.id);
    });
    return job;
  }

  private async runSupportExportJob(jobId: string): Promise<void> {
    const claimed = await this.prisma.supportExportJob.updateMany({
      where: { id: jobId, status: SupportExportJobStatus.QUEUED },
      data: { status: SupportExportJobStatus.RUNNING, startedAt: new Date() },
    });
    if (claimed.count === 0) return;

    try {
      const job = await this.prisma.supportExportJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { filters: true },
      });
      const { csv, rowCount } = await this.buildExportCsv(
        (job.filters ?? {}) as unknown as SupportExportQueryDto,
        EXPORT_JOB_ROW_CAP,
      );
      await this.prisma.supportExportJob.update({
        where: { id: jobId },
        data: {
          status: SupportExportJobStatus.COMPLETED,
          csv,
          rowCount,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + EXPORT_JOB_TTL_HOURS * 3_600_000),
        },
        select: { id: true },
      });
    } catch (error) {
      this.logger.error(
        `Support export job ${jobId} failed`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.prisma.supportExportJob.update({
        where: { id: jobId },
        data: {
          status: SupportExportJobStatus.FAILED,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          completedAt: new Date(),
        },
        select: { id: true },
      });
    }
  }

  // Picks up jobs the in-process runner missed (restart), stops stuck ones, and clears old files.
  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweepSupportExportJobs(): Promise<void> {
    try {
      const now = Date.now();

      const queued = await this.prisma.supportExportJob.findMany({
        where: {
          status: SupportExportJobStatus.QUEUED,
          createdAt: { lt: new Date(now - 2 * 60_000) },
        },
        select: { id: true },
        take: 5,
      });
      for (const job of queued) await this.runSupportExportJob(job.id);

      await this.prisma.supportExportJob.updateMany({
        where: {
          status: SupportExportJobStatus.RUNNING,
          startedAt: { lt: new Date(now - 30 * 60_000) },
        },
        data: {
          status: SupportExportJobStatus.FAILED,
          error: 'export_timed_out',
          completedAt: new Date(),
        },
      });

      const expired = await this.prisma.supportExportJob.updateMany({
        where: { status: SupportExportJobStatus.COMPLETED, expiresAt: { lt: new Date(now) } },
        data: { status: SupportExportJobStatus.EXPIRED, csv: null },
      });
      if (expired.count > 0) {
        this.supportCommonService.emitAudit({
          actorType: ActorType.SYSTEM,
          action: AuditEventEnum.SUPPORT_EXPORT_EXPIRED,
          entity: 'SupportExportJob',
          metadata: { expiredJobs: expired.count },
        });
      }
    } catch (error) {
      this.logger.error(
        'Support export sweep failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async findExportJobFor(id: string, admin: CurrentUserDto) {
    const job = await this.prisma.supportExportJob.findUnique({
      where: { id },
      select: {
        id: true,
        requestedById: true,
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
    const isSuper = this.supportCommonService.getRoles(admin).includes(RolesEnum.SUPER_ADMIN);
    if (job.requestedById !== admin.id && !isSuper) {
      throw new ForbiddenException('not_allowed_to_view_export_job');
    }
    return job;
  }

  // SP-59
  async getSupportExportJob(id: string, admin: CurrentUserDto) {
    const { requestedById, ...job } = await this.findExportJobFor(id, admin);
    void requestedById;
    return job;
  }

  // SP-60. Returns the CSV itself; it is available until expiresAt and every download is audited.
  async getSupportExportJobDownload(id: string, admin: CurrentUserDto) {
    const job = await this.findExportJobFor(id, admin);
    if (job.status !== SupportExportJobStatus.COMPLETED) {
      throw new BadRequestException(
        job.status === SupportExportJobStatus.EXPIRED ? 'export_expired' : 'export_not_ready',
      );
    }
    if (job.expiresAt && job.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('export_expired');
    }

    const file = await this.prisma.supportExportJob.findUniqueOrThrow({
      where: { id },
      select: { csv: true },
    });
    if (!file.csv) throw new BadRequestException('export_expired');

    this.supportCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.supportCommonService.getRoles(admin)),
      action: AuditEventEnum.SUPPORT_EXPORT_DOWNLOADED,
      severity: AuditSeverity.WARNING,
      entity: 'SupportExportJob',
      entityId: id,
      diff: { result: 'success', rowCount: job.rowCount },
    } as AuditEventPayload);

    return {
      filename: this.exportFilename(),
      contentType: 'text/csv',
      rowCount: job.rowCount,
      expiresAt: job.expiresAt,
      content: file.csv,
    };
  }
}

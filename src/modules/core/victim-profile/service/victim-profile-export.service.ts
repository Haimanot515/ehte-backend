import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { AuditSeverity, Prisma, VictimProfileExportJobStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { ExportQueryDto, StatsQueryDto } from '../dto/victim-profile.dto';
import { money, csvCell, EXPORT_COLUMNS } from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  // Never exports story, description, bank or consent data; child profiles are exported by label only.
  private async buildExportRows(
    query: StatsQueryDto,
    maxRows: number,
  ): Promise<{ lines: string[]; rowCount: number; truncated: boolean }> {
    const where = this.victimProfileCommonService.statsWhere(query);
    const lines: string[] = [EXPORT_COLUMNS.map(csvCell).join(',')];
    const batch = 1000;
    let rowCount = 0;
    let truncated = false;
    let cursor: string | undefined;

    while (rowCount < maxRows) {
      const rows = await this.prisma.victimProfile.findMany({
        where,
        select: {
          id: true,
          name: true,
          status: true,
          supportGoal: true,
          totalRaised: true,
          involvesChild: true,
          isPublished: true,
          donationsPaused: true,
          assignedReviewerId: true,
          claimedByUserId: true,
          createdByUserId: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { id: 'asc' },
        take: Math.min(batch, maxRows - rowCount + 1),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) break;

      for (const r of rows) {
        if (rowCount >= maxRows) {
          truncated = true;
          break;
        }
        lines.push(
          [
            r.id,
            this.victimProfileCommonService.profileLabel(r),
            r.status,
            r.supportGoal ? money(r.supportGoal) : '',
            money(r.totalRaised),
            r.involvesChild,
            r.isPublished,
            r.donationsPaused,
            r.assignedReviewerId,
            r.claimedByUserId,
            r.createdByUserId,
            r.createdAt,
            r.updatedAt,
          ]
            .map(csvCell)
            .join(','),
        );
        rowCount += 1;
      }
      if (truncated) break;
      cursor = rows[rows.length - 1].id;
    }

    return { lines, rowCount, truncated };
  }

  // VP-87
  async exportCsv(admin: CurrentUserDto, query: ExportQueryDto) {
    const maxRows = Number(this.configService.get<string>('PROFILE_EXPORT_MAX_ROWS') ?? 5000);
    const { lines, rowCount, truncated } = await this.buildExportRows(query, maxRows);

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_EXPORTED,
      severity: AuditSeverity.WARNING,
      entity: 'VictimProfile',
      diff: { result: 'success', mode: 'inline' },
      metadata: { filters: query as unknown as Record<string, unknown>, rowCount, truncated },
    });

    return {
      filename: `victim-profiles-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      rowCount,
      truncated,
      csv: lines.join('\n'),
    };
  }

  // VP-88
  async createExportJob(admin: CurrentUserDto, data: ExportQueryDto) {
    const job = await this.prisma.victimProfileExportJob.create({
      data: {
        requestedById: admin.id,
        filters: data as unknown as Prisma.InputJsonValue,
      },
    });

    // In-process on purpose (no queue in this codebase yet). On a multi-instance deployment move this
    // call into your job runner; runExportJob() is idempotent on QUEUED -> RUNNING.
    setImmediate(() => {
      this.runExportJob(job.id).catch(() => undefined);
    });

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_EXPORTED,
      severity: AuditSeverity.WARNING,
      entity: 'VictimProfileExportJob',
      entityId: job.id,
      diff: { result: 'success', mode: 'job_requested' },
      metadata: { filters: data as unknown as Record<string, unknown> },
    });

    return { id: job.id, status: job.status, createdAt: job.createdAt };
  }

  private async runExportJob(jobId: string): Promise<void> {
    const started = await this.prisma.victimProfileExportJob.updateMany({
      where: { id: jobId, status: VictimProfileExportJobStatus.QUEUED },
      data: { status: VictimProfileExportJobStatus.RUNNING, startedAt: new Date() },
    });
    if (started.count === 0) return;

    const job = await this.prisma.victimProfileExportJob.findUniqueOrThrow({
      where: { id: jobId },
    });

    try {
      const maxRows = Number(
        this.configService.get<string>('PROFILE_EXPORT_JOB_MAX_ROWS') ?? 100_000,
      );
      const ttlHours = Number(this.configService.get<string>('PROFILE_EXPORT_TTL_HOURS') ?? 24);
      const filters = (job.filters ?? {}) as unknown as StatsQueryDto;

      const { lines, rowCount, truncated } = await this.buildExportRows(filters, maxRows);

      const storageKey = `exports/victim-profiles/${jobId}.csv`;
      // Adapt to your MinioService upload method (key, bytes, content type).
      await this.minioService.uploadFile(
        storageKey,
        Buffer.from(lines.join('\n'), 'utf8'),
        'text/csv',
      );

      await this.prisma.victimProfileExportJob.update({
        where: { id: jobId },
        data: {
          status: VictimProfileExportJobStatus.COMPLETED,
          storageKey,
          rowCount,
          truncated,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
        },
      });

      this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_EXPORT_READY, {
        userId: job.requestedById,
        exportJobId: jobId,
      });
    } catch (err) {
      await this.prisma.victimProfileExportJob.update({
        where: { id: jobId },
        data: {
          status: VictimProfileExportJobStatus.FAILED,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          completedAt: new Date(),
        },
      });
    }
  }

  // Only the requester (or a super admin) can see a job; everyone else gets a 404.
  private async getOwnedExportJob(admin: CurrentUserDto, id: string) {
    const job = await this.prisma.victimProfileExportJob.findUnique({ where: { id } });
    const isSuper = this.victimProfileCommonService.getRoles(admin).includes(RolesEnum.SUPER_ADMIN);
    if (!job || (job.requestedById !== admin.id && !isSuper)) {
      throw new NotFoundException('export_job_not_found');
    }
    return job;
  }

  // VP-89
  async getExportJob(admin: CurrentUserDto, id: string) {
    const job = await this.getOwnedExportJob(admin, id);
    const expired =
      job.status === VictimProfileExportJobStatus.COMPLETED &&
      !!job.expiresAt &&
      job.expiresAt < new Date();
    return {
      id: job.id,
      status: expired ? VictimProfileExportJobStatus.EXPIRED : job.status,
      rowCount: job.rowCount,
      truncated: job.truncated,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      expiresAt: job.expiresAt,
    };
  }

  // VP-90
  async getExportJobDownload(admin: CurrentUserDto, id: string) {
    const job = await this.getOwnedExportJob(admin, id);

    if (job.status !== VictimProfileExportJobStatus.COMPLETED || !job.storageKey) {
      throw new BadRequestException('export_job_not_ready');
    }
    if (job.expiresAt && job.expiresAt < new Date()) {
      await this.prisma.victimProfileExportJob.update({
        where: { id },
        data: { status: VictimProfileExportJobStatus.EXPIRED },
      });
      await this.minioService.deleteFile(job.storageKey).catch(() => undefined);
      throw new BadRequestException('export_job_expired');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(job.storageKey);

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_EXPORT_DOWNLOADED,
      severity: AuditSeverity.WARNING,
      entity: 'VictimProfileExportJob',
      entityId: id,
      diff: { result: 'success' },
      metadata: { rowCount: job.rowCount },
    });

    return { url, expiresAt: job.expiresAt };
  }
}
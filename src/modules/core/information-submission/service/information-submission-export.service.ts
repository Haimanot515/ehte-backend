import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditSeverity, Prisma, ActorType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { AdminInformationExportDto } from '../dto/information-submission.dto';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

  private exportMaxRows(): number {
    return Number(this.configService.get<string>('INFORMATION_SUBMISSION_EXPORT_MAX_ROWS') ?? 5000);
  }

  private csvCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    let s = value instanceof Date ? value.toISOString() : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  private exportWhere(filters: AdminInformationExportDto): Prisma.InformationSubmissionWhereInput {
    return {
      deletedAt: null,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.missingPersonId ? { missingPersonId: filters.missingPersonId } : {}),
      ...(filters.assignedTo ? { assignedToId: filters.assignedTo } : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
    };
  }

  private async buildExportCsv(
    filters: AdminInformationExportDto,
  ): Promise<{ csv: string; rowCount: number; truncated: boolean }> {
    const maxRows = this.exportMaxRows();
    const where = this.exportWhere(filters);

    const header = [
      'id',
      'createdAt',
      'status',
      'priority',
      'credibility',
      'resolution',
      'channel',
      'missingPersonId',
      'missingPersonName',
      'location',
      'information',
      'reviewNote',
      'assignedToId',
      'attachmentCount',
      'mediaTotalBytes',
    ];
    const lines: string[] = [header.join(',')];

    let cursor: string | undefined;
    let rowCount = 0;
    let truncated = false;

    while (rowCount < maxRows) {
      const batch = await this.prisma.informationSubmission.findMany({
        where,
        orderBy: { id: 'asc' },
        take: Math.min(500, maxRows - rowCount + 1),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { missingPerson: { select: { name: true } } },
      });
      if (!batch.length) break;

      for (const s of batch) {
        if (rowCount >= maxRows) {
          truncated = true;
          break;
        }
        lines.push(
          [
            s.id,
            s.createdAt,
            s.status,
            s.priority,
            s.credibility,
            s.resolution,
            s.channel,
            s.missingPersonId,
            s.missingPerson?.name,
            s.location,
            s.information,
            s.reviewNote,
            s.assignedToId,
            this.informationSubmissionCommonService.collectMediaFields(s).length,
            s.mediaTotalBytes,
          ]
            .map((v) => this.csvCell(v))
            .join(','),
        );
        rowCount++;
      }
      if (truncated) break;
      cursor = batch[batch.length - 1].id;
      if (batch.length < 500) break;
    }

    return { csv: lines.join('\r\n'), rowCount, truncated };
  }

  private async recordExport(
    admin: CurrentUserDto,
    filters: AdminInformationExportDto,
    rowCount: number,
    truncated: boolean,
    via: 'sync' | 'job',
    jobId?: string,
  ) {
    await this.prisma.auditExport.create({
      data: {
        exportedById: admin.id,
        filter: { entity: 'InformationSubmission', ...filters } as Prisma.InputJsonValue,
        rowCount,
        truncated,
      },
    });

    this.informationSubmissionCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.informationSubmissionCommonService.getRoles(admin)),
      action: AuditEventEnum.INFORMATION_SUBMISSION_EXPORTED,
      severity: AuditSeverity.WARNING,
      entity: 'InformationSubmission',
      diff: { result: 'success' },
      metadata: { rowCount, truncated, via, jobId, filters },
    });
  }

  async exportCsv(admin: CurrentUserDto, query: AdminInformationExportDto) {
    const { csv, rowCount, truncated } = await this.buildExportCsv(query);
    await this.recordExport(admin, query, rowCount, truncated, 'sync');

    return {
      filename: `information-submissions-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      rowCount,
      truncated,
      csv,
    };
  }

  private async storeExportFile(key: string, body: Buffer): Promise<void> {
    await this.minioService.uploadFile(key, body, 'text/csv; charset=utf-8');
  }

  async startExportJob(admin: CurrentUserDto, data: AdminInformationExportDto) {
    const active = await this.prisma.informationExportJob.count({
      where: {
        requestedById: admin.id,
        status: { in: ['QUEUED', 'RUNNING'] },
        createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) },
      },
    });
    if (active > 0) {
      throw new ConflictException('export_already_running');
    }

    const job = await this.prisma.informationExportJob.create({
      data: {
        requestedById: admin.id,
        filters: { ...data } as Prisma.InputJsonValue,
      },
    });

    void this.runExportJob(job.id, admin).catch(() => undefined);

    return { id: job.id, status: job.status, createdAt: job.createdAt };
  }

  async runExportJob(jobId: string, admin: CurrentUserDto): Promise<void> {
    const job = await this.prisma.informationExportJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'QUEUED') return;

    await this.prisma.informationExportJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    try {
      const filters = (job.filters ?? {}) as unknown as AdminInformationExportDto;
      const { csv, rowCount, truncated } = await this.buildExportCsv(filters);

      const key = `exports/information-submissions/${jobId}.csv`;
      await this.storeExportFile(key, Buffer.from(csv, 'utf8'));

      const ttlHours = Number(
        this.configService.get<string>('INFORMATION_SUBMISSION_EXPORT_TTL_HOURS') ?? 24,
      );

      await this.prisma.informationExportJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          storageKey: key,
          rowCount,
          truncated,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
        },
      });

      await this.recordExport(admin, filters, rowCount, truncated, 'job', jobId);
    } catch (err) {
      await this.prisma.informationExportJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          error: err instanceof Error ? err.message.slice(0, 500) : 'export_failed',
          completedAt: new Date(),
        },
      });
    }
  }

  private async findExportJobFor(admin: CurrentUserDto, id: string) {
    const job = await this.prisma.informationExportJob.findUnique({ where: { id } });
    if (
      !job ||
      (job.requestedById !== admin.id &&
        !this.informationSubmissionCommonService.isSuperAdmin(admin))
    ) {
      throw new NotFoundException('export_job_not_found');
    }
    return job;
  }

  async getExportJob(admin: CurrentUserDto, id: string) {
    let job = await this.findExportJobFor(admin, id);

    const stuck =
      job.status === 'RUNNING' &&
      job.startedAt &&
      Date.now() - job.startedAt.getTime() > 30 * 60 * 1000;
    const expired = job.status === 'COMPLETED' && job.expiresAt && job.expiresAt < new Date();

    if (stuck || expired) {
      job = await this.prisma.informationExportJob.update({
        where: { id },
        data: stuck
          ? { status: 'FAILED', error: 'export_timed_out', completedAt: new Date() }
          : { status: 'EXPIRED' },
      });
      if (expired && job.storageKey) {
        await this.informationSubmissionCommonService.deleteMediaFiles([job.storageKey]);
      }
      if (expired) {
        this.informationSubmissionCommonService.emitAudit({
          actorType: ActorType.SYSTEM,
          action: AuditEventEnum.INFORMATION_SUBMISSION_EXPORT_EXPIRED,
          entity: 'InformationExportJob',
          entityId: id,
        });
      }
    }

    return {
      id: job.id,
      status: job.status,
      rowCount: job.rowCount,
      truncated: job.truncated,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      expiresAt: job.expiresAt,
    };
  }

  async getExportJobDownloadUrl(admin: CurrentUserDto, id: string) {
    const job = await this.findExportJobFor(admin, id);

    if (job.status !== 'COMPLETED' || !job.storageKey) {
      throw new BadRequestException('export_not_ready');
    }
    if (job.expiresAt && job.expiresAt < new Date()) {
      throw new BadRequestException('export_expired');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(job.storageKey);

    this.informationSubmissionCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.informationSubmissionCommonService.getRoles(admin)),
      action: AuditEventEnum.INFORMATION_SUBMISSION_EXPORT_DOWNLOADED,
      severity: AuditSeverity.WARNING,
      entity: 'InformationSubmission',
      diff: { result: 'success' },
      metadata: { jobId: id, rowCount: job.rowCount },
    });

    return { url, expiresAt: job.expiresAt };
  }
}

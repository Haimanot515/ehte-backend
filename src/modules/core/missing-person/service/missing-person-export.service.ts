import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditSeverity, MissingPersonExportStatus, Prisma, ActorType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AdminMissingPersonExportDto } from '../dto/missing-person.dto';
import { ADMIN_BASE_WHERE } from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

    private exportWhere(query: AdminMissingPersonExportDto): Prisma.MissingPersonWhereInput {
    return {
      ...ADMIN_BASE_WHERE,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.personType !== undefined ? { personType: query.personType } : {}),
      ...(query.area ? { lastKnownArea: { contains: query.area, mode: 'insensitive' } } : {}),
      ...(query.assignedTo ? { assignedToUserId: query.assignedTo } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
  }

  // Cells starting with = + - @ are prefixed so spreadsheets never run them as formulas.
  private csvCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    let text = value instanceof Date ? value.toISOString() : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  // CHILD names are replaced with the same redacted label the audit log uses.
  private async buildExportCsv(query: AdminMissingPersonExportDto) {
    const maxRows = Number(
      this.configService.get<string>('MISSING_PERSON_EXPORT_MAX_ROWS') ?? 5000,
    );

    const rows = await this.prisma.missingPerson.findMany({
      where: this.exportWhere(query),
      orderBy: { createdAt: 'desc' },
      take: maxRows + 1,
    });
    const truncated = rows.length > maxRows;
    const slice = truncated ? rows.slice(0, maxRows) : rows;

    const header = [
      'id',
      'status',
      'personType',
      'name',
      'lastKnownArea',
      'dateLastSeen',
      'createdAt',
      'updatedAt',
      'assignedToUserId',
      'claimedByUserId',
      'gender',
      'ageGroup',
      'rewardOffered',
      'rewardApproved',
      'rewardAmount',
      'fundingStatus',
    ];

    const lines = [header.join(',')];
    for (const r of slice) {
      lines.push(
        [
          r.id,
          r.status,
          r.personType,
          this.missingPersonCommonService.caseLabel(r) ?? '',
          r.lastKnownArea,
          r.dateLastSeen,
          r.createdAt,
          r.updatedAt,
          r.assignedToUserId,
          r.claimedByUserId,
          r.gender,
          r.ageGroup,
          r.rewardOffered,
          r.rewardApproved,
          r.rewardAmount,
          r.fundingStatus,
        ]
          .map((v) => this.csvCell(v))
          .join(','),
      );
    }

    return { csv: lines.join('\n'), rowCount: slice.length, truncated };
  }

  async exportCsv(admin: CurrentUserDto, query: AdminMissingPersonExportDto) {
    const built = await this.buildExportCsv(query);

    this.missingPersonCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      severity: AuditSeverity.WARNING,
      entity: 'MissingPersonExport',
      entityId: `csv-${Date.now()}`,
      diff: { result: 'success', rowCount: built.rowCount, truncated: built.truncated },
      metadata: { operation: 'export_csv', filter: { ...query } },
    });

    return {
      filename: `missing-persons-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv',
      rowCount: built.rowCount,
      truncated: built.truncated,
      csv: built.csv,
    };
  }

  async startExportJob(admin: CurrentUserDto, data: AdminMissingPersonExportDto) {
    const ttlHours = Number(
      this.configService.get<string>('MISSING_PERSON_EXPORT_TTL_HOURS') ?? 24,
    );
    const job = await this.prisma.missingPersonExportJob.create({
      data: {
        requestedById: admin.id,
        filter: { ...data } as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
      },
    });

    this.missingPersonCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      severity: AuditSeverity.WARNING,
      entity: 'MissingPersonExportJob',
      entityId: job.id,
      diff: { result: 'success', jobId: job.id },
      metadata: { operation: 'export_job_started', filter: { ...data } },
    });

    // Runs after the response is sent, so the request returns immediately.
    setImmediate(() => {
      void this.runExportJob(job.id, data);
    });

    return { id: job.id, status: job.status, expiresAt: job.expiresAt };
  }

  private async runExportJob(jobId: string, filter: AdminMissingPersonExportDto): Promise<void> {
    try {
      await this.prisma.missingPersonExportJob.update({
        where: { id: jobId },
        data: { status: MissingPersonExportStatus.RUNNING },
      });
      const built = await this.buildExportCsv(filter);
      await this.prisma.missingPersonExportJob.update({
        where: { id: jobId },
        data: {
          status: MissingPersonExportStatus.COMPLETED,
          content: built.csv,
          rowCount: built.rowCount,
          truncated: built.truncated,
          completedAt: new Date(),
        },
      });
    } catch (err) {
      await this.prisma.missingPersonExportJob
        .update({
          where: { id: jobId },
          data: {
            status: MissingPersonExportStatus.FAILED,
            error: err instanceof Error ? err.message.slice(0, 500) : 'export_failed',
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
    }
  }

  private async loadExportJob(admin: CurrentUserDto, id: string) {
    const job = await this.prisma.missingPersonExportJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('export_job_not_found');

    const roles = (admin.roles ?? []) as unknown as string[];
    const isSuper = roles.includes(String(RolesEnum.SUPER_ADMIN));
    if (job.requestedById !== admin.id && !isSuper)
      throw new NotFoundException('export_job_not_found');

    if (job.expiresAt < new Date()) {
      if (job.content) {
        await this.prisma.missingPersonExportJob.update({ where: { id }, data: { content: null } });
        this.missingPersonCommonService.emitAudit({
          actorType: ActorType.SYSTEM,
          action: AuditEventEnum.MISSING_PERSON_EXPORT_EXPIRED,
          entity: 'MissingPersonExportJob',
          entityId: id,
        });
      }
      throw new NotFoundException('export_job_expired');
    }
    return job;
  }

  async getExportJob(admin: CurrentUserDto, id: string) {
    const job = await this.loadExportJob(admin, id);
    return {
      id: job.id,
      status: job.status,
      rowCount: job.rowCount,
      truncated: job.truncated,
      error: job.error,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      expiresAt: job.expiresAt,
    };
  }

  // The CSV lives in the job row, so the download is returned inline rather than as a storage link.
  async getExportJobDownloadUrl(admin: CurrentUserDto, id: string) {
    const job = await this.loadExportJob(admin, id);
    if (job.status !== MissingPersonExportStatus.COMPLETED || !job.content) {
      throw new BadRequestException('export_job_not_ready');
    }

    this.missingPersonCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED,
      severity: AuditSeverity.WARNING,
      entity: 'MissingPersonExportJob',
      entityId: id,
      diff: { result: 'success', jobId: id, rowCount: job.rowCount },
      metadata: { operation: 'export_job_download' },
    });

    return {
      filename: `missing-persons-${job.createdAt.toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv',
      rowCount: job.rowCount,
      truncated: job.truncated,
      csv: job.content,
    };
  }
}

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditSeverity } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { UserExportQueryDto } from '../dto/user.dto';
import { UserCommonService } from './user-common.service';
import {
  EXPORT_ROW_CAP,
  EXPORT_JOB_ROW_CAP,
  EXPORT_JOB_TTL_MS,
  LIST_USER_SELECT,
} from './user.constants';

@Injectable()
export class UserExportService {
  private readonly logger = new Logger(UserExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly userCommonService: UserCommonService,
  ) {}

  private csvCell(value: unknown): string {
    let text = value instanceof Date ? value.toISOString() : value == null ? '' : String(value);
    // Stop spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  private async buildUsersCsv(actor: CurrentUserDto, query: UserExportQueryDto, cap: number) {
    const rows = await this.prisma.user.findMany({
      where: this.userCommonService.searchWhere(query.search, query),
      select: LIST_USER_SELECT,
      orderBy: { createdAt: 'desc' },
      take: cap + 1,
    });
    const truncated = rows.length > cap;
    const lines = [['id', 'name', 'phone', 'email', 'isActive', 'roles', 'createdAt'].join(',')];
    for (const row of rows.slice(0, cap)) {
      const u = this.userCommonService.shapeListed(actor, row) as any;
      lines.push(
        [
          u.id,
          u.name,
          u.phone,
          u.email,
          u.isActive,
          u.roles.map((r: { name: string }) => r.name).join('|'),
          u.createdAt,
        ]
          .map((v) => this.csvCell(v))
          .join(','),
      );
    }
    return { csv: lines.join('\n'), rowCount: lines.length - 1, truncated };
  }

  async exportUsersCsv(actor: CurrentUserDto, query: UserExportQueryDto) {
    const { csv, rowCount, truncated } = await this.buildUsersCsv(actor, query, EXPORT_ROW_CAP);
    this.userCommonService.auditUser(actor, actor.id, AuditEventEnum.USER_UPDATED, 'users_exported', {
      severity: AuditSeverity.WARNING,
      diff: { rowCount, truncated, masked: !this.userCommonService.canSeePii(actor), filters: query },
    });
    return {
      filename: `users-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv',
      rowCount,
      truncated,
      csv,
    };
  }

  async createUserExportJob(actor: CurrentUserDto, data: UserExportQueryDto) {
    const job = await this.userCommonService.db.userExportJob.create({
      data: {
        requestedById: actor.id,
        filters: JSON.parse(JSON.stringify(data)),
        status: 'QUEUED',
        expiresAt: new Date(Date.now() + EXPORT_JOB_TTL_MS),
      },
    });
    setImmediate(() => void this.runExportJob(job.id, actor, data));

    this.userCommonService.auditUser(actor, actor.id, AuditEventEnum.USER_UPDATED, 'export_job_created', {
      diff: { jobId: job.id, filters: data },
    });
    return { id: job.id, status: 'QUEUED' };
  }

  private async runExportJob(jobId: string, actor: CurrentUserDto, data: UserExportQueryDto) {
    try {
      await this.userCommonService.db.userExportJob.update({ where: { id: jobId }, data: { status: 'RUNNING' } });
      const { csv, rowCount, truncated } = await this.buildUsersCsv(
        actor,
        data,
        EXPORT_JOB_ROW_CAP,
      );
      await this.userCommonService.db.userExportJob.update({
        where: { id: jobId },
        data: { status: 'DONE', resultCsv: csv, rowCount, truncated, finishedAt: new Date() },
      });
    } catch (err) {
      this.logger.error(`export job ${jobId} failed: ${err instanceof Error ? err.message : err}`);
      await this.userCommonService.db.userExportJob
        .update({
          where: { id: jobId },
          data: { status: 'FAILED', error: 'export_failed', finishedAt: new Date() },
        })
        .catch(() => undefined);
    }
  }

  async getUserExportJob(actor: CurrentUserDto, id: string) {
    const job = await this.userCommonService.db.userExportJob.findFirst({
      where: { id, requestedById: actor.id },
      select: {
        id: true,
        status: true,
        rowCount: true,
        truncated: true,
        error: true,
        createdAt: true,
        finishedAt: true,
        expiresAt: true,
      },
    });
    if (!job) throw new NotFoundException('export_job_not_found');
    return job;
  }

  async getUserExportJobDownload(actor: CurrentUserDto, id: string) {
    const job = await this.userCommonService.db.userExportJob.findFirst({ where: { id, requestedById: actor.id } });
    if (!job) throw new NotFoundException('export_job_not_found');
    if (job.status !== 'DONE') throw new BadRequestException('export_not_ready');
    if (job.expiresAt && job.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('export_expired');
    }

    this.userCommonService.auditUser(actor, actor.id, AuditEventEnum.USER_UPDATED, 'export_job_downloaded', {
      severity: AuditSeverity.WARNING,
      diff: { jobId: id, rowCount: job.rowCount },
    });
    return {
      filename: `users-${id}.csv`,
      contentType: 'text/csv',
      rowCount: job.rowCount,
      truncated: !!job.truncated,
      expiresAt: job.expiresAt,
      csv: job.resultCsv,
    };
  }
}

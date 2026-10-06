import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuditOutcome, AuditSeverity, Prisma, ReportStatus } from '@prisma/client';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import {
  CreateReportDto,
  UpdateReportDto,
  PageQueryDto,
  SyncReportsDto,
  SaveReportDraftDto,
} from '../dto/report.dto';
import {
  TERMINAL_STATUSES,
  CASE_REFERENCE_MAX_ATTEMPTS,
  MEDIA_FIELD_NAMES,
  MediaBearing,
  MediaBearingDto,
} from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  // Diffs each media field individually; an omitted field means "leave alone"
  private diffMediaFields(
    before: MediaBearing,
    incoming: MediaBearingDto,
  ): { added: string[]; removed: string[] } {
    const added: string[] = [];
    const removed: string[] = [];

    for (const field of MEDIA_FIELD_NAMES) {
      const next = incoming[field];
      if (next === undefined) continue;
      const prev = before[field];
      added.push(...next.filter((fp) => !prev.includes(fp)));
      removed.push(...prev.filter((fp) => !next.includes(fp)));
    }

    return { added, removed };
  }

  // Stamps ownerSuspendedAt for admin filtering; never changes status
  @OnEvent('user.suspended')
  async handleUserSuspended(payload: { userId: string }): Promise<void> {
    const now = new Date();

    await this.prisma.report.updateMany({
      where: {
        userId: payload.userId,
        status: { notIn: TERMINAL_STATUSES },
        ownerSuspendedAt: null,
      },
      data: { ownerSuspendedAt: now },
    });

    const suspendedUser = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      select: { name: true },
    });

    this.reportCommonService.emitAudit({
      targetUserId: payload.userId,
      actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
      action: AuditEventEnum.REPORT_UPDATED,
      entity: 'User',
      entityId: payload.userId,
      entityLabel: suspendedUser?.name ?? undefined,
      diff: { reason: 'owner_account_suspended', result: 'success' },
    });
  }

  private async enforceCreateRateLimit(userId: string): Promise<void> {
    const cooldownSeconds = Number(
      this.configService.get<string>('REPORT_CREATE_RATE_LIMIT_WINDOW_SECONDS') ??
        this.configService.get<string>('CONTENT_CREATE_RATE_LIMIT_WINDOW_SECONDS') ??
        60,
    );

    const lastReport = await this.prisma.report.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (lastReport && Date.now() - lastReport.createdAt.getTime() < cooldownSeconds * 1000) {
      throw new BadRequestException('report_creation_rate_limited');
    }
  }

  private async enforceMaxPendingReports(userId: string): Promise<void> {
    const maxPending = Number(
      this.configService.get<string>('REPORT_MAX_PENDING_PER_USER') ??
        this.configService.get<string>('CONTENT_MAX_PENDING_PER_USER') ??
        5,
    );

    const pendingCount = await this.prisma.report.count({
      where: { userId, status: ReportStatus.PENDING },
    });

    if (pendingCount >= maxPending) {
      throw new BadRequestException('too_many_pending_reports');
    }
  }

  async create(user: CurrentUserDto, data: CreateReportDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.report.findFirst({
        where: { userId: user.id, idempotencyKey },
      });
      if (existing) {
        return existing;
      }
    }

    await this.enforceCreateRateLimit(user.id);
    await this.enforceMaxPendingReports(user.id);

    const merged: MediaBearing = {
      photo: data.photo ?? [],
      video: data.video ?? [],
      audio: data.audio ?? [],
      pdf: data.pdf ?? [],
      document: data.document ?? [],
      other: data.other ?? [],
    };
    this.reportCommonService.assertAttachmentCounts(merged);

    const validated = await this.reportCommonService.validateMediaFilesExist(
      this.reportCommonService.collectMediaFields(merged),
    );
    const totalBytes = validated.reduce((sum, v) => sum + v.size, 0);
    this.reportCommonService.assertTotalBytes(totalBytes);

    const report = await this.createReportWithUniqueCaseReference(
      user,
      data,
      merged,
      totalBytes,
      idempotencyKey,
    );

    this.reportCommonService.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(user)),
      action: AuditEventEnum.REPORT_CREATED,
      entity: 'Report',
      entityId: report.id,
      entityLabel: report.caseReference,
      diff: { result: 'success', status: report.status },
      metadata: {
        category: report.category,
        attachmentCount: this.reportCommonService.collectMediaFields(merged).length,
        mediaTotalBytes: totalBytes,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_RECEIVED, {
      reportId: report.id,
      userId: user.id,
      caseReference: report.caseReference,
    });

    this.eventEmitter.emit(NotificationEventEnum.NEW_REPORT, {
      reportId: report.id,
      caseReference: report.caseReference,
      userId: user.id,
    });

    return report;
  }

  async findMyReports(user: CurrentUserDto) {
    return this.prisma.report.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(user: CurrentUserDto, reportId: string) {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    return report;
  }

  async update(user: CurrentUserDto, reportId: string, data: UpdateReportDto) {
    const existing = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    if (existing.status !== ReportStatus.PENDING) {
      this.reportCommonService.emitAudit({
        userId: user.id,
        actorType: resolveActorType(this.reportCommonService.getRoles(user)),
        action: AuditEventEnum.REPORT_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: {
          result: 'failure',
          reason: 'only_pending_reports_can_be_updated',
          currentStatus: existing.status,
        },
      });
      throw new BadRequestException('only_pending_reports_can_be_updated');
    }

    const { added, removed } = this.diffMediaFields(existing, data);

    const merged: MediaBearing = {
      photo: data.photo ?? existing.photo,
      video: data.video ?? existing.video,
      audio: data.audio ?? existing.audio,
      pdf: data.pdf ?? existing.pdf,
      document: data.document ?? existing.document,
      other: data.other ?? existing.other,
    };

    let addedBytes = 0;
    let removedBytes = 0;
    let newTotalBytes = existing.mediaTotalBytes;

    try {
      this.reportCommonService.assertAttachmentCounts(merged);

      const validatedAdded = await this.reportCommonService.validateMediaFilesExist(added);
      addedBytes = validatedAdded.reduce((sum, v) => sum + v.size, 0);

      const removedStats = await Promise.allSettled(
        removed.map((fp) => this.minioService.statObject(fp)),
      );
      removedBytes = removedStats.reduce(
        (sum, r) => sum + (r.status === 'fulfilled' ? r.value.size : 0),
        0,
      );

      newTotalBytes = Math.max(0, existing.mediaTotalBytes + addedBytes - removedBytes);
      this.reportCommonService.assertTotalBytes(newTotalBytes);
    } catch (err) {
      this.reportCommonService.emitAudit({
        userId: user.id,
        actorType: resolveActorType(this.reportCommonService.getRoles(user)),
        action: AuditEventEnum.REPORT_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: {
          result: 'failure',
          reason: 'media_validation_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        ...(data.category !== undefined ? { category: data.category } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.location !== undefined ? { location: data.location } : {}),
        ...(data.incidentAt !== undefined ? { incidentAt: new Date(data.incidentAt) } : {}),
        ...(data.photo !== undefined ? { photo: data.photo } : {}),
        ...(data.video !== undefined ? { video: data.video } : {}),
        ...(data.audio !== undefined ? { audio: data.audio } : {}),
        ...(data.pdf !== undefined ? { pdf: data.pdf } : {}),
        ...(data.document !== undefined ? { document: data.document } : {}),
        ...(data.other !== undefined ? { other: data.other } : {}),
        mediaTotalBytes: newTotalBytes,
      },
    });

    await this.reportCommonService.deleteMediaFiles(removed);

    this.reportCommonService.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(user)),
      action: AuditEventEnum.REPORT_UPDATED,
      entity: 'Report',
      entityId: report.id,
      entityLabel: report.caseReference,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
      },
      metadata: {
        mediaAdded: added.length,
        mediaRemoved: removed.length,
        mediaTotalBytes: newTotalBytes,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_UPDATED, {
      reportId: report.id,
      userId: user.id,
      caseReference: report.caseReference,
      status: report.status,
    });

    return report;
  }

  // Reuses REJECTED — no dedicated WITHDRAWN status in the schema
  async withdraw(user: CurrentUserDto, reportId: string) {
    const existing = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    if (existing.status !== ReportStatus.PENDING) {
      this.reportCommonService.emitAudit({
        userId: user.id,
        actorType: resolveActorType(this.reportCommonService.getRoles(user)),
        action: AuditEventEnum.REPORT_WITHDRAWN,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: {
          result: 'failure',
          reason: 'only_pending_reports_can_be_withdrawn',
          currentStatus: existing.status,
        },
      });
      throw new BadRequestException('only_pending_reports_can_be_withdrawn');
    }

    const result = await this.prisma.report.updateMany({
      where: { id: reportId, status: ReportStatus.PENDING },
      data: { status: ReportStatus.REJECTED },
    });

    if (result.count === 0) {
      this.reportCommonService.emitAudit({
        userId: user.id,
        actorType: resolveActorType(this.reportCommonService.getRoles(user)),
        action: AuditEventEnum.REPORT_WITHDRAWN,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', reason: 'report_transition_conflict' },
      });
      throw new BadRequestException('only_pending_reports_can_be_withdrawn');
    }

    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    this.reportCommonService.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(user)),
      action: AuditEventEnum.REPORT_WITHDRAWN,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_UPDATED, {
      reportId: report.id,
      userId: user.id,
      caseReference: report.caseReference,
      status: report.status,
    });

    return report;
  }

  // ── Drafts ──────────────────────────────────

  private draftTtlDays(): number {
    return Number(this.configService.get<string>('REPORT_DRAFT_TTL_DAYS') ?? 30);
  }

  private draftExpiry(): Date {
    return new Date(Date.now() + this.draftTtlDays() * 24 * 60 * 60 * 1000);
  }

  private async findOwnedDraft(user: CurrentUserDto, draftId: string) {
    const draft = await this.prisma.reportDraft.findFirst({
      where: {
        id: draftId,
        userId: user.id,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (!draft) throw new NotFoundException('draft_not_found');
    return draft;
  }

  // RPT-93 POST /reports/drafts
  async saveDraft(user: CurrentUserDto, dto: SaveReportDraftDto) {
    const maxDrafts = Number(this.configService.get<string>('REPORT_MAX_DRAFTS_PER_USER') ?? 20);
    const count = await this.prisma.reportDraft.count({ where: { userId: user.id } });
    if (count >= maxDrafts) throw new BadRequestException('too_many_drafts');

    // Never persist the re-auth credential
    const { credential: _credential, ...data } = dto as SaveReportDraftDto & {
      credential?: string;
    };

    return this.prisma.reportDraft.create({
      data: {
        userId: user.id,
        data: data as unknown as Prisma.InputJsonValue,
        expiresAt: this.draftExpiry(),
      },
    });
  }

  // RPT-94 GET /reports/drafts
  async listDrafts(user: CurrentUserDto, query: PageQueryDto) {
    const { page, limit, skip, take } = this.reportCommonService.paging(query);
    const where: Prisma.ReportDraftWhereInput = {
      userId: user.id,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
    const [items, total] = await Promise.all([
      this.prisma.reportDraft.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.reportDraft.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  // RPT-95 PATCH /reports/drafts/:id
  async updateDraft(user: CurrentUserDto, draftId: string, dto: SaveReportDraftDto) {
    const draft = await this.findOwnedDraft(user, draftId);
    const { credential: _credential, ...incoming } = dto as SaveReportDraftDto & {
      credential?: string;
    };
    const merged = { ...(draft.data as Record<string, unknown>), ...incoming };

    return this.prisma.reportDraft.update({
      where: { id: draftId },
      data: {
        data: merged as unknown as Prisma.InputJsonValue,
        expiresAt: this.draftExpiry(),
      },
    });
  }

  // RPT-96 DELETE /reports/drafts/:id
  async deleteDraft(user: CurrentUserDto, draftId: string) {
    const result = await this.prisma.reportDraft.deleteMany({
      where: { id: draftId, userId: user.id },
    });
    if (result.count === 0) throw new NotFoundException('draft_not_found');
    return { deleted: true };
  }

  async submitDraft(user: CurrentUserDto, draftId: string, idempotencyKey?: string) {
    const draft = await this.findOwnedDraft(user, draftId);

    const dto = plainToInstance(CreateReportDto, draft.data as Record<string, unknown>);
    const errors = await validate(dto, { whitelist: true });
    if (errors.length) {
      throw new BadRequestException(`draft_incomplete:${errors.map((e) => e.property).join(',')}`);
    }

    const report = await this.create(user, dto, idempotencyKey ?? `draft-${draftId}`);
    await this.prisma.reportDraft.deleteMany({ where: { id: draftId, userId: user.id } });
    return report;
  }

  async syncReports(user: CurrentUserDto, dto: SyncReportsDto) {
    const results: Array<{
      clientId: string;
      status: 'created' | 'duplicate' | 'invalid' | 'failed';
      reportId?: string;
      caseReference?: string;
      error?: string;
    }> = [];

    for (const item of dto.items) {
      try {
        const existing = await this.prisma.report.findFirst({
          where: { userId: user.id, idempotencyKey: item.clientId },
          select: { id: true, caseReference: true },
        });
        if (existing) {
          results.push({
            clientId: item.clientId,
            status: 'duplicate',
            reportId: existing.id,
            caseReference: existing.caseReference,
          });
          continue;
        }

        const instance = plainToInstance(CreateReportDto, item.data);
        const errors = await validate(instance, { whitelist: true });
        if (errors.length) {
          results.push({
            clientId: item.clientId,
            status: 'invalid',
            error: `validation_failed:${errors.map((e) => e.property).join(',')}`,
          });
          continue;
        }

        const merged: MediaBearing = {
          photo: instance.photo ?? [],
          video: instance.video ?? [],
          audio: instance.audio ?? [],
          pdf: instance.pdf ?? [],
          document: instance.document ?? [],
          other: instance.other ?? [],
        };
        this.reportCommonService.assertAttachmentCounts(merged);
        const validated = await this.reportCommonService.validateMediaFilesExist(
          this.reportCommonService.collectMediaFields(merged),
        );
        const totalBytes = validated.reduce((s, v) => s + v.size, 0);
        this.reportCommonService.assertTotalBytes(totalBytes);

        const created = await this.createReportWithUniqueCaseReference(
          user,
          instance,
          merged,
          totalBytes,
          item.clientId,
        );
        await this.prisma.report.update({
          where: { id: created.id },
          data: { clientCreatedAt: new Date(item.createdAt) },
        });

        this.reportCommonService.audit(
          user,
          AuditEventEnum.REPORT_CREATED,
          created,
          {
            result: 'success',
            status: created.status,
          },
          { metadata: { synced: true, clientId: item.clientId, mediaTotalBytes: totalBytes } },
        );

        this.eventEmitter.emit(NotificationEventEnum.REPORT_RECEIVED, {
          reportId: created.id,
          userId: user.id,
          caseReference: created.caseReference,
        });
        this.eventEmitter.emit(NotificationEventEnum.NEW_REPORT, {
          reportId: created.id,
          caseReference: created.caseReference,
          userId: user.id,
        });

        results.push({
          clientId: item.clientId,
          status: 'created',
          reportId: created.id,
          caseReference: created.caseReference,
        });
      } catch (err) {
        results.push({
          clientId: item.clientId,
          status: 'failed',
          error: this.reportCommonService.errMsg(err),
        });
      }
    }

    return {
      total: results.length,
      created: results.filter((r) => r.status === 'created').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      failed: results.filter((r) => r.status === 'invalid' || r.status === 'failed').length,
      results,
    };
  }

  // Handles both caseReference collisions and idempotencyKey races
  private async createReportWithUniqueCaseReference(
    user: CurrentUserDto,
    data: CreateReportDto,
    merged: MediaBearing,
    totalBytes: number,
    idempotencyKey?: string,
  ) {
    for (let attempt = 1; attempt <= CASE_REFERENCE_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.report.create({
          data: {
            userId: user.id,
            caseReference: this.reportCommonService.generateCaseReference(),
            category: data.category,
            description: data.description,
            location: data.location ?? null,
            incidentAt: data.incidentAt ? new Date(data.incidentAt) : null,
            photo: merged.photo,
            video: merged.video,
            audio: merged.audio,
            pdf: merged.pdf,
            document: merged.document,
            other: merged.other,
            mediaTotalBytes: totalBytes,
            status: ReportStatus.PENDING,
            idempotencyKey: idempotencyKey ?? null,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const target = err.meta?.target as string[] | undefined;

          if (target?.includes('caseReference')) {
            if (attempt === CASE_REFERENCE_MAX_ATTEMPTS) {
              throw err;
            }
            continue;
          }

          if (idempotencyKey && target?.some((t) => t.includes('idempotencyKey'))) {
            const winner = await this.prisma.report.findFirst({
              where: { userId: user.id, idempotencyKey },
            });
            if (winner) {
              return winner;
            }
          }
        }

        throw err;
      }
    }
    throw new Error('failed_to_generate_unique_case_reference');
  }
}

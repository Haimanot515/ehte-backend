import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditOutcome, AuditSeverity, InformationRequestStatus, Prisma, ReportStatus } from '@prisma/client';

import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/prisma/prisma.service';

import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { RolesEnum } from 'src/common/enums/roles.enum';

import { MinioService } from 'src/services/minio/minio.service';

import {
  CreateReportDto,
  UpdateReportDto,
  AdminReportQueryDto,
  UpdateReportStatusDto,
  AssignReportDto,
  RequestMoreInformationDto,
  EscalateReportDto,
  RespondToInformationRequestDto,
} from '../dto/report.dto';

// Adjust to match your actual PRD workflow if it changes
const ALLOWED_STATUS_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  [ReportStatus.PENDING]: [ReportStatus.RECEIVED, ReportStatus.REJECTED],
  [ReportStatus.RECEIVED]: [ReportStatus.UNDER_REVIEW, ReportStatus.REJECTED],
  [ReportStatus.UNDER_REVIEW]: [
    ReportStatus.ASSIGNED,
    ReportStatus.ESCALATED,
    ReportStatus.UNABLE_TO_VERIFY,
    ReportStatus.REJECTED,
  ],
  [ReportStatus.ASSIGNED]: [ReportStatus.IN_PROGRESS, ReportStatus.ESCALATED],
  [ReportStatus.IN_PROGRESS]: [
    ReportStatus.ESCALATED,
    ReportStatus.CLOSED,
    ReportStatus.UNABLE_TO_VERIFY,
  ],
  [ReportStatus.ESCALATED]: [ReportStatus.IN_PROGRESS, ReportStatus.CLOSED],
  [ReportStatus.UNABLE_TO_VERIFY]: [ReportStatus.CLOSED, ReportStatus.UNDER_REVIEW],
  [ReportStatus.CLOSED]: [],
  [ReportStatus.REJECTED]: [],
};

// Terminal statuses used by findStalePending() and maybeFlagUserForRejections()
const TERMINAL_STATUSES: ReportStatus[] = [ReportStatus.CLOSED, ReportStatus.REJECTED];

const ADMIN_ROLE_NAMES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

// Retry cap for case-reference generation on a unique constraint collision
const CASE_REFERENCE_MAX_ATTEMPTS = 5;

// Six media-array fields shared by CreateReportDto/UpdateReportDto and Report
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  private getMediaBucket(): string {
    return this.configService.get<string>('minio.bucketName') ?? 'ehte-media';
  }

  private collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  private collectMediaFieldsFromDto(dto: MediaBearingDto): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => dto[field] ?? []);
  }

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

  // Confirms every filepath exists, and enforces size/MIME limits
  // Also returns each validated file's size for running byte totals
  private async validateMediaFilesExist(
    filepaths: string[],
  ): Promise<Array<{ filepath: string; size: number }>> {
    if (!filepaths.length) return [];

    const maxFileSizeBytes = Number(
      this.configService.get<string>('MEDIA_MAX_FILE_SIZE') ?? 52_428_800,
    );
    const allowedMimeTypes = new Set(
      (this.configService.get<string>('MEDIA_ALLOWED_MIME_TYPES') ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    );

    const checks = await Promise.all(
      filepaths.map(async (filepath) => {
        const exists = await this.minioService.objectExists(filepath);
        if (!exists) {
          return { filepath, ok: false as const, reason: 'not_found', size: 0 };
        }

        const stat = await this.minioService.statObject(filepath);

        if (stat.size > maxFileSizeBytes) {
          return { filepath, ok: false as const, reason: 'too_large', size: stat.size };
        }
        if (allowedMimeTypes.size > 0 && !allowedMimeTypes.has(stat.contentType)) {
          return { filepath, ok: false as const, reason: 'disallowed_type', size: stat.size };
        }
        return { filepath, ok: true as const, size: stat.size };
      }),
    );

    const bad = checks.filter((c) => !c.ok);
    if (bad.length) {
      throw new BadRequestException(
        `media_validation_failed:${bad.map((b) => `${b.filepath}:${b.reason}`).join(',')}`,
      );
    }

    return checks.map((c) => ({ filepath: c.filepath, size: c.size }));
  }

  // Per-field attachment counts, checked before any MinIO calls
  private assertAttachmentCounts(media: MediaBearing): void {
    const maxPhotos = Number(
      this.configService.get<string>('REPORT_MAX_PHOTOS') ??
        this.configService.get<string>('CONTENT_MAX_PHOTOS') ??
        5,
    );
    const maxVideos = Number(
      this.configService.get<string>('REPORT_MAX_VIDEOS') ??
        this.configService.get<string>('CONTENT_MAX_VIDEOS') ??
        1,
    );
    const maxOther = Number(
      this.configService.get<string>('REPORT_MAX_OTHER_FILES') ??
        this.configService.get<string>('CONTENT_MAX_OTHER_FILES') ??
        2,
    );

    if (media.photo.length > maxPhotos) {
      throw new BadRequestException(`too_many_photos:max_${maxPhotos}`);
    }
    if (media.video.length > maxVideos) {
      throw new BadRequestException(`too_many_videos:max_${maxVideos}`);
    }
    const otherCount =
      media.audio.length + media.pdf.length + media.document.length + media.other.length;
    if (otherCount > maxOther) {
      throw new BadRequestException(`too_many_other_files:max_${maxOther}`);
    }
  }

  // Total attached-media size cap per report
  private assertTotalBytes(totalBytes: number): void {
    const maxTotalBytes = Number(
      this.configService.get<string>('REPORT_MAX_TOTAL_UPLOAD_BYTES') ??
        this.configService.get<string>('CONTENT_MAX_TOTAL_UPLOAD_BYTES') ??
        52_428_800,
    );
    if (totalBytes > maxTotalBytes) {
      throw new BadRequestException(`upload_total_size_exceeded:max_${maxTotalBytes}`);
    }
  }

  // Best-effort MinIO delete; failures are swallowed per-file
  private async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  // Reporter-facing media download, scoped to their own report
  async getMediaDownloadUrl(
    user: CurrentUserDto,
    reportId: string,
    key: string,
  ): Promise<{ url: string }> {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    const owned = this.collectMediaFields(report).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_report');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  // Admin media download, open to any ADMIN/SUPER_ADMIN
  // Mismatched key is recorded as a DENIED audit row before throwing
  async getMediaDownloadUrlForAdmin(
    admin: CurrentUserDto,
    reportId: string,
    key: string,
  ): Promise<{ url: string }> {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    const owned = this.collectMediaFields(report).includes(key);
    if (!owned) {
      this.emitAudit({
        userId: admin.id,
        targetUserId: report.userId,
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.REPORT_MEDIA_DOWNLOADED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: report.caseReference,
        diff: { result: 'denied', reason: 'media_not_found_on_report' },
        metadata: { requestedKey: key },
      });
      throw new NotFoundException('media_not_found_on_report');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);

    this.emitAudit({
      userId: admin.id,
      targetUserId: report.userId,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_MEDIA_DOWNLOADED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      diff: { result: 'success' },
      metadata: { key },
    });

    return { url };
  }

  // SUPER_ADMIN may act on any report; plain ADMIN only unassigned/own
  // Denied access attempts write a DENIED audit row before throwing
  private assertAdminCanAccessReport(
    admin: CurrentUserDto,
    report: { id: string; assignedToId: string | null; caseReference: string },
    action: AuditEventEnum,
  ): void {
    const roles = this.getRoles(admin);
    const isSuperAdmin = roles.includes(RolesEnum.SUPER_ADMIN);

    if (!isSuperAdmin && report.assignedToId && report.assignedToId !== admin.id) {
      this.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(roles),
        action,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: report.id,
        entityLabel: report.caseReference,
        diff: { result: 'denied', reason: 'assigned_to_another_admin' },
      });
      throw new ForbiddenException('report_assigned_to_another_admin');
    }
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

    this.emitAudit({
      targetUserId: payload.userId,
      actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
      action: AuditEventEnum.REPORT_UPDATED,
      entity: 'User',
      entityId: payload.userId,
      entityLabel: suspendedUser?.name ?? undefined,
      diff: { reason: 'owner_account_suspended', result: 'success' },
    });
  }

  // Flag != reject; only writes an audit row an admin can review
  private async maybeFlagUserForRejections(userId: string): Promise<void> {
    const threshold = Number(
      this.configService.get<string>('REPORT_AUTO_FLAG_REJECTION_COUNT') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_REJECTION_COUNT') ??
        3,
    );
    const windowDays = Number(
      this.configService.get<string>('REPORT_AUTO_FLAG_WINDOW_DAYS') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_WINDOW_DAYS') ??
        7,
    );
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const recentRejections = await this.prisma.report.count({
      where: { userId, status: ReportStatus.REJECTED, updatedAt: { gte: since } },
    });

    if (recentRejections >= threshold) {
      const flaggedUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      this.emitAudit({
        targetUserId: userId,
        actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
        action: AuditEventEnum.USER_AUTO_FLAGGED,
        entity: 'User',
        entityId: userId,
        entityLabel: flaggedUser?.name ?? undefined,
        diff: {
          reason: 'repeated_report_rejections',
          rejectionCount: recentRejections,
          windowDays,
          result: 'flagged_for_review',
        },
      });
    }
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
    this.assertAttachmentCounts(merged);

    const validated = await this.validateMediaFilesExist(this.collectMediaFields(merged));
    const totalBytes = validated.reduce((sum, v) => sum + v.size, 0);
    this.assertTotalBytes(totalBytes);

    const report = await this.createReportWithUniqueCaseReference(
      user,
      data,
      merged,
      totalBytes,
      idempotencyKey,
    );

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
      action: AuditEventEnum.REPORT_CREATED,
      entity: 'Report',
      entityId: report.id,
      entityLabel: report.caseReference,
      diff: { result: 'success', status: report.status },
      metadata: {
        category: report.category,
        attachmentCount: this.collectMediaFields(merged).length,
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
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(this.getRoles(user)),
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
      this.assertAttachmentCounts(merged);

      const validatedAdded = await this.validateMediaFilesExist(added);
      addedBytes = validatedAdded.reduce((sum, v) => sum + v.size, 0);

      const removedStats = await Promise.allSettled(
        removed.map((fp) => this.minioService.statObject(fp)),
      );
      removedBytes = removedStats.reduce(
        (sum, r) => sum + (r.status === 'fulfilled' ? r.value.size : 0),
        0,
      );

      newTotalBytes = Math.max(0, existing.mediaTotalBytes + addedBytes - removedBytes);
      this.assertTotalBytes(newTotalBytes);
    } catch (err) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(this.getRoles(user)),
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

    await this.deleteMediaFiles(removed);

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
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
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(this.getRoles(user)),
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
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(this.getRoles(user)),
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

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
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

  // Unscoped by assignment; only acting on a report is assignment-gated
  async findAllForAdmin(query: AdminReportQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.assignedTo
        ? { assignedToId: query.assignedTo }
        : query.assignmentStatus === 'unassigned'
          ? { assignedToId: null }
          : query.assignmentStatus === 'assigned'
            ? { assignedToId: { not: null } }
            : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          assignedTo: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
        },
      }),
      this.prisma.report.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async findAssignedToMe(admin: CurrentUserDto, query: { page?: number; limit?: number } = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { assignedToId: admin.id };

    const [items, total] = await Promise.all([
      this.prisma.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, name: true } },
        },
      }),
      this.prisma.report.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  // Only unassigned AND non-terminal reports count as stale
  async findStalePending() {
    const staleHours = Number(
      this.configService.get<string>('REPORT_STALE_PENDING_HOURS') ??
        this.configService.get<string>('CONTENT_STALE_PENDING_HOURS') ??
        48,
    );
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

    const reports = await this.prisma.report.findMany({
      where: {
        status: { notIn: TERMINAL_STATUSES },
        assignedToId: null,
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
    });

    return reports.map((report) => ({
      ...report,
      pendingHours: Math.floor((Date.now() - report.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
  }

  // Dashboard stats: total + per-status breakdown + assignment split
  async getStats() {
    const [total, grouped, assignedCount] = await this.prisma.$transaction([
      this.prisma.report.count(),
      this.prisma.report.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.report.count({ where: { assignedToId: { not: null } } }),
    ]);

    const counts = Object.fromEntries(
      Object.values(ReportStatus).map((status) => [status, 0]),
    ) as Record<ReportStatus, number>;

    for (const row of grouped) {
      const rowCount = row._count as { status?: number } | undefined;
      counts[row.status] = rowCount?.status ?? 0;
    }

    return {
      total,
      pending: counts[ReportStatus.PENDING] ?? 0,
      received: counts[ReportStatus.RECEIVED] ?? 0,
      underReview: counts[ReportStatus.UNDER_REVIEW] ?? 0,
      assigned: counts[ReportStatus.ASSIGNED] ?? 0,
      inProgress: counts[ReportStatus.IN_PROGRESS] ?? 0,
      escalated: counts[ReportStatus.ESCALATED] ?? 0,
      unableToVerify: counts[ReportStatus.UNABLE_TO_VERIFY] ?? 0,
      closed: counts[ReportStatus.CLOSED] ?? 0,
      rejected: counts[ReportStatus.REJECTED] ?? 0,
      assignedToAdmin: assignedCount,
      unassigned: total - assignedCount,
    };
  }

  // Open to any ADMIN/SUPER_ADMIN; assignment gates writes, not reads
  async findOneForAdmin(admin: CurrentUserDto, reportId: string) {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
      include: {
        user: {
          select: { id: true, name: true, phone: true },
        },
        informationRequests: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    const roles = this.getRoles(admin);
    const actorType = resolveActorType(roles);

    this.emitAudit({
      userId: admin.id,
      actorType,
      action: AuditEventEnum.REPORT_OPENED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      diff: { result: 'success' },
    });

    this.emitAudit({
      userId: admin.id,
      targetUserId: report.user.id,
      actorType,
      action: AuditEventEnum.REPORTER_INFORMATION_OPENED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      diff: { result: 'success' },
    });

    return report;
  }

  async getHistory(reportId: string) {
    const existing = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    return this.prisma.auditLog.findMany({
      where: { entity: 'Report', entityId: reportId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Conditional update guards against a concurrent admin transition
  async updateStatus(admin: CurrentUserDto, reportId: string, data: UpdateReportStatusDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.assertAdminCanAccessReport(admin, existing, AuditEventEnum.REPORT_STATUS_CHANGED);

    const allowedNext = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(data.status)) {
      this.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.REPORT_STATUS_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: {
          result: 'failure',
          attemptedStatus: data.status,
          currentStatus: existing.status,
        },
      });
      throw new BadRequestException(
        `invalid_status_transition: ${existing.status} -> ${data.status}`,
      );
    }

    const result = await this.prisma.report.updateMany({
      where: { id: reportId, status: existing.status },
      data: { status: data.status },
    });

    if (result.count === 0) {
      this.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.REPORT_STATUS_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', reason: 'report_transition_conflict', attemptedStatus: data.status },
      });
      throw new BadRequestException('report_transition_conflict');
    }

    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_STATUS_CHANGED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      reason: data.note ?? null,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_UPDATED, {
      reportId: report.id,
      userId: report.userId,
      caseReference: report.caseReference,
      status: report.status,
    });

    if (data.status === ReportStatus.REJECTED) {
      await this.maybeFlagUserForRejections(report.userId);
    }

    return report;
  }

  // Refuses a second request while one is still PENDING
  async requestMoreInformation(
    admin: CurrentUserDto,
    reportId: string,
    data: RequestMoreInformationDto,
  ) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.assertAdminCanAccessReport(
      admin,
      existing,
      AuditEventEnum.REPORT_MORE_INFORMATION_REQUESTED,
    );

    const openRequest = await this.prisma.reportInformationRequest.findFirst({
      where: { reportId, status: InformationRequestStatus.PENDING },
    });

    if (openRequest) {
      this.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.REPORT_MORE_INFORMATION_REQUESTED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', reason: 'information_request_already_pending' },
        metadata: { existingRequestId: openRequest.id },
      });
      throw new BadRequestException('information_request_already_pending');
    }

    const infoRequest = await this.prisma.reportInformationRequest.create({
      data: {
        reportId,
        requestedById: admin.id,
        message: data.message,
        status: InformationRequestStatus.PENDING,
      },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_MORE_INFORMATION_REQUESTED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: existing.caseReference,
      reason: data.message,
      diff: { result: 'success' },
      metadata: { informationRequestId: infoRequest.id },
    });

    this.eventEmitter.emit(NotificationEventEnum.MORE_INFORMATION_REQUESTED, {
      reportId,
      caseReference: existing.caseReference,
      informationRequestId: infoRequest.id,
      userId: existing.userId,
      message: data.message,
    });

    return infoRequest;
  }

  async findInformationRequests(user: CurrentUserDto, reportId: string) {
    const roles = this.getRoles(user);
    const isAdmin = roles.some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));

    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    if (!isAdmin && report.userId !== user.id) {
      throw new NotFoundException('report_not_found');
    }

    return this.prisma.reportInformationRequest.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOneInformationRequest(user: CurrentUserDto, reportId: string, requestId: string) {
    const roles = this.getRoles(user);
    const isAdmin = roles.some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));

    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    if (!isAdmin && report.userId !== user.id) {
      throw new NotFoundException('report_not_found');
    }

    const infoRequest = await this.prisma.reportInformationRequest.findFirst({
      where: { id: requestId, reportId },
    });

    if (!infoRequest) {
      throw new NotFoundException('information_request_not_found');
    }

    return infoRequest;
  }

  async respondToInformationRequest(
    user: CurrentUserDto,
    reportId: string,
    requestId: string,
    data: RespondToInformationRequestDto,
  ) {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    const infoRequest = await this.prisma.reportInformationRequest.findFirst({
      where: { id: requestId, reportId },
    });

    if (!infoRequest) {
      throw new NotFoundException('information_request_not_found');
    }

    if (infoRequest.status !== InformationRequestStatus.PENDING) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(this.getRoles(user)),
        action: AuditEventEnum.REPORT_INFORMATION_RESPONDED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: report.caseReference,
        diff: { result: 'failure', reason: 'information_request_already_responded' },
        metadata: { informationRequestId: requestId },
      });
      throw new BadRequestException('information_request_already_responded');
    }

    await this.validateMediaFilesExist(data.responseFiles ?? []);

    const updated = await this.prisma.reportInformationRequest.update({
      where: { id: requestId },
      data: {
        responseMessage: data.responseMessage,
        responseFiles: data.responseFiles ?? [],
        status: InformationRequestStatus.RESPONDED,
        respondedAt: new Date(),
      },
    });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
      action: AuditEventEnum.REPORT_INFORMATION_RESPONDED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      diff: { result: 'success' },
      metadata: {
        informationRequestId: requestId,
        responseFileCount: (data.responseFiles ?? []).length,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_REQUEST_RESPONDED, {
      reportId,
      caseReference: report.caseReference,
      informationRequestId: requestId,
      requestedById: infoRequest.requestedById,
    });

    return updated;
  }

  // Validates the target user actually holds an admin role
  async assign(admin: CurrentUserDto, reportId: string, data: AssignReportDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: data.assignedToUserId },
      include: {
        userRoles: {
          include: { role: true },
        },
      },
    });

    if (!target) {
      throw new NotFoundException('assignee_not_found');
    }

    const targetRoleNames = target.userRoles.map((ur) => ur.role.name);
    const isEligibleAdmin = targetRoleNames.some((name) =>
      ADMIN_ROLE_NAMES.includes(name as RolesEnum),
    );

    if (!isEligibleAdmin) {
      this.emitAudit({
        userId: admin.id,
        targetUserId: data.assignedToUserId,
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.REPORT_ASSIGNED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', reason: 'assignee_must_be_an_admin' },
      });
      throw new BadRequestException('assignee_must_be_an_admin');
    }

    const allowedNext = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];
    const shouldAutoSetAssigned =
      existing.status !== ReportStatus.ASSIGNED && allowedNext.includes(ReportStatus.ASSIGNED);

    const result = await this.prisma.report.updateMany({
      where: shouldAutoSetAssigned ? { id: reportId, status: existing.status } : { id: reportId },
      data: {
        assignedToId: data.assignedToUserId,
        ...(shouldAutoSetAssigned ? { status: ReportStatus.ASSIGNED } : {}),
      },
    });

    if (result.count === 0) {
      this.emitAudit({
        userId: admin.id,
        targetUserId: data.assignedToUserId,
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.REPORT_ASSIGNED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', reason: 'report_transition_conflict' },
      });
      throw new BadRequestException('report_transition_conflict');
    }

    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    this.emitAudit({
      userId: admin.id,
      targetUserId: data.assignedToUserId,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_ASSIGNED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      reason: data.note ?? null,
      diff: {
        result: 'success',
        assignedToUserId: data.assignedToUserId,
        previousStatus: existing.status,
        currentStatus: report.status,
      },
      metadata: {
        assignedToName: target.name ?? null,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_ASSIGNED, {
      reportId,
      caseReference: report.caseReference,
      assignedToUserId: data.assignedToUserId,
    });

    return report;
  }

  // Status is left unchanged; no concurrency guard needed here
  async unassign(admin: CurrentUserDto, reportId: string) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { assignedToId: null },
    });

    this.emitAudit({
      userId: admin.id,
      ...(existing.assignedToId ? { targetUserId: existing.assignedToId } : {}),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_UNASSIGNED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      diff: {
        result: 'success',
        previousAssignedToId: existing.assignedToId,
      },
    });

    return report;
  }

  // Checks ALLOWED_STATUS_TRANSITIONS directly, same rulebook as updateStatus
  async escalate(admin: CurrentUserDto, reportId: string, data: EscalateReportDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.assertAdminCanAccessReport(admin, existing, AuditEventEnum.REPORT_ESCALATED);

    const allowedNext = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(ReportStatus.ESCALATED)) {
      this.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.REPORT_ESCALATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', currentStatus: existing.status },
      });
      throw new BadRequestException(
        `invalid_status_transition: ${existing.status} -> ${ReportStatus.ESCALATED}`,
      );
    }

    const result = await this.prisma.report.updateMany({
      where: { id: reportId, status: existing.status },
      data: { status: ReportStatus.ESCALATED },
    });

    if (result.count === 0) {
      this.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.REPORT_ESCALATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', reason: 'report_transition_conflict' },
      });
      throw new BadRequestException('report_transition_conflict');
    }

    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_ESCALATED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      reason: data.reason,
      diff: {
        result: 'success',
        previousStatus: existing.status,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.HIGH_PRIORITY_REPORT, {
      reportId: report.id,
      caseReference: report.caseReference,
      reason: data.reason,
    });

    return report;
  }

  private generateCaseReference(): string {
    const year = new Date().getFullYear();
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `EHT-${year}-${random}`;
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
            caseReference: this.generateCaseReference(),
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

  private getRoles(user: CurrentUserDto): string[] {
    return (
      (
        user as unknown as {
          roles?: string[];
        }
      ).roles ?? []
    );
  }
}
import { ReportEvidence } from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { createHmac } from 'crypto';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  ActorType,
  AuditOutcome,
  AuditSeverity,
  InformationRequestStatus,
  Prisma,
  Report,
  ReportCategory,
  ReportContactMethod,
  ReportEvidenceKind,
  ReportIntegrityFlag,
  ReportLinkRecordType,
  ReportPriority,
  ReportResolutionOutcome,
  ReportSensitivity,
  ReportStatus,
  SubmissionChannel,
} from '@prisma/client';

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
  // ── new ──
  PageQueryDto,
  ReportStatsQueryDto,
  StatsTimelineQueryDto,
  ReportCountsQueryDto,
  UnreadReportsQueryDto,
  ByUserQueryDto,
  UserReportsQueryDto,
  RepeatReportersQueryDto,
  SlaBreachingQueryDto,
  FollowUpsQueryDto,
  PendingInformationRequestsQueryDto,
  SearchReportsQueryDto,
  ExportReportsQueryDto,
  ReportMapQueryDto,
  NearbyReportsQueryDto,
  HotspotsQueryDto,
  EvidenceRemovalQueryDto,
  SoftDeleteReportQueryDto,
  QueueNextQueryDto,
  ReportLocationDto,
  AddReportEvidenceDto,
  CreateReportMessageDto,
  RequestReopenDto,
  ReportFeedbackDto,
  AttachReportLocationDto,
  SyncReportsDto,
  ReportDeleteRequestDto,
  MuteReportDto,
  UrgentReportDto,
  ContactPreferenceDto,
  ChangeAnonymityDto,
  ReadAllReportsDto,
  UpdateReportCategoryDto,
  UpdateReportPriorityDto,
  ResolveReportDto,
  BulkAssignReportsDto,
  BulkUpdateReportStatusDto,
  MergeReportDto,
  AssignTeamDto,
  DeEscalateReportDto,
  MarkSpamDto,
  MarkFalseReportDto,
  UnmarkReportDto,
  LinkReportRecordDto,
  UnmergeReportDto,
  SplitReportDto,
  ArchiveReportDto,
  SetDueDateDto,
  CreateFollowUpDto,
  AddReportTagsDto,
  BulkTagReportsDto,
  SaveReportViewDto,
  UpdateReportViewDto,
  RedactEvidenceDto,
  CancelInformationRequestDto,
  ExtendInformationRequestDto,
  ReviewInformationResponseDto,
  UpdateReportSensitivityDto,
  GrantReportAccessDto,
  RevealReporterDto,
  LegalHoldDto,
  UpdateReportLocationDto,
  ReplyToReportEmailDto,
  StartExportJobDto,
  SaveReportDraftDto,
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

// Actual Postgres table name for the Report model (schema.prisma: @@map("report")).
// $queryRaw bypasses Prisma's model->table mapping, so raw SQL must use this name.
const REPORT_TABLE = Prisma.raw('report');

// Six media-array fields shared by CreateReportDto/UpdateReportDto and Report
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

const NEW_AUDIT_ACTIONS = [
  'REPORT_EVIDENCE_ADDED',
  'REPORT_EVIDENCE_REMOVED',
  'REPORT_EVIDENCE_REDACTED',
  'REPORT_MESSAGE_POSTED',
  'REPORT_FEEDBACK_SUBMITTED',
  'REPORT_REOPEN_REQUESTED',
  'REPORT_LOCATION_CHANGED',
  'REPORT_LOCATION_VIEWED',
  'REPORT_SYNCED',
  'REPORT_ERASURE_REQUESTED',
  'REPORT_URGENT_FLAGGED',
  'REPORT_ANONYMITY_CHANGED',
  'REPORT_CATEGORY_CHANGED',
  'REPORT_PRIORITY_CHANGED',
  'REPORT_RESOLVED',
  'REPORT_MERGED',
  'REPORT_UNMERGED',
  'REPORT_SPLIT',
  'REPORT_TEAM_ASSIGNED',
  'REPORT_DE_ESCALATED',
  'REPORT_ARCHIVED',
  'REPORT_UNARCHIVED',
  'REPORT_DELETED',
  'REPORT_RESTORED',
  'REPORT_INTEGRITY_FLAGGED',
  'REPORT_INTEGRITY_CLEARED',
  'REPORT_LINKED',
  'REPORT_UNLINKED',
  'REPORT_DUE_DATE_CHANGED',
  'REPORT_TAGS_CHANGED',
  'REPORT_SENSITIVITY_CHANGED',
  'REPORT_ACCESS_GRANTED',
  'REPORT_ACCESS_REVOKED',
  'REPORTER_REVEALED',
  'REPORT_LEGAL_HOLD_CHANGED',
  'REPORT_CASE_FILE_GENERATED',
  'REPORT_EMAIL_SENT',
  'REPORT_EXPORTED',
  'REPORT_EXPORT_DOWNLOADED',
  'REPORT_INFO_REQUEST_CHANGED',
  'REPORT_BULK_ACTION',
] as const;
type NewAuditAction = (typeof NEW_AUDIT_ACTIONS)[number];
const act = (a: NewAuditAction): AuditEventEnum => a as unknown as AuditEventEnum;

// Plain-string domain events for the new flows (consumed by notification
// listeners). Existing NotificationEventEnum members are reused where they fit.
const NEW_EVENTS = {
  MESSAGE_CREATED: 'report.message.created',
  REOPEN_REQUESTED: 'report.reopen.requested',
  URGENT_FLAGGED: 'report.urgent.flagged',
  INFORMATION_REMINDER: 'report.information-request.reminder',
  INFORMATION_REVIEWED: 'report.information-request.reviewed',
  EVIDENCE_REDACTION_REQUESTED: 'report.evidence.redaction-requested',
  EMAIL_REPLY: 'report.email.reply',
  EXPORT_JOB_CREATED: 'report.export-job.created',
  ERASURE_REQUESTED: 'report.erasure.requested',
} as const;

type RequestCtx = { ip?: string };

const ANON_KEY_PREFIX = 'anon_';
const TERMINAL_SQL = Prisma.raw(`('CLOSED','REJECTED')`);

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
        actorType: 'SYSTEM',
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

  async getStats() {
    const [
      total,
      statusGrouped,
      categoryGrouped,
      assignedCount,
      unassignedCount,
      escalatedCount,
      resolutionAgg,
      dailyTrend,
    ] = await this.prisma.$transaction([
      this.prisma.report.count(),

      this.prisma.report.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),

      this.prisma.report.groupBy({
        by: ['category'],
        _count: { category: true },
        orderBy: { category: 'asc' },
      }),

      this.prisma.report.count({ where: { assignedToId: { not: null } } }),
      this.prisma.report.count({ where: { assignedToId: null } }),
      this.prisma.report.count({ where: { status: ReportStatus.ESCALATED } }),

      this.prisma.$queryRaw<{ avg_hours: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) / 3600) AS avg_hours
        FROM ${REPORT_TABLE}
        WHERE status = 'CLOSED'
      `,

      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM ${REPORT_TABLE}
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY day
        ORDER BY day ASC
      `,
    ]);

    const byStatus = Object.fromEntries(
      Object.values(ReportStatus).map((status) => [status, 0]),
    ) as Record<ReportStatus, number>;

    for (const row of statusGrouped) {
      const c = row._count as { status?: number } | undefined;
      byStatus[row.status] = c?.status ?? 0;
    }

    const byCategory: Record<string, number> = {};
    for (const row of categoryGrouped) {
      const c = row._count as { category?: number } | undefined;
      byCategory[String(row.category)] = c?.category ?? 0;
    }

    const rejected = byStatus[ReportStatus.REJECTED] ?? 0;
    const closed = byStatus[ReportStatus.CLOSED] ?? 0;

    return {
      total,
      byStatus,
      byCategory,

      assignment: {
        assigned: assignedCount,
        unassigned: unassignedCount,
      },

      escalatedCount,

      rejectionRate: total > 0 ? Number((rejected / total).toFixed(4)) : 0,
      closureRate: total > 0 ? Number((closed / total).toFixed(4)) : 0,

      avgResolutionHours:
        resolutionAgg[0]?.avg_hours != null
          ? Number(Number(resolutionAgg[0].avg_hours).toFixed(2))
          : null,

      dailyTrend: dailyTrend.map((row) => ({
        date: row.day.toISOString().slice(0, 10),
        count: Number(row.count),
      })),
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
      targetUserId: report.user?.id,
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
        diff: {
          result: 'failure',
          reason: 'report_transition_conflict',
          attemptedStatus: data.status,
        },
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

    if (data.status === ReportStatus.REJECTED && report.userId) {
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

  private isAdminUser(user: CurrentUserDto): boolean {
    return this.getRoles(user).some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));
  }

  private isSuperAdmin(user: CurrentUserDto): boolean {
    return this.getRoles(user).includes(RolesEnum.SUPER_ADMIN);
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private paging(q: { page?: number; limit?: number }, maxLimit = 100) {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(maxLimit, Math.max(1, q.limit ?? 20));
    return { page, limit, skip: (page - 1) * limit, take: limit };
  }

  private activeGrantWhere(adminId: string): Prisma.ReportAccessGrantWhereInput {
    return {
      adminId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
  }

  private visibilityWhere(admin: CurrentUserDto): Prisma.ReportWhereInput {
    if (this.isSuperAdmin(admin)) return {};
    return {
      OR: [
        { sensitivity: ReportSensitivity.STANDARD },
        { assignedToId: admin.id },
        { accessGrants: { some: this.activeGrantWhere(admin.id) } },
      ],
    };
  }

  // Same rule as visibilityWhere, as a SQL fragment (alias r)
  private visibilitySql(admin: CurrentUserDto): Prisma.Sql {
    if (this.isSuperAdmin(admin)) return Prisma.sql`TRUE`;
    return Prisma.sql`(r."sensitivity"::text = 'STANDARD'
      OR r."assignedToId" = ${admin.id}
      OR EXISTS (
        SELECT 1 FROM report_access_grant g
        WHERE g."reportId" = r.id AND g."adminId" = ${admin.id}
          AND g."revokedAt" IS NULL AND (g."expiresAt" IS NULL OR g."expiresAt" > NOW())
      ))`;
  }

  // Loads a report the admin may see; hidden restricted reports look like 404
  private async loadForAdmin(
    admin: CurrentUserDto,
    reportId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<Report> {
    const report = await this.prisma.report.findFirst({
      where: {
        AND: [
          { id: reportId },
          opts.includeDeleted ? {} : { deletedAt: null },
          this.visibilityWhere(admin),
        ],
      },
    });
    if (!report) throw new NotFoundException('report_not_found');
    return report;
  }

  // loadForAdmin + the same assignment gate the existing write routes use
  private async loadForAdminWrite(
    admin: CurrentUserDto,
    reportId: string,
    action: AuditEventEnum,
  ): Promise<Report> {
    const report = await this.loadForAdmin(admin, reportId);
    this.assertAdminCanAccessReport(admin, report, action);
    return report;
  }

  private async loadOwned(user: CurrentUserDto, reportId: string): Promise<Report> {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id, deletedAt: null },
    });
    if (!report) throw new NotFoundException('report_not_found');
    return report;
  }

  // Public so the controller / existing list routes can add `isRead` (small change #3)
  async attachIsRead<T extends { id: string }>(
    adminId: string,
    items: T[],
  ): Promise<Array<T & { isRead: boolean }>> {
    if (!items.length) return [];
    const reads = await this.prisma.reportAdminRead.findMany({
      where: { adminId, reportId: { in: items.map((i) => i.id) } },
      select: { reportId: true },
    });
    const readIds = new Set(reads.map((r) => r.reportId));
    return items.map((i) => ({ ...i, isRead: readIds.has(i.id) }));
  }

  // Masked, stable identifier for anonymous reporters (never the real id)
  private maskUserId(userId: string): string {
    const secret =
      this.configService.get<string>('REPORT_ANON_MASK_SECRET') ??
      this.configService.get<string>('JWT_SECRET') ??
      'ehte-anon-mask';
    return `${ANON_KEY_PREFIX}${createHmac('sha256', secret).update(userId).digest('hex').slice(0, 12)}`;
  }

  private presentReporter(
    isAnonymous: boolean,
    userId: string | null,
    user?: { id: string; name: string | null } | null,
  ) {
    if (isAnonymous || !userId) {
      return { anonymous: true, key: userId ? this.maskUserId(userId) : null };
    }
    return { anonymous: false, id: user?.id ?? userId, name: user?.name ?? null };
  }

  // Generic admin list: visibility + isRead + masked reporter, one place
  private async pagedReports(
    admin: CurrentUserDto,
    where: Prisma.ReportWhereInput,
    q: { page?: number; limit?: number },
    orderBy: Prisma.ReportOrderByWithRelationInput | Prisma.ReportOrderByWithRelationInput[] = {
      createdAt: 'desc',
    },
  ) {
    const { page, limit, skip, take } = this.paging(q);
    const full: Prisma.ReportWhereInput = { AND: [where, this.visibilityWhere(admin)] };

    const [rows, total] = await Promise.all([
      this.prisma.report.findMany({
        where: full,
        orderBy,
        skip,
        take,
        include: {
          user: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
          adminReads: { where: { adminId: admin.id }, select: { readAt: true } },
        },
      }),
      this.prisma.report.count({ where: full }),
    ]);

    const items = rows.map(({ user, adminReads, ...r }) => ({
      ...r,
      userId: r.isAnonymous ? null : r.userId,
      isRead: adminReads.length > 0,
      reporter: this.presentReporter(r.isAnonymous, r.userId, user),
    }));

    return { items, total, page, limit };
  }

  private async runBulk(ids: string[], fn: (id: string) => Promise<unknown>) {
    const unique = [...new Set(ids)];
    const succeeded: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const id of unique) {
      try {
        await fn(id);
        succeeded.push(id);
      } catch (err) {
        failed.push({ id, reason: this.errMsg(err) });
      }
    }
    return { requested: unique.length, succeeded, failed };
  }

  // Single audit entry point for the new flows
  private audit(
    actor: CurrentUserDto,
    action: AuditEventEnum,
    report: { id: string; caseReference: string },
    diff: Record<string, unknown>,
    opts: {
      reason?: string | null;
      targetUserId?: string | null;
      metadata?: Record<string, unknown>;
      outcome?: AuditOutcome;
      severity?: AuditSeverity;
    } = {},
  ): void {
    this.emitAudit({
      userId: actor.id,
      ...(opts.targetUserId ? { targetUserId: opts.targetUserId } : {}),
      actorType: resolveActorType(this.getRoles(actor)),
      action,
      ...(opts.outcome ? { outcome: opts.outcome } : {}),
      ...(opts.severity ? { severity: opts.severity } : {}),
      entity: 'Report',
      entityId: report.id,
      entityLabel: report.caseReference,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      diff,
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
  }

  private async logAccess(
    reportId: string,
    userId: string | null,
    action: string,
    ctx?: RequestCtx,
  ): Promise<void> {
    await this.prisma.reportAccessLog
      .create({ data: { reportId, userId, action, ipAddress: ctx?.ip ?? null } })
      .catch(() => undefined); // never block the request on the access log
  }

  // Status change that also writes ReportStatusHistory; null = lost a race
  private async applyTransition(
    existing: Report,
    to: ReportStatus,
    changedById: string | null,
    extra: Prisma.ReportUncheckedUpdateManyInput = {},
    note?: string | null,
  ): Promise<Report | null> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const r = await tx.report.updateMany({
        where: { id: existing.id, status: existing.status },
        data: { status: to, lastActivityAt: now, reporterUpdatedAt: now, ...extra },
      });
      if (r.count === 0) return null;
      await tx.reportStatusHistory.create({
        data: {
          reportId: existing.id,
          fromStatus: existing.status,
          toStatus: to,
          changedById,
          note: note ?? null,
        },
      });
      return tx.report.findUniqueOrThrow({ where: { id: existing.id } });
    });
  }

  private notifyReporter(report: Report): void {
    this.eventEmitter.emit(NotificationEventEnum.REPORT_UPDATED, {
      reportId: report.id,
      userId: report.userId,
      caseReference: report.caseReference,
      status: report.status,
    });
  }

  private fieldForKind(kind: ReportEvidenceKind): MediaFieldName {
    return kind.toLowerCase() as MediaFieldName;
  }

  private kindFromMime(mime: string | undefined, key: string): ReportEvidenceKind {
    const m = (mime ?? '').toLowerCase();
    const ext = key.split('.').pop()?.toLowerCase() ?? '';
    if (m.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'].includes(ext)) {
      return ReportEvidenceKind.PHOTO;
    }
    if (m.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv'].includes(ext)) {
      return ReportEvidenceKind.VIDEO;
    }
    if (m.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'ogg', 'aac'].includes(ext)) {
      return ReportEvidenceKind.AUDIO;
    }
    if (m === 'application/pdf' || ext === 'pdf') return ReportEvidenceKind.PDF;
    if (
      m.includes('msword') ||
      m.includes('officedocument') ||
      m.startsWith('text/') ||
      ['doc', 'docx', 'txt', 'rtf', 'odt'].includes(ext)
    ) {
      return ReportEvidenceKind.DOCUMENT;
    }
    return ReportEvidenceKind.OTHER;
  }

  private gpsData(gps: ReportLocationDto) {
    const capturedAt = gps.capturedAt ? new Date(gps.capturedAt) : new Date();
    if (capturedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new BadRequestException('location_captured_in_the_future');
    }
    return {
      latitude: gps.latitude,
      longitude: gps.longitude,
      locationAccuracyMeters: gps.accuracyMeters ?? null,
      locationCapturedAt: capturedAt,
      locationAddress: gps.address ?? null,
      locationVerified: false,
      locationVerifiedAt: null,
      locationVerifiedById: null,
    };
  }

  // RPT-01 POST /reports/:id/evidence
  // `files` are already uploaded to MinIO by the controller/interceptor.
  async addEvidence(
    user: CurrentUserDto,
    reportId: string,
    files: Array<{ storageKey: string; mimeType?: string; sizeBytes?: number; sha256?: string }>,
    dto: AddReportEvidenceDto,
    ctx?: RequestCtx,
  ) {
    if (!files.length) throw new BadRequestException('no_evidence_provided');

    const report = await this.loadOwned(user, reportId);
    if (TERMINAL_STATUSES.includes(report.status)) {
      throw new BadRequestException('report_is_closed');
    }

    const existingKeys = this.collectMediaFields(report);
    const keys = files.map((f) => f.storageKey);
    const dup = keys.filter((k) => existingKeys.includes(k));
    if (dup.length) throw new BadRequestException(`evidence_already_attached:${dup.join(',')}`);

    const validated = await this.validateMediaFilesExist(keys);
    const sizeByKey = new Map(validated.map((v) => [v.filepath, v.size]));

    const entries = files.map((f) => ({
      ...f,
      kind: this.kindFromMime(f.mimeType, f.storageKey),
      size: sizeByKey.get(f.storageKey) ?? f.sizeBytes ?? 0,
    }));

    const merged: MediaBearing = {
      photo: [...report.photo],
      video: [...report.video],
      audio: [...report.audio],
      pdf: [...report.pdf],
      document: [...report.document],
      other: [...report.other],
    };
    for (const e of entries) merged[this.fieldForKind(e.kind)].push(e.storageKey);
    this.assertAttachmentCounts(merged);

    const newTotal = report.mediaTotalBytes + entries.reduce((s, e) => s + e.size, 0);
    this.assertTotalBytes(newTotal);

    const rows = await this.prisma.$transaction(async (tx) => {
      const created: ReportEvidence[] = [];
      for (const e of entries) {
        created.push(
          await tx.reportEvidence.create({
            data: {
              reportId,
              kind: e.kind,
              storageKey: e.storageKey,
              mimeType: e.mimeType ?? null,
              sizeBytes: e.size,
              sha256: e.sha256 ?? null,
              note: dto.note ?? null,
              addedById: user.id,
              custody: {
                create: { action: 'ADDED', actorId: user.id, ipAddress: ctx?.ip ?? null },
              },
            },
          }),
        );
      }
      await tx.report.update({
        where: { id: reportId },
        data: { ...merged, mediaTotalBytes: newTotal, lastActivityAt: new Date() },
      });
      return created;
    });

    this.audit(
      user,
      act('REPORT_EVIDENCE_ADDED'),
      report,
      { result: 'success' },
      {
        metadata: { count: rows.length, mediaTotalBytes: newTotal },
      },
    );

    return rows;
  }

  // RPT-02 POST /reports/:id/messages
  async createMessage(user: CurrentUserDto, reportId: string, dto: CreateReportMessageDto) {
    const report = await this.loadOwned(user, reportId);

    const [message] = await this.prisma.$transaction([
      this.prisma.reportMessage.create({
        data: {
          reportId,
          authorId: user.id,
          authorType: resolveActorType(this.getRoles(user)) as unknown as ActorType,
          message: dto.message,
        },
      }),
      this.prisma.report.update({
        where: { id: reportId },
        data: { lastActivityAt: new Date() },
      }),
    ]);

    this.audit(user, act('REPORT_MESSAGE_POSTED'), report, { result: 'success' });
    this.eventEmitter.emit(NEW_EVENTS.MESSAGE_CREATED, {
      reportId,
      caseReference: report.caseReference,
      messageId: message.id,
      assignedToId: report.assignedToId,
      fromReporter: true,
    });

    return message;
  }

  // RPT-03 GET /reports/:id/messages  (User own / Admin)
  async listMessages(user: CurrentUserDto, reportId: string, query: PageQueryDto) {
    const isAdmin = this.isAdminUser(user);
    if (isAdmin) await this.loadForAdmin(user, reportId);
    else await this.loadOwned(user, reportId);

    const { page, limit, skip, take } = this.paging(query);
    const where = { reportId };

    const [items, total] = await Promise.all([
      this.prisma.reportMessage.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      }),
      this.prisma.reportMessage.count({ where }),
    ]);

    if (!isAdmin) {
      // Reporter opening the thread reads everything staff wrote
      await this.prisma.reportMessage.updateMany({
        where: {
          reportId,
          readAt: null,
          OR: [{ authorId: null }, { authorId: { not: user.id } }],
        },
        data: { readAt: new Date() },
      });
    }

    return { items, total, page, limit };
  }

  // RPT-04 POST /reports/:id/reopen-request
  async requestReopen(user: CurrentUserDto, reportId: string, dto: RequestReopenDto) {
    const report = await this.loadOwned(user, reportId);

    if (!TERMINAL_STATUSES.includes(report.status)) {
      throw new BadRequestException('only_closed_reports_can_be_reopened');
    }

    const pending = await this.prisma.reportReopenRequest.findFirst({
      where: { reportId, handledAt: null },
    });
    if (pending) throw new BadRequestException('reopen_request_already_pending');

    const request = await this.prisma.reportReopenRequest.create({
      data: { reportId, requestedById: user.id, reason: dto.reason },
    });
    await this.prisma.report.update({
      where: { id: reportId },
      data: { lastActivityAt: new Date() },
    });

    this.audit(
      user,
      act('REPORT_REOPEN_REQUESTED'),
      report,
      { result: 'success' },
      {
        reason: dto.reason,
      },
    );
    this.eventEmitter.emit(NEW_EVENTS.REOPEN_REQUESTED, {
      reportId,
      caseReference: report.caseReference,
      requestId: request.id,
      assignedToId: report.assignedToId,
    });

    return request;
  }

  // RPT-05 POST /reports/:id/feedback
  async submitFeedback(user: CurrentUserDto, reportId: string, dto: ReportFeedbackDto) {
    const report = await this.loadOwned(user, reportId);

    if (report.status !== ReportStatus.CLOSED) {
      throw new BadRequestException('feedback_only_for_closed_reports');
    }

    try {
      const feedback = await this.prisma.reportFeedback.create({
        data: {
          reportId,
          userId: user.id,
          rating: dto.rating,
          comment: dto.comment ?? null,
        },
      });
      this.audit(user, act('REPORT_FEEDBACK_SUBMITTED'), report, {
        result: 'success',
        rating: dto.rating,
      });
      return feedback;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('feedback_already_submitted');
      }
      throw err;
    }
  }

  // GP-01 POST /reports/:id/location
  async attachLocation(user: CurrentUserDto, reportId: string, dto: AttachReportLocationDto) {
    const report = await this.loadOwned(user, reportId);
    if (TERMINAL_STATUSES.includes(report.status)) {
      throw new BadRequestException('report_is_closed');
    }

    const updated = await this.prisma.report.update({
      where: { id: reportId },
      data: { ...this.gpsData(dto.gps), lastActivityAt: new Date() },
    });

    this.audit(user, act('REPORT_LOCATION_CHANGED'), report, {
      result: 'success',
      source: 'reporter',
      hadLocation: report.latitude != null,
    });

    return {
      id: updated.id,
      latitude: updated.latitude,
      longitude: updated.longitude,
      locationAccuracyMeters: updated.locationAccuracyMeters,
      locationCapturedAt: updated.locationCapturedAt,
      locationAddress: updated.locationAddress,
    };
  }

  // RPT-29 GET /reports/me/summary
  async getMySummary(user: CurrentUserDto) {
    const grouped = await this.prisma.report.groupBy({
      by: ['status'],
      where: { userId: user.id, deletedAt: null },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { status: 'asc' },
    });

    const byStatus = Object.fromEntries(Object.values(ReportStatus).map((s) => [s, 0])) as Record<
      ReportStatus,
      number
    >;
    let total = 0;
    let lastReportAt: Date | null = null;
    for (const row of grouped) {
      const count = (row._count as { _all?: number } | undefined)?._all ?? 0;
      byStatus[row.status] = count;
      total += count;
      const last = (row._max as { createdAt?: Date | null } | undefined)?.createdAt ?? null;
      if (last && (!lastReportAt || last > lastReportAt)) lastReportAt = last;
    }

    const open = Object.values(ReportStatus)
      .filter((s) => !TERMINAL_STATUSES.includes(s))
      .reduce((sum, s) => sum + byStatus[s], 0);

    return { total, open, byStatus, lastReportAt };
  }

  async countMyUnreadUpdates(user: CurrentUserDto) {
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM ${REPORT_TABLE}
      WHERE "userId" = ${user.id}
        AND "deletedAt" IS NULL
        AND "reporterUpdatedAt" > COALESCE("reporterSeenAt", "createdAt")
    `;
    return { count: rows[0]?.count ?? 0 };
  }

  // RPT-31 PATCH /reports/:id/seen
  async markSeen(user: CurrentUserDto, reportId: string) {
    await this.loadOwned(user, reportId);
    const seenAt = new Date();
    await this.prisma.report.updateMany({
      where: { id: reportId, userId: user.id },
      data: { reporterSeenAt: seenAt },
    });
    return { id: reportId, seenAt };
  }

  // RPT-32 PATCH /reports/me/seen-all
  async markAllSeen(user: CurrentUserDto) {
    const result = await this.prisma.report.updateMany({
      where: { userId: user.id, deletedAt: null },
      data: { reporterSeenAt: new Date() },
    });
    return { updated: result.count };
  }

  // RPT-88 GET /reports/me/information-requests/pending
  async findMyPendingInformationRequests(user: CurrentUserDto, query: PageQueryDto) {
    const { page, limit, skip, take } = this.paging(query);
    const where: Prisma.ReportInformationRequestWhereInput = {
      status: InformationRequestStatus.PENDING,
      report: { userId: user.id, deletedAt: null },
    };

    const [rows, total] = await Promise.all([
      this.prisma.reportInformationRequest.findMany({
        where,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        skip,
        take,
        include: { report: { select: { id: true, caseReference: true, category: true } } },
      }),
      this.prisma.reportInformationRequest.count({ where }),
    ]);

    const now = Date.now();
    const items = rows.map((r) => ({
      ...r,
      isOverdue: r.dueAt ? r.dueAt.getTime() < now : false,
    }));

    return { items, total, page, limit };
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
    const { page, limit, skip, take } = this.paging(query);
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
        this.assertAttachmentCounts(merged);
        const validated = await this.validateMediaFilesExist(this.collectMediaFields(merged));
        const totalBytes = validated.reduce((s, v) => s + v.size, 0);
        this.assertTotalBytes(totalBytes);

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

        this.audit(
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
        results.push({ clientId: item.clientId, status: 'failed', error: this.errMsg(err) });
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

  // RPT-99 GET /reports/:id/timeline
  // Reporter-safe: no internal notes, no admin ids.
  async getReporterTimeline(user: CurrentUserDto, reportId: string) {
    const report = await this.loadOwned(user, reportId);

    const [history, requests] = await Promise.all([
      this.prisma.reportStatusHistory.findMany({
        where: { reportId },
        orderBy: { createdAt: 'asc' },
        select: { fromStatus: true, toStatus: true, createdAt: true },
      }),
      this.prisma.reportInformationRequest.findMany({
        where: { reportId },
        select: { createdAt: true, respondedAt: true, cancelledAt: true },
      }),
    ]);

    const events: Array<{ type: string; at: Date; from?: ReportStatus | null; to?: ReportStatus }> =
      [{ type: 'SUBMITTED', at: report.createdAt, to: ReportStatus.PENDING }];

    for (const h of history) {
      events.push({ type: 'STATUS_CHANGED', at: h.createdAt, from: h.fromStatus, to: h.toStatus });
    }
    for (const r of requests) {
      events.push({ type: 'INFORMATION_REQUESTED', at: r.createdAt });
      if (r.respondedAt) events.push({ type: 'INFORMATION_PROVIDED', at: r.respondedAt });
    }
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    return { reportId, caseReference: report.caseReference, status: report.status, events };
  }

  // RPT-100 GET /reports/track/:reference  (scoped to the caller's own reports)
  async trackByReference(user: CurrentUserDto, reference: string) {
    const report = await this.prisma.report.findFirst({
      where: {
        caseReference: reference.trim().toUpperCase(),
        userId: user.id,
        deletedAt: null,
      },
      select: {
        id: true,
        caseReference: true,
        status: true,
        category: true,
        createdAt: true,
        updatedAt: true,
        reporterUpdatedAt: true,
      },
    });
    if (!report) throw new NotFoundException('report_not_found');
    return report;
  }

  // RPT-101 GET /reports/:id/pdf
  async generateMyReportPdf(user: CurrentUserDto, reportId: string) {
    const report = await this.loadOwned(user, reportId);
    const history = await this.prisma.reportStatusHistory.findMany({
      where: { reportId },
      orderBy: { createdAt: 'asc' },
      select: { toStatus: true, createdAt: true },
    });

    const lines = [
      `Case reference: ${report.caseReference}`,
      `Status: ${report.status}`,
      `Category: ${report.category}`,
      `Submitted: ${report.createdAt.toISOString()}`,
      `Incident time: ${report.incidentAt ? report.incidentAt.toISOString() : '-'}`,
      `Location: ${report.location ?? '-'}`,
      `Attachments: ${this.collectMediaFields(report).length}`,
      '',
      'Description:',
      ...report.description.split('\n'),
      '',
      'Status history:',
      ...history.map((h) => `  ${h.createdAt.toISOString()}  ${h.toStatus}`),
    ];

    const buffer = await this.renderPdf(`Report ${report.caseReference}`, lines);
    return { buffer, filename: `${report.caseReference}.pdf`, contentType: 'application/pdf' };
  }

  // RPT-102 POST /reports/:id/delete-request
  async requestErasure(user: CurrentUserDto, reportId: string, dto: ReportDeleteRequestDto) {
    const report = await this.loadOwned(user, reportId);

    if (report.legalHold) throw new ForbiddenException('report_under_legal_hold');

    const pending = await this.prisma.reportErasureRequest.findFirst({
      where: { reportId, status: 'PENDING' },
    });
    if (pending) throw new BadRequestException('erasure_request_already_pending');

    const request = await this.prisma.reportErasureRequest.create({
      data: { reportId, requestedById: user.id, reason: dto.reason ?? null },
    });

    this.audit(
      user,
      act('REPORT_ERASURE_REQUESTED'),
      report,
      { result: 'success' },
      {
        reason: dto.reason ?? null,
      },
    );
    this.eventEmitter.emit(NEW_EVENTS.ERASURE_REQUESTED, {
      reportId,
      caseReference: report.caseReference,
      requestId: request.id,
    });

    return request;
  }

  // RPT-103 PATCH /reports/:id/mute
  async muteReport(user: CurrentUserDto, reportId: string, dto: MuteReportDto) {
    await this.loadOwned(user, reportId);

    if (dto.until && new Date(dto.until).getTime() <= Date.now()) {
      throw new BadRequestException('mute_until_must_be_in_the_future');
    }

    const updated = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        updatesMuted: dto.muted,
        updatesMutedUntil: dto.muted && dto.until ? new Date(dto.until) : null,
      },
      select: { id: true, updatesMuted: true, updatesMutedUntil: true },
    });
    return updated;
  }

  async flagUrgent(user: CurrentUserDto, reportId: string, dto: UrgentReportDto) {
    const report = await this.loadOwned(user, reportId);

    if (TERMINAL_STATUSES.includes(report.status)) {
      throw new BadRequestException('report_is_closed');
    }
    if (report.urgentFlaggedAt) {
      return { id: report.id, status: report.status, urgentFlaggedAt: report.urgentFlaggedAt };
    }

    const now = new Date();
    const alreadyEscalated = report.status === ReportStatus.ESCALATED;

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.report.update({
        where: { id: reportId },
        data: {
          urgentFlaggedAt: now,
          urgentDetails: dto.details ?? null,
          priority: ReportPriority.CRITICAL,
          lastActivityAt: now,
          reporterUpdatedAt: now,
          ...(alreadyEscalated ? {} : { status: ReportStatus.ESCALATED }),
          ...(dto.gps ? this.gpsData(dto.gps) : {}),
        },
      });
      if (!alreadyEscalated) {
        await tx.reportStatusHistory.create({
          data: {
            reportId,
            fromStatus: report.status,
            toStatus: ReportStatus.ESCALATED,
            changedById: user.id,
            note: 'urgent_flag_by_reporter',
          },
        });
        await tx.reportEscalation.create({
          data: {
            reportId,
            escalatedById: user.id,
            reason: `URGENT: ${dto.details ?? 'reporter flagged immediate danger'}`,
          },
        });
      }
      return u;
    });

    this.audit(
      user,
      act('REPORT_URGENT_FLAGGED'),
      report,
      {
        result: 'success',
        previousStatus: report.status,
        currentStatus: updated.status,
      },
      { severity: AuditSeverity.WARNING },
    );

    this.eventEmitter.emit(NotificationEventEnum.HIGH_PRIORITY_REPORT, {
      reportId,
      caseReference: report.caseReference,
      reason: 'urgent_flag_by_reporter',
      urgent: true,
    });
    this.eventEmitter.emit(NEW_EVENTS.URGENT_FLAGGED, {
      reportId,
      caseReference: report.caseReference,
      assignedToId: report.assignedToId,
      details: dto.details ?? null,
    });

    return { id: updated.id, status: updated.status, urgentFlaggedAt: updated.urgentFlaggedAt };
  }

  // RPT-162 PATCH /reports/:id/contact-preference
  async setContactPreference(user: CurrentUserDto, reportId: string, dto: ContactPreferenceDto) {
    await this.loadOwned(user, reportId);
    return this.prisma.report.update({
      where: { id: reportId },
      data: {
        contactMethod: dto.method as ReportContactMethod,
        contactWindow: dto.window ?? null,
      },
      select: { id: true, contactMethod: true, contactWindow: true },
    });
  }

  async changeAnonymity(user: CurrentUserDto, reportId: string, dto: ChangeAnonymityDto) {
    const report = await this.loadOwned(user, reportId);

    if (this.configService.get<string>('REPORT_ALLOW_ANONYMITY_CHANGE') === 'false') {
      throw new ForbiddenException('anonymity_change_not_allowed');
    }
    if (report.isAnonymous === dto.anonymous) {
      return { id: report.id, isAnonymous: report.isAnonymous };
    }
    if (dto.anonymous) {
      const revealed = await this.prisma.reportReporterReveal.count({ where: { reportId } });
      if (revealed > 0) throw new BadRequestException('identity_already_revealed');
    }

    await this.prisma.$transaction([
      this.prisma.report.update({
        where: { id: reportId },
        data: { isAnonymous: dto.anonymous, lastActivityAt: new Date() },
      }),
      this.prisma.reportRevision.create({
        data: {
          reportId,
          editedById: user.id,
          changes: {
            isAnonymous: { from: report.isAnonymous, to: dto.anonymous },
            ...(dto.reason ? { reason: dto.reason } : {}),
          } as Prisma.InputJsonValue,
        },
      }),
    ]);

    this.audit(
      user,
      act('REPORT_ANONYMITY_CHANGED'),
      report,
      {
        result: 'success',
        from: report.isAnonymous,
        to: dto.anonymous,
      },
      { reason: dto.reason ?? null },
    );

    return { id: report.id, isAnonymous: dto.anonymous };
  }

  private async renderPdf(title: string, lines: string[]): Promise<Buffer> {
    let PDFDocument: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      PDFDocument = require('pdfkit');
    } catch {
      return this.renderSimplePdf(title, lines);
    }

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) =>
      doc.on('end', () => resolve(Buffer.concat(chunks))),
    );

    const fontPath = this.configService.get<string>('REPORT_PDF_FONT_PATH');
    if (fontPath) doc.font(fontPath);
    doc.fontSize(16).text(title);
    doc.moveDown();
    doc.fontSize(10);
    for (const line of lines) doc.text(line || ' ');
    doc.end();
    return done;
  }

  private renderSimplePdf(title: string, lines: string[]): Buffer {
    const clean = (s: string) => s.replace(/[^\x20-\x7E]/g, '?').replace(/([\\()])/g, '\\$1');
    const wrapped: string[] = [title, ''];
    for (const line of lines) {
      if (!line) {
        wrapped.push('');
        continue;
      }
      for (let i = 0; i < line.length; i += 95) wrapped.push(line.slice(i, i + 95));
    }

    const perPage = 55;
    const pages: string[][] = [];
    for (let i = 0; i < wrapped.length; i += perPage) pages.push(wrapped.slice(i, i + perPage));
    if (!pages.length) pages.push(['']);

    const objs: string[] = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`;
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    pages.forEach((pg, i) => {
      const content = `BT /F1 10 Tf 13 TL 50 800 Td\n${pg.map((l) => `(${clean(l)}) '`).join('\n')}\nET`;
      objs[4 + 2 * i] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
      objs[5 + 2 * i] =
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
    });

    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let id = 1; id < objs.length; id++) {
      offsets[id] = Buffer.byteLength(out);
      out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(out);
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objs.length; id++) {
      out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  }

  private unreadFilter(adminId: string): Prisma.ReportWhereInput {
    return { adminReads: { none: { adminId } } };
  }

  // Normal inbox scope: not deleted, not archived
  private inboxWhere(extra: Prisma.ReportWhereInput = {}): Prisma.ReportWhereInput {
    return { AND: [{ deletedAt: null, archivedAt: null }, extra] };
  }

  private async markManyRead(adminId: string, reportIds: string[]): Promise<number> {
    let marked = 0;
    for (let i = 0; i < reportIds.length; i += 1000) {
      const chunk = reportIds.slice(i, i + 1000);
      const res = await this.prisma.reportAdminRead.createMany({
        data: chunk.map((reportId) => ({ reportId, adminId })),
        skipDuplicates: true,
      });
      marked += res.count;
    }
    return marked;
  }

  // RPT-14 PATCH /reports/:id/read
  async markRead(admin: CurrentUserDto, reportId: string) {
    await this.loadForAdmin(admin, reportId);
    await this.prisma.reportAdminRead.upsert({
      where: { reportId_adminId: { reportId, adminId: admin.id } },
      create: { reportId, adminId: admin.id },
      update: {},
    });
    return { id: reportId, isRead: true };
  }

  // RPT-15 PATCH /reports/:id/unread
  async markUnread(admin: CurrentUserDto, reportId: string) {
    await this.loadForAdmin(admin, reportId);
    await this.prisma.reportAdminRead.deleteMany({ where: { reportId, adminId: admin.id } });
    return { id: reportId, isRead: false };
  }

  // RPT-16 PATCH /reports/bulk/read
  async bulkMarkRead(admin: CurrentUserDto, ids: string[]) {
    const unique = [...new Set(ids)];
    const visible = await this.prisma.report.findMany({
      where: { AND: [{ id: { in: unique }, deletedAt: null }, this.visibilityWhere(admin)] },
      select: { id: true },
    });
    const visibleIds = visible.map((r) => r.id);
    await this.markManyRead(admin.id, visibleIds);
    const visibleSet = new Set(visibleIds);
    return {
      requested: unique.length,
      updated: visibleIds.length,
      notFound: unique.filter((id) => !visibleSet.has(id)),
    };
  }

  // RPT-17 PATCH /reports/bulk/unread
  async bulkMarkUnread(admin: CurrentUserDto, ids: string[]) {
    const unique = [...new Set(ids)];
    const res = await this.prisma.reportAdminRead.deleteMany({
      where: {
        adminId: admin.id,
        reportId: { in: unique },
        report: { AND: [{ deletedAt: null }, this.visibilityWhere(admin)] },
      },
    });
    return { requested: unique.length, updated: res.count };
  }

  // RPT-18 PATCH /reports/read-all  (everything matching the filter that is still unread)
  async readAll(admin: CurrentUserDto, dto: ReadAllReportsDto) {
    const where = this.inboxWhere({
      ...this.unreadFilter(admin.id),
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.category ? { category: dto.category } : {}),
      ...(dto.assignedTo ? { assignedToId: dto.assignedTo } : {}),
    });
    const rows = await this.prisma.report.findMany({
      where: { AND: [where, this.visibilityWhere(admin)] },
      select: { id: true },
      take: 20000,
    });
    const marked = await this.markManyRead(
      admin.id,
      rows.map((r) => r.id),
    );
    return { marked };
  }

  // RPT-19 GET /reports/unread
  async listUnread(admin: CurrentUserDto, query: UnreadReportsQueryDto) {
    return this.pagedReports(
      admin,
      this.inboxWhere({
        ...this.unreadFilter(admin.id),
        ...(query.status ? { status: query.status } : {}),
        ...(query.category ? { category: query.category } : {}),
      }),
      query,
    );
  }

  // RPT-20 GET /reports/unread/count
  async countUnread(admin: CurrentUserDto) {
    const count = await this.prisma.report.count({
      where: {
        AND: [this.inboxWhere(this.unreadFilter(admin.id)), this.visibilityWhere(admin)],
      },
    });
    return { count };
  }

  // RPT-21 GET /reports/unread/count/by-status
  async countUnreadByStatus(admin: CurrentUserDto) {
    const grouped = await this.prisma.report.groupBy({
      by: ['status'],
      where: { AND: [this.inboxWhere(this.unreadFilter(admin.id)), this.visibilityWhere(admin)] },
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });
    const byStatus = Object.fromEntries(Object.values(ReportStatus).map((s) => [s, 0])) as Record<
      ReportStatus,
      number
    >;
    let total = 0;
    for (const row of grouped) {
      const c = (row._count as { _all?: number } | undefined)?._all ?? 0;
      byStatus[row.status] = c;
      total += c;
    }
    return { total, byStatus };
  }

  // RPT-22 GET /reports/unread/count/by-category
  async countUnreadByCategory(admin: CurrentUserDto) {
    const grouped = await this.prisma.report.groupBy({
      by: ['category'],
      where: { AND: [this.inboxWhere(this.unreadFilter(admin.id)), this.visibilityWhere(admin)] },
      _count: { _all: true },
      orderBy: { category: 'asc' },
    });
    const byCategory = Object.fromEntries(
      Object.values(ReportCategory).map((c) => [c, 0]),
    ) as Record<ReportCategory, number>;
    let total = 0;
    for (const row of grouped) {
      const c = (row._count as { _all?: number } | undefined)?._all ?? 0;
      byCategory[row.category] = c;
      total += c;
    }
    return { total, byCategory };
  }

  // RPT-159 GET /reports/counts   total / read / unread for this admin
  async getCounts(admin: CurrentUserDto, query: ReportCountsQueryDto) {
    const filter: Prisma.ReportWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.assignedTo ? { assignedToId: query.assignedTo } : {}),
    };
    const base = this.inboxWhere(filter);
    const vis = this.visibilityWhere(admin);

    const [total, unread] = await Promise.all([
      this.prisma.report.count({ where: { AND: [base, vis] } }),
      this.prisma.report.count({ where: { AND: [base, vis, this.unreadFilter(admin.id)] } }),
    ]);
    return { total, read: total - unread, unread };
  }

  private async resolveUserScope(key: string): Promise<{ userId: string; isAnonymous: boolean }> {
    if (key.startsWith(ANON_KEY_PREFIX)) {
      const rows = await this.prisma.report.findMany({
        where: { isAnonymous: true, userId: { not: null } },
        distinct: ['userId'],
        select: { userId: true },
      });
      const hit = rows.find((r) => r.userId && this.maskUserId(r.userId) === key);
      if (!hit?.userId) throw new NotFoundException('reporter_not_found');
      return { userId: hit.userId, isAnonymous: true };
    }
    return { userId: key, isAnonymous: false };
  }

  private scopeWhere(scope: { userId: string; isAnonymous: boolean }): Prisma.ReportWhereInput {
    return { userId: scope.userId, isAnonymous: scope.isAnonymous, deletedAt: null };
  }

  private auditReporterView(
    admin: CurrentUserDto,
    view: string,
    scope?: { userId: string; isAnonymous: boolean },
    extra: Record<string, unknown> = {},
  ): void {
    this.emitAudit({
      userId: admin.id,
      // Never write the real id of an anonymous reporter into the audit target
      ...(scope && !scope.isAnonymous ? { targetUserId: scope.userId } : {}),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORTER_INFORMATION_OPENED,
      entity: 'Report',
      entityId: `by-user:${view}`,
      diff: { result: 'success', view, anonymousGroup: scope?.isAnonymous ?? null, ...extra },
    });
  }

  // One row per (reporter | masked anonymous reporter) with total / read / unread
  private async buildUserRows(admin: CurrentUserDto) {
    const base: Prisma.ReportWhereInput = {
      AND: [{ deletedAt: null, userId: { not: null } }, this.visibilityWhere(admin)],
    };

    const [totals, unreads] = await Promise.all([
      this.prisma.report.groupBy({
        by: ['userId', 'isAnonymous'],
        where: base,
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { userId: 'asc' },
      }),
      this.prisma.report.groupBy({
        by: ['userId', 'isAnonymous'],
        where: { AND: [base, this.unreadFilter(admin.id)] },
        _count: { _all: true },
        orderBy: { userId: 'asc' },
      }),
    ]);

    const unreadMap = new Map<string, number>();
    for (const u of unreads) {
      unreadMap.set(
        `${u.userId}:${u.isAnonymous}`,
        (u._count as { _all?: number } | undefined)?._all ?? 0,
      );
    }

    const identifiedIds = totals.filter((t) => !t.isAnonymous && t.userId).map((t) => t.userId!);
    const users = identifiedIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: identifiedIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameMap = new Map(users.map((u) => [u.id, u.name]));

    return totals.map((t) => {
      const totalReports = (t._count as { _all?: number } | undefined)?._all ?? 0;
      const unread = unreadMap.get(`${t.userId}:${t.isAnonymous}`) ?? 0;
      const lastReportAt = (t._max as { createdAt?: Date | null } | undefined)?.createdAt ?? null;
      return {
        key: t.isAnonymous ? this.maskUserId(t.userId!) : t.userId!,
        anonymous: t.isAnonymous,
        name: t.isAnonymous ? null : (nameMap.get(t.userId!) ?? null),
        totalReports,
        unread,
        read: totalReports - unread,
        lastReportAt,
      };
    });
  }

  private sortRows<T extends { totalReports: number; unread: number; lastReportAt: Date | null }>(
    rows: T[],
    sortBy: 'totalReports' | 'unread' | 'lastReportAt' = 'lastReportAt',
    order: 'asc' | 'desc' = 'desc',
  ): T[] {
    const dir = order === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sortBy === 'lastReportAt' ? (a.lastReportAt?.getTime() ?? 0) : a[sortBy];
      const bv = sortBy === 'lastReportAt' ? (b.lastReportAt?.getTime() ?? 0) : b[sortBy];
      return (av - bv) * dir;
    });
  }

  // RPT-23 GET /reports/by-user
  async listByUser(admin: CurrentUserDto, query: ByUserQueryDto) {
    const rows = this.sortRows(await this.buildUserRows(admin), query.sortBy, query.order);
    const { page, limit, skip } = this.paging(query);
    const totals = rows.reduce(
      (acc, r) => ({
        total: acc.total + r.totalReports,
        unread: acc.unread + r.unread,
        read: acc.read + r.read,
      }),
      { total: 0, unread: 0, read: 0 },
    );

    this.auditReporterView(admin, 'list', undefined, { rows: Math.min(limit, rows.length) });
    return { items: rows.slice(skip, skip + limit), total: rows.length, page, limit, totals };
  }

  // RPT-24 GET /reports/by-user/:userId
  async getUserReports(admin: CurrentUserDto, userKey: string, query: UserReportsQueryDto) {
    const scope = await this.resolveUserScope(userKey);

    const filter: Prisma.ReportWhereInput = {
      ...this.scopeWhere(scope),
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.isRead === true ? { adminReads: { some: { adminId: admin.id } } } : {}),
      ...(query.isRead === false ? this.unreadFilter(admin.id) : {}),
    };

    const header = { AND: [this.scopeWhere(scope), this.visibilityWhere(admin)] };
    const [list, total, unread, user] = await Promise.all([
      this.pagedReports(admin, filter, query),
      this.prisma.report.count({ where: header }),
      this.prisma.report.count({ where: { AND: [header, this.unreadFilter(admin.id)] } }),
      scope.isAnonymous
        ? Promise.resolve(null)
        : this.prisma.user.findUnique({
            where: { id: scope.userId },
            select: { id: true, name: true },
          }),
    ]);

    if (!total && !user && !scope.isAnonymous) throw new NotFoundException('reporter_not_found');

    this.auditReporterView(admin, 'reports', scope);
    return {
      reporter: scope.isAnonymous
        ? { anonymous: true, key: userKey }
        : { anonymous: false, id: user?.id ?? scope.userId, name: user?.name ?? null },
      totals: { total, read: total - unread, unread },
      ...list,
    };
  }

  // RPT-25 GET /reports/by-user/:userId/summary
  async getUserSummary(admin: CurrentUserDto, userKey: string) {
    const scope = await this.resolveUserScope(userKey);
    const where = { AND: [this.scopeWhere(scope), this.visibilityWhere(admin)] };

    const [byStatusRows, byCategoryRows, unread] = await Promise.all([
      this.prisma.report.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.report.groupBy({
        by: ['category'],
        where,
        _count: { _all: true },
        orderBy: { category: 'asc' },
      }),
      this.prisma.report.count({ where: { AND: [where, this.unreadFilter(admin.id)] } }),
    ]);

    const byStatus: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let total = 0;
    for (const r of byStatusRows) {
      const c = (r._count as { _all?: number } | undefined)?._all ?? 0;
      byStatus[r.status] = c;
      total += c;
    }
    for (const r of byCategoryRows) {
      byCategory[r.category] = (r._count as { _all?: number } | undefined)?._all ?? 0;
    }

    this.auditReporterView(admin, 'summary', scope);
    return { key: userKey, total, read: total - unread, unread, byStatus, byCategory };
  }

  // RPT-26 GET /reports/by-user/:userId/timeline   (reports per month)
  async getUserTimeline(admin: CurrentUserDto, userKey: string) {
    const scope = await this.resolveUserScope(userKey);
    const rows = await this.prisma.report.findMany({
      where: { AND: [this.scopeWhere(scope), this.visibilityWhere(admin)] },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const buckets = new Map<string, number>();
    for (const r of rows) {
      const month = r.createdAt.toISOString().slice(0, 7);
      buckets.set(month, (buckets.get(month) ?? 0) + 1);
    }

    this.auditReporterView(admin, 'timeline', scope);
    return {
      key: userKey,
      items: [...buckets.entries()].map(([month, count]) => ({ month, count })),
    };
  }

  // RPT-27 PATCH /reports/by-user/:userId/read
  async markUserReportsRead(admin: CurrentUserDto, userKey: string) {
    const scope = await this.resolveUserScope(userKey);
    const rows = await this.prisma.report.findMany({
      where: {
        AND: [this.scopeWhere(scope), this.visibilityWhere(admin), this.unreadFilter(admin.id)],
      },
      select: { id: true },
    });
    const marked = await this.markManyRead(
      admin.id,
      rows.map((r) => r.id),
    );
    return { key: userKey, marked };
  }

  // RPT-160 PATCH /reports/by-user/:userId/unread
  async markUserReportsUnread(admin: CurrentUserDto, userKey: string) {
    const scope = await this.resolveUserScope(userKey);
    const res = await this.prisma.reportAdminRead.deleteMany({
      where: {
        adminId: admin.id,
        report: { AND: [this.scopeWhere(scope), this.visibilityWhere(admin)] },
      },
    });
    return { key: userKey, updated: res.count };
  }

  // RPT-28 GET /reports/by-user/repeat
  async listRepeatReporters(admin: CurrentUserDto, query: RepeatReportersQueryDto) {
    const min = query.minReports ?? 2;
    const rows = this.sortRows(
      (await this.buildUserRows(admin)).filter((r) => r.totalReports >= min),
      'totalReports',
      'desc',
    );
    const { page, limit, skip } = this.paging(query);

    this.auditReporterView(admin, 'repeat', undefined, { minReports: min });
    return { items: rows.slice(skip, skip + limit), total: rows.length, page, limit };
  }

  private revision(reportId: string, editedById: string, changes: Record<string, unknown>) {
    return this.prisma.reportRevision.create({
      data: { reportId, editedById, changes: changes as Prisma.InputJsonValue },
    });
  }

  // RPT-06 PATCH /reports/:id/category
  async updateCategory(admin: CurrentUserDto, reportId: string, dto: UpdateReportCategoryDto) {
    const existing = await this.loadForAdminWrite(admin, reportId, act('REPORT_CATEGORY_CHANGED'));
    if (existing.category === dto.category) return existing;

    const [report] = await this.prisma.$transaction([
      this.prisma.report.update({
        where: { id: reportId },
        data: { category: dto.category, lastActivityAt: new Date() },
      }),
      this.revision(reportId, admin.id, {
        category: { from: existing.category, to: dto.category },
        ...(dto.reason ? { reason: dto.reason } : {}),
      }),
    ]);

    this.audit(
      admin,
      act('REPORT_CATEGORY_CHANGED'),
      report,
      {
        result: 'success',
        from: existing.category,
        to: dto.category,
      },
      { reason: dto.reason ?? null, targetUserId: report.isAnonymous ? null : report.userId },
    );
    return report;
  }

  // RPT-07 PATCH /reports/:id/priority
  async updatePriority(admin: CurrentUserDto, reportId: string, dto: UpdateReportPriorityDto) {
    const existing = await this.loadForAdminWrite(admin, reportId, act('REPORT_PRIORITY_CHANGED'));
    if (existing.priority === dto.priority) return existing;

    const [report] = await this.prisma.$transaction([
      this.prisma.report.update({
        where: { id: reportId },
        data: { priority: dto.priority as ReportPriority, lastActivityAt: new Date() },
      }),
      this.revision(reportId, admin.id, {
        priority: { from: existing.priority, to: dto.priority },
        ...(dto.reason ? { reason: dto.reason } : {}),
      }),
    ]);

    this.audit(
      admin,
      act('REPORT_PRIORITY_CHANGED'),
      report,
      {
        result: 'success',
        from: existing.priority,
        to: dto.priority,
      },
      { reason: dto.reason ?? null },
    );
    return report;
  }

  // RPT-08 POST /reports/:id/resolve
  async resolve(admin: CurrentUserDto, reportId: string, dto: ResolveReportDto) {
    const existing = await this.loadForAdminWrite(admin, reportId, act('REPORT_RESOLVED'));

    if (!(ALLOWED_STATUS_TRANSITIONS[existing.status] ?? []).includes(ReportStatus.CLOSED)) {
      throw new BadRequestException(
        `invalid_status_transition: ${existing.status} -> ${ReportStatus.CLOSED}`,
      );
    }

    const report = await this.applyTransition(
      existing,
      ReportStatus.CLOSED,
      admin.id,
      {
        closedAt: new Date(),
        resolutionOutcome: dto.outcome as ReportResolutionOutcome,
        resolutionSummary: dto.summary,
        resolvedById: admin.id,
      },
      `resolved:${dto.outcome}`,
    );
    if (!report) throw new BadRequestException('report_transition_conflict');

    this.audit(
      admin,
      AuditEventEnum.REPORT_STATUS_CHANGED,
      report,
      {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
        outcome: dto.outcome,
      },
      { reason: dto.summary },
    );
    this.notifyReporter(report);
    return report;
  }

  // RPT-09 PATCH /reports/bulk/assign   (Super Admin)
  async bulkAssign(admin: CurrentUserDto, dto: BulkAssignReportsDto) {
    const result = await this.runBulk(dto.ids, async (id) => {
      await this.assign(admin, id, { assignedToUserId: dto.adminId });
      await this.prisma.reportAssignmentHistory.create({
        data: {
          reportId: id,
          assignedToId: dto.adminId,
          assignedById: admin.id,
          note: 'bulk_assign',
        },
      });
    });
    this.emitAudit({
      userId: admin.id,
      targetUserId: dto.adminId,
      actorType: resolveActorType(this.getRoles(admin)),
      action: act('REPORT_BULK_ACTION'),
      entity: 'Report',
      entityId: 'bulk',
      diff: { op: 'assign', requested: result.requested, failed: result.failed.length },
    });
    return result;
  }

  // RPT-10 PATCH /reports/bulk/status
  async bulkUpdateStatus(admin: CurrentUserDto, dto: BulkUpdateReportStatusDto) {
    const result = await this.runBulk(dto.ids, async (id) => {
      const report = await this.updateStatus(admin, id, { status: dto.status, note: dto.note });
      await this.prisma.reportStatusHistory.create({
        data: {
          reportId: id,
          toStatus: dto.status,
          // updateStatus already validated the transition; record the source status
          fromStatus: null,
          changedById: admin.id,
          note: dto.note ?? 'bulk_status',
        },
      });
      return report;
    });
    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: act('REPORT_BULK_ACTION'),
      entity: 'Report',
      entityId: 'bulk',
      diff: {
        op: 'status',
        status: dto.status,
        requested: result.requested,
        failed: result.failed.length,
      },
    });
    return result;
  }

  // RPT-12 GET /reports/:id/related
  async findRelated(admin: CurrentUserDto, reportId: string) {
    const report = await this.loadForAdmin(admin, reportId);
    const vis = this.visibilityWhere(admin);
    const pick = { id: true, caseReference: true, status: true, category: true, createdAt: true };

    const links = await this.prisma.reportLink.findMany({
      where: { reportId, recordType: ReportLinkRecordType.REPORT },
      select: { recordId: true },
    });

    const [sameReporter, linked, mergedInto, mergedReports, splitFrom, splitReports] =
      await Promise.all([
        report.userId
          ? this.prisma.report.findMany({
              where: {
                AND: [{ userId: report.userId, id: { not: reportId }, deletedAt: null }, vis],
              },
              select: pick,
              orderBy: { createdAt: 'desc' },
              take: 20,
            })
          : Promise.resolve([]),
        links.length
          ? this.prisma.report.findMany({
              where: { AND: [{ id: { in: links.map((l) => l.recordId) }, deletedAt: null }, vis] },
              select: pick,
            })
          : Promise.resolve([]),
        report.mergedIntoId
          ? this.prisma.report.findFirst({
              where: { AND: [{ id: report.mergedIntoId }, vis] },
              select: pick,
            })
          : Promise.resolve(null),
        this.prisma.report.findMany({
          where: { AND: [{ mergedIntoId: reportId }, vis] },
          select: pick,
        }),
        report.splitFromId
          ? this.prisma.report.findFirst({
              where: { AND: [{ id: report.splitFromId }, vis] },
              select: pick,
            })
          : Promise.resolve(null),
        this.prisma.report.findMany({
          where: { AND: [{ splitFromId: reportId }, vis] },
          select: pick,
        }),
      ]);

    return { sameReporter, linked, mergedInto, mergedReports, splitFrom, splitReports };
  }

  async merge(admin: CurrentUserDto, sourceId: string, dto: MergeReportDto) {
    if (sourceId === dto.targetReportId) throw new BadRequestException('cannot_merge_into_itself');

    const source = await this.loadForAdminWrite(admin, sourceId, act('REPORT_MERGED'));
    const target = await this.loadForAdmin(admin, dto.targetReportId);

    if (source.mergedIntoId) throw new BadRequestException('report_already_merged');
    if (target.mergedIntoId) throw new BadRequestException('target_report_is_merged');

    const children = await this.prisma.report.findMany({
      where: { mergedIntoId: sourceId },
      select: { id: true },
    });

    const closeSource = !TERMINAL_STATUSES.includes(source.status);
    const now = new Date();
    const snapshot = {
      previousStatus: source.status,
      previousClosedAt: source.closedAt?.toISOString() ?? null,
      previousResolutionOutcome: source.resolutionOutcome,
      previousResolutionSummary: source.resolutionSummary,
      previousResolvedById: source.resolvedById,
      closedByMerge: closeSource,
      repointedChildIds: children.map((c) => c.id),
    };

    const merged = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.report.update({
        where: { id: sourceId },
        data: {
          mergedIntoId: target.id,
          mergedAt: now,
          lastActivityAt: now,
          ...(closeSource
            ? {
                status: ReportStatus.CLOSED,
                closedAt: now,
                reporterUpdatedAt: now,
                resolutionOutcome: ReportResolutionOutcome.NO_ACTION,
                resolutionSummary: `Merged into ${target.caseReference}`,
                resolvedById: admin.id,
              }
            : {}),
        },
      });
      if (children.length) {
        await tx.report.updateMany({
          where: { mergedIntoId: sourceId },
          data: { mergedIntoId: target.id },
        });
      }
      await tx.reportMerge.create({
        data: {
          sourceReportId: sourceId,
          targetReportId: target.id,
          mergedById: admin.id,
          reason: dto.reason ?? null,
          snapshot: snapshot as Prisma.InputJsonValue,
        },
      });
      if (closeSource) {
        await tx.reportStatusHistory.create({
          data: {
            reportId: sourceId,
            fromStatus: source.status,
            toStatus: ReportStatus.CLOSED,
            changedById: admin.id,
            note: `merged_into:${target.caseReference}`,
          },
        });
      }
      await tx.report.update({ where: { id: target.id }, data: { lastActivityAt: now } });
      return updated;
    });

    this.audit(
      admin,
      act('REPORT_MERGED'),
      source,
      {
        result: 'success',
        targetReportId: target.id,
        targetCaseReference: target.caseReference,
      },
      { reason: dto.reason ?? null },
    );
    if (closeSource) this.notifyReporter(merged);
    return merged;
  }

  // RPT-72 PATCH /reports/:id/assign-team   (Super Admin)
  async assignTeam(admin: CurrentUserDto, reportId: string, dto: AssignTeamDto) {
    const existing = await this.loadForAdmin(admin, reportId);
    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { assignedTeamId: dto.teamId, lastActivityAt: new Date() },
    });
    this.audit(admin, act('REPORT_TEAM_ASSIGNED'), report, {
      result: 'success',
      from: existing.assignedTeamId,
      to: dto.teamId,
    });
    return report;
  }

  // RPT-73 GET /reports/queue/next
  // Atomically claims the highest-priority, oldest unassigned report for this admin.
  async queueNext(admin: CurrentUserDto, query: QueueNextQueryDto) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await this.prisma.report.findFirst({
        where: {
          AND: [
            {
              deletedAt: null,
              archivedAt: null,
              mergedIntoId: null,
              assignedToId: null,
              status: { notIn: TERMINAL_STATUSES },
              ...(query.teamId ? { assignedTeamId: query.teamId } : {}),
            },
            this.visibilityWhere(admin),
          ],
        },
        orderBy: [
          { priority: 'desc' },
          { dueAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
        ],
        select: { id: true, status: true },
      });
      if (!candidate) return null;

      const autoAssign =
        candidate.status !== ReportStatus.ASSIGNED &&
        (ALLOWED_STATUS_TRANSITIONS[candidate.status] ?? []).includes(ReportStatus.ASSIGNED);

      const now = new Date();
      const claimed = await this.prisma.report.updateMany({
        where: { id: candidate.id, assignedToId: null, status: candidate.status },
        data: {
          assignedToId: admin.id,
          lastActivityAt: now,
          ...(autoAssign ? { status: ReportStatus.ASSIGNED, reporterUpdatedAt: now } : {}),
        },
      });
      if (claimed.count === 0) continue; // someone else got it first

      await this.prisma.reportAssignmentHistory.create({
        data: {
          reportId: candidate.id,
          assignedToId: admin.id,
          assignedById: admin.id,
          note: 'queue_next',
        },
      });
      if (autoAssign) {
        await this.prisma.reportStatusHistory.create({
          data: {
            reportId: candidate.id,
            fromStatus: candidate.status,
            toStatus: ReportStatus.ASSIGNED,
            changedById: admin.id,
            note: 'queue_next',
          },
        });
      }

      const report = await this.prisma.report.findUniqueOrThrow({ where: { id: candidate.id } });
      this.audit(
        admin,
        AuditEventEnum.REPORT_ASSIGNED,
        report,
        {
          result: 'success',
          assignedToUserId: admin.id,
          previousStatus: candidate.status,
          currentStatus: report.status,
        },
        { metadata: { source: 'queue_next' } },
      );
      this.eventEmitter.emit(NotificationEventEnum.REPORT_ASSIGNED, {
        reportId: report.id,
        caseReference: report.caseReference,
        assignedToUserId: admin.id,
      });
      return report;
    }
    return null;
  }

  // RPT-74 PATCH /reports/:id/de-escalate
  async deEscalate(admin: CurrentUserDto, reportId: string, dto: DeEscalateReportDto) {
    const existing = await this.loadForAdminWrite(admin, reportId, act('REPORT_DE_ESCALATED'));
    if (existing.status !== ReportStatus.ESCALATED) {
      throw new BadRequestException('report_not_escalated');
    }

    const report = await this.applyTransition(
      existing,
      ReportStatus.IN_PROGRESS,
      admin.id,
      {},
      `de_escalated: ${dto.reason}`,
    );
    if (!report) throw new BadRequestException('report_transition_conflict');

    const open = await this.prisma.reportEscalation.findFirst({
      where: { reportId, deEscalatedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (open) {
      await this.prisma.reportEscalation.update({
        where: { id: open.id },
        data: {
          deEscalatedAt: new Date(),
          deEscalatedById: admin.id,
          deEscalationReason: dto.reason,
        },
      });
    }

    this.audit(
      admin,
      act('REPORT_DE_ESCALATED'),
      report,
      {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
      },
      { reason: dto.reason },
    );
    this.notifyReporter(report);
    return report;
  }

  // RPT-75 GET /reports/escalated
  async listEscalated(admin: CurrentUserDto, query: PageQueryDto) {
    return this.pagedReports(admin, { deletedAt: null, status: ReportStatus.ESCALATED }, query, [
      { priority: 'desc' },
      { updatedAt: 'desc' },
    ]);
  }

  async getEscalations(admin: CurrentUserDto, reportId: string) {
    await this.loadForAdmin(admin, reportId);
    return this.prisma.reportEscalation.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // RPT-80 PATCH /reports/bulk/unassign   (Super Admin)
  async bulkUnassign(admin: CurrentUserDto, ids: string[]) {
    const result = await this.runBulk(ids, async (id) => {
      await this.unassign(admin, id);
      await this.prisma.reportAssignmentHistory.create({
        data: { reportId: id, assignedToId: null, assignedById: admin.id, note: 'bulk_unassign' },
      });
    });
    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: act('REPORT_BULK_ACTION'),
      entity: 'Report',
      entityId: 'bulk',
      diff: { op: 'unassign', requested: result.requested, failed: result.failed.length },
    });
    return result;
  }

  // RPT-81 GET /reports/:id/transitions
  async getAllowedTransitions(admin: CurrentUserDto, reportId: string) {
    const report = await this.loadForAdmin(admin, reportId);
    return {
      id: report.id,
      current: report.status,
      allowed: ALLOWED_STATUS_TRANSITIONS[report.status] ?? [],
    };
  }

  // RPT-111 PATCH /reports/:id/archive
  async archive(admin: CurrentUserDto, reportId: string, dto: ArchiveReportDto) {
    const existing = await this.loadForAdminWrite(admin, reportId, act('REPORT_ARCHIVED'));
    if (existing.archivedAt) throw new BadRequestException('report_already_archived');
    if (!TERMINAL_STATUSES.includes(existing.status)) {
      throw new BadRequestException('only_closed_reports_can_be_archived');
    }

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        archivedAt: new Date(),
        archivedById: admin.id,
        archiveReason: dto.reason ?? null,
        lastActivityAt: new Date(),
      },
    });
    this.audit(
      admin,
      act('REPORT_ARCHIVED'),
      report,
      { result: 'success' },
      {
        reason: dto.reason ?? null,
      },
    );
    return report;
  }

  // RPT-112 PATCH /reports/:id/unarchive
  async unarchive(admin: CurrentUserDto, reportId: string) {
    const existing = await this.loadForAdminWrite(admin, reportId, act('REPORT_UNARCHIVED'));
    if (!existing.archivedAt) throw new BadRequestException('report_not_archived');

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        archivedAt: null,
        archivedById: null,
        archiveReason: null,
        lastActivityAt: new Date(),
      },
    });
    this.audit(admin, act('REPORT_UNARCHIVED'), report, { result: 'success' });
    return report;
  }

  // RPT-113 GET /reports/archived
  async listArchived(admin: CurrentUserDto, query: PageQueryDto) {
    return this.pagedReports(admin, { deletedAt: null, archivedAt: { not: null } }, query, {
      archivedAt: 'desc',
    });
  }

  // RPT-114 DELETE /reports/:id   (soft delete, Super Admin)
  async softDelete(admin: CurrentUserDto, reportId: string, dto: SoftDeleteReportQueryDto) {
    const existing = await this.loadForAdmin(admin, reportId);
    if (existing.legalHold) throw new ForbiddenException('report_under_legal_hold');

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        deletedAt: new Date(),
        deletedById: admin.id,
        deleteReason: dto.reason,
      },
    });
    this.audit(
      admin,
      act('REPORT_DELETED'),
      report,
      { result: 'success' },
      {
        reason: dto.reason,
        severity: AuditSeverity.WARNING,
      },
    );
    return { id: report.id, deletedAt: report.deletedAt };
  }

  // RPT-115 POST /reports/:id/restore   (Super Admin)
  async restore(admin: CurrentUserDto, reportId: string) {
    const existing = await this.loadForAdmin(admin, reportId, { includeDeleted: true });
    if (!existing.deletedAt) throw new BadRequestException('report_not_deleted');

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { deletedAt: null, deletedById: null, deleteReason: null, lastActivityAt: new Date() },
    });
    this.audit(admin, act('REPORT_RESTORED'), report, { result: 'success' });
    return report;
  }

  // RPT-116 GET /reports/trash   (Super Admin)
  async listTrash(admin: CurrentUserDto, query: PageQueryDto) {
    return this.pagedReports(admin, { deletedAt: { not: null } }, query, { deletedAt: 'desc' });
  }

  // RPT-119 POST /reports/:id/mark-spam
  // Also rejects the report when the status table allows REJECTED from where it is.
  async markSpam(admin: CurrentUserDto, reportId: string, dto: MarkSpamDto) {
    const existing = await this.loadForAdminWrite(admin, reportId, act('REPORT_INTEGRITY_FLAGGED'));
    if (existing.integrityFlag) throw new BadRequestException('report_already_flagged');

    const flagData = {
      integrityFlag: ReportIntegrityFlag.SPAM,
      integrityReason: dto.reason ?? null,
      integrityFlagAt: new Date(),
      integrityById: admin.id,
    };

    const canReject = (ALLOWED_STATUS_TRANSITIONS[existing.status] ?? []).includes(
      ReportStatus.REJECTED,
    );

    let report: Report;
    if (canReject) {
      const res = await this.applyTransition(
        existing,
        ReportStatus.REJECTED,
        admin.id,
        flagData,
        'marked_spam',
      );
      if (!res) throw new BadRequestException('report_transition_conflict');
      report = res;
    } else {
      report = await this.prisma.report.update({
        where: { id: reportId },
        data: { ...flagData, lastActivityAt: new Date() },
      });
    }

    this.audit(
      admin,
      act('REPORT_INTEGRITY_FLAGGED'),
      report,
      {
        result: 'success',
        flag: ReportIntegrityFlag.SPAM,
        rejected: canReject,
      },
      { reason: dto.reason ?? null },
    );

    if (canReject) {
      this.notifyReporter(report);
      if (report.userId) await this.maybeFlagUserForRejections(report.userId);
    }
    return report;
  }

  // RPT-120 POST /reports/:id/mark-false   (flag only; closing is a separate decision)
  async markFalse(admin: CurrentUserDto, reportId: string, dto: MarkFalseReportDto) {
    const existing = await this.loadForAdminWrite(admin, reportId, act('REPORT_INTEGRITY_FLAGGED'));
    if (existing.integrityFlag) throw new BadRequestException('report_already_flagged');

    const flag = dto.malicious
      ? ReportIntegrityFlag.MALICIOUS_FALSE_REPORT
      : ReportIntegrityFlag.FALSE_REPORT;

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        integrityFlag: flag,
        integrityReason: dto.reason,
        integrityFlagAt: new Date(),
        integrityById: admin.id,
        lastActivityAt: new Date(),
      },
    });
    this.audit(
      admin,
      act('REPORT_INTEGRITY_FLAGGED'),
      report,
      {
        result: 'success',
        flag,
      },
      { reason: dto.reason, severity: dto.malicious ? AuditSeverity.WARNING : undefined },
    );
    return report;
  }

  // RPT-121 PATCH /reports/:id/unmark   (clears the flag; does not revert a rejection)
  async unmark(admin: CurrentUserDto, reportId: string, dto: UnmarkReportDto) {
    const existing = await this.loadForAdminWrite(admin, reportId, act('REPORT_INTEGRITY_CLEARED'));
    if (!existing.integrityFlag) throw new BadRequestException('report_not_flagged');

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        integrityFlag: null,
        integrityReason: null,
        integrityFlagAt: null,
        integrityById: null,
        lastActivityAt: new Date(),
      },
    });
    this.audit(
      admin,
      act('REPORT_INTEGRITY_CLEARED'),
      report,
      {
        result: 'success',
        previousFlag: existing.integrityFlag,
      },
      { reason: dto.reason ?? null },
    );
    return report;
  }

  // RPT-122 GET /reports/spam
  async listSpam(admin: CurrentUserDto, query: PageQueryDto) {
    return this.pagedReports(admin, { deletedAt: null, integrityFlag: { not: null } }, query, {
      integrityFlagAt: 'desc',
    });
  }

  // RPT-123 GET /reports/:id/links
  async getLinks(admin: CurrentUserDto, reportId: string) {
    await this.loadForAdmin(admin, reportId);
    return this.prisma.reportLink.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // RPT-124 POST /reports/:id/links
  async addLink(admin: CurrentUserDto, reportId: string, dto: LinkReportRecordDto) {
    const report = await this.loadForAdminWrite(admin, reportId, act('REPORT_LINKED'));

    if (dto.recordType === 'REPORT') {
      if (dto.recordId === reportId) throw new BadRequestException('cannot_link_report_to_itself');
      await this.loadForAdmin(admin, dto.recordId); // must exist and be visible
    }

    try {
      const link = await this.prisma.reportLink.create({
        data: {
          reportId,
          recordType: dto.recordType as ReportLinkRecordType,
          recordId: dto.recordId,
          note: dto.note ?? null,
          createdById: admin.id,
        },
      });
      this.audit(admin, act('REPORT_LINKED'), report, {
        result: 'success',
        recordType: dto.recordType,
        recordId: dto.recordId,
      });
      return link;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('link_already_exists');
      }
      throw err;
    }
  }

  // RPT-125 DELETE /reports/:id/links/:linkId
  async removeLink(admin: CurrentUserDto, reportId: string, linkId: string) {
    const report = await this.loadForAdminWrite(admin, reportId, act('REPORT_UNLINKED'));
    const res = await this.prisma.reportLink.deleteMany({ where: { id: linkId, reportId } });
    if (res.count === 0) throw new NotFoundException('link_not_found');
    this.audit(admin, act('REPORT_UNLINKED'), report, { result: 'success', linkId });
    return { deleted: true };
  }

  // RPT-126 POST /reports/:id/unmerge
  async unmerge(admin: CurrentUserDto, reportId: string, dto: UnmergeReportDto) {
    const source = await this.loadForAdminWrite(admin, reportId, act('REPORT_UNMERGED'));

    const merge = await this.prisma.reportMerge.findFirst({
      where: {
        sourceReportId: reportId,
        unmergedAt: null,
        ...(dto.mergeId ? { id: dto.mergeId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!merge) throw new NotFoundException('merge_not_found');

    const snap = (merge.snapshot ?? {}) as {
      previousStatus?: ReportStatus;
      previousClosedAt?: string | null;
      previousResolutionOutcome?: ReportResolutionOutcome | null;
      previousResolutionSummary?: string | null;
      previousResolvedById?: string | null;
      closedByMerge?: boolean;
      repointedChildIds?: string[];
    };

    const now = new Date();
    const restored = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.report.update({
        where: { id: reportId },
        data: {
          mergedIntoId: null,
          mergedAt: null,
          lastActivityAt: now,
          ...(snap.closedByMerge && snap.previousStatus
            ? {
                status: snap.previousStatus,
                reporterUpdatedAt: now,
                closedAt: snap.previousClosedAt ? new Date(snap.previousClosedAt) : null,
                resolutionOutcome: snap.previousResolutionOutcome ?? null,
                resolutionSummary: snap.previousResolutionSummary ?? null,
                resolvedById: snap.previousResolvedById ?? null,
              }
            : {}),
        },
      });
      if (snap.repointedChildIds?.length) {
        await tx.report.updateMany({
          where: { id: { in: snap.repointedChildIds }, mergedIntoId: merge.targetReportId },
          data: { mergedIntoId: reportId },
        });
      }
      await tx.reportMerge.update({
        where: { id: merge.id },
        data: { unmergedAt: now, unmergedById: admin.id, unmergeReason: dto.reason },
      });
      if (snap.closedByMerge && snap.previousStatus) {
        await tx.reportStatusHistory.create({
          data: {
            reportId,
            fromStatus: source.status,
            toStatus: snap.previousStatus,
            changedById: admin.id,
            note: 'unmerged',
          },
        });
      }
      return updated;
    });

    this.audit(
      admin,
      act('REPORT_UNMERGED'),
      source,
      {
        result: 'success',
        mergeId: merge.id,
        restoredStatus: restored.status,
      },
      { reason: dto.reason },
    );
    if (snap.closedByMerge) this.notifyReporter(restored);
    return restored;
  }

  // RPT-127 GET /reports/:id/merge-history
  async getMergeHistory(admin: CurrentUserDto, reportId: string) {
    await this.loadForAdmin(admin, reportId, { includeDeleted: true });
    return this.prisma.reportMerge.findMany({
      where: { OR: [{ sourceReportId: reportId }, { targetReportId: reportId }] },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listDuplicates(admin: CurrentUserDto, query: PageQueryDto) {
    const { page, limit, skip } = this.paging(query);
    const windowSec = 72 * 3600;
    const degrees = 0.0045; // ≈ 0.5 km
    const standardOnly = this.isSuperAdmin(admin)
      ? Prisma.sql`TRUE`
      : Prisma.sql`(a."sensitivity"::text = 'STANDARD' AND b."sensitivity"::text = 'STANDARD')`;

    const rows = await this.prisma.$queryRaw<
      Array<{
        aId: string;
        aRef: string;
        bId: string;
        bRef: string;
        category: string;
        reason: string;
        gapHours: number;
      }>
    >`
      SELECT a.id AS "aId", a."caseReference" AS "aRef",
             b.id AS "bId", b."caseReference" AS "bRef",
             a.category::text AS category,
             CASE WHEN a."userId" IS NOT NULL AND a."userId" = b."userId"
                  THEN 'SAME_REPORTER' ELSE 'NEARBY_LOCATION' END AS reason,
             ROUND((ABS(EXTRACT(EPOCH FROM (a."createdAt" - b."createdAt"))) / 3600)::numeric, 1)::float AS "gapHours"
      FROM ${REPORT_TABLE} a
      JOIN ${REPORT_TABLE} b
        ON a.id < b.id
       AND a.category = b.category
       AND ABS(EXTRACT(EPOCH FROM (a."createdAt" - b."createdAt"))) <= ${windowSec}
       AND (
            (a."userId" IS NOT NULL AND a."userId" = b."userId")
         OR (a.latitude IS NOT NULL AND b.latitude IS NOT NULL
             AND ABS(a.latitude - b.latitude) <= ${degrees}
             AND ABS(a.longitude - b.longitude) <= ${degrees})
       )
      WHERE a."deletedAt" IS NULL AND b."deletedAt" IS NULL
        AND a."mergedIntoId" IS NULL AND b."mergedIntoId" IS NULL
        AND a.status::text NOT IN ('CLOSED','REJECTED')
        AND b.status::text NOT IN ('CLOSED','REJECTED')
        AND ${standardOnly}
        AND NOT EXISTS (
          SELECT 1 FROM report_link l
          WHERE l."recordType"::text = 'REPORT'
            AND ((l."reportId" = a.id AND l."recordId" = b.id)
              OR (l."reportId" = b.id AND l."recordId" = a.id))
        )
      ORDER BY GREATEST(a."createdAt", b."createdAt") DESC
      LIMIT ${limit + 1} OFFSET ${skip}
    `;

    return {
      items: rows.slice(0, limit),
      page,
      limit,
      hasMore: rows.length > limit,
    };
  }

  async split(admin: CurrentUserDto, reportId: string, dto: SplitReportDto) {
    const source = await this.loadForAdminWrite(admin, reportId, act('REPORT_SPLIT'));

    const evidenceIds = [...new Set(dto.evidenceIds ?? [])];
    const evidence = evidenceIds.length
      ? await this.prisma.reportEvidence.findMany({
          where: { id: { in: evidenceIds }, reportId, removedAt: null },
        })
      : [];
    if (evidence.length !== evidenceIds.length) {
      throw new BadRequestException('evidence_not_on_report');
    }

    const sourceMedia: MediaBearing = {
      photo: [...source.photo],
      video: [...source.video],
      audio: [...source.audio],
      pdf: [...source.pdf],
      document: [...source.document],
      other: [...source.other],
    };
    const newMedia: MediaBearing = {
      photo: [],
      video: [],
      audio: [],
      pdf: [],
      document: [],
      other: [],
    };
    let movedBytes = 0;
    for (const e of evidence) {
      const field = this.fieldForKind(e.kind);
      sourceMedia[field] = sourceMedia[field].filter((k) => k !== e.storageKey);
      newMedia[field].push(e.storageKey);
      movedBytes += e.sizeBytes ?? 0;
    }

    let caseReference = this.generateCaseReference();
    for (let i = 0; i < CASE_REFERENCE_MAX_ATTEMPTS; i++) {
      const clash = await this.prisma.report.findUnique({
        where: { caseReference },
        select: { id: true },
      });
      if (!clash) break;
      caseReference = this.generateCaseReference();
    }

    const now = new Date();
    const created = await this.prisma.$transaction(async (tx) => {
      const child = await tx.report.create({
        data: {
          userId: source.userId,
          caseReference,
          category: source.category,
          description: dto.description,
          location: source.location,
          incidentAt: source.incidentAt,
          channel: source.channel,
          status: ReportStatus.PENDING,
          priority: source.priority,
          sensitivity: source.sensitivity,
          region: source.region,
          isAnonymous: source.isAnonymous,
          contactMethod: source.contactMethod,
          contactWindow: source.contactWindow,
          latitude: source.latitude,
          longitude: source.longitude,
          locationAccuracyMeters: source.locationAccuracyMeters,
          locationCapturedAt: source.locationCapturedAt,
          locationAddress: source.locationAddress,
          splitFromId: source.id,
          ...newMedia,
          mediaTotalBytes: movedBytes,
        },
      });

      if (evidence.length) {
        await tx.reportEvidence.updateMany({
          where: { id: { in: evidenceIds } },
          data: { reportId: child.id },
        });
        await tx.reportEvidenceCustody.createMany({
          data: evidence.map((e) => ({
            evidenceId: e.id,
            action: 'MOVED',
            actorId: admin.id,
            note: `split_from:${source.caseReference}`,
          })),
        });
        await tx.report.update({
          where: { id: source.id },
          data: {
            ...sourceMedia,
            mediaTotalBytes: Math.max(0, source.mediaTotalBytes - movedBytes),
          },
        });
      }

      await tx.report.update({ where: { id: source.id }, data: { lastActivityAt: now } });
      await tx.reportStatusHistory.create({
        data: {
          reportId: child.id,
          fromStatus: null,
          toStatus: ReportStatus.PENDING,
          changedById: admin.id,
          note: `split_from:${source.caseReference}`,
        },
      });
      await tx.reportRevision.create({
        data: {
          reportId: source.id,
          editedById: admin.id,
          changes: {
            split: { to: child.id, caseReference: child.caseReference, movedEvidence: evidenceIds },
            ...(dto.reason ? { reason: dto.reason } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      return child;
    });

    this.audit(
      admin,
      act('REPORT_SPLIT'),
      source,
      {
        result: 'success',
        newReportId: created.id,
        newCaseReference: created.caseReference,
        movedEvidence: evidenceIds.length,
      },
      { reason: dto.reason ?? null },
    );
    return created;
  }

  private slaInfo(r: {
    dueAt: Date | null;
    createdAt: Date;
    status: ReportStatus;
    closedAt: Date | null;
    firstRespondedAt: Date | null;
  }) {
    const now = Date.now();
    const closed = TERMINAL_STATUSES.includes(r.status);
    const due = r.dueAt?.getTime() ?? null;
    const endedAt = closed ? (r.closedAt?.getTime() ?? now) : null;
    const total = due ? due - r.createdAt.getTime() : null;
    const elapsed = (endedAt ?? now) - r.createdAt.getTime();

    return {
      dueAt: r.dueAt,
      hasDeadline: due !== null,
      state:
        due === null
          ? 'NO_DEADLINE'
          : closed
            ? endedAt! <= due
              ? 'MET'
              : 'BREACHED'
            : now > due
              ? 'BREACHED'
              : 'RUNNING',
      hoursRemaining: due && !closed ? Math.round(((due - now) / 3600000) * 10) / 10 : null,
      percentElapsed:
        total && total > 0 ? Math.min(100, Math.round((elapsed / total) * 100)) : null,
      firstRespondedAt: r.firstRespondedAt,
      hoursToFirstResponse: r.firstRespondedAt
        ? Math.round(((r.firstRespondedAt.getTime() - r.createdAt.getTime()) / 3600000) * 10) / 10
        : null,
    };
  }

  // RPT-45 GET /reports/sla/breaching
  async listSlaBreaching(admin: CurrentUserDto, query: SlaBreachingQueryDto) {
    const horizon = new Date(Date.now() + (query.withinHours ?? 24) * 3600000);
    const list = await this.pagedReports(
      admin,
      {
        deletedAt: null,
        archivedAt: null,
        status: { notIn: TERMINAL_STATUSES },
        dueAt: { not: null, lte: horizon },
      },
      query,
      { dueAt: 'asc' },
    );
    return {
      ...list,
      items: list.items.map((r) => ({ ...r, sla: this.slaInfo(r) })),
    };
  }

  // RPT-46 GET /reports/:id/sla
  async getSla(admin: CurrentUserDto, reportId: string) {
    const report = await this.loadForAdmin(admin, reportId);
    return { id: report.id, caseReference: report.caseReference, ...this.slaInfo(report) };
  }

  // RPT-47 PATCH /reports/:id/due-date
  async setDueDate(admin: CurrentUserDto, reportId: string, dto: SetDueDateDto) {
    const existing = await this.loadForAdminWrite(admin, reportId, act('REPORT_DUE_DATE_CHANGED'));
    const dueAt = new Date(dto.dueAt);
    if (dueAt.getTime() <= Date.now())
      throw new BadRequestException('due_date_must_be_in_the_future');

    const [report] = await this.prisma.$transaction([
      this.prisma.report.update({
        where: { id: reportId },
        data: { dueAt, lastActivityAt: new Date() },
      }),
      this.revision(reportId, admin.id, {
        dueAt: { from: existing.dueAt?.toISOString() ?? null, to: dueAt.toISOString() },
        ...(dto.reason ? { reason: dto.reason } : {}),
      }),
    ]);
    this.audit(
      admin,
      act('REPORT_DUE_DATE_CHANGED'),
      report,
      {
        result: 'success',
        from: existing.dueAt,
        to: dueAt,
      },
      { reason: dto.reason ?? null },
    );
    return report;
  }

  // RPT-48 POST /reports/:id/follow-up
  async createFollowUp(admin: CurrentUserDto, reportId: string, dto: CreateFollowUpDto) {
    await this.loadForAdmin(admin, reportId);
    const remindAt = new Date(dto.remindAt);
    if (remindAt.getTime() <= Date.now()) {
      throw new BadRequestException('remind_at_must_be_in_the_future');
    }
    return this.prisma.reportFollowUp.create({
      data: { reportId, adminId: admin.id, remindAt, note: dto.note ?? null },
    });
  }

  // RPT-49 GET /reports/follow-ups   (my reminders that are due)
  async listFollowUps(admin: CurrentUserDto, query: FollowUpsQueryDto) {
    const { page, limit, skip, take } = this.paging(query);
    const where: Prisma.ReportFollowUpWhereInput = {
      adminId: admin.id,
      doneAt: null,
      remindAt: { lte: query.dueBefore ? new Date(query.dueBefore) : new Date() },
      report: { AND: [{ deletedAt: null }, this.visibilityWhere(admin)] },
    };
    const [items, total] = await Promise.all([
      this.prisma.reportFollowUp.findMany({
        where,
        orderBy: { remindAt: 'asc' },
        skip,
        take,
        include: {
          report: { select: { id: true, caseReference: true, status: true, priority: true } },
        },
      }),
      this.prisma.reportFollowUp.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  private normalizeTags(tags: string[]): string[] {
    const cleaned = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
    for (const t of cleaned) {
      if (t.length > 40) throw new BadRequestException(`tag_too_long:${t.slice(0, 20)}`);
    }
    return [...new Set(cleaned)];
  }

  private async tagIdsFor(names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) {
      const tag = await this.prisma.reportTag.upsert({
        where: { name },
        create: { name },
        update: {},
        select: { id: true },
      });
      ids.push(tag.id);
    }
    return ids;
  }

  // RPT-57 POST /reports/:id/tags
  async addTags(admin: CurrentUserDto, reportId: string, dto: AddReportTagsDto) {
    const report = await this.loadForAdmin(admin, reportId);
    const names = this.normalizeTags(dto.tags);
    if (!names.length) throw new BadRequestException('no_tags_provided');

    const tagIds = await this.tagIdsFor(names);
    await this.prisma.reportTagOnReport.createMany({
      data: tagIds.map((tagId) => ({ reportId, tagId, addedById: admin.id })),
      skipDuplicates: true,
    });
    this.audit(admin, act('REPORT_TAGS_CHANGED'), report, { result: 'success', added: names });

    return this.prisma.reportTagOnReport.findMany({
      where: { reportId },
      include: { tag: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // RPT-58 DELETE /reports/:id/tags/:tagId
  async removeTag(admin: CurrentUserDto, reportId: string, tagId: string) {
    const report = await this.loadForAdmin(admin, reportId);
    const res = await this.prisma.reportTagOnReport.deleteMany({ where: { reportId, tagId } });
    if (res.count === 0) throw new NotFoundException('tag_not_on_report');
    this.audit(admin, act('REPORT_TAGS_CHANGED'), report, {
      result: 'success',
      removedTagId: tagId,
    });
    return { deleted: true };
  }

  // RPT-59 PATCH /reports/bulk/tags
  async bulkTag(admin: CurrentUserDto, dto: BulkTagReportsDto) {
    const add = this.normalizeTags(dto.addTags ?? []);
    const remove = this.normalizeTags(dto.removeTags ?? []);
    if (!add.length && !remove.length) throw new BadRequestException('no_tags_provided');

    const ids = [...new Set(dto.ids)];
    const visible = await this.prisma.report.findMany({
      where: { AND: [{ id: { in: ids }, deletedAt: null }, this.visibilityWhere(admin)] },
      select: { id: true },
    });
    const visibleIds = visible.map((r) => r.id);

    if (add.length && visibleIds.length) {
      const tagIds = await this.tagIdsFor(add);
      await this.prisma.reportTagOnReport.createMany({
        data: visibleIds.flatMap((reportId) =>
          tagIds.map((tagId) => ({ reportId, tagId, addedById: admin.id })),
        ),
        skipDuplicates: true,
      });
    }
    if (remove.length && visibleIds.length) {
      await this.prisma.reportTagOnReport.deleteMany({
        where: { reportId: { in: visibleIds }, tag: { name: { in: remove } } },
      });
    }

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: act('REPORT_BULK_ACTION'),
      entity: 'Report',
      entityId: 'bulk',
      diff: { op: 'tags', reports: visibleIds.length, added: add, removed: remove },
    });

    const found = new Set(visibleIds);
    return {
      requested: ids.length,
      updated: visibleIds.length,
      notFound: ids.filter((i) => !found.has(i)),
    };
  }

  // RPT-60 POST /reports/:id/watch
  async watch(admin: CurrentUserDto, reportId: string) {
    await this.loadForAdmin(admin, reportId);
    await this.prisma.reportWatcher.upsert({
      where: { reportId_adminId: { reportId, adminId: admin.id } },
      create: { reportId, adminId: admin.id },
      update: {},
    });
    return { id: reportId, watching: true };
  }

  // RPT-61 DELETE /reports/:id/watch
  async unwatch(admin: CurrentUserDto, reportId: string) {
    await this.prisma.reportWatcher.deleteMany({ where: { reportId, adminId: admin.id } });
    return { id: reportId, watching: false };
  }

  // RPT-62 GET /reports/watching
  async listWatching(admin: CurrentUserDto, query: PageQueryDto) {
    return this.pagedReports(
      admin,
      { deletedAt: null, watchers: { some: { adminId: admin.id } } },
      query,
      { lastActivityAt: 'desc' },
    );
  }

  // RPT-63 GET /reports/views
  async listViews(admin: CurrentUserDto) {
    return this.prisma.reportSavedView.findMany({
      where: { adminId: admin.id },
      orderBy: { name: 'asc' },
    });
  }

  // RPT-64 POST /reports/views
  async saveView(admin: CurrentUserDto, dto: SaveReportViewDto) {
    try {
      return await this.prisma.reportSavedView.create({
        data: {
          adminId: admin.id,
          name: dto.name.trim(),
          filters: dto.filters as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('view_name_already_used');
      }
      throw err;
    }
  }

  // RPT-65 PATCH /reports/views/:id
  async updateView(admin: CurrentUserDto, viewId: string, dto: UpdateReportViewDto) {
    const existing = await this.prisma.reportSavedView.findFirst({
      where: { id: viewId, adminId: admin.id },
    });
    if (!existing) throw new NotFoundException('view_not_found');

    try {
      return await this.prisma.reportSavedView.update({
        where: { id: viewId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.filters !== undefined ? { filters: dto.filters as Prisma.InputJsonValue } : {}),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('view_name_already_used');
      }
      throw err;
    }
  }

  // RPT-66 DELETE /reports/views/:id
  async deleteView(admin: CurrentUserDto, viewId: string) {
    const res = await this.prisma.reportSavedView.deleteMany({
      where: { id: viewId, adminId: admin.id },
    });
    if (res.count === 0) throw new NotFoundException('view_not_found');
    return { deleted: true };
  }

  // Evidence added at submission lives only in the media arrays. Custody, redaction and
  // removal need a row, so one is created lazily the first time it is needed.
  private async ensureEvidenceRow(report: Report, key: string) {
    const row = await this.prisma.reportEvidence.findFirst({
      where: { reportId: report.id, storageKey: key },
    });
    if (row) return row;

    const field = MEDIA_FIELD_NAMES.find((f) => report[f].includes(key));
    if (!field) throw new NotFoundException('evidence_not_found');

    let mimeType: string | null = null;
    let sizeBytes: number | null = null;
    try {
      const stat = await this.minioService.statObject(key);
      mimeType = stat.contentType ?? null;
      sizeBytes = stat.size;
    } catch {
      /* object metadata is best-effort */
    }

    return this.prisma.reportEvidence.create({
      data: {
        reportId: report.id,
        kind: field.toUpperCase() as ReportEvidenceKind,
        storageKey: key,
        mimeType,
        sizeBytes,
        addedById: report.userId,
        custody: {
          create: { action: 'ADDED', actorId: report.userId, note: 'initial_submission' },
        },
      },
    });
  }

  // RPT-82 GET /reports/:id/evidence   (Admin, or the reporter for their own report)
  async listEvidence(user: CurrentUserDto, reportId: string) {
    const isAdmin = this.isAdminUser(user);
    const report = isAdmin
      ? await this.loadForAdmin(user, reportId)
      : await this.loadOwned(user, reportId);

    const items = await this.prisma.reportEvidence.findMany({
      where: { reportId, removedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        kind: true,
        storageKey: true,
        mimeType: true,
        sizeBytes: true,
        sha256: true,
        note: true,
        createdAt: true,
        redactedAt: true,
        ...(isAdmin ? { redactedStorageKey: true, redactionReason: true, addedById: true } : {}),
      },
    });

    const tracked = new Set(items.map((i) => i.storageKey));
    const submittedWithReport = MEDIA_FIELD_NAMES.flatMap((field) =>
      report[field].filter((k) => !tracked.has(k)).map((k) => ({ field, storageKey: k })),
    );

    return { items, submittedWithReport };
  }

  // RPT-83 DELETE /reports/:id/evidence/:key   (soft removal; custody survives)
  async removeEvidence(
    admin: CurrentUserDto,
    reportId: string,
    key: string,
    dto: EvidenceRemovalQueryDto,
    ctx?: RequestCtx,
  ) {
    const report = await this.loadForAdminWrite(admin, reportId, act('REPORT_EVIDENCE_REMOVED'));
    if (report.legalHold) throw new ForbiddenException('report_under_legal_hold');

    const evidence = await this.ensureEvidenceRow(report, key);
    if (evidence.removedAt) throw new BadRequestException('evidence_already_removed');

    const next: MediaBearing = {
      photo: report.photo.filter((k) => k !== key),
      video: report.video.filter((k) => k !== key),
      audio: report.audio.filter((k) => k !== key),
      pdf: report.pdf.filter((k) => k !== key),
      document: report.document.filter((k) => k !== key),
      other: report.other.filter((k) => k !== key),
    };

    await this.prisma.$transaction([
      this.prisma.reportEvidence.update({
        where: { id: evidence.id },
        data: { removedAt: new Date(), removedById: admin.id, removalReason: dto.reason },
      }),
      this.prisma.reportEvidenceCustody.create({
        data: {
          evidenceId: evidence.id,
          action: 'REMOVED',
          actorId: admin.id,
          note: dto.reason,
          ipAddress: ctx?.ip ?? null,
        },
      }),
      this.prisma.report.update({
        where: { id: reportId },
        data: {
          ...next,
          mediaTotalBytes: Math.max(0, report.mediaTotalBytes - (evidence.sizeBytes ?? 0)),
          lastActivityAt: new Date(),
        },
      }),
    ]);
    // The MinIO object is intentionally kept: custody and legal discovery need it.

    this.audit(
      admin,
      act('REPORT_EVIDENCE_REMOVED'),
      report,
      { result: 'success', key },
      {
        reason: dto.reason,
        severity: AuditSeverity.WARNING,
      },
    );
    return { removed: true, evidenceId: evidence.id };
  }

  // RPT-84 GET /reports/:id/evidence/:key/custody
  async getEvidenceCustody(admin: CurrentUserDto, reportId: string, key: string) {
    const report = await this.loadForAdmin(admin, reportId);
    const evidence = await this.ensureEvidenceRow(report, key);
    const entries = await this.prisma.reportEvidenceCustody.findMany({
      where: { evidenceId: evidence.id },
      orderBy: { createdAt: 'asc' },
    });
    return { evidenceId: evidence.id, storageKey: key, entries };
  }

  async redactEvidence(
    admin: CurrentUserDto,
    reportId: string,
    key: string,
    dto: RedactEvidenceDto,
    ctx?: RequestCtx,
  ) {
    const report = await this.loadForAdminWrite(admin, reportId, act('REPORT_EVIDENCE_REDACTED'));
    const evidence = await this.ensureEvidenceRow(report, key);
    if (evidence.removedAt) throw new BadRequestException('evidence_already_removed');

    const updated = await this.prisma.reportEvidence.update({
      where: { id: evidence.id },
      data: {
        redactedAt: new Date(),
        redactedById: admin.id,
        redactionReason: dto.reason,
        redactedRegions: (dto.regions ?? null) as Prisma.InputJsonValue,
        redactedStorageKey: null,
        custody: {
          create: {
            action: 'REDACTED',
            actorId: admin.id,
            note: dto.reason,
            ipAddress: ctx?.ip ?? null,
          },
        },
      },
    });

    this.audit(
      admin,
      act('REPORT_EVIDENCE_REDACTED'),
      report,
      { result: 'success', key },
      {
        reason: dto.reason,
      },
    );
    this.eventEmitter.emit(NEW_EVENTS.EVIDENCE_REDACTION_REQUESTED, {
      reportId,
      evidenceId: evidence.id,
      storageKey: key,
      regions: dto.regions ?? null,
    });

    return {
      evidenceId: updated.id,
      redactedAt: updated.redactedAt,
      redactedStorageKey: updated.redactedStorageKey,
      processing: updated.redactedStorageKey == null,
    };
  }

  // RPT-86 GET /reports/:id/case-file   (printable PDF)
  async getCaseFile(admin: CurrentUserDto, reportId: string, ctx?: RequestCtx) {
    const report = await this.loadForAdmin(admin, reportId);

    const [messages, history, escalations, infoRequests, evidence, merges] = await Promise.all([
      this.prisma.reportMessage.findMany({ where: { reportId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.reportStatusHistory.findMany({
        where: { reportId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.reportEscalation.findMany({ where: { reportId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.reportInformationRequest.findMany({
        where: { reportId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.reportEvidence.findMany({ where: { reportId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.reportMerge.findMany({
        where: { OR: [{ sourceReportId: reportId }, { targetReportId: reportId }] },
      }),
    ]);

    const iso = (d?: Date | null) => (d ? d.toISOString() : '-');
    const lines = [
      `Case reference: ${report.caseReference}`,
      `Status: ${report.status}    Priority: ${report.priority}    Sensitivity: ${report.sensitivity}`,
      `Category: ${report.category}    Channel: ${report.channel}`,
      `Reporter: ${report.isAnonymous ? 'Anonymous (identity withheld)' : (report.userId ?? 'unknown')}`,
      `Submitted: ${iso(report.createdAt)}    Incident: ${iso(report.incidentAt)}`,
      `Location (as typed): ${report.location ?? '-'}`,
      `Due: ${iso(report.dueAt)}    Closed: ${iso(report.closedAt)}`,
      report.resolutionOutcome
        ? `Resolution: ${report.resolutionOutcome} - ${report.resolutionSummary ?? ''}`
        : '',
      report.integrityFlag
        ? `Integrity flag: ${report.integrityFlag} (${report.integrityReason ?? '-'})`
        : '',
      report.legalHold ? `LEGAL HOLD: ${report.legalHoldReason ?? '-'}` : '',
      '',
      'DESCRIPTION',
      ...report.description.split('\n'),
      '',
      `STATUS HISTORY (${history.length})`,
      ...history.map(
        (h) => `  ${iso(h.createdAt)}  ${h.fromStatus ?? '-'} -> ${h.toStatus}  ${h.note ?? ''}`,
      ),
      '',
      `ESCALATIONS (${escalations.length})`,
      ...escalations.map(
        (e) =>
          `  ${iso(e.createdAt)}  ${e.reason}${e.deEscalatedAt ? `  [de-escalated ${iso(e.deEscalatedAt)}]` : ''}`,
      ),
      '',
      `INFORMATION REQUESTS (${infoRequests.length})`,
      ...infoRequests.flatMap((r) => [
        `  ${iso(r.createdAt)}  [${r.status}]  ${r.message}`,
        ...(r.responseMessage
          ? [`      Response ${iso(r.respondedAt)}: ${r.responseMessage}`]
          : []),
      ]),
      '',
      `MESSAGES (${messages.length})`,
      ...messages.map((m) => `  ${iso(m.createdAt)}  ${m.authorType}: ${m.message}`),
      '',
      `EVIDENCE (${evidence.length})`,
      ...evidence.map(
        (e) =>
          `  ${e.kind}  ${e.storageKey}  sha256=${e.sha256 ?? '-'}${e.removedAt ? '  [REMOVED]' : ''}${e.redactedAt ? '  [REDACTED]' : ''}`,
      ),
      '',
      `MERGES (${merges.length})`,
      ...merges.map(
        (m) =>
          `  ${iso(m.createdAt)}  ${m.sourceReportId} -> ${m.targetReportId}${m.unmergedAt ? '  [undone]' : ''}`,
      ),
      '',
      `Generated ${new Date().toISOString()} by admin ${admin.id}`,
    ].filter((l, i, arr) => !(l === '' && arr[i - 1] === ''));

    await this.logAccess(reportId, admin.id, 'CASE_FILE', ctx);
    this.audit(
      admin,
      act('REPORT_CASE_FILE_GENERATED'),
      report,
      { result: 'success' },
      {
        targetUserId: report.isAnonymous ? null : report.userId,
      },
    );

    const buffer = await this.renderPdf(`CASE FILE ${report.caseReference}`, lines);
    return {
      buffer,
      filename: `case-file-${report.caseReference}.pdf`,
      contentType: 'application/pdf',
    };
  }

  private async loadInfoRequest(reportId: string, requestId: string) {
    const request = await this.prisma.reportInformationRequest.findFirst({
      where: { id: requestId, reportId },
    });
    if (!request) throw new NotFoundException('information_request_not_found');
    return request;
  }

  // RPT-87 GET /reports/information-requests/pending
  async listPendingInformationRequests(
    admin: CurrentUserDto,
    query: PendingInformationRequestsQueryDto,
  ) {
    const { page, limit, skip, take } = this.paging(query);
    const where: Prisma.ReportInformationRequestWhereInput = {
      status: InformationRequestStatus.PENDING,
      ...(query.overdueOnly ? { dueAt: { lt: new Date() } } : {}),
      report: { AND: [{ deletedAt: null }, this.visibilityWhere(admin)] },
    };

    const [rows, total] = await Promise.all([
      this.prisma.reportInformationRequest.findMany({
        where,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        skip,
        take,
        include: {
          report: { select: { id: true, caseReference: true, status: true, assignedToId: true } },
        },
      }),
      this.prisma.reportInformationRequest.count({ where }),
    ]);

    const now = Date.now();
    return {
      items: rows.map((r) => ({ ...r, isOverdue: r.dueAt ? r.dueAt.getTime() < now : false })),
      total,
      page,
      limit,
    };
  }

  // RPT-89 PATCH /reports/:id/information-requests/:requestId/cancel
  async cancelInformationRequest(
    admin: CurrentUserDto,
    reportId: string,
    requestId: string,
    dto: CancelInformationRequestDto,
  ) {
    const report = await this.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_INFO_REQUEST_CHANGED'),
    );
    const request = await this.loadInfoRequest(reportId, requestId);
    if (request.status !== InformationRequestStatus.PENDING) {
      throw new BadRequestException('only_pending_requests_can_be_cancelled');
    }

    const updated = await this.prisma.reportInformationRequest.update({
      where: { id: requestId },
      data: {
        status: InformationRequestStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledById: admin.id,
        cancelReason: dto.reason ?? null,
      },
    });
    this.audit(
      admin,
      act('REPORT_INFO_REQUEST_CHANGED'),
      report,
      {
        result: 'success',
        op: 'cancel',
        requestId,
      },
      { reason: dto.reason ?? null },
    );
    return updated;
  }

  // RPT-90 POST /reports/:id/information-requests/:requestId/remind
  async remindInformationRequest(admin: CurrentUserDto, reportId: string, requestId: string) {
    const report = await this.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_INFO_REQUEST_CHANGED'),
    );
    const request = await this.loadInfoRequest(reportId, requestId);
    if (request.status !== InformationRequestStatus.PENDING) {
      throw new BadRequestException('only_pending_requests_can_be_reminded');
    }

    const minHours = Number(this.configService.get<string>('REPORT_INFO_REMINDER_MIN_HOURS') ?? 24);
    if (request.remindedAt && Date.now() - request.remindedAt.getTime() < minHours * 3600000) {
      throw new BadRequestException('reminder_sent_too_recently');
    }

    const updated = await this.prisma.reportInformationRequest.update({
      where: { id: requestId },
      data: { remindedAt: new Date(), remindCount: { increment: 1 } },
    });

    this.audit(admin, act('REPORT_INFO_REQUEST_CHANGED'), report, {
      result: 'success',
      op: 'remind',
      requestId,
    });
    this.eventEmitter.emit(NEW_EVENTS.INFORMATION_REMINDER, {
      reportId,
      caseReference: report.caseReference,
      informationRequestId: requestId,
      userId: report.userId,
      message: request.message,
    });
    return updated;
  }

  // RPT-91 PATCH /reports/:id/information-requests/:requestId/extend
  async extendInformationRequest(
    admin: CurrentUserDto,
    reportId: string,
    requestId: string,
    dto: ExtendInformationRequestDto,
  ) {
    const report = await this.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_INFO_REQUEST_CHANGED'),
    );
    const request = await this.loadInfoRequest(reportId, requestId);
    if (request.status !== InformationRequestStatus.PENDING) {
      throw new BadRequestException('only_pending_requests_can_be_extended');
    }

    const dueAt = new Date(dto.dueAt);
    if (dueAt.getTime() <= Date.now())
      throw new BadRequestException('due_date_must_be_in_the_future');
    if (request.dueAt && dueAt.getTime() <= request.dueAt.getTime()) {
      throw new BadRequestException('new_due_date_must_be_later_than_current');
    }

    const updated = await this.prisma.reportInformationRequest.update({
      where: { id: requestId },
      data: { dueAt },
    });
    this.audit(
      admin,
      act('REPORT_INFO_REQUEST_CHANGED'),
      report,
      {
        result: 'success',
        op: 'extend',
        requestId,
        from: request.dueAt,
        to: dueAt,
      },
      { reason: dto.reason ?? null },
    );
    return updated;
  }

  async reviewInformationResponse(
    admin: CurrentUserDto,
    reportId: string,
    requestId: string,
    dto: ReviewInformationResponseDto,
  ) {
    const report = await this.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_INFO_REQUEST_CHANGED'),
    );
    const request = await this.loadInfoRequest(reportId, requestId);
    if (request.status !== InformationRequestStatus.RESPONDED) {
      throw new BadRequestException('request_has_no_response_to_review');
    }

    const accept = dto.decision === 'ACCEPT';
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.reportInformationRequest.update({
        where: { id: requestId },
        data: {
          status: accept ? InformationRequestStatus.ACCEPTED : InformationRequestStatus.PENDING,
          reviewedAt: now,
          reviewedById: admin.id,
          reviewNote: dto.note ?? null,
        },
      });
      await tx.report.update({
        where: { id: reportId },
        data: {
          lastActivityAt: now,
          reporterUpdatedAt: now,
          firstRespondedAt: report.firstRespondedAt ?? now,
        },
      });
      return u;
    });

    this.audit(
      admin,
      act('REPORT_INFO_REQUEST_CHANGED'),
      report,
      {
        result: 'success',
        op: 'review',
        decision: dto.decision,
        requestId,
      },
      { reason: dto.note ?? null },
    );
    this.eventEmitter.emit(NEW_EVENTS.INFORMATION_REVIEWED, {
      reportId,
      caseReference: report.caseReference,
      informationRequestId: requestId,
      userId: report.userId,
      decision: dto.decision,
      note: dto.note ?? null,
    });
    return updated;
  }

  // RPT-104 PATCH /reports/:id/sensitivity
  async updateSensitivity(
    admin: CurrentUserDto,
    reportId: string,
    dto: UpdateReportSensitivityDto,
  ) {
    const existing = await this.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_SENSITIVITY_CHANGED'),
    );
    if (existing.sensitivity === dto.level) return existing;

    const [report] = await this.prisma.$transaction([
      this.prisma.report.update({
        where: { id: reportId },
        data: { sensitivity: dto.level as ReportSensitivity, lastActivityAt: new Date() },
      }),
      this.revision(reportId, admin.id, {
        sensitivity: { from: existing.sensitivity, to: dto.level },
        reason: dto.reason,
      }),
    ]);
    this.audit(
      admin,
      act('REPORT_SENSITIVITY_CHANGED'),
      report,
      {
        result: 'success',
        from: existing.sensitivity,
        to: dto.level,
      },
      { reason: dto.reason, severity: AuditSeverity.WARNING },
    );
    return report;
  }

  // RPT-105 GET /reports/:id/access-log   (Super Admin)
  async getAccessLog(admin: CurrentUserDto, reportId: string, query: PageQueryDto) {
    await this.loadForAdmin(admin, reportId, { includeDeleted: true });
    const { page, limit, skip, take } = this.paging(query);
    const where = { reportId };

    const [rows, total] = await Promise.all([
      this.prisma.reportAccessLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.reportAccessLog.count({ where }),
    ]);

    const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    return {
      items: rows.map((r) => ({ ...r, userName: r.userId ? (names.get(r.userId) ?? null) : null })),
      total,
      page,
      limit,
    };
  }

  // RPT-106 GET /reports/:id/access-grants
  async listAccessGrants(admin: CurrentUserDto, reportId: string) {
    await this.loadForAdmin(admin, reportId);
    const grants = await this.prisma.reportAccessGrant.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
      include: { admin: { select: { id: true, name: true } } },
    });
    const now = Date.now();
    return grants.map((g) => ({
      ...g,
      isActive: !g.revokedAt && (!g.expiresAt || g.expiresAt.getTime() > now),
    }));
  }

  // RPT-107 POST /reports/:id/access-grants
  async grantAccess(admin: CurrentUserDto, reportId: string, dto: GrantReportAccessDto) {
    const report = await this.loadForAdmin(admin, reportId);

    const target = await this.prisma.user.findUnique({
      where: { id: dto.adminId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!target) throw new NotFoundException('assignee_not_found');
    if (!target.userRoles.some((ur) => ADMIN_ROLE_NAMES.includes(ur.role.name as RolesEnum))) {
      throw new BadRequestException('grantee_must_be_an_admin');
    }

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('expiry_must_be_in_the_future');
    }

    const active = await this.prisma.reportAccessGrant.findFirst({
      where: { reportId, ...this.activeGrantWhere(dto.adminId) },
    });
    if (active) throw new ConflictException('access_already_granted');

    const grant = await this.prisma.reportAccessGrant.create({
      data: {
        reportId,
        adminId: dto.adminId,
        grantedById: admin.id,
        reason: dto.reason,
        expiresAt,
      },
    });
    this.audit(
      admin,
      act('REPORT_ACCESS_GRANTED'),
      report,
      {
        result: 'success',
        grantedTo: dto.adminId,
        expiresAt,
      },
      { reason: dto.reason, targetUserId: dto.adminId, severity: AuditSeverity.WARNING },
    );
    return grant;
  }

  // RPT-108 DELETE /reports/:id/access-grants/:adminId
  async revokeAccess(admin: CurrentUserDto, reportId: string, adminId: string) {
    const report = await this.loadForAdmin(admin, reportId);
    const res = await this.prisma.reportAccessGrant.updateMany({
      where: { reportId, adminId, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: admin.id },
    });
    if (res.count === 0) throw new NotFoundException('access_grant_not_found');
    this.audit(
      admin,
      act('REPORT_ACCESS_REVOKED'),
      report,
      {
        result: 'success',
        revokedFrom: adminId,
      },
      { targetUserId: adminId },
    );
    return { revoked: res.count };
  }

  // RPT-109 POST /reports/:id/reveal-reporter   (break-glass, Super Admin)
  // The reveal is written first and cannot be skipped; the identity is only returned after.
  async revealReporter(
    admin: CurrentUserDto,
    reportId: string,
    dto: RevealReporterDto,
    ctx?: RequestCtx,
  ) {
    const report = await this.loadForAdmin(admin, reportId);
    if (!report.userId) throw new NotFoundException('reporter_unknown');

    await this.prisma.reportReporterReveal.create({
      data: {
        reportId,
        revealedById: admin.id,
        reason: dto.reason,
        ticketRef: dto.ticketRef ?? null,
      },
    });
    await this.logAccess(reportId, admin.id, 'REPORTER_REVEAL', ctx);

    const reporter = await this.prisma.user.findUnique({
      where: { id: report.userId },
      select: { id: true, name: true, phone: true },
    });

    this.audit(
      admin,
      act('REPORTER_REVEALED'),
      report,
      {
        result: 'success',
        wasAnonymous: report.isAnonymous,
      },
      {
        reason: dto.reason,
        targetUserId: report.userId,
        severity: AuditSeverity.WARNING,
        metadata: { ticketRef: dto.ticketRef ?? null },
      },
    );

    return { reportId, wasAnonymous: report.isAnonymous, reporter };
  }

  // RPT-110 PATCH /reports/:id/legal-hold
  async setLegalHold(admin: CurrentUserDto, reportId: string, dto: LegalHoldDto) {
    const existing = await this.loadForAdmin(admin, reportId, { includeDeleted: true });
    if (existing.legalHold === dto.enabled) return existing;

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: dto.enabled
        ? {
            legalHold: true,
            legalHoldReason: dto.reason,
            legalHoldAt: new Date(),
            legalHoldById: admin.id,
          }
        : { legalHold: false, legalHoldReason: null, legalHoldAt: null, legalHoldById: null },
    });
    this.audit(
      admin,
      act('REPORT_LEGAL_HOLD_CHANGED'),
      report,
      {
        result: 'success',
        enabled: dto.enabled,
      },
      { reason: dto.reason, severity: AuditSeverity.WARNING },
    );
    return report;
  }

  private normChannel(channel?: string): SubmissionChannel | undefined {
    if (!channel) return undefined;
    const value = channel.trim().toUpperCase();
    if (!(Object.values(SubmissionChannel) as string[]).includes(value)) {
      throw new BadRequestException('invalid_channel');
    }
    return value as SubmissionChannel;
  }

  private statsWhere(q: ReportStatsQueryDto, admin: CurrentUserDto): Prisma.ReportWhereInput {
    const channel = this.normChannel(q.channel);
    const and: Prisma.ReportWhereInput[] = [{ deletedAt: null }, this.visibilityWhere(admin)];
    if (q.from || q.to) {
      and.push({
        createdAt: {
          ...(q.from ? { gte: new Date(q.from) } : {}),
          ...(q.to ? { lte: new Date(q.to) } : {}),
        },
      });
    }
    if (q.status) and.push({ status: q.status });
    if (q.category) and.push({ category: q.category });
    if (channel) and.push({ channel });
    if (q.assignedTo) and.push({ assignedToId: q.assignedTo });
    if (q.region) and.push({ region: q.region });
    return { AND: and };
  }

  private statsFilterSql(q: ReportStatsQueryDto, admin: CurrentUserDto): Prisma.Sql {
    const channel = this.normChannel(q.channel);
    const c: Prisma.Sql[] = [Prisma.sql`r."deletedAt" IS NULL`, this.visibilitySql(admin)];
    if (q.from) c.push(Prisma.sql`r."createdAt" >= ${new Date(q.from)}`);
    if (q.to) c.push(Prisma.sql`r."createdAt" <= ${new Date(q.to)}`);
    if (q.status) c.push(Prisma.sql`r.status::text = ${q.status}`);
    if (q.category) c.push(Prisma.sql`r.category::text = ${q.category}`);
    if (channel) c.push(Prisma.sql`r.channel::text = ${channel}`);
    if (q.assignedTo) c.push(Prisma.sql`r."assignedToId" = ${q.assignedTo}`);
    if (q.region) c.push(Prisma.sql`r.region = ${q.region}`);
    return Prisma.join(c, ' AND ');
  }

  // GP-09 GET /reports/:id/location   (REPORT_LOCATION_READ, audited)
  async getLocation(admin: CurrentUserDto, reportId: string, ctx?: RequestCtx) {
    const report = await this.loadForAdmin(admin, reportId);

    await this.logAccess(reportId, admin.id, 'LOCATION_VIEW', ctx);
    this.audit(
      admin,
      act('REPORT_LOCATION_VIEWED'),
      report,
      {
        result: 'success',
        hasGps: report.latitude != null,
      },
      { targetUserId: report.isAnonymous ? null : report.userId },
    );

    return {
      id: report.id,
      location: report.location,
      latitude: report.latitude,
      longitude: report.longitude,
      accuracyMeters: report.locationAccuracyMeters,
      capturedAt: report.locationCapturedAt,
      address: report.locationAddress,
      verified: report.locationVerified,
      verifiedAt: report.locationVerifiedAt,
      verifiedById: report.locationVerifiedById,
      note: report.locationNote,
    };
  }

  // GP-10 PATCH /reports/:id/location   (correct and/or verify)
  async updateLocation(admin: CurrentUserDto, reportId: string, dto: UpdateReportLocationDto) {
    const existing = await this.loadForAdminWrite(admin, reportId, act('REPORT_LOCATION_CHANGED'));

    if (!dto.gps && dto.verified === undefined && dto.note === undefined) {
      throw new BadRequestException('nothing_to_update');
    }
    const hasLocation = existing.latitude != null || !!dto.gps;
    if (dto.verified === true && !hasLocation)
      throw new BadRequestException('no_location_to_verify');

    const now = new Date();
    const data: Prisma.ReportUncheckedUpdateInput = { lastActivityAt: now };
    if (dto.gps) Object.assign(data, this.gpsData(dto.gps));
    if (dto.verified !== undefined) {
      Object.assign(
        data,
        dto.verified
          ? { locationVerified: true, locationVerifiedAt: now, locationVerifiedById: admin.id }
          : { locationVerified: false, locationVerifiedAt: null, locationVerifiedById: null },
      );
    }
    if (dto.note !== undefined) data.locationNote = dto.note;

    const [report] = await this.prisma.$transaction([
      this.prisma.report.update({ where: { id: reportId }, data }),
      this.revision(reportId, admin.id, {
        location: {
          from: {
            latitude: existing.latitude,
            longitude: existing.longitude,
            verified: existing.locationVerified,
          },
          to: {
            latitude: dto.gps?.latitude ?? existing.latitude,
            longitude: dto.gps?.longitude ?? existing.longitude,
            verified: dto.verified ?? existing.locationVerified,
          },
        },
        ...(dto.note ? { note: dto.note } : {}),
      }),
    ]);

    this.audit(admin, act('REPORT_LOCATION_CHANGED'), report, {
      result: 'success',
      source: 'admin',
      corrected: !!dto.gps,
      verified: dto.verified ?? null,
    });
    return this.getLocationSummary(report);
  }

  private getLocationSummary(report: Report) {
    return {
      id: report.id,
      latitude: report.latitude,
      longitude: report.longitude,
      accuracyMeters: report.locationAccuracyMeters,
      verified: report.locationVerified,
      verifiedAt: report.locationVerifiedAt,
      note: report.locationNote,
    };
  }

  // bbox = "minLng,minLat,maxLng,maxLat"
  private parseBbox(bbox?: string) {
    if (!bbox) return null;
    const p = bbox.split(',').map((v) => Number(v.trim()));
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
      throw new BadRequestException('invalid_bbox');
    }
    const [minLng, minLat, maxLng, maxLat] = p;
    if (minLat > maxLat || minLng > maxLng) throw new BadRequestException('invalid_bbox');
    return { minLng, minLat, maxLng, maxLat };
  }

  // GP-05 GET /reports/map   (clustered pins)
  async getMapPins(admin: CurrentUserDto, query: ReportMapQueryDto) {
    const box = this.parseBbox(query.bbox);
    const zoom = query.zoom ?? 8;
    const cap = Number(this.configService.get<string>('REPORT_MAP_MAX_POINTS') ?? 5000);

    const where: Prisma.ReportWhereInput = {
      AND: [
        this.statsWhere(query, admin),
        { latitude: { not: null }, longitude: { not: null } },
        box
          ? {
              latitude: { gte: box.minLat, lte: box.maxLat },
              longitude: { gte: box.minLng, lte: box.maxLng },
            }
          : {},
      ],
    };

    const rows = await this.prisma.report.findMany({
      where,
      select: {
        id: true,
        caseReference: true,
        latitude: true,
        longitude: true,
        status: true,
        category: true,
        priority: true,
      },
      orderBy: { createdAt: 'desc' },
      take: cap,
    });

    // Grid clustering: cell size halves each zoom level; no clustering from zoom 15
    const cell = zoom >= 15 ? 0 : 360 / Math.pow(2, zoom + 2);
    if (cell === 0) {
      return {
        zoom,
        truncated: rows.length === cap,
        pins: rows.map((r) => ({
          type: 'report' as const,
          id: r.id,
          caseReference: r.caseReference,
          latitude: r.latitude!,
          longitude: r.longitude!,
          status: r.status,
          category: r.category,
          priority: r.priority,
        })),
      };
    }

    const cells = new Map<string, { lat: number; lng: number; ids: string[] }>();
    for (const r of rows) {
      const key = `${Math.floor(r.latitude! / cell)}:${Math.floor(r.longitude! / cell)}`;
      const c = cells.get(key) ?? { lat: 0, lng: 0, ids: [] };
      c.lat += r.latitude!;
      c.lng += r.longitude!;
      c.ids.push(r.id);
      cells.set(key, c);
    }

    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      zoom,
      truncated: rows.length === cap,
      pins: [...cells.values()].map((c) =>
        c.ids.length === 1
          ? {
              type: 'report' as const,
              id: c.ids[0],
              caseReference: byId.get(c.ids[0])!.caseReference,
              latitude: c.lat,
              longitude: c.lng,
              status: byId.get(c.ids[0])!.status,
              category: byId.get(c.ids[0])!.category,
              priority: byId.get(c.ids[0])!.priority,
            }
          : {
              type: 'cluster' as const,
              count: c.ids.length,
              latitude: c.lat / c.ids.length,
              longitude: c.lng / c.ids.length,
            },
      ),
    };
  }

  private haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }

  // GP-06 GET /reports/nearby
  async findNearby(admin: CurrentUserDto, query: NearbyReportsQueryDto) {
    const radiusKm = query.radiusKm ?? 5;
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.max(0.01, Math.cos((query.lat * Math.PI) / 180)));

    const candidates = await this.prisma.report.findMany({
      where: {
        AND: [
          { deletedAt: null },
          this.visibilityWhere(admin),
          {
            latitude: { gte: query.lat - dLat, lte: query.lat + dLat },
            longitude: { gte: query.lng - dLng, lte: query.lng + dLng },
            ...(query.status ? { status: query.status } : {}),
            ...(query.category ? { category: query.category } : {}),
          },
        ],
      },
      select: {
        id: true,
        caseReference: true,
        latitude: true,
        longitude: true,
        status: true,
        category: true,
        priority: true,
        createdAt: true,
      },
      take: 2000,
    });

    const within = candidates
      .map((r) => ({
        ...r,
        distanceKm:
          Math.round(this.haversineKm(query.lat, query.lng, r.latitude!, r.longitude!) * 100) / 100,
      }))
      .filter((r) => r.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    const { page, limit, skip } = this.paging(query);
    return { items: within.slice(skip, skip + limit), total: within.length, page, limit, radiusKm };
  }

  // GP-07 GET /reports/hotspots   (grid heatmap)
  async getHotspots(admin: CurrentUserDto, query: HotspotsQueryDto) {
    const gridKm = query.gridKm ?? 2;
    const latStep = gridKm / 111;
    const where = this.statsFilterSql(query, admin);

    const rows = await this.prisma.$queryRaw<
      Array<{ gy: number; gx: number; count: number; lat: number; lng: number }>
    >`
      SELECT FLOOR(r.latitude / ${latStep})::int AS gy,
             FLOOR(r.longitude / (${latStep} / GREATEST(0.01, COS(RADIANS(r.latitude)))))::int AS gx,
             COUNT(*)::int AS count,
             AVG(r.latitude)::float AS lat,
             AVG(r.longitude)::float AS lng
      FROM ${REPORT_TABLE} r
      WHERE ${where} AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL
      GROUP BY 1, 2
      ORDER BY count DESC
      LIMIT 500
    `;

    const max = rows[0]?.count ?? 0;
    return {
      gridKm,
      cells: rows.map((r) => ({
        latitude: r.lat,
        longitude: r.lng,
        count: r.count,
        intensity: max ? Math.round((r.count / max) * 100) / 100 : 0,
      })),
    };
  }

  // GP-08 GET /reports/stats/by-region  (declared with the stats group below)

  // EM-20 GET /reports/:id/emails
  async listEmails(admin: CurrentUserDto, reportId: string, query: PageQueryDto) {
    await this.loadForAdmin(admin, reportId);
    const { page, limit, skip, take } = this.paging(query);
    const where = { reportId };
    const [items, total] = await Promise.all([
      this.prisma.reportEmail.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take }),
      this.prisma.reportEmail.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async replyToEmail(admin: CurrentUserDto, reportId: string, dto: ReplyToReportEmailDto) {
    const report = await this.loadForAdminWrite(admin, reportId, act('REPORT_EMAIL_SENT'));

    const lastInbound = await this.prisma.reportEmail.findFirst({
      where: { reportId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
    });
    if (!lastInbound?.fromAddress) throw new BadRequestException('no_inbound_email_to_reply_to');

    const subject =
      dto.subject ??
      (lastInbound.subject
        ? /^re:/i.test(lastInbound.subject)
          ? lastInbound.subject
          : `Re: ${lastInbound.subject}`
        : `Re: ${report.caseReference}`);

    const email = await this.prisma.reportEmail.create({
      data: {
        reportId,
        direction: 'OUTBOUND',
        subject,
        body: dto.body,
        fromAddress: this.configService.get<string>('MAIL_FROM') ?? null,
        toAddress: lastInbound.fromAddress,
        sentById: admin.id,
      },
    });

    await this.prisma.report.update({
      where: { id: reportId },
      data: { lastActivityAt: new Date(), firstRespondedAt: report.firstRespondedAt ?? new Date() },
    });

    this.audit(admin, act('REPORT_EMAIL_SENT'), report, { result: 'success', emailId: email.id });
    this.eventEmitter.emit(NEW_EVENTS.EMAIL_REPLY, {
      reportId,
      caseReference: report.caseReference,
      emailId: email.id,
      to: email.toAddress,
      subject,
      body: dto.body,
      inReplyTo: lastInbound.messageId,
    });
    return email;
  }

  // RPT-128 GET /reports/search?q=
  // Case-insensitive match over reference, description, location, region and tag names.
  async searchReports(admin: CurrentUserDto, query: SearchReportsQueryDto) {
    const term = query.q.trim();
    return this.pagedReports(
      admin,
      {
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.assignedTo ? { assignedToId: query.assignedTo } : {}),
        OR: [
          { caseReference: { contains: term, mode: 'insensitive' } },
          { description: { contains: term, mode: 'insensitive' } },
          { location: { contains: term, mode: 'insensitive' } },
          { region: { contains: term, mode: 'insensitive' } },
          { tags: { some: { tag: { name: { contains: term.toLowerCase() } } } } },
        ],
      },
      query,
    );
  }

  // RPT-129 GET /reports/by-reference/:reference
  async findByReference(admin: CurrentUserDto, reference: string) {
    const found = await this.prisma.report.findFirst({
      where: {
        AND: [
          { caseReference: reference.trim().toUpperCase(), deletedAt: null },
          this.visibilityWhere(admin),
        ],
      },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('report_not_found');

    const { items } = await this.pagedReports(admin, { id: found.id }, { page: 1, limit: 1 });
    return items[0];
  }

  // Counts grouped by one whitelisted column; used by facets and the by-* stats
  private async countBy(
    admin: CurrentUserDto,
    q: ReportStatsQueryDto,
    column:
      'status' | 'category' | 'channel' | 'priority' | 'sensitivity' | 'region' | 'assignedTeamId',
  ) {
    const allowed = [
      'status',
      'category',
      'channel',
      'priority',
      'sensitivity',
      'region',
      'assignedTeamId',
    ];
    if (!allowed.includes(column)) throw new BadRequestException('invalid_column');
    const col = Prisma.raw(`r."${column}"`);
    const where = this.statsFilterSql(q, admin);

    const rows = await this.prisma.$queryRaw<Array<{ key: string | null; count: number }>>`
      SELECT ${col}::text AS key, COUNT(*)::int AS count
      FROM ${REPORT_TABLE} r
      WHERE ${where}
      GROUP BY 1
      ORDER BY count DESC
    `;
    const total = rows.reduce((s, r) => s + r.count, 0);
    return {
      total,
      items: rows.map((r) => ({
        key: r.key ?? 'UNKNOWN',
        count: r.count,
        share: total ? Math.round((r.count / total) * 10000) / 10000 : 0,
      })),
    };
  }

  // RPT-130 GET /reports/facets
  async getFacets(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const [status, category, priority, channel, sensitivity, region, assignment] =
      await Promise.all([
        this.countBy(admin, query, 'status'),
        this.countBy(admin, query, 'category'),
        this.countBy(admin, query, 'priority'),
        this.countBy(admin, query, 'channel'),
        this.countBy(admin, query, 'sensitivity'),
        this.countBy(admin, query, 'region'),
        this.getStatsAssignment(admin, query),
      ]);
    return {
      total: status.total,
      status,
      category,
      priority,
      channel,
      sensitivity,
      region,
      assignment,
    };
  }

  // RPT-131 GET /reports/filters/options
  async getFilterOptions(admin: CurrentUserDto) {
    const [regions, teams, tags, admins] = await Promise.all([
      this.prisma.report.findMany({
        where: { deletedAt: null, region: { not: null } },
        distinct: ['region'],
        select: { region: true },
        orderBy: { region: 'asc' },
      }),
      this.prisma.report.findMany({
        where: { deletedAt: null, assignedTeamId: { not: null } },
        distinct: ['assignedTeamId'],
        select: { assignedTeamId: true },
        orderBy: { assignedTeamId: 'asc' },
      }),
      this.prisma.reportTag.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.user.findMany({
        where: { userRoles: { some: { role: { name: { in: ADMIN_ROLE_NAMES as string[] } } } } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      statuses: Object.values(ReportStatus),
      categories: Object.values(ReportCategory),
      priorities: Object.values(ReportPriority),
      sensitivities: Object.values(ReportSensitivity),
      channels: Object.values(SubmissionChannel),
      integrityFlags: Object.values(ReportIntegrityFlag),
      regions: regions.map((r) => r.region!),
      teams: teams.map((t) => t.assignedTeamId!),
      tags,
      admins,
      canSeeAllAdmins: this.isSuperAdmin(admin),
    };
  }

  // RPT-132 GET /reports/:id/revisions
  async getRevisions(admin: CurrentUserDto, reportId: string, query: PageQueryDto) {
    await this.loadForAdmin(admin, reportId);
    const { page, limit, skip, take } = this.paging(query);
    const where = { reportId };
    const [items, total] = await Promise.all([
      this.prisma.reportRevision.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.reportRevision.count({ where }),
    ]);
    return { items, total, page, limit };
  }

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
    const where = this.statsWhere(filters, admin);

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

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
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
    this.normChannel(filters.channel); // fail fast on a bad filter

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
        data: { status: 'FAILED', error: this.errMsg(err).slice(0, 500), completedAt: new Date() },
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
      if (j.storageKey) await this.deleteMediaFiles([j.storageKey]);
      await this.prisma.reportExportJob.update({
        where: { id: j.id },
        data: { status: 'EXPIRED', storageKey: null },
      });
    }
    return expired.length;
  }

  // RPT-134 GET /reports/export-jobs   (mine)
  async listExportJobs(admin: CurrentUserDto, query: PageQueryDto) {
    const { page, limit, skip, take } = this.paging(query);
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
    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: act('REPORT_EXPORT_DOWNLOADED'),
      entity: 'ReportExportJob',
      entityId: jobId,
      diff: { result: 'success', rowCount: job.rowCount },
    });
    return { url, expiresAt: job.expiresAt, rowCount: job.rowCount };
  }

  // RPT-141 GET /reports/categories   (for the submit form)
  getCategories() {
    const labels: Record<ReportCategory, string> = {
      HARASSMENT: 'Harassment',
      ABUSE: 'Abuse',
      FRAUD: 'Fraud',
      THREAT: 'Threat',
      DISCRIMINATION: 'Discrimination',
      SAFETY_CONCERN: 'Safety concern',
      OTHER: 'Other',
    };
    return Object.values(ReportCategory).map((value) => ({ value, label: labels[value] ?? value }));
  }

  private round(n: number | null | undefined, digits = 2): number | null {
    return n == null || !Number.isFinite(Number(n)) ? null : Number(Number(n).toFixed(digits));
  }

  // Default window when the caller gives no from/to: last `days` days
  private resolveRange(q: ReportStatsQueryDto, days: number, maxDays = 366) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - days * 86400000);
    if (from.getTime() > to.getTime()) throw new BadRequestException('from_must_be_before_to');
    if ((to.getTime() - from.getTime()) / 86400000 > maxDays) {
      throw new BadRequestException(`range_too_large:max_${maxDays}_days`);
    }
    return { from, to };
  }

  private withRange(q: ReportStatsQueryDto, from: Date, to: Date): ReportStatsQueryDto {
    return { ...q, from: from.toISOString(), to: to.toISOString() };
  }

  // RPT-33 GET /reports/stats/timeline
  async getStatsTimeline(admin: CurrentUserDto, query: StatsTimelineQueryDto) {
    const bucket = query.bucket ?? 'day';
    if (!['day', 'week', 'month'].includes(bucket)) throw new BadRequestException('invalid_bucket');
    const { from, to } = this.resolveRange(query, bucket === 'day' ? 30 : 180);
    const where = this.statsFilterSql(this.withRange(query, from, to), admin);
    const unit = Prisma.raw(`'${bucket}'`);

    const rows = await this.prisma.$queryRaw<Array<{ bucket: Date; count: number }>>`
      SELECT date_trunc(${unit}, r."createdAt") AS bucket, COUNT(*)::int AS count
      FROM ${REPORT_TABLE} r
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    return {
      bucket,
      from,
      to,
      total: rows.reduce((s, r) => s + r.count, 0),
      items: rows.map((r) => ({ date: r.bucket.toISOString().slice(0, 10), count: r.count })),
    };
  }

  private async periodMetrics(admin: CurrentUserDto, q: ReportStatsQueryDto, from: Date, to: Date) {
    const where = this.statsFilterSql(this.withRange(q, from, to), admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        total: number;
        closed: number;
        rejected: number;
        escalated: number;
        avg_hours: number | null;
      }>
    >`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE r.status::text = 'CLOSED')::int AS closed,
             COUNT(*) FILTER (WHERE r.status::text = 'REJECTED')::int AS rejected,
             COUNT(*) FILTER (WHERE r.status::text = 'ESCALATED')::int AS escalated,
             AVG(EXTRACT(EPOCH FROM (COALESCE(r."closedAt", r."updatedAt") - r."createdAt")) / 3600)
               FILTER (WHERE r.status::text = 'CLOSED') AS avg_hours
      FROM ${REPORT_TABLE} r
      WHERE ${where}
    `;
    const r = rows[0];
    return {
      total: r?.total ?? 0,
      closed: r?.closed ?? 0,
      rejected: r?.rejected ?? 0,
      escalated: r?.escalated ?? 0,
      avgCloseHours: this.round(r?.avg_hours),
    };
  }

  // RPT-34 GET /reports/stats/compare   (period vs the equal-length period before it)
  async getStatsCompare(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const { from, to } = this.resolveRange(query, 30);
    const span = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - span);

    const [current, previous] = await Promise.all([
      this.periodMetrics(admin, query, from, to),
      this.periodMetrics(admin, query, prevFrom, prevTo),
    ]);

    const delta = (a: number | null, b: number | null) => {
      if (a == null || b == null) return { change: null, changePct: null };
      return {
        change: this.round(a - b),
        changePct: b === 0 ? null : this.round(((a - b) / b) * 100, 1),
      };
    };

    return {
      current: { from, to, ...current },
      previous: { from: prevFrom, to: prevTo, ...previous },
      delta: {
        total: delta(current.total, previous.total),
        closed: delta(current.closed, previous.closed),
        rejected: delta(current.rejected, previous.rejected),
        escalated: delta(current.escalated, previous.escalated),
        avgCloseHours: delta(current.avgCloseHours, previous.avgCloseHours),
      },
    };
  }

  // RPT-35 GET /reports/stats/by-hour   (hour of day x weekday, in REPORT_STATS_TZ)
  async getStatsByHour(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const tz = this.configService.get<string>('REPORT_STATS_TZ') ?? 'Africa/Addis_Ababa';
    const where = this.statsFilterSql(query, admin);

    const rows = await this.prisma.$queryRaw<Array<{ dow: number; hour: number; count: number }>>`
      SELECT EXTRACT(DOW FROM (r."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::int AS dow,
             EXTRACT(HOUR FROM (r."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::int AS hour,
             COUNT(*)::int AS count
      FROM ${REPORT_TABLE} r
      WHERE ${where}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;

    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    const byWeekday = Array.from({ length: 7 }, (_, d) => ({ weekday: d, count: 0 })); // 0 = Sunday
    for (const r of rows) {
      byHour[r.hour].count += r.count;
      byWeekday[r.dow].count += r.count;
    }
    return { timezone: tz, matrix: rows, byHour, byWeekday };
  }

  // RPT-36 GET /reports/stats/resolution-time
  // Close time falls back to updatedAt for reports closed before closedAt was recorded.
  async getStatsResolutionTime(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        resp_n: number;
        resp_avg: number | null;
        resp_p50: number | null;
        resp_p90: number | null;
        close_n: number;
        close_avg: number | null;
        close_p50: number | null;
        close_p90: number | null;
      }>
    >`
      WITH x AS (
        SELECT EXTRACT(EPOCH FROM (r."firstRespondedAt" - r."createdAt")) / 3600 AS resp_h,
               CASE WHEN r.status::text = 'CLOSED'
                    THEN EXTRACT(EPOCH FROM (COALESCE(r."closedAt", r."updatedAt") - r."createdAt")) / 3600 END AS close_h
        FROM ${REPORT_TABLE} r
        WHERE ${where}
      )
      SELECT COUNT(resp_h)::int AS resp_n,
             AVG(resp_h) AS resp_avg,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY resp_h) AS resp_p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY resp_h) AS resp_p90,
             COUNT(close_h)::int AS close_n,
             AVG(close_h) AS close_avg,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY close_h) AS close_p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY close_h) AS close_p90
      FROM x
    `;
    const r = rows[0];
    return {
      firstResponseHours: {
        samples: r?.resp_n ?? 0,
        avg: this.round(r?.resp_avg),
        median: this.round(r?.resp_p50),
        p90: this.round(r?.resp_p90),
      },
      closeHours: {
        samples: r?.close_n ?? 0,
        avg: this.round(r?.close_avg),
        median: this.round(r?.close_p50),
        p90: this.round(r?.close_p90),
      },
    };
  }

  // RPT-37 GET /reports/stats/backlog   (open reports at the end of each day)
  // from/to bound the chart days; the other filters still narrow which reports count.
  async getStatsBacklog(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const { from, to } = this.resolveRange(query, 30);
    const { from: _f, to: _t, ...rest } = query;
    const where = this.statsFilterSql(rest, admin);

    const rows = await this.prisma.$queryRaw<Array<{ day: Date; open: number }>>`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', ${from.toISOString()}::timestamp),
          date_trunc('day', ${to.toISOString()}::timestamp),
          interval '1 day'
        ) AS d
      )
      SELECT d AS day,
             (SELECT COUNT(*)::int FROM ${REPORT_TABLE} r
              WHERE ${where}
                AND r."createdAt" < d + interval '1 day'
                AND (r.status::text NOT IN ('CLOSED','REJECTED')
                     OR COALESCE(r."closedAt", r."updatedAt") >= d + interval '1 day')) AS open
      FROM days
      ORDER BY d
    `;
    return {
      from,
      to,
      items: rows.map((r) => ({ date: r.day.toISOString().slice(0, 10), open: r.open })),
    };
  }

  // RPT-38 GET /reports/stats/by-status
  async getStatsByStatus(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    return this.countBy(admin, query, 'status');
  }

  // RPT-39 GET /reports/stats/by-category
  async getStatsByCategory(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    return this.countBy(admin, query, 'category');
  }

  // RPT-40 GET /reports/stats/by-channel
  async getStatsByChannel(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    return this.countBy(admin, query, 'channel');
  }

  // RPT-42 GET /reports/stats/by-priority
  async getStatsByPriority(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    return this.countBy(admin, query, 'priority');
  }

  // GP-08 GET /reports/stats/by-region
  async getStatsByRegion(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    return this.countBy(admin, query, 'region');
  }

  // RPT-41 GET /reports/stats/by-admin   (Super Admin)
  async getStatsByAdmin(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        adminId: string;
        total: number;
        open: number;
        closed: number;
        overdue: number;
        avg_hours: number | null;
      }>
    >`
      SELECT r."assignedToId" AS "adminId",
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE r.status::text NOT IN ('CLOSED','REJECTED'))::int AS open,
             COUNT(*) FILTER (WHERE r.status::text = 'CLOSED')::int AS closed,
             COUNT(*) FILTER (WHERE r.status::text NOT IN ('CLOSED','REJECTED')
                                AND r."dueAt" IS NOT NULL AND r."dueAt" < NOW())::int AS overdue,
             AVG(EXTRACT(EPOCH FROM (COALESCE(r."closedAt", r."updatedAt") - r."createdAt")) / 3600)
               FILTER (WHERE r.status::text = 'CLOSED') AS avg_hours
      FROM ${REPORT_TABLE} r
      WHERE ${where} AND r."assignedToId" IS NOT NULL
      GROUP BY 1
      ORDER BY total DESC
    `;

    const users = rows.length
      ? await this.prisma.user.findMany({
          where: { id: { in: rows.map((r) => r.adminId) } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    return {
      items: rows.map((r) => ({
        adminId: r.adminId,
        name: names.get(r.adminId) ?? null,
        total: r.total,
        open: r.open,
        closed: r.closed,
        overdue: r.overdue,
        avgCloseHours: this.round(r.avg_hours),
      })),
    };
  }

  // RPT-43 GET /reports/stats/assignment   (assigned / unassigned / stale)
  async getStatsAssignment(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const staleHours = Number(this.configService.get<string>('REPORT_STALE_PENDING_HOURS') ?? 48);
    const where = this.statsFilterSql(query, admin);
    const cutoff = new Date(Date.now() - staleHours * 3600000);

    const rows = await this.prisma.$queryRaw<
      Array<{ assigned: number; unassigned: number; stale: number }>
    >`
      SELECT COUNT(*) FILTER (WHERE r."assignedToId" IS NOT NULL)::int AS assigned,
             COUNT(*) FILTER (WHERE r."assignedToId" IS NULL)::int AS unassigned,
             COUNT(*) FILTER (WHERE r."assignedToId" IS NULL
                                AND r.status::text NOT IN ('CLOSED','REJECTED')
                                AND r."createdAt" < ${cutoff})::int AS stale
      FROM ${REPORT_TABLE} r
      WHERE ${where}
    `;
    return {
      assigned: rows[0]?.assigned ?? 0,
      unassigned: rows[0]?.unassigned ?? 0,
      stale: rows[0]?.stale ?? 0,
      staleAfterHours: staleHours,
    };
  }

  // RPT-44 GET /reports/stats/overview   (the dashboard in one call)
  async getStatsOverview(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.statsFilterSql(query, admin);

    const [byStatus, byCategory, byPriority, assignment, timeline, resolution, extras] =
      await Promise.all([
        this.countBy(admin, query, 'status'),
        this.countBy(admin, query, 'category'),
        this.countBy(admin, query, 'priority'),
        this.getStatsAssignment(admin, query),
        this.getStatsTimeline(admin, { ...query, bucket: 'day' }),
        this.getStatsResolutionTime(admin, query),
        this.prisma.$queryRaw<
          Array<{
            open: number;
            overdue: number;
            escalated: number;
            unreadForMe: number;
            closedLast7d: number;
          }>
        >`
          SELECT COUNT(*) FILTER (WHERE r.status::text NOT IN ('CLOSED','REJECTED'))::int AS open,
                 COUNT(*) FILTER (WHERE r.status::text NOT IN ('CLOSED','REJECTED')
                                    AND r."dueAt" IS NOT NULL AND r."dueAt" < NOW())::int AS overdue,
                 COUNT(*) FILTER (WHERE r.status::text = 'ESCALATED')::int AS escalated,
                 COUNT(*) FILTER (WHERE NOT EXISTS (
                   SELECT 1 FROM report_admin_read ar WHERE ar."reportId" = r.id AND ar."adminId" = ${admin.id}
                 ) AND r."archivedAt" IS NULL)::int AS "unreadForMe",
                 COUNT(*) FILTER (WHERE r.status::text = 'CLOSED'
                                    AND COALESCE(r."closedAt", r."updatedAt") >= NOW() - INTERVAL '7 days')::int AS "closedLast7d"
          FROM ${REPORT_TABLE} r
          WHERE ${where}
        `,
      ]);

    const closed = byStatus.items.find((i) => i.key === 'CLOSED')?.count ?? 0;
    const rejected = byStatus.items.find((i) => i.key === 'REJECTED')?.count ?? 0;
    const total = byStatus.total;

    return {
      total,
      open: extras[0]?.open ?? 0,
      overdue: extras[0]?.overdue ?? 0,
      escalated: extras[0]?.escalated ?? 0,
      unreadForMe: extras[0]?.unreadForMe ?? 0,
      closedLast7d: extras[0]?.closedLast7d ?? 0,
      closureRate: total ? this.round(closed / total, 4) : 0,
      rejectionRate: total ? this.round(rejected / total, 4) : 0,
      byStatus: byStatus.items,
      byCategory: byCategory.items,
      byPriority: byPriority.items,
      assignment,
      resolution,
      timeline: timeline.items,
    };
  }

  // RPT-152 GET /reports/stats/aging   (open reports by age bucket)
  async getStatsAging(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<Array<{ bucket: string; count: number }>>`
      SELECT CASE
               WHEN age < INTERVAL '1 day'   THEN '0-1d'
               WHEN age < INTERVAL '3 days'  THEN '1-3d'
               WHEN age < INTERVAL '7 days'  THEN '3-7d'
               WHEN age < INTERVAL '14 days' THEN '7-14d'
               WHEN age < INTERVAL '30 days' THEN '14-30d'
               ELSE '30d+'
             END AS bucket,
             COUNT(*)::int AS count
      FROM (
        SELECT NOW() - r."createdAt" AS age
        FROM ${REPORT_TABLE} r
        WHERE ${where} AND r.status::text NOT IN ('CLOSED','REJECTED')
      ) t
      GROUP BY 1
    `;
    const order = ['0-1d', '1-3d', '3-7d', '7-14d', '14-30d', '30d+'];
    const map = new Map(rows.map((r) => [r.bucket, r.count]));
    return {
      total: rows.reduce((s, r) => s + r.count, 0),
      items: order.map((bucket) => ({ bucket, count: map.get(bucket) ?? 0 })),
    };
  }

  // RPT-153 GET /reports/stats/sla   (within SLA)
  async getStatsSla(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        with_deadline: number;
        met: number;
        breached: number;
        running: number;
        at_risk: number;
      }>
    >`
      SELECT COUNT(*) FILTER (WHERE r."dueAt" IS NOT NULL)::int AS with_deadline,
             COUNT(*) FILTER (WHERE r."dueAt" IS NOT NULL AND r.status::text IN ('CLOSED','REJECTED')
                                AND COALESCE(r."closedAt", r."updatedAt") <= r."dueAt")::int AS met,
             COUNT(*) FILTER (WHERE r."dueAt" IS NOT NULL AND (
                                (r.status::text IN ('CLOSED','REJECTED') AND COALESCE(r."closedAt", r."updatedAt") > r."dueAt")
                             OR (r.status::text NOT IN ('CLOSED','REJECTED') AND r."dueAt" < NOW())))::int AS breached,
             COUNT(*) FILTER (WHERE r."dueAt" IS NOT NULL AND r.status::text NOT IN ('CLOSED','REJECTED')
                                AND r."dueAt" >= NOW())::int AS running,
             COUNT(*) FILTER (WHERE r."dueAt" IS NOT NULL AND r.status::text NOT IN ('CLOSED','REJECTED')
                                AND r."dueAt" >= NOW() AND r."dueAt" < NOW() + INTERVAL '24 hours')::int AS at_risk
      FROM ${REPORT_TABLE} r
      WHERE ${where}
    `;
    const r = rows[0];
    const decided = (r?.met ?? 0) + (r?.breached ?? 0);
    return {
      withDeadline: r?.with_deadline ?? 0,
      met: r?.met ?? 0,
      breached: r?.breached ?? 0,
      running: r?.running ?? 0,
      atRisk24h: r?.at_risk ?? 0,
      complianceRate: decided ? this.round((r?.met ?? 0) / decided, 4) : null,
    };
  }

  // RPT-154 GET /reports/stats/feedback   (satisfaction)
  async getStatsFeedback(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<Array<{ rating: number; count: number }>>`
      SELECT f.rating AS rating, COUNT(*)::int AS count
      FROM report_feedback f
      JOIN ${REPORT_TABLE} r ON r.id = f."reportId"
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1
    `;
    const distribution = [1, 2, 3, 4, 5].map((rating) => ({
      rating,
      count: rows.find((r) => r.rating === rating)?.count ?? 0,
    }));
    const responses = distribution.reduce((s, d) => s + d.count, 0);
    const sum = distribution.reduce((s, d) => s + d.rating * d.count, 0);

    const closedRows = await this.prisma.$queryRaw<Array<{ closed: number }>>`
      SELECT COUNT(*)::int AS closed FROM ${REPORT_TABLE} r
      WHERE ${where} AND r.status::text = 'CLOSED'
    `;
    const closed = closedRows[0]?.closed ?? 0;

    return {
      responses,
      averageRating: responses ? this.round(sum / responses) : null,
      satisfiedShare: responses
        ? this.round((distribution[3].count + distribution[4].count) / responses, 4)
        : null,
      responseRate: closed ? this.round(responses / closed, 4) : null,
      distribution,
    };
  }

  // RPT-155 GET /reports/stats/reopened   (reopen rate)
  async getStatsReopened(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        requests: number;
        reports: number;
        approved: number;
        pending: number;
        denied: number;
        closed: number;
      }>
    >`
      SELECT (SELECT COUNT(*)::int FROM report_reopen_request q JOIN ${REPORT_TABLE} r ON r.id = q."reportId" WHERE ${where}) AS requests,
             (SELECT COUNT(DISTINCT q."reportId")::int FROM report_reopen_request q JOIN ${REPORT_TABLE} r ON r.id = q."reportId" WHERE ${where}) AS reports,
             (SELECT COUNT(*)::int FROM report_reopen_request q JOIN ${REPORT_TABLE} r ON r.id = q."reportId" WHERE ${where} AND q.approved IS TRUE) AS approved,
             (SELECT COUNT(*)::int FROM report_reopen_request q JOIN ${REPORT_TABLE} r ON r.id = q."reportId" WHERE ${where} AND q."handledAt" IS NULL) AS pending,
             (SELECT COUNT(*)::int FROM report_reopen_request q JOIN ${REPORT_TABLE} r ON r.id = q."reportId" WHERE ${where} AND q.approved IS FALSE) AS denied,
             (SELECT COUNT(*)::int FROM ${REPORT_TABLE} r WHERE ${where} AND r.status::text IN ('CLOSED','REJECTED')) AS closed
    `;
    const r = rows[0];
    return {
      requests: r?.requests ?? 0,
      reportsWithRequests: r?.reports ?? 0,
      approved: r?.approved ?? 0,
      denied: r?.denied ?? 0,
      pending: r?.pending ?? 0,
      requestRate: r?.closed ? this.round((r.reports ?? 0) / r.closed, 4) : null,
      approvedReopenRate: r?.closed ? this.round((r.approved ?? 0) / r.closed, 4) : null,
    };
  }

  async getStatsEscalations(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        recorded: number;
        de_escalated: number;
        avg_hours: number | null;
        current: number;
        reports: number;
      }>
    >`
      SELECT (SELECT COUNT(*)::int FROM report_escalation e JOIN ${REPORT_TABLE} r ON r.id = e."reportId" WHERE ${where}) AS recorded,
             (SELECT COUNT(*)::int FROM report_escalation e JOIN ${REPORT_TABLE} r ON r.id = e."reportId" WHERE ${where} AND e."deEscalatedAt" IS NOT NULL) AS de_escalated,
             (SELECT AVG(EXTRACT(EPOCH FROM (e."deEscalatedAt" - e."createdAt")) / 3600)
                FROM report_escalation e JOIN ${REPORT_TABLE} r ON r.id = e."reportId"
               WHERE ${where} AND e."deEscalatedAt" IS NOT NULL) AS avg_hours,
             (SELECT COUNT(*)::int FROM ${REPORT_TABLE} r WHERE ${where} AND r.status::text = 'ESCALATED') AS current,
             (SELECT COUNT(*)::int FROM ${REPORT_TABLE} r WHERE ${where}) AS reports
    `;
    const r = rows[0];
    return {
      recorded: r?.recorded ?? 0,
      deEscalated: r?.de_escalated ?? 0,
      avgHoursToDeEscalate: this.round(r?.avg_hours),
      currentlyEscalated: r?.current ?? 0,
      escalatedShare: r?.reports ? this.round((r.current ?? 0) / r.reports, 4) : 0,
    };
  }

  // RPT-157 GET /reports/stats/spam   (spam / false-report rate)
  async getStatsSpam(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<Array<{ flag: string | null; count: number }>>`
      SELECT r."integrityFlag"::text AS flag, COUNT(*)::int AS count
      FROM ${REPORT_TABLE} r
      WHERE ${where}
      GROUP BY 1
    `;
    const total = rows.reduce((s, r) => s + r.count, 0);
    const flagged = rows.filter((r) => r.flag).reduce((s, r) => s + r.count, 0);
    const byFlag: Record<string, number> = {};
    for (const flag of Object.values(ReportIntegrityFlag)) {
      byFlag[flag] = rows.find((r) => r.flag === flag)?.count ?? 0;
    }
    return {
      total,
      flagged,
      flaggedRate: total ? this.round(flagged / total, 4) : 0,
      byFlag,
    };
  }

  // RPT-158 GET /reports/stats/by-tag
  async getStatsByTag(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<Array<{ tagId: string; name: string; count: number }>>`
      SELECT t.id AS "tagId", t.name AS name, COUNT(*)::int AS count
      FROM report_tag_on_report x
      JOIN report_tag t ON t.id = x."tagId"
      JOIN ${REPORT_TABLE} r ON r.id = x."reportId"
      WHERE ${where}
      GROUP BY 1, 2
      ORDER BY count DESC, name ASC
      LIMIT 200
    `;
    return { items: rows };
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

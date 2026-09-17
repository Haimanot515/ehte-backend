import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { InformationRequestStatus, Prisma, ReportStatus } from '@prisma/client';

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

// ─────────────────────────────────────────────
// STATUS STATE MACHINE
//
// Adjust to match your actual PRD workflow — this is
// a reasonable default based on the flow discussed,
// not confirmed against your PRD.
// ─────────────────────────────────────────────

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

// Terminal statuses — a report here is done, one way or another.
// Used by findStalePending() (a terminal report can't be "stale")
// and maybeFlagUserForRejections() (only REJECTED counts against
// the user, not every terminal state).
const TERMINAL_STATUSES: ReportStatus[] = [ReportStatus.CLOSED, ReportStatus.REJECTED];

const ADMIN_ROLE_NAMES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

// How many times to retry case-reference generation on a unique
// constraint collision before giving up.
const CASE_REFERENCE_MAX_ATTEMPTS = 5;

// The six media-array fields shared by CreateReportDto/UpdateReportDto
// and the Report model itself. Mirrors PostService's MEDIA_FIELD_NAMES
// so both modules stay in sync if a new media kind is ever added.
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

  // ─────────────────────────────────────────────
  // MEDIA HELPERS
  //
  // Mirrors PostService's media helpers. Report stores media as
  // plain filepath strings in typed arrays (photo/video/audio/pdf/
  // document/other), same as Post — kept in one place so every
  // read/write of that shape stays consistent.
  //
  // NOTE: MinioService.objectExists()/statObject()/deleteFile() are
  // bucket-less — the service holds a single configured bucket
  // internally, so callers just pass the key. getMediaBucket() is
  // unused by the methods below for that reason; left in place in
  // case other code in this file still needs the bucket name for
  // something else.
  // ─────────────────────────────────────────────

  private getMediaBucket(): string {
    return this.configService.get<string>('minio.bucketName') ?? 'ehte-media';
  }

  private collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  private collectMediaFieldsFromDto(dto: MediaBearingDto): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => dto[field] ?? []);
  }

  // Diffs each media field individually (not the flattened whole),
  // so a client resending the same array doesn't get treated as
  // "remove and re-add." Only fields present in the incoming DTO
  // are considered — an omitted field means "leave this one alone."
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

  // FIX (item #3): confirms every filepath the client is attaching
  // actually exists in the media bucket, AND now also enforces
  // size/MIME-type limits — previously this only checked existence,
  // unlike PostService.validateMediaFilesExist which already did
  // all three. Brought to parity so a report can't reference an
  // object that's oversized or of a disallowed type any more than
  // a post can.
  //
  // FIX (item #13, partial): returns each validated file's size so
  // callers can maintain a running mediaTotalBytes without
  // re-statting already-attached files.
  //
  // NOTE (item #3, virus scanning) / NOTE (item #4, EXIF/GPS
  // stripping): same as PostService — deliberately out of scope
  // here, belongs in the media-upload module at upload time.
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

  // FIX (item #13): per-field attachment counts, mirroring
  // PostService.assertAttachmentCounts exactly, but reading
  // REPORT_*-prefixed overrides first. Checked BEFORE any MinIO
  // calls so an over-attached request fails fast.
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

  // FIX (item #13): total attached-media size cap per report,
  // mirroring PostService.assertTotalBytes.
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

  // Best-effort delete against MinIO. A file that's already gone
  // (or MinIO briefly unreachable) must never block the DB write
  // that triggered the cleanup — failures are swallowed per-file
  // via allSettled rather than surfaced to the caller.
  private async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  // ─────────────────────────────────────────────
  // GET MEDIA DOWNLOAD URL (REPORTER — OWN REPORT)
  // GET /reports/:id/media?key=...
  //
  // Mirrors VictimProfileService/PostService's admin media-download
  // method, but scoped the same way findOne()/update() already are:
  // the reporter may only request a URL for a key actually attached
  // to a report *they own*. There is no public equivalent here —
  // unlike Post/VictimProfile, reports are never publicly visible,
  // so only the reporter and admins (below) can ever reach this.
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // GET MEDIA DOWNLOAD URL (ADMIN)
  // GET /reports/:id/admin/media?key=...
  //
  // Viewing a report's media is open to any ADMIN or SUPER_ADMIN,
  // matching findOneForAdmin()'s access rule — assignment
  // (assertAdminCanAccessReport) only gates *acting* on a report
  // (updateStatus, requestMoreInformation, escalate), not reading
  // it. Same key-ownership check as the reporter-facing method
  // above.
  // ─────────────────────────────────────────────

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
      throw new NotFoundException('media_not_found_on_report');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_MEDIA_DOWNLOADED,
      entity: 'Report',
      entityId: reportId,
      diff: { result: 'success', key },
    });

    return { url };
  }

  // ─────────────────────────────────────────────
  // ACCESS CONTROL HELPER
  //
  // Shared by every admin-facing report operation.
  // SUPER_ADMIN may act on any report. A plain ADMIN
  // may only act on a report that is unassigned or
  // assigned specifically to them. Previously only
  // findOneForAdmin() enforced this; updateStatus(),
  // requestMoreInformation(), and escalate() did not.
  //
  // NOTE (item #17): this — combined with assign()/unassign()
  // being SUPER_ADMIN-gated — already serves the same
  // "prevent two admins working the same case" purpose Post's
  // self-serve claim()/unclaim() does, just mediated by
  // SUPER_ADMIN rather than self-service. Whether a plain ADMIN
  // should be able to self-claim an *unassigned* report (the way
  // Post allows) is a product decision, not implemented here —
  // it would change who's currently allowed to act on unassigned
  // reports.
  // ─────────────────────────────────────────────

  private assertAdminCanAccessReport(
    admin: CurrentUserDto,
    report: { assignedToId: string | null },
  ): void {
    const roles = this.getRoles(admin);
    const isSuperAdmin = roles.includes(RolesEnum.SUPER_ADMIN);

    if (!isSuperAdmin && report.assignedToId && report.assignedToId !== admin.id) {
      throw new ForbiddenException('report_assigned_to_another_admin');
    }
  }

  // ─────────────────────────────────────────────
  // BANNED / SUSPENDED OWNER HANDLING (item #6)
  //
  // ASSUMPTION: same event contract as PostService.handleUserSuspended
  // — the user module emits 'user.suspended' with a { userId } payload.
  //
  // Unlike Post, a Report has no safe intermediate "hidden" state to
  // fall back to (no DRAFT), and the checklist is explicit that
  // safety-related reports should be preserved/kept visible rather
  // than hidden or auto-rejected just because the reporter's account
  // was later suspended. So this handler ONLY stamps ownerSuspendedAt
  // for admin filtering — it deliberately does NOT change status or
  // pull anything out of the review queue.
  // ─────────────────────────────────────────────

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

    this.emitAudit({
      userId: payload.userId,
      // ASSUMPTION: resolveActorType only knows about role-bearing
      // actors; cast until AuditEventPayload's actorType union is
      // extended with a SYSTEM variant. Same cast PostService uses.
      actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
      action: AuditEventEnum.REPORT_UPDATED,
      entity: 'Report',
      entityId: `user:${payload.userId}`,
      diff: { reason: 'owner_account_suspended', result: 'success' },
    });
  }

  // ─────────────────────────────────────────────
  // AUTOMATIC FLAGS (item #21)
  //
  // Flag ≠ reject. Writes an audit-log entry an admin can see
  // against the user; never blocks or auto-rejects anything, and
  // never changes any Report's status. Mirrors
  // PostService.maybeFlagUserForRejections, reading REPORT_*
  // overrides first. Only called from updateStatus() on a
  // transition TO REJECTED — not from withdraw(), since a reporter
  // withdrawing their own report is not the same signal as an
  // admin actually rejecting it.
  // ─────────────────────────────────────────────

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
      this.emitAudit({
        userId,
        actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
        action: AuditEventEnum.USER_AUTO_FLAGGED,
        entity: 'User',
        entityId: userId,
        diff: {
          reason: 'repeated_report_rejections',
          rejectionCount: recentRejections,
          windowDays,
          result: 'flagged_for_review',
        },
      });
    }
  }

  // ─────────────────────────────────────────────
  // CREATE REPORT
  //
  // FIX (item #1): a per-user cooldown (REPORT_CREATE_RATE_LIMIT_WINDOW_SECONDS,
  // falling back to the shared CONTENT_* default) blocks rapid-fire
  // spam, and a max-pending-per-user cap (REPORT_MAX_PENDING_PER_USER
  // / CONTENT_MAX_PENDING_PER_USER) is enforced here rather than at a
  // separate "submit" step — Reports have no draft/submit split like
  // Post does; a report is PENDING the moment it's created.
  //
  // FIX (item #5): optional Idempotency-Key (sent as a header by the
  // controller) lets a client safely retry after a dropped response.
  // A repeat with the same key returns the original report.
  //
  // FIX (item #13): attachment counts/total size are checked before
  // any MinIO round trips, and the validated sizes are persisted as
  // mediaTotalBytes.
  //
  // FIX (notifications): REPORT_RECEIVED and NEW_REPORT now include
  // caseReference — previously omitted, which meant the listener's
  // "Your report {caseReference} has been received" message rendered
  // as "Your report undefined has been received."
  // ─────────────────────────────────────────────

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
        // Safe replay of a duplicate submission — return the
        // original instead of creating a second report.
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
      diff: { result: 'success', status: report.status },
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

  // ─────────────────────────────────────────────
  // GET MY REPORTS
  // ─────────────────────────────────────────────

  async findMyReports(user: CurrentUserDto) {
    return this.prisma.report.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // GET ONE OF MY REPORTS
  // ─────────────────────────────────────────────

  async findOne(user: CurrentUserDto, reportId: string) {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    return report;
  }

  // ─────────────────────────────────────────────
  // UPDATE REPORT
  //
  // Media handling: diffs each media field present in the
  // request against what's currently on the row. Newly-added
  // filepaths are validated against MinIO before the write;
  // filepaths dropped from the new array are deleted from
  // MinIO after the write commits — same ordering discipline
  // as PostService.updateMyPost.
  //
  // FIX (item #13): attachment counts are checked against the
  // fully-merged post-update media shape before any MinIO calls,
  // and mediaTotalBytes is recomputed from the previous total
  // plus/minus the added/removed files' sizes — same approach as
  // PostService.updateMyPost.
  //
  // FIX (notifications): REPORT_UPDATED now includes caseReference
  // and status — previously omitted, so the listener's "Status: X"
  // message rendered as "Status: undefined."
  // ─────────────────────────────────────────────

  async update(user: CurrentUserDto, reportId: string, data: UpdateReportDto) {
    const existing = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    if (existing.status !== ReportStatus.PENDING) {
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
    this.assertAttachmentCounts(merged);

    const validatedAdded = await this.validateMediaFilesExist(added);
    const addedBytes = validatedAdded.reduce((sum, v) => sum + v.size, 0);

    // Stat removed files before they're deleted, purely to back out
    // their bytes from the running total — a stat failure here
    // (already gone, MinIO hiccup) just means we can't credit that
    // byte count back, so treat it as 0 rather than blocking the
    // update.
    const removedStats = await Promise.allSettled(
      removed.map((fp) => this.minioService.statObject(fp)),
    );
    const removedBytes = removedStats.reduce(
      (sum, r) => sum + (r.status === 'fulfilled' ? r.value.size : 0),
      0,
    );

    const newTotalBytes = Math.max(0, existing.mediaTotalBytes + addedBytes - removedBytes);
    this.assertTotalBytes(newTotalBytes);

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

    // Only after the DB write commits — deleting first and having
    // the write fail would strand the report pointing at nothing.
    await this.deleteMediaFiles(removed);

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
      action: AuditEventEnum.REPORT_UPDATED,
      entity: 'Report',
      entityId: report.id,
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

  // ─────────────────────────────────────────────
  // WITHDRAW REPORT (USER)
  //
  // Lets a reporter withdraw their own report while it's
  // still PENDING — the same window during which they can edit
  // it. Reuses ReportStatus.REJECTED since there is no dedicated
  // WITHDRAWN status in the schema. If you want to distinguish
  // "reporter withdrew" from "admin rejected" later (e.g. for
  // reporting/metrics), that needs a schema/enum change — the
  // audit trail already records REPORT_WITHDRAWN separately so
  // the distinction isn't lost even though status collapses the
  // two together.
  //
  // Deliberately does NOT call maybeFlagUserForRejections — see
  // that method's comment. A user withdrawing their own report is
  // not the same signal as an admin rejecting it, and shouldn't
  // count toward the auto-flag threshold.
  //
  // NOTE: the row (and its media) are kept, not deleted — unlike
  // PostService.deleteMyPost, which only purges media on an actual
  // row deletion. If withdrawn-report media should also be purged
  // from MinIO, that's a deliberate policy decision to make
  // explicitly, not something to infer from this pattern.
  //
  // FIX (notifications): REPORT_UPDATED now includes caseReference
  // and status, same as update()/updateStatus().
  // ─────────────────────────────────────────────

  async withdraw(user: CurrentUserDto, reportId: string) {
    const existing = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    if (existing.status !== ReportStatus.PENDING) {
      throw new BadRequestException('only_pending_reports_can_be_withdrawn');
    }

    // Conditional update guards against a concurrent admin
    // transition landing between findFirst and update.
    const result = await this.prisma.report.updateMany({
      where: { id: reportId, status: ReportStatus.PENDING },
      data: { status: ReportStatus.REJECTED },
    });

    if (result.count === 0) {
      throw new BadRequestException('only_pending_reports_can_be_withdrawn');
    }

    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
      action: AuditEventEnum.REPORT_WITHDRAWN,
      entity: 'Report',
      entityId: reportId,
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

  // ─────────────────────────────────────────────
  // GET ALL REPORTS (ADMIN)
  //
  // Intentionally unscoped by assignment: viewing the report list
  // (and opening a report's full detail — see findOneForAdmin) is
  // a read action available to any ADMIN or SUPER_ADMIN. Only
  // *acting* on a report — changing its status, requesting more
  // information, escalating it — is restricted to the report's
  // assigned admin (or left open if unassigned); see
  // assertAdminCanAccessReport() and its callers below for that
  // rule. Do not add assignment scoping here without also revisiting
  // findOneForAdmin(), since the two are meant to stay symmetric.
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // GET REPORTS ASSIGNED TO ME (ADMIN)
  //
  // Paginated to match findAllForAdmin, and includes
  // reporter summary fields for dashboard display.
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // ADMIN — STALE / UNASSIGNED-TOO-LONG REPORTS
  // GET /reports/stale
  // (item #15)
  //
  // Unlike PostService.findStalePending (which only checks status,
  // since Post has no assignment concept), a Report is only truly
  // "forgotten" if it's BOTH unassigned AND still non-terminal — an
  // ASSIGNED or IN_PROGRESS report already has someone actively on
  // it, so it's excluded even if it's been open a while. Purely
  // informational, same as Post's version — nothing here changes
  // status or ownership.
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // GET ONE REPORT — FULL DETAIL (ADMIN)
  //
  // Open to any ADMIN or SUPER_ADMIN — viewing is not gated by
  // assignment (see the note on findAllForAdmin above). Assignment
  // only gates the write-side admin actions further down
  // (updateStatus, requestMoreInformation, escalate), via
  // assertAdminCanAccessReport().
  // ─────────────────────────────────────────────

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
      diff: { result: 'success' },
    });

    this.emitAudit({
      userId: admin.id,
      actorType,
      action: AuditEventEnum.REPORTER_INFORMATION_OPENED,
      entity: 'Report',
      entityId: reportId,
      diff: { result: 'success' },
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // ADMIN — PER-REPORT HISTORY / TIMELINE
  // GET /reports/:id/history
  // (item #18)
  //
  // ASSUMPTION: same as PostService.getHistory — an `auditLog`
  // Prisma model populated by a listener subscribed to the events
  // emitAudit() already fires throughout this service.
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // UPDATE STATUS (ADMIN)
  //
  // Transitions validated against ALLOWED_STATUS_TRANSITIONS.
  //
  // FIX (item #22/#26): converted the read-then-write into a
  // conditional update (updateMany guarded on the status read a
  // moment earlier), same pattern PostService uses throughout, so
  // two admins racing to transition the same report can't silently
  // clobber each other — the loser gets report_transition_conflict
  // instead of an unvalidated write going through.
  //
  // FIX (item #21): on a transition TO REJECTED specifically, checks
  // whether the reporter has crossed the auto-flag threshold for
  // repeated rejections.
  //
  // FIX (notifications): REPORT_UPDATED now includes caseReference
  // and status, same as update()/withdraw().
  // ─────────────────────────────────────────────

  async updateStatus(admin: CurrentUserDto, reportId: string, data: UpdateReportStatusDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.assertAdminCanAccessReport(admin, existing);

    const allowedNext = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(data.status)) {
      throw new BadRequestException(
        `invalid_status_transition: ${existing.status} -> ${data.status}`,
      );
    }

    const result = await this.prisma.report.updateMany({
      where: { id: reportId, status: existing.status },
      data: { status: data.status },
    });

    if (result.count === 0) {
      throw new BadRequestException('report_transition_conflict');
    }

    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_STATUS_CHANGED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
        note: data.note ?? null,
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

  // ─────────────────────────────────────────────
  // REQUEST MORE INFORMATION (ADMIN)
  //
  // Persists a ReportInformationRequest row, which the
  // user-response endpoint below reads and updates.
  // Enforces the same admin-access rule as findOneForAdmin,
  // and refuses to open a second request while one is
  // still PENDING — otherwise requests could stack up
  // with no way for the user to tell which is current.
  //
  // FIX (notifications): MORE_INFORMATION_REQUESTED now includes
  // caseReference — previously omitted.
  // ─────────────────────────────────────────────

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

    this.assertAdminCanAccessReport(admin, existing);

    const openRequest = await this.prisma.reportInformationRequest.findFirst({
      where: { reportId, status: InformationRequestStatus.PENDING },
    });

    if (openRequest) {
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
      diff: { result: 'success', informationRequestId: infoRequest.id, message: data.message },
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

  // ─────────────────────────────────────────────
  // LIST INFORMATION REQUESTS
  //
  // Backs GET /reports/:id/information-requests. The reporter may
  // list requests for their own report. An admin may list them for
  // any report they're allowed to open (same rule as
  // findOneForAdmin: SUPER_ADMIN sees any report, plain ADMIN only
  // unassigned or assigned-to-them).
  // ─────────────────────────────────────────────

  async findInformationRequests(user: CurrentUserDto, reportId: string) {
    const roles = this.getRoles(user);
    const isAdmin = roles.some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));

    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    // Viewing is open to any admin (see findOneForAdmin note); only the
    // non-admin path stays ownership-restricted to the reporter themselves.
    if (!isAdmin && report.userId !== user.id) {
      throw new NotFoundException('report_not_found');
    }

    return this.prisma.reportInformationRequest.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // GET ONE INFORMATION REQUEST
  //
  // Backs GET /reports/:id/information-requests/:requestId. Same
  // access rule as findInformationRequests: the reporter sees
  // requests on their own report; an admin sees requests on any
  // report they're allowed to open.
  // ─────────────────────────────────────────────

  async findOneInformationRequest(user: CurrentUserDto, reportId: string, requestId: string) {
    const roles = this.getRoles(user);
    const isAdmin = roles.some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));

    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    // Viewing is open to any admin (see findOneForAdmin note); only the
    // non-admin path stays ownership-restricted to the reporter themselves.
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

  // ─────────────────────────────────────────────
  // RESPOND TO INFORMATION REQUEST (USER)
  //
  // Backs POST /reports/:id/information-requests/:requestId/respond.
  // Only the reporter who owns the report may respond, and only to
  // a request still PENDING. responseFiles is validated against
  // MinIO before being persisted, same as any other media field.
  //
  // FIX (notifications): INFORMATION_REQUEST_RESPONDED now includes
  // caseReference, and now actually has a listener (previously the
  // event was emitted but silently dropped — no @OnEvent handler
  // existed for it).
  // ─────────────────────────────────────────────

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
      diff: { result: 'success', informationRequestId: requestId },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_REQUEST_RESPONDED, {
      reportId,
      caseReference: report.caseReference,
      informationRequestId: requestId,
      requestedById: infoRequest.requestedById,
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // ASSIGN (ADMIN)
  //
  // Persists assignedToId and flips status to ASSIGNED
  // when that transition is legal from the report's
  // current status. Validates the target user actually
  // holds an admin role.
  //   ⚠️ ASSUMPTION: userRoles -> role.name shape.
  //   Adjust to your real UserRole/Role schema.
  //
  // FIX (item #22/#26): the status-changing branch now uses a
  // conditional update guarded on the status read a moment
  // earlier, same reasoning as updateStatus() — prevents a race
  // where the report's status changed between the read and the
  // write. The assignedToId-only branch (no status change) has no
  // such race to guard against, so it stays a plain update.
  //
  // NOTE: if the current status does not allow a direct
  // transition to ASSIGNED (e.g. reassigning a report
  // that is already IN_PROGRESS), assignedToId is still
  // updated but status is left unchanged. Confirm this
  // silent-no-status-change behavior is what you want for
  // reassignment — otherwise consider throwing instead.
  //
  // FIX (notifications): REPORT_ASSIGNED now includes
  // caseReference, and now actually has a listener (previously the
  // event was emitted but silently dropped).
  // ─────────────────────────────────────────────

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
      throw new BadRequestException('report_transition_conflict');
    }

    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_ASSIGNED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        assignedToUserId: data.assignedToUserId,
        previousStatus: existing.status,
        currentStatus: report.status,
        note: data.note ?? null,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_ASSIGNED, {
      reportId,
      caseReference: report.caseReference,
      assignedToUserId: data.assignedToUserId,
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // UNASSIGN (ADMIN)
  //
  // Clears assignedToId back to null. Restricted to
  // SUPER_ADMIN at the controller level, mirroring assign()'s
  // current role restriction. Status is left unchanged — same
  // silent-no-status-change approach assign() already takes;
  // revisit if you'd rather step status back to UNDER_REVIEW
  // when a report becomes unassigned. No status change here, so
  // no concurrency guard is needed beyond confirming the report
  // still exists.
  // ─────────────────────────────────────────────

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
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_UNASSIGNED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        previousAssignedToId: existing.assignedToId,
      },
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // ESCALATE (ADMIN)
  //
  // Checks ALLOWED_STATUS_TRANSITIONS directly instead of a
  // separate terminal-state blocklist, so escalate() and
  // updateStatus() enforce the same single rulebook. Also
  // enforces the same admin-access rule as the other admin
  // operations.
  //
  // FIX (item #22/#26): conditional update guarded on the status
  // read a moment earlier, same as updateStatus()/assign().
  //
  // FIX (notifications): HIGH_PRIORITY_REPORT now includes
  // caseReference and reason, and now actually has a listener
  // (previously the event was emitted but silently dropped).
  // ─────────────────────────────────────────────

  async escalate(admin: CurrentUserDto, reportId: string, data: EscalateReportDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.assertAdminCanAccessReport(admin, existing);

    const allowedNext = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(ReportStatus.ESCALATED)) {
      throw new BadRequestException(
        `invalid_status_transition: ${existing.status} -> ${ReportStatus.ESCALATED}`,
      );
    }

    const result = await this.prisma.report.updateMany({
      where: { id: reportId, status: existing.status },
      data: { status: ReportStatus.ESCALATED },
    });

    if (result.count === 0) {
      throw new BadRequestException('report_transition_conflict');
    }

    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_ESCALATED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        reason: data.reason,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.HIGH_PRIORITY_REPORT, {
      reportId: report.id,
      caseReference: report.caseReference,
      reason: data.reason,
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────

  private generateCaseReference(): string {
    const year = new Date().getFullYear();
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `EHT-${year}-${random}`;
  }

  // FIX (item #5/#26): now also handles a race on the NEW
  // (userId, idempotencyKey) unique constraint, not just the
  // pre-existing caseReference collision. A fast-path findFirst
  // already runs in create() before this is called, but that
  // check-then-create is inherently racy under concurrent
  // requests — two near-simultaneous retries with the same key can
  // both pass the findFirst and race to insert. This catches that
  // P2002 specifically (distinguished from a caseReference
  // collision via err.meta.target) and returns the row that won
  // the race instead of letting the raw Prisma error surface.
  //
  // Random 6-char case references aren't guaranteed unique either,
  // and caseReference is @unique in the schema, so a collision on
  // *that* constraint retries with a fresh reference instead.
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
            // loop and try again with a new random reference
            continue;
          }

          if (idempotencyKey && target?.some((t) => t.includes('idempotencyKey'))) {
            // Lost a race against a concurrent identical retry — the
            // other request's insert won; return that row instead of
            // creating (or failing to create) a duplicate.
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
    // Unreachable: the loop always returns or throws.
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
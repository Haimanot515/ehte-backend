import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { AuditOutcome, AuditSeverity, InformationStatus, MissingPersonStatus } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { MinioService } from 'src/services/minio/minio.service';

import {
  CreateInformationSubmissionDto,
  ListInformationSubmissionsQueryDto,
  UpdateInformationSubmissionDto,
} from '../dto/information-submission.dto';

// The six media-array fields shared by CreateInformationSubmissionDto/
// UpdateInformationSubmissionDto and the InformationSubmission model
// itself. Mirrors PostService's / VictimProfileService's
// MEDIA_FIELD_NAMES so every module stays in sync if a new media
// kind is ever added.
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

// ⚠️ ASSUMPTIONS ON THE AUDIT ENUM
//
// Two action names are referenced below that this file didn't
// previously import: AuditEventEnum.INFORMATION_SUBMISSION_UPDATED
// and AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_DOWNLOADED. Every
// other service in this codebase follows a <Entity>_<VERB> naming
// convention for its audit actions (REPORT_UPDATED, REPORT_MEDIA_
// DOWNLOADED, USER_UPDATED, SUPPORT_CANCELLED, ...), so these are
// assumed to exist or to be trivial additions to the shared enum. If
// they don't exist yet, add them there rather than repurposing an
// unrelated action name — reusing e.g. INFORMATION_SUBMITTED for an
// edit would make "who submitted this" and "who edited this" show up
// as the same action in a history view.

@Injectable()
export class InformationSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // Admin workflow.
  //
  //   PENDING → UNDER_REVIEW           (updateStatus)
  //   UNDER_REVIEW → REVIEWED|REJECTED (review — terminal)
  //   REVIEWED → (final)
  //   REJECTED → (final)
  // ─────────────────────────────────────────────

  private readonly ALLOWED_STATUS_TRANSITIONS: Record<InformationStatus, InformationStatus[]> = {
    [InformationStatus.PENDING]: [InformationStatus.UNDER_REVIEW],
    [InformationStatus.UNDER_REVIEW]: [],
    [InformationStatus.REVIEWED]: [],
    [InformationStatus.REJECTED]: [],
  };

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  private getRoles(user: CurrentUserDto): string[] {
    return (user as unknown as { roles?: string[] }).roles ?? [];
  }

  // FIX (audit review, item #4): InformationSubmission has no
  // caseReference-style human identifier, and the tipster is
  // deliberately anonymous-ish to the public (their identity is only
  // ever exposed to admins via findOneForAdmin). So the label leans
  // on whichever missing-person case the tip is about — the thing an
  // admin actually searches an audit list by — falling back to a
  // truncated snippet of the tip text, and only then to an id prefix.
  private buildSubmissionLabel(
    submission: { id: string; information: string },
    missingPersonName?: string | null,
  ): string {
    if (missingPersonName) {
      return `Tip re: ${missingPersonName}`;
    }
    const snippet = submission.information.trim().slice(0, 40);
    if (snippet) {
      return snippet.length < submission.information.trim().length ? `${snippet}…` : snippet;
    }
    return `submission:${submission.id.slice(0, 8)}`;
  }

  // ─────────────────────────────────────────────
  // MEDIA HELPERS
  //
  // Mirrors PostService's / VictimProfileService's media helpers.
  // InformationSubmission stores media as plain filepath strings in
  // typed arrays (photo/video/audio/pdf/document/other), same as
  // Post, Report, VictimProfile, and MissingPerson — kept in one
  // place so every read/write of that shape stays consistent.
  // ─────────────────────────────────────────────

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

  // FIX (item #3): previously only checked objectExists(). Now mirrors
  // PostService.validateMediaFilesExist() — also rejects files that are
  // too large or of a disallowed content-type, and returns each file's
  // size so callers can maintain mediaTotalBytes without re-statting
  // already-attached files.
  //
  // Shares the MEDIA_MAX_FILE_SIZE / MEDIA_ALLOWED_MIME_TYPES config
  // keys with Post — one bucket-wide policy, not a per-module one,
  // since the underlying risk (fake/dangerous files) is identical.
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

  // FIX (item #13): per-field attachment counts, checked before any
  // MinIO round trips. Shares the CONTENT_* shared defaults with Post/
  // Report/etc.; an optional INFORMATION_SUBMISSION_* override lets
  // this module diverge later without touching any other module's copy.
  private assertAttachmentCounts(media: MediaBearing): void {
    const maxPhotos = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_MAX_PHOTOS') ??
        this.configService.get<string>('CONTENT_MAX_PHOTOS') ??
        5,
    );
    const maxVideos = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_MAX_VIDEOS') ??
        this.configService.get<string>('CONTENT_MAX_VIDEOS') ??
        1,
    );
    const maxOther = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_MAX_OTHER_FILES') ??
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

  // FIX (item #13): total attached-media size cap, checked against the
  // running mediaTotalBytes column rather than re-summing every
  // attached file on every write.
  private assertTotalBytes(totalBytes: number): void {
    const maxTotalBytes = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_MAX_TOTAL_UPLOAD_BYTES') ??
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
  // MEDIA — DOWNLOAD URL (owner)
  // GET /information-submissions/:id/media?key=...
  //
  // No audit trail here, matching ReportService.getMediaDownloadUrl
  // (the reporter-facing equivalent) — a user downloading their own
  // attachment isn't a "someone accessed something" event the way an
  // admin doing the same is.
  // ─────────────────────────────────────────────

  async getMediaDownloadUrl(id: string, userId: string, key: string): Promise<{ url: string }> {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: { id },
    });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    if (submission.userId !== userId) {
      throw new ForbiddenException('not_authorized');
    }

    const owned = this.collectMediaFields(submission).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_submission');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  // ─────────────────────────────────────────────
  // ADMIN — MEDIA DOWNLOAD URL
  // GET /information-submissions/admin/:id/media?key=...
  //
  // FIX (audit review, items #1/#2/#5): this method previously took
  // no acting-admin parameter at all, so there was no honest way to
  // record who accessed a tipster's attachment — the exact case
  // ReportService.getMediaDownloadUrlForAdmin exists to audit. Now
  // mirrors it: a mismatched key emits a DENIED row before throwing
  // (a stale link, or someone probing for media on a submission they
  // have no other reason to open), the submitter is recorded as
  // targetUserId, and the accessed key is captured in metadata on
  // the success row.
  //
  // ⚠️ SIGNATURE CHANGE: takes the acting admin. Update the
  // controller to pass @CurrentUser().
  // ─────────────────────────────────────────────

  async getMediaDownloadUrlForAdmin(
    admin: CurrentUserDto,
    id: string,
    key: string,
  ): Promise<{ url: string }> {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: { id },
    });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    const actorType = resolveActorType(this.getRoles(admin));
    const label = this.buildSubmissionLabel(submission);

    const owned = this.collectMediaFields(submission).includes(key);
    if (!owned) {
      this.emitAudit({
        userId: admin.id,
        targetUserId: submission.userId,
        actorType,
        action: AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_DOWNLOADED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: submission.id,
        entityLabel: label,
        diff: { result: 'denied', reason: 'media_not_found_on_submission' },
        metadata: { requestedKey: key },
      });
      throw new NotFoundException('media_not_found_on_submission');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);

    this.emitAudit({
      userId: admin.id,
      targetUserId: submission.userId,
      actorType,
      action: AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_DOWNLOADED,
      entity: 'InformationSubmission',
      entityId: submission.id,
      entityLabel: label,
      diff: { result: 'success' },
      metadata: { key },
    });

    return { url };
  }

  // ─────────────────────────────────────────────
  // PUBLIC — MEDIA DOWNLOAD URL
  // GET /information-submissions/public/:id/media?key=...
  //
  // Media on a submission is only reachable once it has been
  // REVIEWED. A submission that exists but isn't reviewed yet
  // 404s here, not a different error shape.
  // ─────────────────────────────────────────────

  async getPublicMediaDownloadUrl(id: string, key: string): Promise<{ url: string }> {
    const submission = await this.prisma.informationSubmission.findFirst({
      where: {
        id,
        status: InformationStatus.REVIEWED,
      },
      select: {
        photo: true,
        video: true,
        audio: true,
        pdf: true,
        document: true,
        other: true,
      },
    });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    const owned = this.collectMediaFields(submission).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_submission');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  // ─────────────────────────────────────────────
  // CREATE INFORMATION
  // Only allowed against APPROVED (publicly visible) cases, and
  // not by the person who filed the missing-person report itself.
  //
  // FIX (item #1): per-user cooldown between submissions, plus a
  // cap on how many of a user's submissions can sit in
  // PENDING/UNDER_REVIEW at once — collapsed into one step here
  // since Information Submission has no separate draft→submit
  // flow the way Post does.
  //
  // FIX (item #5): optional Idempotency-Key lets a client safely
  // retry a create call after a dropped response — a repeat with
  // the same key returns the original submission instead of
  // creating a duplicate.
  //
  // FIX (item #13): attachment counts checked before any MinIO
  // round trips; total size persisted as mediaTotalBytes.
  //
  // FIX (audit review, item #1): actorType was hardcoded to
  // resolveActorType(['USER']) rather than resolved from the actual
  // submitter's roles — a plain typo-shaped bug (every other create()
  // in this codebase resolves from the real actor). It's now resolved
  // properly, which requires the actor's roles, so this method now
  // takes the full CurrentUserDto instead of a bare userId.
  //
  // ⚠️ SIGNATURE CHANGE: create(user: CurrentUserDto, ...) instead of
  // create(userId: string, ...). Update the controller accordingly.
  //
  // FIX (audit review, item #1, continued): every guard below —
  // not-approved, self-submission, rate limit, max-pending, media
  // validation — threw with no audit row. The not-approved and
  // self-submission guards run after the MissingPerson is loaded, so
  // both now emit against entity: 'MissingPerson' (there's no
  // InformationSubmission row yet to attach to). Deliberately NOT
  // fixed: missing_person_not_found itself, and the rate-limit/max-
  // pending/media-validation failures, for the same reason
  // ReportService.create() leaves its pre-creation guards unaudited —
  // no natural entity to hang the row on without a schema/product
  // decision on nullable entityIds.
  //
  // FIX (audit review, item #2): cannot_submit_information_on_own_report
  // is a user attempting to act on THEIR OWN missing-person report by
  // routing through the tip pathway — the missing person's owner
  // (i.e. the actor themselves here) is recorded as targetUserId for
  // consistency with how every other "acting on a record tied to a
  // user" case is audited elsewhere, even though actor and subject
  // are the same person in this specific case.
  //
  // FIX (audit review, item #4): entityLabel added, via the
  // already-loaded missingPerson's name.
  //
  // FIX (audit review, item #5): missingPersonId, attachment count,
  // and mediaTotalBytes are the investigative context worth keeping
  // and weren't captured before — moved into metadata.
  // ─────────────────────────────────────────────

  private async enforceCreateRateLimit(userId: string): Promise<void> {
    const cooldownSeconds = Number(
      this.configService.get<string>(
        'INFORMATION_SUBMISSION_CREATE_RATE_LIMIT_WINDOW_SECONDS',
      ) ??
        this.configService.get<string>('CONTENT_CREATE_RATE_LIMIT_WINDOW_SECONDS') ??
        60,
    );

    const last = await this.prisma.informationSubmission.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (last && Date.now() - last.createdAt.getTime() < cooldownSeconds * 1000) {
      throw new BadRequestException('information_submission_rate_limited');
    }
  }

  private async enforceMaxPending(userId: string): Promise<void> {
    const maxPending = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_MAX_PENDING_PER_USER') ??
        this.configService.get<string>('CONTENT_MAX_PENDING_PER_USER') ??
        5,
    );

    const pendingCount = await this.prisma.informationSubmission.count({
      where: {
        userId,
        status: { in: [InformationStatus.PENDING, InformationStatus.UNDER_REVIEW] },
      },
    });

    if (pendingCount >= maxPending) {
      throw new BadRequestException('too_many_pending_information_submissions');
    }
  }

  async create(
    user: CurrentUserDto,
    missingPersonId: string,
    data: CreateInformationSubmissionDto,
    idempotencyKey?: string,
  ) {
    const actorType = resolveActorType(this.getRoles(user));

    if (idempotencyKey) {
      const existing = await this.prisma.informationSubmission.findFirst({
        where: { userId: user.id, idempotencyKey },
      });
      if (existing) {
        // Safe replay of a duplicate submission (double-tap, retried
        // request after a flaky connection) — return the original
        // instead of creating a second one.
        return existing;
      }
    }

    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
    });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (missingPerson.status !== MissingPersonStatus.APPROVED) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.INFORMATION_SUBMITTED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'MissingPerson',
        entityId: missingPersonId,
        entityLabel: missingPerson.name ?? undefined,
        diff: {
          result: 'failure',
          reason: 'information_submission_not_allowed',
          missingPersonStatus: missingPerson.status,
        },
      });
      throw new BadRequestException('information_submission_not_allowed');
    }

    if (missingPerson.userId === user.id) {
      this.emitAudit({
        userId: user.id,
        targetUserId: missingPerson.userId,
        actorType,
        action: AuditEventEnum.INFORMATION_SUBMITTED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'MissingPerson',
        entityId: missingPersonId,
        entityLabel: missingPerson.name ?? undefined,
        diff: { result: 'denied', reason: 'cannot_submit_information_on_own_report' },
      });
      throw new ForbiddenException('cannot_submit_information_on_own_report');
    }

    await this.enforceCreateRateLimit(user.id);
    await this.enforceMaxPending(user.id);

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

    const submission = await this.prisma.informationSubmission.create({
      data: {
        userId: user.id,
        missingPersonId,

        information: data.information,
        location: data.location,

        photo: merged.photo,
        video: merged.video,
        audio: merged.audio,
        pdf: merged.pdf,
        document: merged.document,
        other: merged.other,
        mediaTotalBytes: totalBytes,

        status: InformationStatus.PENDING,
        idempotencyKey: idempotencyKey ?? null,
      },
    });

    this.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.INFORMATION_SUBMITTED,
      entity: 'InformationSubmission',
      entityId: submission.id,
      entityLabel: this.buildSubmissionLabel(submission, missingPerson.name),
      diff: {
        status: InformationStatus.PENDING,
        result: 'success',
      },
      metadata: {
        missingPersonId,
        attachmentCount: this.collectMediaFields(merged).length,
        mediaTotalBytes: totalBytes,
      },
    });

    return submission;
  }

  // ─────────────────────────────────────────────
  // GET MY SUBMISSIONS (paginated)
  // ─────────────────────────────────────────────

  async findMine(userId: string, query: ListInformationSubmissionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { userId, ...(query.status !== undefined ? { status: query.status } : {}) };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: {
          missingPerson: {
            select: { id: true, personType: true, name: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // ─────────────────────────────────────────────
  // GET SUBMISSIONS FOR MISSING PERSON (public, paginated)
  // ─────────────────────────────────────────────

  async findForMissingPerson(missingPersonId: string, query: ListInformationSubmissionsQueryDto) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
    });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      missingPersonId,
      status: { in: [InformationStatus.REVIEWED] },
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        select: {
          id: true,
          information: true,
          location: true,
          photo: true,
          video: true,
          audio: true,
          pdf: true,
          document: true,
          other: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // ─────────────────────────────────────────────
  // GET MY SUBMISSIONS FOR ONE MISSING PERSON
  // Lets the frontend check "did I already submit on this case"
  // before showing the submit form, instead of relying on the
  // self-submission/duplicate error at create time.
  // ─────────────────────────────────────────────

  async findMineForMissingPerson(userId: string, missingPersonId: string) {
    return this.prisma.informationSubmission.findMany({
      where: { userId, missingPersonId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // GET ONE — OWNER
  // ─────────────────────────────────────────────

  async findOne(id: string, userId: string) {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: { id },
      include: {
        missingPerson: {
          select: { id: true, personType: true, name: true, status: true },
        },
      },
    });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    if (submission.userId !== userId) {
      throw new ForbiddenException('not_authorized');
    }

    return submission;
  }

  // ─────────────────────────────────────────────
  // UPDATE — OWNER
  // Only while PENDING. Empty patches are rejected.
  //
  // Media handling: diffs each media field present in the request
  // against what's currently on the row. Newly-added filepaths are
  // validated against MinIO before the write; filepaths dropped
  // from the new array are deleted from MinIO after the write
  // commits — same ordering discipline as PostService.updateMyPost.
  //
  // FIX (item #13): attachment counts checked against the merged
  // post-update media shape; mediaTotalBytes recomputed from the
  // previous total plus/minus added/removed files' sizes.
  //
  // FIX (audit review, item #1 — the big one for this method): this
  // method emitted NO audit row at all, success or failure, despite
  // being a write to reporter-submitted evidence. Every guard
  // (not_authorized, submission_not_editable_in_current_status,
  // no_fields_provided, media validation) now emits a FAILURE/DENIED
  // row before throwing, and a SUCCESS row is emitted after the
  // write commits.
  //
  // ⚠️ SIGNATURE CHANGE: takes the full CurrentUserDto instead of a
  // bare userId string, since resolving actorType needs the actor's
  // roles — same reasoning as create() above. Update the controller
  // to pass @CurrentUser().
  //
  // FIX (audit review, item #4): entityLabel added.
  //
  // FIX (audit review, item #5): media churn (added/removed counts,
  // new total) captured in metadata, same as
  // ReportService.update()/PostService's equivalent.
  // ─────────────────────────────────────────────

  async update(id: string, user: CurrentUserDto, data: UpdateInformationSubmissionDto) {
    const actorType = resolveActorType(this.getRoles(user));

    const existing = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('information_submission_not_found');
    }

    const label = this.buildSubmissionLabel(existing);

    if (existing.userId !== user.id) {
      this.emitAudit({
        userId: user.id,
        targetUserId: existing.userId,
        actorType,
        action: AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: id,
        entityLabel: label,
        diff: { result: 'denied', reason: 'not_authorized' },
      });
      throw new ForbiddenException('not_authorized');
    }

    if (existing.status !== InformationStatus.PENDING) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'submission_not_editable_in_current_status',
          currentStatus: existing.status,
        },
      });
      throw new ForbiddenException('submission_not_editable_in_current_status');
    }

    const hasAnyField = Object.values(data).some((value) => value !== undefined);

    if (!hasAnyField) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: id,
        entityLabel: label,
        diff: { result: 'failure', reason: 'no_fields_provided' },
      });
      throw new BadRequestException('no_fields_provided');
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

      // Stat removed files before they're deleted, purely to back out
      // their bytes from the running total — a stat failure here
      // (already gone, MinIO hiccup) just means we can't credit that
      // byte count back, so treat it as 0 rather than blocking the
      // update.
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
        actorType,
        action: AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'media_validation_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: {
        ...(data.information !== undefined ? { information: data.information } : {}),
        ...(data.location !== undefined ? { location: data.location } : {}),
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
    // the write fail would strand the submission pointing at
    // nothing.
    await this.deleteMediaFiles(removed);

    this.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
      entity: 'InformationSubmission',
      entityId: updated.id,
      entityLabel: this.buildSubmissionLabel(updated),
      diff: { result: 'success' },
      metadata: {
        mediaAdded: added.length,
        mediaRemoved: removed.length,
        mediaTotalBytes: newTotalBytes,
      },
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // DELETE — OWNER
  // Only while PENDING. Deletes the DB row, then removes every
  // attached media object from MinIO — once the row referencing
  // them is gone, an orphaned object in the bucket serves no
  // purpose. Same ordering as PostService.deleteMyPost.
  //
  // FIX (audit review, item #1): both guards (not_authorized,
  // only_pending_submissions_can_be_deleted) threw with no row. Now
  // emit DENIED/FAILURE before throwing.
  //
  // FIX (audit review, item #4): entityLabel added — built before the
  // delete, since the row (and the label's source data) won't exist
  // afterward.
  //
  // FIX (audit review, item #5): count of media objects removed
  // wasn't captured anywhere — added to metadata.
  // ─────────────────────────────────────────────

  async remove(id: string, user: CurrentUserDto) {
    const actorType = resolveActorType(this.getRoles(user));

    const existing = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('information_submission_not_found');
    }

    const label = this.buildSubmissionLabel(existing);

    if (existing.userId !== user.id) {
      this.emitAudit({
        userId: user.id,
        targetUserId: existing.userId,
        actorType,
        action: AuditEventEnum.INFORMATION_SUBMISSION_DELETED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: id,
        entityLabel: label,
        diff: { result: 'denied', reason: 'not_authorized' },
      });
      throw new ForbiddenException('not_authorized');
    }

    if (existing.status !== InformationStatus.PENDING) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.INFORMATION_SUBMISSION_DELETED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'only_pending_submissions_can_be_deleted',
          currentStatus: existing.status,
        },
      });
      throw new ForbiddenException('only_pending_submissions_can_be_deleted');
    }

    await this.prisma.informationSubmission.delete({ where: { id } });

    const mediaFields = this.collectMediaFields(existing);
    await this.deleteMediaFiles(mediaFields);

    this.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.INFORMATION_SUBMISSION_DELETED,
      entity: 'InformationSubmission',
      entityId: id,
      entityLabel: label,
      diff: {
        previousStatus: existing.status,
        result: 'success',
      },
      metadata: {
        missingPersonId: existing.missingPersonId,
        mediaFilesRemoved: mediaFields.length,
      },
    });

    return { message: 'information_submission_deleted' };
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ALL (paginated, lightweight — no nested detail)
  // ─────────────────────────────────────────────

  async findAllForAdmin(query: ListInformationSubmissionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { ...(query.status !== undefined ? { status: query.status } : {}) };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        // user / missingPerson detail no longer included here —
        // use admin/:id for full detail on one record.
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ONE (full detail)
  //
  // NOTE (audit gap, deliberately NOT fixed here): this include pulls
  // the tipster's name and phone — the same class of PII access
  // ReportService.findOneForAdmin audits as REPORTER_INFORMATION_
  // OPENED. It isn't audited here because doing so needs (a) an
  // acting-admin parameter, which this method doesn't currently take,
  // and (b) confidence that a matching action enum member exists,
  // which I don't have for this file the way I did for Report's. Add
  // an `admin: CurrentUserDto` parameter and an
  // INFORMATION_SUBMITTER_INFORMATION_OPENED-shaped emit here once
  // that enum member exists, following the exact pattern in
  // ReportService.findOneForAdmin.
  // ─────────────────────────────────────────────

  async findOneForAdmin(id: string) {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        missingPerson: true,
      },
    });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    return submission;
  }

  // ─────────────────────────────────────────────
  // ADMIN — STALE / UNREVIEWED-TOO-LONG SUBMISSIONS
  // GET /information-submissions/admin/stale
  // (item #15)
  //
  // Flags PENDING or UNDER_REVIEW submissions older than the shared
  // CONTENT_STALE_PENDING_HOURS default, mirroring
  // PostService.findStalePending. Purely informational — nothing
  // here changes status or ownership.
  // ─────────────────────────────────────────────

  async findStalePending() {
    const staleHours = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_STALE_PENDING_HOURS') ??
        this.configService.get<string>('CONTENT_STALE_PENDING_HOURS') ??
        48,
    );
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

    const submissions = await this.prisma.informationSubmission.findMany({
      where: {
        status: { in: [InformationStatus.PENDING, InformationStatus.UNDER_REVIEW] },
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
    });

    return submissions.map((s) => ({
      ...s,
      pendingHours: Math.floor((Date.now() - s.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
  }

  // ─────────────────────────────────────────────
  // ADMIN — HISTORY
  // GET /information-submissions/admin/:id/history
  // (item #18)
  //
  // ASSUMPTION: same auditLog model assumption as
  // PostService.getHistory / VictimProfile's admin history endpoint
  // — adjust the model/field names if your schema differs.
  // ─────────────────────────────────────────────

  async getHistory(id: string) {
    await this.findOneForAdmin(id); // 404s if the submission doesn't exist

    return this.prisma.auditLog.findMany({
      where: { entity: 'InformationSubmission', entityId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  // Only moves PENDING → UNDER_REVIEW. Terminal decisions
  // (REVIEWED / REJECTED) must go through review().
  //
  // FIX (audit review, item #1): the invalid-transition guard threw
  // with no row. Now emits FAILURE first.
  //
  // FIX (audit review, item #4): entityLabel added.
  //
  // NOTE: the submission.status === status branch stays a silent
  // no-op rather than an audited failure — unlike ReportService's
  // updateStatus, a same-status "transition" here isn't reachable
  // from more than one caller racing (there's exactly one legal
  // transition out of PENDING), so it's much more likely to be an
  // idempotent retry than a conflict worth surfacing.
  // ─────────────────────────────────────────────

  async updateStatus(admin: CurrentUserDto, id: string, status: InformationStatus) {
    const actorType = resolveActorType(this.getRoles(admin));

    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    if (submission.status === status) {
      return submission;
    }

    const label = this.buildSubmissionLabel(submission);
    const allowedNext = this.ALLOWED_STATUS_TRANSITIONS[submission.status] ?? [];

    if (!allowedNext.includes(status)) {
      this.emitAudit({
        userId: admin.id,
        targetUserId: submission.userId,
        actorType,
        action: AuditEventEnum.INFORMATION_UNDER_REVIEW,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: id,
        entityLabel: label,
        diff: {
          result: 'failure',
          currentStatus: submission.status,
          attemptedStatus: status,
        },
      });
      throw new BadRequestException(`invalid_status_transition: ${submission.status} -> ${status}`);
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { status },
    });

    this.emitAudit({
      userId: admin.id,
      targetUserId: submission.userId,
      actorType,
      action: AuditEventEnum.INFORMATION_UNDER_REVIEW,
      entity: 'InformationSubmission',
      entityId: updated.id,
      entityLabel: label,
      diff: {
        previousStatus: submission.status,
        newStatus: updated.status,
        result: 'success',
      },
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVIEW (terminal decision)
  // Only valid from UNDER_REVIEW. reviewNote required on REJECTED.
  //
  // FIX (audit review, item #2): submissionOwnerId was buried inside
  // `diff`, which should describe the change to the submission's
  // status — the tipster whose submission this is about the actual
  // subject of an admin's terminal decision, so it's now the
  // top-level targetUserId instead.
  //
  // FIX (audit review, item #3): reviewNote is the reviewing admin's
  // actual human-written rationale (mandatory on rejection, optional
  // on approval) — it was previously only forwarded to the
  // notification event and never written to the audit trail at all.
  // Now promoted to the top-level reason column.
  //
  // FIX (audit review, item #1): all three guards
  // (invalid_review_status, invalid_status_transition,
  // review_note_required_for_rejection) threw with no row. Now emit
  // FAILURE first. The reviewer's roles are resolved up front so
  // these early emits have a real actorType rather than a guess.
  //
  // FIX (audit review, item #4): entityLabel added.
  //
  // FIX (audit review, item #5): missingPersonId added to metadata —
  // it was already in the notification payload but never in the
  // audit row itself.
  // ─────────────────────────────────────────────

  async review(
    id: string,
    status: InformationStatus,
    reviewNote: string | undefined,
    reviewer: CurrentUserDto,
  ) {
    const actorType = resolveActorType(this.getRoles(reviewer));

    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    const label = this.buildSubmissionLabel(submission);

    if (status !== InformationStatus.REVIEWED && status !== InformationStatus.REJECTED) {
      this.emitAudit({
        userId: reviewer.id,
        targetUserId: submission.userId,
        actorType,
        action: AuditEventEnum.INFORMATION_REJECTED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: id,
        entityLabel: label,
        diff: { result: 'failure', reason: 'invalid_review_status', attemptedStatus: status },
      });
      throw new BadRequestException('invalid_review_status');
    }

    const auditEventForStatus =
      status === InformationStatus.REVIEWED
        ? AuditEventEnum.INFORMATION_REVIEWED
        : AuditEventEnum.INFORMATION_REJECTED;

    if (submission.status !== InformationStatus.UNDER_REVIEW) {
      this.emitAudit({
        userId: reviewer.id,
        targetUserId: submission.userId,
        actorType,
        action: auditEventForStatus,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'invalid_status_transition',
          currentStatus: submission.status,
          attemptedStatus: status,
        },
      });
      throw new BadRequestException(`invalid_status_transition: ${submission.status} -> ${status}`);
    }

    if (status === InformationStatus.REJECTED && !reviewNote?.trim()) {
      this.emitAudit({
        userId: reviewer.id,
        targetUserId: submission.userId,
        actorType,
        action: auditEventForStatus,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: id,
        entityLabel: label,
        diff: { result: 'failure', reason: 'review_note_required_for_rejection' },
      });
      throw new BadRequestException('review_note_required_for_rejection');
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: {
        status,
        ...(reviewNote !== undefined ? { reviewNote } : {}),
      },
    });

    this.emitAudit({
      userId: reviewer.id,
      targetUserId: submission.userId,
      actorType,
      action: auditEventForStatus,
      entity: 'InformationSubmission',
      entityId: updated.id,
      entityLabel: label,
      reason: reviewNote ?? null,
      diff: {
        previousStatus: submission.status,
        newStatus: status,
        result: 'success',
      },
      metadata: { missingPersonId: submission.missingPersonId },
    });

    const notificationEvent =
      status === InformationStatus.REVIEWED
        ? NotificationEventEnum.INFORMATION_SUBMISSION_REVIEWED
        : NotificationEventEnum.INFORMATION_SUBMISSION_REJECTED;

    this.eventEmitter.emit(notificationEvent, {
      userId: submission.userId,
      informationSubmissionId: updated.id,
      missingPersonId: submission.missingPersonId,
      status: updated.status,
      reviewNote,
    });

    return updated;
  }
}
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import {
  AuditOutcome,
  AuditSeverity,
  InformationStatus,
  MissingPersonStatus,
  Prisma,
  RewardClaimStatus,
  InformationPriority as PrismaInformationPriority,
  InformationCredibility as PrismaInformationCredibility,
  InformationRedactionMode as PrismaInformationRedactionMode,
} from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { MinioService } from 'src/services/minio/minio.service';
import { CacheService } from 'src/services/redis/cache.service';

import {
  AddInformationEvidenceDto,
  AdminInformationExportDto,
  AdminSearchInformationSubmissionsQueryDto,
  AppealInformationRejectionDto,
  CreateInformationSubmissionDto,
  EscalateInformationDto,
  InformationPaginationQueryDto,
  InformationStatsInterval,
  InformationStatsQueryDto,
  InformationStatsTimelineQueryDto,
  ListInformationSubmissionsQueryDto,
  MarkAllInformationReadDto,
  RedactInformationMediaDto,
  RespondToInformationQuestionDto,
  UpdateInformationSubmissionDto,
} from '../dto/information-submission.dto';

// Media array fields shared by the DTOs and the InformationSubmission model.
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
//
// ⚠️ ASSUMPTION ON THE CACHE SERVICE
//
// Same convention as MissingPersonService/PostService: getX/setX for
// a single cached row, wrapXList for a paginated/filterable list, and
// invalidateXList (rather than invalidateXEverywhere) since — unlike
// Post/MissingPerson — no single-submission public read exists here
// to invalidate, only the list.

@Injectable()
export class InformationSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
  ) {}

  // ─────────────────────────────────────────────
  // Admin workflow.
  //
  //   PENDING → UNDER_REVIEW           (updateStatus)
  //   UNDER_REVIEW → REVIEWED|REJECTED (review — terminal)
  //   REVIEWED → (final)
  //   REJECTED → (final)
  //
  // Both REVIEWED and REJECTED are terminal — there is no transition
  // back out of either. That matters for caching below: since
  // REVIEWED is the only status findForMissingPerson() ever serves,
  // and nothing can ever leave REVIEWED once it gets there, a
  // submission can only ever enter the cached public list once and
  // never has to be invalidated OUT of it — unlike Post (PUBLISHED
  // <-> UNPUBLISHED) or MissingPerson, which both need bidirectional
  // invalidation.
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

  // Labels by the missing-person case the tip is about, falling back to a snippet or id.
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

  private collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  private collectMediaFieldsFromDto(dto: MediaBearingDto): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => dto[field] ?? []);
  }

  // Diffs each media field individually so resending the same array isn't a remove+re-add.
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

  // Confirms every new filepath exists in the media bucket and is within size/type limits.
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

  // Per-field attachment caps, checked before any MinIO round trips.
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

  // Total attached-media size cap per submission.
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

  // Best-effort delete; a failure here must never block the DB write that triggered it.
  private async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  // Owner-facing download; not audited, same as ReportService's reporter-facing equivalent.
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

  // Admin download; a mismatched key emits DENIED before throwing, success is logged too.
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
  //
  // Deliberately NOT read through the cache: like
  // Post.getPublicMediaDownloadUrl, this is a narrow per-key lookup
  // rather than the whole public row, and MinIO presigned URLs are
  // already short-lived and cheap to mint.
  // ─────────────────────────────────────────────

  async getPublicMediaDownloadUrl(id: string, key: string): Promise<{ url: string }> {
    const submission = await this.prisma.informationSubmission.findFirst({
      where: {
        id,
        status: InformationStatus.REVIEWED,
        deletedAt: null, // NEW (soft delete)
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
  // A freshly created submission is always PENDING — never REVIEWED,
  // the only status the public cache holds — so there's nothing to
  // invalidate here.
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
      this.configService.get<string>('INFORMATION_SUBMISSION_CREATE_RATE_LIMIT_WINDOW_SECONDS') ??
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

  // Only allowed against APPROVED cases, and not by the case's own reporter.
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

    this.eventEmitter.emit(NotificationEventEnum.NEW_MISSING_PERSON_INFORMATION, {
      missingPersonId,
      informationSubmissionId: submission.id,
      userId: user.id,
    });

    return submission;
  }

  // ─────────────────────────────────────────────
  // GET MY SUBMISSIONS (paginated)
  // Owner-scoped, not public — no cache.
  // ─────────────────────────────────────────────

  async findMine(userId: string, query: ListInformationSubmissionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      userId,
      deletedAt: null, // NEW (soft delete)
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

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
  //
  // The one genuinely public, anonymous-callable read in this file —
  // no CurrentUserDto, already status-gated to REVIEWED, and the
  // select already excludes userId/reviewNote/idempotencyKey/etc., so
  // there's nothing internal left in the cached shape to leak. Same
  // read-through pattern as MissingPersonService.findAll/findAllUncached
  // and PostService.findPublishedPosts/findPublishedPostsUncached: the
  // cache key is derived from (missingPersonId, query), and the DB path
  // only runs on a miss.
  //
  // Invalidated from review() below, and ONLY there — see the
  // ALLOWED_STATUS_TRANSITIONS comment above for why entering REVIEWED
  // is the only transition that can ever change what this returns.
  // (Soft delete / restore below also invalidate it.)
  // ─────────────────────────────────────────────

  async findForMissingPerson(missingPersonId: string, query: ListInformationSubmissionsQueryDto) {
    return this.cache.wrapInformationSubmissionList(
      missingPersonId,
      query as unknown as Record<string, unknown>,
      () => this.findForMissingPersonUncached(missingPersonId, query),
    );
  }

  private async findForMissingPersonUncached(
    missingPersonId: string,
    query: ListInformationSubmissionsQueryDto,
  ) {
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
      deletedAt: null, // NEW (soft delete)
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
  // self-submission/duplicate error at create time. Owner-scoped,
  // not public — no cache.
  // ─────────────────────────────────────────────

  async findMineForMissingPerson(userId: string, missingPersonId: string) {
    return this.prisma.informationSubmission.findMany({
      where: { userId, missingPersonId, deletedAt: null }, // NEW (soft delete)
      orderBy: { createdAt: 'desc' },
    });
  }

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
  // Only while PENDING — never the REVIEWED status the public cache
  // holds — so no invalidation needed here.
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

      // Stat failure on a removed file just means 0 bytes credited back, not a blocker.
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

    // Delete only after the write commits, so a failed write never strands an orphan reference.
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
  // Only while PENDING — never REVIEWED — so no cache invalidation
  // needed here either, same reasoning as update() above.
  //
  // Deletes the DB row, then removes every attached media object
  // from MinIO — once the row referencing them is gone, an orphaned
  // object in the bucket serves no purpose. Same ordering as
  // PostService.deleteMyPost.
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
  // Admin-only — deliberately left uncached, same as
  // MissingPersonService.findAllForAdmin / PostService.findAll, so an
  // admin never acts on stale data.
  // ─────────────────────────────────────────────

  async findAllForAdmin(query: ListInformationSubmissionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      deletedAt: null, // NEW (soft delete)
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // Pulls the tipster's name and phone; not yet audited (needs an acting-admin param and enum member).
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

  // Admin dashboard stats: totals by status.
  async getStats() {
    const [total, byStatus] = await this.prisma.$transaction([
      this.prisma.informationSubmission.count({ where: { deletedAt: null } }), // NEW (soft delete)
      this.prisma.informationSubmission.groupBy({
        by: ['status'],
        where: { deletedAt: null }, // NEW (soft delete)
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(InformationStatus).map((status) => [status, 0]),
    ) as Record<InformationStatus, number>;

    for (const row of byStatus) {
      const rowCount = row._count as { status?: number } | undefined;
      statusCounts[row.status] = rowCount?.status ?? 0;
    }

    return {
      total,
      pending: statusCounts[InformationStatus.PENDING] ?? 0,
      underReview: statusCounts[InformationStatus.UNDER_REVIEW] ?? 0,
      reviewed: statusCounts[InformationStatus.REVIEWED] ?? 0,
      rejected: statusCounts[InformationStatus.REJECTED] ?? 0,
    };
  }

  // Flags PENDING/UNDER_REVIEW submissions older than the configured stale window.
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
        deletedAt: null, // NEW (soft delete)
      },
      orderBy: { createdAt: 'asc' },
    });

    return submissions.map((s) => ({
      ...s,
      pendingHours: Math.floor((Date.now() - s.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
  }

  async getHistory(id: string) {
    await this.findOneForAdmin(id);

    return this.prisma.auditLog.findMany({
      where: { entity: 'InformationSubmission', entityId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  // Only moves PENDING → UNDER_REVIEW — never REVIEWED — so no cache
  // invalidation needed here.
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
  // Cache: this is the ONLY method in the file that can move a
  // submission into REVIEWED — the sole status the public
  // findForMissingPerson() cache ever serves — so it's the only
  // place that needs to invalidate that cache. It's a plain
  // invalidation (not conditional on `status === REVIEWED`) purely
  // for readability, since REJECTED never appeared in the cache to
  // begin with; invalidating an entry that was never cached is a
  // cheap no-op, same reasoning MissingPersonService.updateStatus
  // gives for invalidating unconditionally on every transition.
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

    // G21: REVIEWED is the terminal decision that makes a submission
    // eligible for RewardService.approveClaim(submissionId) — the step
    // that turns a tip into a payout. userId is nullable on
    // InformationSubmission (anonymous/USSD tips per SubmissionChannel),
    // and there is no other identifying field on the model yet
    // (contactPhone is proposed in the section-9 schema review but not
    // migrated), so an anonymous tip cannot currently be verified or paid.
    // Block REVIEWED rather than let it through and fail later, silently
    // or otherwise, inside RewardService.
    if (status === InformationStatus.REVIEWED && !submission.userId) {
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
          reason: 'finder_not_verifiable',
          channel: submission.channel,
        },
        metadata: { missingPersonId: submission.missingPersonId },
      });
      throw new BadRequestException('finder_not_verifiable');
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: {
        status,
        ...(reviewNote !== undefined ? { reviewNote } : {}),
      },
    });

    await this.cache.invalidateInformationSubmissionList(submission.missingPersonId);

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

  // ═════════════════════════════════════════════════════════════════
  // NEW — everything below this line is new. Nothing above was changed
  // apart from the imports and the `NEW (soft delete)` filters.
  // ═════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────
  // SHARED HELPERS (new)
  // ─────────────────────────────────────────────

  private readonly OPEN_STATUSES: InformationStatus[] = [
    InformationStatus.PENDING,
    InformationStatus.UNDER_REVIEW,
  ];

  private readonly TERMINAL_STATUSES: InformationStatus[] = [
    InformationStatus.REVIEWED,
    InformationStatus.REJECTED,
  ];

  private readonly PRIORITY_RANK: Record<string, number> = {
    LOW: 0,
    NORMAL: 1,
    HIGH: 2,
    URGENT: 3,
  };

  // Emitted when an admin asks for a face/region blur. A worker is expected to listen for it,
  // write the redacted copy to MinIO and set InformationAttachment.redactedKey/redactionStatus.
  static readonly MEDIA_REDACTION_REQUESTED_EVENT = 'information-submission.media.redaction-requested';

  private isSuperAdmin(user: CurrentUserDto): boolean {
    return this.getRoles(user).includes(RolesEnum.SUPER_ADMIN);
  }

  private pageArgs(query: { page?: number; limit?: number }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return { page, limit, skip: (page - 1) * limit };
  }

  private pageMeta(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  private isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }

  // Prisma needs DbNull/JsonNull rather than null for nullable Json columns.
  private toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
    return value === undefined || value === null
      ? Prisma.DbNull
      : (value as Prisma.InputJsonValue);
  }

  // Not deleted, or 404.
  private async findLiveOrThrow(id: string) {
    const submission = await this.prisma.informationSubmission.findFirst({
      where: { id, deletedAt: null },
    });
    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }
    return submission;
  }

  // Owner check shared by the informant-facing actions. A non-owner gets a DENIED audit row.
  private async findOwnedOrThrow(user: CurrentUserDto, id: string, action: AuditEventEnum) {
    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!submission || submission.deletedAt) {
      throw new NotFoundException('information_submission_not_found');
    }

    if (submission.userId !== user.id) {
      this.emitAudit({
        userId: user.id,
        targetUserId: submission.userId,
        actorType: resolveActorType(this.getRoles(user)),
        action,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'InformationSubmission',
        entityId: id,
        entityLabel: this.buildSubmissionLabel(submission),
        diff: { result: 'denied', reason: 'not_authorized' },
      });
      throw new ForbiddenException('not_authorized');
    }

    return submission;
  }

  // A tip assigned to another reviewer can only be decided by them or a super admin.
  private assertNotLockedByOther(submission: { assignedToId: string | null }, admin: CurrentUserDto) {
    if (
      submission.assignedToId &&
      submission.assignedToId !== admin.id &&
      !this.isSuperAdmin(admin)
    ) {
      throw new ForbiddenException('assigned_to_another_reviewer');
    }
  }

  private assertNoLegalHold(submission: { legalHold: boolean }) {
    if (submission.legalHold) {
      throw new ForbiddenException('legal_hold_active');
    }
  }

  // One audit emit for the many admin/informant actions below.
  private auditAction(params: {
    actor: CurrentUserDto;
    action: AuditEventEnum;
    submission: { id: string; information: string; userId?: string | null };
    outcome?: AuditOutcome;
    severity?: AuditSeverity;
    reason?: string | null;
    diff?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    omitTarget?: boolean;
  }): void {
    const { actor, action, submission, outcome, severity, reason, diff, metadata, omitTarget } =
      params;

    this.emitAudit({
      userId: actor.id,
      ...(omitTarget ? {} : { targetUserId: submission.userId ?? undefined }),
      actorType: resolveActorType(this.getRoles(actor)),
      action,
      ...(outcome ? { outcome } : {}),
      ...(severity ? { severity } : {}),
      entity: 'InformationSubmission',
      entityId: submission.id,
      entityLabel: this.buildSubmissionLabel(submission),
      ...(reason !== undefined ? { reason } : {}),
      diff: diff ?? { result: outcome && outcome !== AuditOutcome.SUCCESS ? 'failure' : 'success' },
      ...(metadata ? { metadata } : {}),
    });
  }

  // New activity from the informant makes the tip unread again for every admin.
  private async markUnreadForAdmins(submissionId: string): Promise<void> {
    await this.prisma.informationAdminRead.deleteMany({ where: { submissionId } });
  }

  private async recordRevisions(
    submissionId: string,
    actorId: string | null,
    changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>,
    reason?: string | null,
  ): Promise<void> {
    if (!changes.length) return;
    await this.prisma.informationRevision.createMany({
      data: changes.map((c) => ({
        submissionId,
        actorId,
        field: c.field,
        oldValue: this.toJson(c.oldValue),
        newValue: this.toJson(c.newValue),
        reason: reason ?? null,
      })),
    });
  }

  // When the tip was decided, read from the audit trail so it works for every code path
  // that decides a tip. Falls back to updatedAt for rows that predate auditing.
  private async decisionAt(
    id: string,
    actions: AuditEventEnum[],
    fallback?: Date,
  ): Promise<Date | null> {
    const row = await this.prisma.auditLog.findFirst({
      where: {
        entity: 'InformationSubmission',
        entityId: id,
        outcome: AuditOutcome.SUCCESS,
        action: { in: actions as string[] },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? fallback ?? null;
  }

  private async userNameMap(ids: Array<string | null | undefined>): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private async caseNameMap(ids: string[]): Promise<Map<string, { name: string | null; personType: string }>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const cases = await this.prisma.missingPerson.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true, personType: true },
    });
    return new Map(cases.map((c) => [c.id, { name: c.name, personType: c.personType }]));
  }

  // Runs one action per id and reports each outcome, so a bad id never sinks the whole batch.
  private async runBulk(
    ids: string[],
    fn: (id: string) => Promise<unknown>,
  ): Promise<{
    requested: number;
    succeeded: number;
    failed: number;
    results: Array<{ id: string; ok: boolean; error?: string }>;
  }> {
    const unique = [...new Set(ids)];
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];

    for (const id of unique) {
      try {
        await fn(id);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({
          id,
          ok: false,
          error: err instanceof Error ? err.message : 'unknown_error',
        });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    return {
      requested: unique.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    };
  }

  // Removes one file from whichever media array holds it and credits its bytes back.
  // The MinIO delete happens after the row is updated, same ordering as update() above.
  private async detachMedia(
    existing: MediaBearing & { id: string; mediaTotalBytes: number },
    key: string,
  ): Promise<{ field: MediaFieldName; size: number }> {
    const field = MEDIA_FIELD_NAMES.find((f) => existing[f].includes(key));
    if (!field) {
      throw new NotFoundException('media_not_found_on_submission');
    }

    const attachment = await this.prisma.informationAttachment.findUnique({
      where: { submissionId_key: { submissionId: existing.id, key } },
    });

    let size = attachment?.size ?? 0;
    try {
      size = (await this.minioService.statObject(key)).size;
    } catch {
      // Keep the stored size; a missing object just credits what we recorded.
    }

    await this.prisma.informationSubmission.update({
      where: { id: existing.id },
      data: {
        [field]: existing[field].filter((k) => k !== key),
        mediaTotalBytes: Math.max(0, existing.mediaTotalBytes - size),
      } as Prisma.InformationSubmissionUpdateInput,
    });

    await this.prisma.informationAttachment.deleteMany({
      where: { submissionId: existing.id, key },
    });

    await this.deleteMediaFiles([key, ...(attachment?.redactedKey ? [attachment.redactedKey] : [])]);

    return { field, size };
  }

  // ─────────────────────────────────────────────
  // INFORMANT — SUMMARY / UNSEEN UPDATES
  //
  // "Unseen" = status differs from informantSeenStatus, or a question/message
  // was added after informantSeenAt. Comparing two columns is why this is raw SQL.
  // Status changes are detected from the column itself, so tips decided by any
  // code path (review(), updateStatus(), markDuplicate()...) show up.
  // ─────────────────────────────────────────────

  async countMyUnreadUpdates(user: CurrentUserDto): Promise<{ count: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count
      FROM information_submission s
      WHERE s."userId" = ${user.id}
        AND s."deletedAt" IS NULL
        AND (
          s.status <> s."informantSeenStatus"
          OR EXISTS (
            SELECT 1 FROM information_timeline_event e
            WHERE e."submissionId" = s.id
              AND e.type::text IN ('QUESTION_ASKED', 'MESSAGE')
              AND e."createdAt" > COALESCE(s."informantSeenAt", s."createdAt")
          )
        )
    `);
    return { count: rows[0]?.count ?? 0 };
  }

  async getMySummary(user: CurrentUserDto) {
    const [byStatus, openQuestions, unread] = await Promise.all([
      this.prisma.informationSubmission.groupBy({
        by: ['status'],
        where: { userId: user.id, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.informationQuestion.count({
        where: { answeredAt: null, submission: { userId: user.id, deletedAt: null } },
      }),
      this.countMyUnreadUpdates(user),
    ]);

    const counts = Object.fromEntries(
      Object.values(InformationStatus).map((s) => [s, 0]),
    ) as Record<InformationStatus, number>;
    for (const row of byStatus) {
      counts[row.status] = row._count._all;
    }

    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      pending: counts.PENDING,
      underReview: counts.UNDER_REVIEW,
      reviewed: counts.REVIEWED,
      rejected: counts.REJECTED,
      openQuestions,
      unreadUpdates: unread.count,
    };
  }

  // Raw so that marking seen doesn't bump updatedAt.
  async markAllMineSeen(user: CurrentUserDto) {
    const updated = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE information_submission
      SET "informantSeenStatus" = status, "informantSeenAt" = NOW()
      WHERE "userId" = ${user.id} AND "deletedAt" IS NULL
    `);
    return { updated };
  }

  async markMineSeen(user: CurrentUserDto, id: string) {
    await this.findOwnedOrThrow(user, id, AuditEventEnum.INFORMATION_SUBMISSION_UPDATED);

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE information_submission
      SET "informantSeenStatus" = status, "informantSeenAt" = NOW()
      WHERE id = ${id}
    `);
    return { id, seen: true };
  }

  // ─────────────────────────────────────────────
  // INFORMANT — TIMELINE
  //
  // Three sources, merged by time:
  //   1. the submission itself
  //   2. InformationTimelineEvent rows (questions, answers, messages, evidence, appeal)
  //   3. status changes, read from the audit trail (action + reason column)
  // Admin-only things (assignment, priority, credibility, escalation, read state)
  // are never included.
  // ─────────────────────────────────────────────

  async getMyTimeline(user: CurrentUserDto, id: string) {
    const submission = await this.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
    );

    const statusActions: Array<{ action: AuditEventEnum; status: InformationStatus }> = [
      { action: AuditEventEnum.INFORMATION_UNDER_REVIEW, status: InformationStatus.UNDER_REVIEW },
      { action: AuditEventEnum.INFORMATION_REVIEWED, status: InformationStatus.REVIEWED },
      { action: AuditEventEnum.INFORMATION_REJECTED, status: InformationStatus.REJECTED },
    ];

    const [events, statusRows] = await Promise.all([
      this.prisma.informationTimelineEvent.findMany({
        where: { submissionId: id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, type: true, message: true, data: true, createdAt: true },
      }),
      this.prisma.auditLog.findMany({
        where: {
          entity: 'InformationSubmission',
          entityId: id,
          outcome: AuditOutcome.SUCCESS,
          action: { in: statusActions.map((s) => s.action as string) },
        },
        orderBy: { createdAt: 'asc' },
        select: { action: true, reason: true, createdAt: true },
      }),
    ]);

    const entries = [
      { type: 'SUBMITTED', at: submission.createdAt, status: InformationStatus.PENDING, message: null as string | null },
      ...statusRows.map((row) => ({
        type: 'STATUS_CHANGED',
        at: row.createdAt,
        status: statusActions.find((s) => (s.action as string) === row.action)?.status ?? null,
        message: row.reason ?? null,
      })),
      ...events.map((e) => ({
        type: e.type as string,
        at: e.createdAt,
        status: null as InformationStatus | null,
        message: e.message,
        eventId: e.id,
      })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());

    return { submissionId: id, status: submission.status, entries };
  }

  async getMyQuestions(user: CurrentUserDto, id: string) {
    await this.findOwnedOrThrow(user, id, AuditEventEnum.INFORMATION_SUBMISSION_UPDATED);

    return this.prisma.informationQuestion.findMany({
      where: { submissionId: id, answeredAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, question: true, createdAt: true },
    });
  }

  // ─────────────────────────────────────────────
  // INFORMANT — ANSWER A QUESTION
  //
  // questionId is optional: without it the oldest open question is answered.
  // The answer is claimed with an updateMany guarded on answeredAt IS NULL, so two
  // quick submissions can't both answer the same question.
  // ─────────────────────────────────────────────

  async respond(user: CurrentUserDto, id: string, data: RespondToInformationQuestionDto) {
    const submission = await this.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_QUESTION_ANSWERED,
    );

    const answer = data.answer.trim();
    if (!answer) {
      throw new BadRequestException('answer_required');
    }

    const question = data.questionId
      ? await this.prisma.informationQuestion.findFirst({
          where: { id: data.questionId, submissionId: id },
        })
      : await this.prisma.informationQuestion.findFirst({
          where: { submissionId: id, answeredAt: null },
          orderBy: { createdAt: 'asc' },
        });

    if (!question) {
      throw data.questionId
        ? new NotFoundException('question_not_found')
        : new BadRequestException('no_open_question');
    }

    if (question.answeredAt) {
      throw new ConflictException('question_already_answered');
    }

    const claimed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.informationQuestion.updateMany({
        where: { id: question.id, answeredAt: null },
        data: { answer, answeredAt: new Date() },
      });
      if (result.count === 0) return false;

      await tx.informationTimelineEvent.create({
        data: {
          submissionId: id,
          type: 'QUESTION_ANSWERED',
          actorId: user.id,
          message: answer,
          data: { questionId: question.id },
        },
      });
      await tx.informationAdminRead.deleteMany({ where: { submissionId: id } });
      return true;
    });

    if (!claimed) {
      throw new ConflictException('question_already_answered');
    }

    this.auditAction({
      actor: user,
      action: AuditEventEnum.INFORMATION_SUBMISSION_QUESTION_ANSWERED,
      submission,
      metadata: { questionId: question.id, missingPersonId: submission.missingPersonId },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_SUBMISSION_QUESTION_ANSWERED, {
      userId: user.id,
      informationSubmissionId: id,
      missingPersonId: submission.missingPersonId,
      questionId: question.id,
      assignedToId: submission.assignedToId,
    });

    return { message: 'answer_recorded', questionId: question.id };
  }

  // ─────────────────────────────────────────────
  // INFORMANT — ADD EVIDENCE AFTER SUBMITTING
  //
  // Allowed while the tip is PENDING or UNDER_REVIEW. Same validation as create():
  // counts against the merged result, files must exist in MinIO, total size capped.
  // Resending a key the tip already has is ignored; sending only such keys is a 400.
  // ─────────────────────────────────────────────

  async addEvidence(user: CurrentUserDto, id: string, data: AddInformationEvidenceDto) {
    const existing = await this.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_EVIDENCE_ADDED,
    );

    if (!this.OPEN_STATUSES.includes(existing.status)) {
      this.auditAction({
        actor: user,
        action: AuditEventEnum.INFORMATION_SUBMISSION_EVIDENCE_ADDED,
        submission: existing,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        diff: {
          result: 'failure',
          reason: 'submission_not_editable_in_current_status',
          currentStatus: existing.status,
        },
      });
      throw new ForbiddenException('submission_not_editable_in_current_status');
    }

    const incoming = this.collectMediaFieldsFromDto(data);
    if (!incoming.length) {
      throw new BadRequestException('no_evidence_provided');
    }

    const merged: MediaBearing = {
      photo: [...existing.photo],
      video: [...existing.video],
      audio: [...existing.audio],
      pdf: [...existing.pdf],
      document: [...existing.document],
      other: [...existing.other],
    };

    const added: string[] = [];
    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];

    for (const field of MEDIA_FIELD_NAMES) {
      const fresh = [...new Set(data[field] ?? [])].filter((fp) => !merged[field].includes(fp));
      if (!fresh.length) continue;
      changes.push({ field, oldValue: [...merged[field]], newValue: [...merged[field], ...fresh] });
      merged[field].push(...fresh);
      added.push(...fresh);
    }

    if (!added.length) {
      throw new BadRequestException('evidence_already_attached');
    }

    this.assertAttachmentCounts(merged);
    const validated = await this.validateMediaFilesExist(added);
    const addedBytes = validated.reduce((sum, v) => sum + v.size, 0);
    const newTotalBytes = existing.mediaTotalBytes + addedBytes;
    this.assertTotalBytes(newTotalBytes);

    const note = data.note?.trim() || null;

    const [updated] = await this.prisma.$transaction([
      this.prisma.informationSubmission.update({
        where: { id },
        data: { ...merged, mediaTotalBytes: newTotalBytes },
      }),
      this.prisma.informationTimelineEvent.create({
        data: {
          submissionId: id,
          type: 'EVIDENCE_ADDED',
          actorId: user.id,
          message: note,
          data: { count: added.length },
        },
      }),
      this.prisma.informationAdminRead.deleteMany({ where: { submissionId: id } }),
    ]);

    await this.recordRevisions(id, user.id, changes);

    this.auditAction({
      actor: user,
      action: AuditEventEnum.INFORMATION_SUBMISSION_EVIDENCE_ADDED,
      submission: updated,
      metadata: {
        mediaAdded: added.length,
        mediaTotalBytes: newTotalBytes,
        missingPersonId: existing.missingPersonId,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_SUBMISSION_EVIDENCE_ADDED, {
      userId: user.id,
      informationSubmissionId: id,
      missingPersonId: existing.missingPersonId,
      assignedToId: existing.assignedToId,
      count: added.length,
    });

    return updated;
  }

  // Owner removes one file; only while PENDING, same rule as update().
  async removeOwnMedia(user: CurrentUserDto, id: string, key: string) {
    const existing = await this.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_REMOVED,
    );

    if (existing.status !== InformationStatus.PENDING) {
      this.auditAction({
        actor: user,
        action: AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_REMOVED,
        submission: existing,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        diff: {
          result: 'failure',
          reason: 'submission_not_editable_in_current_status',
          currentStatus: existing.status,
        },
      });
      throw new ForbiddenException('submission_not_editable_in_current_status');
    }

    this.assertNoLegalHold(existing);

    const { field, size } = await this.detachMedia(existing, key);

    await this.recordRevisions(id, user.id, [
      { field, oldValue: existing[field], newValue: existing[field].filter((k) => k !== key) },
    ]);

    this.auditAction({
      actor: user,
      action: AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_REMOVED,
      submission: existing,
      metadata: { key, field, bytesFreed: size, missingPersonId: existing.missingPersonId },
    });

    return { message: 'media_removed', key };
  }

  // ─────────────────────────────────────────────
  // INFORMANT — OUTCOME (no case details)
  //
  // `helped` is only true when a linked reward claim reached VALID or later, and
  // false when every linked claim was judged INVALID/INELIGIBLE. Otherwise null
  // (not known yet). No case name, no reviewNote, nothing about other tips.
  // ─────────────────────────────────────────────

  async getMyOutcome(user: CurrentUserDto, id: string) {
    const submission = await this.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
    );

    const [claims, appeal] = await Promise.all([
      this.prisma.rewardClaim.findMany({
        where: { informationSubmissionId: id },
        select: { status: true },
      }),
      this.prisma.informationAppeal.findUnique({
        where: { submissionId: id },
        select: { status: true },
      }),
    ]);

    let outcome: 'IN_PROGRESS' | 'ACCEPTED' | 'NOT_ACCEPTED' | 'DUPLICATE' | 'ALREADY_KNOWN';
    if (this.OPEN_STATUSES.includes(submission.status)) {
      outcome = 'IN_PROGRESS';
    } else if (submission.status === InformationStatus.REVIEWED) {
      outcome = 'ACCEPTED';
    } else if (submission.resolution === 'DUPLICATE') {
      outcome = 'DUPLICATE';
    } else if (submission.resolution === 'ALREADY_KNOWN') {
      outcome = 'ALREADY_KNOWN';
    } else {
      outcome = 'NOT_ACCEPTED';
    }

    const positive: RewardClaimStatus[] = [
      RewardClaimStatus.VALID,
      RewardClaimStatus.APPROVED_FOR_REWARD,
      RewardClaimStatus.PAID_OUT,
    ];
    const negative: RewardClaimStatus[] = [
      RewardClaimStatus.INVALID,
      RewardClaimStatus.INELIGIBLE,
      RewardClaimStatus.REJECTED,
    ];

    let helped: boolean | null = null;
    if (outcome === 'NOT_ACCEPTED' || outcome === 'DUPLICATE' || outcome === 'ALREADY_KNOWN') {
      helped = false;
    } else if (claims.some((c) => positive.includes(c.status))) {
      helped = true;
    } else if (claims.length > 0 && claims.every((c) => negative.includes(c.status))) {
      helped = false;
    }

    const decidedAt = this.TERMINAL_STATUSES.includes(submission.status)
      ? await this.decisionAt(
          id,
          [AuditEventEnum.INFORMATION_REVIEWED, AuditEventEnum.INFORMATION_REJECTED],
          submission.updatedAt,
        )
      : null;

    return {
      submissionId: id,
      status: submission.status,
      outcome,
      helped,
      decidedAt,
      appealFiled: !!appeal,
      appealStatus: appeal?.status ?? null,
    };
  }

  // The informant's own reward claim state. Amounts only once a share has been approved.
  async getMyRewardStatus(user: CurrentUserDto, id: string) {
    await this.findOwnedOrThrow(user, id, AuditEventEnum.INFORMATION_SUBMISSION_UPDATED);

    const claims = await this.prisma.rewardClaim.findMany({
      where: { informationSubmissionId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        rewardAmount: true,
        approvedAt: true,
        createdAt: true,
        missingPerson: { select: { rewardCurrency: true } },
        disbursements: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true, executedAt: true },
        },
      },
    });

    const showAmount: RewardClaimStatus[] = [
      RewardClaimStatus.APPROVED_FOR_REWARD,
      RewardClaimStatus.PAID_OUT,
    ];

    return {
      submissionId: id,
      hasClaim: claims.length > 0,
      claims: claims.map((c) => ({
        id: c.id,
        status: c.status,
        rewardAmount: showAmount.includes(c.status) ? c.rewardAmount : null,
        currency: c.missingPerson.rewardCurrency,
        approvedAt: c.approvedAt,
        createdAt: c.createdAt,
        payout: c.disbursements[0]
          ? { status: c.disbursements[0].status, paidAt: c.disbursements[0].executedAt }
          : null,
      })),
    };
  }

  // ─────────────────────────────────────────────
  // INFORMANT — APPEAL A REJECTION
  //
  // One appeal per tip (unique on submissionId). The tip stays REJECTED — it is a
  // terminal status — so the appeal is a record for the review team, not a transition.
  // Window: INFORMATION_SUBMISSION_APPEAL_WINDOW_DAYS (default 14) from the rejection.
  // ─────────────────────────────────────────────

  async appealRejection(user: CurrentUserDto, id: string, data: AppealInformationRejectionDto) {
    const submission = await this.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_APPEALED,
    );

    if (submission.status !== InformationStatus.REJECTED) {
      this.auditAction({
        actor: user,
        action: AuditEventEnum.INFORMATION_SUBMISSION_APPEALED,
        submission,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        diff: { result: 'failure', reason: 'only_rejected_submissions_can_be_appealed', currentStatus: submission.status },
      });
      throw new BadRequestException('only_rejected_submissions_can_be_appealed');
    }

    const reason = data.reason.trim();
    if (!reason) {
      throw new BadRequestException('appeal_reason_required');
    }

    const existingAppeal = await this.prisma.informationAppeal.findUnique({
      where: { submissionId: id },
    });
    if (existingAppeal) {
      throw new ConflictException('appeal_already_filed');
    }

    const windowDays = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_APPEAL_WINDOW_DAYS') ?? 14,
    );
    const rejectedAt =
      (await this.decisionAt(id, [AuditEventEnum.INFORMATION_REJECTED], submission.updatedAt)) ??
      submission.updatedAt;

    if (Date.now() - rejectedAt.getTime() > windowDays * 24 * 60 * 60 * 1000) {
      this.auditAction({
        actor: user,
        action: AuditEventEnum.INFORMATION_SUBMISSION_APPEALED,
        submission,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        diff: { result: 'failure', reason: 'appeal_window_closed', windowDays },
      });
      throw new BadRequestException('appeal_window_closed');
    }

    let appeal;
    try {
      [appeal] = await this.prisma.$transaction([
        this.prisma.informationAppeal.create({
          data: { submissionId: id, userId: user.id, reason },
        }),
        this.prisma.informationTimelineEvent.create({
          data: { submissionId: id, type: 'APPEAL_FILED', actorId: user.id, message: reason },
        }),
        this.prisma.informationAdminRead.deleteMany({ where: { submissionId: id } }),
      ]);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException('appeal_already_filed');
      }
      throw err;
    }

    this.auditAction({
      actor: user,
      action: AuditEventEnum.INFORMATION_SUBMISSION_APPEALED,
      submission,
      reason,
      metadata: { missingPersonId: submission.missingPersonId, appealId: appeal.id },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_SUBMISSION_APPEALED, {
      userId: user.id,
      informationSubmissionId: id,
      missingPersonId: submission.missingPersonId,
      assignedToId: submission.assignedToId,
    });

    return { id: appeal.id, status: appeal.status, createdAt: appeal.createdAt };
  }

  // ─────────────────────────────────────────────
  // ADMIN — READ STATE
  //
  // Per admin, like ReportAdminRead: a row in information_admin_read means "this admin
  // has read this tip". Unread = no row for that admin. Deleted tips never count.
  // Informant activity (answer, evidence, appeal) deletes the rows, so the tip pops
  // back to unread for everyone.
  // ─────────────────────────────────────────────

  private unreadWhere(
    adminId: string,
    extra: Prisma.InformationSubmissionWhereInput = {},
  ): Prisma.InformationSubmissionWhereInput {
    return { deletedAt: null, adminReads: { none: { adminId } }, ...extra };
  }

  async markRead(admin: CurrentUserDto, id: string) {
    await this.findLiveOrThrow(id);

    await this.prisma.informationAdminRead.upsert({
      where: { submissionId_adminId: { submissionId: id, adminId: admin.id } },
      create: { submissionId: id, adminId: admin.id },
      update: { readAt: new Date() },
    });
    await this.prisma.informationAccessLog.create({
      data: { submissionId: id, adminId: admin.id, action: 'READ' },
    });

    return { id, isRead: true };
  }

  async markUnread(admin: CurrentUserDto, id: string) {
    await this.findLiveOrThrow(id);

    await this.prisma.informationAdminRead.deleteMany({
      where: { submissionId: id, adminId: admin.id },
    });
    return { id, isRead: false };
  }

  async bulkMarkRead(admin: CurrentUserDto, ids: string[]) {
    const unique = [...new Set(ids)];
    const found = await this.prisma.informationSubmission.findMany({
      where: { id: { in: unique }, deletedAt: null },
      select: { id: true },
    });

    await this.prisma.informationAdminRead.createMany({
      data: found.map((f) => ({ submissionId: f.id, adminId: admin.id })),
      skipDuplicates: true,
    });

    const foundIds = new Set(found.map((f) => f.id));
    return {
      requested: unique.length,
      updated: found.length,
      notFound: unique.filter((i) => !foundIds.has(i)),
    };
  }

  async bulkMarkUnread(admin: CurrentUserDto, ids: string[]) {
    const unique = [...new Set(ids)];
    const result = await this.prisma.informationAdminRead.deleteMany({
      where: { adminId: admin.id, submissionId: { in: unique } },
    });
    return { requested: unique.length, updated: result.count };
  }

  // Marks every unread tip matching the filter as read, in one statement.
  async markAllRead(admin: CurrentUserDto, data: MarkAllInformationReadDto) {
    const statusSql = data.status
      ? Prisma.sql`AND s.status = ${data.status}::"InformationStatus"`
      : Prisma.empty;
    const caseSql = data.missingPersonId
      ? Prisma.sql`AND s."missingPersonId" = ${data.missingPersonId}`
      : Prisma.empty;

    const marked = await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO information_admin_read ("submissionId", "adminId", "readAt")
      SELECT s.id, ${admin.id}, NOW()
      FROM information_submission s
      WHERE s."deletedAt" IS NULL
        ${statusSql}
        ${caseSql}
        AND NOT EXISTS (
          SELECT 1 FROM information_admin_read r
          WHERE r."submissionId" = s.id AND r."adminId" = ${admin.id}
        )
      ON CONFLICT DO NOTHING
    `);

    return { marked };
  }

  async markCaseRead(admin: CurrentUserDto, missingPersonId: string) {
    return this.markAllRead(admin, { missingPersonId });
  }

  async markCaseUnread(admin: CurrentUserDto, missingPersonId: string) {
    const result = await this.prisma.informationAdminRead.deleteMany({
      where: { adminId: admin.id, submission: { missingPersonId } },
    });
    return { updated: result.count };
  }

  // Unread queue: urgent first, then oldest first.
  async findUnread(admin: CurrentUserDto, query: ListInformationSubmissionsQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
    const where = this.unreadWhere(admin.id, query.status ? { status: query.status } : {});

    const [data, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: {
          missingPerson: { select: { id: true, name: true, personType: true } },
          assignedTo: { select: { id: true, name: true } },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    return { data, meta: this.pageMeta(page, limit, total) };
  }

  async countUnread(admin: CurrentUserDto) {
    const count = await this.prisma.informationSubmission.count({
      where: this.unreadWhere(admin.id),
    });
    return { count };
  }

  async countUnreadByStatus(admin: CurrentUserDto) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['status'],
      where: this.unreadWhere(admin.id),
      _count: { _all: true },
    });

    const counts = Object.fromEntries(
      Object.values(InformationStatus).map((s) => [s, 0]),
    ) as Record<InformationStatus, number>;
    for (const row of rows) counts[row.status] = row._count._all;

    return { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts };
  }

  async countUnreadByCase(admin: CurrentUserDto) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['missingPersonId'],
      where: this.unreadWhere(admin.id),
      _count: { _all: true },
      orderBy: { _count: { missingPersonId: 'desc' } },
      take: 200,
    });

    const cases = await this.caseNameMap(rows.map((r) => r.missingPersonId));

    return rows.map((r) => ({
      missingPersonId: r.missingPersonId,
      name: cases.get(r.missingPersonId)?.name ?? null,
      unread: r._count._all,
    }));
  }

  async getReadCounts(admin: CurrentUserDto) {
    const [total, unread] = await Promise.all([
      this.prisma.informationSubmission.count({ where: { deletedAt: null } }),
      this.prisma.informationSubmission.count({ where: this.unreadWhere(admin.id) }),
    ]);
    return { total, read: total - unread, unread };
  }

  // ─────────────────────────────────────────────
  // ADMIN — BY CASE
  // ─────────────────────────────────────────────

  async listByCase(admin: CurrentUserDto, query: InformationPaginationQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);

    const [rows, totalRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          missingPersonId: string;
          total: number;
          read: number;
          lastSubmittedAt: Date;
        }>
      >(Prisma.sql`
        SELECT s."missingPersonId",
               COUNT(*)::int AS total,
               COUNT(r."adminId")::int AS read,
               MAX(s."createdAt") AS "lastSubmittedAt"
        FROM information_submission s
        LEFT JOIN information_admin_read r
               ON r."submissionId" = s.id AND r."adminId" = ${admin.id}
        WHERE s."deletedAt" IS NULL
        GROUP BY s."missingPersonId"
        ORDER BY MAX(s."createdAt") DESC
        LIMIT ${limit} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "missingPersonId")::int AS count
        FROM information_submission WHERE "deletedAt" IS NULL
      `),
    ]);

    const cases = await this.caseNameMap(rows.map((r) => r.missingPersonId));

    return {
      data: rows.map((r) => ({
        missingPersonId: r.missingPersonId,
        name: cases.get(r.missingPersonId)?.name ?? null,
        personType: cases.get(r.missingPersonId)?.personType ?? null,
        total: r.total,
        read: r.read,
        unread: r.total - r.read,
        lastSubmittedAt: r.lastSubmittedAt,
      })),
      meta: this.pageMeta(page, limit, totalRows[0]?.count ?? 0),
    };
  }

  // Every tip on one case, each with isRead for the calling admin. query.isRead filters.
  async findByCase(
    admin: CurrentUserDto,
    missingPersonId: string,
    query: ListInformationSubmissionsQueryDto,
  ) {
    const { page, limit, skip } = this.pageArgs(query);

    const where: Prisma.InformationSubmissionWhereInput = {
      missingPersonId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.isRead === true ? { adminReads: { some: { adminId: admin.id } } } : {}),
      ...(query.isRead === false ? { adminReads: { none: { adminId: admin.id } } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: {
          assignedTo: { select: { id: true, name: true } },
          adminReads: { where: { adminId: admin.id }, select: { adminId: true } },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    const data = rows.map(({ adminReads, ...rest }) => ({ ...rest, isRead: adminReads.length > 0 }));
    return { data, meta: this.pageMeta(page, limit, total) };
  }

  // ─────────────────────────────────────────────
  // ADMIN — BY INFORMANT
  //
  // The list and summary below return an informant id and counts only — no name, no
  // phone — so they are safe with MISSING_PERSON_INFO_READ alone. Seeing who the person
  // is needs INFORMANT_IDENTITY_READ (+ re-authentication), and every such access is
  // written to information_identity_access.
  // ─────────────────────────────────────────────

  async listByInformant(admin: CurrentUserDto, query: InformationPaginationQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);

    const [rows, totalRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          informantId: string;
          total: number;
          read: number;
          accepted: number;
          rejected: number;
          lastSubmittedAt: Date;
        }>
      >(Prisma.sql`
        SELECT s."userId" AS "informantId",
               COUNT(*)::int AS total,
               COUNT(r."adminId")::int AS read,
               (COUNT(*) FILTER (WHERE s.status = 'REVIEWED'))::int AS accepted,
               (COUNT(*) FILTER (WHERE s.status = 'REJECTED'))::int AS rejected,
               MAX(s."createdAt") AS "lastSubmittedAt"
        FROM information_submission s
        LEFT JOIN information_admin_read r
               ON r."submissionId" = s.id AND r."adminId" = ${admin.id}
        WHERE s."deletedAt" IS NULL AND s."userId" IS NOT NULL
        GROUP BY s."userId"
        ORDER BY MAX(s."createdAt") DESC
        LIMIT ${limit} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "userId")::int AS count
        FROM information_submission WHERE "deletedAt" IS NULL AND "userId" IS NOT NULL
      `),
    ]);

    return {
      data: rows.map((r) => ({ ...r, unread: r.total - r.read })),
      meta: this.pageMeta(page, limit, totalRows[0]?.count ?? 0),
    };
  }

  // Informants with several tips rejected on the merits. Duplicate / already-known closures
  // are counted separately because they are not "false" tips.
  // Config: INFORMATION_SUBMISSION_REPEAT_REJECTION_THRESHOLD (3), ..._WINDOW_DAYS (90).
  async listRepeatRejections(query: InformationPaginationQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);

    const threshold = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_REPEAT_REJECTION_THRESHOLD') ?? 3,
    );
    const windowDays = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_REPEAT_REJECTION_WINDOW_DAYS') ?? 90,
    );
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const grouped = Prisma.sql`
      FROM information_submission
      WHERE "deletedAt" IS NULL AND "userId" IS NOT NULL AND "createdAt" >= ${since}
      GROUP BY "userId"
      HAVING (COUNT(*) FILTER (WHERE status = 'REJECTED' AND resolution IS NULL)) >= ${threshold}::int
    `;

    const [rows, totalRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          informantId: string;
          rejectedCount: number;
          closedAsDuplicateOrKnown: number;
          total: number;
          lastSubmittedAt: Date;
        }>
      >(Prisma.sql`
        SELECT "userId" AS "informantId",
               (COUNT(*) FILTER (WHERE status = 'REJECTED' AND resolution IS NULL))::int AS "rejectedCount",
               (COUNT(*) FILTER (WHERE status = 'REJECTED' AND resolution IS NOT NULL))::int AS "closedAsDuplicateOrKnown",
               COUNT(*)::int AS total,
               MAX("createdAt") AS "lastSubmittedAt"
        ${grouped}
        ORDER BY 2 DESC, 5 DESC
        LIMIT ${limit} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count FROM (SELECT "userId" ${grouped}) g
      `),
    ]);

    return {
      data: rows,
      meta: this.pageMeta(page, limit, totalRows[0]?.count ?? 0),
      criteria: { threshold, windowDays },
    };
  }

  // Needs INFORMANT_IDENTITY_READ + re-auth (controller). Shows the informant's identity,
  // so the lookup itself is logged and audited.
  async findByInformant(
    admin: CurrentUserDto,
    informantId: string,
    query: ListInformationSubmissionsQueryDto,
  ) {
    const informant = await this.prisma.user.findUnique({
      where: { id: informantId },
      select: { id: true, name: true, phone: true },
    });
    if (!informant) {
      throw new NotFoundException('informant_not_found');
    }

    const { page, limit, skip } = this.pageArgs(query);
    const where: Prisma.InformationSubmissionWhereInput = {
      userId: informantId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: { missingPerson: { select: { id: true, name: true, personType: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    await this.prisma.informationIdentityAccess.create({
      data: { informantId, adminId: admin.id, kind: 'INFORMANT_LOOKUP' },
    });

    this.emitAudit({
      userId: admin.id,
      targetUserId: informantId,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.INFORMATION_SUBMISSION_INFORMANT_LOOKUP,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: informantId,
      diff: { result: 'success' },
      metadata: { tipsReturned: data.length, total },
    });

    return { informant, data, meta: this.pageMeta(page, limit, total) };
  }

  // Totals by status plus a reliability label, with no identity. reliability.score is
  // reviewed / (reviewed + rejected on the merits); duplicates and already-known tips are
  // excluded from the score. Fewer than 3 decided tips = INSUFFICIENT_DATA.
  async getInformantSummary(_admin: CurrentUserDto, informantId: string) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['status', 'resolution'],
      where: { userId: informantId, deletedAt: null },
      _count: { _all: true },
    });

    if (!rows.length) {
      throw new NotFoundException('informant_not_found');
    }

    let total = 0;
    let reviewed = 0;
    let rejectedOnMerits = 0;
    let duplicate = 0;
    let alreadyKnown = 0;
    const byStatus = Object.fromEntries(
      Object.values(InformationStatus).map((s) => [s, 0]),
    ) as Record<InformationStatus, number>;

    for (const row of rows) {
      const n = row._count._all;
      total += n;
      byStatus[row.status] += n;
      if (row.status === InformationStatus.REVIEWED) reviewed += n;
      if (row.status === InformationStatus.REJECTED) {
        if (row.resolution === 'DUPLICATE') duplicate += n;
        else if (row.resolution === 'ALREADY_KNOWN') alreadyKnown += n;
        else rejectedOnMerits += n;
      }
    }

    const decided = reviewed + rejectedOnMerits;
    const score = decided > 0 ? reviewed / decided : null;
    const label =
      decided < 3 || score === null
        ? 'INSUFFICIENT_DATA'
        : score >= 0.7
          ? 'HIGH'
          : score >= 0.3
            ? 'MEDIUM'
            : 'LOW';

    return {
      informantId,
      total,
      byStatus,
      reviewed,
      rejectedOnMerits,
      duplicate,
      alreadyKnown,
      reliability: { score, label, decided },
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVEAL INFORMANT (one tip, with a reason)
  //
  // Not cached, never stored in the audit row: only who looked, when, why and for which
  // tip. Every call is its own information_identity_access row. This does NOT limit an
  // admin to a single reveal per tip — it makes each one visible to super admins through
  // getIdentityAccessLog(). previousReveals is returned so a repeat is obvious.
  // ─────────────────────────────────────────────

  async revealInformant(admin: CurrentUserDto, id: string, reason: string) {
    const submission = await this.findLiveOrThrow(id);

    const trimmed = reason.trim();
    if (!trimmed) {
      throw new BadRequestException('reason_required');
    }

    if (!submission.userId || submission.anonymizedAt) {
      throw new NotFoundException('informant_not_available');
    }

    const informant = await this.prisma.user.findUnique({
      where: { id: submission.userId },
      select: { id: true, name: true, phone: true },
    });
    if (!informant) {
      throw new NotFoundException('informant_not_available');
    }

    const previousReveals = await this.prisma.informationIdentityAccess.count({
      where: { submissionId: id, kind: 'REVEAL' },
    });

    await this.prisma.informationIdentityAccess.create({
      data: {
        submissionId: id,
        informantId: informant.id,
        adminId: admin.id,
        kind: 'REVEAL',
        reason: trimmed,
      },
    });

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_INFORMANT_REVEALED,
      submission,
      severity: AuditSeverity.WARNING,
      reason: trimmed,
      metadata: { missingPersonId: submission.missingPersonId, previousReveals },
    });

    return { submissionId: id, informant, revealedAt: new Date(), previousReveals };
  }

  // Super admin: every reveal for this tip, plus lookups of the same informant.
  async getIdentityAccessLog(id: string, query: InformationPaginationQueryDto) {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    const { page, limit, skip } = this.pageArgs(query);
    const where: Prisma.InformationIdentityAccessWhereInput = {
      OR: [
        { submissionId: id },
        ...(submission.userId
          ? [{ informantId: submission.userId, kind: 'INFORMANT_LOOKUP' as const }]
          : []),
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationIdentityAccess.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationIdentityAccess.count({ where }),
    ]);

    const names = await this.userNameMap(rows.map((r) => r.adminId));

    return {
      data: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        reason: r.reason,
        at: r.createdAt,
        admin: { id: r.adminId, name: names.get(r.adminId) ?? null },
      })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  // Super admin: who opened this tip in the admin area (information_access_log).
  // Rows are written by markRead(); see recordAdminView() for the detail-page hook.
  async getAccessLog(id: string, query: InformationPaginationQueryDto) {
    const exists = await this.prisma.informationSubmission.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('information_submission_not_found');
    }

    const { page, limit, skip } = this.pageArgs(query);
    const where = { submissionId: id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationAccessLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationAccessLog.count({ where }),
    ]);

    const names = await this.userNameMap(rows.map((r) => r.adminId));

    return {
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        at: r.createdAt,
        admin: { id: r.adminId, name: names.get(r.adminId) ?? null },
      })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  // Not wired to an endpoint. findOneForAdmin(id) doesn't receive the admin, so the detail
  // page view can't be logged from inside it. To log it, pass @CurrentUser() into that
  // controller handler and call this first.
  async recordAdminView(admin: CurrentUserDto, id: string): Promise<void> {
    await this.prisma.informationAccessLog.create({
      data: { submissionId: id, adminId: admin.id, action: 'VIEWED' },
    });
  }

  // ─────────────────────────────────────────────
  // ADMIN — CLAIM / ASSIGN
  //
  // A claim is a self-assignment of an unassigned tip. Once a tip has an assignee, only
  // that admin (or a super admin) can decide it through the actions below. review() and
  // updateStatus() above are unchanged and do not check the assignee; the bulk and
  // duplicate/already-known actions here do.
  // ─────────────────────────────────────────────

  private async assertAssignableAdmin(adminId: string) {
    const target = await this.prisma.user.findFirst({
      where: {
        id: adminId,
        isActive: true,
        userRoles: {
          some: { role: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] as string[] } } },
        },
      },
      select: { id: true, name: true },
    });
    if (!target) {
      throw new BadRequestException('assignee_must_be_an_active_admin');
    }
    return target;
  }

  async claim(admin: CurrentUserDto, id: string) {
    const submission = await this.findLiveOrThrow(id);

    if (!this.OPEN_STATUSES.includes(submission.status)) {
      throw new BadRequestException('submission_already_decided');
    }

    if (submission.assignedToId === admin.id) {
      return submission;
    }

    // Guarded on assignedToId IS NULL so two admins clicking at once can't both win.
    const result = await this.prisma.informationSubmission.updateMany({
      where: { id, assignedToId: null, deletedAt: null },
      data: { assignedToId: admin.id, assignedAt: new Date(), assignedById: admin.id },
    });
    if (result.count === 0) {
      throw new ConflictException('already_claimed');
    }

    await this.recordRevisions(id, admin.id, [
      { field: 'assignedToId', oldValue: null, newValue: admin.id },
    ]);

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_CLAIMED,
      submission,
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return this.prisma.informationSubmission.findUniqueOrThrow({ where: { id } });
  }

  async unclaim(admin: CurrentUserDto, id: string) {
    const submission = await this.findLiveOrThrow(id);

    if (!submission.assignedToId) {
      return submission;
    }
    if (submission.assignedToId !== admin.id && !this.isSuperAdmin(admin)) {
      throw new ForbiddenException('not_assigned_to_you');
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { assignedToId: null, assignedAt: null, assignedById: null },
    });

    await this.recordRevisions(id, admin.id, [
      { field: 'assignedToId', oldValue: submission.assignedToId, newValue: null },
    ]);

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_UNCLAIMED,
      submission,
      metadata: { missingPersonId: submission.missingPersonId, previousAssignee: submission.assignedToId },
    });

    return updated;
  }

  private async assignInternal(admin: CurrentUserDto, id: string, assigneeId: string) {
    const submission = await this.findLiveOrThrow(id);

    if (!this.OPEN_STATUSES.includes(submission.status)) {
      throw new BadRequestException('submission_already_decided');
    }
    if (submission.assignedToId === assigneeId) {
      return submission;
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { assignedToId: assigneeId, assignedAt: new Date(), assignedById: admin.id },
    });

    await this.recordRevisions(id, admin.id, [
      { field: 'assignedToId', oldValue: submission.assignedToId, newValue: assigneeId },
    ]);

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_ASSIGNED,
      submission,
      metadata: {
        missingPersonId: submission.missingPersonId,
        assigneeId,
        previousAssignee: submission.assignedToId,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_SUBMISSION_ASSIGNED, {
      userId: assigneeId,
      informationSubmissionId: id,
      missingPersonId: submission.missingPersonId,
      assignedById: admin.id,
    });

    return updated;
  }

  async assign(admin: CurrentUserDto, id: string, adminId: string) {
    await this.assertAssignableAdmin(adminId);
    return this.assignInternal(admin, id, adminId);
  }

  async unassign(admin: CurrentUserDto, id: string) {
    const submission = await this.findLiveOrThrow(id);

    if (!submission.assignedToId) {
      return submission;
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { assignedToId: null, assignedAt: null, assignedById: null },
    });

    await this.recordRevisions(id, admin.id, [
      { field: 'assignedToId', oldValue: submission.assignedToId, newValue: null },
    ]);

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_UNASSIGNED,
      submission,
      metadata: { missingPersonId: submission.missingPersonId, previousAssignee: submission.assignedToId },
    });

    return updated;
  }

  async bulkAssign(admin: CurrentUserDto, ids: string[], adminId: string) {
    await this.assertAssignableAdmin(adminId);
    return this.runBulk(ids, (id) => this.assignInternal(admin, id, adminId));
  }

  // ─────────────────────────────────────────────
  // ADMIN — BULK DECISIONS
  //
  // Each id goes through the unchanged review(), so validation, cache invalidation,
  // audit rows and informant notifications are exactly what a single review does.
  // The only addition is the assignee check. A tip still in PENDING is reported as a
  // per-id failure (invalid_status_transition) — move it to UNDER_REVIEW first.
  // ─────────────────────────────────────────────

  private async reviewOne(
    admin: CurrentUserDto,
    id: string,
    status: InformationStatus,
    reviewNote: string | undefined,
  ) {
    const submission = await this.findLiveOrThrow(id);
    this.assertNotLockedByOther(submission, admin);
    return this.review(id, status, reviewNote, admin);
  }

  async bulkReview(
    admin: CurrentUserDto,
    ids: string[],
    status: InformationStatus,
    reviewNote: string,
  ) {
    return this.runBulk(ids, (id) => this.reviewOne(admin, id, status, reviewNote));
  }

  async bulkReject(admin: CurrentUserDto, ids: string[], reviewNote: string) {
    return this.runBulk(ids, (id) =>
      this.reviewOne(admin, id, InformationStatus.REJECTED, reviewNote),
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — ASK / MESSAGE THE INFORMANT
  //
  // Both need a known informant (anonymous/USSD tips have none) and both show up in the
  // informant's timeline and unseen-update count. At most
  // INFORMATION_SUBMISSION_MAX_OPEN_QUESTIONS (3) questions can be open on one tip.
  // ─────────────────────────────────────────────

  async requestInformation(admin: CurrentUserDto, id: string, question: string) {
    const submission = await this.findLiveOrThrow(id);
    this.assertNotLockedByOther(submission, admin);

    const text = question.trim();
    if (!text) {
      throw new BadRequestException('question_required');
    }
    if (!submission.userId) {
      throw new BadRequestException('informant_not_reachable');
    }

    const maxOpen = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_MAX_OPEN_QUESTIONS') ?? 3,
    );
    const openCount = await this.prisma.informationQuestion.count({
      where: { submissionId: id, answeredAt: null },
    });
    if (openCount >= maxOpen) {
      throw new BadRequestException('too_many_open_questions');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const q = await tx.informationQuestion.create({
        data: { submissionId: id, askedById: admin.id, question: text },
      });
      await tx.informationTimelineEvent.create({
        data: {
          submissionId: id,
          type: 'QUESTION_ASKED',
          actorId: admin.id,
          message: text,
          data: { questionId: q.id },
        },
      });
      return q;
    });

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_QUESTION_ASKED,
      submission,
      reason: text,
      metadata: { questionId: created.id, missingPersonId: submission.missingPersonId },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_SUBMISSION_QUESTION_ASKED, {
      userId: submission.userId,
      informationSubmissionId: id,
      missingPersonId: submission.missingPersonId,
      questionId: created.id,
    });

    return { id: created.id, question: created.question, createdAt: created.createdAt };
  }

  async messageInformant(admin: CurrentUserDto, id: string, message: string) {
    const submission = await this.findLiveOrThrow(id);
    this.assertNotLockedByOther(submission, admin);

    const text = message.trim();
    if (!text) {
      throw new BadRequestException('message_required');
    }
    if (!submission.userId) {
      throw new BadRequestException('informant_not_reachable');
    }

    const event = await this.prisma.informationTimelineEvent.create({
      data: { submissionId: id, type: 'MESSAGE', actorId: admin.id, message: text },
    });

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_MESSAGE_SENT,
      submission,
      reason: text,
      metadata: { eventId: event.id, missingPersonId: submission.missingPersonId },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_SUBMISSION_MESSAGE, {
      userId: submission.userId,
      informationSubmissionId: id,
      missingPersonId: submission.missingPersonId,
      eventId: event.id,
    });

    return { id: event.id, createdAt: event.createdAt };
  }

  // ─────────────────────────────────────────────
  // ADMIN — TRIAGE: PRIORITY, CREDIBILITY, ESCALATION
  // ─────────────────────────────────────────────

  async setPriority(admin: CurrentUserDto, id: string, priority: string) {
    const submission = await this.findLiveOrThrow(id);
    const next = priority as PrismaInformationPriority;

    if (submission.priority === next) {
      return submission;
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { priority: next },
    });

    await this.recordRevisions(id, admin.id, [
      { field: 'priority', oldValue: submission.priority, newValue: next },
    ]);

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_PRIORITY_CHANGED,
      submission,
      diff: { previousPriority: submission.priority, newPriority: next, result: 'success' },
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return updated;
  }

  async setCredibility(admin: CurrentUserDto, id: string, credibility: string, reason: string) {
    const submission = await this.findLiveOrThrow(id);
    const next = credibility as PrismaInformationCredibility;

    const text = reason.trim();
    if (!text) {
      throw new BadRequestException('reason_required');
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: {
        credibility: next,
        credibilityReason: text,
        credibilitySetById: admin.id,
        credibilitySetAt: new Date(),
      },
    });

    await this.recordRevisions(
      id,
      admin.id,
      [{ field: 'credibility', oldValue: submission.credibility, newValue: next }],
      text,
    );

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_CREDIBILITY_CHANGED,
      submission,
      reason: text,
      diff: {
        previousCredibility: submission.credibility,
        newCredibility: next,
        result: 'success',
      },
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return updated;
  }

  // Urgent sighting. Raises (never lowers) the tip's priority, stores the escalation,
  // makes the tip unread for every admin and emits an ESCALATED notification event for
  // whatever referral flow listens to it.
  async escalate(admin: CurrentUserDto, id: string, data: EscalateInformationDto) {
    const submission = await this.findLiveOrThrow(id);

    const note = data.note.trim();
    if (!note) {
      throw new BadRequestException('note_required');
    }

    const requested = data.priority as string as PrismaInformationPriority;
    const raise = this.PRIORITY_RANK[requested] > this.PRIORITY_RANK[submission.priority];
    const newPriority = raise ? requested : submission.priority;

    const [escalation] = await this.prisma.$transaction([
      this.prisma.informationEscalation.create({
        data: { submissionId: id, escalatedById: admin.id, priority: requested, note },
      }),
      this.prisma.informationSubmission.update({
        where: { id },
        data: { priority: newPriority },
      }),
      this.prisma.informationAdminRead.deleteMany({ where: { submissionId: id } }),
    ]);

    if (raise) {
      await this.recordRevisions(id, admin.id, [
        { field: 'priority', oldValue: submission.priority, newValue: newPriority },
      ], note);
    }

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_ESCALATED,
      submission,
      severity: requested === 'URGENT' ? AuditSeverity.CRITICAL : AuditSeverity.WARNING,
      reason: note,
      diff: { requestedPriority: requested, newPriority, result: 'success' },
      metadata: { missingPersonId: submission.missingPersonId, escalationId: escalation.id },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_SUBMISSION_ESCALATED, {
      informationSubmissionId: id,
      missingPersonId: submission.missingPersonId,
      priority: requested,
      note,
      escalatedById: admin.id,
      assignedToId: submission.assignedToId,
    });

    return { escalation, priority: newPriority };
  }

  // ─────────────────────────────────────────────
  // ADMIN — CLOSE AS DUPLICATE / ALREADY KNOWN
  //
  // Both end as status REJECTED with `resolution` set, from PENDING or UNDER_REVIEW.
  // They emit the same INFORMATION_REJECTED audit action and informant notification as a
  // normal rejection, so the informant timeline, public cache (REJECTED is never cached)
  // and notification listeners need no special case. The informant is never told which
  // other tip it duplicates.
  // ─────────────────────────────────────────────

  private async closeWithResolution(
    admin: CurrentUserDto,
    id: string,
    resolution: 'DUPLICATE' | 'ALREADY_KNOWN',
    options: { duplicateOfId?: string; reason?: string },
  ) {
    const submission = await this.findLiveOrThrow(id);
    this.assertNotLockedByOther(submission, admin);

    if (!this.OPEN_STATUSES.includes(submission.status)) {
      throw new BadRequestException(
        `invalid_status_transition: ${submission.status} -> ${InformationStatus.REJECTED}`,
      );
    }

    let duplicateOfId: string | null = null;
    if (resolution === 'DUPLICATE') {
      if (!options.duplicateOfId || options.duplicateOfId === id) {
        throw new BadRequestException('invalid_duplicate_target');
      }
      const original = await this.prisma.informationSubmission.findFirst({
        where: { id: options.duplicateOfId, deletedAt: null },
        select: { id: true, missingPersonId: true, duplicateOfId: true, resolution: true },
      });
      if (!original) {
        throw new NotFoundException('duplicate_target_not_found');
      }
      if (original.missingPersonId !== submission.missingPersonId) {
        throw new BadRequestException('duplicate_must_be_on_same_case');
      }
      // Point at the root so duplicates never form a chain.
      duplicateOfId =
        original.resolution === 'DUPLICATE' && original.duplicateOfId
          ? original.duplicateOfId
          : original.id;
    }

    const note =
      options.reason?.trim() ||
      (resolution === 'DUPLICATE'
        ? 'This matches information we already received on this case.'
        : 'This information was already known to the case team.');

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: {
        status: InformationStatus.REJECTED,
        resolution,
        duplicateOfId,
        reviewNote: note,
      },
    });

    await this.recordRevisions(
      id,
      admin.id,
      [
        { field: 'status', oldValue: submission.status, newValue: InformationStatus.REJECTED },
        { field: 'resolution', oldValue: null, newValue: resolution },
        ...(duplicateOfId ? [{ field: 'duplicateOfId', oldValue: null, newValue: duplicateOfId }] : []),
      ],
      note,
    );

    this.emitAudit({
      userId: admin.id,
      targetUserId: submission.userId ?? undefined,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.INFORMATION_REJECTED,
      entity: 'InformationSubmission',
      entityId: id,
      entityLabel: this.buildSubmissionLabel(submission),
      reason: note,
      diff: {
        previousStatus: submission.status,
        newStatus: InformationStatus.REJECTED,
        resolution,
        result: 'success',
      },
      metadata: { missingPersonId: submission.missingPersonId, duplicateOfId },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_SUBMISSION_REJECTED, {
      userId: submission.userId,
      informationSubmissionId: id,
      missingPersonId: submission.missingPersonId,
      status: updated.status,
      reviewNote: note,
    });

    return updated;
  }

  async markDuplicate(admin: CurrentUserDto, id: string, duplicateOfId: string, reason?: string) {
    return this.closeWithResolution(admin, id, 'DUPLICATE', { duplicateOfId, reason });
  }

  async markAlreadyKnown(admin: CurrentUserDto, id: string, reason?: string) {
    return this.closeWithResolution(admin, id, 'ALREADY_KNOWN', { reason });
  }

  // ─────────────────────────────────────────────
  // ADMIN — WHAT CAN HAPPEN NEXT
  // ALLOWED_STATUS_TRANSITIONS above only covers updateStatus(); the terminal decision is
  // its own endpoint, so this merges both and says which endpoint performs each move.
  // ─────────────────────────────────────────────

  async getTransitions(id: string) {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: { id },
      select: {
        status: true,
        deletedAt: true,
        legalHold: true,
        assignedToId: true,
        userId: true,
      },
    });
    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    const open = !submission.deletedAt && this.OPEN_STATUSES.includes(submission.status);

    const allowed: Array<{ status: InformationStatus; via: string; requires?: string }> = [];
    if (open) {
      for (const next of this.ALLOWED_STATUS_TRANSITIONS[submission.status] ?? []) {
        allowed.push({ status: next, via: 'PATCH admin/:id/status' });
      }
      if (submission.status === InformationStatus.UNDER_REVIEW) {
        allowed.push({
          status: InformationStatus.REVIEWED,
          via: 'PATCH admin/:id/review',
          ...(submission.userId ? {} : { requires: 'known_informant' }),
        });
        allowed.push({
          status: InformationStatus.REJECTED,
          via: 'PATCH admin/:id/review',
          requires: 'reviewNote',
        });
      }
      allowed.push(
        { status: InformationStatus.REJECTED, via: 'PATCH admin/:id/mark-duplicate' },
        { status: InformationStatus.REJECTED, via: 'PATCH admin/:id/mark-already-known' },
      );
    }

    return {
      currentStatus: submission.status,
      isFinal: this.TERMINAL_STATUSES.includes(submission.status),
      isDeleted: !!submission.deletedAt,
      legalHold: submission.legalHold,
      assignedToId: submission.assignedToId,
      allowed,
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — RELATED TIPS
  // Same case, other tips, ranked by word overlap (Jaccard) over information + location.
  // Unicode-aware tokenising and no stop-word list, so it works for Amharic and English
  // alike. Plain JS over at most 300 recent tips on the case; swap for pg_trgm if a case
  // ever has far more. No informant identity in the result.
  // ─────────────────────────────────────────────

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 3),
    );
  }

  async findRelated(id: string) {
    const base = await this.findLiveOrThrow(id);

    const others = await this.prisma.informationSubmission.findMany({
      where: { missingPersonId: base.missingPersonId, id: { not: id }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        id: true,
        information: true,
        location: true,
        status: true,
        resolution: true,
        createdAt: true,
      },
    });

    const baseTokens = this.tokenize(`${base.information} ${base.location ?? ''}`);
    const minScore = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_RELATED_MIN_SCORE') ?? 0.15,
    );

    return others
      .map((o) => {
        const tokens = this.tokenize(`${o.information} ${o.location ?? ''}`);
        const shared = [...baseTokens].filter((t) => tokens.has(t));
        const union = new Set([...baseTokens, ...tokens]).size;
        const sameLocation =
          !!base.location &&
          !!o.location &&
          base.location.trim().toLowerCase() === o.location.trim().toLowerCase();
        const score = union === 0 ? 0 : shared.length / union + (sameLocation ? 0.1 : 0);
        return {
          id: o.id,
          status: o.status,
          resolution: o.resolution,
          createdAt: o.createdAt,
          similarity: Math.round(Math.min(score, 1) * 100) / 100,
          sameLocation,
          sharedTerms: shared.slice(0, 10),
          preview: o.information.length > 160 ? `${o.information.slice(0, 160)}…` : o.information,
        };
      })
      .filter((r) => r.similarity >= minScore)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 10);
  }

  // ─────────────────────────────────────────────
  // ADMIN — FIELD-LEVEL HISTORY
  // Covers changes made through the actions in this section (assignment, priority,
  // credibility, resolution, media). Edits the owner makes through update() above are
  // not recorded here until update() calls recordRevisions().
  // ─────────────────────────────────────────────

  async getRevisions(id: string, query: InformationPaginationQueryDto) {
    const exists = await this.prisma.informationSubmission.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('information_submission_not_found');
    }

    const { page, limit, skip } = this.pageArgs(query);
    const where = { submissionId: id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationRevision.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationRevision.count({ where }),
    ]);

    const names = await this.userNameMap(rows.map((r) => r.actorId));

    return {
      data: rows.map((r) => ({
        id: r.id,
        field: r.field,
        oldValue: r.oldValue,
        newValue: r.newValue,
        reason: r.reason,
        at: r.createdAt,
        actor: r.actorId ? { id: r.actorId, name: names.get(r.actorId) ?? null } : null,
      })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — ATTACHMENTS
  //
  // Files live only as string arrays on the submission, so per-file metadata is kept in
  // information_attachment and filled in lazily: the first listing stats any file that has
  // no row yet (size, content type, etag) and creates it; rows for files no longer on the
  // tip are dropped. scanStatus and sha256 are written by a scanning worker — until then
  // scanStatus is PENDING and `hash` falls back to the MinIO etag (not a sha256 for
  // multipart uploads).
  // ─────────────────────────────────────────────

  private fieldOfKey(entity: MediaBearing, key: string): MediaFieldName | undefined {
    return MEDIA_FIELD_NAMES.find((f) => entity[f].includes(key));
  }

  private async syncAttachmentRows(
    submission: MediaBearing & { id: string },
  ): Promise<void> {
    const keys = this.collectMediaFields(submission);

    await this.prisma.informationAttachment.deleteMany({
      where: { submissionId: submission.id, key: { notIn: keys } },
    });
    if (!keys.length) return;

    const known = await this.prisma.informationAttachment.findMany({
      where: { submissionId: submission.id },
      select: { key: true },
    });
    const knownKeys = new Set(known.map((k) => k.key));
    const missing = keys.filter((k) => !knownKeys.has(k));
    if (!missing.length) return;

    const stats = await Promise.allSettled(
      missing.map((key) => this.minioService.statObject(key)),
    );

    await this.prisma.informationAttachment.createMany({
      data: missing.map((key, i) => {
        const result = stats[i];
        const stat = result.status === 'fulfilled' ? result.value : null;
        return {
          submissionId: submission.id,
          key,
          field: this.fieldOfKey(submission, key) ?? 'other',
          size: stat?.size ?? 0,
          contentType: stat?.contentType ?? null,
          // Depends on what MinioService.statObject returns; null if it doesn't expose it.
          etag: (stat as unknown as { etag?: string } | null)?.etag ?? null,
          // A file we couldn't stat is flagged so it isn't mistaken for a clean, scanned one.
          scanStatus: stat ? ('PENDING' as const) : ('FAILED' as const),
        };
      }),
      skipDuplicates: true,
    });
  }

  async listAttachments(id: string) {
    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });
    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    await this.syncAttachmentRows(submission);

    const rows = await this.prisma.informationAttachment.findMany({
      where: { submissionId: id },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      field: r.field,
      type: r.contentType ?? r.field,
      size: r.size,
      scanStatus: r.scanStatus,
      scannedAt: r.scannedAt,
      hash: r.sha256 ?? r.etag ?? null,
      hashAlgorithm: r.sha256 ? 'sha256' : r.etag ? 'etag' : null,
      redaction: {
        status: r.redactionStatus,
        mode: r.redactionMode,
        requestedAt: r.redactionAt,
        redactedKey: r.redactedKey,
      },
      addedAt: r.createdAt,
    }));
  }

  // Super admin or admin, re-auth required (controller). Blocked while a legal hold is on.
  async removeMediaByAdmin(admin: CurrentUserDto, id: string, key: string) {
    const submission = await this.findLiveOrThrow(id);
    this.assertNoLegalHold(submission);
    this.assertNotLockedByOther(submission, admin);

    const { field, size } = await this.detachMedia(submission, key);

    await this.recordRevisions(id, admin.id, [
      {
        field,
        oldValue: submission[field],
        newValue: submission[field].filter((k) => k !== key),
      },
    ]);

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_REMOVED,
      submission,
      severity: AuditSeverity.WARNING,
      metadata: { key, field, bytesFreed: size, missingPersonId: submission.missingPersonId },
    });

    return { message: 'media_removed', key };
  }

  // ─────────────────────────────────────────────
  // ADMIN — REDACT A FILE
  //
  // This records the request and emits MEDIA_REDACTION_REQUESTED_EVENT. It does NOT blur
  // pixels itself: that needs an image/video worker, which wasn't part of what I was given.
  // The worker should write a redacted copy to MinIO and then set
  // information_attachment.redactedKey + redactionStatus = COMPLETED (or FAILED).
  // The original is kept, so a legal hold doesn't block a request. Until the download
  // endpoints are taught to prefer redactedKey, they keep serving the original.
  //
  // The DTO has no region coordinates, so BLUR_REGION can be requested but the worker has
  // nothing to locate the region with — add them to RedactInformationMediaDto if you need it.
  // ─────────────────────────────────────────────

  async redactMedia(
    admin: CurrentUserDto,
    id: string,
    key: string,
    data: RedactInformationMediaDto,
  ) {
    const submission = await this.findLiveOrThrow(id);

    const field = this.fieldOfKey(submission, key);
    if (!field) {
      throw new NotFoundException('media_not_found_on_submission');
    }
    if (field !== 'photo' && field !== 'video') {
      throw new BadRequestException('redaction_not_supported_for_type');
    }

    await this.syncAttachmentRows(submission);

    const attachment = await this.prisma.informationAttachment.findUniqueOrThrow({
      where: { submissionId_key: { submissionId: id, key } },
    });

    if (attachment.redactionStatus === 'REQUESTED') {
      throw new ConflictException('redaction_already_requested');
    }

    const mode = data.mode as string as PrismaInformationRedactionMode;
    const reason = data.reason?.trim() || null;

    const updated = await this.prisma.informationAttachment.update({
      where: { id: attachment.id },
      data: {
        redactionStatus: 'REQUESTED',
        redactionMode: mode,
        redactionReason: reason,
        redactionById: admin.id,
        redactionAt: new Date(),
        redactedKey: null,
      },
    });

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_REDACTION_REQUESTED,
      submission,
      severity: AuditSeverity.WARNING,
      reason,
      metadata: { key, field, mode, missingPersonId: submission.missingPersonId },
    });

    this.eventEmitter.emit(InformationSubmissionService.MEDIA_REDACTION_REQUESTED_EVENT, {
      informationSubmissionId: id,
      attachmentId: updated.id,
      key,
      mode,
      requestedById: admin.id,
    });

    return {
      key,
      field,
      redaction: { status: updated.redactionStatus, mode: updated.redactionMode },
    };
  }

  // Who downloaded, removed or asked to redact one file, from the audit trail.
  // Owner downloads are not audited (see getMediaDownloadUrl above), so they're absent.
  async getMediaCustody(id: string, key: string) {
    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });
    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }
    if (!this.collectMediaFields(submission).includes(key)) {
      throw new NotFoundException('media_not_found_on_submission');
    }

    const events = await this.prisma.auditLog.findMany({
      where: {
        entity: 'InformationSubmission',
        entityId: id,
        action: {
          in: [
            AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_DOWNLOADED,
            AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_REMOVED,
            AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_REDACTION_REQUESTED,
          ] as string[],
        },
        metadata: { path: ['key'], equals: key },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        createdAt: true,
        action: true,
        outcome: true,
        actorType: true,
        userId: true,
        user: { select: { id: true, name: true } },
      },
    });

    const attachment = await this.prisma.informationAttachment.findUnique({
      where: { submissionId_key: { submissionId: id, key } },
      select: { redactionStatus: true, redactionMode: true, redactionAt: true, scanStatus: true },
    });

    return {
      key,
      attachment,
      events: events.map((e) => ({
        id: e.id,
        at: e.createdAt,
        action: e.action,
        outcome: e.outcome,
        actorType: e.actorType,
        actor: e.user ? { id: e.user.id, name: e.user.name } : null,
      })),
    };
  }

  // ─────────────────────────────────────────────
  // SUPER ADMIN — RETENTION: LEGAL HOLD, SOFT DELETE, RESTORE, TRASH, ANONYMIZE
  //
  // Legal hold blocks removeByAdmin(), anonymize() and admin file removal. It does NOT
  // block the owner's own remove()/update() above — those are unchanged.
  //
  // Soft delete keeps the row and its files so it can be restored; nothing here purges.
  // It always invalidates the public list cache, since a REVIEWED tip leaves it.
  // ─────────────────────────────────────────────

  async setLegalHold(admin: CurrentUserDto, id: string, legalHold: boolean, reason: string) {
    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });
    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    const text = reason.trim();
    if (!text) {
      throw new BadRequestException('reason_required');
    }

    if (submission.legalHold === legalHold) {
      return submission;
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: legalHold
        ? { legalHold: true, legalHoldReason: text, legalHoldAt: new Date(), legalHoldById: admin.id }
        : { legalHold: false, legalHoldReason: null, legalHoldAt: null, legalHoldById: null },
    });

    await this.recordRevisions(
      id,
      admin.id,
      [{ field: 'legalHold', oldValue: submission.legalHold, newValue: legalHold }],
      text,
    );

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_LEGAL_HOLD_CHANGED,
      submission,
      severity: AuditSeverity.CRITICAL,
      reason: text,
      diff: { previousLegalHold: submission.legalHold, newLegalHold: legalHold, result: 'success' },
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return updated;
  }

  async removeByAdmin(admin: CurrentUserDto, id: string, reason: string) {
    const submission = await this.findLiveOrThrow(id);
    this.assertNoLegalHold(submission);

    const text = reason.trim();
    if (!text) {
      throw new BadRequestException('reason_required');
    }

    await this.prisma.informationSubmission.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById: admin.id, deleteReason: text },
    });

    await this.cache.invalidateInformationSubmissionList(submission.missingPersonId);

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_SOFT_DELETED,
      submission,
      severity: AuditSeverity.WARNING,
      reason: text,
      diff: { previousStatus: submission.status, result: 'success' },
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return { message: 'information_submission_removed' };
  }

  async restore(admin: CurrentUserDto, id: string, reason?: string) {
    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });
    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }
    if (!submission.deletedAt) {
      throw new BadRequestException('information_submission_not_deleted');
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { deletedAt: null, deletedById: null, deleteReason: null },
    });

    await this.cache.invalidateInformationSubmissionList(submission.missingPersonId);

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_RESTORED,
      submission,
      severity: AuditSeverity.WARNING,
      reason: reason?.trim() || null,
      diff: { result: 'success' },
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return updated;
  }

  async listTrash(query: InformationPaginationQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
    const where = { deletedAt: { not: null } };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: { missingPerson: { select: { id: true, name: true, personType: true } } },
        orderBy: { deletedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    const names = await this.userNameMap(rows.map((r) => r.deletedById));

    return {
      data: rows.map((r) => ({
        ...r,
        deletedBy: r.deletedById ? { id: r.deletedById, name: names.get(r.deletedById) ?? null } : null,
      })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  // ─────────────────────────────────────────────
  // SUPER ADMIN — ANONYMIZE
  //
  // For a closed tip: detaches the informant (userId → null) and clears the idempotency
  // key, the informant's appeal user id, and the informant id in this tip's timeline,
  // revision and identity-access rows. Blocked while a legal hold is on, and while a reward
  // claim on the tip is still active or paid (payout needs the informant).
  //
  // What it does NOT touch: the free text (information, location, answers) — it can contain
  // names — the audit_log rows (hash-chained, so editing them breaks the chain), and
  // reward_claims.informantUserId. The audit row for this action deliberately carries no
  // target user, so it doesn't re-link the tip to the person.
  // ─────────────────────────────────────────────

  async anonymize(admin: CurrentUserDto, id: string, reason: string) {
    const submission = await this.findLiveOrThrow(id);

    const text = reason.trim();
    if (!text) {
      throw new BadRequestException('reason_required');
    }

    if (!this.TERMINAL_STATUSES.includes(submission.status)) {
      throw new BadRequestException('submission_not_closed');
    }
    this.assertNoLegalHold(submission);

    if (submission.anonymizedAt) {
      return submission;
    }

    const releasable: RewardClaimStatus[] = [
      RewardClaimStatus.INVALID,
      RewardClaimStatus.DUPLICATE,
      RewardClaimStatus.ALREADY_KNOWN,
      RewardClaimStatus.INELIGIBLE,
      RewardClaimStatus.REJECTED,
      RewardClaimStatus.REFUNDED,
    ];
    const activeClaims = await this.prisma.rewardClaim.count({
      where: { informationSubmissionId: id, status: { notIn: releasable } },
    });
    if (activeClaims > 0) {
      throw new BadRequestException('reward_claim_in_progress');
    }

    const informantId = submission.userId;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (informantId) {
        await tx.informationAppeal.updateMany({
          where: { submissionId: id, userId: informantId },
          data: { userId: null },
        });
        await tx.informationTimelineEvent.updateMany({
          where: { submissionId: id, actorId: informantId },
          data: { actorId: null },
        });
        await tx.informationRevision.updateMany({
          where: { submissionId: id, actorId: informantId },
          data: { actorId: null },
        });
        await tx.informationIdentityAccess.updateMany({
          where: { submissionId: id, informantId },
          data: { informantId: null },
        });
      }

      return tx.informationSubmission.update({
        where: { id },
        data: {
          userId: null,
          idempotencyKey: null,
          anonymizedAt: new Date(),
          anonymizedById: admin.id,
        },
      });
    });

    this.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_ANONYMIZED,
      submission: { id: submission.id, information: submission.information },
      severity: AuditSeverity.CRITICAL,
      reason: text,
      diff: { result: 'success' },
      metadata: { missingPersonId: submission.missingPersonId },
      omitTarget: true,
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — SEARCH, FACETS, FILTER OPTIONS
  //
  // Search is case-insensitive substring matching (ILIKE) over the tip text, location,
  // review note, case name, and an exact id match. It is not ranked full-text search; add a
  // tsvector/pg_trgm index if volume makes this slow. Informant identity is never searched.
  // ─────────────────────────────────────────────

  async searchForAdmin(admin: CurrentUserDto, query: AdminSearchInformationSubmissionsQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
    const q = query.q.trim();

    const where: Prisma.InformationSubmissionWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      OR: [
        { id: q },
        { information: { contains: q, mode: 'insensitive' } },
        { location: { contains: q, mode: 'insensitive' } },
        { reviewNote: { contains: q, mode: 'insensitive' } },
        { missingPerson: { name: { contains: q, mode: 'insensitive' } } },
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: {
          missingPerson: { select: { id: true, name: true, personType: true } },
          assignedTo: { select: { id: true, name: true } },
          adminReads: { where: { adminId: admin.id }, select: { adminId: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    const data = rows.map(({ adminReads, ...rest }) => ({ ...rest, isRead: adminReads.length > 0 }));
    return { data, meta: this.pageMeta(page, limit, total), q };
  }

  async getFacets() {
    const base = { deletedAt: null };
    const [byStatus, byPriority, byCredibility, byChannel, byResolution, unassigned, assigned] =
      await Promise.all([
        this.prisma.informationSubmission.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
        this.prisma.informationSubmission.groupBy({ by: ['priority'], where: base, _count: { _all: true } }),
        this.prisma.informationSubmission.groupBy({ by: ['credibility'], where: base, _count: { _all: true } }),
        this.prisma.informationSubmission.groupBy({ by: ['channel'], where: base, _count: { _all: true } }),
        this.prisma.informationSubmission.groupBy({
          by: ['resolution'],
          where: { ...base, resolution: { not: null } },
          _count: { _all: true },
        }),
        this.prisma.informationSubmission.count({
          where: { ...base, assignedToId: null, status: { in: this.OPEN_STATUSES } },
        }),
        this.prisma.informationSubmission.groupBy({
          by: ['assignedToId'],
          where: { ...base, assignedToId: { not: null }, status: { in: this.OPEN_STATUSES } },
          _count: { _all: true },
        }),
      ]);

    const names = await this.userNameMap(assigned.map((a) => a.assignedToId));
    const toMap = <T extends string>(rows: Array<Record<string, unknown> & { _count: { _all: number } }>, key: string) =>
      Object.fromEntries(rows.map((r) => [String(r[key] as T), r._count._all]));

    return {
      status: toMap(byStatus, 'status'),
      priority: toMap(byPriority, 'priority'),
      credibility: toMap(byCredibility, 'credibility'),
      channel: toMap(byChannel, 'channel'),
      resolution: toMap(byResolution, 'resolution'),
      assignment: {
        unassignedOpen: unassigned,
        byAdmin: assigned.map((a) => ({
          adminId: a.assignedToId,
          name: a.assignedToId ? (names.get(a.assignedToId) ?? null) : null,
          open: a._count._all,
        })),
      },
    };
  }

  async getFilterOptions() {
    const [admins, caseRows] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          isActive: true,
          userRoles: {
            some: { role: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] as string[] } } },
          },
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 200,
      }),
      this.prisma.informationSubmission.groupBy({
        by: ['missingPersonId'],
        where: { deletedAt: null },
        _count: { _all: true },
        orderBy: { _max: { createdAt: 'desc' } },
        take: 200,
      }),
    ]);

    const cases = await this.caseNameMap(caseRows.map((c) => c.missingPersonId));

    return {
      statuses: Object.values(InformationStatus),
      priorities: Object.values(PrismaInformationPriority),
      credibilities: Object.values(PrismaInformationCredibility),
      channels: ['APP', 'USSD'],
      resolutions: ['DUPLICATE', 'ALREADY_KNOWN'],
      admins,
      cases: caseRows.map((c) => ({
        id: c.missingPersonId,
        name: cases.get(c.missingPersonId)?.name ?? null,
        tips: c._count._all,
      })),
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — CSV EXPORT
  //
  // No informant identity and no informant id. Rows are capped at
  // INFORMATION_SUBMISSION_EXPORT_MAX_ROWS (default 5000) and `truncated` says when the cap
  // cut the result short. Cells starting with = + - @ are prefixed with ' so a spreadsheet
  // won't run them as formulas. Every export writes an audit_export row and an audit event.
  // ─────────────────────────────────────────────

  private exportMaxRows(): number {
    return Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_EXPORT_MAX_ROWS') ?? 5000,
    );
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
      'id', 'createdAt', 'status', 'priority', 'credibility', 'resolution', 'channel',
      'missingPersonId', 'missingPersonName', 'location', 'information', 'reviewNote',
      'assignedToId', 'attachmentCount', 'mediaTotalBytes',
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
            s.id, s.createdAt, s.status, s.priority, s.credibility, s.resolution, s.channel,
            s.missingPersonId, s.missingPerson?.name, s.location, s.information, s.reviewNote,
            s.assignedToId, this.collectMediaFields(s).length, s.mediaTotalBytes,
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

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
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

  // ─────────────────────────────────────────────
  // ADMIN — BACKGROUND EXPORT JOBS
  //
  // The job runs in this process right after the request returns (no queue), so a restart
  // mid-run leaves the row RUNNING; getExportJob() reports such a row as FAILED after 30
  // minutes. If you have a queue (BullMQ etc.), call runExportJob(id) from its processor
  // instead of the fire-and-forget below.
  // ─────────────────────────────────────────────

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
    if (!job || (job.requestedById !== admin.id && !this.isSuperAdmin(admin))) {
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
        await this.deleteMediaFiles([job.storageKey]);
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

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.INFORMATION_SUBMISSION_EXPORT_DOWNLOADED,
      severity: AuditSeverity.WARNING,
      entity: 'InformationSubmission',
      diff: { result: 'success' },
      metadata: { jobId: id, rowCount: job.rowCount },
    });

    return { url, expiresAt: job.expiresAt };
  }

  // ─────────────────────────────────────────────
  // ADMIN — STATS
  //
  // Filters (all optional): from/to on createdAt, status, missingPersonId, assignedTo.
  // Soft-deleted tips are always excluded. Decision times are read from the audit trail
  // (first INFORMATION_UNDER_REVIEW, REVIEWED/REJECTED rows) so they're right for tips
  // decided through any code path, but they depend on the audit listener having persisted.
  // ─────────────────────────────────────────────

  private statsWhere(q: InformationStatsQueryDto): Prisma.InformationSubmissionWhereInput {
    return {
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.missingPersonId ? { missingPersonId: q.missingPersonId } : {}),
      ...(q.assignedTo ? { assignedToId: q.assignedTo } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
  }

  // Same filters as raw SQL conditions on alias `s`.
  private statsSql(q: InformationStatsQueryDto, opts: { dates?: boolean; status?: boolean } = {}) {
    const dates = opts.dates ?? true;
    const status = opts.status ?? true;
    const conds: Prisma.Sql[] = [Prisma.sql`s."deletedAt" IS NULL`];
    if (status && q.status) conds.push(Prisma.sql`s.status = ${q.status}::"InformationStatus"`);
    if (q.missingPersonId) conds.push(Prisma.sql`s."missingPersonId" = ${q.missingPersonId}`);
    if (q.assignedTo) conds.push(Prisma.sql`s."assignedToId" = ${q.assignedTo}`);
    if (dates && q.from) conds.push(Prisma.sql`s."createdAt" >= ${new Date(q.from)}`);
    if (dates && q.to) conds.push(Prisma.sql`s."createdAt" <= ${new Date(q.to)}`);
    return Prisma.join(conds, ' AND ');
  }

  private auditActionList(actions: AuditEventEnum[]) {
    return Prisma.join(actions.map((a) => a as string));
  }

  private round(n: number | null | undefined, digits = 1): number | null {
    return n === null || n === undefined ? null : Math.round(Number(n) * 10 ** digits) / 10 ** digits;
  }

  async getStatsTimeline(query: InformationStatsTimelineQueryDto) {
    const interval = Object.values(InformationStatsInterval).includes(
      query.interval as InformationStatsInterval,
    )
      ? (query.interval as string)
      : 'day';

    const rows = await this.prisma.$queryRaw<
      Array<{ bucket: Date; total: number; reviewed: number; rejected: number }>
    >(Prisma.sql`
      SELECT date_trunc(${interval}::text, s."createdAt") AS bucket,
             COUNT(*)::int AS total,
             (COUNT(*) FILTER (WHERE s.status = 'REVIEWED'))::int AS reviewed,
             (COUNT(*) FILTER (WHERE s.status = 'REJECTED'))::int AS rejected
      FROM information_submission s
      WHERE ${this.statsSql(query)}
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    return { interval, data: rows };
  }

  async getStatsByStatus(query: InformationStatsQueryDto) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['status'],
      where: this.statsWhere(query),
      _count: { _all: true },
    });

    const counts = Object.fromEntries(
      Object.values(InformationStatus).map((s) => [s, 0]),
    ) as Record<InformationStatus, number>;
    for (const row of rows) counts[row.status] = row._count._all;

    return { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts };
  }

  async getStatsByCase(query: InformationStatsQueryDto) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['missingPersonId'],
      where: this.statsWhere(query),
      _count: { _all: true },
      orderBy: { _count: { missingPersonId: 'desc' } },
      take: 50,
    });

    const cases = await this.caseNameMap(rows.map((r) => r.missingPersonId));

    return rows.map((r) => ({
      missingPersonId: r.missingPersonId,
      name: cases.get(r.missingPersonId)?.name ?? null,
      total: r._count._all,
    }));
  }

  async getStatsReviewTime(query: InformationStatsQueryDto) {
    const reviewActions = this.auditActionList([AuditEventEnum.INFORMATION_UNDER_REVIEW]);
    const decisionActions = this.auditActionList([
      AuditEventEnum.INFORMATION_REVIEWED,
      AuditEventEnum.INFORMATION_REJECTED,
    ]);

    const [row] = await this.prisma.$queryRaw<
      Array<{
        firstReviewCount: number;
        decidedCount: number;
        avgFirstReview: number | null;
        medianFirstReview: number | null;
        p90FirstReview: number | null;
        avgDecision: number | null;
        medianDecision: number | null;
        p90Decision: number | null;
      }>
    >(Prisma.sql`
      WITH t AS (
        SELECT s."createdAt",
          (SELECT MIN(a."createdAt") FROM audit_log a
            WHERE a.entity = 'InformationSubmission' AND a."entityId" = s.id
              AND a.outcome = 'SUCCESS' AND a.action IN (${reviewActions})) AS first_review_at,
          (SELECT MIN(a."createdAt") FROM audit_log a
            WHERE a.entity = 'InformationSubmission' AND a."entityId" = s.id
              AND a.outcome = 'SUCCESS' AND a.action IN (${decisionActions})) AS decided_at
        FROM information_submission s
        WHERE ${this.statsSql(query)}
      ),
      h AS (
        SELECT EXTRACT(EPOCH FROM (first_review_at - "createdAt")) / 3600 AS first_h,
               EXTRACT(EPOCH FROM (decided_at - "createdAt")) / 3600 AS decision_h
        FROM t
      )
      SELECT COUNT(first_h)::int AS "firstReviewCount",
             COUNT(decision_h)::int AS "decidedCount",
             AVG(first_h)::float AS "avgFirstReview",
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY first_h))::float AS "medianFirstReview",
             (percentile_cont(0.9) WITHIN GROUP (ORDER BY first_h))::float AS "p90FirstReview",
             AVG(decision_h)::float AS "avgDecision",
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY decision_h))::float AS "medianDecision",
             (percentile_cont(0.9) WITHIN GROUP (ORDER BY decision_h))::float AS "p90Decision"
      FROM h
    `);

    return {
      unit: 'hours',
      timeToFirstReview: {
        count: row?.firstReviewCount ?? 0,
        average: this.round(row?.avgFirstReview),
        median: this.round(row?.medianFirstReview),
        p90: this.round(row?.p90FirstReview),
      },
      timeToDecision: {
        count: row?.decidedCount ?? 0,
        average: this.round(row?.avgDecision),
        median: this.round(row?.medianDecision),
        p90: this.round(row?.p90Decision),
      },
    };
  }

  // Open tips at the end of each day. Range defaults to the last 30 days, max 180.
  // The status/date filters are ignored here (they'd contradict "open on that day").
  async getStatsBacklog(query: InformationStatsQueryDto) {
    const to = query.to ? new Date(query.to) : new Date();
    let from = query.from ? new Date(query.from) : new Date(to.getTime() - 29 * 86_400_000);
    const maxMs = 179 * 86_400_000;
    if (to.getTime() - from.getTime() > maxMs) from = new Date(to.getTime() - maxMs);

    const decisionActions = this.auditActionList([
      AuditEventEnum.INFORMATION_REVIEWED,
      AuditEventEnum.INFORMATION_REJECTED,
    ]);

    const rows = await this.prisma.$queryRaw<Array<{ day: Date; open: number }>>(Prisma.sql`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', ${from}::timestamp),
          date_trunc('day', ${to}::timestamp),
          interval '1 day'
        ) AS day
      ),
      t AS (
        SELECT s.id, s."createdAt",
          (SELECT MIN(a."createdAt") FROM audit_log a
            WHERE a.entity = 'InformationSubmission' AND a."entityId" = s.id
              AND a.outcome = 'SUCCESS' AND a.action IN (${decisionActions})) AS decided_at
        FROM information_submission s
        WHERE ${this.statsSql(query, { dates: false, status: false })}
      )
      SELECT d.day, COUNT(t.id)::int AS open
      FROM days d
      LEFT JOIN t
        ON t."createdAt" < d.day + interval '1 day'
       AND (t.decided_at IS NULL OR t.decided_at >= d.day + interval '1 day')
      GROUP BY d.day
      ORDER BY d.day ASC
    `);

    return { from, to, data: rows };
  }

  async getStatsAging(query: InformationStatsQueryDto) {
    const base = this.statsWhere({ ...query, status: undefined, from: undefined, to: undefined });
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * 86_400_000);

    const bucket = (gte?: Date, lt?: Date) =>
      this.prisma.informationSubmission.count({
        where: {
          ...base,
          status: { in: this.OPEN_STATUSES },
          createdAt: { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) },
        },
      });

    const [under1d, d1to3, d3to7, d7to14, over14d] = await Promise.all([
      bucket(ago(1)),
      bucket(ago(3), ago(1)),
      bucket(ago(7), ago(3)),
      bucket(ago(14), ago(7)),
      bucket(undefined, ago(14)),
    ]);

    return {
      totalOpen: under1d + d1to3 + d3to7 + d7to14 + over14d,
      buckets: [
        { label: '<1d', count: under1d },
        { label: '1-3d', count: d1to3 },
        { label: '3-7d', count: d3to7 },
        { label: '7-14d', count: d7to14 },
        { label: '14d+', count: over14d },
      ],
    };
  }

  async getStatsUsefulness(query: InformationStatsQueryDto) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['status', 'resolution'],
      where: this.statsWhere(query),
      _count: { _all: true },
    });

    let useful = 0;
    let duplicate = 0;
    let alreadyKnown = 0;
    let rejectedOther = 0;
    let open = 0;

    for (const r of rows) {
      const n = r._count._all;
      if (r.status === InformationStatus.REVIEWED) useful += n;
      else if (r.status === InformationStatus.REJECTED) {
        if (r.resolution === 'DUPLICATE') duplicate += n;
        else if (r.resolution === 'ALREADY_KNOWN') alreadyKnown += n;
        else rejectedOther += n;
      } else open += n;
    }

    const decided = useful + duplicate + alreadyKnown + rejectedOther;
    const share = (n: number) => (decided ? this.round(n / decided, 3) : null);

    return {
      decided,
      open,
      useful: { count: useful, share: share(useful) },
      duplicate: { count: duplicate, share: share(duplicate) },
      alreadyKnown: { count: alreadyKnown, share: share(alreadyKnown) },
      rejectedOther: { count: rejectedOther, share: share(rejectedOther) },
    };
  }

  // Questions asked in the period: how many were answered and how fast (hours).
  async getStatsResponseTime(query: InformationStatsQueryDto) {
    const submissionWhere = this.statsWhere({ ...query, status: undefined, from: undefined, to: undefined });

    const questions = await this.prisma.informationQuestion.findMany({
      where: {
        submission: submissionWhere,
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      select: { createdAt: true, answeredAt: true },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
    });

    const hours = questions
      .filter((q) => q.answeredAt)
      .map((q) => (q.answeredAt!.getTime() - q.createdAt.getTime()) / 3_600_000)
      .sort((a, b) => a - b);

    const pick = (p: number) =>
      hours.length ? hours[Math.min(hours.length - 1, Math.floor(p * hours.length))] : null;

    return {
      unit: 'hours',
      asked: questions.length,
      answered: hours.length,
      open: questions.length - hours.length,
      answerRate: questions.length ? this.round(hours.length / questions.length, 3) : null,
      average: hours.length ? this.round(hours.reduce((a, b) => a + b, 0) / hours.length) : null,
      median: this.round(pick(0.5)),
      p90: this.round(pick(0.9)),
      sampleCapped: questions.length === 10_000,
    };
  }

  // Per reviewer: decisions made in the period and how long those tips waited, plus their
  // currently open assigned tips.
  async getStatsByAdmin(query: InformationStatsQueryDto) {
    const reviewed = AuditEventEnum.INFORMATION_REVIEWED as string;
    const rejected = AuditEventEnum.INFORMATION_REJECTED as string;

    const rows = await this.prisma.$queryRaw<
      Array<{ adminId: string; reviewed: number; rejected: number; avgHoursToDecision: number | null }>
    >(Prisma.sql`
      SELECT a."userId" AS "adminId",
             (COUNT(*) FILTER (WHERE a.action = ${reviewed}))::int AS reviewed,
             (COUNT(*) FILTER (WHERE a.action = ${rejected}))::int AS rejected,
             AVG(EXTRACT(EPOCH FROM (a."createdAt" - s."createdAt")) / 3600)::float AS "avgHoursToDecision"
      FROM audit_log a
      JOIN information_submission s ON s.id = a."entityId"
      WHERE a.entity = 'InformationSubmission'
        AND a.outcome = 'SUCCESS'
        AND a.action IN (${reviewed}, ${rejected})
        AND a."userId" IS NOT NULL
        ${query.from ? Prisma.sql`AND a."createdAt" >= ${new Date(query.from)}` : Prisma.empty}
        ${query.to ? Prisma.sql`AND a."createdAt" <= ${new Date(query.to)}` : Prisma.empty}
        ${query.missingPersonId ? Prisma.sql`AND s."missingPersonId" = ${query.missingPersonId}` : Prisma.empty}
      GROUP BY a."userId"
    `);

    const open = await this.prisma.informationSubmission.groupBy({
      by: ['assignedToId'],
      where: { deletedAt: null, assignedToId: { not: null }, status: { in: this.OPEN_STATUSES } },
      _count: { _all: true },
    });
    const openMap = new Map(open.map((o) => [o.assignedToId as string, o._count._all]));

    const adminIds = [...new Set([...rows.map((r) => r.adminId), ...openMap.keys()])];
    const names = await this.userNameMap(adminIds);

    return adminIds
      .map((adminId) => {
        const r = rows.find((x) => x.adminId === adminId);
        return {
          adminId,
          name: names.get(adminId) ?? null,
          reviewed: r?.reviewed ?? 0,
          rejected: r?.rejected ?? 0,
          decisions: (r?.reviewed ?? 0) + (r?.rejected ?? 0),
          avgHoursToDecision: this.round(r?.avgHoursToDecision),
          openAssigned: openMap.get(adminId) ?? 0,
        };
      })
      .sort((a, b) => b.decisions - a.decisions);
  }

  // One call for the dashboard. Reuses the endpoints above plus a few quick counts.
  async getStatsOverview(query: InformationStatsQueryDto) {
    const base = this.statsWhere({ ...query, status: undefined });

    const [totals, aging, usefulness, reviewTime, unassignedOpen, urgentOpen, openQuestions, pendingAppeals] =
      await Promise.all([
        this.getStats(),
        this.getStatsAging(query),
        this.getStatsUsefulness(query),
        this.getStatsReviewTime(query),
        this.prisma.informationSubmission.count({
          where: { ...base, assignedToId: null, status: { in: this.OPEN_STATUSES } },
        }),
        this.prisma.informationSubmission.count({
          where: { ...base, priority: 'URGENT', status: { in: this.OPEN_STATUSES } },
        }),
        this.prisma.informationQuestion.count({
          where: { answeredAt: null, submission: { deletedAt: null } },
        }),
        this.prisma.informationAppeal.count({ where: { status: 'PENDING' } }),
      ]);

    return {
      totals,
      aging,
      usefulness,
      reviewTime,
      attention: { unassignedOpen, urgentOpen, openQuestions, pendingAppeals },
    };
  }
}
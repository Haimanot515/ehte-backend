import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { InformationStatus, MissingPersonStatus } from '@prisma/client';

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
  // ─────────────────────────────────────────────

  async getMediaDownloadUrlForAdmin(id: string, key: string): Promise<{ url: string }> {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: { id },
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
    userId: string,
    missingPersonId: string,
    data: CreateInformationSubmissionDto,
    idempotencyKey?: string,
  ) {
    if (idempotencyKey) {
      const existing = await this.prisma.informationSubmission.findFirst({
        where: { userId, idempotencyKey },
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
      throw new BadRequestException('information_submission_not_allowed');
    }

    if (missingPerson.userId === userId) {
      throw new ForbiddenException('cannot_submit_information_on_own_report');
    }

    await this.enforceCreateRateLimit(userId);
    await this.enforceMaxPending(userId);

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
        userId,
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
      userId,
      actorType: resolveActorType(['USER']),
      action: AuditEventEnum.INFORMATION_SUBMITTED,
      entity: 'InformationSubmission',
      entityId: submission.id,
      diff: {
        missingPersonId,
        status: InformationStatus.PENDING,
        result: 'success',
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
  // ─────────────────────────────────────────────

  async update(id: string, userId: string, data: UpdateInformationSubmissionDto) {
    const existing = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('information_submission_not_found');
    }

    if (existing.userId !== userId) {
      throw new ForbiddenException('not_authorized');
    }

    if (existing.status !== InformationStatus.PENDING) {
      throw new ForbiddenException('submission_not_editable_in_current_status');
    }

    const hasAnyField = Object.values(data).some((value) => value !== undefined);

    if (!hasAnyField) {
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

    return updated;
  }

  // ─────────────────────────────────────────────
  // DELETE — OWNER
  // Only while PENDING. Deletes the DB row, then removes every
  // attached media object from MinIO — once the row referencing
  // them is gone, an orphaned object in the bucket serves no
  // purpose. Same ordering as PostService.deleteMyPost.
  // ─────────────────────────────────────────────

  async remove(id: string, user: CurrentUserDto) {
    const existing = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('information_submission_not_found');
    }

    if (existing.userId !== user.id) {
      throw new ForbiddenException('not_authorized');
    }

    if (existing.status !== InformationStatus.PENDING) {
      throw new ForbiddenException('only_pending_submissions_can_be_deleted');
    }

    await this.prisma.informationSubmission.delete({ where: { id } });

    await this.deleteMediaFiles(this.collectMediaFields(existing));

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.INFORMATION_SUBMISSION_DELETED,
      entity: 'InformationSubmission',
      entityId: id,
      diff: {
        previousStatus: existing.status,
        result: 'success',
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
  // ─────────────────────────────────────────────

  async updateStatus(admin: CurrentUserDto, id: string, status: InformationStatus) {
    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    if (submission.status === status) {
      return submission;
    }

    const allowedNext = this.ALLOWED_STATUS_TRANSITIONS[submission.status] ?? [];

    if (!allowedNext.includes(status)) {
      throw new BadRequestException(`invalid_status_transition: ${submission.status} -> ${status}`);
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { status },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.INFORMATION_UNDER_REVIEW,
      entity: 'InformationSubmission',
      entityId: updated.id,
      diff: {
        previousStatus: submission.status,
        newStatus: updated.status,
        result: 'success',
      },
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVIEW (terminal decision)
  // Only valid from UNDER_REVIEW. reviewNote required on REJECTED.
  // ─────────────────────────────────────────────

  async review(
    id: string,
    status: InformationStatus,
    reviewNote: string | undefined,
    reviewer: CurrentUserDto,
  ) {
    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    if (status !== InformationStatus.REVIEWED && status !== InformationStatus.REJECTED) {
      throw new BadRequestException('invalid_review_status');
    }

    if (submission.status !== InformationStatus.UNDER_REVIEW) {
      throw new BadRequestException(`invalid_status_transition: ${submission.status} -> ${status}`);
    }

    if (status === InformationStatus.REJECTED && !reviewNote?.trim()) {
      throw new BadRequestException('review_note_required_for_rejection');
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: {
        status,
        ...(reviewNote !== undefined ? { reviewNote } : {}),
      },
    });

    const auditEvent =
      status === InformationStatus.REVIEWED
        ? AuditEventEnum.INFORMATION_REVIEWED
        : AuditEventEnum.INFORMATION_REJECTED;

    this.emitAudit({
      userId: reviewer.id,
      actorType: resolveActorType(reviewer.roles ?? []),
      action: auditEvent,
      entity: 'InformationSubmission',
      entityId: updated.id,
      diff: {
        submissionOwnerId: submission.userId,
        previousStatus: submission.status,
        newStatus: status,
        result: 'success',
      },
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
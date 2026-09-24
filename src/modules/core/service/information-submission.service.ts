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

// Media array fields shared by the DTOs and the InformationSubmission model.
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

// Assumes AuditEventEnum has INFORMATION_SUBMISSION_UPDATED and
// INFORMATION_SUBMISSION_MEDIA_DOWNLOADED members; add them if missing.

@Injectable()
export class InformationSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  // Admin workflow: PENDING -> UNDER_REVIEW -> REVIEWED|REJECTED (terminal).
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

  // Media only reachable once REVIEWED; unreviewed submissions 404 here.
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

    return submission;
  }

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

  // Lets the frontend check "did I already submit on this case" before showing the form.
  async findMineForMissingPerson(userId: string, missingPersonId: string) {
    return this.prisma.informationSubmission.findMany({
      where: { userId, missingPersonId },
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

  // Owner update, only while PENDING; media diffed and validated before the write.
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

  // Owner delete, only while PENDING; purges attached media after the row is gone.
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

  async findAllForAdmin(query: ListInformationSubmissionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { ...(query.status !== undefined ? { status: query.status } : {}) };

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
      this.prisma.informationSubmission.count(),
      this.prisma.informationSubmission.groupBy({
        by: ['status'],
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

  // Only moves PENDING -> UNDER_REVIEW; terminal decisions go through review().
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

  // Terminal decision, only valid from UNDER_REVIEW; reviewNote required on REJECTED.
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
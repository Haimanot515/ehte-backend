import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { AuditOutcome, AuditSeverity, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import {
  MEDIA_FIELD_NAMES,
  MediaFieldName,
  MediaBearing,
} from './information-submission.constants';

@Injectable()
export class InformationSubmissionCommonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  getRoles(user: CurrentUserDto): string[] {
    return (user as unknown as { roles?: string[] }).roles ?? [];
  }

  // Labels by the missing-person case the tip is about, falling back to a snippet or id.
  buildSubmissionLabel(
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

  collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  // Confirms every new filepath exists in the media bucket and is within size/type limits.
  async validateMediaFilesExist(
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
  assertAttachmentCounts(media: MediaBearing): void {
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
  assertTotalBytes(totalBytes: number): void {
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
  async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  isSuperAdmin(user: CurrentUserDto): boolean {
    return this.getRoles(user).includes(RolesEnum.SUPER_ADMIN);
  }

  pageArgs(query: { page?: number; limit?: number }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return { page, limit, skip: (page - 1) * limit };
  }

  pageMeta(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  // Prisma needs DbNull/JsonNull rather than null for nullable Json columns.
  toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
    return value === undefined || value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
  }

  // Not deleted, or 404.
  async findLiveOrThrow(id: string) {
    const submission = await this.prisma.informationSubmission.findFirst({
      where: { id, deletedAt: null },
    });
    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }
    return submission;
  }

  // Owner check shared by the informant-facing actions. A non-owner gets a DENIED audit row.
  async findOwnedOrThrow(user: CurrentUserDto, id: string, action: AuditEventEnum) {
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
  assertNotLockedByOther(submission: { assignedToId: string | null }, admin: CurrentUserDto) {
    if (
      submission.assignedToId &&
      submission.assignedToId !== admin.id &&
      !this.isSuperAdmin(admin)
    ) {
      throw new ForbiddenException('assigned_to_another_reviewer');
    }
  }

  assertNoLegalHold(submission: { legalHold: boolean }) {
    if (submission.legalHold) {
      throw new ForbiddenException('legal_hold_active');
    }
  }

  // One audit emit for the many admin/informant actions below.
  auditAction(params: {
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
  async markUnreadForAdmins(submissionId: string): Promise<void> {
    await this.prisma.informationAdminRead.deleteMany({ where: { submissionId } });
  }

  async recordRevisions(
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
  async decisionAt(id: string, actions: AuditEventEnum[], fallback?: Date): Promise<Date | null> {
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

  async userNameMap(ids: Array<string | null | undefined>): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  async caseNameMap(
    ids: string[],
  ): Promise<Map<string, { name: string | null; personType: string }>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const cases = await this.prisma.missingPerson.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true, personType: true },
    });
    return new Map(cases.map((c) => [c.id, { name: c.name, personType: c.personType }]));
  }

  // Runs one action per id and reports each outcome, so a bad id never sinks the whole batch.
  async runBulk(
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
  async detachMedia(
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

    await this.deleteMediaFiles([
      key,
      ...(attachment?.redactedKey ? [attachment.redactedKey] : []),
    ]);

    return { field, size };
  }
}

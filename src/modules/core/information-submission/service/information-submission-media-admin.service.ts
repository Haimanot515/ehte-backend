import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AuditOutcome,
  AuditSeverity,
  InformationRedactionMode as PrismaInformationRedactionMode,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { RedactInformationMediaDto } from '../dto/information-submission.dto';
import {
  MEDIA_FIELD_NAMES,
  MediaFieldName,
  MediaBearing,
  MEDIA_REDACTION_REQUESTED_EVENT,
} from './information-submission.constants';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionMediaAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

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

    const actorType = resolveActorType(this.informationSubmissionCommonService.getRoles(admin));
    const label = this.informationSubmissionCommonService.buildSubmissionLabel(submission);

    const owned = this.informationSubmissionCommonService
      .collectMediaFields(submission)
      .includes(key);
    if (!owned) {
      this.informationSubmissionCommonService.emitAudit({
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

    this.informationSubmissionCommonService.emitAudit({
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

  private fieldOfKey(entity: MediaBearing, key: string): MediaFieldName | undefined {
    return MEDIA_FIELD_NAMES.find((f) => entity[f].includes(key));
  }

  private async syncAttachmentRows(submission: MediaBearing & { id: string }): Promise<void> {
    const keys = this.informationSubmissionCommonService.collectMediaFields(submission);

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

    const stats = await Promise.allSettled(missing.map((key) => this.minioService.statObject(key)));

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
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);
    this.informationSubmissionCommonService.assertNoLegalHold(submission);
    this.informationSubmissionCommonService.assertNotLockedByOther(submission, admin);

    const { field, size } = await this.informationSubmissionCommonService.detachMedia(
      submission,
      key,
    );

    await this.informationSubmissionCommonService.recordRevisions(id, admin.id, [
      {
        field,
        oldValue: submission[field],
        newValue: submission[field].filter((k) => k !== key),
      },
    ]);

    this.informationSubmissionCommonService.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_REMOVED,
      submission,
      severity: AuditSeverity.WARNING,
      metadata: { key, field, bytesFreed: size, missingPersonId: submission.missingPersonId },
    });

    return { message: 'media_removed', key };
  }

  async redactMedia(
    admin: CurrentUserDto,
    id: string,
    key: string,
    data: RedactInformationMediaDto,
  ) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);

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

    this.informationSubmissionCommonService.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_REDACTION_REQUESTED,
      submission,
      severity: AuditSeverity.WARNING,
      reason,
      metadata: { key, field, mode, missingPersonId: submission.missingPersonId },
    });

    this.eventEmitter.emit(MEDIA_REDACTION_REQUESTED_EVENT, {
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
    if (!this.informationSubmissionCommonService.collectMediaFields(submission).includes(key)) {
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
}

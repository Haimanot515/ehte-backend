import {
  BadRequestException,
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
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import {
  CreateInformationSubmissionDto,
  UpdateInformationSubmissionDto,
} from '../dto/information-submission.dto';
import {
  MEDIA_FIELD_NAMES,
  MediaBearing,
  MediaBearingDto,
} from './information-submission.constants';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

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
    const actorType = resolveActorType(this.informationSubmissionCommonService.getRoles(user));

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
      this.informationSubmissionCommonService.emitAudit({
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
      this.informationSubmissionCommonService.emitAudit({
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
    this.informationSubmissionCommonService.assertAttachmentCounts(merged);

    const validated = await this.informationSubmissionCommonService.validateMediaFilesExist(
      this.informationSubmissionCommonService.collectMediaFields(merged),
    );
    const totalBytes = validated.reduce((sum, v) => sum + v.size, 0);
    this.informationSubmissionCommonService.assertTotalBytes(totalBytes);

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

    this.informationSubmissionCommonService.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.INFORMATION_SUBMITTED,
      entity: 'InformationSubmission',
      entityId: submission.id,
      entityLabel: this.informationSubmissionCommonService.buildSubmissionLabel(
        submission,
        missingPerson.name,
      ),
      diff: {
        status: InformationStatus.PENDING,
        result: 'success',
      },
      metadata: {
        missingPersonId,
        attachmentCount: this.informationSubmissionCommonService.collectMediaFields(merged).length,
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

  async update(id: string, user: CurrentUserDto, data: UpdateInformationSubmissionDto) {
    const actorType = resolveActorType(this.informationSubmissionCommonService.getRoles(user));

    const existing = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('information_submission_not_found');
    }

    const label = this.informationSubmissionCommonService.buildSubmissionLabel(existing);

    if (existing.userId !== user.id) {
      this.informationSubmissionCommonService.emitAudit({
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
      this.informationSubmissionCommonService.emitAudit({
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
      this.informationSubmissionCommonService.emitAudit({
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
      this.informationSubmissionCommonService.assertAttachmentCounts(merged);

      const validatedAdded =
        await this.informationSubmissionCommonService.validateMediaFilesExist(added);
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
      this.informationSubmissionCommonService.assertTotalBytes(newTotalBytes);
    } catch (err) {
      this.informationSubmissionCommonService.emitAudit({
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
    await this.informationSubmissionCommonService.deleteMediaFiles(removed);

    this.informationSubmissionCommonService.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
      entity: 'InformationSubmission',
      entityId: updated.id,
      entityLabel: this.informationSubmissionCommonService.buildSubmissionLabel(updated),
      diff: { result: 'success' },
      metadata: {
        mediaAdded: added.length,
        mediaRemoved: removed.length,
        mediaTotalBytes: newTotalBytes,
      },
    });

    return updated;
  }

  async remove(id: string, user: CurrentUserDto) {
    const actorType = resolveActorType(this.informationSubmissionCommonService.getRoles(user));

    const existing = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('information_submission_not_found');
    }

    const label = this.informationSubmissionCommonService.buildSubmissionLabel(existing);

    if (existing.userId !== user.id) {
      this.informationSubmissionCommonService.emitAudit({
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
      this.informationSubmissionCommonService.emitAudit({
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

    const mediaFields = this.informationSubmissionCommonService.collectMediaFields(existing);
    await this.informationSubmissionCommonService.deleteMediaFiles(mediaFields);

    this.informationSubmissionCommonService.emitAudit({
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
}

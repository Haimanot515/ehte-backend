import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditOutcome, AuditSeverity, InformationStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  ALLOWED_STATUS_TRANSITIONS,
  OPEN_STATUSES,
  TERMINAL_STATUSES,
} from './information-submission.constants';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: CacheService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

  async updateStatus(admin: CurrentUserDto, id: string, status: InformationStatus) {
    const actorType = resolveActorType(this.informationSubmissionCommonService.getRoles(admin));

    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    if (submission.status === status) {
      return submission;
    }

    const label = this.informationSubmissionCommonService.buildSubmissionLabel(submission);
    const allowedNext = ALLOWED_STATUS_TRANSITIONS[submission.status] ?? [];

    if (!allowedNext.includes(status)) {
      this.informationSubmissionCommonService.emitAudit({
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

    this.informationSubmissionCommonService.emitAudit({
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

  async review(
    id: string,
    status: InformationStatus,
    reviewNote: string | undefined,
    reviewer: CurrentUserDto,
  ) {
    const actorType = resolveActorType(this.informationSubmissionCommonService.getRoles(reviewer));

    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    const label = this.informationSubmissionCommonService.buildSubmissionLabel(submission);

    if (status !== InformationStatus.REVIEWED && status !== InformationStatus.REJECTED) {
      this.informationSubmissionCommonService.emitAudit({
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
      this.informationSubmissionCommonService.emitAudit({
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
      this.informationSubmissionCommonService.emitAudit({
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

    if (status === InformationStatus.REVIEWED && !submission.userId) {
      this.informationSubmissionCommonService.emitAudit({
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

    this.informationSubmissionCommonService.emitAudit({
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

  private async reviewOne(
    admin: CurrentUserDto,
    id: string,
    status: InformationStatus,
    reviewNote: string | undefined,
  ) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);
    this.informationSubmissionCommonService.assertNotLockedByOther(submission, admin);
    return this.review(id, status, reviewNote, admin);
  }

  async bulkReview(
    admin: CurrentUserDto,
    ids: string[],
    status: InformationStatus,
    reviewNote: string,
  ) {
    return this.informationSubmissionCommonService.runBulk(ids, (id) =>
      this.reviewOne(admin, id, status, reviewNote),
    );
  }

  async bulkReject(admin: CurrentUserDto, ids: string[], reviewNote: string) {
    return this.informationSubmissionCommonService.runBulk(ids, (id) =>
      this.reviewOne(admin, id, InformationStatus.REJECTED, reviewNote),
    );
  }

  private async closeWithResolution(
    admin: CurrentUserDto,
    id: string,
    resolution: 'DUPLICATE' | 'ALREADY_KNOWN',
    options: { duplicateOfId?: string; reason?: string },
  ) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);
    this.informationSubmissionCommonService.assertNotLockedByOther(submission, admin);

    if (!OPEN_STATUSES.includes(submission.status)) {
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

    await this.informationSubmissionCommonService.recordRevisions(
      id,
      admin.id,
      [
        { field: 'status', oldValue: submission.status, newValue: InformationStatus.REJECTED },
        { field: 'resolution', oldValue: null, newValue: resolution },
        ...(duplicateOfId
          ? [{ field: 'duplicateOfId', oldValue: null, newValue: duplicateOfId }]
          : []),
      ],
      note,
    );

    this.informationSubmissionCommonService.emitAudit({
      userId: admin.id,
      targetUserId: submission.userId ?? undefined,
      actorType: resolveActorType(this.informationSubmissionCommonService.getRoles(admin)),
      action: AuditEventEnum.INFORMATION_REJECTED,
      entity: 'InformationSubmission',
      entityId: id,
      entityLabel: this.informationSubmissionCommonService.buildSubmissionLabel(submission),
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

    const open = !submission.deletedAt && OPEN_STATUSES.includes(submission.status);

    const allowed: Array<{ status: InformationStatus; via: string; requires?: string }> = [];
    if (open) {
      for (const next of ALLOWED_STATUS_TRANSITIONS[submission.status] ?? []) {
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
      isFinal: TERMINAL_STATUSES.includes(submission.status),
      isDeleted: !!submission.deletedAt,
      legalHold: submission.legalHold,
      assignedToId: submission.assignedToId,
      allowed,
    };
  }
}

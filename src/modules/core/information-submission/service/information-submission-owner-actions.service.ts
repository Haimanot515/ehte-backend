import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { AuditOutcome, AuditSeverity, InformationStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import {
  AddInformationEvidenceDto,
  AppealInformationRejectionDto,
  RespondToInformationQuestionDto,
} from '../dto/information-submission.dto';
import {
  MEDIA_FIELD_NAMES,
  MediaBearing,
  MediaBearingDto,
  OPEN_STATUSES,
} from './information-submission.constants';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionOwnerActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

  private collectMediaFieldsFromDto(dto: MediaBearingDto): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => dto[field] ?? []);
  }

  private isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }

  async respond(user: CurrentUserDto, id: string, data: RespondToInformationQuestionDto) {
    const submission = await this.informationSubmissionCommonService.findOwnedOrThrow(
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

    this.informationSubmissionCommonService.auditAction({
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

  async addEvidence(user: CurrentUserDto, id: string, data: AddInformationEvidenceDto) {
    const existing = await this.informationSubmissionCommonService.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_EVIDENCE_ADDED,
    );

    if (!OPEN_STATUSES.includes(existing.status)) {
      this.informationSubmissionCommonService.auditAction({
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

    this.informationSubmissionCommonService.assertAttachmentCounts(merged);
    const validated = await this.informationSubmissionCommonService.validateMediaFilesExist(added);
    const addedBytes = validated.reduce((sum, v) => sum + v.size, 0);
    const newTotalBytes = existing.mediaTotalBytes + addedBytes;
    this.informationSubmissionCommonService.assertTotalBytes(newTotalBytes);

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

    await this.informationSubmissionCommonService.recordRevisions(id, user.id, changes);

    this.informationSubmissionCommonService.auditAction({
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
    const existing = await this.informationSubmissionCommonService.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_REMOVED,
    );

    if (existing.status !== InformationStatus.PENDING) {
      this.informationSubmissionCommonService.auditAction({
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

    this.informationSubmissionCommonService.assertNoLegalHold(existing);

    const { field, size } = await this.informationSubmissionCommonService.detachMedia(existing, key);

    await this.informationSubmissionCommonService.recordRevisions(id, user.id, [
      { field, oldValue: existing[field], newValue: existing[field].filter((k) => k !== key) },
    ]);

    this.informationSubmissionCommonService.auditAction({
      actor: user,
      action: AuditEventEnum.INFORMATION_SUBMISSION_MEDIA_REMOVED,
      submission: existing,
      metadata: { key, field, bytesFreed: size, missingPersonId: existing.missingPersonId },
    });

    return { message: 'media_removed', key };
  }

  async appealRejection(user: CurrentUserDto, id: string, data: AppealInformationRejectionDto) {
    const submission = await this.informationSubmissionCommonService.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_APPEALED,
    );

    if (submission.status !== InformationStatus.REJECTED) {
      this.informationSubmissionCommonService.auditAction({
        actor: user,
        action: AuditEventEnum.INFORMATION_SUBMISSION_APPEALED,
        submission,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        diff: {
          result: 'failure',
          reason: 'only_rejected_submissions_can_be_appealed',
          currentStatus: submission.status,
        },
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
      (await this.informationSubmissionCommonService.decisionAt(id, [AuditEventEnum.INFORMATION_REJECTED], submission.updatedAt)) ??
      submission.updatedAt;

    if (Date.now() - rejectedAt.getTime() > windowDays * 24 * 60 * 60 * 1000) {
      this.informationSubmissionCommonService.auditAction({
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

    this.informationSubmissionCommonService.auditAction({
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
}

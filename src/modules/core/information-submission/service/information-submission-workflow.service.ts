import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import {
  AuditSeverity,
  InformationPriority as PrismaInformationPriority,
  InformationCredibility as PrismaInformationCredibility,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { EscalateInformationDto } from '../dto/information-submission.dto';
import { OPEN_STATUSES, PRIORITY_RANK } from './information-submission.constants';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

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
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);

    if (!OPEN_STATUSES.includes(submission.status)) {
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

    await this.informationSubmissionCommonService.recordRevisions(id, admin.id, [
      { field: 'assignedToId', oldValue: null, newValue: admin.id },
    ]);

    this.informationSubmissionCommonService.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_CLAIMED,
      submission,
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return this.prisma.informationSubmission.findUniqueOrThrow({ where: { id } });
  }

  async unclaim(admin: CurrentUserDto, id: string) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);

    if (!submission.assignedToId) {
      return submission;
    }
    if (submission.assignedToId !== admin.id && !this.informationSubmissionCommonService.isSuperAdmin(admin)) {
      throw new ForbiddenException('not_assigned_to_you');
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { assignedToId: null, assignedAt: null, assignedById: null },
    });

    await this.informationSubmissionCommonService.recordRevisions(id, admin.id, [
      { field: 'assignedToId', oldValue: submission.assignedToId, newValue: null },
    ]);

    this.informationSubmissionCommonService.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_UNCLAIMED,
      submission,
      metadata: {
        missingPersonId: submission.missingPersonId,
        previousAssignee: submission.assignedToId,
      },
    });

    return updated;
  }

  private async assignInternal(admin: CurrentUserDto, id: string, assigneeId: string) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);

    if (!OPEN_STATUSES.includes(submission.status)) {
      throw new BadRequestException('submission_already_decided');
    }
    if (submission.assignedToId === assigneeId) {
      return submission;
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { assignedToId: assigneeId, assignedAt: new Date(), assignedById: admin.id },
    });

    await this.informationSubmissionCommonService.recordRevisions(id, admin.id, [
      { field: 'assignedToId', oldValue: submission.assignedToId, newValue: assigneeId },
    ]);

    this.informationSubmissionCommonService.auditAction({
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
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);

    if (!submission.assignedToId) {
      return submission;
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { assignedToId: null, assignedAt: null, assignedById: null },
    });

    await this.informationSubmissionCommonService.recordRevisions(id, admin.id, [
      { field: 'assignedToId', oldValue: submission.assignedToId, newValue: null },
    ]);

    this.informationSubmissionCommonService.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_UNASSIGNED,
      submission,
      metadata: {
        missingPersonId: submission.missingPersonId,
        previousAssignee: submission.assignedToId,
      },
    });

    return updated;
  }

  async bulkAssign(admin: CurrentUserDto, ids: string[], adminId: string) {
    await this.assertAssignableAdmin(adminId);
    return this.informationSubmissionCommonService.runBulk(ids, (id) => this.assignInternal(admin, id, adminId));
  }

  async requestInformation(admin: CurrentUserDto, id: string, question: string) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);
    this.informationSubmissionCommonService.assertNotLockedByOther(submission, admin);

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

    this.informationSubmissionCommonService.auditAction({
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
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);
    this.informationSubmissionCommonService.assertNotLockedByOther(submission, admin);

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

    this.informationSubmissionCommonService.auditAction({
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

  async setPriority(admin: CurrentUserDto, id: string, priority: string) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);
    const next = priority as PrismaInformationPriority;

    if (submission.priority === next) {
      return submission;
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { priority: next },
    });

    await this.informationSubmissionCommonService.recordRevisions(id, admin.id, [
      { field: 'priority', oldValue: submission.priority, newValue: next },
    ]);

    this.informationSubmissionCommonService.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_PRIORITY_CHANGED,
      submission,
      diff: { previousPriority: submission.priority, newPriority: next, result: 'success' },
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return updated;
  }

  async setCredibility(admin: CurrentUserDto, id: string, credibility: string, reason: string) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);
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

    await this.informationSubmissionCommonService.recordRevisions(
      id,
      admin.id,
      [{ field: 'credibility', oldValue: submission.credibility, newValue: next }],
      text,
    );

    this.informationSubmissionCommonService.auditAction({
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

  async escalate(admin: CurrentUserDto, id: string, data: EscalateInformationDto) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);

    const note = data.note.trim();
    if (!note) {
      throw new BadRequestException('note_required');
    }

    const requested = data.priority as string as PrismaInformationPriority;
    const raise = PRIORITY_RANK[requested] > PRIORITY_RANK[submission.priority];
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
      await this.informationSubmissionCommonService.recordRevisions(
        id,
        admin.id,
        [{ field: 'priority', oldValue: submission.priority, newValue: newPriority }],
        note,
      );
    }

    this.informationSubmissionCommonService.auditAction({
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
}

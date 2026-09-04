import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { InformationStatus, MissingPersonStatus } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import {
  CreateInformationSubmissionDto,
  ListInformationSubmissionsQueryDto,
  UpdateInformationSubmissionDto,
} from '../dto/information-submission.dto';

@Injectable()
export class InformationSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
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
  // CREATE INFORMATION
  // Only allowed against APPROVED (publicly visible) cases, and
  // not by the person who filed the missing-person report itself.
  // ─────────────────────────────────────────────

  async create(userId: string, missingPersonId: string, data: CreateInformationSubmissionDto) {
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

    const submission = await this.prisma.informationSubmission.create({
      data: {
        userId,
        missingPersonId,

        information: data.information,
        location: data.location,

        photo: data.photo ?? [],
        video: data.video ?? [],
        audio: data.audio ?? [],
        pdf: data.pdf ?? [],
        document: data.document ?? [],
        other: data.other ?? [],

        status: InformationStatus.PENDING,
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

    return this.prisma.informationSubmission.update({
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
      },
    });
  }

  // ─────────────────────────────────────────────
  // DELETE — OWNER
  // Only while PENDING.
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

  async review(id: string, status: InformationStatus, reviewNote: string | undefined, reviewer: CurrentUserDto) {
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
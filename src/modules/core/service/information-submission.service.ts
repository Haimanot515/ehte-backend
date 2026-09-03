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

import { CreateInformationSubmissionDto } from '../dto/information-submission.dto';

@Injectable()
export class InformationSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // AUDIT EMIT (typed helper): routes every audit emit through AuditEventPayload so a
  // missing field (actorType, entity, etc.) is caught at compile time, not silently dropped

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // ─────────────────────────────────────────────
  // CREATE INFORMATION
  // Only allowed against APPROVED (publicly visible) cases.
  // Using an allowlist here (rather than excluding REJECTED/
  // FOUND) means any future MissingPersonStatus value is
  // submission-blocked by default until explicitly allowed.
  // ─────────────────────────────────────────────

  async create(userId: string, missingPersonId: string, data: CreateInformationSubmissionDto) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: {
        id: missingPersonId,
      },
    });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new BadRequestException('information_submission_not_allowed');
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

    // ─────────────────────────────────────────────
    // AUDIT — INFORMATION SUBMITTED
    // ─────────────────────────────────────────────

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
  // GET MY SUBMISSIONS
  // ─────────────────────────────────────────────

  async findMine(userId: string) {
    return this.prisma.informationSubmission.findMany({
      where: {
        userId,
      },

      include: {
        missingPerson: {
          select: {
            id: true,
            personType: true,
            name: true,
            status: true,
          },
        },
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // GET SUBMISSIONS FOR MISSING PERSON
  // ─────────────────────────────────────────────

  async findForMissingPerson(missingPersonId: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: {
        id: missingPersonId,
      },
    });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    return this.prisma.informationSubmission.findMany({
      where: {
        missingPersonId,

        status: {
          in: [InformationStatus.REVIEWED],
        },
      },

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

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // GET ONE — OWNER
  // ─────────────────────────────────────────────

  async findOne(id: string, userId: string) {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: {
        id,
      },

      include: {
        missingPerson: {
          select: {
            id: true,
            personType: true,
            name: true,
            status: true,
          },
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
  // ADMIN — GET ALL
  // ─────────────────────────────────────────────

  async findAllForAdmin(status?: InformationStatus) {
    return this.prisma.informationSubmission.findMany({
      where: {
        ...(status
          ? {
              status,
            }
          : {}),
      },

      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },

        missingPerson: {
          select: {
            id: true,
            personType: true,
            name: true,
            description: true,
            dateLastSeen: true,
            lastKnownArea: true,
            status: true,
          },
        },
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  // ─────────────────────────────────────────────

  async updateStatus(id: string, status: InformationStatus) {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: {
        id,
      },
    });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    return this.prisma.informationSubmission.update({
      where: {
        id,
      },

      data: {
        status,
      },
    });
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVIEW
  // ─────────────────────────────────────────────

  async review(id: string, status: InformationStatus, reviewer: CurrentUserDto) {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: {
        id,
      },
    });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    // Only these two statuses are valid
    // review outcomes.
    if (status !== InformationStatus.REVIEWED && status !== InformationStatus.REJECTED) {
      throw new BadRequestException('invalid_review_status');
    }

    const updated = await this.prisma.informationSubmission.update({
      where: {
        id,
      },

      data: {
        status,
      },
    });

    // ─────────────────────────────────────────────
    // SELECT AUDIT EVENT
    // ─────────────────────────────────────────────

    const auditEvent =
      status === InformationStatus.REVIEWED
        ? AuditEventEnum.INFORMATION_REVIEWED
        : AuditEventEnum.INFORMATION_REJECTED;

    // ─────────────────────────────────────────────
    // AUDIT — REVIEW / REJECT
    // ─────────────────────────────────────────────

    this.emitAudit({
      userId: reviewer.id,

      actorType: resolveActorType(
        (
          reviewer as unknown as {
            roles?: string[];
          }
        ).roles ?? [],
      ),

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

    return updated;
  }
}

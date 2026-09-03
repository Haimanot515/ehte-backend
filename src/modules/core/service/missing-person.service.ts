import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { MissingPersonStatus } from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import {
  CreateMissingPersonDto,
  ListMissingPersonsAdminQueryDto,
  ListMissingPersonsQueryDto,
  UpdateMissingPersonDto,
} from '../dto/missing-person.dto';

@Injectable()
export class MissingPersonService {
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
  // CREATE
  // ─────────────────────────────────────────────

  async create(user: CurrentUserDto, data: CreateMissingPersonDto) {
    const missingPerson = await this.prisma.missingPerson.create({
      data: {
        userId: user.id,

        personType: data.personType,

        name: data.name,
        description: data.description,

        dateLastSeen: new Date(data.dateLastSeen),

        lastKnownArea: data.lastKnownArea,

        photo: data.photo ?? [],
        video: data.video ?? [],
        audio: data.audio ?? [],
        pdf: data.pdf ?? [],
        document: data.document ?? [],
        other: data.other ?? [],

        status: MissingPersonStatus.PENDING,
      },
    });

    // ─────────────────────────────────────────
    // AUDIT
    // ─────────────────────────────────────────

    this.emitAudit({
      userId: user.id,

      actorType: resolveActorType(user.roles ?? []),

      action: AuditEventEnum.MISSING_PERSON_CREATED,

      entity: 'MissingPerson',

      entityId: missingPerson.id,

      diff: {
        personType: missingPerson.personType,

        status: missingPerson.status,

        result: 'success',
      },
    });

    // ─────────────────────────────────────────
    // NOTIFICATION
    // ─────────────────────────────────────────

    this.eventEmitter.emit(NotificationEventEnum.NEW_MISSING_PERSON_REQUEST, {
      userId: user.id,

      missingPersonId: missingPerson.id,
    });

    return missingPerson;
  }

  // ─────────────────────────────────────────────
  // FIND ONE (public — approved only)
  // ─────────────────────────────────────────────

  async findOne(id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: {
        id,
      },
    });

    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }

    return missingPerson;
  }

  // ─────────────────────────────────────────────
  // FIND ALL PUBLIC (paginated)
  // ─────────────────────────────────────────────

  async findAll(query: ListMissingPersonsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      status: MissingPersonStatus.APPROVED,

      ...(query.type !== undefined ? { personType: query.type } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,

        orderBy: {
          createdAt: 'desc',
        },

        skip: (page - 1) * limit,
        take: limit,
      }),

      this.prisma.missingPerson.count({
        where,
      }),
    ]);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─────────────────────────────────────────────
  // FIND MINE
  // ─────────────────────────────────────────────

  async findMine(user: CurrentUserDto) {
    return this.prisma.missingPerson.findMany({
      where: {
        userId: user.id,
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // UPDATE
  // Resets status back to PENDING if the submission
  // had already been APPROVED, so edited content goes
  // through admin review again before showing publicly.
  // ─────────────────────────────────────────────

  async update(user: CurrentUserDto, id: string, data: UpdateMissingPersonDto) {
    const existing = await this.prisma.missingPerson.findUnique({
      where: {
        id,
      },
    });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    // ─────────────────────────────────────────
    // OWNERSHIP CHECK
    // ─────────────────────────────────────────

    if (existing.userId !== user.id) {
      throw new ForbiddenException('not_authorized_to_update');
    }

    const shouldResetToPending = existing.status === MissingPersonStatus.APPROVED;

    const updated = await this.prisma.missingPerson.update({
      where: {
        id,
      },

      data: {
        ...(data.personType !== undefined
          ? {
              personType: data.personType,
            }
          : {}),

        ...(data.name !== undefined
          ? {
              name: data.name,
            }
          : {}),

        ...(data.description !== undefined
          ? {
              description: data.description,
            }
          : {}),

        ...(data.dateLastSeen !== undefined
          ? {
              dateLastSeen: new Date(data.dateLastSeen),
            }
          : {}),

        ...(data.lastKnownArea !== undefined
          ? {
              lastKnownArea: data.lastKnownArea,
            }
          : {}),

        ...(data.photo !== undefined
          ? {
              photo: data.photo,
            }
          : {}),

        ...(data.video !== undefined
          ? {
              video: data.video,
            }
          : {}),

        ...(data.audio !== undefined
          ? {
              audio: data.audio,
            }
          : {}),

        ...(data.pdf !== undefined
          ? {
              pdf: data.pdf,
            }
          : {}),

        ...(data.document !== undefined
          ? {
              document: data.document,
            }
          : {}),

        ...(data.other !== undefined
          ? {
              other: data.other,
            }
          : {}),

        ...(shouldResetToPending
          ? {
              status: MissingPersonStatus.PENDING,
            }
          : {}),
      },
    });

    // ─────────────────────────────────────────
    // AUDIT
    // ─────────────────────────────────────────

    this.emitAudit({
      userId: user.id,

      actorType: resolveActorType(user.roles ?? []),

      action: AuditEventEnum.MISSING_PERSON_UPDATED,

      entity: 'MissingPerson',

      entityId: updated.id,

      diff: {
        resetToPending: shouldResetToPending,
        result: 'success',
      },
    });

    // ─────────────────────────────────────────
    // NOTIFICATION
    // ─────────────────────────────────────────

    this.eventEmitter.emit(NotificationEventEnum.MISSING_PERSON_UPDATED, {
      userId: existing.userId,

      missingPersonId: updated.id,

      status: updated.status,
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────

  async remove(user: CurrentUserDto, id: string) {
    const existing = await this.prisma.missingPerson.findUnique({
      where: {
        id,
      },
    });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    // ─────────────────────────────────────────
    // OWNERSHIP CHECK
    // ─────────────────────────────────────────

    if (existing.userId !== user.id) {
      throw new ForbiddenException('not_authorized_to_delete');
    }

    await this.prisma.missingPerson.delete({
      where: {
        id,
      },
    });

    /*
     * There is currently no
     *
     * MISSING_PERSON_DELETED
     *
     * event in AuditEventEnum.
     *
     * Therefore we intentionally do not
     * emit an incorrect audit event.
     */

    return {
      message: 'missing_person_deleted',
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — FIND ALL (paginated, includes submissions)
  // ─────────────────────────────────────────────

  async findAllForAdmin(query: ListMissingPersonsAdminQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,

        include: {
          informationSubmissions: true,
        },

        orderBy: {
          createdAt: 'desc',
        },

        skip: (page - 1) * limit,
        take: limit,
      }),

      this.prisma.missingPerson.count({
        where,
      }),
    ]);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  // ─────────────────────────────────────────────

  async updateStatus(admin: CurrentUserDto, id: string, status: MissingPersonStatus) {
    const existing = await this.prisma.missingPerson.findUnique({
      where: {
        id,
      },
    });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    // ─────────────────────────────────────────
    // NO-OP PROTECTION
    // ─────────────────────────────────────────

    if (existing.status === status) {
      return existing;
    }

    const updated = await this.prisma.missingPerson.update({
      where: {
        id,
      },

      data: {
        status,
      },
    });

    // ─────────────────────────────────────────
    // DETERMINE AUDIT EVENT
    // ─────────────────────────────────────────

    let auditEvent: AuditEventEnum;

    switch (status) {
      case MissingPersonStatus.APPROVED:
        auditEvent = AuditEventEnum.MISSING_PERSON_APPROVED;
        break;

      case MissingPersonStatus.REJECTED:
        auditEvent = AuditEventEnum.MISSING_PERSON_REJECTED;
        break;

      case MissingPersonStatus.FOUND:
        auditEvent = AuditEventEnum.MISSING_PERSON_FOUND;
        break;

      default:
        auditEvent = AuditEventEnum.MISSING_PERSON_UPDATED;
        break;
    }

    // ─────────────────────────────────────────
    // AUDIT
    // ─────────────────────────────────────────

    this.emitAudit({
      userId: admin.id,

      actorType: resolveActorType(admin.roles ?? []),

      action: auditEvent,

      entity: 'MissingPerson',

      entityId: updated.id,

      diff: {
        previousStatus: existing.status,

        newStatus: updated.status,

        result: 'success',
      },
    });

    // ─────────────────────────────────────────
    // NOTIFICATION
    // ─────────────────────────────────────────

    this.eventEmitter.emit(NotificationEventEnum.MISSING_PERSON_UPDATED, {
      userId: existing.userId,

      missingPersonId: updated.id,

      previousStatus: existing.status,

      status: updated.status,
    });

    return updated;
  }
}

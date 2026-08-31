import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  MissingPersonStatus,
  MissingPersonType,
} from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import {
  CreateMissingPersonDto,
  UpdateMissingPersonDto,
} from '../dto/missing-person.dto';

@Injectable()
export class MissingPersonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // CREATE
  // ─────────────────────────────────────────────

  async create(
    user: CurrentUserDto,
    data: CreateMissingPersonDto,
  ) {
    const missingPerson =
      await this.prisma.missingPerson.create({
        data: {
          userId: user.id,

          personType: data.personType,

          name: data.name,
          description: data.description,

          dateLastSeen: new Date(
            data.dateLastSeen,
          ),

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

    this.eventEmitter.emit(
      AuditEventEnum.MISSING_PERSON_CREATED,
      {
        userId: user.id,

        actorType: resolveActorType(
          user.roles ?? [],
        ),

        action:
          AuditEventEnum.MISSING_PERSON_CREATED,

        entity: 'MissingPerson',

        entityId: missingPerson.id,

        diff: {
          personType:
            missingPerson.personType,

          status:
            missingPerson.status,

          result: 'success',
        },
      } as AuditEventPayload,
    );

    // ─────────────────────────────────────────
    // NOTIFICATION
    // ─────────────────────────────────────────

    this.eventEmitter.emit(
      NotificationEventEnum.NEW_MISSING_PERSON_REQUEST,
      {
        userId: user.id,

        missingPersonId:
          missingPerson.id,
      },
    );

    return missingPerson;
  }

  // ─────────────────────────────────────────────
  // FIND ONE
  // ─────────────────────────────────────────────

  async findOne(id: string) {
    const missingPerson =
      await this.prisma.missingPerson.findUnique({
        where: {
          id,
        },

        include: {
          informationSubmissions: true,
        },
      });

    if (!missingPerson) {
      throw new NotFoundException(
        'missing_person_not_found',
      );
    }

    return missingPerson;
  }

  // ─────────────────────────────────────────────
  // FIND ALL PUBLIC
  // ─────────────────────────────────────────────

  async findAll(
    type?: MissingPersonType,
  ) {
    return this.prisma.missingPerson.findMany({
      where: {
        status: MissingPersonStatus.APPROVED,

        ...(type !== undefined
          ? {
              personType: type,
            }
          : {}),
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // FIND MINE
  // ─────────────────────────────────────────────

  async findMine(
    user: CurrentUserDto,
  ) {
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
  // ─────────────────────────────────────────────

  async update(
    user: CurrentUserDto,
    id: string,
    data: UpdateMissingPersonDto,
  ) {
    const existing =
      await this.prisma.missingPerson.findUnique({
        where: {
          id,
        },
      });

    if (!existing) {
      throw new NotFoundException(
        'missing_person_not_found',
      );
    }

    // ─────────────────────────────────────────
    // OWNERSHIP CHECK
    // ─────────────────────────────────────────

    if (existing.userId !== user.id) {
      throw new BadRequestException(
        'not_authorized_to_update',
      );
    }

    const updated =
      await this.prisma.missingPerson.update({
        where: {
          id,
        },

        data: {
          ...(data.personType !== undefined
            ? {
                personType:
                  data.personType,
              }
            : {}),

          ...(data.name !== undefined
            ? {
                name: data.name,
              }
            : {}),

          ...(data.description !== undefined
            ? {
                description:
                  data.description,
              }
            : {}),

          ...(data.dateLastSeen !== undefined
            ? {
                dateLastSeen: new Date(
                  data.dateLastSeen,
                ),
              }
            : {}),

          ...(data.lastKnownArea !== undefined
            ? {
                lastKnownArea:
                  data.lastKnownArea,
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
        },
      });

    // ─────────────────────────────────────────
    // AUDIT
    // ─────────────────────────────────────────

    this.eventEmitter.emit(
      AuditEventEnum.MISSING_PERSON_UPDATED,
      {
        userId: user.id,

        actorType: resolveActorType(
          user.roles ?? [],
        ),

        action:
          AuditEventEnum.MISSING_PERSON_UPDATED,

        entity: 'MissingPerson',

        entityId: updated.id,

        diff: {
          result: 'success',
        },
      } as AuditEventPayload,
    );

    // ─────────────────────────────────────────
    // NOTIFICATION
    // ─────────────────────────────────────────

    this.eventEmitter.emit(
      NotificationEventEnum.MISSING_PERSON_UPDATED,
      {
        userId: existing.userId,

        missingPersonId:
          updated.id,

        status:
          updated.status,
      },
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────

  async remove(
    user: CurrentUserDto,
    id: string,
  ) {
    const existing =
      await this.prisma.missingPerson.findUnique({
        where: {
          id,
        },
      });

    if (!existing) {
      throw new NotFoundException(
        'missing_person_not_found',
      );
    }

    // ─────────────────────────────────────────
    // OWNERSHIP CHECK
    // ─────────────────────────────────────────

    if (existing.userId !== user.id) {
      throw new BadRequestException(
        'not_authorized_to_delete',
      );
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
      message:
        'missing_person_deleted',
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — FIND ALL
  // ─────────────────────────────────────────────

  async findAllForAdmin(
    status?: MissingPersonStatus,
  ) {
    return this.prisma.missingPerson.findMany({
      where: {
        ...(status !== undefined
          ? {
              status,
            }
          : {}),
      },

      include: {
        informationSubmissions: true,
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  // ─────────────────────────────────────────────

  async updateStatus(
    admin: CurrentUserDto,
    id: string,
    status: MissingPersonStatus,
  ) {
    const existing =
      await this.prisma.missingPerson.findUnique({
        where: {
          id,
        },
      });

    if (!existing) {
      throw new NotFoundException(
        'missing_person_not_found',
      );
    }

    // ─────────────────────────────────────────
    // NO-OP PROTECTION
    // ─────────────────────────────────────────

    if (existing.status === status) {
      return existing;
    }

    const updated =
      await this.prisma.missingPerson.update({
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
        auditEvent =
          AuditEventEnum.MISSING_PERSON_APPROVED;
        break;

      case MissingPersonStatus.REJECTED:
        auditEvent =
          AuditEventEnum.MISSING_PERSON_REJECTED;
        break;

      case MissingPersonStatus.FOUND:
        auditEvent =
          AuditEventEnum.MISSING_PERSON_FOUND;
        break;

      default:
        auditEvent =
          AuditEventEnum.MISSING_PERSON_UPDATED;
        break;
    }

    // ─────────────────────────────────────────
    // AUDIT
    // ─────────────────────────────────────────

    this.eventEmitter.emit(
      auditEvent,
      {
        userId: admin.id,

        actorType: resolveActorType(
          admin.roles ?? [],
        ),

        action: auditEvent,

        entity: 'MissingPerson',

        entityId: updated.id,

        diff: {
          previousStatus:
            existing.status,

          newStatus:
            updated.status,

          result: 'success',
        },
      } as AuditEventPayload,
    );

    // ─────────────────────────────────────────
    // NOTIFICATION
    // ─────────────────────────────────────────

    this.eventEmitter.emit(
      NotificationEventEnum.MISSING_PERSON_UPDATED,
      {
        userId: existing.userId,

        missingPersonId:
          updated.id,

        previousStatus:
          existing.status,

        status:
          updated.status,
      },
    );

    return updated;
  }
}
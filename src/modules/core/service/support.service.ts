
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  SupportAgreementType,
  SupportStatus,
  SupportType,
} from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';

import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // CREATE SUPPORT
  // ─────────────────────────────────────────────

  async create(
    user: CurrentUserDto,
    data: {
      victimProfileId: string;
      type?: SupportType;
      agreementType?: SupportAgreementType;
      amount?: number;
      recipientAmount?: number;
      organizationAmount?: number;
      platformAmount?: number;
      message?: string;
    },
  ) {
    const victimProfile =
      await this.prisma.victimProfile.findUnique({
        where: {
          id: data.victimProfileId,
        },
      });

    if (!victimProfile) {
      throw new NotFoundException(
        'victim_profile_not_found',
      );
    }

    if (
      victimProfile.status !== 'PUBLISHED' ||
      !victimProfile.isPublished
    ) {
      throw new BadRequestException(
        'victim_profile_not_available_for_support',
      );
    }

    const support =
      await this.prisma.support.create({
        data: {
          victimProfileId:
            data.victimProfileId,

          userId: user.id,

          type:
            data.type ??
            SupportType.FINANCIAL,

          agreementType:
            data.agreementType ??
            SupportAgreementType.DIRECT,

          amount:
            data.amount,

          recipientAmount:
            data.recipientAmount,

          organizationAmount:
            data.organizationAmount,

          platformAmount:
            data.platformAmount,

          message:
            data.message,

          status:
            SupportStatus.PENDING,
        },
      });

    const roles =
      (user as unknown as {
        roles?: string[];
      }).roles ?? [];

    // ─────────────────────────────────────────
    // AUDIT
    // ─────────────────────────────────────────

    this.eventEmitter.emit(
      AuditEventEnum.SUPPORT_CREATED,
      {
        userId: user.id,

        actorType:
          resolveActorType(roles),

        action:
          AuditEventEnum.SUPPORT_CREATED,

        entity: 'Support',

        entityId: support.id,

        diff: {
          result: 'success',
          status: support.status,
          type: support.type,
          agreementType:
            support.agreementType,
        },
      } as AuditEventPayload,
    );

    // ─────────────────────────────────────────
    // NOTIFICATION
    // ─────────────────────────────────────────

    this.eventEmitter.emit(
      NotificationEventEnum.SUPPORT_PAYMENT_CONFIRMED,
      {
        supportId: support.id,
        userId: user.id,
      },
    );

    return support;
  }

  // ─────────────────────────────────────────────
  // MY SUPPORT REQUESTS
  // ─────────────────────────────────────────────

  async findMine(
    user: CurrentUserDto,
  ) {
    return this.prisma.support.findMany({
      where: {
        userId: user.id,
      },

      include: {
        victimProfile: true,
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // SUPPORT FOR VICTIM PROFILE
  // ─────────────────────────────────────────────

  async findForVictimProfile(
    victimProfileId: string,
  ) {
    return this.prisma.support.findMany({
      where: {
        victimProfileId,
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // GET ONE SUPPORT
  // ─────────────────────────────────────────────

  async findOne(id: string) {
    const support =
      await this.prisma.support.findUnique({
        where: {
          id,
        },

        include: {
          victimProfile: true,
          user: true,
        },
      });

    if (!support) {
      throw new NotFoundException(
        'support_not_found',
      );
    }

    return support;
  }

  // ─────────────────────────────────────────────
  // UPDATE STATUS
  // ─────────────────────────────────────────────

  async updateStatus(
    id: string,
    status: SupportStatus,
  ) {
    const support =
      await this.prisma.support.findUnique({
        where: {
          id,
        },
      });

    if (!support) {
      throw new NotFoundException(
        'support_not_found',
      );
    }

    const previousStatus =
      support.status;

    // ─────────────────────────────────────────
    // PREVENT USELESS STATUS UPDATE
    // ─────────────────────────────────────────

    if (previousStatus === status) {
      throw new BadRequestException(
        'support_already_has_status',
      );
    }

    const updatedSupport =
      await this.prisma.support.update({
        where: {
          id,
        },

        data: {
          status,
        },
      });

    // ─────────────────────────────────────────
    // AUDIT EVENT
    // ─────────────────────────────────────────

    let auditEvent:
      | AuditEventEnum.SUPPORT_CONFIRMED
      | AuditEventEnum.SUPPORT_COMPLETED
      | AuditEventEnum.SUPPORT_CANCELLED
      | AuditEventEnum.SUPPORT_FAILED
      | null = null;

    switch (status) {
      case SupportStatus.CONFIRMED:
        auditEvent =
          AuditEventEnum.SUPPORT_CONFIRMED;
        break;

      case SupportStatus.COMPLETED:
        auditEvent =
          AuditEventEnum.SUPPORT_COMPLETED;
        break;

      case SupportStatus.CANCELLED:
        auditEvent =
          AuditEventEnum.SUPPORT_CANCELLED;
        break;

      case SupportStatus.FAILED:
        auditEvent =
          AuditEventEnum.SUPPORT_FAILED;
        break;
    }

    if (auditEvent) {
      this.eventEmitter.emit(
        auditEvent,
        {
          userId:
            support.userId,

          actorType:
            resolveActorType([]),

          action:
            auditEvent,

          entity: 'Support',

          entityId:
            support.id,

          diff: {
            previousStatus,
            currentStatus:
              updatedSupport.status,
            result: 'success',
          },
        } as AuditEventPayload,
      );
    }

    // ─────────────────────────────────────────
    // NOTIFICATIONS
    // ─────────────────────────────────────────

    if (
      status ===
      SupportStatus.CONFIRMED
    ) {
      this.eventEmitter.emit(
        NotificationEventEnum.SUPPORT_PAYMENT_CONFIRMED,
        {
          supportId:
            updatedSupport.id,

          userId:
            support.userId,
        },
      );
    }

    return updatedSupport;
  }

  // ─────────────────────────────────────────────
  // CONFIRM PAYMENT
  // ─────────────────────────────────────────────

  async confirm(id: string) {
    return this.updateStatus(
      id,
      SupportStatus.CONFIRMED,
    );
  }

  // ─────────────────────────────────────────────
  // COMPLETE PAYMENT
  // ─────────────────────────────────────────────

  async complete(id: string) {
    return this.updateStatus(
      id,
      SupportStatus.COMPLETED,
    );
  }

  // ─────────────────────────────────────────────
  // CANCEL SUPPORT
  // ─────────────────────────────────────────────

  async cancel(id: string) {
    return this.updateStatus(
      id,
      SupportStatus.CANCELLED,
    );
  }
}


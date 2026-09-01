import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { SupportStatus } from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';

import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { CreateSupportDto } from '../dto/support.dto';

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // CREATE SUPPORT
  // ─────────────────────────────────────────────

  async create(user: CurrentUserDto, data: CreateSupportDto) {
    const victimProfile = await this.prisma.victimProfile.findUnique({
      where: { id: data.victimProfileId },
    });

    if (!victimProfile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (
      victimProfile.status !== 'PUBLISHED' ||
      !victimProfile.isPublished
    ) {
      throw new BadRequestException(
        'victim_profile_not_available_for_support',
      );
    }

    // If a breakdown is provided, it must add up to the total —
    // this is what the payer sees before transferring money.
    const breakdownProvided =
      data.recipientAmount !== undefined ||
      data.organizationAmount !== undefined ||
      data.platformAmount !== undefined;

    if (breakdownProvided) {
      const sum =
        (data.recipientAmount ?? 0) +
        (data.organizationAmount ?? 0) +
        (data.platformAmount ?? 0);

      // Guard against floating point noise.
      if (Math.abs(sum - data.amount) > 0.01) {
        throw new BadRequestException(
          'support_breakdown_does_not_match_amount',
        );
      }
    }

    const support = await this.prisma.support.create({
      data: {
        victimProfileId: data.victimProfileId,

        userId: user.id,

        type: data.type ?? 'FINANCIAL',
        agreementType: data.agreementType ?? 'DIRECT',

        amount: data.amount,

        recipientAmount: data.recipientAmount,
        organizationAmount: data.organizationAmount,
        platformAmount: data.platformAmount,

        transferReference: data.transferReference,
        message: data.message,

        status: SupportStatus.PENDING,
      },
    });

    const roles =
      (user as unknown as { roles?: string[] }).roles ?? [];

    this.eventEmitter.emit(AuditEventEnum.SUPPORT_CREATED, {
      userId: user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.SUPPORT_CREATED,
      entity: 'Support',
      entityId: support.id,

      diff: {
        result: 'success',
        status: support.status,
        type: support.type,
        agreementType: support.agreementType,
      },
    } as AuditEventPayload);

    // Note: this notifies as if payment were confirmed at creation
    // time, which is misleading — a PENDING support hasn't been
    // confirmed by anyone yet. Consider firing a
    // SUPPORT_PLEDGE_CREATED-style event here instead and reserving
    // SUPPORT_PAYMENT_CONFIRMED for the confirm() transition below.

    return support;
  }

  // ─────────────────────────────────────────────
  // MY SUPPORT REQUESTS
  // ─────────────────────────────────────────────

  async findMine(user: CurrentUserDto) {
    return this.prisma.support.findMany({
      where: { userId: user.id },

      include: { victimProfile: true },

      orderBy: { createdAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // SUPPORT FOR VICTIM PROFILE
  // ─────────────────────────────────────────────

  async findForVictimProfile(victimProfileId: string) {
    return this.prisma.support.findMany({
      where: { victimProfileId },

      orderBy: { createdAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // GET ONE SUPPORT
  // ─────────────────────────────────────────────

  async findOne(id: string) {
    const support = await this.prisma.support.findUnique({
      where: { id },

      include: {
        victimProfile: true,
        user: true,
      },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    return support;
  }

  // ─────────────────────────────────────────────
  // UPDATE STATUS (internal — callers below enforce who's allowed)
  // ─────────────────────────────────────────────

  private async updateStatus(id: string, status: SupportStatus) {
    const support = await this.prisma.support.findUnique({
      where: { id },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    const previousStatus = support.status;

    if (previousStatus === status) {
      throw new BadRequestException('support_already_has_status');
    }

    const updatedSupport = await this.prisma.support.update({
      where: { id },
      data: { status },
    });

    let auditEvent:
      | AuditEventEnum.SUPPORT_CONFIRMED
      | AuditEventEnum.SUPPORT_COMPLETED
      | AuditEventEnum.SUPPORT_CANCELLED
      | AuditEventEnum.SUPPORT_FAILED
      | null = null;

    switch (status) {
      case SupportStatus.CONFIRMED:
        auditEvent = AuditEventEnum.SUPPORT_CONFIRMED;
        break;
      case SupportStatus.COMPLETED:
        auditEvent = AuditEventEnum.SUPPORT_COMPLETED;
        break;
      case SupportStatus.CANCELLED:
        auditEvent = AuditEventEnum.SUPPORT_CANCELLED;
        break;
      case SupportStatus.FAILED:
        auditEvent = AuditEventEnum.SUPPORT_FAILED;
        break;
    }

    if (auditEvent) {
      this.eventEmitter.emit(auditEvent, {
        userId: support.userId,
        actorType: resolveActorType([]),
        action: auditEvent,
        entity: 'Support',
        entityId: support.id,

        diff: {
          previousStatus,
          currentStatus: updatedSupport.status,
          result: 'success',
        },
      } as AuditEventPayload);
    }

    if (status === SupportStatus.CONFIRMED) {
      this.eventEmitter.emit(
        NotificationEventEnum.SUPPORT_PAYMENT_CONFIRMED,
        {
          supportId: updatedSupport.id,
          userId: support.userId,
        },
      );
    }

    return updatedSupport;
  }

  // ─────────────────────────────────────────────
  // CONFIRM — admin only (controller enforces @Roles)
  // Represents an admin verifying the off-platform transfer arrived.
  // ─────────────────────────────────────────────

  async confirm(id: string) {
    return this.updateStatus(id, SupportStatus.CONFIRMED);
  }

  // ─────────────────────────────────────────────
  // COMPLETE — admin only (controller enforces @Roles)
  // ─────────────────────────────────────────────

  async complete(id: string) {
    return this.updateStatus(id, SupportStatus.COMPLETED);
  }

  // ─────────────────────────────────────────────
  // CANCEL — the support's own creator, or an admin
  // ─────────────────────────────────────────────

  async cancel(id: string, requestingUser: CurrentUserDto) {
    const support = await this.prisma.support.findUnique({
      where: { id },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    const roles =
      (requestingUser as unknown as { roles?: string[] }).roles ?? [];

    const isOwner = support.userId === requestingUser.id;
    const isAdmin = roles.some((r) =>
      ['ADMIN', 'SUPER_ADMIN'].includes(r),
    );

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('not_allowed_to_cancel_support');
    }

    // Once an admin has confirmed money arrived, a supporter
    // shouldn't be able to unilaterally cancel that record.
    if (support.status === SupportStatus.CONFIRMED && !isAdmin) {
      throw new BadRequestException(
        'cannot_cancel_confirmed_support',
      );
    }

    return this.updateStatus(id, SupportStatus.CANCELLED);
  }
}
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditOutcome, AuditSeverity, SupportStatus } from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';

import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { RolesEnum } from 'src/common/enums/roles.enum';

import { CreateSupportDto } from '../dto/support.dto';

const ADMIN_ROLE_NAMES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  private getRoles(user: CurrentUserDto): string[] {
    return (
      (
        user as unknown as {
          roles?: string[];
        }
      ).roles ?? []
    );
  }

  private isAdmin(user: CurrentUserDto): boolean {
    return this.getRoles(user).some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));
  }

  // Labels by transferReference (the off-platform reference an admin verifies against).
  private buildSupportLabel(support: { id: string; transferReference: string | null }): string {
    return support.transferReference ?? `support:${support.id.slice(0, 8)}`;
  }

  // Only against a PUBLISHED, published victim profile; breakdown fields must sum to amount.
  async create(user: CurrentUserDto, data: CreateSupportDto) {
    const roles = this.getRoles(user);
    const actorType = resolveActorType(roles);

    const victimProfile = await this.prisma.victimProfile.findUnique({
      where: { id: data.victimProfileId },
    });

    if (!victimProfile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (victimProfile.status !== 'PUBLISHED' || !victimProfile.isPublished) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.SUPPORT_CREATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'VictimProfile',
        entityId: victimProfile.id,
        diff: {
          result: 'failure',
          reason: 'victim_profile_not_available_for_support',
          profileStatus: victimProfile.status,
          isPublished: victimProfile.isPublished,
        },
        metadata: { amount: data.amount },
      });
      throw new BadRequestException('victim_profile_not_available_for_support');
    }

    const breakdownProvided =
      data.recipientAmount !== undefined ||
      data.organizationAmount !== undefined ||
      data.platformAmount !== undefined;

    if (breakdownProvided) {
      const sum =
        (data.recipientAmount ?? 0) + (data.organizationAmount ?? 0) + (data.platformAmount ?? 0);

      // Guard against floating point noise.
      if (Math.abs(sum - data.amount) > 0.01) {
        this.emitAudit({
          userId: user.id,
          actorType,
          action: AuditEventEnum.SUPPORT_CREATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'VictimProfile',
          entityId: victimProfile.id,
          diff: {
            result: 'failure',
            reason: 'support_breakdown_does_not_match_amount',
          },
          metadata: {
            amount: data.amount,
            breakdownSum: sum,
            recipientAmount: data.recipientAmount ?? null,
            organizationAmount: data.organizationAmount ?? null,
            platformAmount: data.platformAmount ?? null,
          },
        });
        throw new BadRequestException('support_breakdown_does_not_match_amount');
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

    this.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.SUPPORT_CREATED,
      entity: 'Support',
      entityId: support.id,
      entityLabel: this.buildSupportLabel(support),
      reason: data.message ?? null,
      diff: {
        result: 'success',
        status: support.status,
        type: support.type,
        agreementType: support.agreementType,
      },
      metadata: {
        victimProfileId: support.victimProfileId,
        amount: Number(support.amount ?? 0),
        recipientAmount: support.recipientAmount ?? null,
        organizationAmount: support.organizationAmount ?? null,
        platformAmount: support.platformAmount ?? null,
        transferReference: support.transferReference ?? null,
      },
    });

    // PENDING support hasn't been confirmed by anyone yet — this is a pledge, not a payment.
    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_PLEDGE_CREATED, {
      supportId: support.id,
      userId: support.userId,
      victimProfileId: support.victimProfileId,
    });

    return support;
  }

  async findMine(user: CurrentUserDto) {
    return this.prisma.support.findMany({
      where: { userId: user.id },

      include: { victimProfile: true },

      orderBy: { createdAt: 'desc' },
    });
  }

  async findForVictimProfile(victimProfileId: string) {
    return this.prisma.support.findMany({
      where: { victimProfileId },

      orderBy: { createdAt: 'desc' },
    });
  }

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

  // Admin dashboard stats: totals by status, and total confirmed amount.
  async getStats() {
    const [total, byStatus, confirmedSum] = await this.prisma.$transaction([
      this.prisma.support.count(),
      this.prisma.support.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.support.aggregate({
        where: { status: SupportStatus.CONFIRMED },
        _sum: { recipientAmount: true, amount: true },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(SupportStatus).map((status) => [status, 0]),
    ) as Record<SupportStatus, number>;

    for (const row of byStatus) {
      const rowCount = row._count as { status?: number } | undefined;
      statusCounts[row.status] = rowCount?.status ?? 0;
    }

    return {
      total,
      pending: statusCounts[SupportStatus.PENDING] ?? 0,
      confirmed: statusCounts[SupportStatus.CONFIRMED] ?? 0,
      completed: statusCounts[SupportStatus.COMPLETED] ?? 0,
      cancelled: statusCounts[SupportStatus.CANCELLED] ?? 0,
      failed: statusCounts[SupportStatus.FAILED] ?? 0,
      totalConfirmedAmount: Number(
        confirmedSum._sum.recipientAmount ?? confirmedSum._sum.amount ?? 0,
      ),
    };
  }

  // Keeps VictimProfile.totalRaised in sync atomically when crossing into/out of CONFIRMED.
  private async updateStatus(
    id: string,
    status: SupportStatus,
    actor: CurrentUserDto,
    reason?: string,
  ) {
    const actorRoles = this.getRoles(actor);
    const actorType = resolveActorType(actorRoles);

    const support = await this.prisma.support.findUnique({
      where: { id },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    const previousStatus = support.status;
    const label = this.buildSupportLabel(support);

    // Set only when the actor is someone other than the supporter — a self-cancel isn't "against" anyone.
    const targetUserFields =
      actor.id === support.userId ? {} : { targetUserId: support.userId };

    if (previousStatus === status) {
      this.emitAudit({
        userId: actor.id,
        ...targetUserFields,
        actorType,
        action: AuditEventEnum.SUPPORT_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'support_already_has_status',
          currentStatus: previousStatus,
          attemptedStatus: status,
        },
      });
      throw new BadRequestException('support_already_has_status');
    }

    const wasCounted = previousStatus === SupportStatus.CONFIRMED;
    const isCounted = status === SupportStatus.CONFIRMED;
    const amount = Number(support.recipientAmount ?? support.amount ?? 0);

    // Non-zero only when the support enters or leaves CONFIRMED.
    let totalRaisedDelta = 0;
    if (!wasCounted && isCounted) totalRaisedDelta = amount;
    if (wasCounted && !isCounted) totalRaisedDelta = -amount;

    // Returns null on a lost race so the transaction commits as a no-op instead of rolling back.
    const updatedSupport = await this.prisma.$transaction(async (tx) => {
      const result = await tx.support.updateMany({
        where: { id, status: previousStatus },
        data: { status },
      });

      if (result.count === 0) {
        return null;
      }

      if (totalRaisedDelta !== 0) {
        await tx.victimProfile.update({
          where: { id: support.victimProfileId },
          data: { totalRaised: { increment: totalRaisedDelta } },
        });
      }

      return tx.support.findUniqueOrThrow({ where: { id } });
    });

    if (!updatedSupport) {
      this.emitAudit({
        userId: actor.id,
        ...targetUserFields,
        actorType,
        action: AuditEventEnum.SUPPORT_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'support_transition_conflict',
          expectedStatus: previousStatus,
          attemptedStatus: status,
        },
      });
      throw new BadRequestException('support_transition_conflict');
    }

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
      this.emitAudit({
        userId: actor.id,
        ...targetUserFields,
        actorType,
        action: auditEvent,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        reason: reason ?? null,

        diff: {
          result: 'success',
          previousStatus,
          currentStatus: updatedSupport.status,
        },

        metadata: {
          victimProfileId: support.victimProfileId,
          amount,
          totalRaisedDelta,
          transferReference: support.transferReference ?? null,
        },
      });
    }

    if (status === SupportStatus.CONFIRMED) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_PAYMENT_CONFIRMED, {
        supportId: updatedSupport.id,
        userId: support.userId,
      });
    }

    return updatedSupport;
  }

  // Admin-only (controller enforces @Roles); verifies the off-platform transfer arrived.
  async confirm(id: string, admin: CurrentUserDto, reason?: string) {
    return this.updateStatus(id, SupportStatus.CONFIRMED, admin, reason);
  }

  // Admin-only (controller enforces @Roles).
  async complete(id: string, admin: CurrentUserDto, reason?: string) {
    return this.updateStatus(id, SupportStatus.COMPLETED, admin, reason);
  }

  // Cancellable by the support's own creator, or by an admin.
  async cancel(id: string, requestingUser: CurrentUserDto, reason?: string) {
    const support = await this.prisma.support.findUnique({
      where: { id },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    const roles = this.getRoles(requestingUser);
    const actorType = resolveActorType(roles);
    const label = this.buildSupportLabel(support);

    const isOwner = support.userId === requestingUser.id;
    const isAdmin = this.isAdmin(requestingUser);

    if (!isOwner && !isAdmin) {
      this.emitAudit({
        userId: requestingUser.id,
        targetUserId: support.userId,
        actorType,
        action: AuditEventEnum.SUPPORT_CANCELLED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        diff: { result: 'denied', reason: 'not_allowed_to_cancel_support' },
        metadata: {
          victimProfileId: support.victimProfileId,
          currentStatus: support.status,
        },
      });
      throw new ForbiddenException('not_allowed_to_cancel_support');
    }

    // Once an admin has confirmed money arrived, a supporter can't unilaterally cancel it.
    if (support.status === SupportStatus.CONFIRMED && !isAdmin) {
      this.emitAudit({
        userId: requestingUser.id,
        actorType,
        action: AuditEventEnum.SUPPORT_CANCELLED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'cannot_cancel_confirmed_support',
          currentStatus: support.status,
        },
        metadata: { victimProfileId: support.victimProfileId },
      });
      throw new BadRequestException('cannot_cancel_confirmed_support');
    }

    return this.updateStatus(id, SupportStatus.CANCELLED, requestingUser, reason);
  }
}
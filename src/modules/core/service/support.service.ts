import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ActorType,
  AuditOutcome,
  AuditSeverity,
  PartyType,
  Prisma,
  SupportAgreementType,
  SupportCategory,
  SupportStatus,
  SupportType,
} from '@prisma/client';

import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';

import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { RolesEnum } from 'src/common/enums/roles.enum';

import { CreateSupportDto, ListSupportQueryDto } from '../dto/support.dto';

import {
  BILLING_PAYMENT_PAID,
  BillingPaymentPaid,
} from 'src/modules/billing/service/billing-events.service';
import type { AllocationPreview } from 'src/modules/billing/service/allocation.service';

const ADMIN_ROLE_NAMES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

// Only these statuses are shown publicly and counted in total raised (financial) or offers received.
const COUNTED_STATUSES: SupportStatus[] = [SupportStatus.CONFIRMED, SupportStatus.COMPLETED];

const ANONYMOUS_LABEL = 'An anonymous supporter';

// Default number of days an unanswered non-financial offer waits before it is auto-cancelled.
const DEFAULT_OFFER_EXPIRY_DAYS = 14;

// Never includes allocationSnapshot or the User relation.
const SUPPORT_OWNER_SELECT = {
  id: true,
  victimProfileId: true,
  userId: true,
  type: true,
  status: true,
  agreementType: true,
  message: true,
  categories: true,
  anonymous: true,
  contactMayBeShared: true,
  victimConfirmedReceiptAt: true,
  transferReference: true,
  amount: true,
  recipientAmount: true,
  organizationAmount: true,
  platformAmount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SupportSelect;

// Bank details and internal review fields are deliberately left out.
const VICTIM_PROFILE_SUMMARY_SELECT = {
  id: true,
  name: true,
  description: true,
  photo: true,
  status: true,
  isPublished: true,
  supportGoal: true,
  totalRaised: true,
} satisfies Prisma.VictimProfileSelect;

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly config: ConfigService,
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

  // Non-financial offers only. Money is never accepted here: financial support is created by
  // onPaymentPaid() after Chapa confirms a payment.
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
        metadata: { categories: data.categories },
      });
      throw new BadRequestException('victim_profile_not_available_for_support');
    }

    const categories = [...new Set(data.categories)];
    if (categories.length === 0) {
      throw new BadRequestException('support_categories_required');
    }

    const note = data.message?.trim() || undefined;
    if (categories.includes(SupportCategory.OTHER) && !note) {
      throw new BadRequestException('support_note_required_for_other');
    }

    const support = await this.prisma.support.create({
      data: {
        victimProfileId: data.victimProfileId,
        userId: user.id,
        type: SupportType.NON_FINANCIAL,
        status: SupportStatus.PENDING,
        categories,
        message: note,
        anonymous: data.anonymous ?? true,
        contactMayBeShared: data.contactMayBeShared ?? false,
      },
      select: SUPPORT_OWNER_SELECT,
    });

    this.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.SUPPORT_CREATED,
      entity: 'Support',
      entityId: support.id,
      entityLabel: this.buildSupportLabel(support),
      reason: note ?? null,
      diff: {
        result: 'success',
        status: support.status,
        type: support.type,
      },
      metadata: {
        victimProfileId: support.victimProfileId,
        categories: support.categories,
        anonymous: support.anonymous,
        contactMayBeShared: support.contactMayBeShared,
      },
    });

    // The supporter is told right away. The victim is NOT told until an admin confirms the offer.
    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_PLEDGE_CREATED, {
      supportId: support.id,
      userId: support.userId,
      victimProfileId: support.victimProfileId,
    });

    return support;
  }

  // Runs when Chapa has confirmed a support payment. Safe to run twice: the payment's fulfilledAt
  // is claimed in the same transaction that creates the Support, so a repeat does nothing.
  @OnEvent(BILLING_PAYMENT_PAID)
  async onPaymentPaid(e: BillingPaymentPaid): Promise<void> {
    try {
      await this.fulfilSupportPayment(e.paymentId);
    } catch (error) {
      // The repair job re-emits the event for PAID support payments that are still unfulfilled.
      this.logger.error(
        `Could not create support for payment ${e.paymentId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async fulfilSupportPayment(paymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        payerUserId: true,
        victimProfileId: true,
        agreementId: true,
        agreementVersion: true,
        allocationSnapshot: true,
        supportAnonymous: true,
        supportId: true,
        fulfilledAt: true,
      },
    });

    if (!payment || payment.type !== 'SUPPORT') return;
    if (payment.status !== 'PAID' || payment.fulfilledAt || payment.supportId) return;

    if (!payment.victimProfileId) {
      this.logger.warn(`Paid support payment ${payment.id} has no victim profile; not fulfilled`);
      return;
    }
    const victimProfileId = payment.victimProfileId;

    const snapshot = payment.allocationSnapshot as unknown as AllocationPreview;
    const shareOf = (party: PartyType): Prisma.Decimal =>
      (snapshot.lines ?? [])
        .filter((line) => line.partyType === party)
        .reduce((sum, line) => sum.add(new Prisma.Decimal(line.amount)), new Prisma.Decimal(0));

    const recipientAmount = shareOf(PartyType.RECIPIENT);
    const organizationAmount = shareOf(PartyType.RESPONSIBLE_ORGANIZATION);
    const platformAmount = shareOf(PartyType.PLATFORM);
    const anonymous = payment.supportAnonymous;

    const supporterName = anonymous
      ? null
      : ((
          await this.prisma.user.findUnique({
            where: { id: payment.payerUserId },
            select: { name: true },
          })
        )?.name ?? null);

    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PAID', fulfilledAt: null, supportId: null },
        data: { fulfilledAt: new Date() },
      });
      if (claimed.count === 0) return null;

      const support = await tx.support.create({
        data: {
          victimProfileId,
          userId: payment.payerUserId,
          type: SupportType.FINANCIAL,
          status: SupportStatus.CONFIRMED,
          agreementType: snapshot.agreementType ?? SupportAgreementType.DIRECT,
          agreementId: payment.agreementId,
          agreementVersion: payment.agreementVersion,
          allocationSnapshot: payment.allocationSnapshot as Prisma.InputJsonValue,
          amount: payment.amount,
          recipientAmount,
          organizationAmount,
          platformAmount,
          anonymous,
        },
        select: { id: true },
      });

      await tx.payment.update({
        where: { id: payment.id },
        data: { supportId: support.id },
      });

      // The total is read from the same statement that increments it, so the message adds up.
      const profile = await tx.victimProfile.update({
        where: { id: victimProfileId },
        data: { totalRaised: { increment: recipientAmount } },
        select: { totalRaised: true, claimedByUserId: true },
      });

      return {
        supportId: support.id,
        totalRaised: profile.totalRaised,
        claimedByUserId: profile.claimedByUserId,
      };
    });

    if (!result) return;

    this.emitAudit({
      actorType: ActorType.SYSTEM,
      targetUserId: payment.payerUserId,
      action: AuditEventEnum.SUPPORT_CREATED,
      entity: 'Support',
      entityId: result.supportId,
      entityLabel: `support:${result.supportId.slice(0, 8)}`,
      diff: {
        result: 'success',
        status: SupportStatus.CONFIRMED,
        type: SupportType.FINANCIAL,
      },
      metadata: {
        victimProfileId,
        paymentId: payment.id,
        amount: payment.amount.toFixed(2),
        recipientAmount: recipientAmount.toFixed(2),
        organizationAmount: organizationAmount.toFixed(2),
        platformAmount: platformAmount.toFixed(2),
        anonymous,
        totalRaised: result.totalRaised.toFixed(2),
      },
    });

    // Only the claiming user is told. An unclaimed profile gets no automatic message.
    if (result.claimedByUserId) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_RECEIVED, {
        userId: result.claimedByUserId,
        supportId: result.supportId,
        victimProfileId,
        supporterName,
        recipientAmount: recipientAmount.toFixed(2),
        totalRaised: result.totalRaised.toFixed(2),
      });
    }
  }

  async findMine(user: CurrentUserDto) {
    return this.prisma.support.findMany({
      where: { userId: user.id },

      select: {
        ...SUPPORT_OWNER_SELECT,
        victimProfile: { select: VICTIM_PROFILE_SUMMARY_SELECT },
      },

      orderBy: { createdAt: 'desc' },
    });
  }

  // Admin queue. Includes the supporter's contact because the team follows up off the platform.
  async listForAdmin(query: ListSupportQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.SupportWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.support.count({ where }),
      this.prisma.support.findMany({
        where,
        select: {
          ...SUPPORT_OWNER_SELECT,
          user: { select: { id: true, name: true, phone: true, email: true } },
          victimProfile: { select: { id: true, name: true, claimedByUserId: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { total, page, limit, items };
  }

  // Public list for a published profile. Only CONFIRMED or COMPLETED supports, respecting the
  // anonymous flag. No notes, contact details, user IDs or allocation data.
  async findForVictimProfile(victimProfileId: string) {
    await this.assertPublishedProfile(victimProfileId);

    const supports = await this.prisma.support.findMany({
      where: { victimProfileId, status: { in: COUNTED_STATUSES } },
      select: {
        id: true,
        type: true,
        status: true,
        categories: true,
        anonymous: true,
        amount: true,
        recipientAmount: true,
        createdAt: true,
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return supports.map((support) => ({
      id: support.id,
      type: support.type,
      status: support.status,
      categories: support.categories,
      // The recipient's share, so the list adds up to total raised.
      amount:
        support.type === SupportType.FINANCIAL
          ? Number(support.recipientAmount ?? support.amount ?? 0)
          : null,
      supporterName:
        support.anonymous || !support.user?.name ? ANONYMOUS_LABEL : support.user.name,
      createdAt: support.createdAt,
    }));
  }

  // Goods have no money value, so they are counted separately next to total raised.
  async getOfferCounts(victimProfileId: string) {
    await this.assertPublishedProfile(victimProfileId);

    const [received, delivered] = await this.prisma.$transaction([
      this.prisma.support.count({
        where: {
          victimProfileId,
          type: SupportType.NON_FINANCIAL,
          status: { in: COUNTED_STATUSES },
        },
      }),
      this.prisma.support.count({
        where: {
          victimProfileId,
          type: SupportType.NON_FINANCIAL,
          status: SupportStatus.COMPLETED,
        },
      }),
    ]);

    return { offersReceived: received, offersDelivered: delivered };
  }

  private async assertPublishedProfile(victimProfileId: string): Promise<void> {
    const profile = await this.prisma.victimProfile.findFirst({
      where: { id: victimProfileId, status: 'PUBLISHED', isPublished: true },
      select: { id: true },
    });
    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }
  }

  // Only the supporter or an admin. Admins also see the supporter's contact; the full User record
  // (which holds password and passcode hashes) is never selected.
  async findOne(id: string, requestingUser: CurrentUserDto) {
    const isAdmin = this.isAdmin(requestingUser);

    const support = await this.prisma.support.findUnique({
      where: { id },
      select: {
        ...SUPPORT_OWNER_SELECT,
        victimProfile: { select: VICTIM_PROFILE_SUMMARY_SELECT },
        ...(isAdmin
          ? {
              allocationSnapshot: true,
              user: { select: { id: true, name: true, phone: true, email: true } },
            }
          : {}),
      },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    if (!isAdmin && support.userId !== requestingUser.id) {
      throw new ForbiddenException('not_allowed_to_view_support');
    }

    return support;
  }

  // Admin dashboard stats: totals by status and type, total confirmed amount, and offer counts.
  async getStats() {
    const [total, byStatus, byType, byTypeAndStatus, countedSum] = await this.prisma.$transaction([
      this.prisma.support.count(),
      this.prisma.support.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.support.groupBy({
        by: ['type'],
        _count: { type: true },
        orderBy: { type: 'asc' },
      }),
      this.prisma.support.groupBy({
        by: ['type', 'status'],
        _count: { _all: true },
        orderBy: [{ type: 'asc' }, { status: 'asc' }],
      }),
      this.prisma.support.aggregate({
        where: { type: SupportType.FINANCIAL, status: { in: COUNTED_STATUSES } },
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

    const typeCounts = Object.fromEntries(
      Object.values(SupportType).map((type) => [type, 0]),
    ) as Record<SupportType, number>;

    for (const row of byType) {
      const rowCount = row._count as { type?: number } | undefined;
      typeCounts[row.type] = rowCount?.type ?? 0;
    }

    const nonFinancial = { pending: 0, received: 0, delivered: 0, cancelled: 0 };
    for (const row of byTypeAndStatus) {
      if (row.type !== SupportType.NON_FINANCIAL) continue;
      const n = (row._count as { _all?: number } | undefined)?._all ?? 0;
      if (row.status === SupportStatus.PENDING) nonFinancial.pending += n;
      if (row.status === SupportStatus.CONFIRMED || row.status === SupportStatus.COMPLETED) {
        nonFinancial.received += n;
      }
      if (row.status === SupportStatus.COMPLETED) nonFinancial.delivered += n;
      if (row.status === SupportStatus.CANCELLED) nonFinancial.cancelled += n;
    }

    return {
      total,
      pending: statusCounts[SupportStatus.PENDING] ?? 0,
      confirmed: statusCounts[SupportStatus.CONFIRMED] ?? 0,
      completed: statusCounts[SupportStatus.COMPLETED] ?? 0,
      cancelled: statusCounts[SupportStatus.CANCELLED] ?? 0,
      failed: statusCounts[SupportStatus.FAILED] ?? 0,
      byType: typeCounts,
      nonFinancial,
      totalConfirmedAmount: Number(countedSum._sum.recipientAmount ?? countedSum._sum.amount ?? 0),
    };
  }

  // Allowed moves. Completed financial supports can still be cancelled by an admin (paid by mistake).
  private isTransitionAllowed(
    from: SupportStatus,
    to: SupportStatus,
    type: SupportType,
  ): boolean {
    switch (to) {
      case SupportStatus.CONFIRMED:
        return from === SupportStatus.PENDING;
      case SupportStatus.COMPLETED:
        return from === SupportStatus.CONFIRMED;
      case SupportStatus.CANCELLED:
        return (
          from === SupportStatus.PENDING ||
          from === SupportStatus.CONFIRMED ||
          (from === SupportStatus.COMPLETED && type === SupportType.FINANCIAL)
        );
      default:
        return false;
    }
  }

  // Keeps VictimProfile.totalRaised in sync atomically. Only FINANCIAL supports count, and they count
  // while CONFIRMED or COMPLETED. Non-financial supports never touch the total.
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
      include: {
        user: { select: { name: true } },
        victimProfile: { select: { claimedByUserId: true } },
      },
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

    if (!this.isTransitionAllowed(previousStatus, status, support.type)) {
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
          reason: 'support_invalid_transition',
          currentStatus: previousStatus,
          attemptedStatus: status,
          type: support.type,
        },
      });
      throw new BadRequestException('support_invalid_transition');
    }

    const isFinancial = support.type === SupportType.FINANCIAL;
    const wasCounted = isFinancial && COUNTED_STATUSES.includes(previousStatus);
    const isCounted = isFinancial && COUNTED_STATUSES.includes(status);
    const amount = Number(support.recipientAmount ?? support.amount ?? 0);

    // Non-zero only when a financial support enters or leaves the counted statuses.
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

      return tx.support.findUniqueOrThrow({ where: { id }, select: SUPPORT_OWNER_SELECT });
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
          type: support.type,
          amount,
          totalRaisedDelta,
          categories: support.categories,
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

    // Victim messages for non-financial offers: only at confirm and at complete, and only when the
    // profile has been claimed. Unclaimed profiles are handled by the admin.
    const claimedByUserId = support.victimProfile.claimedByUserId;
    if (
      support.type === SupportType.NON_FINANCIAL &&
      claimedByUserId &&
      (status === SupportStatus.CONFIRMED || status === SupportStatus.COMPLETED)
    ) {
      this.eventEmitter.emit(
        status === SupportStatus.CONFIRMED
          ? NotificationEventEnum.SUPPORT_OFFER_CONFIRMED
          : NotificationEventEnum.SUPPORT_OFFER_COMPLETED,
        {
          userId: claimedByUserId,
          supportId: support.id,
          victimProfileId: support.victimProfileId,
          supporterName: support.anonymous ? null : (support.user?.name ?? null),
          categories: support.categories,
        },
      );
    }

    return updatedSupport;
  }

  // Admin-only (controller enforces @Roles). Accepts a PENDING non-financial offer. Financial
  // supports are created already CONFIRMED by a successful payment.
  async confirm(id: string, admin: CurrentUserDto, reason?: string) {
    return this.updateStatus(id, SupportStatus.CONFIRMED, admin, reason);
  }

  // Admin-only (controller enforces @Roles). The note is required and is kept in the audit trail.
  async complete(id: string, admin: CurrentUserDto, note: string) {
    const trimmed = note?.trim();
    if (!trimmed) {
      throw new BadRequestException('completion_note_required');
    }
    return this.updateStatus(id, SupportStatus.COMPLETED, admin, trimmed);
  }

  // The claimed victim confirms, with one tap, that non-financial help arrived. Optional.
  async confirmReceipt(id: string, user: CurrentUserDto) {
    const actorType = resolveActorType(this.getRoles(user));

    const support = await this.prisma.support.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        victimProfileId: true,
        victimConfirmedReceiptAt: true,
        victimProfile: { select: { claimedByUserId: true } },
      },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    if (!support.victimProfile.claimedByUserId || support.victimProfile.claimedByUserId !== user.id) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.SUPPORT_RECEIPT_CONFIRMED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        diff: { result: 'denied', reason: 'not_allowed_to_confirm_receipt' },
        metadata: { victimProfileId: support.victimProfileId },
      });
      throw new ForbiddenException('not_allowed_to_confirm_receipt');
    }

    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('receipt_confirmation_is_for_non_financial_support');
    }

    if (!COUNTED_STATUSES.includes(support.status)) {
      throw new BadRequestException('support_not_ready_for_receipt_confirmation');
    }

    if (support.victimConfirmedReceiptAt) {
      return { id: support.id, status: support.status, victimConfirmedReceiptAt: support.victimConfirmedReceiptAt };
    }

    const now = new Date();
    const { count } = await this.prisma.support.updateMany({
      where: { id, victimConfirmedReceiptAt: null },
      data: { victimConfirmedReceiptAt: now },
    });

    if (count > 0) {
      this.emitAudit({
        userId: user.id,
        targetUserId: support.userId,
        actorType,
        action: AuditEventEnum.SUPPORT_RECEIPT_CONFIRMED,
        entity: 'Support',
        entityId: support.id,
        diff: { result: 'success', victimConfirmedReceiptAt: now.toISOString() },
        metadata: { victimProfileId: support.victimProfileId },
      });
    }

    const fresh = await this.prisma.support.findUniqueOrThrow({
      where: { id },
      select: { id: true, status: true, victimConfirmedReceiptAt: true },
    });
    return fresh;
  }

  // Cancellable by an admin, or by the supporter for their own non-financial offer while PENDING.
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

    // A paid financial support cannot be cancelled by the supporter. A refund is a separate admin action.
    if (!isAdmin && support.type === SupportType.FINANCIAL && support.status !== SupportStatus.PENDING) {
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
          reason: 'cannot_cancel_financial_support',
          currentStatus: support.status,
        },
        metadata: { victimProfileId: support.victimProfileId },
      });
      throw new BadRequestException('cannot_cancel_financial_support');
    }

    // A supporter can only cancel a non-financial offer while it is still PENDING.
    if (
      !isAdmin &&
      support.status !== SupportStatus.PENDING &&
      support.status !== SupportStatus.CANCELLED
    ) {
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

  // Cancels non-financial offers nobody answered in time, and tells the supporter.
  @Cron(CronExpression.EVERY_HOUR)
  async expireStaleOffers(): Promise<void> {
    const configured = Number(
      this.config.get<number>('support.offerExpiryDays', DEFAULT_OFFER_EXPIRY_DAYS),
    );
    const expiryDays =
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_OFFER_EXPIRY_DAYS;
    const cutoff = new Date(Date.now() - expiryDays * 86_400_000);

    const stale = await this.prisma.support.findMany({
      where: {
        type: SupportType.NON_FINANCIAL,
        status: SupportStatus.PENDING,
        createdAt: { lt: cutoff },
      },
      select: { id: true, userId: true, victimProfileId: true, transferReference: true },
      take: 200,
    });

    for (const support of stale) {
      try {
        const { count } = await this.prisma.support.updateMany({
          where: { id: support.id, status: SupportStatus.PENDING },
          data: { status: SupportStatus.CANCELLED },
        });
        if (count === 0) continue;

        this.emitAudit({
          actorType: ActorType.SYSTEM,
          ...(support.userId ? { targetUserId: support.userId } : {}),
          action: AuditEventEnum.SUPPORT_EXPIRED,
          severity: AuditSeverity.INFO,
          entity: 'Support',
          entityId: support.id,
          entityLabel: this.buildSupportLabel(support),
          reason: 'unanswered_offer_expired',
          diff: {
            result: 'success',
            previousStatus: SupportStatus.PENDING,
            currentStatus: SupportStatus.CANCELLED,
          },
          metadata: { victimProfileId: support.victimProfileId, expiryDays },
        });

        if (support.userId) {
          this.eventEmitter.emit(NotificationEventEnum.SUPPORT_OFFER_EXPIRED, {
            userId: support.userId,
            supportId: support.id,
            expiryDays,
          });
        }
      } catch (error) {
        this.logger.error(
          `Could not expire support ${support.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}

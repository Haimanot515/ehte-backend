import {
  BadRequestException,
  ForbiddenException,
  HttpException,
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
  SupportAttachmentAccessAction,
  SupportCategory,
  SupportDisputeOutcome,
  SupportDisputeReason,
  SupportDisputeSide,
  SupportDisputeStatus,
  SupportExportJobStatus,
  SupportFlagReason,
  SupportMessageAuthor,
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

import {
  AssignSupportReviewerDto,
  BulkExpireSupportDto,
  BulkSupportIdsDto,
  BulkSupportReasonDto,
  CreateSupportDisputeDto,
  CreateSupportDto,
  CreateSupportMessageDto,
  DeclineIncomingSupportDto,
  FlagSupportDto,
  ListSupportDisputesQueryDto,
  ListSupportFlagsQueryDto,
  ListSupportQueryDto,
  ListUnreadSupportQueryDto,
  ReadAllSupportDto,
  ReassignSupportProfileDto,
  ResolveSupportDisputeDto,
  RestrictSupporterDto,
  SendThanksDto,
  SupportExportQueryDto,
  SupportPagedQueryDto,
  SupportReasonDto,
  SupportSearchQueryDto,
  SupportStatsInterval,
  SupportStatsQueryDto,
  SupportStatsTimelineQueryDto,
  UpdateSupportDto,
  UploadSupportProofDto,
} from '../dto/support.dto';

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

// ── Constants for the case-management endpoints (SP-01 .. SP-68) ──

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ACTIVE_ATTACHMENTS = 10;
const EXPORT_SYNC_ROW_CAP = 5_000;
const EXPORT_JOB_ROW_CAP = 50_000;
const EXPORT_JOB_TTL_HOURS = 24;
const MAX_ACTIVE_EXPORT_JOBS_PER_ADMIN = 2;
const MARK_ALL_READ_BATCH = 1_000;
const MARK_ALL_READ_MAX_BATCHES = 10;
const BULK_EXPIRE_MAX = 500;

// Repeat-dispute rule: this many disputes, or at least one confirmed non-delivery.
const REPEAT_DISPUTE_THRESHOLD = 2;

const SUPPORTER_DISPUTE_REASONS: SupportDisputeReason[] = [
  SupportDisputeReason.MISMATCH,
  SupportDisputeReason.RECIPIENT_DENIES_RECEIPT,
  SupportDisputeReason.OTHER,
];
const RECIPIENT_DISPUTE_REASONS: SupportDisputeReason[] = [
  SupportDisputeReason.NOT_DELIVERED,
  SupportDisputeReason.MISMATCH,
  SupportDisputeReason.OTHER,
];

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  gif: 'image/gif',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};

// Admin list rows: supporter contact is included because the team follows up off the platform.
const adminListSelect = (adminId: string) =>
  ({
    ...SUPPORT_OWNER_SELECT,
    assignedReviewerId: true,
    user: { select: { id: true, name: true, phone: true, email: true } },
    victimProfile: { select: { id: true, name: true, claimedByUserId: true } },
    adminReads: { where: { adminId }, select: { adminId: true } },
  }) satisfies Prisma.SupportSelect;

// What the supporter sees about their own attachments.
const ATTACHMENT_OWNER_SELECT = {
  id: true,
  key: true,
  kind: true,
  mimeType: true,
  note: true,
  createdAt: true,
} satisfies Prisma.SupportAttachmentSelect;

const DISPUTE_SELECT = {
  id: true,
  supportId: true,
  side: true,
  reason: true,
  details: true,
  status: true,
  outcome: true,
  resolutionReason: true,
  resolvedAt: true,
  createdAt: true,
} satisfies Prisma.SupportDisputeSelect;

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
      supporterName: support.anonymous || !support.user?.name ? ANONYMOUS_LABEL : support.user.name,
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
  private isTransitionAllowed(from: SupportStatus, to: SupportStatus, type: SupportType): boolean {
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
    const targetUserFields = actor.id === support.userId ? {} : { targetUserId: support.userId };

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

    if (
      !support.victimProfile.claimedByUserId ||
      support.victimProfile.claimedByUserId !== user.id
    ) {
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
      return {
        id: support.id,
        status: support.status,
        victimConfirmedReceiptAt: support.victimConfirmedReceiptAt,
      };
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
    if (
      !isAdmin &&
      support.type === SupportType.FINANCIAL &&
      support.status !== SupportStatus.PENDING
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

  // ───────────────────────────── shared helpers ─────────────────────────────

  private static readonly INCOMING_SELECT = {
    id: true,
    status: true,
    categories: true,
    message: true,
    anonymous: true,
    createdAt: true,
    victimConfirmedReceiptAt: true,
    thanksSentAt: true,
    declinedAt: true,
    recipientOpenedAt: true,
    victimProfile: { select: { id: true, name: true } },
    user: { select: { name: true } },
  } satisfies Prisma.SupportSelect;

  private paging(q?: { page?: number; limit?: number }) {
    const page = q?.page ?? 1;
    const limit = q?.limit ?? 20;
    return { page, limit, skip: (page - 1) * limit, take: limit };
  }

  // Raw SQL returns bigint for COUNT(); the API returns plain numbers.
  private num(v: unknown): number {
    if (v === null || v === undefined) return 0;
    return typeof v === 'bigint' ? Number(v) : Number(v);
  }

  private toJson(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    return v === null || v === undefined ? Prisma.JsonNull : (v as Prisma.InputJsonValue);
  }

  private httpMessage(e: unknown): string {
    if (e instanceof HttpException) {
      const r = e.getResponse();
      if (typeof r === 'string') return r;
      const m = (r as { message?: string | string[] }).message;
      return Array.isArray(m) ? m.join(', ') : (m ?? e.message);
    }
    return 'unexpected_error';
  }

  private emitSupportAudit(
    actor: CurrentUserDto,
    action: AuditEventEnum,
    support: { id: string; userId?: string | null; transferReference?: string | null },
    extra: Partial<AuditEventPayload> & Record<string, unknown> = {},
  ): void {
    this.emitAudit({
      userId: actor.id,
      ...(support.userId && support.userId !== actor.id ? { targetUserId: support.userId } : {}),
      actorType: resolveActorType(this.getRoles(actor)),
      action,
      entity: 'Support',
      entityId: support.id,
      entityLabel: this.buildSupportLabel({
        id: support.id,
        transferReference: support.transferReference ?? null,
      }),
      ...extra,
    } as AuditEventPayload);
  }

  private async findSupportOrThrow(id: string) {
    const support = await this.prisma.support.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        victimProfileId: true,
        transferReference: true,
        victimProfile: { select: { claimedByUserId: true } },
      },
    });
    if (!support) throw new NotFoundException('support_not_found');
    return support;
  }

  private async findOwnedOrThrow(id: string, user: CurrentUserDto) {
    const support = await this.findSupportOrThrow(id);
    if (support.userId !== user.id) throw new ForbiddenException('not_allowed_to_modify_support');
    return support;
  }

  // Owner or admin may read; anyone else is refused.
  private async findReadableOrThrow(id: string, user: CurrentUserDto) {
    const support = await this.findSupportOrThrow(id);
    if (support.userId !== user.id && !this.isAdmin(user)) {
      throw new ForbiddenException('not_allowed_to_view_support');
    }
    return support;
  }

  // The user who claimed the victim profile, and nobody else.
  private async findAsRecipientOrThrow(id: string, user: CurrentUserDto, forbiddenCode: string) {
    const support = await this.findSupportOrThrow(id);
    const claimant = support.victimProfile.claimedByUserId;
    if (!claimant || claimant !== user.id) throw new ForbiddenException(forbiddenCode);
    return support;
  }

  // A new supporter message or proof file puts the offer back in every admin's unread list.
  private async markUnreadForAllAdmins(supportId: string): Promise<void> {
    await this.prisma.supportAdminRead.deleteMany({ where: { supportId } });
  }

  private async touchSupporterUpdate(supportId: string): Promise<void> {
    await this.prisma.support.updateMany({
      where: { id: supportId },
      data: { lastUpdateAt: new Date() },
    });
  }

  private mapAdminRow<T extends { adminReads: unknown[] }>(row: T) {
    const { adminReads, ...rest } = row;
    return { ...rest, isRead: adminReads.length > 0 };
  }

  private csvCell(v: unknown): string {
    if (v === null || v === undefined) return '';
    let s: string;
    if (v instanceof Date) s = v.toISOString();
    else if (Prisma.Decimal.isDecimal(v)) s = (v as Prisma.Decimal).toFixed(2);
    else if (Array.isArray(v)) s = v.join('|');
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    // Stops a spreadsheet from running a cell as a formula.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  @OnEvent(AuditEventEnum.SUPPORT_CONFIRMED)
  async onSupportConfirmed(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.CONFIRMED);
  }

  @OnEvent(AuditEventEnum.SUPPORT_COMPLETED)
  async onSupportCompleted(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.COMPLETED);
  }

  @OnEvent(AuditEventEnum.SUPPORT_CANCELLED)
  async onSupportCancelled(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.CANCELLED);
  }

  @OnEvent(AuditEventEnum.SUPPORT_EXPIRED)
  async onSupportExpired(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.CANCELLED);
  }

  @OnEvent(AuditEventEnum.SUPPORT_FAILED)
  async onSupportFailed(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.FAILED);
  }

  @OnEvent(AuditEventEnum.SUPPORT_REOPENED)
  async onSupportReopened(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.PENDING);
  }

  private async trackStatusChange(p: AuditEventPayload, to: SupportStatus): Promise<void> {
    try {
      if (p.outcome && p.outcome !== AuditOutcome.SUCCESS) return;
      if (!p.entityId) return;

      const diff = (p.diff ?? {}) as Record<string, unknown>;
      const prev = diff.previousStatus as SupportStatus | undefined;
      const fromStatus =
        prev && (Object.values(SupportStatus) as string[]).includes(prev) ? prev : null;
      const now = new Date();

      const stamp: Prisma.SupportUncheckedUpdateManyInput = {
        ...(to === SupportStatus.CONFIRMED ? { confirmedAt: now } : {}),
        ...(to === SupportStatus.COMPLETED ? { completedAt: now } : {}),
        ...(to === SupportStatus.CANCELLED ? { cancelledAt: now } : {}),
        ...(to === SupportStatus.FAILED ? { failedAt: now } : {}),
        ...(to === SupportStatus.PENDING
          ? { confirmedAt: null, completedAt: null, cancelledAt: null, failedAt: null }
          : {}),
        // targetUserId is only set when someone other than the supporter made the change.
        ...(p.targetUserId ? { lastUpdateAt: now } : {}),
      };

      await this.prisma.$transaction([
        this.prisma.supportStatusEvent.create({
          data: {
            supportId: p.entityId,
            fromStatus,
            toStatus: to,
            actorUserId: p.userId ?? null,
            actorType: p.actorType ?? null,
            reason: p.reason ?? null,
          },
        }),
        this.prisma.support.updateMany({ where: { id: p.entityId }, data: stamp }),
      ]);
    } catch (error) {
      this.logger.error(
        `Could not record status change for support ${p.entityId ?? '?'}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  // ──────────────────── supporter restrictions (used by SP-38/39) ────────────────────

  private activeRestrictionWhere(userId: string): Prisma.SupporterRestrictionWhereInput {
    return {
      userId,
      liftedAt: null,
      OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
    };
  }

  async isSupporterRestricted(userId: string): Promise<boolean> {
    const count = await this.prisma.supporterRestriction.count({
      where: this.activeRestrictionWhere(userId),
    });
    return count > 0;
  }

  // Call this at the top of create() to enforce a restriction. See the notes that came with this file.
  async assertSupporterNotRestricted(userId: string): Promise<void> {
    if (await this.isSupporterRestricted(userId)) {
      throw new ForbiddenException('supporter_restricted');
    }
  }

  // ═══════════════════════════ supporter side (SP-01 .. SP-12) ═══════════════════════════

  // SP-01
  async updateMyOffer(id: string, user: CurrentUserDto, data: UpdateSupportDto) {
    const support = await this.prisma.support.findUnique({
      where: { id },
      select: SUPPORT_OWNER_SELECT,
    });
    if (!support) throw new NotFoundException('support_not_found');
    if (support.userId !== user.id) throw new ForbiddenException('not_allowed_to_modify_support');
    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('only_non_financial_offers_can_be_edited');
    }
    if (support.status !== SupportStatus.PENDING) {
      throw new BadRequestException('only_pending_offers_can_be_edited');
    }

    const nextCategories = data.categories ? [...new Set(data.categories)] : support.categories;
    const nextMessage =
      data.message !== undefined ? data.message.trim() || null : (support.message ?? null);

    if (nextCategories.length === 0) throw new BadRequestException('support_categories_required');
    if (nextCategories.includes(SupportCategory.OTHER) && !nextMessage) {
      throw new BadRequestException('support_note_required_for_other');
    }

    const nextAnonymous = data.anonymous ?? support.anonymous;
    const nextContact = data.contactMayBeShared ?? support.contactMayBeShared;

    const sameCategories =
      [...nextCategories].sort().join(',') === [...support.categories].sort().join(',');

    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
    if (!sameCategories) {
      changes.push({ field: 'categories', oldValue: support.categories, newValue: nextCategories });
    }
    if (nextMessage !== (support.message ?? null)) {
      changes.push({ field: 'message', oldValue: support.message ?? null, newValue: nextMessage });
    }
    if (nextAnonymous !== support.anonymous) {
      changes.push({ field: 'anonymous', oldValue: support.anonymous, newValue: nextAnonymous });
    }
    if (nextContact !== support.contactMayBeShared) {
      changes.push({
        field: 'contactMayBeShared',
        oldValue: support.contactMayBeShared,
        newValue: nextContact,
      });
    }

    if (changes.length === 0) return support;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.support.updateMany({
        where: { id, userId: user.id, status: SupportStatus.PENDING },
        data: {
          categories: nextCategories,
          message: nextMessage,
          anonymous: nextAnonymous,
          contactMayBeShared: nextContact,
        },
      });
      if (result.count === 0) return null;

      await tx.supportRevision.createMany({
        data: changes.map((c) => ({
          supportId: id,
          actorUserId: user.id,
          field: c.field,
          oldValue: this.toJson(c.oldValue),
          newValue: this.toJson(c.newValue),
        })),
      });
      // The team should see that the offer changed.
      await tx.supportAdminRead.deleteMany({ where: { supportId: id } });

      return tx.support.findUniqueOrThrow({ where: { id }, select: SUPPORT_OWNER_SELECT });
    });

    if (!updated) throw new BadRequestException('only_pending_offers_can_be_edited');

    this.emitSupportAudit(user, AuditEventEnum.SUPPORT_UPDATED, support, {
      diff: { result: 'success', fields: changes.map((c) => c.field) },
      metadata: { victimProfileId: support.victimProfileId },
    });

    return updated;
  }

  // SP-02. Files are already stored by @MediaUpload; the DTO arrays hold their keys.
  async uploadProof(id: string, user: CurrentUserDto, data: UploadSupportProofDto) {
    const support = await this.findOwnedOrThrow(id, user);

    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('proof_is_for_non_financial_support');
    }
    if (support.status !== SupportStatus.PENDING && support.status !== SupportStatus.CONFIRMED) {
      throw new BadRequestException('support_not_open_for_proof');
    }

    const incoming = new Map<string, string>();
    for (const [kind, keys] of [
      ['photo', data.photo],
      ['pdf', data.pdf],
      ['document', data.document],
    ] as const) {
      for (const key of keys ?? []) {
        const trimmed = key.trim();
        if (trimmed && !incoming.has(trimmed)) incoming.set(trimmed, kind);
      }
    }
    if (incoming.size === 0) throw new BadRequestException('proof_file_required');

    const existing = await this.prisma.supportAttachment.findMany({
      where: { supportId: id, removedAt: null },
      select: { key: true },
    });
    const existingKeys = new Set(existing.map((a) => a.key));
    const fresh = [...incoming.entries()].filter(([key]) => !existingKeys.has(key));

    if (existing.length + fresh.length > MAX_ACTIVE_ATTACHMENTS) {
      throw new BadRequestException('too_many_proof_files');
    }

    const note = data.note?.trim() || null;
    const created = await this.prisma.$transaction(
      fresh.map(([key, kind]) => {
        const ext = key.split('.').pop()?.toLowerCase() ?? '';
        return this.prisma.supportAttachment.create({
          data: {
            supportId: id,
            key,
            kind,
            mimeType: MIME_BY_EXTENSION[ext] ?? null,
            note,
            uploadedByUserId: user.id,
          },
          select: ATTACHMENT_OWNER_SELECT,
        });
      }),
    );

    if (created.length > 0) {
      await this.markUnreadForAllAdmins(id);
      this.emitSupportAudit(user, AuditEventEnum.SUPPORT_PROOF_UPLOADED, support, {
        diff: { result: 'success', files: created.length },
        metadata: { victimProfileId: support.victimProfileId, kinds: created.map((c) => c.kind) },
      });
    }

    return { supportId: id, added: created.length, attachments: created };
  }

  // SP-03. Only while the offer is still PENDING.
  async removeProof(id: string, key: string, user: CurrentUserDto) {
    const support = await this.findOwnedOrThrow(id, user);
    if (support.status !== SupportStatus.PENDING) {
      throw new BadRequestException('proof_can_only_be_removed_while_pending');
    }

    const { count } = await this.prisma.supportAttachment.updateMany({
      where: { supportId: id, key, removedAt: null },
      data: {
        removedAt: new Date(),
        removedByUserId: user.id,
        removalReason: 'removed_by_supporter',
      },
    });
    if (count === 0) throw new NotFoundException('proof_not_found');

    this.emitSupportAudit(user, AuditEventEnum.SUPPORT_PROOF_REMOVED, support, {
      diff: { result: 'success', key },
    });
    return { supportId: id, key, removed: true };
  }

  // SP-06. Status history only: no internal reasons, no admin names.
  async getTimeline(id: string, user: CurrentUserDto) {
    const support = await this.findReadableOrThrow(id, user);
    const [head, events] = await Promise.all([
      this.prisma.support.findUniqueOrThrow({
        where: { id },
        select: { status: true, createdAt: true },
      }),
      this.prisma.supportStatusEvent.findMany({
        where: { supportId: id },
        orderBy: { createdAt: 'asc' },
        select: { fromStatus: true, toStatus: true, actorType: true, createdAt: true },
        take: 200,
      }),
    ]);

    const by = (t: ActorType | null) =>
      t === ActorType.SYSTEM
        ? 'SYSTEM'
        : t === ActorType.ADMIN || t === ActorType.SUPER_ADMIN
          ? 'STAFF'
          : 'PARTICIPANT';

    return {
      supportId: support.id,
      currentStatus: head.status,
      timeline: [
        {
          status: SupportStatus.PENDING,
          previousStatus: null,
          at: head.createdAt,
          by: 'PARTICIPANT',
          event: 'CREATED',
        },
        ...events.map((e) => ({
          status: e.toStatus,
          previousStatus: e.fromStatus,
          at: e.createdAt,
          by: by(e.actorType),
          event: 'STATUS_CHANGED',
        })),
      ],
    };
  }

  // SP-07
  async createDispute(id: string, user: CurrentUserDto, data: CreateSupportDisputeDto) {
    if (!SUPPORTER_DISPUTE_REASONS.includes(data.reason)) {
      throw new BadRequestException('dispute_reason_not_allowed_for_supporter');
    }
    const support = await this.findOwnedOrThrow(id, user);
    return this.openDispute(support, user, SupportDisputeSide.SUPPORTER, data);
  }

  private async openDispute(
    support: Awaited<ReturnType<SupportService['findSupportOrThrow']>>,
    user: CurrentUserDto,
    side: SupportDisputeSide,
    data: CreateSupportDisputeDto,
  ) {
    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('disputes_are_for_non_financial_support');
    }
    if (!COUNTED_STATUSES.includes(support.status)) {
      throw new BadRequestException('support_not_ready_for_dispute');
    }

    const open = await this.prisma.supportDispute.count({
      where: { supportId: support.id, side, status: SupportDisputeStatus.OPEN },
    });
    if (open > 0) throw new BadRequestException('dispute_already_open');

    const dispute = await this.prisma.supportDispute.create({
      data: {
        supportId: support.id,
        supporterUserId: support.userId,
        raisedByUserId: user.id,
        side,
        reason: data.reason,
        details: data.details.trim(),
      },
      select: DISPUTE_SELECT,
    });

    await this.markUnreadForAllAdmins(support.id);
    if (side === SupportDisputeSide.RECIPIENT) await this.touchSupporterUpdate(support.id);

    this.emitSupportAudit(user, AuditEventEnum.SUPPORT_DISPUTE_CREATED, support, {
      severity: AuditSeverity.WARNING,
      diff: { result: 'success', disputeId: dispute.id, side, reason: data.reason },
      metadata: { victimProfileId: support.victimProfileId },
    });

    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_DISPUTE_OPENED, {
      supportId: support.id,
      disputeId: dispute.id,
      side,
      supporterUserId: support.userId,
      victimProfileId: support.victimProfileId,
    });

    return dispute;
  }

  // SP-08
  async sendMessage(id: string, user: CurrentUserDto, data: CreateSupportMessageDto) {
    const support = await this.findOwnedOrThrow(id, user);
    const body = data.body.trim();
    if (!body) throw new BadRequestException('message_body_required');

    const message = await this.prisma.supportMessage.create({
      data: {
        supportId: id,
        authorUserId: user.id,
        authorType: SupportMessageAuthor.SUPPORTER,
        body,
      },
      select: { id: true, authorType: true, body: true, createdAt: true },
    });

    await this.markUnreadForAllAdmins(id);

    this.emitSupportAudit(user, AuditEventEnum.SUPPORT_MESSAGE_SENT, support, {
      diff: { result: 'success', messageId: message.id, authorType: message.authorType },
    });
    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_MESSAGE_RECEIVED, {
      supportId: id,
      messageId: message.id,
      supporterUserId: support.userId,
    });

    return message;
  }

  // SP-09. The supporter and the staff see the same thread.
  async getMessages(id: string, user: CurrentUserDto, query: SupportPagedQueryDto) {
    await this.findReadableOrThrow(id, user);
    const { page, limit, skip, take } = this.paging(query);

    const [total, items] = await this.prisma.$transaction([
      this.prisma.supportMessage.count({ where: { supportId: id } }),
      this.prisma.supportMessage.findMany({
        where: { supportId: id },
        orderBy: { createdAt: 'asc' },
        skip,
        take,
        select: { id: true, authorType: true, body: true, createdAt: true },
      }),
    ]);
    return { total, page, limit, items };
  }

  private unseenWhere(userId: string): Prisma.SupportWhereInput {
    return {
      userId,
      lastUpdateAt: { not: null },
      OR: [
        { supporterSeenAt: null },
        { supporterSeenAt: { lt: this.prisma.support.fields.lastUpdateAt } },
      ],
    };
  }

  // SP-04
  async getMySupportSummary(user: CurrentUserDto) {
    const [byStatus, byType] = await Promise.all([
      this.prisma.support.groupBy({
        by: ['status'],
        where: { userId: user.id },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.support.groupBy({
        by: ['type'],
        where: { userId: user.id },
        _count: { _all: true },
        orderBy: { type: 'asc' },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(SupportStatus).map((s) => [s, 0]),
    ) as Record<SupportStatus, number>;
    for (const row of byStatus)
      statusCounts[row.status] = (row._count as { _all?: number })?._all ?? 0;

    const typeCounts = Object.fromEntries(Object.values(SupportType).map((t) => [t, 0])) as Record<
      SupportType,
      number
    >;
    for (const row of byType) typeCounts[row.type] = (row._count as { _all?: number })?._all ?? 0;

    return {
      total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      byStatus: statusCounts,
      byType: typeCounts,
    };
  }

  // SP-05
  async getMySupportImpact(user: CurrentUserDto) {
    const [completed, inProgress, profiles, financial] = await Promise.all([
      this.prisma.support.count({
        where: {
          userId: user.id,
          type: SupportType.NON_FINANCIAL,
          status: SupportStatus.COMPLETED,
        },
      }),
      this.prisma.support.count({
        where: {
          userId: user.id,
          type: SupportType.NON_FINANCIAL,
          status: { in: [SupportStatus.PENDING, SupportStatus.CONFIRMED] },
        },
      }),
      this.prisma.support.groupBy({
        by: ['victimProfileId'],
        where: { userId: user.id, status: { in: COUNTED_STATUSES } },
        orderBy: { victimProfileId: 'asc' },
      }),
      this.prisma.support.aggregate({
        where: { userId: user.id, type: SupportType.FINANCIAL, status: { in: COUNTED_STATUSES } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    return {
      offersCompleted: completed,
      offersInProgress: inProgress,
      profilesHelped: profiles.length,
      financialContributions: {
        count: financial._count._all,
        totalAmount: Number(financial._sum.amount ?? 0),
      },
    };
  }

  // SP-10
  async countMyUnreadUpdates(user: CurrentUserDto) {
    const count = await this.prisma.support.count({ where: this.unseenWhere(user.id) });
    return { count };
  }

  // SP-11
  async markSeen(id: string, user: CurrentUserDto) {
    await this.findOwnedOrThrow(id, user);
    const supporterSeenAt = new Date();
    await this.prisma.support.updateMany({
      where: { id, userId: user.id },
      data: { supporterSeenAt },
    });
    return { id, supporterSeenAt };
  }

  // SP-12
  async markAllMineSeen(user: CurrentUserDto) {
    const { count } = await this.prisma.support.updateMany({
      where: this.unseenWhere(user.id),
      data: { supporterSeenAt: new Date() },
    });
    return { marked: count };
  }

  private incomingWhere(userId: string): Prisma.SupportWhereInput {
    return {
      type: SupportType.NON_FINANCIAL,
      victimProfile: { claimedByUserId: userId },
      OR: [{ status: { in: COUNTED_STATUSES } }, { declinedAt: { not: null } }],
    };
  }

  private mapIncoming(
    s: Prisma.SupportGetPayload<{ select: typeof SupportService.INCOMING_SELECT }>,
  ) {
    return {
      id: s.id,
      status: s.status,
      categories: s.categories,
      note: s.message,
      supporterName: s.anonymous || !s.user?.name ? ANONYMOUS_LABEL : s.user.name,
      victimProfile: s.victimProfile,
      receiptConfirmedAt: s.victimConfirmedReceiptAt,
      thanksSentAt: s.thanksSentAt,
      declinedAt: s.declinedAt,
      opened: s.recipientOpenedAt !== null,
      createdAt: s.createdAt,
    };
  }

  // SP-13
  async findIncoming(user: CurrentUserDto, query: SupportPagedQueryDto) {
    const { page, limit, skip, take } = this.paging(query);
    const where = this.incomingWhere(user.id);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.support.count({ where }),
      this.prisma.support.findMany({
        where,
        select: SupportService.INCOMING_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);
    return { total, page, limit, items: rows.map((r) => this.mapIncoming(r)) };
  }

  // SP-18
  async getIncomingSummary(user: CurrentUserDto) {
    const where = this.incomingWhere(user.id);
    const [byStatus, declined, awaitingReceipt] = await Promise.all([
      this.prisma.support.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.support.count({ where: { ...where, declinedAt: { not: null } } }),
      this.prisma.support.count({
        where: { ...where, status: { in: COUNTED_STATUSES }, victimConfirmedReceiptAt: null },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(SupportStatus).map((s) => [s, 0]),
    ) as Record<SupportStatus, number>;
    for (const row of byStatus)
      statusCounts[row.status] = (row._count as { _all?: number })?._all ?? 0;

    return {
      total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      byStatus: statusCounts,
      declined,
      awaitingReceiptConfirmation: awaitingReceipt,
    };
  }

  // SP-19
  async countIncomingUnread(user: CurrentUserDto) {
    const count = await this.prisma.support.count({
      where: {
        ...this.incomingWhere(user.id),
        status: { in: COUNTED_STATUSES },
        recipientOpenedAt: null,
      },
    });
    return { count };
  }

  // SP-14. Opening an offer marks it as opened.
  async findOneIncoming(id: string, user: CurrentUserDto) {
    const row = await this.prisma.support.findFirst({
      where: { id, ...this.incomingWhere(user.id) },
      select: SupportService.INCOMING_SELECT,
    });
    if (!row) throw new NotFoundException('support_not_found');

    if (!row.recipientOpenedAt) {
      const now = new Date();
      await this.prisma.support.updateMany({
        where: { id, recipientOpenedAt: null },
        data: { recipientOpenedAt: now },
      });
      row.recipientOpenedAt = now;
    }
    return this.mapIncoming(row);
  }

  // SP-15. The offer is cancelled; the supporter is told, the stated reason stays with the team.
  async declineIncoming(id: string, user: CurrentUserDto, data: DeclineIncomingSupportDto) {
    const support = await this.findAsRecipientOrThrow(id, user, 'not_allowed_to_decline_offer');
    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('only_non_financial_offers_can_be_declined');
    }
    if (support.status !== SupportStatus.CONFIRMED) {
      throw new BadRequestException('only_confirmed_offers_can_be_declined');
    }

    const reason = data.reason.trim();
    const cancelled = await this.updateStatus(
      id,
      SupportStatus.CANCELLED,
      user,
      `declined_by_recipient: ${reason}`,
    );

    await this.prisma.support.updateMany({
      where: { id, declinedAt: null },
      data: { declinedAt: new Date(), declineReason: reason, declinedByUserId: user.id },
    });

    this.emitSupportAudit(user, AuditEventEnum.SUPPORT_DECLINED, support, {
      reason,
      diff: { result: 'success', currentStatus: cancelled.status },
      metadata: { victimProfileId: support.victimProfileId },
    });
    if (support.userId) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_OFFER_DECLINED, {
        userId: support.userId,
        supportId: id,
        victimProfileId: support.victimProfileId,
      });
    }

    return { id, status: cancelled.status, declined: true };
  }

  // SP-16
  async disputeReceipt(id: string, user: CurrentUserDto, data: CreateSupportDisputeDto) {
    if (!RECIPIENT_DISPUTE_REASONS.includes(data.reason)) {
      throw new BadRequestException('dispute_reason_not_allowed_for_recipient');
    }
    const support = await this.findAsRecipientOrThrow(id, user, 'not_allowed_to_dispute_receipt');
    return this.openDispute(support, user, SupportDisputeSide.RECIPIENT, data);
  }

  // SP-17. One thank-you per offer. The text travels in the notification event.
  async sendThanks(id: string, user: CurrentUserDto, data: SendThanksDto) {
    const support = await this.findAsRecipientOrThrow(id, user, 'not_allowed_to_send_thanks');
    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('thanks_are_for_non_financial_support');
    }
    if (!COUNTED_STATUSES.includes(support.status)) {
      throw new BadRequestException('support_not_ready_for_thanks');
    }

    const now = new Date();
    const { count } = await this.prisma.support.updateMany({
      where: { id, thanksSentAt: null },
      data: { thanksSentAt: now, lastUpdateAt: now },
    });
    if (count === 0) throw new BadRequestException('thanks_already_sent');

    const message = data.message?.trim() || null;
    this.emitSupportAudit(user, AuditEventEnum.SUPPORT_THANKS_SENT, support, {
      diff: { result: 'success', hasMessage: Boolean(message) },
    });
    if (support.userId) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_THANKS_RECEIVED, {
        userId: support.userId,
        supportId: id,
        message,
      });
    }
    return { id, thanksSentAt: now };
  }

  // ═════════════════════ admin: read state and counts (SP-20 .. SP-27) ═════════════════════

  // SP-20
  async markRead(id: string, admin: CurrentUserDto) {
    await this.findSupportOrThrow(id);
    await this.prisma.supportAdminRead.upsert({
      where: { supportId_adminId: { supportId: id, adminId: admin.id } },
      create: { supportId: id, adminId: admin.id },
      update: {},
    });
    return { id, read: true };
  }

  // SP-21
  async markUnread(id: string, admin: CurrentUserDto) {
    await this.findSupportOrThrow(id);
    await this.prisma.supportAdminRead.deleteMany({ where: { supportId: id, adminId: admin.id } });
    return { id, read: false };
  }

  // SP-22
  async bulkMarkRead(admin: CurrentUserDto, data: BulkSupportIdsDto) {
    const ids = [...new Set(data.ids)];
    const found = await this.prisma.support.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const { count } = await this.prisma.supportAdminRead.createMany({
      data: found.map((s) => ({ supportId: s.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    return { requested: ids.length, matched: found.length, marked: count };
  }

  // SP-23
  async bulkMarkUnread(admin: CurrentUserDto, data: BulkSupportIdsDto) {
    const ids = [...new Set(data.ids)];
    const { count } = await this.prisma.supportAdminRead.deleteMany({
      where: { adminId: admin.id, supportId: { in: ids } },
    });
    return { requested: ids.length, marked: count };
  }

  // SP-24. Capped per call so one request cannot lock a huge table; call again if `more` is true.
  async markAllRead(admin: CurrentUserDto, data: ReadAllSupportDto) {
    const where: Prisma.SupportWhereInput = {
      ...(data.status ? { status: data.status } : {}),
      ...(data.type ? { type: data.type } : {}),
      adminReads: { none: { adminId: admin.id } },
    };

    let marked = 0;
    let more = false;
    for (let i = 0; i < MARK_ALL_READ_MAX_BATCHES; i++) {
      const batch = await this.prisma.support.findMany({
        where,
        select: { id: true },
        take: MARK_ALL_READ_BATCH,
      });
      if (batch.length === 0) break;
      const { count } = await this.prisma.supportAdminRead.createMany({
        data: batch.map((s) => ({ supportId: s.id, adminId: admin.id })),
        skipDuplicates: true,
      });
      marked += count;
      if (batch.length < MARK_ALL_READ_BATCH) break;
      if (i === MARK_ALL_READ_MAX_BATCHES - 1) more = true;
    }
    return { marked, more };
  }

  // SP-25
  async findUnread(admin: CurrentUserDto, query: ListUnreadSupportQueryDto) {
    const { page, limit, skip, take } = this.paging(query);
    const where: Prisma.SupportWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      adminReads: { none: { adminId: admin.id } },
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.support.count({ where }),
      this.prisma.support.findMany({
        where,
        select: adminListSelect(admin.id),
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);
    return { total, page, limit, items: rows.map((r) => this.mapAdminRow(r)) };
  }

  // SP-26
  async countUnread(admin: CurrentUserDto) {
    const count = await this.prisma.support.count({
      where: { adminReads: { none: { adminId: admin.id } } },
    });
    return { count };
  }

  // SP-27
  async getReadCounts(admin: CurrentUserDto) {
    const [total, read] = await Promise.all([
      this.prisma.support.count(),
      this.prisma.support.count({ where: { adminReads: { some: { adminId: admin.id } } } }),
    ]);
    return { total, read, unread: total - read };
  }

  // ═════════════════ admin: supporters and profiles (SP-28 .. SP-33) ═════════════════

  // SP-28
  async findSupportersSummary(admin: CurrentUserDto, query: SupportPagedQueryDto) {
    const { page, limit, skip, take } = this.paging(query);

    const [items, totalRow] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          supporterId: string;
          name: string | null;
          total: bigint;
          read: bigint;
          unread: bigint;
          completed: bigint;
          disputed: bigint;
          lastOfferAt: Date;
        }>
      >(Prisma.sql`
        SELECT s."userId" AS "supporterId",
               u."name" AS "name",
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE r."supportId" IS NOT NULL) AS read,
               COUNT(*) FILTER (WHERE r."supportId" IS NULL) AS unread,
               COUNT(*) FILTER (WHERE s."status" = 'COMPLETED') AS completed,
               (SELECT COUNT(*) FROM "support_dispute" d WHERE d."supporterUserId" = s."userId") AS disputed,
               MAX(s."createdAt") AS "lastOfferAt"
        FROM "Support" s
        LEFT JOIN "user" u ON u."id" = s."userId"
        LEFT JOIN "support_admin_read" r ON r."supportId" = s."id" AND r."adminId" = ${admin.id}
        WHERE s."userId" IS NOT NULL
        GROUP BY s."userId", u."name"
        ORDER BY MAX(s."createdAt") DESC
        LIMIT ${take} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "userId") AS count FROM "Support" WHERE "userId" IS NOT NULL
      `),
    ]);

    return {
      total: this.num(totalRow[0]?.count),
      page,
      limit,
      items: items.map((r) => ({
        supporterId: r.supporterId,
        name: r.name,
        total: this.num(r.total),
        read: this.num(r.read),
        unread: this.num(r.unread),
        completed: this.num(r.completed),
        disputed: this.num(r.disputed),
        lastOfferAt: r.lastOfferAt,
      })),
    };
  }

  // SP-29
  async findBySupporter(supporterId: string, admin: CurrentUserDto, query: ListSupportQueryDto) {
    const { page, limit, skip, take } = this.paging(query);
    const where: Prisma.SupportWhereInput = {
      userId: supporterId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.support.count({ where }),
      this.prisma.support.findMany({
        where,
        select: adminListSelect(admin.id),
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);
    return { total, page, limit, items: rows.map((r) => this.mapAdminRow(r)) };
  }

  // SP-30
  async getSupporterSummary(supporterId: string, admin: CurrentUserDto) {
    void admin;
    const supporter = await this.prisma.user.findUnique({
      where: { id: supporterId },
      select: { id: true, name: true },
    });
    if (!supporter) throw new NotFoundException('supporter_not_found');

    const [byStatus, disputes, notDelivered, restriction, firstLast] = await Promise.all([
      this.prisma.support.groupBy({
        by: ['status'],
        where: { userId: supporterId },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.supportDispute.count({ where: { supporterUserId: supporterId } }),
      this.prisma.supportDispute.count({
        where: { supporterUserId: supporterId, outcome: SupportDisputeOutcome.NOT_DELIVERED },
      }),
      this.prisma.supporterRestriction.findFirst({
        where: this.activeRestrictionWhere(supporterId),
        select: { id: true, reason: true, startsAt: true, endsAt: true },
      }),
      this.prisma.support.aggregate({
        where: { userId: supporterId },
        _min: { createdAt: true },
        _max: { createdAt: true },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(SupportStatus).map((s) => [s, 0]),
    ) as Record<SupportStatus, number>;
    for (const row of byStatus)
      statusCounts[row.status] = (row._count as { _all?: number })?._all ?? 0;

    const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const completed = statusCounts[SupportStatus.COMPLETED];
    const failed = statusCounts[SupportStatus.FAILED];
    const denominator = completed + failed + notDelivered;

    return {
      supporter,
      total,
      byStatus: statusCounts,
      disputes: { total: disputes, notDelivered },
      reliability: {
        // completed / (completed + failed + confirmed non-deliveries). null until there is history.
        score: denominator === 0 ? null : Number((completed / denominator).toFixed(2)),
        completed,
        failed,
        notDelivered,
      },
      restriction,
      firstOfferAt: firstLast._min.createdAt,
      lastOfferAt: firstLast._max.createdAt,
    };
  }

  // SP-31
  async findProfilesSummary(admin: CurrentUserDto, query: SupportPagedQueryDto) {
    void admin;
    const { page, limit, skip, take } = this.paging(query);

    const [items, totalRow] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          victimProfileId: string;
          name: string | null;
          offers: bigint;
          completed: bigint;
          pending: bigint;
          disputed: bigint;
          lastOfferAt: Date;
        }>
      >(Prisma.sql`
        SELECT s."victimProfileId" AS "victimProfileId",
               vp."name" AS "name",
               COUNT(*) AS offers,
               COUNT(*) FILTER (WHERE s."status" = 'COMPLETED') AS completed,
               COUNT(*) FILTER (WHERE s."status" = 'PENDING') AS pending,
               (SELECT COUNT(*) FROM "support_dispute" d
                  JOIN "Support" s2 ON s2."id" = d."supportId"
                 WHERE s2."victimProfileId" = s."victimProfileId") AS disputed,
               MAX(s."createdAt") AS "lastOfferAt"
        FROM "Support" s
        JOIN "victim_profile" vp ON vp."id" = s."victimProfileId"
        WHERE s."type" = 'NON_FINANCIAL'
        GROUP BY s."victimProfileId", vp."name"
        ORDER BY MAX(s."createdAt") DESC
        LIMIT ${take} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "victimProfileId") AS count FROM "Support" WHERE "type" = 'NON_FINANCIAL'
      `),
    ]);

    return {
      total: this.num(totalRow[0]?.count),
      page,
      limit,
      items: items.map((r) => ({
        victimProfileId: r.victimProfileId,
        name: r.name,
        offers: this.num(r.offers),
        completed: this.num(r.completed),
        pending: this.num(r.pending),
        disputed: this.num(r.disputed),
        lastOfferAt: r.lastOfferAt,
      })),
    };
  }

  // SP-32
  async markSupporterRead(supporterId: string, admin: CurrentUserDto) {
    const unread = await this.prisma.support.findMany({
      where: { userId: supporterId, adminReads: { none: { adminId: admin.id } } },
      select: { id: true },
      take: 5_000,
    });
    const { count } = await this.prisma.supportAdminRead.createMany({
      data: unread.map((s) => ({ supportId: s.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    return { supporterId, marked: count };
  }

  // SP-33
  async findRepeatDisputeSupporters(admin: CurrentUserDto, query: SupportPagedQueryDto) {
    void admin;
    const { page, limit, skip, take } = this.paging(query);

    const having = Prisma.sql`
      COUNT(*) >= ${REPEAT_DISPUTE_THRESHOLD}
      OR COUNT(*) FILTER (WHERE d."outcome" = 'NOT_DELIVERED') >= 1
    `;

    const [items, totalRow] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          supporterId: string;
          name: string | null;
          disputes: bigint;
          notDelivered: bigint;
          lastDisputeAt: Date;
        }>
      >(Prisma.sql`
        SELECT d."supporterUserId" AS "supporterId",
               u."name" AS "name",
               COUNT(*) AS disputes,
               COUNT(*) FILTER (WHERE d."outcome" = 'NOT_DELIVERED') AS "notDelivered",
               MAX(d."createdAt") AS "lastDisputeAt"
        FROM "support_dispute" d
        LEFT JOIN "user" u ON u."id" = d."supporterUserId"
        WHERE d."supporterUserId" IS NOT NULL
        GROUP BY d."supporterUserId", u."name"
        HAVING ${having}
        ORDER BY COUNT(*) DESC, MAX(d."createdAt") DESC
        LIMIT ${take} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS count FROM (
          SELECT d."supporterUserId"
          FROM "support_dispute" d
          WHERE d."supporterUserId" IS NOT NULL
          GROUP BY d."supporterUserId"
          HAVING ${having}
        ) t
      `),
    ]);

    return {
      total: this.num(totalRow[0]?.count),
      page,
      limit,
      items: items.map((r) => ({
        supporterId: r.supporterId,
        name: r.name,
        disputes: this.num(r.disputes),
        notDelivered: this.num(r.notDelivered),
        lastDisputeAt: r.lastDisputeAt,
      })),
    };
  }

  // ═════════════════ admin: disputes, restrictions, flags (SP-34 .. SP-42) ═════════════════

  // SP-34. Open disputes unless a status is given.
  async findDisputes(admin: CurrentUserDto, query: ListSupportDisputesQueryDto) {
    void admin;
    const { page, limit, skip, take } = this.paging(query);
    const where: Prisma.SupportDisputeWhereInput = {
      status: query.status ?? SupportDisputeStatus.OPEN,
      ...(query.outcome ? { outcome: query.outcome } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.supportDispute.count({ where }),
      this.prisma.supportDispute.findMany({
        where,
        select: {
          ...DISPUTE_SELECT,
          supporterUserId: true,
          support: {
            select: {
              id: true,
              type: true,
              status: true,
              categories: true,
              transferReference: true,
              user: { select: { id: true, name: true } },
              victimProfile: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      }),
    ]);
    return { total, page, limit, items };
  }

  // SP-35. Both sides plus the proof files (metadata only).
  async findOneDispute(disputeId: string, admin: CurrentUserDto) {
    void admin;
    const dispute = await this.prisma.supportDispute.findUnique({
      where: { id: disputeId },
      select: {
        ...DISPUTE_SELECT,
        supporterUserId: true,
        raisedByUserId: true,
        resolvedByUserId: true,
        support: {
          select: {
            ...SUPPORT_OWNER_SELECT,
            victimProfile: { select: { id: true, name: true, claimedByUserId: true } },
            attachments: {
              where: { removedAt: null },
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                key: true,
                kind: true,
                mimeType: true,
                sizeBytes: true,
                scanStatus: true,
                note: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });
    if (!dispute) throw new NotFoundException('dispute_not_found');

    const userIds = [
      dispute.supporterUserId,
      dispute.raisedByUserId,
      dispute.resolvedByUserId,
      dispute.support.victimProfile.claimedByUserId,
    ].filter((v): v is string => Boolean(v));
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, name: true, phone: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    return {
      ...dispute,
      supporter: dispute.supporterUserId ? (byId.get(dispute.supporterUserId) ?? null) : null,
      recipient: dispute.support.victimProfile.claimedByUserId
        ? (byId.get(dispute.support.victimProfile.claimedByUserId) ?? null)
        : null,
      raisedBy: dispute.raisedByUserId ? (byId.get(dispute.raisedByUserId) ?? null) : null,
      resolvedBy: dispute.resolvedByUserId ? (byId.get(dispute.resolvedByUserId) ?? null) : null,
    };
  }

  // SP-36. The outcome is applied to the offer where the move is allowed; otherwise it is only recorded.
  async resolveDispute(disputeId: string, admin: CurrentUserDto, data: ResolveSupportDisputeDto) {
    const dispute = await this.prisma.supportDispute.findUnique({
      where: { id: disputeId },
      select: {
        id: true,
        status: true,
        supportId: true,
        raisedByUserId: true,
        support: {
          select: {
            id: true,
            userId: true,
            type: true,
            status: true,
            victimProfileId: true,
            transferReference: true,
            victimProfile: { select: { claimedByUserId: true } },
          },
        },
      },
    });
    if (!dispute) throw new NotFoundException('dispute_not_found');
    if (dispute.status !== SupportDisputeStatus.OPEN) {
      throw new BadRequestException('dispute_already_resolved');
    }

    const reason = data.reason.trim();
    const support = dispute.support;
    let appliedStatus: SupportStatus | null = null;

    // Change the offer first: if the move is refused the dispute stays open.
    if (
      data.outcome === SupportDisputeOutcome.DELIVERED &&
      support.status === SupportStatus.CONFIRMED
    ) {
      appliedStatus = (await this.updateStatus(support.id, SupportStatus.COMPLETED, admin, reason))
        .status;
    } else if (
      data.outcome === SupportDisputeOutcome.NOT_DELIVERED &&
      this.isAdminTransitionAllowed(support.status, SupportStatus.FAILED, support.type)
    ) {
      appliedStatus = (await this.adminTransition(support.id, SupportStatus.FAILED, admin, reason))
        .status;
    } else if (
      data.outcome === SupportDisputeOutcome.CANCELLED &&
      this.isTransitionAllowed(support.status, SupportStatus.CANCELLED, support.type)
    ) {
      appliedStatus = (await this.updateStatus(support.id, SupportStatus.CANCELLED, admin, reason))
        .status;
    }

    const { count } = await this.prisma.supportDispute.updateMany({
      where: { id: disputeId, status: SupportDisputeStatus.OPEN },
      data: {
        status: SupportDisputeStatus.RESOLVED,
        outcome: data.outcome,
        resolutionReason: reason,
        resolvedByUserId: admin.id,
        resolvedAt: new Date(),
      },
    });
    if (count === 0) throw new BadRequestException('dispute_already_resolved');

    this.emitSupportAudit(admin, AuditEventEnum.SUPPORT_DISPUTE_RESOLVED, support, {
      reason,
      diff: { result: 'success', disputeId, outcome: data.outcome, appliedStatus },
      metadata: { victimProfileId: support.victimProfileId },
    });

    const notify = new Set(
      [support.userId, support.victimProfile.claimedByUserId, dispute.raisedByUserId].filter(
        (v): v is string => Boolean(v),
      ),
    );
    for (const userId of notify) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_DISPUTE_RESOLVED, {
        userId,
        supportId: support.id,
        disputeId,
        outcome: data.outcome,
      });
    }

    const resolved = await this.prisma.supportDispute.findUniqueOrThrow({
      where: { id: disputeId },
      select: DISPUTE_SELECT,
    });
    return { ...resolved, appliedStatus };
  }

  // SP-37
  async findDisputesForSupport(id: string, admin: CurrentUserDto) {
    void admin;
    await this.findSupportOrThrow(id);
    return this.prisma.supportDispute.findMany({
      where: { supportId: id },
      select: { ...DISPUTE_SELECT, raisedByUserId: true, resolvedByUserId: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // SP-38
  async restrictSupporter(supporterId: string, admin: CurrentUserDto, data: RestrictSupporterDto) {
    const target = await this.prisma.user.findUnique({
      where: { id: supporterId },
      select: { id: true, userRoles: { select: { role: { select: { name: true } } } } },
    });
    if (!target) throw new NotFoundException('supporter_not_found');
    if (target.userRoles.some((ur) => ADMIN_ROLE_NAMES.includes(ur.role.name as RolesEnum))) {
      throw new BadRequestException('cannot_restrict_staff');
    }
    if (supporterId === admin.id) throw new BadRequestException('cannot_restrict_yourself');

    const endsAt = data.endsAt ? new Date(data.endsAt) : null;
    if (endsAt && endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('restriction_end_must_be_in_the_future');
    }

    const active = await this.prisma.supporterRestriction.count({
      where: this.activeRestrictionWhere(supporterId),
    });
    if (active > 0) throw new BadRequestException('supporter_already_restricted');

    const reason = data.reason.trim();
    const restriction = await this.prisma.supporterRestriction.create({
      data: { userId: supporterId, reason, endsAt, restrictedByUserId: admin.id },
      select: { id: true, userId: true, reason: true, startsAt: true, endsAt: true },
    });

    this.emitAudit({
      userId: admin.id,
      targetUserId: supporterId,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.SUPPORT_SUPPORTER_RESTRICTED,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: supporterId,
      reason,
      diff: {
        result: 'success',
        restrictionId: restriction.id,
        endsAt: endsAt?.toISOString() ?? null,
      },
    } as AuditEventPayload);
    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_SUPPORTER_RESTRICTED, {
      userId: supporterId,
      endsAt: endsAt?.toISOString() ?? null,
    });

    return restriction;
  }

  // SP-39
  async liftSupporterRestriction(supporterId: string, admin: CurrentUserDto) {
    const { count } = await this.prisma.supporterRestriction.updateMany({
      where: this.activeRestrictionWhere(supporterId),
      data: { liftedAt: new Date(), liftedByUserId: admin.id },
    });
    if (count === 0) throw new NotFoundException('no_active_restriction');

    this.emitAudit({
      userId: admin.id,
      targetUserId: supporterId,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.SUPPORT_SUPPORTER_RESTRICTION_LIFTED,
      entity: 'User',
      entityId: supporterId,
      diff: { result: 'success', lifted: count },
    } as AuditEventPayload);

    return { supporterId, lifted: count };
  }

  // SP-40
  async flagSupport(id: string, admin: CurrentUserDto, data: FlagSupportDto) {
    const support = await this.findSupportOrThrow(id);
    const details = data.details?.trim() || null;
    if (data.reason === SupportFlagReason.OTHER && !details) {
      throw new BadRequestException('flag_details_required_for_other');
    }

    const flag = await this.prisma.supportFlag.create({
      data: { supportId: id, reason: data.reason, details, flaggedByUserId: admin.id },
      select: { id: true, supportId: true, reason: true, details: true, createdAt: true },
    });

    this.emitSupportAudit(admin, AuditEventEnum.SUPPORT_FLAGGED, support, {
      severity: AuditSeverity.WARNING,
      reason: details,
      diff: { result: 'success', flagId: flag.id, flagReason: data.reason },
    });
    return flag;
  }

  // SP-41. Flags on offers that are still open (PENDING or CONFIRMED).
  async findFlags(admin: CurrentUserDto, query: ListSupportFlagsQueryDto) {
    void admin;
    const { page, limit, skip, take } = this.paging(query);
    const where: Prisma.SupportFlagWhereInput = {
      ...(query.reason ? { reason: query.reason } : {}),
      support: { status: { in: [SupportStatus.PENDING, SupportStatus.CONFIRMED] } },
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.supportFlag.count({ where }),
      this.prisma.supportFlag.findMany({
        where,
        select: {
          id: true,
          reason: true,
          details: true,
          flaggedByUserId: true,
          createdAt: true,
          support: {
            select: {
              id: true,
              type: true,
              status: true,
              categories: true,
              transferReference: true,
              user: { select: { id: true, name: true, phone: true, email: true } },
              victimProfile: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);
    return { total, page, limit, items };
  }

  // SP-42 (super admin only; the controller enforces the role)
  async assignReviewer(id: string, admin: CurrentUserDto, data: AssignSupportReviewerDto) {
    const support = await this.findSupportOrThrow(id);

    const reviewer = await this.prisma.user.findFirst({
      where: {
        id: data.reviewerId,
        isActive: true,
        userRoles: { some: { role: { name: { in: ADMIN_ROLE_NAMES } } } },
      },
      select: { id: true, name: true },
    });
    if (!reviewer) throw new BadRequestException('reviewer_must_be_an_active_admin');

    const before = await this.prisma.support.findUniqueOrThrow({
      where: { id },
      select: { assignedReviewerId: true },
    });
    if (before.assignedReviewerId === reviewer.id) {
      throw new BadRequestException('reviewer_already_assigned');
    }

    await this.prisma.$transaction([
      this.prisma.support.update({
        where: { id },
        data: { assignedReviewerId: reviewer.id, assignedAt: new Date() },
        select: { id: true },
      }),
      this.prisma.supportRevision.create({
        data: {
          supportId: id,
          actorUserId: admin.id,
          field: 'assignedReviewerId',
          oldValue: this.toJson(before.assignedReviewerId),
          newValue: this.toJson(reviewer.id),
        },
      }),
    ]);

    this.emitSupportAudit(admin, AuditEventEnum.SUPPORT_REVIEWER_ASSIGNED, support, {
      diff: {
        result: 'success',
        previousReviewerId: before.assignedReviewerId,
        reviewerId: reviewer.id,
      },
    });
    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_REVIEWER_ASSIGNED, {
      userId: reviewer.id,
      supportId: id,
    });

    return { id, assignedReviewerId: reviewer.id, reviewerName: reviewer.name };
  }

  // ═════════════════ admin: bulk and case management (SP-43 .. SP-54) ═════════════════

  private summariseBulk(results: Array<{ id: string; ok: boolean; error?: string }>) {
    const succeeded = results.filter((r) => r.ok).length;
    return { requested: results.length, succeeded, failed: results.length - succeeded, results };
  }

  // SP-43. Each offer goes through confirm(), so audit and notifications are the same as one by one.
  async bulkConfirm(admin: CurrentUserDto, data: BulkSupportIdsDto) {
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of [...new Set(data.ids)]) {
      try {
        const s = await this.prisma.support.findUnique({ where: { id }, select: { type: true } });
        if (!s) throw new NotFoundException('support_not_found');
        if (s.type !== SupportType.NON_FINANCIAL) {
          throw new BadRequestException('only_non_financial_offers_can_be_bulk_confirmed');
        }
        await this.confirm(id, admin);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: this.httpMessage(e) });
      }
    }
    return this.summariseBulk(results);
  }

  // SP-44
  async bulkCancel(admin: CurrentUserDto, data: BulkSupportReasonDto) {
    const reason = data.reason.trim();
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of [...new Set(data.ids)]) {
      try {
        await this.cancel(id, admin, reason);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: this.httpMessage(e) });
      }
    }
    return this.summariseBulk(results);
  }

  // SP-45. Same effect as the hourly job, run on demand with a shorter or longer cut-off.
  async bulkExpire(admin: CurrentUserDto, data: BulkExpireSupportDto) {
    const days = data.olderThanDays ?? DEFAULT_OFFER_EXPIRY_DAYS;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const reason = data.reason?.trim() || 'expired_by_admin';

    const stale = await this.prisma.support.findMany({
      where: {
        type: SupportType.NON_FINANCIAL,
        status: SupportStatus.PENDING,
        createdAt: { lt: cutoff },
      },
      select: { id: true, userId: true, victimProfileId: true, transferReference: true },
      orderBy: { createdAt: 'asc' },
      take: BULK_EXPIRE_MAX,
    });

    let expired = 0;
    for (const support of stale) {
      try {
        const { count } = await this.prisma.support.updateMany({
          where: { id: support.id, status: SupportStatus.PENDING },
          data: { status: SupportStatus.CANCELLED },
        });
        if (count === 0) continue;
        expired += 1;

        this.emitSupportAudit(admin, AuditEventEnum.SUPPORT_EXPIRED, support, {
          severity: AuditSeverity.INFO,
          reason,
          diff: {
            result: 'success',
            previousStatus: SupportStatus.PENDING,
            currentStatus: SupportStatus.CANCELLED,
          },
          metadata: { victimProfileId: support.victimProfileId, expiryDays: days, bulk: true },
        });
        if (support.userId) {
          this.eventEmitter.emit(NotificationEventEnum.SUPPORT_OFFER_EXPIRED, {
            userId: support.userId,
            supportId: support.id,
            expiryDays: days,
          });
        }
      } catch (error) {
        this.logger.error(
          `Could not expire support ${support.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return {
      olderThanDays: days,
      matched: stale.length,
      expired,
      more: stale.length === BULK_EXPIRE_MAX,
    };
  }

  // Moves that updateStatus() does not cover. Reopening is limited to non-financial offers so a
  // refunded or cancelled payment can never come back to life and change total raised by accident.
  private isAdminTransitionAllowed(
    from: SupportStatus,
    to: SupportStatus,
    type: SupportType,
  ): boolean {
    if (to === SupportStatus.FAILED) {
      return (
        from === SupportStatus.PENDING ||
        from === SupportStatus.CONFIRMED ||
        (from === SupportStatus.COMPLETED && type === SupportType.NON_FINANCIAL)
      );
    }
    if (to === SupportStatus.PENDING) {
      return (
        (from === SupportStatus.CANCELLED || from === SupportStatus.FAILED) &&
        type === SupportType.NON_FINANCIAL
      );
    }
    return false;
  }

  private async adminTransition(
    id: string,
    to: typeof SupportStatus.FAILED | typeof SupportStatus.PENDING,
    admin: CurrentUserDto,
    reason: string,
  ) {
    const support = await this.prisma.support.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        victimProfileId: true,
        amount: true,
        recipientAmount: true,
        transferReference: true,
      },
    });
    if (!support) throw new NotFoundException('support_not_found');

    const from = support.status;
    const action =
      to === SupportStatus.FAILED ? AuditEventEnum.SUPPORT_FAILED : AuditEventEnum.SUPPORT_REOPENED;

    if (from === to || !this.isAdminTransitionAllowed(from, to, support.type)) {
      this.emitSupportAudit(admin, AuditEventEnum.SUPPORT_UPDATED, support, {
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        diff: {
          result: 'failure',
          reason: from === to ? 'support_already_has_status' : 'support_invalid_transition',
          currentStatus: from,
          attemptedStatus: to,
          type: support.type,
        },
      });
      throw new BadRequestException(
        from === to ? 'support_already_has_status' : 'support_invalid_transition',
      );
    }

    // A counted financial support that fails stops counting towards total raised.
    const amount = Number(support.recipientAmount ?? support.amount ?? 0);
    const wasCounted = support.type === SupportType.FINANCIAL && COUNTED_STATUSES.includes(from);
    const totalRaisedDelta = wasCounted && to === SupportStatus.FAILED ? -amount : 0;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.support.updateMany({
        where: { id, status: from },
        data: {
          status: to,
          ...(to === SupportStatus.PENDING
            ? {
                declinedAt: null,
                declineReason: null,
                declinedByUserId: null,
                recipientOpenedAt: null,
              }
            : {}),
        },
      });
      if (result.count === 0) return null;

      if (totalRaisedDelta !== 0) {
        await tx.victimProfile.update({
          where: { id: support.victimProfileId },
          data: { totalRaised: { increment: totalRaisedDelta } },
        });
      }
      return tx.support.findUniqueOrThrow({ where: { id }, select: SUPPORT_OWNER_SELECT });
    });

    if (!updated) {
      this.emitSupportAudit(admin, AuditEventEnum.SUPPORT_UPDATED, support, {
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        diff: {
          result: 'failure',
          reason: 'support_transition_conflict',
          expectedStatus: from,
          attemptedStatus: to,
        },
      });
      throw new BadRequestException('support_transition_conflict');
    }

    this.emitSupportAudit(admin, action, support, {
      reason,
      diff: { result: 'success', previousStatus: from, currentStatus: updated.status },
      metadata: {
        victimProfileId: support.victimProfileId,
        type: support.type,
        amount,
        totalRaisedDelta,
      },
    });

    if (support.userId) {
      this.eventEmitter.emit(
        to === SupportStatus.FAILED
          ? NotificationEventEnum.SUPPORT_OFFER_FAILED
          : NotificationEventEnum.SUPPORT_OFFER_REOPENED,
        { userId: support.userId, supportId: id, victimProfileId: support.victimProfileId },
      );
    }
    return updated;
  }

  // SP-46
  async markFailed(id: string, admin: CurrentUserDto, data: SupportReasonDto) {
    return this.adminTransition(id, SupportStatus.FAILED, admin, data.reason.trim());
  }

  // SP-47
  async reopen(id: string, admin: CurrentUserDto, data: SupportReasonDto) {
    return this.adminTransition(id, SupportStatus.PENDING, admin, data.reason.trim());
  }

  // SP-48. Non-financial only: money stays on the profile its payment was made for.
  async reassignProfile(id: string, admin: CurrentUserDto, data: ReassignSupportProfileDto) {
    const support = await this.prisma.support.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        victimProfileId: true,
        transferReference: true,
        anonymous: true,
        categories: true,
        user: { select: { name: true } },
      },
    });
    if (!support) throw new NotFoundException('support_not_found');
    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('only_non_financial_offers_can_be_reassigned');
    }
    if (support.status !== SupportStatus.PENDING && support.status !== SupportStatus.CONFIRMED) {
      throw new BadRequestException('support_not_open_for_reassignment');
    }
    if (support.victimProfileId === data.victimProfileId) {
      throw new BadRequestException('support_already_on_this_profile');
    }

    const target = await this.prisma.victimProfile.findFirst({
      where: { id: data.victimProfileId, status: 'PUBLISHED', isPublished: true },
      select: { id: true, claimedByUserId: true },
    });
    if (!target) throw new NotFoundException('victim_profile_not_found');

    const reason = data.reason.trim();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.support.updateMany({
        where: {
          id,
          victimProfileId: support.victimProfileId,
          status: { in: [SupportStatus.PENDING, SupportStatus.CONFIRMED] },
        },
        data: {
          victimProfileId: target.id,
          recipientOpenedAt: null,
          victimConfirmedReceiptAt: null,
          lastUpdateAt: new Date(),
        },
      });
      if (result.count === 0) return null;
      await tx.supportRevision.create({
        data: {
          supportId: id,
          actorUserId: admin.id,
          field: 'victimProfileId',
          oldValue: this.toJson(support.victimProfileId),
          newValue: this.toJson(target.id),
        },
      });
      return tx.support.findUniqueOrThrow({ where: { id }, select: SUPPORT_OWNER_SELECT });
    });
    if (!updated) throw new BadRequestException('support_transition_conflict');

    this.emitSupportAudit(admin, AuditEventEnum.SUPPORT_PROFILE_REASSIGNED, support, {
      reason,
      diff: { result: 'success', fromProfileId: support.victimProfileId, toProfileId: target.id },
    });

    // The new profile's owner is only told once the offer is already confirmed.
    if (support.status === SupportStatus.CONFIRMED && target.claimedByUserId) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_OFFER_CONFIRMED, {
        userId: target.claimedByUserId,
        supportId: id,
        victimProfileId: target.id,
        supporterName: support.anonymous ? null : (support.user?.name ?? null),
        categories: support.categories,
      });
    }
    return updated;
  }

  // SP-49
  async getTransitions(id: string, admin: CurrentUserDto) {
    void admin;
    const support = await this.findSupportOrThrow(id);
    const { status: from, type } = support;

    const allowed: Array<{
      to: SupportStatus;
      action: string;
      method: string;
      path: string;
      requires: string[];
    }> = [];
    const add = (to: SupportStatus, action: string, path: string, requires: string[]) =>
      allowed.push({ to, action, method: 'PATCH', path: `/support/${id}/${path}`, requires });

    if (
      type === SupportType.NON_FINANCIAL &&
      this.isTransitionAllowed(from, SupportStatus.CONFIRMED, type)
    ) {
      add(SupportStatus.CONFIRMED, 'confirm', 'confirm', []);
    }
    if (this.isTransitionAllowed(from, SupportStatus.COMPLETED, type)) {
      add(SupportStatus.COMPLETED, 'complete', 'complete', ['note']);
    }
    if (this.isTransitionAllowed(from, SupportStatus.CANCELLED, type)) {
      add(SupportStatus.CANCELLED, 'cancel', 'cancel', []);
    }
    if (this.isAdminTransitionAllowed(from, SupportStatus.FAILED, type)) {
      add(SupportStatus.FAILED, 'mark-failed', 'mark-failed', ['reason']);
    }
    if (this.isAdminTransitionAllowed(from, SupportStatus.PENDING, type)) {
      add(SupportStatus.PENDING, 'reopen', 'reopen', ['reason']);
    }

    return { supportId: id, currentStatus: from, type, allowed };
  }

  // SP-50
  async getRevisions(id: string, admin: CurrentUserDto) {
    void admin;
    await this.findSupportOrThrow(id);
    return this.prisma.supportRevision.findMany({
      where: { supportId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        field: true,
        oldValue: true,
        newValue: true,
        actorUserId: true,
        createdAt: true,
      },
      take: 500,
    });
  }

  // SP-51
  async sendStaffMessage(id: string, admin: CurrentUserDto, data: CreateSupportMessageDto) {
    const support = await this.findSupportOrThrow(id);
    const body = data.body.trim();
    if (!body) throw new BadRequestException('message_body_required');

    const [message] = await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: {
          supportId: id,
          authorUserId: admin.id,
          authorType: SupportMessageAuthor.STAFF,
          body,
        },
        select: { id: true, authorType: true, body: true, createdAt: true },
      }),
      this.prisma.support.update({
        where: { id },
        data: { lastUpdateAt: new Date() },
        select: { id: true },
      }),
      this.prisma.supportAdminRead.upsert({
        where: { supportId_adminId: { supportId: id, adminId: admin.id } },
        create: { supportId: id, adminId: admin.id },
        update: {},
      }),
    ]);

    this.emitSupportAudit(admin, AuditEventEnum.SUPPORT_MESSAGE_SENT, support, {
      diff: { result: 'success', messageId: message.id, authorType: message.authorType },
    });
    if (support.userId) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_STAFF_MESSAGE, {
        userId: support.userId,
        supportId: id,
        messageId: message.id,
      });
    }
    return message;
  }

  // SP-52. Includes removed files (flagged) so the team can see what was taken down.
  async getAttachments(id: string, admin: CurrentUserDto) {
    void admin;
    await this.findSupportOrThrow(id);
    const rows = await this.prisma.supportAttachment.findMany({
      where: { supportId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        key: true,
        kind: true,
        mimeType: true,
        sizeBytes: true,
        sha256: true,
        scanStatus: true,
        note: true,
        uploadedByUserId: true,
        createdAt: true,
        removedAt: true,
        removalReason: true,
      },
    });
    return rows.map(({ removedAt, ...rest }) => ({
      ...rest,
      removedAt,
      removed: removedAt !== null,
    }));
  }

  // SP-53. For example a photo that shows a face or an address.
  async adminRemoveProof(id: string, key: string, admin: CurrentUserDto) {
    const support = await this.findSupportOrThrow(id);
    const { count } = await this.prisma.supportAttachment.updateMany({
      where: { supportId: id, key, removedAt: null },
      data: { removedAt: new Date(), removedByUserId: admin.id, removalReason: 'removed_by_staff' },
    });
    if (count === 0) throw new NotFoundException('proof_not_found');

    await this.touchSupporterUpdate(id);
    this.emitSupportAudit(admin, AuditEventEnum.SUPPORT_PROOF_REMOVED, support, {
      severity: AuditSeverity.WARNING,
      reason: 'removed_by_staff',
      diff: { result: 'success', key },
    });
    return { supportId: id, key, removed: true };
  }

  // SP-54
  async getProofCustody(id: string, key: string, admin: CurrentUserDto) {
    void admin;
    await this.findSupportOrThrow(id);
    const attachment = await this.prisma.supportAttachment.findFirst({
      where: { supportId: id, key },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        key: true,
        kind: true,
        sha256: true,
        scanStatus: true,
        uploadedByUserId: true,
        createdAt: true,
        removedAt: true,
        removedByUserId: true,
        removalReason: true,
      },
    });
    if (!attachment) throw new NotFoundException('proof_not_found');

    const accesses = await this.prisma.supportAttachmentAccess.findMany({
      where: { attachmentId: attachment.id },
      orderBy: { createdAt: 'desc' },
      select: { userId: true, action: true, createdAt: true },
      take: 200,
    });
    const userIds = [
      ...new Set(
        [
          attachment.uploadedByUserId,
          attachment.removedByUserId,
          ...accesses.map((a) => a.userId),
        ].filter((v): v is string => Boolean(v)),
      ),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const name = (uid: string | null) =>
      uid ? (users.find((u) => u.id === uid)?.name ?? null) : null;

    return {
      attachment,
      uploadedBy: { userId: attachment.uploadedByUserId, name: name(attachment.uploadedByUserId) },
      removedBy: attachment.removedByUserId
        ? { userId: attachment.removedByUserId, name: name(attachment.removedByUserId) }
        : null,
      accesses: accesses.map((a) => ({ ...a, name: name(a.userId) })),
    };
  }

  // Call this from whatever serves or signs proof-file URLs, so SP-54 has something to show.
  async recordProofAccess(
    attachmentId: string,
    userId: string | null,
    action: SupportAttachmentAccessAction,
  ): Promise<void> {
    await this.prisma.supportAttachmentAccess.create({ data: { attachmentId, userId, action } });
  }

  // ═════════════════ admin: search, facets, export (SP-55 .. SP-60) ═════════════════

  // Filters shared by search, facets, export and every stats route.
  private buildStatsWhere(q: SupportStatsQueryDto): Prisma.SupportWhereInput {
    const createdAt: Prisma.DateTimeFilter = {};
    if (q.from) createdAt.gte = new Date(q.from);
    if (q.to) createdAt.lte = new Date(q.to);
    return {
      ...(q.from || q.to ? { createdAt } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.victimProfileId ? { victimProfileId: q.victimProfileId } : {}),
      ...(q.supporterId ? { userId: q.supporterId } : {}),
    };
  }

  // Same filters as SQL conditions on the alias `s`, for the raw statistics queries.
  private statsConditions(q: SupportStatsQueryDto): Prisma.Sql[] {
    const conds: Prisma.Sql[] = [];
    if (q.from) conds.push(Prisma.sql`s."createdAt" >= ${new Date(q.from)}`);
    if (q.to) conds.push(Prisma.sql`s."createdAt" <= ${new Date(q.to)}`);
    if (q.status) conds.push(Prisma.sql`s."status" = ${q.status}::"SupportStatus"`);
    if (q.type) conds.push(Prisma.sql`s."type" = ${q.type}::"SupportType"`);
    if (q.victimProfileId) conds.push(Prisma.sql`s."victimProfileId" = ${q.victimProfileId}`);
    if (q.supporterId) conds.push(Prisma.sql`s."userId" = ${q.supporterId}`);
    return conds;
  }

  private whereSql(conds: Prisma.Sql[]): Prisma.Sql {
    return conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
  }

  // SP-55
  async searchSupports(admin: CurrentUserDto, query: SupportSearchQueryDto) {
    const { page, limit, skip, take } = this.paging(query);
    const q = query.q.trim();

    const or: Prisma.SupportWhereInput[] = [
      { transferReference: { contains: q, mode: 'insensitive' } },
      { user: { name: { contains: q, mode: 'insensitive' } } },
      { user: { email: { contains: q, mode: 'insensitive' } } },
      { user: { phone: { contains: q } } },
      { victimProfile: { name: { contains: q, mode: 'insensitive' } } },
    ];
    if (UUID_RE.test(q)) {
      or.push({ id: q }, { victimProfileId: q }, { userId: q });
    } else {
      // The label shown in audit rows is "support:" plus the first 8 characters of the id.
      const prefix = q.toLowerCase().replace(/^support:/, '');
      if (/^[0-9a-f-]{4,36}$/.test(prefix)) or.push({ id: { startsWith: prefix } });
    }

    const where: Prisma.SupportWhereInput = { AND: [this.buildStatsWhere(query), { OR: or }] };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.support.count({ where }),
      this.prisma.support.findMany({
        where,
        select: adminListSelect(admin.id),
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);
    return { total, page, limit, items: rows.map((r) => this.mapAdminRow(r)) };
  }

  // SP-56. Each dimension ignores its own filter so the sidebar still shows the alternatives.
  async getSupportFacets(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    const base = this.buildStatsWhere({ ...query, status: undefined, type: undefined });
    const withStatus = this.buildStatsWhere({ ...query, status: undefined });
    const withType = this.buildStatsWhere({ ...query, type: undefined });
    const full = this.buildStatsWhere(query);

    const [byStatus, byType, openDisputes, flagged, unread, ...categoryCounts] = await Promise.all([
      this.prisma.support.groupBy({
        by: ['status'],
        where: withType,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.support.groupBy({
        by: ['type'],
        where: withStatus,
        _count: { _all: true },
        orderBy: { type: 'asc' },
      }),
      this.prisma.support.count({
        where: { ...full, disputes: { some: { status: SupportDisputeStatus.OPEN } } },
      }),
      this.prisma.support.count({ where: { ...full, flags: { some: {} } } }),
      this.prisma.support.count({
        where: { ...full, adminReads: { none: { adminId: admin.id } } },
      }),
      ...Object.values(SupportCategory).map((category) =>
        this.prisma.support.count({ where: { ...base, ...full, categories: { has: category } } }),
      ),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(SupportStatus).map((s) => [s, 0]),
    ) as Record<SupportStatus, number>;
    for (const row of byStatus)
      statusCounts[row.status] = (row._count as { _all?: number })?._all ?? 0;

    const typeCounts = Object.fromEntries(Object.values(SupportType).map((t) => [t, 0])) as Record<
      SupportType,
      number
    >;
    for (const row of byType) typeCounts[row.type] = (row._count as { _all?: number })?._all ?? 0;

    const categories = Object.fromEntries(
      Object.values(SupportCategory).map((c, i) => [c, categoryCounts[i]]),
    ) as Record<SupportCategory, number>;

    return { status: statusCounts, type: typeCounts, categories, openDisputes, flagged, unread };
  }

  private async buildExportCsv(q: SupportExportQueryDto, cap: number) {
    const rows = await this.prisma.support.findMany({
      where: this.buildStatsWhere(q),
      select: {
        id: true,
        createdAt: true,
        type: true,
        status: true,
        victimProfileId: true,
        userId: true,
        anonymous: true,
        categories: true,
        amount: true,
        recipientAmount: true,
        organizationAmount: true,
        platformAmount: true,
        transferReference: true,
        contactMayBeShared: true,
        victimConfirmedReceiptAt: true,
        completedAt: true,
        victimProfile: { select: { name: true } },
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: cap + 1,
    });

    const truncated = rows.length > cap;
    const slice = truncated ? rows.slice(0, cap) : rows;

    // Contact details are deliberately not exported.
    const header = [
      'id',
      'createdAt',
      'type',
      'status',
      'victimProfileId',
      'victimProfileName',
      'supporterId',
      'supporterName',
      'anonymous',
      'categories',
      'amount',
      'recipientAmount',
      'organizationAmount',
      'platformAmount',
      'transferReference',
      'contactMayBeShared',
      'receiptConfirmedAt',
      'completedAt',
    ];
    const lines = [header.join(',')];
    for (const r of slice) {
      lines.push(
        [
          r.id,
          r.createdAt,
          r.type,
          r.status,
          r.victimProfileId,
          r.victimProfile?.name,
          r.userId,
          r.user?.name,
          r.anonymous,
          r.categories,
          r.amount,
          r.recipientAmount,
          r.organizationAmount,
          r.platformAmount,
          r.transferReference,
          r.contactMayBeShared,
          r.victimConfirmedReceiptAt,
          r.completedAt,
        ]
          .map((v) => this.csvCell(v))
          .join(','),
      );
    }
    return { csv: lines.join('\n') + '\n', rowCount: slice.length, truncated };
  }

  private exportFilename(): string {
    return `support-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  }

  // SP-57. Small, immediate export; use the job route for anything bigger.
  async exportSupportsCsv(admin: CurrentUserDto, query: SupportExportQueryDto) {
    const { csv, rowCount, truncated } = await this.buildExportCsv(query, EXPORT_SYNC_ROW_CAP);

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.SUPPORT_EXPORTED,
      severity: AuditSeverity.WARNING,
      entity: 'Support',
      diff: { result: 'success', rowCount, truncated },
      metadata: { filters: JSON.parse(JSON.stringify(query)), mode: 'sync' },
    } as AuditEventPayload);

    return {
      filename: this.exportFilename(),
      contentType: 'text/csv',
      rowCount,
      truncated,
      rowCap: EXPORT_SYNC_ROW_CAP,
      content: csv,
    };
  }

  // SP-58
  async createSupportExportJob(admin: CurrentUserDto, data: SupportExportQueryDto) {
    const active = await this.prisma.supportExportJob.count({
      where: {
        requestedById: admin.id,
        status: { in: [SupportExportJobStatus.QUEUED, SupportExportJobStatus.RUNNING] },
      },
    });
    if (active >= MAX_ACTIVE_EXPORT_JOBS_PER_ADMIN) {
      throw new BadRequestException('too_many_active_export_jobs');
    }

    const filters = JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
    const job = await this.prisma.supportExportJob.create({
      data: { requestedById: admin.id, filters },
      select: { id: true, status: true, createdAt: true },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.SUPPORT_EXPORTED,
      severity: AuditSeverity.WARNING,
      entity: 'SupportExportJob',
      entityId: job.id,
      diff: { result: 'queued' },
      metadata: { filters, mode: 'job' },
    } as AuditEventPayload);

    setImmediate(() => {
      void this.runSupportExportJob(job.id);
    });
    return job;
  }

  private async runSupportExportJob(jobId: string): Promise<void> {
    const claimed = await this.prisma.supportExportJob.updateMany({
      where: { id: jobId, status: SupportExportJobStatus.QUEUED },
      data: { status: SupportExportJobStatus.RUNNING, startedAt: new Date() },
    });
    if (claimed.count === 0) return;

    try {
      const job = await this.prisma.supportExportJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { filters: true },
      });
      const { csv, rowCount } = await this.buildExportCsv(
        (job.filters ?? {}) as unknown as SupportExportQueryDto,
        EXPORT_JOB_ROW_CAP,
      );
      await this.prisma.supportExportJob.update({
        where: { id: jobId },
        data: {
          status: SupportExportJobStatus.COMPLETED,
          csv,
          rowCount,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + EXPORT_JOB_TTL_HOURS * 3_600_000),
        },
        select: { id: true },
      });
    } catch (error) {
      this.logger.error(
        `Support export job ${jobId} failed`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.prisma.supportExportJob.update({
        where: { id: jobId },
        data: {
          status: SupportExportJobStatus.FAILED,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          completedAt: new Date(),
        },
        select: { id: true },
      });
    }
  }

  // Picks up jobs the in-process runner missed (restart), stops stuck ones, and clears old files.
  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweepSupportExportJobs(): Promise<void> {
    try {
      const now = Date.now();

      const queued = await this.prisma.supportExportJob.findMany({
        where: {
          status: SupportExportJobStatus.QUEUED,
          createdAt: { lt: new Date(now - 2 * 60_000) },
        },
        select: { id: true },
        take: 5,
      });
      for (const job of queued) await this.runSupportExportJob(job.id);

      await this.prisma.supportExportJob.updateMany({
        where: {
          status: SupportExportJobStatus.RUNNING,
          startedAt: { lt: new Date(now - 30 * 60_000) },
        },
        data: {
          status: SupportExportJobStatus.FAILED,
          error: 'export_timed_out',
          completedAt: new Date(),
        },
      });

      await this.prisma.supportExportJob.updateMany({
        where: { status: SupportExportJobStatus.COMPLETED, expiresAt: { lt: new Date(now) } },
        data: { status: SupportExportJobStatus.EXPIRED, csv: null },
      });
    } catch (error) {
      this.logger.error(
        'Support export sweep failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async findExportJobFor(id: string, admin: CurrentUserDto) {
    const job = await this.prisma.supportExportJob.findUnique({
      where: { id },
      select: {
        id: true,
        requestedById: true,
        status: true,
        rowCount: true,
        error: true,
        startedAt: true,
        completedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    if (!job) throw new NotFoundException('export_job_not_found');
    const isSuper = this.getRoles(admin).includes(RolesEnum.SUPER_ADMIN);
    if (job.requestedById !== admin.id && !isSuper) {
      throw new ForbiddenException('not_allowed_to_view_export_job');
    }
    return job;
  }

  // SP-59
  async getSupportExportJob(id: string, admin: CurrentUserDto) {
    const { requestedById, ...job } = await this.findExportJobFor(id, admin);
    void requestedById;
    return job;
  }

  // SP-60. Returns the CSV itself; it is available until expiresAt and every download is audited.
  async getSupportExportJobDownload(id: string, admin: CurrentUserDto) {
    const job = await this.findExportJobFor(id, admin);
    if (job.status !== SupportExportJobStatus.COMPLETED) {
      throw new BadRequestException(
        job.status === SupportExportJobStatus.EXPIRED ? 'export_expired' : 'export_not_ready',
      );
    }
    if (job.expiresAt && job.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('export_expired');
    }

    const file = await this.prisma.supportExportJob.findUniqueOrThrow({
      where: { id },
      select: { csv: true },
    });
    if (!file.csv) throw new BadRequestException('export_expired');

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.SUPPORT_EXPORT_DOWNLOADED,
      severity: AuditSeverity.WARNING,
      entity: 'SupportExportJob',
      entityId: id,
      diff: { result: 'success', rowCount: job.rowCount },
    } as AuditEventPayload);

    return {
      filename: this.exportFilename(),
      contentType: 'text/csv',
      rowCount: job.rowCount,
      expiresAt: job.expiresAt,
      content: file.csv,
    };
  }

  // ═════════════════ admin: statistics (SP-61 .. SP-68) ═════════════════
  // Every route takes from, to, status, type, victimProfileId and supporterId.

  // SP-61
  async getSupportStatsTimeline(admin: CurrentUserDto, query: SupportStatsTimelineQueryDto) {
    void admin;
    const interval = query.interval ?? SupportStatsInterval.DAY;
    const unit =
      interval === SupportStatsInterval.WEEK
        ? 'week'
        : interval === SupportStatsInterval.MONTH
          ? 'month'
          : 'day';

    const rows = await this.prisma.$queryRaw<
      Array<{
        bucket: Date;
        total: bigint;
        nonFinancial: bigint;
        financial: bigint;
        completed: bigint;
        cancelled: bigint;
      }>
    >(Prisma.sql`
      SELECT date_trunc(${Prisma.raw(`'${unit}'`)}, s."createdAt") AS bucket,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE s."type" = 'NON_FINANCIAL') AS "nonFinancial",
             COUNT(*) FILTER (WHERE s."type" = 'FINANCIAL') AS financial,
             COUNT(*) FILTER (WHERE s."status" = 'COMPLETED') AS completed,
             COUNT(*) FILTER (WHERE s."status" = 'CANCELLED') AS cancelled
      FROM "Support" s
      ${this.whereSql(this.statsConditions(query))}
      GROUP BY 1
      ORDER BY 1 ASC
      LIMIT 1000
    `);

    return {
      interval,
      points: rows.map((r) => ({
        bucket: r.bucket,
        total: this.num(r.total),
        nonFinancial: this.num(r.nonFinancial),
        financial: this.num(r.financial),
        completed: this.num(r.completed),
        cancelled: this.num(r.cancelled),
      })),
    };
  }

  // SP-62
  async getSupportStatsByStatus(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    void admin;
    const rows = await this.prisma.support.groupBy({
      by: ['status'],
      where: this.buildStatsWhere(query),
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });
    const counts = Object.fromEntries(Object.values(SupportStatus).map((s) => [s, 0])) as Record<
      SupportStatus,
      number
    >;
    for (const row of rows) counts[row.status] = (row._count as { _all?: number })?._all ?? 0;
    return { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts };
  }

  // SP-63
  async getSupportStatsByType(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    void admin;
    const rows = await this.prisma.support.groupBy({
      by: ['type'],
      where: this.buildStatsWhere(query),
      _count: { _all: true },
      _sum: { amount: true, recipientAmount: true },
      orderBy: { type: 'asc' },
    });

    const byType = Object.fromEntries(
      Object.values(SupportType).map((t) => [t, { count: 0, amount: 0, recipientAmount: 0 }]),
    ) as Record<SupportType, { count: number; amount: number; recipientAmount: number }>;
    for (const row of rows) {
      byType[row.type] = {
        count: (row._count as { _all?: number })?._all ?? 0,
        amount: Number(row._sum?.amount ?? 0),
        recipientAmount: Number(row._sum?.recipientAmount ?? 0),
      };
    }
    return { byType };
  }

  // SP-64. Hours from the offer being made to it being completed.
  async getSupportStatsFulfilmentTime(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    void admin;
    const conds = [
      ...this.statsConditions(query),
      Prisma.sql`s."status" = 'COMPLETED'`,
      Prisma.sql`s."completedAt" IS NOT NULL`,
    ];
    const secs = Prisma.sql`EXTRACT(EPOCH FROM (s."completedAt" - s."createdAt"))`;

    const [row] = await this.prisma.$queryRaw<
      Array<{
        completed: bigint;
        avg: number | null;
        median: number | null;
        p90: number | null;
        min: number | null;
        max: number | null;
      }>
    >(Prisma.sql`
      SELECT COUNT(*) AS completed,
             AVG(${secs}) AS avg,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${secs}) AS median,
             PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ${secs}) AS p90,
             MIN(${secs}) AS min,
             MAX(${secs}) AS max
      FROM "Support" s
      ${this.whereSql(conds)}
    `);

    const hours = (v: number | null | undefined) =>
      v === null || v === undefined ? null : Number((Number(v) / 3600).toFixed(2));
    return {
      completed: this.num(row?.completed),
      unit: 'hours',
      average: hours(row?.avg),
      median: hours(row?.median),
      p90: hours(row?.p90),
      fastest: hours(row?.min),
      slowest: hours(row?.max),
    };
  }

  // SP-65
  async getSupportStatsCompletionRate(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    const { byStatus, total } = await this.getSupportStatsByStatus(admin, query);
    const completed = byStatus[SupportStatus.COMPLETED];
    const cancelled = byStatus[SupportStatus.CANCELLED];
    const failed = byStatus[SupportStatus.FAILED];
    const closed = completed + cancelled + failed;
    const rate = (n: number) => (closed === 0 ? null : Number((n / closed).toFixed(4)));

    return {
      total,
      open: byStatus[SupportStatus.PENDING] + byStatus[SupportStatus.CONFIRMED],
      closed,
      completed,
      cancelled,
      failed,
      // Shares of the closed offers only, so open ones do not drag the rate down.
      completionRate: rate(completed),
      cancellationRate: rate(cancelled),
      failureRate: rate(failed),
    };
  }

  // SP-66
  async getSupportStatsDisputes(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    void admin;
    const where: Prisma.SupportDisputeWhereInput = { support: this.buildStatsWhere(query) };

    const [byStatus, byOutcome, byReason, bySide, perMonth] = await Promise.all([
      this.prisma.supportDispute.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.supportDispute.groupBy({
        by: ['outcome'],
        where,
        _count: { _all: true },
        orderBy: { outcome: 'asc' },
      }),
      this.prisma.supportDispute.groupBy({
        by: ['reason'],
        where,
        _count: { _all: true },
        orderBy: { reason: 'asc' },
      }),
      this.prisma.supportDispute.groupBy({
        by: ['side'],
        where,
        _count: { _all: true },
        orderBy: { side: 'asc' },
      }),
      this.prisma.$queryRaw<Array<{ bucket: Date; opened: bigint; resolved: bigint }>>(Prisma.sql`
        SELECT date_trunc('month', d."createdAt") AS bucket,
               COUNT(*) AS opened,
               COUNT(*) FILTER (WHERE d."status" = 'RESOLVED') AS resolved
        FROM "support_dispute" d
        JOIN "Support" s ON s."id" = d."supportId"
        ${this.whereSql(this.statsConditions(query))}
        GROUP BY 1
        ORDER BY 1 ASC
        LIMIT 120
      `),
    ]);

    const toMap = <K extends string>(
      rows: Array<{ _count: unknown } & Record<string, unknown>>,
      key: string,
    ) =>
      Object.fromEntries(
        rows.map((r) => [
          String(r[key] ?? 'UNRESOLVED') as K,
          (r._count as { _all?: number })?._all ?? 0,
        ]),
      ) as Record<K, number>;

    const status = toMap<SupportDisputeStatus>(byStatus, 'status');
    return {
      total: Object.values(status).reduce((a, b) => a + b, 0),
      byStatus: status,
      byOutcome: toMap<SupportDisputeOutcome | 'UNRESOLVED'>(byOutcome, 'outcome'),
      byReason: toMap<SupportDisputeReason>(byReason, 'reason'),
      bySide: toMap<SupportDisputeSide>(bySide, 'side'),
      perMonth: perMonth.map((r) => ({
        bucket: r.bucket,
        opened: this.num(r.opened),
        resolved: this.num(r.resolved),
      })),
    };
  }

  // SP-67. Pending offers only; any status filter is ignored because aging only makes sense for PENDING.
  async getSupportStatsAging(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    void admin;
    const base = this.buildStatsWhere({ ...query, status: undefined });
    const now = Date.now();
    const day = 86_400_000;

    const buckets: Array<{ label: string; fromDays: number; toDays: number | null }> = [
      { label: 'under_1_day', fromDays: 0, toDays: 1 },
      { label: '1_to_3_days', fromDays: 1, toDays: 3 },
      { label: '3_to_7_days', fromDays: 3, toDays: 7 },
      { label: '7_to_14_days', fromDays: 7, toDays: 14 },
      { label: 'over_14_days', fromDays: 14, toDays: null },
    ];

    const [counts, oldest] = await Promise.all([
      Promise.all(
        buckets.map((b) =>
          this.prisma.support.count({
            where: {
              AND: [
                base,
                { status: SupportStatus.PENDING },
                {
                  createdAt: {
                    lte: new Date(now - b.fromDays * day),
                    ...(b.toDays !== null ? { gt: new Date(now - b.toDays * day) } : {}),
                  },
                },
              ],
            },
          }),
        ),
      ),
      this.prisma.support.aggregate({
        where: { AND: [base, { status: SupportStatus.PENDING }] },
        _min: { createdAt: true },
      }),
    ]);

    return {
      totalPending: counts.reduce((a, b) => a + b, 0),
      oldestPendingAt: oldest._min.createdAt,
      buckets: buckets.map((b, i) => ({ bucket: b.label, count: counts[i] })),
    };
  }

  // SP-68. The dashboard in one call.
  async getSupportStatsOverview(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    const where = this.buildStatsWhere(query);
    const [status, type, completion, aging, fulfilment, disputes, financial, flagged] =
      await Promise.all([
        this.getSupportStatsByStatus(admin, query),
        this.getSupportStatsByType(admin, query),
        this.getSupportStatsCompletionRate(admin, query),
        this.getSupportStatsAging(admin, query),
        this.getSupportStatsFulfilmentTime(admin, query),
        this.getSupportStatsDisputes(admin, query),
        this.prisma.support.aggregate({
          where: {
            AND: [where, { type: SupportType.FINANCIAL, status: { in: COUNTED_STATUSES } }],
          },
          _sum: { recipientAmount: true, amount: true },
        }),
        this.prisma.support.count({ where: { ...where, flags: { some: {} } } }),
      ]);

    return {
      total: status.total,
      byStatus: status.byStatus,
      byType: type.byType,
      completion,
      aging,
      fulfilment,
      disputes: {
        total: disputes.total,
        open: disputes.byStatus[SupportDisputeStatus.OPEN] ?? 0,
        byOutcome: disputes.byOutcome,
      },
      flagged,
      totalConfirmedAmount: Number(financial._sum.recipientAmount ?? financial._sum.amount ?? 0),
    };
  }
}

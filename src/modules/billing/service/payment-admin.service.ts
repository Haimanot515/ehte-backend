import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditOutcome, AuditSeverity, PaymentStatus, PaymentType, Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditEventEnum } from '../../../common/enums/shared/audit-events.enum';
import { RolesEnum } from '../../../common/enums/roles.enum';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';

import { BillingEventsService } from './billing-events.service';
import { PaymentService } from './payment.service';
import { dec, maskName, money, pageArgs, pageResult, parseMoney } from './billing-admin.helpers';
import {
  ExecuteRefundDto,
  PaymentDisputesQueryDto,
  PaymentSearchQueryDto,
  PagingDto,
  RefundListQueryDto,
  RequestRefundDto,
  ResolvePaymentDisputeDto,
  ReviewQueueQueryDto,
  WebhookEventsQueryDto,
} from '../dto/billing-admin.dto';

// A refund is only possible once the money was actually collected.
const REFUNDABLE_TYPES: PaymentType[] = [
  PaymentType.SUPPORT,
  PaymentType.VICTIM_PROFILE_POSTING_FEE,
  PaymentType.MISSING_PERSON_POSTING_FEE,
];

@Injectable()
export class PaymentAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly events: BillingEventsService,
  ) {}

  private isSuper(admin: CurrentUserDto): boolean {
    return (admin.roles ?? []).includes(RolesEnum.SUPER_ADMIN);
  }

  private async loadPayment(id: string) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('payment_not_found');
    return p;
  }

  // BL-16
  async reconcileNow(adminId: string, txRef: string) {
    const p = await this.prisma.payment.findUnique({
      where: { txRef },
      select: { id: true, status: true },
    });
    if (!p) throw new NotFoundException('payment_not_found');

    const status = await this.payments.reconcile(txRef);

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYMENT_RECONCILED,
      entityType: 'Payment',
      entityId: p.id,
      metadata: { before: p.status, after: status },
    });

    return { txRef, before: p.status, after: status, changed: status !== p.status };
  }

  // Used by ChapaWebhookController. Both calls swallow their own errors so a
  // logging problem can never make the gateway think the webhook failed.
  async recordWebhookEvent(
    body: { tx_ref?: string } & Record<string, unknown>,
  ): Promise<string | null> {
    try {
      const e = await this.prisma.paymentWebhookEvent.create({
        data: {
          txRef: typeof body.tx_ref === 'string' ? body.tx_ref : null,
          payload: body as Prisma.InputJsonValue,
          result: 'RECEIVED',
        },
        select: { id: true },
      });
      return e.id;
    } catch {
      return null;
    }
  }

  async finishWebhookEvent(id: string | null, result: string, error?: string): Promise<void> {
    if (!id) return;
    try {
      await this.prisma.paymentWebhookEvent.update({
        where: { id },
        data: { result, error: error ? error.slice(0, 300) : null, processedAt: new Date() },
      });
    } catch {
      // ignored on purpose
    }
  }

  // BL-17
  async listWebhookEvents(q: WebhookEventsQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.PaymentWebhookEventWhereInput = {
      ...(q.result ? { result: q.result } : {}),
      ...(q.txRef ? { txRef: q.txRef } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.paymentWebhookEvent.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip,
        take: limit,
        // The payload is only in the single-event view.
        select: {
          id: true,
          provider: true,
          txRef: true,
          result: true,
          error: true,
          replayCount: true,
          receivedAt: true,
          processedAt: true,
        },
      }),
      this.prisma.paymentWebhookEvent.count({ where }),
    ]);

    return pageResult(items, total, page, limit);
  }

  // BL-18
  async getWebhookEvent(id: string) {
    const e = await this.prisma.paymentWebhookEvent.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('webhook_event_not_found');
    return e;
  }

  // BL-19. Replaying asks the gateway for the current truth about the payment
  // (reconcile), it never trusts the stored payload as a new instruction.
  async replayWebhookEvent(adminId: string, id: string) {
    const e = await this.getWebhookEvent(id);
    if (!e.txRef) throw new BadRequestException('event_has_no_tx_ref');

    let result = 'RECONCILED';
    let error: string | null = null;
    let status: PaymentStatus | null = null;
    try {
      status = await this.payments.reconcile(e.txRef);
      if (status === null) result = 'IGNORED';
    } catch (err) {
      result = 'ERROR';
      error = String((err as Error).message).slice(0, 300);
    }

    await this.prisma.paymentWebhookEvent.update({
      where: { id },
      data: {
        result,
        error,
        processedAt: new Date(),
        replayCount: { increment: 1 },
        lastReplayedAt: new Date(),
        lastReplayedById: adminId,
      },
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYMENT_WEBHOOK_REPLAYED,
      entityType: 'PaymentWebhookEvent',
      entityId: id,
      outcome: result === 'ERROR' ? AuditOutcome.FAILURE : undefined,
      severity: AuditSeverity.WARNING,
      metadata: { txRef: e.txRef, result, paymentStatus: status },
    });

    return { id, txRef: e.txRef, result, error, paymentStatus: status };
  }

  // BL-20
  async byPayer(admin: CurrentUserDto, q: PagingDto) {
    const { page, limit, skip } = pageArgs(q);

    const [groups, paidGroups, failedGroups, refundedGroups] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['payerUserId'],
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { payerUserId: 'asc' },
      }),
      this.prisma.payment.groupBy({
        by: ['payerUserId'],
        where: { status: PaymentStatus.PAID },
        _sum: { amount: true },
        orderBy: { payerUserId: 'asc' },
      }),
      this.prisma.payment.groupBy({
        by: ['payerUserId'],
        where: { status: { in: [PaymentStatus.FAILED, PaymentStatus.EXPIRED] } },
        _count: { _all: true },
        orderBy: { payerUserId: 'asc' },
      }),
      this.prisma.payment.groupBy({
        by: ['payerUserId'],
        where: { refundStatus: 'REFUNDED' },
        _count: { _all: true },
        orderBy: { payerUserId: 'asc' },
      }),
    ]);

    const paid = new Map(paidGroups.map((g) => [g.payerUserId, g._sum.amount]));
    const failed = new Map(failedGroups.map((g) => [g.payerUserId, g._count._all]));
    const refunded = new Map(refundedGroups.map((g) => [g.payerUserId, g._count._all]));

    const rows = groups
      .map((g) => ({
        payerUserId: g.payerUserId,
        paymentsCount: g._count._all,
        totalPaid: money(paid.get(g.payerUserId)),
        failedCount: failed.get(g.payerUserId) ?? 0,
        refundedCount: refunded.get(g.payerUserId) ?? 0,
        lastPaymentAt: g._max.createdAt,
      }))
      .sort((a, b) => (b.lastPaymentAt?.getTime() ?? 0) - (a.lastPaymentAt?.getTime() ?? 0));

    const pageRows = rows.slice(skip, skip + limit);
    const users = await this.prisma.user.findMany({
      where: { id: { in: pageRows.map((r) => r.payerUserId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const superAdmin = this.isSuper(admin);

    return pageResult(
      pageRows.map((r) => ({
        ...r,
        payerName: maskName(nameById.get(r.payerUserId), superAdmin),
      })),
      rows.length,
      page,
      limit,
    );
  }

  // BL-21
  async payerPayments(payerUserId: string, q: PagingDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.PaymentWhereInput = { payerUserId };

    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          txRef: true,
          type: true,
          status: true,
          amount: true,
          currency: true,
          refundStatus: true,
          victimProfileId: true,
          missingPersonId: true,
          paidAt: true,
          createdAt: true,
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return pageResult(items, total, page, limit);
  }

  // BL-22
  async profilePayments(profileId: string, q: PagingDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.PaymentWhereInput = { victimProfileId: profileId };

    const [items, total, paid, allocations] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          txRef: true,
          type: true,
          status: true,
          amount: true,
          chapaFee: true,
          supportAnonymous: true,
          paidAt: true,
        },
      }),
      this.prisma.payment.count({ where }),
      this.prisma.payment.aggregate({
        where: { ...where, status: PaymentStatus.PAID },
        _sum: { amount: true, chapaFee: true },
        _count: { _all: true },
      }),
      this.prisma.paymentAllocation.groupBy({
        by: ['partyType', 'settlementStatus'],
        where: { payment: { victimProfileId: profileId, status: PaymentStatus.PAID } },
        _sum: { amount: true },
        orderBy: [{ partyType: 'asc' }, { settlementStatus: 'asc' }],
      }),
    ]);

    return {
      totals: {
        paidCount: paid._count._all,
        gross: money(paid._sum.amount),
        gatewayFees: money(paid._sum.chapaFee),
        allocations: allocations.map((a) => ({
          partyType: a.partyType,
          settlementStatus: a.settlementStatus,
          amount: money(a._sum.amount),
        })),
      },
      ...pageResult(items, total, page, limit),
    };
  }

  // BL-23
  async reviewQueue(q: ReviewQueueQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.PaymentWhereInput = {
      status: PaymentStatus.REVIEW_REQUIRED,
      ...(q.type ? { type: q.type } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { updatedAt: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          txRef: true,
          type: true,
          amount: true,
          currency: true,
          payerUserId: true,
          victimProfileId: true,
          missingPersonId: true,
          updatedAt: true,
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return pageResult(
      items.map((i) => ({
        ...i,
        waitingHours: Math.floor((Date.now() - i.updatedAt.getTime()) / 3_600_000),
      })),
      total,
      page,
      limit,
    );
  }

  // BL-29
  async search(q: PaymentSearchQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const term = q.q.trim();
    const where: Prisma.PaymentWhereInput = {
      OR: [
        { txRef: { contains: term, mode: 'insensitive' } },
        { chapaReference: { contains: term, mode: 'insensitive' } },
        { id: term },
        { payerUserId: term },
        { victimProfileId: term },
        { missingPersonId: term },
      ],
    };

    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          txRef: true,
          chapaReference: true,
          type: true,
          status: true,
          amount: true,
          payerUserId: true,
          victimProfileId: true,
          missingPersonId: true,
          createdAt: true,
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return pageResult(items, total, page, limit);
  }

  // BL-24
  async hold(adminId: string, id: string, reason: string) {
    const p = await this.loadPayment(id);
    if (p.status !== PaymentStatus.PAID) {
      throw new BadRequestException('only_paid_payments_can_be_held');
    }
    if (p.heldAt) throw new ConflictException('payment_already_held');

    await this.prisma.payment.update({
      where: { id },
      data: { heldAt: new Date(), holdReason: reason, heldById: adminId },
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYMENT_HELD,
      entityType: 'Payment',
      entityId: id,
      reason,
      severity: AuditSeverity.WARNING,
    });

    return { id, held: true };
  }

  // BL-25
  async release(adminId: string, id: string, reason: string) {
    const p = await this.loadPayment(id);
    if (!p.heldAt) throw new BadRequestException('payment_is_not_held');

    await this.prisma.payment.update({
      where: { id },
      data: { heldAt: null, holdReason: null, heldById: null },
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYMENT_RELEASED,
      entityType: 'Payment',
      entityId: id,
      reason,
      metadata: { heldById: p.heldById, heldAt: p.heldAt },
    });

    return { id, held: false };
  }

  // BL-26
  async timeline(id: string) {
    const p = await this.loadPayment(id);

    const [audit, hooks, disputes] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { entity: 'Payment', entityId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          createdAt: true,
          action: true,
          outcome: true,
          reason: true,
          userId: true,
          actorType: true,
        },
      }),
      this.prisma.paymentWebhookEvent.findMany({
        where: { txRef: p.txRef },
        orderBy: { receivedAt: 'asc' },
        select: { receivedAt: true, result: true, error: true, replayCount: true },
      }),
      this.prisma.paymentDispute.findMany({
        where: { paymentId: id },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, status: true, outcome: true, resolvedAt: true },
      }),
    ]);

    const entries = [
      ...audit.map((a) => ({
        at: a.createdAt,
        source: 'audit' as const,
        event: a.action,
        outcome: a.outcome,
        reason: a.reason,
        actorId: a.userId,
        actorType: a.actorType,
      })),
      ...hooks.map((h) => ({
        at: h.receivedAt,
        source: 'webhook' as const,
        event: `webhook_${h.result.toLowerCase()}`,
        outcome: h.error ? 'FAILURE' : 'SUCCESS',
        reason: h.error,
        actorId: null,
        actorType: 'SYSTEM',
      })),
      ...disputes.map((d) => ({
        at: d.createdAt,
        source: 'dispute' as const,
        event: `dispute_${d.status.toLowerCase()}`,
        outcome: d.outcome ?? 'OPEN',
        reason: null,
        actorId: null,
        actorType: 'USER',
      })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());

    return {
      payment: {
        id: p.id,
        txRef: p.txRef,
        status: p.status,
        type: p.type,
        amount: money(p.amount),
        refundStatus: p.refundStatus,
        heldAt: p.heldAt,
      },
      entries,
    };
  }

  // BL-27
  async listDisputes(q: PaymentDisputesQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.PaymentDisputeWhereInput = { status: q.status ?? 'OPEN' };

    const [items, total] = await Promise.all([
      this.prisma.paymentDispute.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: {
          payment: {
            select: { txRef: true, type: true, status: true, amount: true, refundStatus: true },
          },
        },
      }),
      this.prisma.paymentDispute.count({ where }),
    ]);

    return pageResult(items, total, page, limit);
  }

  // BL-28. Upholding a dispute does not refund by itself, a refund is a
  // separate, two-admin step (BL-30, BL-33).
  async resolveDispute(adminId: string, disputeId: string, dto: ResolvePaymentDisputeDto) {
    const d = await this.prisma.paymentDispute.findUnique({ where: { id: disputeId } });
    if (!d) throw new NotFoundException('dispute_not_found');
    if (d.status !== 'OPEN') throw new ConflictException('dispute_already_resolved');

    const { count } = await this.prisma.paymentDispute.updateMany({
      where: { id: disputeId, status: 'OPEN' },
      data: {
        status: 'RESOLVED',
        outcome: dto.outcome,
        resolutionNote: dto.note,
        resolvedByUserId: adminId,
        resolvedAt: new Date(),
      },
    });
    if (count === 0) throw new ConflictException('dispute_already_resolved');

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYMENT_DISPUTE_RESOLVED,
      entityType: 'Payment',
      entityId: d.paymentId,
      reason: dto.note,
      metadata: { disputeId, outcome: dto.outcome },
    });

    return {
      id: disputeId,
      status: 'RESOLVED',
      outcome: dto.outcome,
      nextStep: dto.outcome === 'UPHELD' ? 'create_a_refund_if_money_is_owed' : null,
    };
  }

  // BL-30. Records a refund REQUEST. No money moves until BL-33.
  async requestRefund(adminId: string, paymentId: string, dto: RequestRefundDto) {
    const p = await this.loadPayment(paymentId);

    if (p.status !== PaymentStatus.PAID) {
      throw new BadRequestException('only_paid_payments_can_be_refunded');
    }
    if (!REFUNDABLE_TYPES.includes(p.type)) {
      throw new BadRequestException('use_the_reward_close_flow_for_reward_payments');
    }
    if (p.refundStatus === 'REQUESTED' || p.refundStatus === 'REFUNDED') {
      throw new ConflictException('refund_already_requested_or_done');
    }

    const amount = dto.amount ? parseMoney(dto.amount) : p.amount;
    if (amount.gt(p.amount)) throw new BadRequestException('refund_exceeds_payment_amount');

    const processing = await this.prisma.disbursement.count({
      where: { allocation: { paymentId }, status: 'PROCESSING' },
    });
    if (processing > 0) throw new ConflictException('a_payout_is_in_progress');

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        refundStatus: 'REQUESTED',
        refundAmount: amount,
        refundReason: dto.reason,
        refundRequestedById: adminId,
        refundRequestedAt: new Date(),
        refundDecidedById: null,
      },
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYMENT_REFUND_REQUESTED,
      entityType: 'Payment',
      entityId: paymentId,
      reason: dto.reason,
      severity: AuditSeverity.WARNING,
      metadata: { amount: amount.toFixed(2), full: amount.eq(p.amount) },
    });

    return { paymentId, refundStatus: 'REQUESTED', refundAmount: money(amount) };
  }

  // BL-31
  async listRefunds(q: RefundListQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.PaymentWhereInput = {
      refundStatus: q.status ?? 'REQUESTED',
      ...(q.type ? { type: q.type } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { refundRequestedAt: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          txRef: true,
          type: true,
          amount: true,
          refundStatus: true,
          refundAmount: true,
          refundReason: true,
          refundRequestedById: true,
          refundRequestedAt: true,
          refundedAt: true,
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return pageResult(items, total, page, limit);
  }

  // BL-32
  async getRefund(paymentId: string) {
    const p = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        allocations: {
          include: { disbursements: { select: { id: true, status: true, amount: true } } },
        },
        disputes: true,
      },
    });
    if (!p || !p.refundStatus) throw new NotFoundException('refund_not_found');
    return p;
  }

  // BL-33. Core of the money movement. One transaction.
  async executeRefund(admin: CurrentUserDto, paymentId: string, dto: ExecuteRefundDto) {
    const p = await this.loadPayment(paymentId);

    if (p.refundStatus !== 'REQUESTED')
      throw new BadRequestException('no_refund_is_awaiting_execution');
    if (p.refundRequestedById === admin.id) {
      throw new ForbiddenException('refund_must_be_executed_by_a_different_admin');
    }
    if (p.status !== PaymentStatus.PAID) throw new BadRequestException('payment_is_not_paid');
    if (p.heldAt) throw new ConflictException('payment_is_on_hold');

    const refundAmount = dec(p.refundAmount);
    const full = refundAmount.gte(p.amount);

    const result = await this.prisma.$transaction(async (tx) => {
      const allocations = await tx.paymentAllocation.findMany({
        where: { paymentId },
        include: { disbursements: true },
      });
      const disbursements = allocations.flatMap((a) => a.disbursements);

      if (disbursements.some((d) => d.status === 'PROCESSING')) {
        throw new ConflictException('a_payout_is_in_progress');
      }

      if (full) {
        if (disbursements.some((d) => d.status === 'PAID_OUT')) {
          throw new ConflictException('money_was_already_paid_out_use_a_partial_refund');
        }
      } else {
        const unsettled = allocations.some(
          (a) => a.settlementStatus !== 'PAID_OUT' && a.settlementStatus !== 'CANCELLED',
        );
        if (unsettled) throw new BadRequestException('partial_refund_requires_settled_allocations');
      }

      // Only the first writer wins.
      const { count } = await tx.payment.updateMany({
        where: { id: paymentId, refundStatus: 'REQUESTED', status: PaymentStatus.PAID },
        data: {
          refundStatus: 'REFUNDED',
          refundedAt: new Date(),
          refundReference: dto.reference,
          refundDecidedById: admin.id,
          ...(full ? { status: PaymentStatus.REFUNDED } : {}),
        },
      });
      if (count === 0) throw new ConflictException('refund_already_processed');

      let cancelledDisbursements = 0;
      if (full) {
        const cancelled = await tx.disbursement.updateMany({
          where: {
            allocation: { paymentId },
            status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
          },
          data: { status: 'CANCELLED', failureReason: 'payment_refunded' },
        });
        cancelledDisbursements = cancelled.count;

        await tx.paymentAllocation.updateMany({
          where: { paymentId },
          data: { settlementStatus: 'CANCELLED' },
        });

        if (p.type === PaymentType.SUPPORT && p.supportId) {
          await tx.support.updateMany({
            where: { id: p.supportId },
            data: { status: 'CANCELLED' },
          });
        }
        if (p.type === PaymentType.VICTIM_PROFILE_POSTING_FEE && p.victimProfileId) {
          await tx.victimProfile.updateMany({
            where: { id: p.victimProfileId },
            data: { postingFeeStatus: 'REFUNDED' },
          });
        }
        if (p.type === PaymentType.MISSING_PERSON_POSTING_FEE && p.missingPersonId) {
          await tx.missingPerson.updateMany({
            where: { id: p.missingPersonId },
            data: { postingFeeStatus: 'REFUNDED' },
          });
        }
      }

      return { cancelledDisbursements };
    });

    await this.events.log({
      actorId: admin.id,
      action: AuditEventEnum.PAYMENT_REFUND_EXECUTED,
      entityType: 'Payment',
      entityId: paymentId,
      severity: AuditSeverity.WARNING,
      metadata: {
        amount: refundAmount.toFixed(2),
        full,
        reference: dto.reference,
        requestedById: p.refundRequestedById,
        cancelledDisbursements: result.cancelledDisbursements,
        method: 'MANUAL',
      },
    });

    return {
      paymentId,
      refundStatus: 'REFUNDED',
      refundAmount: money(refundAmount),
      full,
      cancelledDisbursements: result.cancelledDisbursements,
    };
  }

  // BL-34
  async rejectRefund(adminId: string, paymentId: string, reason: string) {
    const p = await this.loadPayment(paymentId);
    if (p.refundStatus !== 'REQUESTED')
      throw new BadRequestException('no_refund_is_awaiting_execution');

    const { count } = await this.prisma.payment.updateMany({
      where: { id: paymentId, refundStatus: 'REQUESTED' },
      data: { refundStatus: 'REJECTED', refundDecidedById: adminId },
    });
    if (count === 0) throw new ConflictException('refund_already_processed');

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYMENT_REFUND_REJECTED,
      entityType: 'Payment',
      entityId: paymentId,
      reason,
    });

    return { paymentId, refundStatus: 'REJECTED' };
  }

  // BL-35. Puts a FAILED or REJECTED refund back in the queue.
  async retryRefund(adminId: string, paymentId: string) {
    const p = await this.loadPayment(paymentId);
    if (p.refundStatus !== 'FAILED' && p.refundStatus !== 'REJECTED') {
      throw new BadRequestException('only_failed_or_rejected_refunds_can_be_retried');
    }
    if (p.status !== PaymentStatus.PAID) throw new BadRequestException('payment_is_not_paid');

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        refundStatus: 'REQUESTED',
        // The person who re-queues it becomes the requester, so they cannot execute it.
        refundRequestedById: adminId,
        refundRequestedAt: new Date(),
        refundDecidedById: null,
      },
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYMENT_REFUND_RESET,
      entityType: 'Payment',
      entityId: paymentId,
      metadata: { previous: p.refundStatus },
    });

    return { paymentId, refundStatus: 'REQUESTED' };
  }

  // BL-36. Each item succeeds or fails on its own.
  async bulkExecuteRefunds(
    admin: CurrentUserDto,
    items: { paymentId: string; reference: string }[],
  ) {
    const results: Array<{ paymentId: string; ok: boolean; error?: string }> = [];

    for (const item of items) {
      try {
        await this.executeRefund(admin, item.paymentId, { reference: item.reference });
        results.push({ paymentId: item.paymentId, ok: true });
      } catch (err) {
        const message = (err as { message?: string }).message ?? 'failed';
        results.push({ paymentId: item.paymentId, ok: false, error: message });
      }
    }

    return {
      requested: items.length,
      succeeded: results.filter((r) => r.ok).length,
      results,
    };
  }
}

// src/modules/billing/service/payer-billing.service.ts
//
// User-facing additions: receipts, retry, payer summary and statement, payer
// disputes (BL-01, BL-02, BL-04 to BL-08) and informant reward views and
// appeals (BL-09, BL-13 to BL-15).
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentStatus, PaymentType, Prisma, RewardClaimStatus } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditEventEnum } from '../../../common/enums/shared/audit-events.enum';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';

import { BillingEventsService } from './billing-events.service';
import { PaymentService } from './payment.service';
import { dec, money } from './billing-admin.helpers';
import { CreateRewardAppealDto, OpenPaymentDisputeDto } from '../dto/billing-admin.dto';

// Claim decisions an informant may appeal.
const APPEALABLE_CLAIM_STATUSES: RewardClaimStatus[] = [
  RewardClaimStatus.INVALID,
  RewardClaimStatus.INELIGIBLE,
];

// Audit actions an informant is allowed to see on their own claim timeline.
const INFORMANT_VISIBLE_ACTIONS: string[] = [
  AuditEventEnum.REWARD_CLAIM_CREATED,
  AuditEventEnum.REWARD_CLAIM_DECIDED,
  AuditEventEnum.REWARD_CLAIM_APPROVED,
  AuditEventEnum.REWARD_CLAIM_REOPENED,
  AuditEventEnum.REWARD_CLAIM_APPEALED,
  AuditEventEnum.REWARD_APPEAL_DECIDED,
];

@Injectable()
export class PayerBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly events: BillingEventsService,
  ) {}

  // ─────────────────────────────────────────────
  // BL-01  Receipt
  // ─────────────────────────────────────────────
  async receipt(userId: string, paymentId: string) {
    const p = await this.prisma.payment.findFirst({
      where: { id: paymentId, payerUserId: userId },
    });
    if (!p) throw new NotFoundException('payment_not_found');
    if (p.status !== PaymentStatus.PAID && p.status !== PaymentStatus.REFUNDED) {
      throw new BadRequestException('receipt_available_after_payment');
    }

    return {
      receiptNumber: p.txRef,
      issuedAt: new Date().toISOString(),
      paymentId: p.id,
      type: p.type,
      status: p.status,
      amount: money(p.amount),
      currency: p.currency,
      paidAt: p.paidAt,
      gatewayReference: p.chapaReference,
      // Anonymous support stays anonymous on the receipt too.
      supportAnonymous: p.type === PaymentType.SUPPORT ? p.supportAnonymous : null,
      victimProfileId: p.victimProfileId,
      missingPersonId: p.missingPersonId,
      refund:
        p.refundStatus === 'REFUNDED'
          ? { amount: money(p.refundAmount), refundedAt: p.refundedAt }
          : null,
    };
  }

  // ─────────────────────────────────────────────
  // BL-02  Retry a failed or expired checkout
  // ─────────────────────────────────────────────
  async retry(user: CurrentUserDto, txRef: string) {
    const p = await this.prisma.payment.findFirst({
      where: { txRef, payerUserId: user.id },
    });
    if (!p) throw new NotFoundException('payment_not_found');
    if (p.status !== PaymentStatus.FAILED && p.status !== PaymentStatus.EXPIRED) {
      throw new BadRequestException('only_failed_or_expired_payments_can_be_retried');
    }

    // The money is not collected for these statuses, so starting a new
    // checkout through the normal flow is safe. It creates a new payment.
    switch (p.type) {
      case PaymentType.SUPPORT:
        if (!p.victimProfileId) throw new BadRequestException('payment_has_no_profile');
        return this.payments.initiateSupportCheckout(
          user,
          p.victimProfileId,
          p.amount.toFixed(2),
          p.supportAnonymous,
        );
      case PaymentType.MISSING_PERSON_REWARD:
        if (!p.missingPersonId) throw new BadRequestException('payment_has_no_case');
        return this.payments.initiateRewardFunding(user, p.missingPersonId);
      case PaymentType.VICTIM_PROFILE_POSTING_FEE:
        if (!p.victimProfileId) throw new BadRequestException('payment_has_no_profile');
        return this.payments.initiatePostingFeeCheckout(user, 'VICTIM_PROFILE', p.victimProfileId);
      case PaymentType.MISSING_PERSON_POSTING_FEE:
        if (!p.missingPersonId) throw new BadRequestException('payment_has_no_case');
        return this.payments.initiatePostingFeeCheckout(user, 'MISSING_PERSON', p.missingPersonId);
      default:
        throw new BadRequestException('payment_type_not_retryable');
    }
  }

  // ─────────────────────────────────────────────
  // BL-04  My totals by type and status
  // ─────────────────────────────────────────────
  async summary(userId: string) {
    const rows = await this.prisma.payment.groupBy({
      by: ['type', 'status'],
      where: { payerUserId: userId },
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: [{ type: 'asc' }, { status: 'asc' }],
    });

    return {
      groups: rows.map((r) => ({
        type: r.type,
        status: r.status,
        count: r._count._all,
        amount: money(r._sum.amount),
      })),
    };
  }

  // ─────────────────────────────────────────────
  // BL-05  What I gave
  // ─────────────────────────────────────────────
  async stats(userId: string) {
    const paid = { payerUserId: userId, status: PaymentStatus.PAID };

    const [total, supportTotal, profiles, lastPaid] = await Promise.all([
      this.prisma.payment.aggregate({
        where: paid,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.payment.aggregate({
        where: { ...paid, type: PaymentType.SUPPORT },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.payment.findMany({
        where: { ...paid, type: PaymentType.SUPPORT, victimProfileId: { not: null } },
        distinct: ['victimProfileId'],
        select: { victimProfileId: true },
      }),
      this.prisma.payment.findFirst({
        where: paid,
        orderBy: { paidAt: 'desc' },
        select: { paidAt: true },
      }),
    ]);

    return {
      paymentsCount: total._count._all,
      totalPaid: money(total._sum.amount),
      supportCount: supportTotal._count._all,
      supportTotal: money(supportTotal._sum.amount),
      profilesSupported: profiles.length,
      lastPaidAt: lastPaid?.paidAt ?? null,
    };
  }

  // ─────────────────────────────────────────────
  // BL-06  Dispute a charge
  // ─────────────────────────────────────────────
  async openDispute(userId: string, paymentId: string, dto: OpenPaymentDisputeDto) {
    const p = await this.prisma.payment.findFirst({
      where: { id: paymentId, payerUserId: userId },
      select: { id: true, status: true, txRef: true },
    });
    if (!p) throw new NotFoundException('payment_not_found');
    if (p.status === PaymentStatus.PENDING) {
      throw new BadRequestException('payment_still_pending');
    }

    const open = await this.prisma.paymentDispute.findFirst({
      where: { paymentId, status: 'OPEN' },
      select: { id: true },
    });
    if (open) throw new ConflictException('dispute_already_open');

    const dispute = await this.prisma.paymentDispute.create({
      data: { paymentId, payerUserId: userId, reason: dto.reason },
    });

    await this.events.log({
      actorId: userId,
      action: AuditEventEnum.PAYMENT_DISPUTE_OPENED,
      entityType: 'Payment',
      entityId: paymentId,
      reason: dto.reason,
      metadata: { disputeId: dispute.id, txRef: p.txRef },
    });

    return { id: dispute.id, status: dispute.status, createdAt: dispute.createdAt };
  }

  // ─────────────────────────────────────────────
  // BL-07  Refund status for my payment
  // ─────────────────────────────────────────────
  async refundStatus(userId: string, paymentId: string) {
    const p = await this.prisma.payment.findFirst({
      where: { id: paymentId, payerUserId: userId },
      select: {
        id: true,
        status: true,
        amount: true,
        refundStatus: true,
        refundAmount: true,
        refundedAt: true,
        disputes: { select: { id: true, status: true, outcome: true, createdAt: true } },
      },
    });
    if (!p) throw new NotFoundException('payment_not_found');

    // The refund reason and reviewer stay internal.
    return {
      paymentId: p.id,
      paymentStatus: p.status,
      refundStatus: p.refundStatus ?? 'NONE',
      refundAmount: p.refundAmount ? money(p.refundAmount) : null,
      refundedAt: p.refundedAt,
      disputes: p.disputes,
    };
  }

  // ─────────────────────────────────────────────
  // BL-08  Yearly statement
  // ─────────────────────────────────────────────
  async annualStatement(userId: string, year?: number) {
    const y = year ?? new Date().getUTCFullYear();
    const from = new Date(Date.UTC(y, 0, 1));
    const to = new Date(Date.UTC(y + 1, 0, 1));

    const rows = await this.prisma.payment.findMany({
      where: {
        payerUserId: userId,
        status: { in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] },
        paidAt: { gte: from, lt: to },
      },
      orderBy: { paidAt: 'asc' },
      select: {
        id: true,
        txRef: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        paidAt: true,
        refundStatus: true,
        refundAmount: true,
      },
    });

    let given = dec(0);
    let refunded = dec(0);
    const byType: Record<string, Prisma.Decimal> = {};

    for (const r of rows) {
      given = given.add(r.amount);
      byType[r.type] = (byType[r.type] ?? dec(0)).add(r.amount);
      if (r.refundStatus === 'REFUNDED') refunded = refunded.add(r.refundAmount ?? 0);
    }

    return {
      year: y,
      currency: 'ETB',
      totalGiven: money(given),
      totalRefunded: money(refunded),
      netGiven: money(given.sub(refunded)),
      byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, money(v)])),
      items: rows.map((r) => ({
        paymentId: r.id,
        receiptNumber: r.txRef,
        type: r.type,
        status: r.status,
        amount: money(r.amount),
        paidAt: r.paidAt,
        refundedAmount: r.refundStatus === 'REFUNDED' ? money(r.refundAmount) : null,
      })),
    };
  }

  // ═════════════════════════════════════════════
  // INFORMANT REWARD VIEWS
  // ═════════════════════════════════════════════

  private async ownClaim(userId: string, claimId: string) {
    const claim = await this.prisma.rewardClaim.findFirst({
      where: { id: claimId, informantUserId: userId },
    });
    if (!claim) throw new NotFoundException('reward_claim_not_found');
    return claim;
  }

  // BL-09
  async myClaim(userId: string, claimId: string) {
    const c = await this.ownClaim(userId, claimId);
    const appeals = await this.prisma.rewardClaimAppeal.findMany({
      where: { claimId, informantUserId: userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, decisionNote: true, createdAt: true, decidedAt: true },
    });

    // Scores, weights and reviewer identity stay internal.
    return {
      id: c.id,
      missingPersonId: c.missingPersonId,
      status: c.status,
      decisionReason: c.decisionReason,
      rewardPercentage: c.rewardPercentage ? c.rewardPercentage.toString() : null,
      rewardAmount: c.rewardAmount ? money(c.rewardAmount) : null,
      reviewedAt: c.reviewedAt,
      approvedAt: c.approvedAt,
      createdAt: c.createdAt,
      canAppeal:
        APPEALABLE_CLAIM_STATUSES.includes(c.status) &&
        !appeals.some((a) => a.status === 'OPEN'),
      appeals,
    };
  }

  // BL-15
  async myClaimsSummary(userId: string) {
    const rows = await this.prisma.rewardClaim.groupBy({
      by: ['status'],
      where: { informantUserId: userId },
      _count: { _all: true },
      _sum: { rewardAmount: true },
      orderBy: { status: 'asc' },
    });

    const paid = rows.find((r) => r.status === RewardClaimStatus.PAID_OUT);

    return {
      total: rows.reduce((n, r) => n + r._count._all, 0),
      byStatus: rows.map((r) => ({ status: r.status, count: r._count._all })),
      totalPaid: money(paid?._sum.rewardAmount),
    };
  }

  // BL-14
  async myClaimTimeline(userId: string, claimId: string) {
    const c = await this.ownClaim(userId, claimId);

    const rows = await this.prisma.auditLog.findMany({
      where: {
        entity: 'RewardClaim',
        entityId: c.id,
        action: { in: INFORMANT_VISIBLE_ACTIONS },
        outcome: 'SUCCESS',
      },
      orderBy: { createdAt: 'asc' },
      select: { action: true, createdAt: true, metadata: true },
    });

    return {
      claimId: c.id,
      events: rows.map((r) => ({
        at: r.createdAt,
        event: r.action,
        // Only the decision label is shown, never scores or reviewer notes.
        decision:
          r.action === AuditEventEnum.REWARD_CLAIM_DECIDED
            ? ((r.metadata as Record<string, unknown> | null)?.decision ?? null)
            : null,
      })),
    };
  }

  // BL-13
  async appeal(userId: string, claimId: string, dto: CreateRewardAppealDto) {
    const c = await this.ownClaim(userId, claimId);

    if (!APPEALABLE_CLAIM_STATUSES.includes(c.status)) {
      throw new BadRequestException('claim_status_cannot_be_appealed');
    }

    const open = await this.prisma.rewardClaimAppeal.findFirst({
      where: { claimId, status: 'OPEN' },
      select: { id: true },
    });
    if (open) throw new ConflictException('appeal_already_open');

    const appeal = await this.prisma.rewardClaimAppeal.create({
      data: { claimId, informantUserId: userId, message: dto.message },
    });

    await this.events.log({
      actorId: userId,
      action: AuditEventEnum.REWARD_CLAIM_APPEALED,
      entityType: 'RewardClaim',
      entityId: claimId,
      metadata: { appealId: appeal.id, claimStatus: c.status },
    });

    return { id: appeal.id, status: appeal.status, createdAt: appeal.createdAt };
  }
}

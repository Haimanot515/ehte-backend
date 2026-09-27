// src/modules/billing/service/funding-query.service.ts
// Read side only — no writes here. Backs every endpoint in section 3 of the billing review
// except the two mutations (resolve-review stays on PaymentService; cancel/refund stay on
// DisbursementService / RewardService). This file is new; it does not replace any of those.
// DESIGN RULE (section 4): one source of truth. Every total here is computed from
// Payment(status=PAID) and PaymentAllocation — never from Support.amount/recipientAmount and
// never from VictimProfile.totalRaised, which section 4 and G22 flag as a cache that can drift.
// Money is always returned as a decimal string, never a JS number (G22's Number() bug).
// G43 RESOLVED (Sep 2026 migration): RewardClaim now has a real FK to MissingPerson and a
// unique(missingPersonId, informationSubmissionId), plus its own informantUserId column, so
// "my reward claims" for a finder is a plain findMany() again — no more hand-joining through
// InformationSubmission. RewardClaim is also no longer one row per case (see
// reward-claim.prisma): a case can have several informants, so several of the queries below
// changed from findUnique({missingPersonId}) to findMany / aggregate.

import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, InformationStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChapaService } from '../../../services/chapa/chapa.service';

// Decimal fields always leave this service as strings — never Number().
const money = (d: Prisma.Decimal | number | null | undefined): string =>
  d == null ? '0.00' : new Prisma.Decimal(d).toFixed(2);

const paginate = (page = 1, limit = 20) => ({ skip: (page - 1) * limit, take: limit });

@Injectable()
export class FundingQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chapa: ChapaService,
  ) {}

  // ── PUBLIC ────────────────────────────────────────────────────────────

  // GET billing/public/victim-profiles/:id/funding
  async getPublicProfileFunding(profileId: string) {
    const profile = await this.prisma.victimProfile.findFirst({
      where: { id: profileId, isPublished: true },
      select: { id: true, supportGoal: true },
    });
    if (!profile) throw new NotFoundException('Profile not found');

    const [agg, payers] = await Promise.all([
      this.prisma.payment.aggregate({
        // SUPPORT only — see the same note in getProfileFundingBreakdown().
        where: { victimProfileId: profileId, type: 'SUPPORT', status: 'PAID' },
        _sum: { amount: true },
        _max: { paidAt: true },
      }),
      this.prisma.payment.groupBy({
        by: ['payerUserId'],
        where: { victimProfileId: profileId, type: 'SUPPORT', status: 'PAID' },
      }),
    ]);

    const raised = new Prisma.Decimal(agg._sum.amount ?? 0);
    const goal = profile.supportGoal ? new Prisma.Decimal(profile.supportGoal) : null;

    return {
      raised: money(raised),
      goal: goal ? money(goal) : null,
      // Capped at 1: a profile can be over-funded once split rules and rounding are in the
      // mix, and the public bar shouldn't show >100%.
      progress: goal && goal.gt(0) ? Math.min(1, raised.div(goal).toNumber()) : null,
      supporterCount: payers.length,
      lastSupportedAt: agg._max.paidAt ?? null,
    };
  }

  // GET billing/public/missing-persons/:id/reward
  // Coarse on purpose: no amount breakdown, no claim/finder detail.
  async getPublicRewardFunding(missingPersonId: string) {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: { id: true, rewardOffered: true, rewardApproved: true, rewardAmount: true },
    });
    if (!mp || !mp.rewardOffered) throw new NotFoundException('No reward offered on this case');

    const paid = await this.prisma.payment.aggregate({
      where: { missingPersonId, type: 'MISSING_PERSON_REWARD', status: 'PAID' },
      _sum: { amount: true },
    });
    const funded = new Prisma.Decimal(paid._sum.amount ?? 0).gt(0);

    let status: 'OFFERED' | 'APPROVED' | 'FUNDED' | 'CLAIMED' = 'OFFERED';
    if (funded) status = 'FUNDED';
    if (mp.rewardApproved) status = funded ? 'FUNDED' : 'APPROVED';
    if (funded) {
      const anyPaidOut = await this.prisma.rewardClaim.findFirst({
        where: { missingPersonId, status: { in: ['APPROVED_FOR_REWARD', 'PAID_OUT'] } },
        select: { id: true },
      });
      if (anyPaidOut) status = 'CLAIMED';
    }

    return {
      amount: mp.rewardAmount ?? null, // whole ETB, per schema comment — no decimals to format
      funded,
      status,
    };
  }

  // ── DONOR ────────────────────────────────────────────────────────────

  // GET payments/mine
  async getMyPayments(userId: string, page = 1, limit = 20) {
    const where: Prisma.PaymentWhereInput = { payerUserId: userId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          status: true,
          amount: true,
          currency: true,
          victimProfileId: true,
          missingPersonId: true,
          supportId: true,
          createdAt: true,
          paidAt: true,
        },
        ...paginate(page, limit),
      }),
      this.prisma.payment.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({ ...r, amount: money(r.amount) })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // GET payments/mine/:id — receipt view
  // Includes the allocation snapshot shown at checkout time (Payment.allocationSnapshot) so
  // the receipt matches what the donor actually agreed to pay.
  async getMyPaymentById(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, payerUserId: userId },
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        chapaReference: true,
        victimProfileId: true,
        missingPersonId: true,
        supportId: true,
        allocationSnapshot: true,
        createdAt: true,
        paidAt: true,
        allocations: {
          select: { partyType: true, amount: true, institutionId: true, settlementStatus: true },
        },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return {
      ...payment,
      amount: money(payment.amount),
      allocations: payment.allocations.map((a) => ({ ...a, amount: money(a.amount) })),
    };
  }

  // ── CASE OWNER ───────────────────────────────────────────────────────

  // GET missing-persons/mine/:id/reward
  async getMyRewardFunding(userId: string, missingPersonId: string) {
    const mp = await this.prisma.missingPerson.findFirst({
      where: { id: missingPersonId, userId },
      select: {
        id: true,
        rewardOffered: true,
        rewardApproved: true,
        rewardAmount: true,
        rewardDetails: true,
        fundingMethod: true,
        fundingStatus: true,
        fundedAmount: true,
      },
    });
    if (!mp) throw new NotFoundException('Case not found');

    // A case can have several informants (section 11), so this is every claim
    // on the case, not "the" claim — the case owner sees the whole picture.
    const claims = await this.prisma.rewardClaim.findMany({
      where: { missingPersonId },
      select: { id: true, status: true, rewardPercentage: true, rewardAmount: true, approvedAt: true },
      orderBy: { createdAt: 'asc' },
    });

    return {
      rewardOffered: mp.rewardOffered,
      rewardApproved: mp.rewardApproved,
      rewardAmount: mp.rewardAmount,
      rewardDetails: mp.rewardDetails,
      fundingMethod: mp.fundingMethod,
      fundingStatus: mp.fundingStatus,
      funded: money(mp.fundedAmount),
      claims,
      // Case-level refund state now lives on MissingPerson.fundingStatus (section 21) —
      // a single claim's own REFUND_DUE/REFUNDED only ever concerns that claim's share.
      refundState: mp.fundingStatus === 'REFUND_DUE' || mp.fundingStatus === 'REFUNDED' ? mp.fundingStatus : null,
    };
  }

  // ── FINDER ───────────────────────────────────────────────────────────

  // GET rewards/mine
  // informantUserId is set directly on RewardClaim now (from the submission at
  // claim-creation time), so this is a plain query — no more reconstructing it
  // by hand through InformationSubmission (G43 is resolved by the FK/relation
  // this migration added; see reward-claim.prisma).
  async getMyRewardClaims(userId: string) {
    const claims = await this.prisma.rewardClaim.findMany({
      where: { informantUserId: userId },
      select: {
        id: true,
        missingPersonId: true,
        informationSubmissionId: true,
        status: true,
        rewardPercentage: true,
        rewardAmount: true,
        approvedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (claims.length === 0) return { data: [] };

    // Payout status: this claim's own disbursement, if one has been created for
    // it (a reward pool can be split across several informants — see
    // disbursement.service.ts — so this is keyed on rewardClaimId, not on the
    // shared allocation). Small N (one finder's own claims), so N+1 is acceptable.
    const data = await Promise.all(
      claims.map(async (c) => {
        const disbursement = await this.prisma.disbursement.findFirst({
          where: { rewardClaimId: c.id },
          select: { status: true, amount: true, executedAt: true },
          orderBy: { createdAt: 'desc' },
        });
        return {
          claimId: c.id,
          missingPersonId: c.missingPersonId,
          status: c.status,
          rewardPercentage: c.rewardPercentage,
          approvedAt: c.approvedAt,
          amount: c.rewardAmount ? money(c.rewardAmount) : null,
          disbursementStatus: disbursement?.status ?? null,
          paidOutAt: disbursement?.status === 'PAID_OUT' ? disbursement.executedAt : null,
        };
      }),
    );
    return { data };
  }

  // ── ADMIN: per-entity breakdowns ────────────────────────────────────

  // GET admin/billing/victim-profiles/:id/funding
  async getProfileFundingBreakdown(profileId: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id: profileId },
      select: { id: true, supportGoal: true },
    });
    if (!profile) throw new NotFoundException('Profile not found');

    const [grossAgg, allocations] = await Promise.all([
      this.prisma.payment.aggregate({
        // SUPPORT only: posting-fee payments share victimProfileId but are a
        // separate financial movement (section 33) and must never be summed
        // into supporter funding totals.
        where: { victimProfileId: profileId, type: 'SUPPORT', status: 'PAID' },
        _sum: { amount: true, chapaFee: true },
      }),
      this.prisma.paymentAllocation.findMany({
        where: { payment: { victimProfileId: profileId, type: 'SUPPORT', status: 'PAID' } },
        select: {
          partyType: true,
          amount: true,
          settlementStatus: true,
          disbursements: { select: { status: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
    ]);

    const byParty: Record<string, Prisma.Decimal> = {};
    let pending = new Prisma.Decimal(0);
    let inFlight = new Prisma.Decimal(0);
    let paidOut = new Prisma.Decimal(0);

    for (const a of allocations) {
      const amt = new Prisma.Decimal(a.amount);
      byParty[a.partyType] = (byParty[a.partyType] ?? new Prisma.Decimal(0)).add(amt);

      const latest = a.disbursements[0]?.status;
      if (a.settlementStatus === 'PAID_OUT' || latest === 'PAID_OUT') {
        paidOut = paidOut.add(amt);
      } else if (latest && ['PENDING_APPROVAL', 'APPROVED', 'PROCESSING'].includes(latest)) {
        inFlight = inFlight.add(amt);
      } else if (a.settlementStatus === 'PENDING') {
        pending = pending.add(amt);
      }
    }

    return {
      gross: money(grossAgg._sum.amount ?? 0),
      chapaFees: money(grossAgg._sum.chapaFee ?? 0),
      byPartyType: Object.fromEntries(Object.entries(byParty).map(([k, v]) => [k, money(v)])),
      pending: money(pending),
      inFlight: money(inFlight),
      paidOut: money(paidOut),
    };
  }

  // GET admin/billing/victim-profiles/:id/payments
  async getProfilePayments(profileId: string, page = 1, limit = 20) {
    const where: Prisma.PaymentWhereInput = { victimProfileId: profileId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          amount: true,
          currency: true,
          payerUserId: true,
          chapaReference: true,
          createdAt: true,
          paidAt: true,
        },
        ...paginate(page, limit),
      }),
      this.prisma.payment.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({ ...r, amount: money(r.amount) })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // GET admin/billing/missing-persons/:id/reward
  async getRewardAdminView(missingPersonId: string) {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: {
        id: true,
        rewardOffered: true,
        rewardApproved: true,
        rewardAmount: true,
        rewardDetails: true,
        fundingMethod: true,
        fundingStatus: true,
        fundedAmount: true,
        reservedAmount: true,
        postingFeeAmount: true,
        postingFeeStatus: true,
        timeWeight: true,
        evidenceWeight: true,
        credibilityWeight: true,
      },
    });
    if (!mp) throw new NotFoundException('Case not found');

    const [payments, claims] = await Promise.all([
      this.prisma.payment.findMany({
        where: { missingPersonId, type: { in: ['MISSING_PERSON_REWARD', 'MISSING_PERSON_POSTING_FEE'] } },
        select: { id: true, type: true, status: true, amount: true, createdAt: true, paidAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      // A case can have several informants (section 11) — every claim, not "the" claim.
      this.prisma.rewardClaim.findMany({
        where: { missingPersonId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const submissionIds = claims.map((c) => c.informationSubmissionId).filter((id): id is string => !!id);
    const submissions = submissionIds.length
      ? await this.prisma.informationSubmission.findMany({
          where: { id: { in: submissionIds } },
          select: { id: true, userId: true, status: true, createdAt: true },
        })
      : [];
    const submissionById = new Map(submissions.map((s) => [s.id, s]));

    const claimIds = claims.map((c) => c.id);
    const disbursements = claimIds.length
      ? await this.prisma.disbursement.findMany({
          where: { rewardClaimId: { in: claimIds } },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const disbursementsByClaim = new Map<string, (typeof disbursements)[number][]>();
    for (const d of disbursements) {
      if (!d.rewardClaimId) continue;
      const list = disbursementsByClaim.get(d.rewardClaimId) ?? [];
      list.push(d);
      disbursementsByClaim.set(d.rewardClaimId, list);
    }

    const claimsView = claims.map((c) => ({
      ...c,
      rewardAmount: c.rewardAmount ? money(c.rewardAmount) : null,
      submission: c.informationSubmissionId ? submissionById.get(c.informationSubmissionId) ?? null : null,
      disbursements: disbursementsByClaim.get(c.id) ?? [],
    }));

    // The pool total is the funded reward's REWARD_BENEFICIARY allocation, same
    // computation RewardService.splitReward() uses — shown here so an admin can
    // see it before deciding a split.
    const paidPaymentIds = payments.filter((p) => p.status === 'PAID' && p.type === 'MISSING_PERSON_REWARD').map((p) => p.id);
    let poolAmount: string | null = null;
    if (paidPaymentIds.length > 0) {
      const pool = await this.prisma.paymentAllocation.aggregate({
        where: { paymentId: { in: paidPaymentIds }, partyType: 'REWARD_BENEFICIARY' },
        _sum: { amount: true },
      });
      poolAmount = money(pool._sum.amount ?? 0);
    }

    return {
      offer: {
        rewardOffered: mp.rewardOffered,
        rewardApproved: mp.rewardApproved,
        rewardAmount: mp.rewardAmount,
        rewardDetails: mp.rewardDetails,
      },
      funding: {
        method: mp.fundingMethod,
        status: mp.fundingStatus,
        fundedAmount: money(mp.fundedAmount),
        reservedAmount: money(mp.reservedAmount),
        poolAmount,
      },
      postingFee: {
        amount: mp.postingFeeAmount ? money(mp.postingFeeAmount) : null,
        status: mp.postingFeeStatus,
      },
      evaluationWeights:
        mp.timeWeight != null
          ? { time: mp.timeWeight, evidence: mp.evidenceWeight, credibility: mp.credibilityWeight }
          : null,
      payments: payments.map((p) => ({ ...p, amount: money(p.amount) })),
      claims: claimsView,
      refundState: mp.fundingStatus === 'REFUND_DUE' || mp.fundingStatus === 'REFUNDED' ? mp.fundingStatus : null,
    };
  }

  // ── ADMIN: billing-wide reports (used by BillingReportController) ──

  async listPayments(where: Prisma.PaymentWhereInput, page = 1, limit = 20) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...paginate(page, limit),
      }),
      this.prisma.payment.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({ ...r, amount: money(r.amount), chapaFee: money(r.chapaFee) })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getPaymentById(id: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        allocations: { include: { disbursements: true } },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return {
      ...payment,
      amount: money(payment.amount),
      chapaFee: money(payment.chapaFee),
      allocations: payment.allocations.map((a) => ({
        ...a,
        amount: money(a.amount),
        disbursements: a.disbursements.map((d) => ({ ...d, amount: money(d.amount) })),
      })),
    };
  }

  async listAllocations(
    where: Prisma.PaymentAllocationWhereInput,
    page = 1,
    limit = 20,
  ) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.paymentAllocation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { payment: { select: { victimProfileId: true, missingPersonId: true, status: true } } },
        ...paginate(page, limit),
      }),
      this.prisma.paymentAllocation.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({ ...r, amount: money(r.amount) })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async listDisbursements(where: Prisma.DisbursementWhereInput, page = 1, limit = 20) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.disbursement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...paginate(page, limit),
      }),
      this.prisma.disbursement.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({ ...r, amount: money(r.amount) })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getDisbursementById(id: string) {
    const disbursement = await this.prisma.disbursement.findUnique({
      where: { id },
      include: { allocation: { include: { payment: true } }, payoutDestination: true },
    });
    if (!disbursement) throw new NotFoundException('Disbursement not found');
    return {
      ...disbursement,
      amount: money(disbursement.amount),
      allocation: {
        ...disbursement.allocation,
        amount: money(disbursement.allocation.amount),
        payment: { ...disbursement.allocation.payment, amount: money(disbursement.allocation.payment.amount) },
      },
    };
  }

  // GET admin/billing/liabilities (G27 — RESOLVED)
  // Compares what Ehte still owes (unpaid allocations) against Chapa's reported balance.
  // ChapaService.getBalance() is now implemented (see chapa.service.ts) — this still
  // degrades gracefully to "unknown" on a transient Chapa outage, but no longer needs
  // the duck-typing runtime check that existed only because the method might not exist.
  async getLiabilities() {
    const unpaid = await this.prisma.paymentAllocation.groupBy({
      by: ['partyType', 'settlementStatus'],
      where: { settlementStatus: { in: ['PENDING'] } },
      _sum: { amount: true },
      _count: true,
    });

    const totalUnpaid = unpaid.reduce(
      (sum, row) => sum.add(new Prisma.Decimal(row._sum.amount ?? 0)),
      new Prisma.Decimal(0),
    );

    let chapaBalance: string | null = null;
    let chapaBalanceError: string | null = null;
    try {
      const balance = await this.chapa.getBalance();
      chapaBalance = money(balance.available);
    } catch (err) {
      // Chapa unreachable/erroring at request time — still a graceful "unknown",
      // just no longer a stand-in for "method doesn't exist".
      chapaBalanceError = `Could not fetch Chapa balance: ${String(err)}`;
    }

    return {
      totalUnpaidAllocations: money(totalUnpaid),
      byPartyAndStatus: unpaid.map((row) => ({
        partyType: row.partyType,
        settlementStatus: row.settlementStatus,
        count: row._count,
        amount: money(row._sum.amount ?? 0),
      })),
      chapaBalance,
      chapaBalanceError,
      covered: chapaBalance != null ? new Prisma.Decimal(chapaBalance).gte(totalUnpaid) : null,
    };
  }
}
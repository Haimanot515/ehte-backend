// Collection side. Same shape as PurchaseService in the other project:
// initiate -> Chapa checkout -> webhook/confirm -> verify -> fulfil

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentStatus, PaymentType, Prisma, AuditOutcome, AuditSeverity } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChapaService } from '../../../services/chapa/chapa.service';
import { BillingEventsService } from './billing-events.service';
import { AllocationPreview, AllocationService } from './allocation.service';
import { AuditEventEnum } from '../../../common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from '../../../common/enums/shared/notification-events.enum';
import { PaymentVerifiedEvent } from '../../misc/events/notification.events';
import { ReviewDecision, ResolveReviewDto } from '../dto/billing-report.dto';

export type Payer = { id: string; email?: string | null };

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly appUrl: string;
  private readonly returnUrl: string;
  private readonly minSupport: Prisma.Decimal;
  private readonly fallbackEmail: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chapa: ChapaService,
    private readonly allocation: AllocationService,
    private readonly events: BillingEventsService,
    private readonly config: ConfigService,
  ) {
    this.appUrl = config.get<string>('app.url', '');
    this.returnUrl = config.get<string>('payments.returnUrl', '');
    this.minSupport = new Prisma.Decimal(config.get<string>('payments.minSupportEtb', '10'));
    this.fallbackEmail = config.get<string>('chapa.fallbackEmail', '');
  }

  previewSupport(profileId: string, amount: string) {
    return this.allocation.preview(PaymentType.SUPPORT, this.parseAmount(amount), profileId);
  }

  // SupportService stored the split it showed the payer in
  // Support.allocationSnapshot, so what they saw is exactly what is charged.
  async initiateSupportCheckout(payer: Payer, supportId: string) {
    this.assertEnabled('payments.enabled');

    const support = await this.prisma.support.findFirst({
      where: { id: supportId, userId: payer.id, status: 'PENDING' },
      select: {
        id: true,
        type: true,
        victimProfileId: true,
        amount: true,
        allocationSnapshot: true,
      },
    });
    if (support && support.type !== 'FINANCIAL') {
      throw new BadRequestException('Only financial support can be paid online');
    }
    if (!support?.allocationSnapshot) throw new NotFoundException('No payable support found');

    const preview = support.allocationSnapshot as unknown as AllocationPreview;
    const amount = new Prisma.Decimal(support.amount ?? 0);
    if (!amount.equals(new Prisma.Decimal(preview.total))) {
      throw new ConflictException('Support amount does not match its recorded allocation');
    }
    if (amount.lt(this.minSupport)) {
      throw new BadRequestException(`Minimum support amount is ${this.minSupport} ETB`);
    }

    const existing = await this.prisma.payment.findFirst({
      where: {
        supportId,
        OR: [
          { status: 'PAID' },
          { status: 'PENDING', createdAt: { gt: new Date(Date.now() - 30 * 60_000) } },
        ],
      },
      select: { status: true },
    });
    if (existing) {
      throw new ConflictException(
        existing.status === 'PAID'
          ? 'This support is already paid'
          : 'A payment for this support is already in progress',
      );
    }

    return this.startCheckout({
      type: PaymentType.SUPPORT,
      amount,
      payer,
      preview,
      victimProfileId: support.victimProfileId,
      supportId: support.id,
    });
  }

  // missingPersonId, not a rewardId: the reward offer, amount and approval
  // all live on MissingPerson itself. Only the case requester can fund it.
  async initiateRewardFunding(payer: Payer, missingPersonId: string) {
    this.assertEnabled('payments.rewardsEnabled');
    const mp = await this.prisma.missingPerson.findFirst({
      where: { id: missingPersonId, userId: payer.id, rewardOffered: true, rewardApproved: true },
      select: { id: true },
    });
    if (!mp) throw new NotFoundException('No approved reward to fund');

    const already = await this.prisma.payment.findFirst({
      where: {
        missingPersonId,
        OR: [
          { status: 'PAID' },
          { status: 'PENDING', createdAt: { gt: new Date(Date.now() - 30 * 60_000) } },
        ],
      },
      select: { status: true },
    });
    if (already) {
      throw new ConflictException(
        already.status === 'PAID'
          ? 'This reward is already funded'
          : 'A payment for this reward is already in progress',
      );
    }

    const preview = await this.allocation.previewReward(missingPersonId);

    return this.startCheckout({
      type: PaymentType.MISSING_PERSON_REWARD,
      amount: new Prisma.Decimal(preview.total),
      payer,
      preview,
      missingPersonId,
    });
  }

  // Section 5 / 8 / 27: posting/promotion fee, always separate from SUPPORT and
  // MISSING_PERSON_REWARD payments. Publication must be blocked until this
  // settles PAID — the object service (VictimProfileService / MissingPersonService,
  // not provided in this pass) should flip postingFeeStatus to PAID on the same
  // BILLING_PAYMENT_PAID event PaymentService already emits, mirroring how
  // RewardService listens for reward funding.
  async initiatePostingFeeCheckout(
    payer: Payer,
    objectType: 'VICTIM_PROFILE' | 'MISSING_PERSON',
    objectId: string,
  ) {
    this.assertEnabled('payments.enabled');

    const type =
      objectType === 'VICTIM_PROFILE'
        ? PaymentType.VICTIM_PROFILE_POSTING_FEE
        : PaymentType.MISSING_PERSON_POSTING_FEE;

    const feeState =
      objectType === 'VICTIM_PROFILE'
        ? await this.prisma.victimProfile.findUnique({
            where: { id: objectId },
            select: { postingFeeAmount: true, postingFeeStatus: true, agreementId: true },
          })
        : await this.prisma.missingPerson.findUnique({
            where: { id: objectId },
            select: { postingFeeAmount: true, postingFeeStatus: true, agreementId: true },
          });
    if (!feeState) throw new NotFoundException('Object not found');
    if (feeState.postingFeeStatus === 'NOT_REQUIRED' || feeState.postingFeeStatus === 'PAID') {
      throw new BadRequestException('No posting fee is due for this object');
    }
    if (!feeState.postingFeeAmount) {
      throw new BadRequestException('Posting fee amount has not been resolved for this object yet');
    }

    const already = await this.prisma.payment.findFirst({
      where: {
        type,
        ...(objectType === 'VICTIM_PROFILE'
          ? { victimProfileId: objectId }
          : { missingPersonId: objectId }),
        OR: [
          { status: 'PAID' },
          { status: 'PENDING', createdAt: { gt: new Date(Date.now() - 30 * 60_000) } },
        ],
      },
      select: { status: true },
    });
    if (already) {
      throw new ConflictException(
        already.status === 'PAID'
          ? 'This posting fee is already paid'
          : 'A payment for this posting fee is already in progress',
      );
    }

    const preview = await this.allocation.previewPostingFee(
      type,
      new Prisma.Decimal(feeState.postingFeeAmount),
      feeState.agreementId,
    );

    return this.startCheckout({
      type,
      amount: new Prisma.Decimal(preview.total),
      payer,
      preview,
      victimProfileId: objectType === 'VICTIM_PROFILE' ? objectId : undefined,
      missingPersonId: objectType === 'MISSING_PERSON' ? objectId : undefined,
    });
  }

  // Row created before Chapa can ever call back, so a webhook never sees an
  // unknown tx_ref.
  private async startCheckout(args: {
    type: PaymentType;
    amount: Prisma.Decimal;
    payer: Payer;
    preview: AllocationPreview;
    victimProfileId?: string;
    supportId?: string;
    missingPersonId?: string;
  }) {
    const email = args.payer.email ?? this.fallbackEmail;
    if (!this.returnUrl || !this.appUrl || !email) {
      throw new ServiceUnavailableException('Payments are not configured');
    }
    const txRef = this.chapa.generateTxRef();
    const payment = await this.prisma.payment.create({
      data: {
        type: args.type,
        amount: args.amount,
        currency: 'ETB',
        txRef,
        payerUserId: args.payer.id,
        victimProfileId: args.victimProfileId,
        supportId: args.supportId,
        missingPersonId: args.missingPersonId,
        agreementId: args.preview.agreementId,
        agreementVersion: args.preview.agreementVersion,
        allocationSnapshot: args.preview,
        previewShownAt: new Date(),
      },
    });
    // FIX: payment creation itself had no audit row — every other Payment
    // status this file reaches (MISMATCH, PAID, FAILED, EXPIRED) is logged;
    // the very first step wasn't. No events.notify() here: the payer just
    // triggered this themselves by clicking pay, so a notification back to
    // them would be redundant — same reasoning DisbursementService.create()
    // uses for staying audit-only.
    // ASSUMPTION TO VERIFY: AuditEventEnum.PAYMENT_INITIATED does not exist
    // yet either — add it alongside PAYMENT_FAILED/PAYMENT_EXPIRED.
    await this.events.log({
      actorId: args.payer.id,
      action: AuditEventEnum.PAYMENT_INITIATED,
      entityType: 'Payment',
      entityId: payment.id,
      metadata: { type: args.type },
    });

    try {
      const { checkoutUrl } = await this.chapa.initialize({
        amount: args.amount,
        email,
        firstName: 'Ehte',
        lastName: 'Supporter',
        txRef,
        returnUrl: `${this.returnUrl}?tx_ref=${txRef}`,
        callbackUrl: `${this.appUrl}/billing/webhook/chapa`,
        title: 'Ehte',
        description: 'Ehte payment',
      });
      return { checkoutUrl, txRef, allocation: args.preview };
    } catch (err) {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' },
      });
      // FIX: second FAILED transition in this file with no audit row —
      // same gap as reconcile()'s FAILED branch, different trigger (Chapa
      // rejected the checkout init call itself, not a later verify). actorId
      // is the payer here (their checkout attempt is what failed), unlike
      // reconcile()'s FAILED branch where actorId is null (async webhook/cron
      // path with no direct user in the loop).
      await this.events.log({
        actorId: args.payer.id,
        action: AuditEventEnum.PAYMENT_FAILED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entityType: 'Payment',
        entityId: payment.id,
        metadata: { type: args.type, reason: 'checkout_initiation_failed' },
      });
      throw err;
    }
  }

  async reconcile(txRef: string): Promise<PaymentStatus | null> {
    const payment = await this.prisma.payment.findUnique({ where: { txRef } });
    if (!payment) {
      this.logger.warn(`Reconcile: unknown tx_ref ${txRef}`);
      return null;
    }
    if (payment.status !== 'PENDING') return payment.status;

    let remote;
    try {
      remote = await this.chapa.verify(txRef);
    } catch (err) {
      this.logger.warn(`Verify failed for ${txRef}: ${String(err)}`);
      return 'PENDING';
    }

    if (remote.status === 'failed') {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' },
      });
      // FIX: this branch previously updated status with no audit row at all —
      // the PAYMENT_MISMATCH branch right below it, and the PAYMENT_PAID
      // branch further down, both log via events.log(); FAILED was the only
      // terminal outcome of reconcile() that left no trace. actorId: null
      // follows the same system-actor convention already used for
      // PAYMENT_MISMATCH just below (this is Chapa reporting the failure,
      // not an admin action).
      // ASSUMPTION TO VERIFY: AuditEventEnum.PAYMENT_FAILED does not exist
      // in this codebase's enum yet (checked — no other call site references
      // it). Add it to audit-events.enum.ts before this compiles.
      await this.events.log({
        actorId: null,
        action: AuditEventEnum.PAYMENT_FAILED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entityType: 'Payment',
        entityId: payment.id,
        metadata: { type: payment.type },
      });
      return 'FAILED';
    }
    if (remote.status !== 'success') return 'PENDING';

    // Never trust the webhook: amount/currency must match what we stored.
    if (!this.chapa.paidAmountMatches(remote, payment)) {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'REVIEW_REQUIRED' },
      });
      this.logger.error(`Amount/currency mismatch on payment ${payment.id}`);
      await this.events.log({
        actorId: null,
        action: AuditEventEnum.PAYMENT_MISMATCH,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entityType: 'Payment',
        entityId: payment.id,
      });
      return 'REVIEW_REQUIRED';
    }

    const snapshot = payment.allocationSnapshot as unknown as AllocationPreview;

    const won = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          chapaReference: remote.reference ?? null,
          chapaFee: remote.charge ? new Prisma.Decimal(remote.charge) : null,
        },
      });
      if (count === 0) return false;

      await tx.paymentAllocation.createMany({
        data: snapshot.lines.map((l) => ({
          paymentId: payment.id,
          partyType: l.partyType,
          institutionId: l.institutionId,
          amount: new Prisma.Decimal(l.amount),
          ruleId: l.ruleId,
        })),
      });

      // FIX: this used to upsert a RewardClaim keyed on missingPersonId, back
      // when RewardClaim was one row per case. Now that a case can have many
      // claims (one per informant, see reward-claim.prisma), there is no
      // single row to upsert here — RewardService.onPaymentPaid(), which
      // already listens on BILLING_PAYMENT_PAID below, is the only place that
      // updates MissingPerson.fundedAmount/fundingStatus. Posting-fee
      // payments (VICTIM_PROFILE_POSTING_FEE / MISSING_PERSON_POSTING_FEE)
      // are handled the same way, via their own listeners on the object
      // services — nothing to do here either.
      return true;
    });

    if (won) {
      await this.events.log({
        actorId: payment.payerUserId,
        action: AuditEventEnum.PAYMENT_PAID,
        entityType: 'Payment',
        entityId: payment.id,
        metadata: { type: payment.type },
      });
      await this.events.paymentPaid({
        paymentId: payment.id,
        supportId: payment.supportId,
        missingPersonId: payment.missingPersonId,
      });
      // Amount deliberately left out of the notification body/payload —
      // same convention as PostService/AuthService keeping financial
      // specifics out of user-facing notification content.
      this.events.notify<PaymentVerifiedEvent>(NotificationEventEnum.PAYMENT_VERIFIED, {
        userId: payment.payerUserId,
        paymentId: payment.id,
        supportId: payment.supportId ?? undefined,
        missingPersonId: payment.missingPersonId ?? undefined,
      });
    }
    return 'PAID';
  }

  async getStatus(txRef: string, userId: string) {
    const owned = await this.prisma.payment.findFirst({
      where: { txRef, payerUserId: userId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Payment not found');

    const status = await this.reconcile(txRef);
    const p = await this.prisma.payment.findUniqueOrThrow({
      where: { txRef },
      select: { type: true, amount: true, currency: true, allocationSnapshot: true },
    });
    return {
      status,
      type: p.type,
      amount: p.amount,
      currency: p.currency,
      allocation: p.allocationSnapshot,
    };
  }

  // ADMIN — G9 REVIEW RESOLUTION. reconcile()'s mismatch branch parks a
  // payment at REVIEW_REQUIRED and stops; nothing before this method ever
  // moves it back out of that state. resolveReview() is that missing exit:
  // an admin either rejects it (same FAILED transition reconcile() takes on
  // a hard failure) or approves it (same PAID transition reconcile() takes
  // on a clean match — allocations from the stored snapshot, paymentPaid
  // event, PAYMENT_VERIFIED notification).
  // CONFIRMED (Sep 2026): AuditEventEnum.PAYMENT_REVIEW_RESOLVED exists. Still
  // assumes ResolveReviewDto/ReviewDecision in billing-report.dto.ts are the
  // final contract; adjust this method to match if that shape changes.
  async resolveReview(adminId: string, paymentId: string, dto: ResolveReviewDto) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== 'REVIEW_REQUIRED') {
      throw new ConflictException('Payment is not awaiting review');
    }

    if (dto.decision === ReviewDecision.REJECT) {
      const { count } = await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'REVIEW_REQUIRED' },
        data: { status: 'FAILED' },
      });
      if (count === 0) throw new ConflictException('Payment is not awaiting review');

      await this.events.log({
        actorId: adminId,
        action: AuditEventEnum.PAYMENT_REVIEW_RESOLVED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entityType: 'Payment',
        entityId: payment.id,
        metadata: { decision: dto.decision, reason: dto.reason },
      });
      return { status: 'FAILED' as PaymentStatus };
    }

    const snapshot = payment.allocationSnapshot as unknown as AllocationPreview;

    const won = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, status: 'REVIEW_REQUIRED' },
        data: { status: 'PAID', paidAt: new Date() },
      });
      if (count === 0) return false;

      await tx.paymentAllocation.createMany({
        data: snapshot.lines.map((l) => ({
          paymentId: payment.id,
          partyType: l.partyType,
          institutionId: l.institutionId,
          amount: new Prisma.Decimal(l.amount),
          ruleId: l.ruleId,
        })),
      });

      // See the matching note in reconcile() above: no RewardClaim upsert
      // here anymore, RewardService.onPaymentPaid() owns the funding update.
      return true;
    });

    if (!won) throw new ConflictException('Payment is not awaiting review');

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYMENT_REVIEW_RESOLVED,
      entityType: 'Payment',
      entityId: payment.id,
      metadata: { decision: dto.decision, reason: dto.reason },
    });
    await this.events.paymentPaid({
      paymentId: payment.id,
      supportId: payment.supportId,
      missingPersonId: payment.missingPersonId,
    });
    this.events.notify<PaymentVerifiedEvent>(NotificationEventEnum.PAYMENT_VERIFIED, {
      userId: payment.payerUserId,
      paymentId: payment.id,
      supportId: payment.supportId ?? undefined,
      missingPersonId: payment.missingPersonId ?? undefined,
    });

    return { status: 'PAID' as PaymentStatus };
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcileStale(): Promise<void> {
    const stale = await this.prisma.payment.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 15 * 60_000) } },
      select: { id: true, txRef: true, createdAt: true },
      take: 100,
    });
    for (const p of stale) {
      const status = await this.reconcile(p.txRef);
      if (status === 'PENDING' && p.createdAt.getTime() < Date.now() - 24 * 3_600_000) {
        const { count } = await this.prisma.payment.updateMany({
          where: { txRef: p.txRef, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
        // FIX: silently expired a stale payment with no audit row — the only
        // other cron in this module that mutates state without a human actor
        // (syncProcessing's stale-flag branch in disbursement.service.ts)
        // still logs via events.log(). actorId: null, same system-actor
        // convention used for PAYMENT_FAILED/PAYMENT_MISMATCH above.
        // ASSUMPTION TO VERIFY: AuditEventEnum.PAYMENT_EXPIRED does not exist
        // yet either — add it alongside PAYMENT_FAILED.
        if (count > 0) {
          await this.events.log({
            actorId: null,
            action: AuditEventEnum.PAYMENT_EXPIRED,
            // WARNING severity, no `outcome` — expiry isn't a failed
            // operation the way FAILED/MISMATCH are (nothing was attempted
            // and rejected), it's a routine timeout on an abandoned
            // checkout. Still worth flagging for visibility, so it keeps
            // severity but not FAILURE.
            severity: AuditSeverity.WARNING,
            entityType: 'Payment',
            entityId: p.id,
            metadata: { reason: 'reconcile_stale_timeout' },
          });
        }
      }
    }
  }

  private assertEnabled(flag: 'payments.enabled' | 'payments.rewardsEnabled'): void {
    if (this.config.get<boolean>(flag) !== true) {
      throw new ServiceUnavailableException('This payment feature is not enabled yet');
    }
  }

  // Repair: a payment is PAID but its Support is still PENDING (event lost
  // or handler failed). Re-emit until SupportService confirms it.
  @Cron(CronExpression.EVERY_10_MINUTES)
  async repairUnconfirmedSupports(): Promise<void> {
    const paid = await this.prisma.payment.findMany({
      where: {
        status: 'PAID',
        supportId: { not: null },
        paidAt: {
          lt: new Date(Date.now() - 2 * 60_000),
          gt: new Date(Date.now() - 7 * 86_400_000),
        },
      },
      select: { id: true, supportId: true },
      take: 200,
    });
    if (paid.length === 0) return;

    const pending = await this.prisma.support.findMany({
      where: { id: { in: paid.map((p) => p.supportId as string) }, status: 'PENDING' },
      select: { id: true },
    });
    const pendingIds = new Set(pending.map((s) => s.id));
    for (const p of paid) {
      if (p.supportId && pendingIds.has(p.supportId)) {
        await this.events.paymentPaid({
          paymentId: p.id,
          supportId: p.supportId,
          missingPersonId: null,
        });
      }
    }
  }

  private parseAmount(raw: string): Prisma.Decimal {
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      throw new BadRequestException('Invalid amount');
    }
    const amount = new Prisma.Decimal(raw);
    if (amount.lte(0)) throw new BadRequestException('Invalid amount');
    return amount;
  }

  // ADMIN — DASHBOARD STATISTICS. Counts/totals by status and type, Chapa
  // fees taken, REVIEW_REQUIRED mismatches, allocation totals by party type,
  // average time PENDING->PAID, and a 30-day daily volume trend.
  async getStats() {
    const [
      total,
      statusGrouped,
      typeGrouped,
      paidAgg,
      reviewRequiredCount,
      allocationGrouped,
      avgPaidAgg,
      dailyTrend,
    ] = await this.prisma.$transaction([
      this.prisma.payment.count(),

      this.prisma.payment.groupBy({
        by: ['status'],
        _count: { status: true },
        _sum: { amount: true },
        orderBy: { status: 'asc' },
      }),

      this.prisma.payment.groupBy({
        by: ['type'],
        _count: { type: true },
        _sum: { amount: true },
        orderBy: { type: 'asc' },
      }),

      this.prisma.payment.aggregate({
        where: { status: 'PAID' },
        _sum: { amount: true, chapaFee: true },
        _count: true,
      }),

      this.prisma.payment.count({ where: { status: 'REVIEW_REQUIRED' } }),

      this.prisma.paymentAllocation.groupBy({
        by: ['partyType'],
        _sum: { amount: true },
        orderBy: { partyType: 'asc' },
      }),

      this.prisma.$queryRaw<{ avg_minutes: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("paidAt" - "createdAt")) / 60) AS avg_minutes
        FROM "Payment"
        WHERE status = 'PAID' AND "paidAt" IS NOT NULL
      `,

      this.prisma.$queryRaw<{ day: Date; count: bigint; total: number | null }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count, SUM(amount) AS total
        FROM "Payment"
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY day
        ORDER BY day ASC
      `,
    ]);

    const byStatus: Record<string, { count: number; amount: number }> = {};
    for (const row of statusGrouped) {
      const c = row._count as { status?: number } | undefined;
      byStatus[String(row.status)] = {
        count: c?.status ?? 0,
        amount: Number(row._sum?.amount ?? 0),
      };
    }

    const byType: Record<string, { count: number; amount: number }> = {};
    for (const row of typeGrouped) {
      const c = row._count as { type?: number } | undefined;
      byType[String(row.type)] = {
        count: c?.type ?? 0,
        amount: Number(row._sum?.amount ?? 0),
      };
    }

    const byPartyType: Record<string, number> = {};
    for (const row of allocationGrouped) {
      byPartyType[String(row.partyType)] = Number(row._sum?.amount ?? 0);
    }

    return {
      total,
      byStatus,
      byType,
      byPartyType,

      paid: {
        count: paidAgg._count,
        totalAmount: Number(paidAgg._sum.amount ?? 0),
        totalChapaFees: Number(paidAgg._sum.chapaFee ?? 0),
      },

      reviewRequiredCount,

      avgTimeToPaidMinutes:
        avgPaidAgg[0]?.avg_minutes != null
          ? Number(Number(avgPaidAgg[0].avg_minutes).toFixed(2))
          : null,

      dailyTrend: dailyTrend.map((row) => ({
        date: row.day.toISOString().slice(0, 10),
        count: Number(row.count),
        totalAmount: Number(row.total ?? 0),
      })),
    };
  }
} 
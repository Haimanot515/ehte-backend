// src/modules/billing/services/payment.service.ts
//
// Collection side. Same shape as PurchaseService in the other project:
//   initiate -> Chapa checkout -> webhook/confirm -> verify -> fulfil
// with three changes: a real Payment row (no placeholder hack), a conditional
// update as the double-processing gate, and allocations created in the same
// transaction as the PAID transition.

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
import { PaymentStatus, PaymentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChapaService } from '../../../services/chapa/chapa.service';
import { BillingEventsService } from './billing-events.service';
import { AllocationPreview, AllocationService } from './allocation.service';
import { AuditEventEnum } from '../../../common/enums/shared/audit-events.enum';

// Only what Chapa needs. Real names are never sent to Chapa.
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
    // Chapa requires an email. Used when the user has none on file.
    this.fallbackEmail = config.get<string>('chapa.fallbackEmail', '');
  }

  // ── Flow A: support a victim/survivor ─────────────────────────────────────

  /** Step 1: show the payer where the money goes. */
  previewSupport(profileId: string, amount: string) {
    return this.allocation.preview(
      PaymentType.SUPPORT,
      this.parseAmount(amount),
      profileId,
    );
  }

  /**
   * Step 2: pay for a Support the user already created (POST /support).
   * SupportService stored the split it showed the payer in
   * Support.allocationSnapshot, so what they saw is exactly what is charged.
   */
  async initiateSupportCheckout(payer: Payer, supportId: string) {
    this.assertEnabled('payments.enabled');

    const support = await this.prisma.support.findFirst({
      where: { id: supportId, userId: payer.id, status: 'PENDING' },
      select: { id: true, type: true, victimProfileId: true, amount: true, allocationSnapshot: true },
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

  // ── Flow B: fund a missing-person reward (requester pays into escrow) ─────

  /**
   * missingPersonId, not a rewardId: there is no separate reward-escrow model.
   * The reward offer, its amount and its approval all live on MissingPerson itself
   * (rewardOffered/rewardAmount/rewardApproved). Only the requester who created the
   * case can fund it (MissingPerson.userId).
   */
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
        already.status === 'PAID' ? 'This reward is already funded' : 'A payment for this reward is already in progress',
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

  // ── Shared: create row first, then call Chapa ─────────────────────────────
  // The row exists before Chapa can ever call back, so a webhook never sees
  // an unknown tx_ref.

  private async startCheckout(args: {
    type: PaymentType;
    amount: Prisma.Decimal;
    payer: Payer;
    preview: AllocationPreview;
    victimProfileId?: string;
    supportId?: string;
    missingPersonId?: string;
  }) {
    const email = args.payer.email ?? this.fallbackEmail; // Chapa requires one
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
        allocationSnapshot: args.preview as unknown as Prisma.InputJsonValue,
        previewShownAt: new Date(),
      },
    });

    try {
      const { checkoutUrl } = await this.chapa.initialize({
        amount: args.amount,
        email,
        firstName: 'Ehte', // generic on purpose
        lastName: 'Supporter',
        txRef,
        returnUrl: `${this.returnUrl}?tx_ref=${txRef}`,
        callbackUrl: `${this.appUrl}/billing/webhook/chapa`,
        title: 'Ehte',
        description: 'Ehte payment', // generic on purpose
      });
      return { checkoutUrl, txRef, allocation: args.preview };
    } catch (err) {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' },
      });
      throw err;
    }
  }

  // ── Fulfilment (called by webhook, return URL, and cron) ──────────────────

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
      return 'PENDING'; // try again on next webhook/cron
    }

    if (remote.status === 'failed') {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' },
      });
      return 'FAILED';
    }
    if (remote.status !== 'success') return 'PENDING';

    // Never trust the webhook: amount and currency must match what we stored.
    // If Chapa is configured so the customer pays the fee on top, `amount` may
    // differ. Adjust this check to your Chapa fee settings.
    if (!this.chapa.paidAmountMatches(remote, payment)) {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'REVIEW_REQUIRED' },
      });
      this.logger.error(`Amount/currency mismatch on payment ${payment.id}`);
      await this.events.log({
        actorId: null,
        action: AuditEventEnum.PAYMENT_MISMATCH,
        entityType: 'Payment',
        entityId: payment.id,
      });
      return 'REVIEW_REQUIRED';
    }

    const snapshot = payment.allocationSnapshot as unknown as AllocationPreview;

    const won = await this.prisma.$transaction(async (tx) => {
      // Gate: only one caller (webhook / confirm / cron) can flip PENDING -> PAID.
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

      if (payment.missingPersonId) {
        // Creates the RewardClaim row (status PENDING) the first time a reward is funded.
        // RewardService also listens on BILLING_PAYMENT_PAID and calls onFunded() itself,
        // so this is belt-and-braces — upsert makes both paths idempotent together.
        await tx.rewardClaim.upsert({
          where: { missingPersonId: payment.missingPersonId },
          create: { missingPersonId: payment.missingPersonId },
          update: {},
        });
      }
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
      // Support: SupportService listens for this and moves the Support to CONFIRMED
      // (totalRaised, audit and SUPPORT_PAYMENT_CONFIRMED all run there).
      // Reward: RewardService.onFunded() creates the RewardClaim row.
      await this.events.paymentPaid({
        paymentId: payment.id,
        supportId: payment.supportId,
        missingPersonId: payment.missingPersonId,
      });
    }
    return 'PAID';
  }

  /** Return-URL / polling endpoint for the app. Only the payer can call it. */
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
    return { status, type: p.type, amount: p.amount, currency: p.currency, allocation: p.allocationSnapshot };
  }

  // ── Cron: catch missed webhooks, expire abandoned checkouts ───────────────

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcileStale(): Promise<void> {
    const stale = await this.prisma.payment.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 15 * 60_000) } },
      select: { txRef: true, createdAt: true },
      take: 100,
    });
    for (const p of stale) {
      const status = await this.reconcile(p.txRef);
      if (status === 'PENDING' && p.createdAt.getTime() < Date.now() - 24 * 3_600_000) {
        await this.prisma.payment.updateMany({
          where: { txRef: p.txRef, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
      }
    }
  }

  /** Feature flags: the PRD lists payments and reward payments as future features. */
  private assertEnabled(flag: 'payments.enabled' | 'payments.rewardsEnabled'): void {
    if (this.config.get<boolean>(flag) !== true) {
      throw new ServiceUnavailableException('This payment feature is not enabled yet');
    }
  }

  /**
   * Repair: a payment is PAID but its Support is still PENDING (event lost or
   * handler failed). Re-emit until SupportService confirms it. Idempotent.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async repairUnconfirmedSupports(): Promise<void> {
    const paid = await this.prisma.payment.findMany({
      where: {
        status: 'PAID',
        supportId: { not: null },
        paidAt: { lt: new Date(Date.now() - 2 * 60_000), gt: new Date(Date.now() - 7 * 86_400_000) },
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
        await this.events.paymentPaid({ paymentId: p.id, supportId: p.supportId, missingPersonId: null });
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
}

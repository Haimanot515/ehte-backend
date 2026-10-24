import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ActorType,
  AuditOutcome,
  AuditSeverity,
  DisbursementStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { ChapaService } from 'src/infrastructure/chapa/chapa.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';

import { PayoutService } from './payout.service';
import { TransferApprovalDto } from '../dto/payments.dto';

export type SettleResult = {
  status: PaymentStatus;
  amount: string;
  currency: string;
};

@Injectable()
export class ChapaWebhookService {
  private readonly logger = new Logger(ChapaWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chapa: ChapaService,
    private readonly payouts: PayoutService,
    private readonly cache: CacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Webhook entry ─────────────────────────────────────────────────────────

  /**
   * The body is only a hint about WHICH record to look at. Everything is re-checked with Chapa,
   * so a forged or replayed body cannot change money. Safe to receive twice.
   */
  async handleEvent(payload: Record<string, unknown>): Promise<void> {
    const txRef = this.str(payload.tx_ref);
    if (txRef) {
      await this.settlePayment(txRef);
      return;
    }

    const transferRef = this.str(payload.reference) ?? this.str(payload.transfer_reference);
    if (transferRef) {
      await this.payouts.checkByReference(transferRef);
      return;
    }

    this.logger.warn('Chapa webhook had neither tx_ref nor a transfer reference');
    this.eventEmitter.emit(AuditEventEnum.PAYMENT_WEBHOOK_PAYLOAD_INVALID, {
      userId: null,
      actorType: ActorType.SYSTEM,
      action: AuditEventEnum.PAYMENT_WEBHOOK_PAYLOAD_INVALID,
      outcome: AuditOutcome.FAILURE,
      entity: 'ProviderEvent',
    });
  }

  // ── Settle one donation ───────────────────────────────────────────────────

  /**
   * Asks Chapa for the truth about this tx_ref and records it once.
   * - success + exact amount/currency  -> PAID, totalRaised grows, the victim's balance is sent
   * - success + different amount       -> REVIEW_REQUIRED (an admin decides)
   * - failed                           -> FAILED
   * - pending                          -> unchanged
   * `acceptAmountMismatch` is only used when an admin accepts a REVIEW_REQUIRED payment.
   */
  async settlePayment(
    txRef: string,
    opts: { acceptAmountMismatch?: boolean } = {},
  ): Promise<SettleResult> {
    const payment = await this.prisma.payment.findUnique({ where: { txRef } });
    if (!payment) throw new NotFoundException('payment_not_found');

    const result = (p: { status: PaymentStatus; amount: Prisma.Decimal; currency: string }) => ({
      status: p.status,
      amount: p.amount.toFixed(2),
      currency: p.currency,
    });

    const settled: PaymentStatus[] = [PaymentStatus.PAID, PaymentStatus.REFUNDED];
    if (settled.includes(payment.status)) return result(payment);
    if (payment.status === PaymentStatus.REVIEW_REQUIRED && !opts.acceptAmountMismatch) {
      return result(payment);
    }

    // A timeout or 5xx here throws, and the caller (or the next webhook/job run) simply tries again.
    const data = await this.chapa.verify(txRef);

    if (data.status === 'failed') {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED, failureReason: 'chapa_reported_failed' },
      });
      this.auditPayment(AuditEventEnum.PAYMENT_FAILED, payment.id, payment.victimProfileId, {}, AuditOutcome.FAILURE);
      return result({ ...payment, status: PaymentStatus.FAILED });
    }

    if (data.status !== 'success') return result(payment);

    const matches = this.chapa.paidAmountMatches(
      { amount: data.amount, currency: data.currency },
      { amount: payment.amount, currency: payment.currency },
    );

    if (!matches && !opts.acceptAmountMismatch) {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.REVIEW_REQUIRED,
          chapaReference: data.reference ?? null,
          failureReason: `amount_mismatch expected=${payment.amount.toFixed(2)} got=${data.amount} ${data.currency}`,
        },
      });
      this.auditPayment(
        AuditEventEnum.PAYMENT_MISMATCH,
        payment.id,
        payment.victimProfileId,
        { expected: payment.amount.toFixed(2), got: data.amount, currency: data.currency },
        AuditOutcome.FAILURE,
      );
      return result({ ...payment, status: PaymentStatus.REVIEW_REQUIRED });
    }

    // Admin accepted a mismatch: the amount Chapa actually collected is what we record.
    // The currency must still be ours.
    const paidAmount = new Prisma.Decimal(data.amount);
    if (data.currency.toUpperCase() !== payment.currency.toUpperCase()) {
      return result(payment);
    }

    const from = opts.acceptAmountMismatch
      ? [PaymentStatus.PENDING, PaymentStatus.REVIEW_REQUIRED]
      : [PaymentStatus.PENDING];

    const won = await this.prisma.runInTransaction(async () => {
      const res = await this.prisma.payment.updateMany({
        where: { id: payment.id, status: { in: from } },
        data: {
          status: PaymentStatus.PAID,
          amount: paidAmount,
          paidAt: new Date(),
          chapaReference: data.reference ?? null,
          chapaFee: data.charge != null ? new Prisma.Decimal(data.charge) : null,
          failureReason: null,
        },
      });
      if (res.count === 0) return false; // another caller already settled it
      await this.prisma.victimProfile.update({
        where: { id: payment.victimProfileId },
        data: { totalRaised: { increment: paidAmount } },
      });
      return true;
    });

    if (!won) {
      const fresh = await this.prisma.payment.findUnique({ where: { id: payment.id } });
      return result(fresh ?? payment);
    }

    await this.cache.invalidateVictimProfileEverywhere(payment.victimProfileId);
    this.auditPayment(AuditEventEnum.PAYMENT_PAID, payment.id, payment.victimProfileId, {
      amount: paidAmount.toFixed(2),
      chapaFee: data.charge ?? null,
    });
    if (payment.payerUserId) {
      this.eventEmitter.emit(NotificationEventEnum.PAYMENT_VERIFIED, {
        userId: payment.payerUserId,
        paymentId: payment.id,
      });
    }

    // Send the money on. A failure here must never fail the webhook; the timer job will retry.
    try {
      await this.payouts.runForVictim(payment.victimProfileId);
    } catch (err) {
      this.logger.warn(`Payout after payment ${payment.id} failed: ${String(err)}`);
    }

    return result({ ...payment, status: PaymentStatus.PAID, amount: paidAmount });
  }

  // ── Transfer approval (Chapa's approval URL) ──────────────────────────────

  /**
   * Chapa asks "did you really start this transfer?". Yes only when our own record agrees on
   * every point. Returns false on any difference. This is the last gate before money leaves.
   */
  async approveTransfer(dto: TransferApprovalDto): Promise<boolean> {
    const d = await this.prisma.disbursement.findUnique({
      where: { reference: dto.reference },
      include: {
        victimProfile: {
          select: {
            payoutsPaused: true,
            deletedAt: true,
            takedownAt: true,
            legalHold: true,
            payoutDestination: true,
          },
        },
      },
    });
    if (!d) return false;

    const open: DisbursementStatus[] = [DisbursementStatus.CREATED, DisbursementStatus.SUBMITTED];
    if (!open.includes(d.status)) return false;

    let asked: Prisma.Decimal;
    try {
      asked = new Prisma.Decimal(dto.amount);
    } catch {
      return false;
    }
    if (!asked.equals(d.amount)) return false;

    const snap = d.destinationSnapshot as { accountNumber?: string; accountHolder?: string } | null;
    if (!snap) return false;
    if (snap.accountNumber !== dto.account_number) return false;
    if ((snap.accountHolder ?? '').trim().toLowerCase() !== dto.account_name.trim().toLowerCase()) {
      return false;
    }

    const p = d.victimProfile;
    if (p.payoutsPaused || p.deletedAt || p.takedownAt || p.legalHold) return false;

    // The bank account must still be the verified one we snapshotted.
    const dest = p.payoutDestination;
    if (!dest || !dest.isVerified || dest.accountNumber !== snap.accountNumber) return false;

    // The money must still exist: confirmed donations minus every OTHER transfer.
    const balance = await this.payouts.getBalance(d.victimProfileId);
    const others = balance.sent.add(balance.onTheWay).sub(d.amount);
    if (balance.raised.sub(others).lt(d.amount)) return false;

    return true;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private str(v: unknown): string | null {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  private auditPayment(
    action: AuditEventEnum,
    paymentId: string,
    victimProfileId: string,
    diff: Record<string, unknown>,
    outcome: AuditOutcome = AuditOutcome.SUCCESS,
  ) {
    this.eventEmitter.emit(action, {
      userId: null,
      actorType: ActorType.SYSTEM,
      action,
      outcome,
      severity: outcome === AuditOutcome.SUCCESS ? AuditSeverity.INFO : AuditSeverity.WARNING,
      entity: 'Payment',
      entityId: paymentId,
      diff,
      metadata: { victimProfileId },
    });
  }
}
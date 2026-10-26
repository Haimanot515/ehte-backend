import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AuditOutcome,
  AuditSeverity,
  Disbursement,
  DisbursementStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { ChapaService } from 'src/infrastructure/chapa/chapa.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  maskAccount,
  money,
} from 'src/modules/core/victim-profile/service/victim-profile.constants';

import { ChapaWebhookService } from './chapa-webhook.service';
import { ACTIVE_DISBURSEMENT, DestinationSnapshot } from './payout.service';
import { DisbursementListQueryDto, PaymentListQueryDto } from '../dto/payments.dto';

const PAYMENT_INCLUDE = {
  victimProfile: { select: { id: true, name: true, involvesChild: true } },
  payerUser: { select: { id: true, name: true, phone: true } },
} satisfies Prisma.PaymentInclude;

type PaymentWithRelations = Prisma.PaymentGetPayload<{ include: typeof PAYMENT_INCLUDE }>;

@Injectable()
export class PaymentsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chapa: ChapaService,
    private readonly webhooks: ChapaWebhookService,
    private readonly cache: CacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Totals ────────────────────────────────────────────────────────────────

  /**
   * raised = PAID payments, sent = PAID transfers, onTheWay = CREATED + SUBMITTED + UNKNOWN,
   * waiting = raised - sent - onTheWay (never below 0). Fees are shown apart and never reduce them.
   */
  async getTotals(victimProfileId?: string) {
    if (victimProfileId) {
      const exists = await this.prisma.victimProfile.findUnique({
        where: { id: victimProfileId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('victim_profile_not_found');
    }

    const scope = victimProfileId ? { victimProfileId } : {};
    const [paid, groups] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { ...scope, status: PaymentStatus.PAID },
        _sum: { amount: true, chapaFee: true },
      }),
      this.prisma.disbursement.groupBy({
        by: ['status'],
        where: scope,
        _sum: { amount: true, transferFee: true },
      }),
    ]);

    const dec = (v: Prisma.Decimal | number | null | undefined) => new Prisma.Decimal(v ?? 0);
    const raised = dec(paid._sum.amount);
    let sent = dec(0);
    let onTheWay = dec(0);
    let transferFees = dec(0);
    for (const g of groups) {
      if (g.status === DisbursementStatus.PAID) {
        sent = sent.add(dec(g._sum.amount));
        transferFees = transferFees.add(dec(g._sum.transferFee));
      } else if (ACTIVE_DISBURSEMENT.includes(g.status)) {
        onTheWay = onTheWay.add(dec(g._sum.amount));
      }
    }

    const left = raised.sub(sent).sub(onTheWay);
    const collectionFees = dec(paid._sum.chapaFee);

    return {
      victimProfileId: victimProfileId ?? null,
      raised: money(raised),
      sent: money(sent),
      onTheWay: money(onTheWay),
      waiting: money(left.lt(0) ? 0 : left),
      fees: {
        collection: money(collectionFees),
        transfer: money(transferFees),
        total: money(collectionFees.add(transferFees)),
      },
    };
  }

  // ── Payments ──────────────────────────────────────────────────────────────

  async listPayments(query: PaymentListQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.PaymentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.victimProfileId ? { victimProfileId: query.victimProfileId } : {}),
      ...this.dateRange(query.from, query.to),
    };

    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: PAYMENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data: rows.map((r) => this.serializePayment(r)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getPayment(id: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: PAYMENT_INCLUDE,
    });
    if (!payment) throw new NotFoundException('payment_not_found');
    return this.serializePayment(payment);
  }

  // ── Transfers (disbursements) ─────────────────────────────────────────────

  async listDisbursements(query: DisbursementListQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.DisbursementWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.victimProfileId ? { victimProfileId: query.victimProfileId } : {}),
      ...this.dateRange(query.from, query.to),
    };

    const [rows, total] = await Promise.all([
      this.prisma.disbursement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.disbursement.count({ where }),
    ]);

    return {
      data: rows.map((r) => this.serializeDisbursement(r)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getDisbursement(id: string) {
    const d = await this.prisma.disbursement.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('disbursement_not_found');
    return this.serializeDisbursement(d);
  }

  // ── Pause / resume transfers for one victim ───────────────────────────────

  /** Stops new transfers and makes Chapa's approval URL refuse any that is already recorded. Donations stay open. */
  async pausePayouts(admin: CurrentUserDto, victimProfileId: string, reason: string) {
    await this.assertProfile(victimProfileId);

    const res = await this.prisma.victimProfile.updateMany({
      where: { id: victimProfileId, payoutsPaused: false },
      data: { payoutsPaused: true },
    });
    if (res.count > 0) {
      this.auditProfile(AuditEventEnum.DISBURSEMENT_HELD, admin, victimProfileId, {
        payoutsPaused: { from: false, to: true },
        reason,
      });
    }
    return { victimProfileId, payoutsPaused: true };
  }

  async resumePayouts(admin: CurrentUserDto, victimProfileId: string) {
    await this.assertProfile(victimProfileId);

    const res = await this.prisma.victimProfile.updateMany({
      where: { id: victimProfileId, payoutsPaused: true },
      data: { payoutsPaused: false },
    });
    if (res.count > 0) {
      this.auditProfile(AuditEventEnum.DISBURSEMENT_RELEASED, admin, victimProfileId, {
        payoutsPaused: { from: true, to: false },
      });
    }
    // The timer job sends whatever is waiting on its next run.
    return { victimProfileId, payoutsPaused: false };
  }

  // ── Payments that need a decision ─────────────────────────────────────────

  /**
   * Only for Payment.status = REVIEW_REQUIRED (Chapa collected a different amount than we asked for).
   * ACCEPT: record what Chapa really collected and send it on like any other donation.
   * REFUND: give the collected money back to the donor. It was never counted as raised.
   */
  async resolveReview(
    admin: CurrentUserDto,
    paymentId: string,
    decision: 'ACCEPT' | 'REFUND',
    reason: string,
  ) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('payment_not_found');
    if (payment.status !== PaymentStatus.REVIEW_REQUIRED) {
      throw new ConflictException('payment_not_in_review');
    }

    if (decision === 'ACCEPT') {
      // Asks Chapa again, so the amount we record is Chapa's, not the admin's.
      const settled = await this.webhooks.settlePayment(payment.txRef, {
        acceptAmountMismatch: true,
      });
      if (settled.status !== PaymentStatus.PAID) {
        throw new ConflictException('payment_not_confirmed_by_chapa');
      }
      this.auditPayment(AuditEventEnum.PAYMENT_REVIEW_RESOLVED, admin, payment.id, {
        decision,
        reason,
        expected: payment.amount.toFixed(2),
        recorded: settled.amount,
      });
      return this.getPayment(payment.id);
    }

    // REFUND. The amount to give back is what Chapa actually holds for this payment.
    const data = await this.chapa.verify(payment.txRef);
    if (data.status !== 'success') throw new ConflictException('payment_not_successful_at_chapa');
    const chapaReference = payment.chapaReference ?? data.reference;
    if (!chapaReference) throw new ConflictException('chapa_reference_missing');
    const refundAmount = new Prisma.Decimal(data.amount);

    // Claim the payment first, so a parallel ACCEPT can never turn the same money into "raised".
    const claim = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.REVIEW_REQUIRED },
      data: { status: PaymentStatus.REFUNDED, chapaReference },
    });
    if (claim.count === 0) throw new ConflictException('payment_not_in_review');

    this.auditPayment(AuditEventEnum.PAYMENT_REFUND_REQUESTED, admin, payment.id, {
      reason,
      amount: refundAmount.toFixed(2),
    });

    try {
      // The reference is fixed per payment, so an admin retry cannot refund twice.
      await this.chapa.refund({
        chapaReference,
        amount: refundAmount,
        reason,
        reference: `ehte-rf-${payment.id}`,
      });
    } catch (err) {
      // Not refunded (or not known to be): put it back for an admin to try again.
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.REFUNDED },
        data: { status: PaymentStatus.REVIEW_REQUIRED },
      });
      this.auditPayment(
        AuditEventEnum.PAYMENT_REFUND_REJECTED,
        admin,
        payment.id,
        { reason: err instanceof Error ? err.message.slice(0, 300) : 'refund_error' },
        AuditOutcome.FAILURE,
      );
      throw err;
    }

    this.auditPayment(AuditEventEnum.PAYMENT_REFUND_EXECUTED, admin, payment.id, {
      amount: refundAmount.toFixed(2),
    });
    this.auditPayment(AuditEventEnum.PAYMENT_REVIEW_RESOLVED, admin, payment.id, {
      decision,
      reason,
    });
    await this.cache.invalidateVictimProfileEverywhere(payment.victimProfileId);

    return this.getPayment(payment.id);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async assertProfile(id: string) {
    const found = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('victim_profile_not_found');
  }

  private dateRange(from?: string, to?: string): { createdAt?: Prisma.DateTimeFilter } {
    if (!from && !to) return {};
    return {
      createdAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      },
    };
  }

  private serializePayment(p: PaymentWithRelations) {
    return {
      id: p.id,
      status: p.status,
      txRef: p.txRef,
      chapaReference: p.chapaReference,
      amount: money(p.amount),
      currency: p.currency,
      chapaFee: p.chapaFee ? money(p.chapaFee) : null,
      failureReason: p.failureReason,
      isAnonymous: p.isAnonymous,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      victimProfile: {
        id: p.victimProfile.id,
        name: p.victimProfile.involvesChild ? null : p.victimProfile.name,
      },
      payer: p.payerUser
        ? { id: p.payerUser.id, name: p.payerUser.name, phone: p.payerUser.phone }
        : null,
    };
  }

  // The full account number never leaves the server through the admin API.
  private serializeDisbursement(d: Disbursement) {
    const snap = d.destinationSnapshot as Partial<DestinationSnapshot> | null;
    return {
      id: d.id,
      victimProfileId: d.victimProfileId,
      status: d.status,
      amount: money(d.amount),
      currency: d.currency,
      reference: d.reference,
      chapaTransferRef: d.chapaTransferRef,
      transferFee: d.transferFee ? money(d.transferFee) : null,
      failureReason: d.failureReason,
      destination: snap
        ? {
            bankName: snap.bankName ?? null,
            bankCode: snap.bankCode ?? null,
            accountNumberMasked: maskAccount(snap.accountNumber),
            accountHolder: snap.accountHolder ?? null,
          }
        : null,
      submittedAt: d.submittedAt,
      paidAt: d.paidAt,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  }

  private auditPayment(
    action: AuditEventEnum,
    admin: CurrentUserDto,
    paymentId: string,
    diff: Record<string, unknown>,
    outcome: AuditOutcome = AuditOutcome.SUCCESS,
  ) {
    this.eventEmitter.emit(action, {
      userId: admin.id,
      actorType: resolveActorType(admin.roles),
      action,
      outcome,
      severity: AuditSeverity.WARNING,
      entity: 'Payment',
      entityId: paymentId,
      diff,
    });
  }

  private auditProfile(
    action: AuditEventEnum,
    admin: CurrentUserDto,
    victimProfileId: string,
    diff: Record<string, unknown>,
  ) {
    this.eventEmitter.emit(action, {
      userId: admin.id,
      actorType: resolveActorType(admin.roles),
      action,
      outcome: AuditOutcome.SUCCESS,
      severity: AuditSeverity.WARNING,
      entity: 'VictimProfile',
      entityId: victimProfileId,
      diff,
      metadata: { victimProfileId },
    });
  }
}
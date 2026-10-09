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
import {
  Payment,
  PaymentStatus,
  PaymentType,
  Prisma,
  AuditOutcome,
  AuditSeverity,
} from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ChapaService } from '../../../../infrastructure/chapa/chapa.service';
import { CronLockService } from '../../../../infrastructure/redis/cron-lock.service';
import { BillingEventsService } from 'src/modules/billing/billing-events/service/billing-events.service';
import {
  AllocationPreview,
  AllocationService,
} from 'src/modules/billing/allocation/service/allocation.service';
import { AuditEventEnum } from '../../../../common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from '../../../../common/enums/shared/notification-events.enum';
import { PaymentVerifiedEvent } from '../../../misc/notification/events/notification.events';
import { MyPaymentsQueryDto, ResolveReviewDto, ReviewDecision } from '../dto/payment.dto';
import { POSTING_FEE_GATE_STATUSES } from '../payment.constants';

export type Payer = { id: string; email?: string | null };

type CheckoutGuard = {
  where: Prisma.PaymentWhereInput;
  lockKey: string;
  paidMessage: string;
  pendingMessage: string;
};

type CheckoutArgs = {
  type: PaymentType;
  amount: Prisma.Decimal;
  payer: Payer;
  preview: AllocationPreview;
  victimProfileId?: string;
  supportId?: string;
  missingPersonId?: string;
  supportAnonymous?: boolean;
  idempotencyKey?: string;
  previewHash?: string;
  guard?: CheckoutGuard;
};

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
    private readonly cronLock: CronLockService,
  ) {
    this.appUrl = config.get<string>('app.url', '');
    this.returnUrl = config.get<string>('payments.returnUrl', '');
    this.minSupport = new Prisma.Decimal(config.get<string>('payments.minSupportEtb', '10'));
    this.fallbackEmail = config.get<string>('chapa.fallbackEmail', '');
  }

  previewSupport(victimProfileId: string, amount: string) {
    return this.allocation.preview(PaymentType.SUPPORT, this.parseAmount(amount), victimProfileId);
  }

  async initiateSupportCheckout(
    payer: Payer,
    victimProfileId: string,
    amountRaw: string,
    anonymous = true,
    idempotencyKey?: string,
    previewHash?: string,
  ) {
    this.assertEnabled('payments.enabled');

    const amount = this.parseAmount(amountRaw);
    if (amount.lt(this.minSupport)) {
      throw new BadRequestException(`Minimum support amount is ${this.minSupport} ETB`);
    }

    const preview = await this.allocation.preview(PaymentType.SUPPORT, amount, victimProfileId);

    return this.startCheckout({
      type: PaymentType.SUPPORT,
      amount: new Prisma.Decimal(preview.total),
      payer,
      preview,
      victimProfileId,
      supportAnonymous: anonymous,
      idempotencyKey,
      previewHash,
    });
  }

  async initiateRewardFunding(
    payer: Payer,
    missingPersonId: string,
    idempotencyKey?: string,
    previewHash?: string,
  ) {
    this.assertEnabled('payments.rewardsEnabled');
    const mp = await this.prisma.missingPerson.findFirst({
      where: { id: missingPersonId, userId: payer.id, rewardOffered: true, rewardApproved: true },
      select: { id: true },
    });
    if (!mp) throw new NotFoundException('No approved reward to fund');

    const already = await this.prisma.payment.findFirst({
      where: {
        missingPersonId,
        type: PaymentType.MISSING_PERSON_REWARD,
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
      idempotencyKey,
      previewHash,
      guard: {
        where: { missingPersonId, type: PaymentType.MISSING_PERSON_REWARD },
        lockKey: `reward:${missingPersonId}`,
        paidMessage: 'This reward is already funded',
        pendingMessage: 'A payment for this reward is already in progress',
      },
    });
  }

  async initiatePostingFeeCheckout(
    payer: Payer,
    objectType: 'VICTIM_PROFILE' | 'MISSING_PERSON',
    objectId: string,
    idempotencyKey?: string,
    previewHash?: string,
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
      idempotencyKey,
      previewHash,
      guard: {
        where: {
          type,
          ...(objectType === 'VICTIM_PROFILE'
            ? { victimProfileId: objectId }
            : { missingPersonId: objectId }),
        },
        lockKey: `posting-fee:${type}:${objectId}`,
        paidMessage: 'This posting fee is already paid',
        pendingMessage: 'A payment for this posting fee is already in progress',
      },
    });
  }

  private assertPreviewUnchanged(preview: AllocationPreview, shown?: string): void {
    if (!shown) {
      if (this.config.get<boolean>('payments.requirePreviewHash', false) === true) {
        throw new BadRequestException('preview_hash_required');
      }
      return;
    }
    if (!/^[a-f0-9]{64}$/.test(shown)) throw new BadRequestException('invalid_preview_hash');
    if (shown !== preview.hash) {
      throw new ConflictException({
        code: 'allocation_changed',
        message: 'The split changed since it was shown. Review the new split and try again.',
        allocation: preview,
      });
    }
  }

  private parseIdempotencyKey(raw?: string): string | undefined {
    if (raw === undefined || raw === '') return undefined;
    if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(raw)) {
      throw new BadRequestException('invalid_idempotency_key');
    }
    return raw;
  }

  private async replayCheckout(args: CheckoutArgs, key: string) {
    const existing = await this.prisma.payment.findFirst({
      where: { payerUserId: args.payer.id, idempotencyKey: key },
    });
    if (!existing) return null;

    const sameRequest =
      existing.type === args.type &&
      existing.amount.equals(args.amount) &&
      existing.victimProfileId === (args.victimProfileId ?? null) &&
      existing.missingPersonId === (args.missingPersonId ?? null);
    if (!sameRequest) {
      throw new ConflictException('idempotency_key_reused_for_a_different_request');
    }
    if (existing.status === 'PENDING' && existing.checkoutUrl) {
      return {
        checkoutUrl: existing.checkoutUrl,
        txRef: existing.txRef,
        allocation: existing.allocationSnapshot as unknown as AllocationPreview,
      };
    }
    throw new ConflictException('a_payment_already_exists_for_this_idempotency_key');
  }

  private createPendingPayment(args: CheckoutArgs, txRef: string, key?: string): Promise<Payment> {
    return this.prisma.$transaction(async (tx) => {
      if (args.guard) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.guard.lockKey}))`;
        const already = await tx.payment.findFirst({
          where: {
            ...args.guard.where,
            OR: [
              { status: 'PAID' },
              { status: 'PENDING', createdAt: { gt: new Date(Date.now() - 30 * 60_000) } },
            ],
          },
          select: { status: true },
        });
        if (already) {
          throw new ConflictException(
            already.status === 'PAID' ? args.guard.paidMessage : args.guard.pendingMessage,
          );
        }
      }
      return tx.payment.create({
        data: {
          type: args.type,
          amount: args.amount,
          currency: 'ETB',
          txRef,
          idempotencyKey: key,
          payerUserId: args.payer.id,
          victimProfileId: args.victimProfileId,
          supportId: args.supportId,
          missingPersonId: args.missingPersonId,
          supportAnonymous: args.supportAnonymous ?? true,
          agreementId: args.preview.agreementId,
          agreementVersion: args.preview.agreementVersion,
          allocationSnapshot: args.preview,
          previewShownAt: new Date(),
        },
      });
    });
  }

  private async startCheckout(args: CheckoutArgs) {
    const email = args.payer.email ?? this.fallbackEmail;
    if (!this.returnUrl || !this.appUrl || !email) {
      throw new ServiceUnavailableException('Payments are not configured');
    }

    const key = this.parseIdempotencyKey(args.idempotencyKey);
    if (key) {
      const replay = await this.replayCheckout(args, key);
      if (replay) return replay;
    }

    // After the replay check, so a retry still gets the original checkout even if the split changed since.
    this.assertPreviewUnchanged(args.preview, args.previewHash);

    const txRef = this.chapa.generateTxRef();
    let payment: Payment;
    try {
      payment = await this.createPendingPayment(args, txRef, key);
    } catch (err) {
      if (key && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const replay = await this.replayCheckout(args, key);
        if (replay) return replay;
      }
      throw err;
    }

    await this.events.log({
      actorId: args.payer.id,
      action: AuditEventEnum.PAYMENT_INITIATED,
      entityType: 'Payment',
      entityId: payment.id,
      metadata: { type: args.type },
    });

    let checkoutUrl: string;
    try {
      ({ checkoutUrl } = await this.chapa.initialize({
        amount: args.amount,
        email,
        firstName: 'Ehte',
        lastName: 'Supporter',
        txRef,
        returnUrl: `${this.returnUrl}?tx_ref=${txRef}`,
        callbackUrl: `${this.appUrl}/billing/webhook/chapa`,
        title: 'Ehte',
        description: 'Ehte payment',
      }));
    } catch (err) {
      if (!this.chapa.isDefiniteRejection(err)) {
        // An unknown outcome stays PENDING so reconcile can still record a checkout the customer completes.
        this.logger.warn(`Checkout initiation outcome unknown for ${txRef}: ${String(err)}`);
        throw err;
      }
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' },
      });

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

    try {
      await this.prisma.payment.updateMany({ where: { id: payment.id }, data: { checkoutUrl } });
    } catch (err) {
      this.logger.warn(`Could not store the checkout url for ${txRef}: ${String(err)}`);
    }
    return { checkoutUrl, txRef, allocation: args.preview };
  }

  async reconcile(txRef: string): Promise<PaymentStatus | null> {
    const payment = await this.prisma.payment.findUnique({ where: { txRef } });
    if (!payment) {
      this.logger.warn(`Reconcile: unknown tx_ref ${txRef}`);
      return null;
    }
    const wasExpired = payment.status === 'EXPIRED';
    if (payment.status !== 'PENDING' && !wasExpired) return payment.status;
    const openStatuses: PaymentStatus[] = ['PENDING', 'EXPIRED'];

    let remote;
    try {
      remote = await this.chapa.verify(txRef);
    } catch (err) {
      this.logger.warn(`Verify failed for ${txRef}: ${String(err)}`);
      return payment.status;
    }

    if (wasExpired && remote.status !== 'success') return 'EXPIRED';

    if (remote.status === 'failed') {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' },
      });

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

    if (!this.chapa.paidAmountMatches(remote, payment)) {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: { in: openStatuses } },
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
        metadata: {
          expected: payment.amount.toFixed(2),
          expectedCurrency: payment.currency,
          received: remote.amount,
          receivedCurrency: remote.currency,
        },
      });
      return 'REVIEW_REQUIRED';
    }

    const snapshot = payment.allocationSnapshot as unknown as AllocationPreview;

    const won = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, status: { in: openStatuses } },
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

      return true;
    });

    if (won) {
      await this.events.log({
        actorId: payment.payerUserId,
        action: AuditEventEnum.PAYMENT_PAID,
        entityType: 'Payment',
        entityId: payment.id,
        metadata: { type: payment.type, ...(wasExpired ? { lateAfterExpiry: true } : {}) },
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
      select: {
        type: true,
        amount: true,
        currency: true,
        allocationSnapshot: true,
        supportId: true,
        fulfilledAt: true,
      },
    });
    return {
      status,
      type: p.type,
      amount: p.amount,
      currency: p.currency,
      allocation: p.allocationSnapshot,
      supportRecorded: p.type === PaymentType.SUPPORT ? !!p.supportId : null,
      supportId: p.supportId,
    };
  }

  async listMine(userId: string, query: MyPaymentsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.PaymentWhereInput = {
      payerUserId: userId,
      ...(query.status ? { status: query.status } : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        select: {
          id: true,
          txRef: true,
          type: true,
          status: true,
          amount: true,
          currency: true,
          victimProfileId: true,
          supportId: true,
          supportAnonymous: true,
          fulfilledAt: true,
          paidAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const items = rows.map((p) => ({
      ...p,
      retryable:
        p.type === PaymentType.SUPPORT &&
        (p.status === 'FAILED' || p.status === 'EXPIRED' || p.status === 'PENDING'),
      awaitingSupportRecord: p.type === PaymentType.SUPPORT && p.status === 'PAID' && !p.supportId,
    }));

    return { total, page, limit, items };
  }

  async resolveReview(adminId: string, paymentId: string, dto: ResolveReviewDto) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== 'REVIEW_REQUIRED') {
      throw new ConflictException('Payment is not awaiting review');
    }

    if (dto.decision === ReviewDecision.REJECT) {
      let held;
      try {
        held = await this.chapa.verify(payment.txRef);
      } catch (err) {
        this.logger.warn(`Verify failed for ${payment.txRef}: ${String(err)}`);
        throw new ServiceUnavailableException(
          'Could not verify this payment with Chapa. Try again shortly.',
        );
      }

      let heldAmount: Prisma.Decimal | null = null;
      if (held.status === 'success') {
        try {
          heldAmount = new Prisma.Decimal(held.amount);
        } catch {
          throw new BadRequestException('unreadable_amount_from_chapa');
        }
      }
      const moneyHeld = !!heldAmount && heldAmount.gt(0);

      const { count } = await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'REVIEW_REQUIRED' },
        data: {
          status: 'FAILED',
          ...(moneyHeld
            ? {
                chapaReference: held.reference ?? null,
                refundStatus: 'REQUESTED',
                refundAmount: heldAmount,
                refundReason: `review_rejected: ${dto.reason}`.slice(0, 500),
                refundRequestedById: adminId,
                refundRequestedAt: new Date(),
              }
            : {}),
        },
      });
      if (count === 0) throw new ConflictException('Payment is not awaiting review');

      await this.events.log({
        actorId: adminId,
        action: AuditEventEnum.PAYMENT_REVIEW_RESOLVED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entityType: 'Payment',
        entityId: payment.id,
        metadata: {
          decision: dto.decision,
          reason: dto.reason,
          moneyHeld,
          received: heldAmount ? heldAmount.toFixed(2) : null,
        },
      });
      return { status: 'FAILED' as PaymentStatus, refundRequested: moneyHeld };
    }

    let remote;
    try {
      remote = await this.chapa.verify(payment.txRef);
    } catch (err) {
      this.logger.warn(`Verify failed for ${payment.txRef}: ${String(err)}`);
      throw new ServiceUnavailableException(
        'Could not verify this payment with Chapa. Try again shortly.',
      );
    }
    if (remote.status !== 'success') {
      throw new ConflictException('Chapa does not report this payment as successful');
    }
    if (String(remote.currency).toUpperCase() !== String(payment.currency).toUpperCase()) {
      throw new BadRequestException({ code: 'paid_currency_mismatch' });
    }
    const received = new Prisma.Decimal(remote.amount);
    if (received.lt(payment.amount)) {
      throw new BadRequestException({
        code: 'paid_amount_short',
        expected: payment.amount.toFixed(2),
        received: received.toFixed(2),
      });
    }
    const excess = received.sub(payment.amount);

    const snapshot = payment.allocationSnapshot as unknown as AllocationPreview;

    const won = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, status: 'REVIEW_REQUIRED' },
        data: {
          excessAmount: excess.gt(0) ? excess : null,
          excessResolvedById: excess.gt(0) ? adminId : null,
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

      return true;
    });

    if (!won) throw new ConflictException('Payment is not awaiting review');

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYMENT_REVIEW_RESOLVED,
      entityType: 'Payment',
      entityId: payment.id,
      metadata: {
        decision: dto.decision,
        reason: dto.reason,
        received: received.toFixed(2),
        excess: excess.toFixed(2),
      },
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
    await this.cronLock.runExclusive('payment:reconcile-stale', 9 * 60_000, () =>
      this.runReconcileStale(),
    );
  }

  private async runReconcileStale(): Promise<void> {
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

        if (count > 0) {
          await this.events.log({
            actorId: null,
            action: AuditEventEnum.PAYMENT_EXPIRED,

            severity: AuditSeverity.WARNING,
            entityType: 'Payment',
            entityId: p.id,
            metadata: { reason: 'reconcile_stale_timeout' },
          });
        }
      }
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async reconcileExpired(): Promise<void> {
    await this.cronLock.runExclusive('payment:reconcile-expired', 55 * 60_000, () =>
      this.runReconcileExpired(),
    );
  }

  private async runReconcileExpired(): Promise<void> {
    const expired = await this.prisma.payment.findMany({
      where: { status: 'EXPIRED', createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) } },
      select: { txRef: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    for (const p of expired) {
      await this.reconcile(p.txRef);
    }
  }

  private assertEnabled(flag: 'payments.enabled' | 'payments.rewardsEnabled'): void {
    if (this.config.get<boolean>(flag) !== true) {
      throw new ServiceUnavailableException('This payment feature is not enabled yet');
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async repairUnfulfilledPayments(): Promise<void> {
    await this.cronLock.runExclusive('payment:repair-unfulfilled', 9 * 60_000, () =>
      this.runRepairUnfulfilledPayments(),
    );
  }

  private async runRepairUnfulfilledPayments(): Promise<void> {
    const paidAt = {
      lt: new Date(Date.now() - 2 * 60_000),
      gt: new Date(Date.now() - 7 * 86_400_000),
    };

    const rewards = await this.prisma.payment.findMany({
      where: { status: 'PAID', type: PaymentType.MISSING_PERSON_REWARD, fulfilledAt: null, paidAt },
      select: { id: true, missingPersonId: true },
      take: 200,
    });
    for (const p of rewards) {
      await this.events.paymentPaid({
        paymentId: p.id,
        supportId: null,
        missingPersonId: p.missingPersonId,
      });
    }

    const supportPayments = await this.prisma.payment.findMany({
      where: {
        status: 'PAID',
        type: PaymentType.SUPPORT,
        fulfilledAt: null,
        supportId: null,
        paidAt,
      },
      select: { id: true, paidAt: true },
      take: 200,
    });
    for (const p of supportPayments) {
      await this.events.paymentPaid({ paymentId: p.id, supportId: null, missingPersonId: null });
    }

    const stuckCount = supportPayments.filter(
      (p) => p.paidAt && p.paidAt.getTime() < Date.now() - 30 * 60_000,
    ).length;
    if (stuckCount > 0) {
      this.logger.warn(
        `${stuckCount} paid support payment(s) still have no Support after 30 minutes`,
      );
    }

    const fees = await this.prisma.payment.findMany({
      where: {
        status: 'PAID',
        type: {
          in: [PaymentType.VICTIM_PROFILE_POSTING_FEE, PaymentType.MISSING_PERSON_POSTING_FEE],
        },
        paidAt,
      },
      select: { id: true, type: true, victimProfileId: true, missingPersonId: true },
      take: 200,
    });
    if (fees.length === 0) return;

    const gate = [...POSTING_FEE_GATE_STATUSES];
    const profileIds = fees.flatMap((p) =>
      p.type === PaymentType.VICTIM_PROFILE_POSTING_FEE && p.victimProfileId
        ? [p.victimProfileId]
        : [],
    );
    const personIds = fees.flatMap((p) =>
      p.type === PaymentType.MISSING_PERSON_POSTING_FEE && p.missingPersonId
        ? [p.missingPersonId]
        : [],
    );

    const [profiles, persons] = await Promise.all([
      this.prisma.victimProfile.findMany({
        where: { id: { in: profileIds }, postingFeeStatus: { notIn: gate } },
        select: { id: true },
      }),
      this.prisma.missingPerson.findMany({
        where: { id: { in: personIds }, postingFeeStatus: { notIn: gate } },
        select: { id: true },
      }),
    ]);
    const openProfiles = new Set(profiles.map((x) => x.id));
    const openPersons = new Set(persons.map((x) => x.id));

    for (const p of fees) {
      const open =
        p.type === PaymentType.VICTIM_PROFILE_POSTING_FEE
          ? !!p.victimProfileId && openProfiles.has(p.victimProfileId)
          : !!p.missingPersonId && openPersons.has(p.missingPersonId);
      if (!open) continue;
      await this.events.paymentPaid({
        paymentId: p.id,
        supportId: null,
        missingPersonId: p.missingPersonId,
      });
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
        FROM "payments"
        WHERE status = 'PAID' AND "paidAt" IS NOT NULL
      `,

      this.prisma.$queryRaw<{ day: Date; count: bigint; total: number | null }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count, SUM(amount) AS total
        FROM "payments"
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

    // Policy: the platform bears the Chapa fee. byPartyType is gross, so the platform's real share is net of fees.
    const totalChapaFees = Number(paidAgg._sum.chapaFee ?? 0);
    const platformGross = byPartyType['PLATFORM'] ?? 0;

    return {
      total,
      byStatus,
      byType,
      byPartyType,
      platformNetOfChapaFees: Number((platformGross - totalChapaFees).toFixed(2)),

      paid: {
        count: paidAgg._count,
        totalAmount: Number(paidAgg._sum.amount ?? 0),
        totalChapaFees,
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
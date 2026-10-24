import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes } from 'crypto';
import {
  ActorType,
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
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { ChapaService } from 'src/infrastructure/chapa/chapa.service';
import { CronLockService } from 'src/infrastructure/redis/cron-lock.service';
import { maskAccount } from 'src/modules/core/victim-profile/service/victim-profile.constants';

// A transfer in any of these states may still move money, so no second one is allowed for the same victim.
export const ACTIVE_DISBURSEMENT: DisbursementStatus[] = [
  DisbursementStatus.CREATED,
  DisbursementStatus.SUBMITTED,
  DisbursementStatus.UNKNOWN,
];

export type DestinationSnapshot = {
  destinationId: string;
  bankName: string;
  bankCode: string;
  accountNumber: string;
  accountHolder: string;
};

export type VictimBalance = {
  raised: Prisma.Decimal; // confirmed donations (PAID)
  sent: Prisma.Decimal; // transfers Chapa confirmed (PAID)
  onTheWay: Prisma.Decimal; // CREATED + SUBMITTED + UNKNOWN
  waiting: Prisma.Decimal; // confirmed, not yet part of any transfer
};

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);
  private readonly enabled: boolean;
  private readonly currency: string;
  private readonly minTransfer: Prisma.Decimal;
  private readonly retryAfterFailureMinutes: number;
  private readonly timeoutMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chapa: ChapaService,
    private readonly cronLock: CronLockService,
    private readonly eventEmitter: EventEmitter2,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('payments.enabled', false);
    this.currency = config.get<string>('support.currency', 'ETB');
    this.minTransfer = new Prisma.Decimal(config.get<string>('disbursement.minTransferEtb', '1'));
    this.retryAfterFailureMinutes = config.get<number>('disbursement.retryAfterFailureMinutes', 15);
    this.timeoutMinutes = config.get<number>('disbursement.processingTimeoutMinutes', 60);
  }

  // ── Balance ───────────────────────────────────────────────────────────────

  async getBalance(victimProfileId: string): Promise<VictimBalance> {
    const [paid, groups] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { victimProfileId, status: PaymentStatus.PAID },
        _sum: { amount: true },
      }),
      this.prisma.disbursement.groupBy({
        by: ['status'],
        where: { victimProfileId },
        _sum: { amount: true },
      }),
    ]);

    const raised = new Prisma.Decimal(paid._sum.amount ?? 0);
    let sent = new Prisma.Decimal(0);
    let onTheWay = new Prisma.Decimal(0);
    for (const g of groups) {
      const amount = new Prisma.Decimal(g._sum.amount ?? 0);
      if (g.status === DisbursementStatus.PAID) sent = sent.add(amount);
      else if (ACTIVE_DISBURSEMENT.includes(g.status)) onTheWay = onTheWay.add(amount);
    }

    const left = raised.sub(sent).sub(onTheWay);
    return { raised, sent, onTheWay, waiting: left.lt(0) ? new Prisma.Decimal(0) : left };
  }

  // ── Create and send one transfer ──────────────────────────────────────────

  /**
   * Sends the victim's confirmed, unsent balance. Safe to call from the webhook, the timer job
   * and the admin button at the same time: the VictimProfile row is locked while the transfer is
   * recorded, so two callers can never both see the same "unsent" money.
   */
  async runForVictim(
    victimProfileId: string,
    actor?: CurrentUserDto,
  ): Promise<{ disbursementId: string | null; reason?: string }> {
    if (!this.enabled) return { disbursementId: null, reason: 'payments_disabled' };

    // Step 1: decide and RECORD the transfer (CREATED) before anything is sent.
    const prepared = await this.prisma.runInTransaction(async () => {
      await this.prisma.$queryRaw`SELECT id FROM victim_profile WHERE id = ${victimProfileId} FOR UPDATE`;

      const profile = await this.prisma.victimProfile.findUnique({
        where: { id: victimProfileId },
        select: {
          id: true,
          payoutsPaused: true,
          deletedAt: true,
          takedownAt: true,
          legalHold: true,
          payoutDestination: true,
        },
      });
      if (!profile) throw new NotFoundException('victim_profile_not_found');
      if (profile.payoutsPaused) return { skip: 'payouts_paused' as const };
      if (profile.deletedAt || profile.takedownAt || profile.legalHold) {
        return { skip: 'profile_blocked' as const };
      }

      const destination = profile.payoutDestination;
      if (!destination || !destination.isVerified) return { skip: 'no_verified_destination' as const };

      const active = await this.prisma.disbursement.findFirst({
        where: { victimProfileId, status: { in: ACTIVE_DISBURSEMENT } },
        select: { id: true },
      });
      if (active) return { skip: 'transfer_in_progress' as const };

      const since = new Date(Date.now() - this.retryAfterFailureMinutes * 60_000);
      const recentFailure = await this.prisma.disbursement.findFirst({
        where: { victimProfileId, status: DisbursementStatus.FAILED, updatedAt: { gt: since } },
        select: { id: true },
      });
      if (recentFailure) return { skip: 'recent_failure' as const };

      const balance = await this.getBalance(victimProfileId);
      if (balance.waiting.lt(this.minTransfer)) return { skip: 'nothing_to_send' as const };

      const snapshot: DestinationSnapshot = {
        destinationId: destination.id,
        bankName: destination.bankName,
        bankCode: destination.bankCode,
        accountNumber: destination.accountNumber,
        accountHolder: destination.accountHolder,
      };

      const disbursement = await this.prisma.disbursement.create({
        data: {
          victimProfileId,
          amount: balance.waiting,
          currency: this.currency,
          reference: `ehte-tr-${randomBytes(12).toString('hex')}`,
          destinationSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        },
      });
      return { disbursement, snapshot };
    });

    if ('skip' in prepared) return { disbursementId: null, reason: prepared.skip };

    const { disbursement, snapshot } = prepared;
    this.audit(AuditEventEnum.DISBURSEMENT_CREATED, disbursement, actor, {
      amount: disbursement.amount.toFixed(2),
      accountNumberMasked: maskAccount(snapshot.accountNumber),
    });

    // Step 2: send it. Chapa then calls our approval URL, which re-checks the same record.
    try {
      await this.chapa.transfer({
        accountName: snapshot.accountHolder,
        accountNumber: snapshot.accountNumber,
        bankCode: snapshot.bankCode,
        amount: disbursement.amount,
        reference: disbursement.reference,
      });
      await this.prisma.disbursement.updateMany({
        where: { id: disbursement.id, status: DisbursementStatus.CREATED },
        data: { status: DisbursementStatus.SUBMITTED, submittedAt: new Date() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : 'transfer_error';
      if (this.chapa.isDefiniteRejection(err)) {
        // Chapa clearly refused it, so nothing was sent and a later retry is safe.
        await this.markFailed(disbursement.id, message, actor);
      } else {
        // Timeout, 5xx or network error: we do not know. Never resend; the checker decides later.
        await this.prisma.disbursement.updateMany({
          where: { id: disbursement.id, status: DisbursementStatus.CREATED },
          data: { status: DisbursementStatus.UNKNOWN, failureReason: 'chapa_no_clear_answer' },
        });
        this.logger.warn(`Transfer ${disbursement.reference} is UNKNOWN: ${message}`);
      }
    }

    return { disbursementId: disbursement.id };
  }

  // ── Check an unclear transfer (never resends) ─────────────────────────────

  async checkDisbursement(id: string, actor?: CurrentUserDto): Promise<Disbursement> {
    const d = await this.prisma.disbursement.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('disbursement_not_found');
    if (!ACTIVE_DISBURSEMENT.includes(d.status)) return d;

    const ageMinutes = (Date.now() - d.createdAt.getTime()) / 60_000;

    let status: string;
    try {
      status = (await this.chapa.verifyTransfer(d.reference)).status.toLowerCase();
    } catch (err) {
      // Chapa has no record of this reference. After the timeout that is treated as "never received",
      // which is the only case where a failed transfer is released without Chapa saying "failed".
      // Confirm this rule with Chapa before go-live.
      if (this.chapa.isDefiniteRejection(err) && ageMinutes >= this.timeoutMinutes) {
        await this.markFailed(d.id, 'not_found_at_chapa_after_timeout', actor);
      }
      return (await this.prisma.disbursement.findUnique({ where: { id } })) ?? d;
    }

    if (status === 'success') {
      await this.markPaid(d, actor);
    } else if (status === 'failed' || status === 'reverted') {
      await this.markFailed(d.id, `chapa_${status}`, actor);
    } else if (d.status !== DisbursementStatus.SUBMITTED) {
      // Chapa has it and it is still pending.
      await this.prisma.disbursement.updateMany({
        where: { id: d.id, status: { in: [DisbursementStatus.CREATED, DisbursementStatus.UNKNOWN] } },
        data: { status: DisbursementStatus.SUBMITTED, submittedAt: d.submittedAt ?? new Date() },
      });
    }

    return (await this.prisma.disbursement.findUnique({ where: { id } })) ?? d;
  }

  async checkByReference(reference: string): Promise<void> {
    const d = await this.prisma.disbursement.findUnique({
      where: { reference },
      select: { id: true },
    });
    if (d) await this.checkDisbursement(d.id);
  }

  private async markPaid(d: Disbursement, actor?: CurrentUserDto) {
    const res = await this.prisma.disbursement.updateMany({
      where: { id: d.id, status: { in: ACTIVE_DISBURSEMENT } },
      data: { status: DisbursementStatus.PAID, paidAt: new Date(), failureReason: null },
    });
    if (res.count === 0) return;

    this.audit(AuditEventEnum.DISBURSEMENT_EXECUTED, d, actor, { amount: d.amount.toFixed(2) });

    const profile = await this.prisma.victimProfile.findUnique({
      where: { id: d.victimProfileId },
      select: { createdByUserId: true },
    });
    if (profile?.createdByUserId) {
      this.eventEmitter.emit(NotificationEventEnum.DISBURSEMENT_PAID_OUT, {
        userId: profile.createdByUserId,
        disbursementId: d.id,
        partyType: 'VICTIM',
      });
    }
  }

  private async markFailed(id: string, reason: string, actor?: CurrentUserDto) {
    const res = await this.prisma.disbursement.updateMany({
      where: { id, status: { in: ACTIVE_DISBURSEMENT } },
      data: { status: DisbursementStatus.FAILED, failureReason: reason },
    });
    if (res.count === 0) return;
    const d = await this.prisma.disbursement.findUnique({ where: { id } });
    if (d) this.audit(AuditEventEnum.DISBURSEMENT_FAILED, d, actor, { reason }, AuditOutcome.FAILURE);
  }

  // ── Timer job: the safety net ─────────────────────────────────────────────

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    if (!this.enabled) return;

    await this.cronLock.runExclusive('payout-sweep', 4 * 60_000, async () => {
      // 1. Ask Chapa about transfers that have been sitting unresolved.
      const stale = await this.prisma.disbursement.findMany({
        where: {
          status: { in: ACTIVE_DISBURSEMENT },
          updatedAt: { lt: new Date(Date.now() - 2 * 60_000) },
        },
        select: { id: true },
        orderBy: { updatedAt: 'asc' },
        take: 100,
      });
      for (const s of stale) {
        await this.checkDisbursement(s.id).catch((e) =>
          this.logger.warn(`check ${s.id} failed: ${String(e)}`),
        );
      }

      // 2. Send confirmed donations that no transfer has picked up yet (missed or waiting for verification).
      const victims = await this.prisma.payment.groupBy({
        by: ['victimProfileId'],
        where: { status: PaymentStatus.PAID, victimProfile: { payoutsPaused: false } },
        orderBy: { victimProfileId: 'asc' },
        take: 1000,
      });
      for (const v of victims) {
        await this.runForVictim(v.victimProfileId).catch((e) =>
          this.logger.warn(`payout ${v.victimProfileId} failed: ${String(e)}`),
        );
      }
    });
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  private audit(
    action: AuditEventEnum,
    d: Pick<Disbursement, 'id' | 'victimProfileId' | 'reference'>,
    actor: CurrentUserDto | undefined,
    diff: Record<string, unknown>,
    outcome: AuditOutcome = AuditOutcome.SUCCESS,
  ) {
    this.eventEmitter.emit(action, {
      userId: actor?.id ?? null,
      actorType: actor ? resolveActorType(actor.roles) : ActorType.SYSTEM,
      action,
      outcome,
      severity: AuditSeverity.WARNING,
      entity: 'Disbursement',
      entityId: d.id,
      entityLabel: d.reference,
      diff,
      metadata: { victimProfileId: d.victimProfileId },
    });
  }
}
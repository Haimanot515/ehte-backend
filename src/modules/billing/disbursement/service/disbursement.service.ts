import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DisbursementMethod, Prisma, AuditOutcome, AuditSeverity } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ChapaService } from '../../../../infrastructure/chapa/chapa.service';
import { CronLockService } from '../../../../infrastructure/redis/cron-lock.service';
import { BillingEventsService } from 'src/modules/billing/billing-events/service/billing-events.service';
import { AuditEventEnum } from '../../../../common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from '../../../../common/enums/shared/notification-events.enum';
import { DisbursementPaidOutEvent } from '../../../misc/notification/events/notification.events';

const SYNC_INTERVAL_MS = 10 * 60_000;
const SYNC_BATCH_SIZE = 50;
const SYNC_MAX_BATCHES = 10;
const STALE_ALERT_REPEAT_MS = 6 * 3_600_000;
const STALE_CRITICAL_AFTER_MS = 24 * 3_600_000;

export type ExecuteInput = {
  accountName?: string;
  accountNumber?: string;
  bankCode?: string;
  externalReference?: string;
};

@Injectable()
export class DisbursementService {
  private readonly logger = new Logger(DisbursementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chapa: ChapaService,
    private readonly events: BillingEventsService,
    private readonly configService: ConfigService,
    private readonly cronLock: CronLockService,
  ) {}

  private get processingTimeoutMinutes(): number {
    return this.configService.get<number>('disbursement.processingTimeoutMinutes', 60);
  }

  async create(
    adminId: string,
    allocationId: string,
    method: DisbursementMethod,
    rewardClaimId?: string,
  ) {
    const allocation = await this.prisma.paymentAllocation.findUnique({
      where: { id: allocationId },
      include: { payment: true, disbursements: true },
    });
    if (!allocation) throw new NotFoundException('Allocation not found');
    this.assertPaymentPayable(allocation.payment);
    if (!['PENDING', 'PARTIALLY_PAID_OUT'].includes(allocation.settlementStatus)) {
      throw new BadRequestException('Allocation is not payable');
    }
    if (
      allocation.partyType !== 'REWARD_BENEFICIARY' &&
      allocation.disbursements.some((d) => !['FAILED', 'CANCELLED'].includes(d.status))
    ) {
      throw new BadRequestException('A disbursement already exists for this allocation');
    }
    if (allocation.partyType === 'RECIPIENT') {
      await this.loadPayableRecipient(allocation.payment.victimProfileId);
    }

    let amount = allocation.amount;

    if (allocation.partyType === 'REWARD_BENEFICIARY') {
      if (!rewardClaimId) {
        throw new BadRequestException('rewardClaimId is required for a reward payout');
      }
      const claim = await this.prisma.rewardClaim.findUnique({ where: { id: rewardClaimId } });
      if (!claim || claim.missingPersonId !== allocation.payment.missingPersonId) {
        throw new BadRequestException('Reward claim does not belong to this payment');
      }
      if (claim.status !== 'APPROVED_FOR_REWARD') {
        throw new BadRequestException('Reward claim has not been approved for a reward');
      }
      if (!claim.rewardAmount) {
        throw new BadRequestException('Reward claim has no allocated amount');
      }
      if (
        allocation.disbursements.some(
          (d) => d.rewardClaimId === rewardClaimId && !['FAILED', 'CANCELLED'].includes(d.status),
        )
      ) {
        throw new BadRequestException('This claim has already been disbursed');
      }
      await this.assertRewardPayable(allocation.partyType, allocation.payment.missingPersonId);
      const alreadyCommitted = allocation.disbursements
        .filter((d) => !['FAILED', 'CANCELLED'].includes(d.status))
        .reduce((sum, d) => sum.add(d.amount), new Prisma.Decimal(0));
      if (alreadyCommitted.add(claim.rewardAmount).gt(allocation.amount)) {
        throw new BadRequestException('Split disbursements would exceed the funded reward pool');
      }
      amount = claim.rewardAmount;
    }

    const d = await this.prisma.disbursement.create({
      data: {
        allocationId,
        rewardClaimId: allocation.partyType === 'REWARD_BENEFICIARY' ? rewardClaimId : null,
        method,
        amount,
        reference: this.chapa.generateTxRef('dsb'),
        createdById: adminId,
      },
    });
    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.DISBURSEMENT_CREATED,
      entityType: 'Disbursement',
      entityId: d.id,
    });
    return d;
  }

  async approve(adminId: string, id: string) {
    const d = await this.prisma.disbursement.findUnique({
      where: { id },
      include: { allocation: { include: { payment: true } } },
    });
    if (!d) throw new NotFoundException('Disbursement not found');
    if (d.heldAt) throw new BadRequestException('Disbursement is on hold');
    this.assertPaymentPayable(d.allocation.payment);
    await this.assertRewardPayable(d.allocation.partyType, d.allocation.payment.missingPersonId);
    if (d.createdById === adminId) {
      await this.events.log({
        actorId: adminId,
        action: AuditEventEnum.DISBURSEMENT_APPROVED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entityType: 'Disbursement',
        entityId: id,
        metadata: { reason: 'same_admin_cannot_approve_own_disbursement' },
      });
      throw new ForbiddenException('A different admin must approve');
    }

    const { count } = await this.prisma.disbursement.updateMany({
      where: { id, status: 'PENDING_APPROVAL' },
      data: { status: 'APPROVED', approvedById: adminId },
    });
    if (count === 0) {
      await this.events.log({
        actorId: adminId,
        action: AuditEventEnum.DISBURSEMENT_APPROVED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entityType: 'Disbursement',
        entityId: id,
        metadata: { reason: 'not_awaiting_approval', currentStatus: d.status },
      });
      throw new BadRequestException('Not awaiting approval');
    }
    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.DISBURSEMENT_APPROVED,
      entityType: 'Disbursement',
      entityId: id,
    });
  }

  async cancel(adminId: string, id: string, reason: string) {
    const d = await this.prisma.disbursement.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!d) throw new NotFoundException('Disbursement not found');

    const { count } = await this.prisma.disbursement.updateMany({
      where: { id, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } },
      data: { status: 'CANCELLED' },
    });
    if (count === 0) {
      throw new BadRequestException(`A disbursement that is ${d.status} cannot be cancelled`);
    }
    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.DISBURSEMENT_CANCELLED,
      entityType: 'Disbursement',
      entityId: id,
      reason,
    });
  }

  listBanks() {
    return this.chapa.getBanks();
  }

  async execute(adminId: string, id: string, input: ExecuteInput) {
    const d = await this.prisma.disbursement.findUnique({
      where: { id },
      include: { allocation: { include: { payment: true } } },
    });
    if (!d) throw new NotFoundException('Disbursement not found');
    if (d.heldAt) throw new BadRequestException('Disbursement is on hold');
    this.assertPaymentPayable(d.allocation.payment);
    await this.assertRewardPayable(d.allocation.partyType, d.allocation.payment.missingPersonId);

    let account: { accountName: string; accountNumber: string; bankCode: string } | null = null;
    let destinationId: string | null = null;
    let destinationSnapshot: Prisma.InputJsonValue | undefined;
    if (d.allocation.partyType === 'RECIPIENT') {
      const dest = await this.loadPayableRecipient(d.allocation.payment.victimProfileId);
      account = {
        accountName: dest.accountHolder,
        accountNumber: dest.accountNumber as string,
        bankCode: dest.bankCode as string,
      };
      destinationId = dest.id;
      destinationSnapshot = {
        rail: dest.rail,
        bankName: dest.bankName,
        bankCode: dest.bankCode,
        accountNumberMasked: `****${(dest.accountNumber as string).slice(-4)}`,
        accountHolder: dest.accountHolder,
        verifiedById: dest.verifiedById,
        verifiedAt: dest.verifiedAt?.toISOString() ?? null,
      };
    } else if (d.allocation.partyType === 'RESPONSIBLE_ORGANIZATION' && d.allocation.institutionId) {
      const dest = await this.loadInstitutionDestination(d.allocation.institutionId);
      if (dest) {
        account = {
          accountName: dest.accountHolder,
          accountNumber: dest.accountNumber as string,
          bankCode: dest.bankCode as string,
        };
        destinationId = dest.id;
        destinationSnapshot = {
          rail: dest.rail,
          bankName: dest.bankName,
          bankCode: dest.bankCode,
          accountNumberMasked: `****${(dest.accountNumber as string).slice(-4)}`,
          accountHolder: dest.accountHolder,
          verifiedById: dest.verifiedById,
          verifiedAt: dest.verifiedAt?.toISOString() ?? null,
        };
      } else if (d.method === 'CHAPA_TRANSFER') {
        throw new BadRequestException('institution_payout_destination_not_verified');
      }
    } else if (input.accountName && input.accountNumber && input.bankCode) {
      // Typed account details are not verified, so the approver may not also execute and the account is recorded.
      if (d.approvedById === adminId) {
        throw new ForbiddenException('A different admin must execute a payout to a typed account');
      }
      account = {
        accountName: input.accountName,
        accountNumber: input.accountNumber,
        bankCode: input.bankCode,
      };
      destinationSnapshot = {
        source: 'admin_supplied',
        bankCode: input.bankCode,
        accountNumberMasked: `****${input.accountNumber.slice(-4)}`,
        accountHolder: input.accountName,
        suppliedById: adminId,
      };
    }
    if (d.method === 'CHAPA_TRANSFER' && !account) {
      throw new BadRequestException('Account details and bankCode are required');
    }
    if (d.method === 'MANUAL_BANK' && !input.externalReference) {
      throw new BadRequestException('externalReference (bank slip) is required');
    }

    const { count } = await this.prisma.disbursement.updateMany({
      where: {
        id,
        status: 'APPROVED',
        allocation: {
          payment: {
            status: 'PAID',
            heldAt: null,
            OR: [{ refundStatus: null }, { refundStatus: { notIn: ['REQUESTED', 'PROCESSING'] } }],
          },
        },
      },
      data: {
        status: 'PROCESSING',
        executedById: adminId,
        executedAt: new Date(),
        ...(destinationId ? { payoutDestinationId: destinationId } : {}),
        ...(destinationSnapshot ? { destinationSnapshot } : {}),
      },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Not approved, already executed, or the payment is held or being refunded',
      );
    }

    try {
      if (d.method === 'CHAPA_TRANSFER') {
        await this.chapa.transfer({
          accountName: (account as { accountName: string }).accountName,
          accountNumber: (account as { accountNumber: string }).accountNumber,
          bankCode: (account as { bankCode: string }).bankCode,
          amount: d.amount,
          reference: d.reference,
        });
      } else {
        const outcome = await this.prisma.$transaction(async (tx) => {
          await tx.disbursement.update({
            where: { id },
            data: { externalReference: input.externalReference },
          });
          return this.markPaidOut(tx, id);
        });
        if (outcome.paid) {
          await this.notifyPaidOut(
            id,
            outcome.partyType,
            outcome.missingPersonId,
            outcome.rewardClaimId,
          );
        }
      }
    } catch (err) {
      if (d.method === 'CHAPA_TRANSFER' && !this.isDefiniteRejection(err)) {
        await this.events.log({
          actorId: adminId,
          action: AuditEventEnum.SECURITY_ALERT,
          severity: AuditSeverity.WARNING,
          entityType: 'Disbursement',
          entityId: id,
          metadata: { reason: 'transfer_outcome_unknown' },
        });
        throw new ServiceUnavailableException(
          'Transfer outcome is unknown and will be checked automatically. Do not create another disbursement.',
        );
      }
      await this.prisma.disbursement.update({
        where: { id },
        data: { status: 'FAILED', failureReason: String((err as Error).message).slice(0, 200) },
      });
      await this.events.log({
        actorId: adminId,
        action: AuditEventEnum.DISBURSEMENT_FAILED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entityType: 'Disbursement',
        entityId: id,
      });
      throw err;
    }

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.DISBURSEMENT_EXECUTED,
      entityType: 'Disbursement',
      entityId: id,
      metadata: {
        method: d.method,
        partyType: d.allocation.partyType,
        destination:
          d.allocation.partyType === 'RECIPIENT' ? 'payout_destination' : 'admin_supplied',
      },
    });
  }

  async markPaidManually(adminId: string, id: string, externalReference: string, reason: string) {
    const d = await this.prisma.disbursement.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Disbursement not found');
    if (d.status !== 'PROCESSING') {
      throw new BadRequestException('Only a disbursement that is PROCESSING can be marked paid');
    }
    if (d.executedById === adminId) {
      throw new ForbiddenException('A different admin must confirm a manual payout');
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.disbursement.update({ where: { id }, data: { externalReference } });
      return this.markPaidOut(tx, id);
    });
    if (!outcome.paid) throw new BadRequestException('Disbursement was already settled');

    await this.notifyPaidOut(id, outcome.partyType, outcome.missingPersonId, outcome.rewardClaimId);

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.DISBURSEMENT_MARKED_PAID,
      entityType: 'Disbursement',
      entityId: id,
      reason,
      severity: AuditSeverity.WARNING,
      metadata: { externalReference, executedById: d.executedById },
    });

    return { id, status: 'PAID_OUT' };
  }

  private isDefiniteRejection(err: unknown): boolean {
    const e = err as {
      status?: number;
      response?: { status?: number };
      getStatus?: () => number;
    };
    const status =
      typeof e.getStatus === 'function' ? e.getStatus() : (e.response?.status ?? e.status);
    return (
      typeof status === 'number' &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 429
    );
  }

  private assertPaymentPayable(payment: {
    status: string;
    heldAt: Date | null;
    refundStatus: string | null;
  }): void {
    if (payment.status !== 'PAID') throw new BadRequestException('Payment is not settled');
    if (payment.heldAt) throw new BadRequestException('Payment is on hold');
    if (['REQUESTED', 'PROCESSING'].includes(payment.refundStatus ?? '')) {
      throw new BadRequestException('A refund is pending for this payment');
    }
  }

  private async assertRewardPayable(
    partyType: string,
    missingPersonId: string | null,
  ): Promise<void> {
    if (partyType !== 'REWARD_BENEFICIARY') return;
    if (!missingPersonId) throw new BadRequestException('Reward payment has no case');
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: { fundingStatus: true },
    });
    if (!mp || mp.fundingStatus === 'REFUND_DUE' || mp.fundingStatus === 'REFUNDED') {
      throw new BadRequestException('The reward for this case is closed');
    }
  }

  private loadInstitutionDestination(institutionId: string) {
    return this.prisma.payoutDestination.findFirst({
      where: {
        institutionId,
        isVerified: true,
        rail: 'BANK',
        accountNumber: { not: null },
        bankCode: { not: null },
      },
      orderBy: { verifiedAt: 'desc' },
    });
  }

  private async loadPayableRecipient(profileId: string | null) {
    if (!profileId) throw new BadRequestException('recipient_profile_missing');
    const p = await this.prisma.victimProfile.findUnique({
      where: { id: profileId },
      select: {
        status: true,
        involvesChild: true,
        isVerified: true,
        isSafetyReviewed: true,
        isChildSafetyReviewed: true,
        hasConsent: true,
        isPrivacyReviewed: true,
        isAdminApproved: true,
        payoutDestination: {
          select: {
            id: true,
            rail: true,
            bankName: true,
            bankCode: true,
            accountNumber: true,
            accountHolder: true,
            isVerified: true,
            verifiedById: true,
            verifiedAt: true,
          },
        },
      },
    });
    if (!p) throw new NotFoundException('recipient_profile_not_found');

    const missing: string[] = [];
    if (p.status === 'REJECTED') missing.push('status_rejected');
    if (!p.isVerified) missing.push('isVerified');
    if (!p.isSafetyReviewed) missing.push('isSafetyReviewed');
    if (p.involvesChild && !p.isChildSafetyReviewed) missing.push('isChildSafetyReviewed');
    if (!p.hasConsent) missing.push('hasConsent');
    if (!p.isPrivacyReviewed) missing.push('isPrivacyReviewed');
    if (!p.isAdminApproved) missing.push('isAdminApproved');
    const dest = p.payoutDestination;
    if (!dest || dest.rail !== 'BANK' || !dest.accountNumber || !dest.accountHolder || !dest.bankName || !dest.bankCode) {
      missing.push('payoutDestination');
    } else if (!dest.isVerified) {
      missing.push('payoutDestinationVerified');
    }
    if (missing.length) {
      throw new BadRequestException({ code: 'recipient_profile_not_payable', missing });
    }
    return p.payoutDestination as NonNullable<typeof p.payoutDestination>;
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncProcessing(): Promise<void> {
    await this.cronLock.runExclusive('disbursement:sync-processing', 9 * 60_000, () =>
      this.syncProcessingBatches(),
    );
  }

  // Oldest first, in pages, so a pile of stuck transfers cannot starve newer ones.
  private async syncProcessingBatches(): Promise<void> {
    let cursor: string | undefined;
    for (let batch = 0; batch < SYNC_MAX_BATCHES; batch++) {
      const pending = await this.prisma.disbursement.findMany({
        where: { status: 'PROCESSING', method: 'CHAPA_TRANSFER' },
        select: { id: true, reference: true, executedAt: true, createdById: true },
        orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
        take: SYNC_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (pending.length === 0) return;
      await this.syncProcessingPage(pending);
      if (pending.length < SYNC_BATCH_SIZE) return;
      cursor = pending[pending.length - 1].id;
    }
  }

  private async syncProcessingPage(
    pending: { id: string; reference: string; executedAt: Date | null; createdById: string }[],
  ): Promise<void> {
    const timeoutMs = this.processingTimeoutMinutes * 60 * 1000;
    const now = Date.now();

    for (const d of pending) {
      try {
        const remote = await this.chapa.verifyTransfer(d.reference);
        if (remote.status === 'success') {
          const outcome = await this.prisma.$transaction((tx) => this.markPaidOut(tx, d.id));
          if (outcome.paid) {
            await this.events.log({
              actorId: null,
              action: AuditEventEnum.DISBURSEMENT_EXECUTED,
              entityType: 'Disbursement',
              entityId: d.id,
              metadata: { source: 'chapa_sync_cron', partyType: outcome.partyType },
            });
            await this.notifyPaidOut(
              d.id,
              outcome.partyType,
              outcome.missingPersonId,
              outcome.rewardClaimId,
            );
          }
          continue;
        }
        if (remote.status === 'failed') {
          await this.prisma.disbursement.updateMany({
            where: { id: d.id, status: 'PROCESSING' },
            data: { status: 'FAILED', failureReason: 'Transfer failed at Chapa' },
          });
          continue;
        }

        this.flagIfStale(d, timeoutMs, now, remote.status);
      } catch (err) {
        this.logger.warn(`Transfer sync failed for ${d.id}: ${String(err)}`);
        // A 4xx from Chapa (for example no such transfer) will not fix itself, so it is reported as such.
        this.flagIfStale(
          d,
          timeoutMs,
          now,
          this.isDefiniteRejection(err) ? 'transfer_not_found_or_rejected' : 'sync_error',
        );
      }
    }
  }

  private flagIfStale(
    d: { id: string; executedAt: Date | null; createdById: string },
    timeoutMs: number,
    now: number,
    remoteStatus: string,
  ): void {
    if (!d.executedAt) return;
    const ageMs = now - d.executedAt.getTime();
    if (ageMs < timeoutMs) return;

    // Alert on the first run after the timeout, then about every 6 hours, instead of every run.
    const sinceTimeout = ageMs - timeoutMs;
    if (sinceTimeout >= SYNC_INTERVAL_MS && sinceTimeout % STALE_ALERT_REPEAT_MS >= SYNC_INTERVAL_MS) {
      return;
    }

    this.logger.warn(
      `Disbursement ${d.id} has been PROCESSING for over ${this.processingTimeoutMinutes}m ` +
        `(remote status: ${remoteStatus})`,
    );
    void this.events.log({
      actorId: d.createdById,
      action: AuditEventEnum.SECURITY_ALERT,
      severity: ageMs >= STALE_CRITICAL_AFTER_MS ? AuditSeverity.CRITICAL : AuditSeverity.WARNING,
      entityType: 'Disbursement',
      entityId: d.id,
      metadata: {
        reason: 'disbursement_processing_timeout',
        ageMinutes: Math.floor(ageMs / 60000),
        thresholdMinutes: this.processingTimeoutMinutes,
        remoteStatus,
      },
    });
  }

  private async markPaidOut(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{
    paid: boolean;
    partyType?: string;
    missingPersonId?: string | null;
    rewardClaimId?: string | null;
  }> {
    const { count } = await tx.disbursement.updateMany({
      where: { id, status: { in: ['PROCESSING', 'APPROVED'] } },
      data: { status: 'PAID_OUT' },
    });
    if (count === 0) return { paid: false };

    const d = await tx.disbursement.findUniqueOrThrow({
      where: { id },
      include: { allocation: { include: { payment: true, disbursements: true } } },
    });

    const paidOutTotal = d.allocation.disbursements
      .filter((x) => x.id === d.id || x.status === 'PAID_OUT')
      .reduce((sum, x) => sum.add(x.amount), new Prisma.Decimal(0));
    const settlementStatus = paidOutTotal.gte(d.allocation.amount)
      ? 'PAID_OUT'
      : 'PARTIALLY_PAID_OUT';
    await tx.paymentAllocation.update({
      where: { id: d.allocationId },
      data: { settlementStatus },
    });

    if (d.allocation.partyType === 'REWARD_BENEFICIARY' && d.rewardClaimId) {
      await tx.rewardClaim.update({
        where: { id: d.rewardClaimId },
        data: { status: 'PAID_OUT' },
      });
    }

    return {
      paid: true,
      partyType: d.allocation.partyType,
      missingPersonId: d.allocation.payment.missingPersonId,
      rewardClaimId: d.rewardClaimId,
    };
  }

  private async notifyPaidOut(
    disbursementId: string,
    partyType?: string,
    missingPersonId?: string | null,
    rewardClaimId?: string | null,
  ) {
    if (partyType !== 'REWARD_BENEFICIARY' || !rewardClaimId) return;

    const claim = await this.prisma.rewardClaim.findUnique({
      where: { id: rewardClaimId },
      select: { informantUserId: true },
    });
    if (!claim?.informantUserId) return;

    this.events.notify<DisbursementPaidOutEvent>(NotificationEventEnum.DISBURSEMENT_PAID_OUT, {
      userId: claim.informantUserId,
      disbursementId,
      partyType,
    });
  }
}
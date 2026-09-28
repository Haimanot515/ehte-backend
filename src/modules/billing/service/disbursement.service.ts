// src/modules/billing/services/disbursement.service.ts
//
// Money leaving Ehte: to the approved recipient, the responsible organization,
// Pitron's platform share, or a reward finder.
//
// Rules:
//   - one admin creates, a DIFFERENT admin approves (four-eyes)
//   - bank details are supplied at execute time and are NOT stored
//   - reward payouts require reward.status = CLAIM_APPROVED
//   - every step is audited

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DisbursementMethod, Prisma, AuditOutcome, AuditSeverity } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChapaService } from '../../../services/chapa/chapa.service';
import { BillingEventsService } from './billing-events.service';
import { AuditEventEnum } from '../../../common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from '../../../common/enums/shared/notification-events.enum';
import { DisbursementPaidOutEvent } from '../../misc/events/notification.events';

export type ExecuteInput = {
  // CHAPA_TRANSFER
  accountName?: string;
  accountNumber?: string;
  bankCode?: string;
  // MANUAL_BANK
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
  ) {}

  /**
   * How long a disbursement may sit in PROCESSING before syncProcessing()
   * flags it instead of silently retrying forever. NOT a retry count — no
   * automatic retry exists yet (see DISBURSEMENT_MAX_RETRY_ATTEMPTS note
   * below, still unimplemented pending an idempotency check on
   * ChapaService.transfer()).
   */
  private get processingTimeoutMinutes(): number {
    return this.configService.get<number>('disbursement.processingTimeoutMinutes', 60);
  }

  /**
   * rewardClaimId is required for a REWARD_BENEFICIARY allocation once the case
   * has more than one approved informant (section 12): the allocation holds the
   * WHOLE informant pool, and each informant is paid out from it separately.
   * The disbursement amount is then the claim's own rewardAmount, not the
   * allocation's full amount, and several disbursements can exist against the
   * same allocation as long as their amounts never exceed it (section 25:
   * "a financial claim must not be successfully disbursed twice").
   */
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
    if (allocation.payment.status !== 'PAID')
      throw new BadRequestException('Payment is not settled');
    if (!['PENDING', 'PARTIALLY_PAID_OUT'].includes(allocation.settlementStatus)) {
      throw new BadRequestException('Allocation is not payable');
    }
    if (allocation.partyType === 'RECIPIENT') {
      if (allocation.disbursements.some((d) => !['FAILED', 'CANCELLED'].includes(d.status))) {
        throw new BadRequestException('A disbursement already exists for this allocation');
      }
      await this.loadPayableRecipient(allocation.payment.victimProfileId); // fail early
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
    const d = await this.prisma.disbursement.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Disbursement not found');
    if (d.createdById === adminId) {
      // FIX: the four-eyes violation itself — the exact thing this guard
      // exists to catch — threw with no audit row at all. Same gap
      // ReportService.assertAdminCanAccessReport() closes: write a DENIED
      // row before throwing, so an admin repeatedly trying to self-approve
      // leaves a trace instead of just bouncing off a 403.
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
      // FIX: same class of gap as the four-eyes check above — a lost
      // optimistic-concurrency race (someone else approved/executed first)
      // threw with no audit row, unlike the equivalent
      // report_transition_conflict guards elsewhere in this module.
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

  /** Banks and their Chapa codes, for the admin to pick from at payout time. */
  listBanks() {
    return this.chapa.getBanks();
  }

  async execute(adminId: string, id: string, input: ExecuteInput) {
    const d = await this.prisma.disbursement.findUnique({
      where: { id },
      include: { allocation: { include: { payment: true } } },
    });
    if (!d) throw new NotFoundException('Disbursement not found');

    // Resolve the destination BEFORE changing any state: a failed check must not burn the disbursement.
    let account: { accountName: string; accountNumber: string } | null = null;
    if (d.allocation.partyType === 'RECIPIENT') {
      // The destination is the bank account on the approved profile, never something typed in the request.
      const p = await this.loadPayableRecipient(d.allocation.payment.victimProfileId);
      account = {
        accountName: p.bankAccountName as string,
        accountNumber: p.bankAccountNumber as string,
      };
    } else if (input.accountName && input.accountNumber) {
      account = { accountName: input.accountName, accountNumber: input.accountNumber };
    }
    if (d.method === 'CHAPA_TRANSFER' && (!account || !input.bankCode)) {
      throw new BadRequestException('Account details and bankCode are required');
    }
    if (d.method === 'MANUAL_BANK' && !input.externalReference) {
      throw new BadRequestException('externalReference (bank slip) is required');
    }

    // Gate: only one execute can move APPROVED -> PROCESSING.
    const { count } = await this.prisma.disbursement.updateMany({
      where: { id, status: 'APPROVED' },
      data: { status: 'PROCESSING', executedById: adminId, executedAt: new Date() },
    });
    if (count === 0) throw new BadRequestException('Not approved or already executed');

    try {
      if (d.method === 'CHAPA_TRANSFER') {
        await this.chapa.transfer({
          accountName: (account as { accountName: string }).accountName,
          accountNumber: (account as { accountNumber: string }).accountNumber,
          bankCode: input.bankCode as string,
          amount: d.amount,
          reference: d.reference,
        });
        // Stays PROCESSING until syncProcessing() sees it succeed.
      } else {
        const outcome = await this.prisma.$transaction(async (tx) => {
          await tx.disbursement.update({
            where: { id },
            data: { externalReference: input.externalReference },
          });
          return this.markPaidOut(tx, id);
        });
        if (outcome.paid) {
          await this.notifyPaidOut(id, outcome.partyType, outcome.missingPersonId, outcome.rewardClaimId);
        }
      }
    } catch (err) {
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

    // Audit policy: bank details are never written to audit rows, not even the last digits.
    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.DISBURSEMENT_EXECUTED,
      entityType: 'Disbursement',
      entityId: id,
      metadata: {
        method: d.method,
        partyType: d.allocation.partyType,
        destination:
          d.allocation.partyType === 'RECIPIENT' ? 'profile_bank_details' : 'admin_supplied',
      },
    });
  }

  /**
   * A recipient payout is only allowed while the profile still passes every approval gate.
   * Editing a profile, changing bank details or revoking consent resets isAdminApproved, so
   * money collected earlier is held until an admin re-approves. Publication is NOT required
   * (a fundraiser can end and be unpublished before the money is paid out).
   */
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
        bankAccountName: true,
        bankAccountNumber: true,
        bankName: true,
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
    if (!p.bankAccountName || !p.bankAccountNumber || !p.bankName) missing.push('bankDetails');
    if (missing.length) {
      throw new BadRequestException({ code: 'recipient_profile_not_payable', missing });
    }
    return p;
  }

  // ── Cron: settle Chapa transfers that were accepted but not yet final ─────

  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncProcessing(): Promise<void> {
    const pending = await this.prisma.disbursement.findMany({
      where: { status: 'PROCESSING', method: 'CHAPA_TRANSFER' },
      select: { id: true, reference: true, executedAt: true, createdById: true },
      take: 50,
    });

    const timeoutMs = this.processingTimeoutMinutes * 60 * 1000;
    const now = Date.now();

    for (const d of pending) {
      try {
        const remote = await this.chapa.verifyTransfer(d.reference);
        if (remote.status === 'success') {
          const outcome = await this.prisma.$transaction((tx) => this.markPaidOut(tx, d.id));
          if (outcome.paid) {
            // FIX: this branch settles CHAPA_TRANSFER payouts from the cron,
            // parallel to the MANUAL_BANK branch of execute() above — but was
            // missing the events.log() call that branch has, so a payout
            // settled here fired a user notification with no audit trail
            // entry at all. actorId: null follows BillingEventsService.log's
            // existing system-actor convention (null -> ActorType.SYSTEM),
            // same as how webhook-triggered billing events are already
            // logged elsewhere in this module.
            await this.events.log({
              actorId: null,
              action: AuditEventEnum.DISBURSEMENT_EXECUTED,
              entityType: 'Disbursement',
              entityId: d.id,
              metadata: { source: 'chapa_sync_cron', partyType: outcome.partyType },
            });
            await this.notifyPaidOut(d.id, outcome.partyType, outcome.missingPersonId, outcome.rewardClaimId);
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

        // Still pending at Chapa (or an unrecognized status string). Not a
        // failure by itself, but flag it once it's been stuck too long so an
        // admin can look rather than it sitting PROCESSING indefinitely.
        this.flagIfStale(d, timeoutMs, now, remote.status);
      } catch (err) {
        this.logger.warn(`Transfer sync failed for ${d.id}: ${String(err)}`);
        // A failed *check* also counts toward staleness — an unreachable
        // Chapa endpoint shouldn't quietly hide a stuck disbursement.
        this.flagIfStale(d, timeoutMs, now, 'sync_error');
      }
    }
  }

  /**
   * Emits a SECURITY_ALERT audit event the first time a PROCESSING
   * disbursement crosses processingTimeoutMinutes. Does NOT change the
   * disbursement's status (no STALLED/TIMED_OUT state exists in the schema
   * yet) and does NOT retry or cancel anything — this is visibility only.
   * Runs every cron tick past the threshold, so downstream alerting should
   * dedupe on entityId if repeat notifications aren't wanted.
   */
  private flagIfStale(
    d: { id: string; executedAt: Date | null; createdById: string },
    timeoutMs: number,
    now: number,
    remoteStatus: string,
  ): void {
    if (!d.executedAt) return;
    const ageMs = now - d.executedAt.getTime();
    if (ageMs < timeoutMs) return;

    this.logger.warn(
      `Disbursement ${d.id} has been PROCESSING for over ${this.processingTimeoutMinutes}m ` +
        `(remote status: ${remoteStatus})`,
    );
    void this.events.log({
      actorId: d.createdById,
      action: AuditEventEnum.SECURITY_ALERT,
      // Same reasoning as PAYMENT_EXPIRED in payment.service.ts: severity
      // only, no `outcome` — nothing was attempted-and-rejected here, it's
      // a stuck-state flag for an admin to look at, not a failed operation.
      severity: AuditSeverity.WARNING,
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

  // ── Shared completion, always inside a transaction ────────────────────────
  //
  // Returns what the caller needs to fire the PAID_OUT notification AFTER
  // the transaction commits — never emit from inside a transaction that
  // might still roll back.
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

    // A reward payout may be one of several disbursements against the same
    // allocation (split among informants) — the allocation only moves to the
    // fully PAID_OUT settlement status once every committed disbursement has
    // settled; until then it stays PARTIALLY_PAID_OUT (section 25).
    const paidOutTotal = d.allocation.disbursements
      .filter((x) => x.id === d.id || x.status === 'PAID_OUT')
      .reduce((sum, x) => sum.add(x.amount), new Prisma.Decimal(0));
    const settlementStatus = paidOutTotal.gte(d.allocation.amount) ? 'PAID_OUT' : 'PARTIALLY_PAID_OUT';
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

  // Resolves who to notify for a PAID_OUT disbursement and fires it. Only
  // REWARD_BENEFICIARY is resolvable today, via the same
  // InformationSubmission.userId path used in RewardService.approveClaim —
  // same unconfirmed-field-name caveat applies. RECIPIENT payouts go to a
  // VictimProfile, which isn't loaded here; wire that once the profile's
  // owning userId is confirmed, rather than guessing a join.
  private async notifyPaidOut(
    disbursementId: string,
    partyType?: string,
    missingPersonId?: string | null,
    rewardClaimId?: string | null,
  ) {
    if (partyType !== 'REWARD_BENEFICIARY' || !rewardClaimId) return;

    // rewardClaimId now identifies exactly which informant this specific
    // disbursement paid (a case can have several, see reward-claim.prisma) —
    // no more missingPersonId-keyed lookup, which only ever worked for a
    // single-informant case.
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
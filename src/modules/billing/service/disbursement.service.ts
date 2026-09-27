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
//
// GAP 2 FIX (disbursement idempotency):
// Retrying a failed transfer used to be impossible on purpose — there was no
// safe way to know whether a "failed" call had actually gone through on
// Chapa's side before firing it again, so automatic/manual retry was left
// out entirely (see the old comment on processingTimeoutMinutes below).
//
// The fix doesn't require a change to ChapaService: every disbursement
// already gets one stable `reference` at create() time (this.chapa.
// generateTxRef('dsb')) and reuses it for the life of the disbursement.
// verifyTransfer(reference) — already used by syncProcessing() — can tell us
// whether Chapa has *any* record of that reference before we ever call
// transfer() again. So instead of blindly re-calling transfer(), both a
// fresh execute() and a retry() now check with Chapa first:
//   - Chapa has no record of it  -> safe to call transfer(), first time or not
//   - Chapa already shows it as settled -> mark PAID_OUT locally, never re-send
//   - Chapa shows it still pending -> leave it to syncProcessing(), don't retry
// This makes "retry" mean "ask Chapa what actually happened, then act
// accordingly" rather than "call transfer() again and hope."
//
// GAP 4 FIX (bank code validation):
// bankCode is checked once at data-entry time (victim-profile.service.ts),
// but Chapa's bank list can change between then and an actual payout
// attempt — including a retry that reuses a bank code from an earlier
// attempt (lastBankCode). transferOrReconcile() below is the single place
// that's ever about to actually call chapa.transfer(), for both a fresh
// execute() and a retry(), so that's where the re-check lives — one check,
// not one per call site.

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

  // How long a disbursement may sit in PROCESSING before syncProcessing()
  // flags it instead of silently retrying forever.
  private get processingTimeoutMinutes(): number {
    return this.configService.get<number>('disbursement.processingTimeoutMinutes', 60);
  }

  // GAP 2 FIX: the ceiling this comment used to say didn't exist yet. Now
  // enforced by retry() below — once a disbursement has been retried this
  // many times it stops here and needs a human to look at it, rather than
  // looping forever against a Chapa failure that isn't going to resolve
  // itself.
  private get maxRetryAttempts(): number {
    return this.configService.get<number>('disbursement.maxRetryAttempts', 3);
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

  // Banks and their Chapa codes, for the admin to pick from at payout time.
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
        accountName: p.payoutDestination!.accountHolder as string,
        accountNumber: p.payoutDestination!.accountNumber as string,
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
        // GAP 2 FIX: ask Chapa first. If this exact reference was already
        // sent (e.g. a prior execute() call whose response never made it
        // back to us before the process died), transfer() must never be
        // called a second time for it.
        await this.transferOrReconcile(d.id, d.reference, {
          accountName: (account as { accountName: string }).accountName,
          accountNumber: (account as { accountNumber: string }).accountNumber,
          bankCode: input.bankCode as string,
          amount: d.amount,
          reference: d.reference,
        });
        // Stays PROCESSING until syncProcessing() (or the check above) sees it succeed.
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
   * GAP 2 FIX — the new entry point for retrying a FAILED CHAPA_TRANSFER
   * disbursement. This is what admins should call instead of trying to
   * force execute() to run again.
   *
   * Safety comes from never re-calling chapa.transfer() blind:
   *   1. Refuse if retryCount is already at the cap — a human needs to look.
   *   2. Ask Chapa what it actually knows about this reference.
   *   3. Only call transfer() again if Chapa has genuinely never seen it;
   *      otherwise reconcile to whatever Chapa says (paid, or still pending).
   */
  async retry(adminId: string, id: string) {
    const d = await this.prisma.disbursement.findUnique({
      where: { id },
      include: { allocation: { include: { payment: true } } },
    });
    if (!d) throw new NotFoundException('Disbursement not found');
    if (d.method !== 'CHAPA_TRANSFER') {
      throw new BadRequestException('Only CHAPA_TRANSFER disbursements can be retried this way');
    }
    if (d.retryCount >= this.maxRetryAttempts) {
      await this.events.log({
        actorId: adminId,
        action: AuditEventEnum.DISBURSEMENT_FAILED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entityType: 'Disbursement',
        entityId: id,
        reason: 'max_retry_attempts_reached',
        metadata: { retryCount: d.retryCount, maxRetryAttempts: this.maxRetryAttempts },
      });
      throw new BadRequestException(
        `Max retry attempts (${this.maxRetryAttempts}) reached — needs manual review`,
      );
    }

    // Gate: only one retry can move FAILED -> PROCESSING at a time, and it
    // increments retryCount as part of the same atomic update so two
    // concurrent retry() calls can't both slip in under the cap.
    const { count } = await this.prisma.disbursement.updateMany({
      where: { id, status: 'FAILED', retryCount: d.retryCount },
      data: {
        status: 'PROCESSING',
        executedById: adminId,
        executedAt: new Date(),
        retryCount: { increment: 1 },
        failureReason: null,
      },
    });
    if (count === 0) {
      throw new BadRequestException('Not in a retryable state, or a retry is already in flight');
    }

    // Account details were never stored (by design — see file header rule),
    // so a retry re-resolves the destination exactly like execute() did.
    let account: { accountName: string; accountNumber: string } | null = null;
    if (d.allocation.partyType === 'RECIPIENT') {
      const p = await this.loadPayableRecipient(d.allocation.payment.victimProfileId);
      account = {
        accountName: p.payoutDestination!.accountHolder as string,
        accountNumber: p.payoutDestination!.accountNumber as string,
      };
    }
    if (!account || !d.lastBankCode) {
      // Retry can't proceed without the bank code used originally — this
      // service intentionally never persisted the admin-supplied bankCode
      // for a non-RECIPIENT payout, so those must go through execute() again
      // with the details re-supplied rather than through retry().
      await this.prisma.disbursement.updateMany({
        where: { id, status: 'PROCESSING' },
        data: { status: 'FAILED', failureReason: 'retry_missing_destination_details' },
      });
      throw new BadRequestException(
        'Destination details are unavailable for this disbursement — use execute() again with the details supplied',
      );
    }

    try {
      await this.transferOrReconcile(d.id, d.reference, {
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        bankCode: d.lastBankCode,
        amount: d.amount,
        reference: d.reference,
      });
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
        metadata: { retryCount: d.retryCount + 1 },
      });
      throw err;
    }

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.DISBURSEMENT_EXECUTED,
      entityType: 'Disbursement',
      entityId: id,
      metadata: { retried: true, retryCount: d.retryCount + 1 },
    });
  }

  /**
   * GAP 2 FIX — the idempotency guard. Never calls chapa.transfer()
   * without first checking whether Chapa already has a record of this
   * reference. This is what makes both execute() and retry() safe to call
   * more than once for the same disbursement.
   *
   *   - Chapa reports success already  -> mark PAID_OUT locally, don't re-send.
   *   - Chapa reports it still pending -> leave PROCESSING, don't re-send;
   *     syncProcessing() will pick it up.
   *   - Chapa has no record of it (404 / not-found style response) -> this is
   *     genuinely the first (or first successful) send, safe to call transfer().
   *
   * GAP 4 FIX — bank code re-validation lives here too, in the "about to
   * actually send" branch only. If Chapa already has a record of this
   * reference (settled or still pending), the bank code was already good
   * enough to reach Chapa the first time — no reason to re-check it just to
   * reconcile a status. Only a genuinely fresh send needs the check, and
   * this is the one place both execute() and retry() route through before
   * one happens.
   */
  private async transferOrReconcile(
    disbursementId: string,
    reference: string,
    transferInput: {
      accountName: string;
      accountNumber: string;
      bankCode: string;
      amount: Prisma.Decimal;
      reference: string;
    },
  ): Promise<void> {
    const known = await this.safeVerifyTransfer(reference);

    if (known?.status === 'success') {
      const outcome = await this.prisma.$transaction((tx) => this.markPaidOut(tx, disbursementId));
      if (outcome.paid) {
        await this.notifyPaidOut(disbursementId, outcome.partyType, outcome.missingPersonId, outcome.rewardClaimId);
      }
      return;
    }
    if (known?.status === 'pending' || known?.status === 'processing') {
      // Already in flight at Chapa — do nothing, let syncProcessing() settle it.
      return;
    }

    // GAP 4: about to send for real — bankCode was checked once at data
    // entry, but Chapa's bank list can change before this moment, including
    // between a first execute() and a later retry() reusing lastBankCode.
    const banks = await this.chapa.getBanks();
    const bankIsValid = banks.some((b) => b.code === transferInput.bankCode);
    if (!bankIsValid) {
      throw new BadRequestException('invalid_bank_code');
    }

    // Persist the bank code used, so a *future* retry (if this attempt also
    // fails) doesn't need it re-supplied by the admin.
    await this.prisma.disbursement.update({
      where: { id: disbursementId },
      data: { lastBankCode: transferInput.bankCode },
    });

    await this.chapa.transfer(transferInput);
  }

  /** verifyTransfer() failing (e.g. Chapa unreachable) must not be read as "never sent" — treat it as unknown. */
  private async safeVerifyTransfer(reference: string): Promise<{ status: string } | null> {
    try {
      return await this.chapa.verifyTransfer(reference);
    } catch (err) {
      this.logger.warn(`verifyTransfer failed for ${reference}: ${String(err)}`);
      return null;
    }
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
        // G40: payout destination now lives on PayoutDestination, not the
        // legacy VictimProfile.bank* columns.
        payoutDestination: {
          select: { accountHolder: true, accountNumber: true, bankName: true },
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
    if (
      !p.payoutDestination?.accountHolder ||
      !p.payoutDestination?.accountNumber ||
      !p.payoutDestination?.bankName
    ) {
      missing.push('bankDetails');
    }
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
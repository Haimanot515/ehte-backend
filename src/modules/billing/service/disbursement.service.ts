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
import { Cron, CronExpression } from '@nestjs/schedule';
import { DisbursementMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChapaService } from '../../../services/chapa/chapa.service';
import { BillingEventsService } from './billing-events.service';

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
  ) {}

  async create(adminId: string, allocationId: string, method: DisbursementMethod) {
    const allocation = await this.prisma.paymentAllocation.findUnique({
      where: { id: allocationId },
      include: { payment: true, disbursements: true },
    });
    if (!allocation) throw new NotFoundException('Allocation not found');
    if (allocation.payment.status !== 'PAID') throw new BadRequestException('Payment is not settled');
    if (allocation.settlementStatus !== 'PENDING') throw new BadRequestException('Allocation is not pending');
    if (allocation.disbursements.some((d) => !['FAILED', 'CANCELLED'].includes(d.status))) {
      throw new BadRequestException('A disbursement already exists for this allocation');
    }
    if (allocation.partyType === 'RECIPIENT') {
      await this.loadPayableRecipient(allocation.payment.victimProfileId); // fail early
    }
    if (allocation.partyType === 'REWARD_BENEFICIARY' && allocation.payment.missingPersonId) {
      const claim = await this.prisma.rewardClaim.findUnique({
        where: { missingPersonId: allocation.payment.missingPersonId },
      });
      if (claim?.status !== 'APPROVED') {
        throw new BadRequestException('Reward claim has not been approved');
      }
    }

    const d = await this.prisma.disbursement.create({
      data: {
        allocationId,
        method,
        amount: allocation.amount,
        reference: this.chapa.generateTxRef('dsb'),
        createdById: adminId,
      },
    });
    await this.events.log({ actorId: adminId, action: 'DISBURSEMENT_CREATED', entityType: 'Disbursement', entityId: d.id });
    return d;
  }

  async approve(adminId: string, id: string) {
    const d = await this.prisma.disbursement.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Disbursement not found');
    if (d.createdById === adminId) throw new ForbiddenException('A different admin must approve');

    const { count } = await this.prisma.disbursement.updateMany({
      where: { id, status: 'PENDING_APPROVAL' },
      data: { status: 'APPROVED', approvedById: adminId },
    });
    if (count === 0) throw new BadRequestException('Not awaiting approval');
    await this.events.log({ actorId: adminId, action: 'DISBURSEMENT_APPROVED', entityType: 'Disbursement', entityId: id });
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
      account = { accountName: p.bankAccountName as string, accountNumber: p.bankAccountNumber as string };
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
        await this.prisma.$transaction(async (tx) => {
          await tx.disbursement.update({ where: { id }, data: { externalReference: input.externalReference } });
          await this.markPaidOut(tx, id);
        });
      }
    } catch (err) {
      await this.prisma.disbursement.update({
        where: { id },
        data: { status: 'FAILED', failureReason: String((err as Error).message).slice(0, 200) },
      });
      await this.events.log({ actorId: adminId, action: 'DISBURSEMENT_FAILED', entityType: 'Disbursement', entityId: id });
      throw err;
    }

    // Audit policy: bank details are never written to audit rows, not even the last digits.
    await this.events.log({
      actorId: adminId,
      action: 'DISBURSEMENT_EXECUTED',
      entityType: 'Disbursement',
      entityId: id,
      metadata: {
        method: d.method,
        partyType: d.allocation.partyType,
        destination: d.allocation.partyType === 'RECIPIENT' ? 'profile_bank_details' : 'admin_supplied',
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
      select: { id: true, reference: true },
      take: 50,
    });
    for (const d of pending) {
      try {
        const remote = await this.chapa.verifyTransfer(d.reference);
        if (remote.status === 'success') {
          await this.prisma.$transaction((tx) => this.markPaidOut(tx, d.id));
        } else if (remote.status === 'failed') {
          await this.prisma.disbursement.updateMany({
            where: { id: d.id, status: 'PROCESSING' },
            data: { status: 'FAILED', failureReason: 'Transfer failed at Chapa' },
          });
        }
      } catch (err) {
        this.logger.warn(`Transfer sync failed for ${d.id}: ${String(err)}`);
      }
    }
  }

  // ── Shared completion, always inside a transaction ────────────────────────

  private async markPaidOut(tx: Prisma.TransactionClient, id: string) {
    const { count } = await tx.disbursement.updateMany({
      where: { id, status: { in: ['PROCESSING', 'APPROVED'] } },
      data: { status: 'PAID_OUT' },
    });
    if (count === 0) return;

    const d = await tx.disbursement.findUniqueOrThrow({
      where: { id },
      include: { allocation: { include: { payment: true } } },
    });
    await tx.paymentAllocation.update({
      where: { id: d.allocationId },
      data: { settlementStatus: 'PAID_OUT' },
    });
    if (d.allocation.partyType === 'REWARD_BENEFICIARY' && d.allocation.payment.missingPersonId) {
      await tx.rewardClaim.updateMany({
        where: { missingPersonId: d.allocation.payment.missingPersonId, status: 'APPROVED' },
        data: { status: 'PAID_OUT' },
      });
    }
  }
}

// src/modules/billing/service/reward.service.ts
//
// Rebuilt against the real schema: MissingPerson already holds the reward OFFER
// (rewardOffered, rewardAmount: Int — whole ETB, no cents, rewardApproved,
// rewardDetails). There is no separate reward-escrow model. RewardClaim (new,
// see reward-claim.prisma) is the only new table: it tracks which confidential
// InformationSubmission an admin verified as the valid claim.
//
// ASSUMPTION TO VERIFY: MissingPersonService likely already owns
// rewardOffered/rewardApproved changes (its own service file wasn't shown to
// me). If so, move approveOffer()/rejectOffer() there and have this service
// only own RewardClaim + payment funding. For now this service writes those
// two fields directly via Prisma so the flow is complete; reconcile with
// MissingPersonService before merging so two places don't write the same columns.

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../../prisma/prisma.service';
import { BILLING_PAYMENT_PAID, BillingEventsService, BillingPaymentPaid } from './billing-events.service';

@Injectable()
export class RewardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: BillingEventsService,
  ) {}

  // ── Admin: approve/reject the reward OFFER (may belong in MissingPersonService — see note above) ──

  async approveOffer(adminId: string, missingPersonId: string) {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: { rewardOffered: true, rewardApproved: true },
    });
    if (!mp) throw new NotFoundException('missing_person_not_found');
    if (!mp.rewardOffered) throw new BadRequestException('no_reward_offered_for_this_case');
    if (mp.rewardApproved) throw new BadRequestException('reward_already_approved');

    await this.prisma.missingPerson.update({
      where: { id: missingPersonId },
      data: { rewardApproved: true },
    });
    await this.events.log({
      actorId: adminId,
      action: 'REWARD_APPROVED',
      entityType: 'MissingPerson',
      entityId: missingPersonId,
    });
  }

  async rejectOffer(adminId: string, missingPersonId: string, reason: string) {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: { rewardOffered: true, rewardApproved: true },
    });
    if (!mp) throw new NotFoundException('missing_person_not_found');
    if (!mp.rewardOffered || mp.rewardApproved) {
      throw new BadRequestException('reward_not_awaiting_approval');
    }

    await this.prisma.missingPerson.update({
      where: { id: missingPersonId },
      data: { rewardOffered: false, rewardDetails: reason },
    });
    await this.events.log({
      actorId: adminId,
      action: 'REWARD_REJECTED',
      entityType: 'MissingPerson',
      entityId: missingPersonId,
      reason,
    });
  }

  // ── Admin: verify which confidential submission earns the reward ────────

  async approveClaim(adminId: string, missingPersonId: string, informationSubmissionId: string) {
    const submission = await this.prisma.informationSubmission.findFirst({
      where: { id: informationSubmissionId, missingPersonId },
      select: { id: true },
    });
    if (!submission) throw new BadRequestException('submission_does_not_belong_to_this_case');

    const claim = await this.prisma.rewardClaim.findUnique({ where: { missingPersonId } });
    if (!claim || claim.status !== 'PENDING') {
      throw new BadRequestException('reward_not_funded_or_already_decided');
    }

    await this.prisma.rewardClaim.update({
      where: { missingPersonId },
      data: {
        status: 'APPROVED',
        informationSubmissionId,
        approvedById: adminId,
        approvedAt: new Date(),
      },
    });
    await this.events.log({
      actorId: adminId,
      action: 'REWARD_CLAIM_APPROVED',
      entityType: 'RewardClaim',
      entityId: claim.id,
      metadata: { missingPersonId, informationSubmissionId },
    });
  }

  /** Case closed with no valid claim, or the offer is withdrawn after funding. */
  async closeWithoutPayout(adminId: string, missingPersonId: string, reason: string) {
    const claim = await this.prisma.rewardClaim.findUnique({ where: { missingPersonId } });
    if (!claim) throw new NotFoundException('reward_claim_not_found');
    if (claim.status !== 'PENDING') throw new BadRequestException('reward_already_decided');

    await this.prisma.rewardClaim.update({
      where: { missingPersonId },
      data: { status: 'REFUND_DUE', closedReason: reason },
    });
    await this.events.log({
      actorId: adminId,
      action: 'REWARD_CLOSED',
      entityType: 'RewardClaim',
      entityId: claim.id,
      reason,
    });
  }

  /**
   * Reacts to a settled reward-funding payment. PaymentService.reconcile() also upserts
   * this row in the same DB transaction as the PAID transition (belt-and-braces); this
   * listener is the audited path and fires on both the live path and the repair cron.
   */
  @OnEvent(BILLING_PAYMENT_PAID)
  async onPaymentPaid(e: BillingPaymentPaid): Promise<void> {
    if (!e.missingPersonId) return;
    const existed = await this.prisma.rewardClaim.findUnique({
      where: { missingPersonId: e.missingPersonId },
      select: { id: true },
    });
    await this.prisma.rewardClaim.upsert({
      where: { missingPersonId: e.missingPersonId },
      create: { missingPersonId: e.missingPersonId },
      update: {},
    });
    if (!existed) {
      await this.events.log({
        actorId: null, // system: triggered by a settled Chapa payment, not an admin action
        action: 'REWARD_FUNDED',
        entityType: 'MissingPerson',
        entityId: e.missingPersonId,
        metadata: { paymentId: e.paymentId },
      });
    }
  }
}
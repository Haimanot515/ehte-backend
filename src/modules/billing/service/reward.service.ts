// src/modules/billing/service/reward.service.ts
//
// Owns the reward OFFER (rewardOffered/rewardApproved/rewardDetails, still on
// MissingPerson), the funding method and funded/reserved balance (section 7 /
// 17-19), the per-informant RewardClaim lifecycle (section 11 / 16 / 20), and
// reward splitting among approved informants (section 12).
//
// PRD alignment (Sep 2026): RewardClaim moved from one row per case to many
// rows per case (see reward-claim.prisma). A claim is no longer auto-created
// when a reward payment settles — it is created explicitly once an admin
// escalates a specific InformationSubmission into a claim (createClaimFromSubmission),
// matching section 10-11: "each submission is a separate claim/information record".
// MissingPerson.fundedAmount/fundingStatus track the reward pool's funding state
// directly; onPaymentPaid() updates those instead of upserting a RewardClaim row.
//
// G6 RESOLVED: rewardOffered/rewardApproved/rewardAmount/rewardDetails now
// have exactly one write path — reviewOffer() (with approveOffer()/
// rejectOffer() as thin wrappers over it/the same funded-lock) below.
// MissingPersonService no longer has an updateReward() method; the
// admin/:id/reward controller route calls RewardService.reviewOffer()
// directly. See reviewOffer()'s own comment for the full history.
// ASSUMPTION TO VERIFY (confirmed against the real audit-events.enum.ts, Sep 2026):
// REWARD_APPROVED / REWARD_REJECTED / REWARD_FUNDED / REWARD_CLOSED already exist —
// REWARD_CLOSED is reused for closeWithoutPayout() rather than adding a duplicate.
// Six members genuinely don't exist yet and need adding to the "BILLING — REWARDS"
// section: REWARD_FUNDING_METHOD_SET, REWARD_WEIGHTS_SET, REWARD_CLAIM_CREATED,
// REWARD_CLAIM_SCORED, REWARD_CLAIM_DECIDED, REWARD_SPLIT_DECIDED.
// ASSUMPTION TO VERIFY: RewardClaimApprovedEvent (notification.events.ts) and
// the PermissionsEnum members used in disbursement.controller.ts
// (REWARDS_VERIFY_CLAIM alongside the existing REWARDS_APPROVE) weren't in
// the files provided for this pass — carried over from the pre-existing
// single-claim approveClaim() flow's naming, verify they still exist / add
// them the same way.

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditOutcome, AuditSeverity, Prisma, RewardClaimStatus, RewardFundingStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CacheService } from '../../../services/redis/cache.service';
import {
  BILLING_PAYMENT_PAID,
  BillingEventsService,
  BillingPaymentPaid,
} from './billing-events.service';
import { AuditEventEnum } from '../../../common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from '../../../common/enums/shared/notification-events.enum';
import { RewardClaimApprovedEvent } from '../../misc/events/notification.events';
import {
  ClaimDecision,
  DecideClaimDto,
  ScoreClaimDto,
  SetEvaluationWeightsDto,
  SetFundingMethodDto,
  SplitRewardDto,
} from '../dto/reward-claim.dto';
import { EVALUATION_WEIGHTS_TOTAL } from '../billing.constants';

const OPEN_CLAIM_STATUSES: RewardClaimStatus[] = ['SUBMITTED', 'UNDER_REVIEW'];
const DECIDABLE_STATUSES: RewardClaimStatus[] = ['SUBMITTED', 'UNDER_REVIEW'];

@Injectable()
export class RewardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: BillingEventsService,
    private readonly cache: CacheService,
  ) {}

  // G6: shared by every write path onto rewardApproved/rewardAmount below.
  // Once a PAID payment exists against this case, the terms the payer
  // actually funded can never move again — no legitimate reason to touch
  // any of these once funded, so it's a hard block, not a partial one.
  private async isRewardFunded(missingPersonId: string): Promise<boolean> {
    const count = await this.prisma.payment.count({
      where: { missingPersonId, type: 'MISSING_PERSON_REWARD', status: 'PAID' },
    });
    return count > 0;
  }

  // ── Admin: approve/revise/reject the reward OFFER ──────────────────────────
  //
  // G6 RESOLVED: rewardApproved/rewardAmount/rewardDetails used to have two
  // independent write paths — this method (approveOffer, REWARDS_APPROVE
  // alone, no funded-lock) and MissingPersonService.updateReward()
  // (admin/:id/reward, MISSING_PERSON_REVIEW + REWARDS_APPROVE, funded-lock
  // present). A reviewer with only REWARDS_APPROVE could approve/revise
  // through the billing route and bypass both the dual-permission
  // requirement and the funded-lock enforced on the other route. reviewOffer()
  // below is now the only method that writes these three fields; approveOffer()
  // is kept as a thin, backward-compatible wrapper over it so the existing
  // admin/billing/.../reward/approve route keeps working, and updateReward()
  // has been removed from MissingPersonService entirely — the
  // admin/:id/reward controller route calls reviewOffer() directly.
  async reviewOffer(
    adminId: string,
    missingPersonId: string,
    rewardApproved: boolean,
    rewardAmount?: number,
    rewardDetails?: string,
  ) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id: missingPersonId } });
    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (await this.isRewardFunded(missingPersonId)) {
      await this.events.log({
        actorId: adminId,
        action: AuditEventEnum.REWARD_APPROVED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entityType: 'MissingPerson',
        entityId: missingPersonId,
        reason: 'reward_terms_locked_once_funded',
        metadata: { operation: 'reward_review_blocked' },
      });
      throw new ConflictException('reward_terms_locked_once_funded');
    }

    if (rewardApproved && !existing.rewardOffered) {
      await this.events.log({
        actorId: adminId,
        action: AuditEventEnum.REWARD_APPROVED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entityType: 'MissingPerson',
        entityId: missingPersonId,
        reason: 'cannot_approve_reward_that_was_not_offered',
        metadata: { operation: 'reward_review' },
      });
      throw new BadRequestException('cannot_approve_reward_that_was_not_offered');
    }

    const finalAmount = rewardAmount !== undefined ? rewardAmount : existing.rewardAmount;
    const finalDetails = rewardDetails !== undefined ? rewardDetails : existing.rewardDetails;

    if (rewardApproved && (finalAmount === undefined || finalAmount === null)) {
      await this.events.log({
        actorId: adminId,
        action: AuditEventEnum.REWARD_APPROVED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entityType: 'MissingPerson',
        entityId: missingPersonId,
        reason: 'reward_amount_required_when_approved',
        metadata: { operation: 'reward_review' },
      });
      throw new BadRequestException('reward_amount_required_when_approved');
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id: missingPersonId },
      data: {
        rewardApproved,
        rewardAmount: finalAmount,
        rewardDetails: finalDetails,
      },
    });

    // rewardApproved/rewardAmount/rewardDetails feed maskUnapprovedReward() on
    // the public detail/list views, so any change here can change what's
    // shown publicly.
    await this.cache.invalidateMissingPersonEverywhere(missingPersonId);

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.REWARD_APPROVED,
      entityType: 'MissingPerson',
      entityId: missingPersonId,
      metadata: {
        operation: 'reward_review',
        previousRewardApproved: existing.rewardApproved,
        previousRewardAmount: existing.rewardAmount,
        previousRewardDetails: existing.rewardDetails,
        rewardApproved: updated.rewardApproved,
        rewardAmount: updated.rewardAmount,
        rewardDetails: updated.rewardDetails,
        amountOverriddenByAdmin:
          rewardAmount !== undefined && rewardAmount !== existing.rewardAmount,
        detailsOverriddenByAdmin:
          rewardDetails !== undefined && rewardDetails !== existing.rewardDetails,
      },
    });

    this.events.notify<{ userId: string; missingPersonId: string; status: string }>(
      NotificationEventEnum.MISSING_PERSON_UPDATED,
      {
        userId: existing.userId ?? '',
        missingPersonId: updated.id,
        status: existing.status,
      },
    );

    return updated;
  }

  // Thin wrapper over reviewOffer() so the existing no-body
  // admin/billing/missing-persons/:id/reward/approve route keeps working —
  // now with the same funded-lock and validation reviewOffer() enforces
  // everywhere else, instead of the unguarded direct write this used to do.
  async approveOffer(adminId: string, missingPersonId: string) {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: { rewardApproved: true },
    });
    if (!mp) throw new NotFoundException('missing_person_not_found');
    if (mp.rewardApproved) throw new BadRequestException('reward_already_approved');

    return this.reviewOffer(adminId, missingPersonId, true);
  }

  // G6: withdrawing the offer writes rewardOffered, not rewardApproved —
  // a different field than reviewOffer() above governs — but it is the same
  // "reward terms locked once funded" money the funded-lock protects, so it
  // gets the identical guard rather than a second, slightly-different rule.
  async rejectOffer(adminId: string, missingPersonId: string, reason: string) {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: { rewardOffered: true, rewardApproved: true },
    });
    if (!mp) throw new NotFoundException('missing_person_not_found');
    if (!mp.rewardOffered || mp.rewardApproved) {
      throw new BadRequestException('reward_not_awaiting_approval');
    }
    if (await this.isRewardFunded(missingPersonId)) {
      await this.events.log({
        actorId: adminId,
        action: AuditEventEnum.REWARD_REJECTED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entityType: 'MissingPerson',
        entityId: missingPersonId,
        reason: 'reward_terms_locked_once_funded',
        metadata: { operation: 'reward_reject_blocked' },
      });
      throw new ConflictException('reward_terms_locked_once_funded');
    }

    await this.prisma.missingPerson.update({
      where: { id: missingPersonId },
      data: { rewardOffered: false, rewardDetails: reason },
    });
    await this.cache.invalidateMissingPersonEverywhere(missingPersonId);
    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.REWARD_REJECTED,
      entityType: 'MissingPerson',
      entityId: missingPersonId,
      reason,
    });
  }

  // ── Sponsor/admin: funding method (section 7 / 17-19) ────────────────────

  /**
   * Must be set before the reward can be funded. Changing it once funding has
   * started is refused — switching a PREPAID case to PROMISE_TO_PAY (or back)
   * after money has moved would strand the reserved/funded bookkeeping.
   */
  async setFundingMethod(actorId: string, missingPersonId: string, dto: SetFundingMethodDto) {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: { rewardOffered: true, fundingStatus: true },
    });
    if (!mp) throw new NotFoundException('missing_person_not_found');
    if (!mp.rewardOffered) throw new BadRequestException('no_reward_offered_for_this_case');
    if (mp.fundingStatus !== 'UNFUNDED') {
      throw new BadRequestException('funding_method_locked_after_funding_starts');
    }

    await this.prisma.missingPerson.update({
      where: { id: missingPersonId },
      data: { fundingMethod: dto.fundingMethod },
    });
    await this.events.log({
      actorId,
      action: AuditEventEnum.REWARD_FUNDING_METHOD_SET,
      entityType: 'MissingPerson',
      entityId: missingPersonId,
      metadata: { fundingMethod: dto.fundingMethod },
    });
  }

  /** Section 11: admin-selected weights for this case, must sum to exactly 100. */
  async setEvaluationWeights(adminId: string, missingPersonId: string, dto: SetEvaluationWeightsDto) {
    const sum = dto.timeWeight + dto.evidenceWeight + dto.credibilityWeight;
    if (sum !== EVALUATION_WEIGHTS_TOTAL) {
      throw new BadRequestException(`Weights must total ${EVALUATION_WEIGHTS_TOTAL}`);
    }
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: { id: true },
    });
    if (!mp) throw new NotFoundException('missing_person_not_found');

    await this.prisma.missingPerson.update({
      where: { id: missingPersonId },
      data: {
        timeWeight: dto.timeWeight,
        evidenceWeight: dto.evidenceWeight,
        credibilityWeight: dto.credibilityWeight,
      },
    });
    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.REWARD_WEIGHTS_SET,
      entityType: 'MissingPerson',
      entityId: missingPersonId,
      metadata: { timeWeight: dto.timeWeight, evidenceWeight: dto.evidenceWeight, credibilityWeight: dto.credibilityWeight },
    });
  }

  // ── Admin: per-informant claim lifecycle (section 10-11 / 16 / 20) ───────

  /** Escalates one confidential submission into a claim the admin can score and decide. */
  async createClaimFromSubmission(adminId: string, missingPersonId: string, informationSubmissionId: string) {
    const submission = await this.prisma.informationSubmission.findFirst({
      where: { id: informationSubmissionId, missingPersonId },
      select: { id: true, userId: true },
    });
    if (!submission) throw new BadRequestException('submission_does_not_belong_to_this_case');

    const existing = await this.prisma.rewardClaim.findUnique({
      where: { missingPersonId_informationSubmissionId: { missingPersonId, informationSubmissionId } },
    });
    if (existing) throw new ConflictException('claim_already_exists_for_this_submission');

    const claim = await this.prisma.rewardClaim.create({
      data: {
        missingPersonId,
        informationSubmissionId,
        informantUserId: submission.userId ?? null,
        status: 'SUBMITTED',
      },
    });
    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.REWARD_CLAIM_CREATED,
      entityType: 'RewardClaim',
      entityId: claim.id,
      metadata: { missingPersonId, informationSubmissionId },
    });
    return claim;
  }

  /**
   * Scores a claim against the case's configured weights (section 11 / 16).
   * Weights are copied onto the claim at scoring time so a later change to the
   * case's weights never silently reweights an already-scored claim.
   */
  async scoreClaim(adminId: string, claimId: string, dto: ScoreClaimDto) {
    const claim = await this.prisma.rewardClaim.findUnique({ where: { id: claimId } });
    if (!claim) throw new NotFoundException('reward_claim_not_found');
    if (!DECIDABLE_STATUSES.includes(claim.status)) {
      throw new BadRequestException('claim_already_decided');
    }
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: claim.missingPersonId },
      select: { timeWeight: true, evidenceWeight: true, credibilityWeight: true },
    });
    if (!mp?.timeWeight || !mp.evidenceWeight || !mp.credibilityWeight) {
      throw new BadRequestException('evaluation_weights_not_configured_for_this_case');
    }

    const weightedScore =
      (dto.timeScore * mp.timeWeight +
        dto.evidenceScore * mp.evidenceWeight +
        dto.credibilityScore * mp.credibilityWeight) /
      100;

    await this.prisma.rewardClaim.update({
      where: { id: claimId },
      data: {
        status: 'UNDER_REVIEW',
        timeScore: dto.timeScore,
        evidenceScore: dto.evidenceScore,
        credibilityScore: dto.credibilityScore,
        timeWeight: mp.timeWeight,
        evidenceWeight: mp.evidenceWeight,
        credibilityWeight: mp.credibilityWeight,
        weightedScore: new Prisma.Decimal(weightedScore.toFixed(2)),
      },
    });
    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.REWARD_CLAIM_SCORED,
      entityType: 'RewardClaim',
      entityId: claimId,
      metadata: { ...dto, weightedScore },
    });
  }

  /** Section 20: VALID / INVALID / DUPLICATE / ALREADY_KNOWN / INELIGIBLE, always with a reason. */
  async decideClaim(adminId: string, claimId: string, dto: DecideClaimDto) {
    const claim = await this.prisma.rewardClaim.findUnique({ where: { id: claimId } });
    if (!claim) throw new NotFoundException('reward_claim_not_found');
    if (!DECIDABLE_STATUSES.includes(claim.status)) {
      throw new BadRequestException('claim_already_decided');
    }
    if (dto.decision === ClaimDecision.DUPLICATE && !dto.duplicateOfClaimId) {
      throw new BadRequestException('duplicateOfClaimId is required for a DUPLICATE decision');
    }

    await this.prisma.rewardClaim.update({
      where: { id: claimId },
      data: {
        status: dto.decision as unknown as RewardClaimStatus,
        decisionReason: dto.reason,
        duplicateOfClaimId: dto.duplicateOfClaimId ?? null,
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
    });
    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.REWARD_CLAIM_DECIDED,
      entityType: 'RewardClaim',
      entityId: claimId,
      reason: dto.reason,
      metadata: { decision: dto.decision, duplicateOfClaimId: dto.duplicateOfClaimId },
    });

    if (dto.decision === ClaimDecision.VALID && claim.informantUserId) {
      this.events.notify<RewardClaimApprovedEvent>(NotificationEventEnum.REWARD_CLAIM_APPROVED, {
        userId: claim.informantUserId,
        rewardClaimId: claim.id,
        missingPersonId: claim.missingPersonId,
      });
    }
  }

  /**
   * Section 12 / 13-14: splits the funded reward pool across every VALID claim
   * named in dto.splits. Percentages are of the informant pool (REWARD_BENEFICIARY
   * allocation lines), not of the gross reward, and must total exactly 100 —
   * matching section 12's "Informant percentages must total 100%". Every named
   * claim must be VALID and not already split; any VALID claim on the case that
   * is NOT named in dto.splits gets 0% (the admin decided it, even if valid,
   * does not share the pool) and is moved to REJECTED with that reason recorded.
   */
  async splitReward(adminId: string, missingPersonId: string, dto: SplitRewardDto) {
    const totalPct = dto.splits.reduce((sum, s) => sum + s.percentage, 0);
    if (totalPct !== 100) throw new BadRequestException('Informant percentages must total 100%');

    const claimIds = dto.splits.map((s) => s.claimId);
    if (new Set(claimIds).size !== claimIds.length) {
      throw new BadRequestException('Duplicate claimId in splits');
    }

    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: { agreementId: true, agreementVersion: true },
    });
    if (!mp) throw new NotFoundException('missing_person_not_found');

    const pool = await this.prisma.paymentAllocation.aggregate({
      where: {
        partyType: 'REWARD_BENEFICIARY',
        payment: { missingPersonId, type: 'MISSING_PERSON_REWARD', status: 'PAID' },
      },
      _sum: { amount: true },
    });
    const poolAmount = new Prisma.Decimal(pool._sum.amount ?? 0);
    if (poolAmount.lte(0)) throw new BadRequestException('Reward is not funded yet');

    const claims = await this.prisma.rewardClaim.findMany({
      where: { id: { in: claimIds }, missingPersonId },
    });
    if (claims.length !== claimIds.length) {
      throw new BadRequestException('One or more claims do not belong to this case');
    }
    if (claims.some((c) => c.status !== 'VALID')) {
      throw new BadRequestException('Every named claim must be VALID before it can be split');
    }

    await this.prisma.$transaction(async (tx) => {
      for (const split of dto.splits) {
        const amount = poolAmount.mul(split.percentage).div(100);
        await tx.rewardClaim.update({
          where: { id: split.claimId },
          data: {
            status: 'APPROVED_FOR_REWARD',
            rewardPercentage: new Prisma.Decimal(split.percentage),
            rewardAmount: amount,
            agreementId: mp.agreementId,
            agreementVersion: mp.agreementVersion,
            approvedById: adminId,
            approvedAt: new Date(),
          },
        });
      }
      // Any other VALID claim on this case not named in the split forfeits its
      // share — the admin's split is the complete, final decision for the pool.
      await tx.rewardClaim.updateMany({
        where: { missingPersonId, status: 'VALID', id: { notIn: claimIds } },
        data: { status: 'REJECTED', decisionReason: 'not_included_in_reward_split' },
      });
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.REWARD_SPLIT_DECIDED,
      entityType: 'MissingPerson',
      entityId: missingPersonId,
      metadata: { splits: dto.splits, poolAmount: poolAmount.toFixed(2) },
    });
  }

  /** Case closed with no valid claim, or the offer is withdrawn after funding (section 21). */
  async closeWithoutPayout(adminId: string, missingPersonId: string, reason: string) {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: { fundingStatus: true, fundedAmount: true },
    });
    if (!mp) throw new NotFoundException('missing_person_not_found');

    const openClaims = await this.prisma.rewardClaim.findMany({
      where: { missingPersonId, status: { in: OPEN_CLAIM_STATUSES } },
      select: { id: true },
    });
    if (openClaims.length === 0 && mp.fundedAmount.lte(0)) {
      throw new BadRequestException('nothing_to_close');
    }

    await this.prisma.$transaction(async (tx) => {
      if (openClaims.length > 0) {
        await tx.rewardClaim.updateMany({
          where: { id: { in: openClaims.map((c) => c.id) } },
          data: { status: 'REJECTED', decisionReason: reason },
        });
      }
      if (mp.fundedAmount.gt(0)) {
        await tx.missingPerson.update({
          where: { id: missingPersonId },
          data: { fundingStatus: 'REFUND_DUE', closureReason: reason, closedAt: new Date() },
        });
      }
    });
    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.REWARD_CLOSED,
      entityType: 'MissingPerson',
      entityId: missingPersonId,
      reason,
    });
  }

  /**
   * Reacts to a settled reward-funding payment. Updates the funded/reserved
   * balance and funding status directly on MissingPerson — no RewardClaim row
   * is created here anymore (see file header). Idempotent: re-running this for
   * an already-counted payment would double-count, so PaymentService must only
   * ever emit BILLING_PAYMENT_PAID once per payment (it already guards this via
   * the PENDING -> PAID transition's updateMany count check).
   */
  @OnEvent(BILLING_PAYMENT_PAID)
  async onPaymentPaid(e: BillingPaymentPaid): Promise<void> {
    if (!e.missingPersonId) return;
    const payment = await this.prisma.payment.findUnique({
      where: { id: e.paymentId },
      select: { amount: true, type: true },
    });
    if (!payment || payment.type !== 'MISSING_PERSON_REWARD') return;

    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: e.missingPersonId },
      select: { rewardAmount: true, fundingMethod: true, fundedAmount: true, reservedAmount: true },
    });
    if (!mp) return;

    const fundedAmount = mp.fundedAmount.add(payment.amount);
    const reservedAmount =
      mp.fundingMethod === 'PREPAID' ? mp.reservedAmount.add(payment.amount) : mp.reservedAmount;
    const target = new Prisma.Decimal(mp.rewardAmount ?? 0);
    let fundingStatus: RewardFundingStatus = 'PARTIALLY_FUNDED';
    if (target.gt(0) && fundedAmount.gte(target)) fundingStatus = 'FULLY_FUNDED';

    await this.prisma.missingPerson.update({
      where: { id: e.missingPersonId },
      data: { fundedAmount, reservedAmount, fundingStatus },
    });
    await this.events.log({
      actorId: null, // system: triggered by a settled Chapa payment, not an admin action
      action: AuditEventEnum.REWARD_FUNDED,
      entityType: 'MissingPerson',
      entityId: e.missingPersonId,
      metadata: { paymentId: e.paymentId, fundingStatus },
    });
  }
}
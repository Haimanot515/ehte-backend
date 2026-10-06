import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma, RewardClaimStatus, RewardFundingStatus } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  BILLING_PAYMENT_PAID,
  BillingEventsService,
  BillingPaymentPaid,
} from 'src/modules/billing/billing-events/service/billing-events.service';
import { AuditEventEnum } from '../../../../common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from '../../../../common/enums/shared/notification-events.enum';
import { RewardClaimApprovedEvent } from '../../../misc/notification/events/notification.events';
import {
  ClaimDecision,
  DecideClaimDto,
  ScoreClaimDto,
  SetEvaluationWeightsDto,
  SetFundingMethodDto,
  SplitRewardDto,
} from '../dto/reward-claim.dto';
import { EVALUATION_WEIGHTS_TOTAL } from '../reward.constants';

const OPEN_CLAIM_STATUSES: RewardClaimStatus[] = ['SUBMITTED', 'UNDER_REVIEW'];
const DECIDABLE_STATUSES: RewardClaimStatus[] = ['SUBMITTED', 'UNDER_REVIEW'];

@Injectable()
export class RewardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: BillingEventsService,
  ) {}

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
      action: AuditEventEnum.REWARD_APPROVED,
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
      action: AuditEventEnum.REWARD_REJECTED,
      entityType: 'MissingPerson',
      entityId: missingPersonId,
      reason,
    });
  }

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

  @OnEvent(BILLING_PAYMENT_PAID)
  async onPaymentPaid(e: BillingPaymentPaid): Promise<void> {
    if (!e.missingPersonId) return;
    const missingPersonId = e.missingPersonId;
    const payment = await this.prisma.payment.findUnique({
      where: { id: e.paymentId },
      select: { amount: true, type: true, fulfilledAt: true },
    });
    if (!payment || payment.type !== 'MISSING_PERSON_REWARD' || payment.fulfilledAt) return;

    const fundingStatus = await this.prisma.$transaction(
      async (tx): Promise<RewardFundingStatus | null> => {
        const mp = await tx.missingPerson.findUnique({
          where: { id: missingPersonId },
          select: { rewardAmount: true, fundingMethod: true, fundedAmount: true, reservedAmount: true },
        });
        if (!mp) return null;

        // fulfilledAt is claimed in the same transaction as the funding update, so a repeated event does nothing
        const { count } = await tx.payment.updateMany({
          where: { id: e.paymentId, fulfilledAt: null },
          data: { fulfilledAt: new Date() },
        });
        if (count === 0) return null;

        const fundedAmount = mp.fundedAmount.add(payment.amount);
        const reservedAmount =
          mp.fundingMethod === 'PREPAID' ? mp.reservedAmount.add(payment.amount) : mp.reservedAmount;
        const target = new Prisma.Decimal(mp.rewardAmount ?? 0);
        let status: RewardFundingStatus = 'PARTIALLY_FUNDED';
        if (target.gt(0) && fundedAmount.gte(target)) status = 'FULLY_FUNDED';

        await tx.missingPerson.update({
          where: { id: missingPersonId },
          data: { fundedAmount, reservedAmount, fundingStatus: status },
        });
        return status;
      },
    );
    if (!fundingStatus) return;

    await this.events.log({
      actorId: null,
      action: AuditEventEnum.REWARD_FUNDED,
      entityType: 'MissingPerson',
      entityId: missingPersonId,
      metadata: { paymentId: e.paymentId, fundingStatus },
    });
  }
}
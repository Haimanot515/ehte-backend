import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditSeverity, Prisma, RewardClaimStatus } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditEventEnum } from '../../../common/enums/shared/audit-events.enum';

import { BillingEventsService } from './billing-events.service';
import { money, pageArgs, pageResult } from './billing-admin.helpers';
import {
  DecideRewardAppealDto,
  RewardAppealsQueryDto,
  RewardClaimsQueryDto,
  RewardOffersQueryDto,
} from '../dto/billing-admin.dto';

// Decisions that can be reopened. Paid or already approved claims cannot.
const REOPENABLE: RewardClaimStatus[] = [
  RewardClaimStatus.INVALID,
  RewardClaimStatus.INELIGIBLE,
  RewardClaimStatus.DUPLICATE,
  RewardClaimStatus.ALREADY_KNOWN,
  RewardClaimStatus.REJECTED,
];

@Injectable()
export class RewardAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: BillingEventsService,
  ) {}

  private async loadClaim(claimId: string) {
    const c = await this.prisma.rewardClaim.findUnique({ where: { id: claimId } });
    if (!c) throw new NotFoundException('reward_claim_not_found');
    return c;
  }

  // BL-66
  async listClaims(q: RewardClaimsQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.RewardClaimWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.missingPersonId ? { missingPersonId: q.missingPersonId } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.rewardClaim.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          missingPersonId: true,
          status: true,
          weightedScore: true,
          rewardPercentage: true,
          rewardAmount: true,
          reviewedAt: true,
          approvedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.rewardClaim.count({ where }),
    ]);

    return pageResult(
      items.map((i) => ({
        ...i,
        weightedScore: i.weightedScore?.toString() ?? null,
        rewardPercentage: i.rewardPercentage?.toString() ?? null,
        rewardAmount: i.rewardAmount ? money(i.rewardAmount) : null,
      })),
      total,
      page,
      limit,
    );
  }

  // BL-67
  async getClaim(claimId: string) {
    const c = await this.prisma.rewardClaim.findUnique({
      where: { id: claimId },
      include: {
        disbursements: {
          select: { id: true, status: true, amount: true, reference: true, executedAt: true },
        },
        appeals: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, decisionNote: true, createdAt: true, decidedAt: true },
        },
      },
    });
    if (!c) throw new NotFoundException('reward_claim_not_found');

    // informantUserId is left out on purpose.
    const { informantUserId: _hidden, ...rest } = c;
    void _hidden;
    return {
      ...rest,
      weightedScore: c.weightedScore?.toString() ?? null,
      rewardPercentage: c.rewardPercentage?.toString() ?? null,
      rewardAmount: c.rewardAmount ? money(c.rewardAmount) : null,
      disbursements: c.disbursements.map((d) => ({ ...d, amount: money(d.amount) })),
    };
  }

  // BL-68
  async timeline(claimId: string) {
    await this.loadClaim(claimId);

    const rows = await this.prisma.auditLog.findMany({
      where: { entity: 'RewardClaim', entityId: claimId },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        action: true,
        outcome: true,
        reason: true,
        userId: true,
        metadata: true,
      },
    });

    return {
      claimId,
      entries: rows.map((r) => ({
        at: r.createdAt,
        event: r.action,
        outcome: r.outcome,
        reason: r.reason,
        actorId: r.userId,
        metadata: r.metadata,
      })),
    };
  }

  // BL-69. Reopens a decided claim for review. Does not change money.
  async reopen(adminId: string, claimId: string, reason: string) {
    const c = await this.loadClaim(claimId);
    if (!REOPENABLE.includes(c.status)) {
      throw new BadRequestException('claim_status_cannot_be_reopened');
    }

    const { count } = await this.prisma.rewardClaim.updateMany({
      where: { id: claimId, status: c.status },
      data: {
        status: RewardClaimStatus.UNDER_REVIEW,
        decisionReason: null,
        duplicateOfClaimId: null,
        reviewedById: null,
        reviewedAt: null,
      },
    });
    if (count === 0) throw new ConflictException('claim_changed_while_reopening');

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.REWARD_CLAIM_REOPENED,
      entityType: 'RewardClaim',
      entityId: claimId,
      reason,
      severity: AuditSeverity.WARNING,
      metadata: { previousStatus: c.status, previousReason: c.decisionReason },
    });

    return { id: claimId, status: RewardClaimStatus.UNDER_REVIEW };
  }

  // BL-70
  async listAppeals(q: RewardAppealsQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.RewardClaimAppealWhereInput = { status: q.status ?? 'OPEN' };

    const [items, total] = await Promise.all([
      this.prisma.rewardClaimAppeal.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        // The informant id is not exposed in the queue.
        select: {
          id: true,
          claimId: true,
          message: true,
          status: true,
          decisionNote: true,
          createdAt: true,
          decidedAt: true,
          claim: { select: { status: true, missingPersonId: true, decisionReason: true } },
        },
      }),
      this.prisma.rewardClaimAppeal.count({ where }),
    ]);

    return pageResult(items, total, page, limit);
  }

  // BL-71. Upholding an appeal reopens the claim, it does not approve it.
  async decideAppeal(adminId: string, appealId: string, dto: DecideRewardAppealDto) {
    const a = await this.prisma.rewardClaimAppeal.findUnique({
      where: { id: appealId },
      include: { claim: true },
    });
    if (!a) throw new NotFoundException('appeal_not_found');
    if (a.status !== 'OPEN') throw new ConflictException('appeal_already_decided');

    const uphold = dto.decision === 'UPHOLD';
    if (uphold && !REOPENABLE.includes(a.claim.status)) {
      throw new BadRequestException('claim_status_cannot_be_reopened');
    }

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rewardClaimAppeal.updateMany({
        where: { id: appealId, status: 'OPEN' },
        data: {
          status: uphold ? 'UPHELD' : 'DECLINED',
          decisionNote: dto.note,
          decidedByUserId: adminId,
          decidedAt: new Date(),
        },
      });
      if (count === 0) throw new ConflictException('appeal_already_decided');

      if (uphold) {
        await tx.rewardClaim.update({
          where: { id: a.claimId },
          data: {
            status: RewardClaimStatus.UNDER_REVIEW,
            decisionReason: null,
            duplicateOfClaimId: null,
            reviewedById: null,
            reviewedAt: null,
          },
        });
      }
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.REWARD_APPEAL_DECIDED,
      entityType: 'RewardClaim',
      entityId: a.claimId,
      reason: dto.note,
      metadata: { appealId, decision: dto.decision, claimStatusBefore: a.claim.status },
    });

    return { id: appealId, status: uphold ? 'UPHELD' : 'DECLINED', claimReopened: uphold };
  }

  // BL-72
  async listOffers(q: RewardOffersQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.MissingPersonWhereInput = {
      rewardOffered: true,
      ...(q.approved ? { rewardApproved: q.approved === 'true' } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          status: true,
          rewardAmount: true,
          rewardCurrency: true,
          rewardApproved: true,
          fundingMethod: true,
          fundingStatus: true,
          createdAt: true,
          _count: { select: { rewardClaims: true } },
        },
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return pageResult(items, total, page, limit);
  }

  // BL-73. Offers waiting for an approve or reject decision, oldest first.
  async pendingOffers(q: RewardOffersQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.MissingPersonWhereInput = { rewardOffered: true, rewardApproved: false };

    const [items, total] = await Promise.all([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          status: true,
          rewardAmount: true,
          rewardCurrency: true,
          rewardDetails: true,
          createdAt: true,
        },
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return pageResult(items, total, page, limit);
  }

  // BL-75. The only route that returns an informant's identity.
  async revealInformant(adminId: string, claimId: string, reason: string) {
    const c = await this.loadClaim(claimId);
    if (!c.informantUserId) throw new NotFoundException('informant_not_recorded');

    const u = await this.prisma.user.findUnique({
      where: { id: c.informantUserId },
      select: { id: true, name: true, phone: true },
    });
    if (!u) throw new NotFoundException('informant_not_found');

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.INFORMANT_IDENTITY_REVEALED,
      entityType: 'RewardClaim',
      entityId: claimId,
      reason,
      severity: AuditSeverity.CRITICAL,
      metadata: { informantUserId: u.id },
    });

    return { claimId, informant: { id: u.id, name: u.name, phone: u.phone } };
  }

  // BL-76. Other claims on the same case that look related to this one.
  async duplicates(claimId: string) {
    const c = await this.loadClaim(claimId);

    const related = await this.prisma.rewardClaim.findMany({
      where: {
        missingPersonId: c.missingPersonId,
        id: { not: c.id },
        OR: [
          ...(c.informantUserId ? [{ informantUserId: c.informantUserId }] : []),
          { duplicateOfClaimId: c.id },
          ...(c.duplicateOfClaimId ? [{ id: c.duplicateOfClaimId }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        duplicateOfClaimId: true,
        createdAt: true,
      },
    });

    return {
      claimId,
      items: related.map((r) => ({
        ...r,
        relation:
          r.duplicateOfClaimId === c.id
            ? 'marked_duplicate_of_this'
            : r.id === c.duplicateOfClaimId
              ? 'original_of_this'
              : 'same_informant',
      })),
    };
  }
}

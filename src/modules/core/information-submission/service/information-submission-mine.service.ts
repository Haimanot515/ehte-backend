import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditOutcome, InformationStatus, Prisma, RewardClaimStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { ListInformationSubmissionsQueryDto } from '../dto/information-submission.dto';
import { OPEN_STATUSES, TERMINAL_STATUSES } from './information-submission.constants';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionMineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

  // Owner-facing download; not audited, same as ReportReporterService.getMediaDownloadUrl.
  async getMediaDownloadUrl(id: string, userId: string, key: string): Promise<{ url: string }> {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: { id },
    });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    if (submission.userId !== userId) {
      throw new ForbiddenException('not_authorized');
    }

    const owned = this.informationSubmissionCommonService
      .collectMediaFields(submission)
      .includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_submission');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  async findMine(userId: string, query: ListInformationSubmissionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      userId,
      deletedAt: null, // NEW (soft delete)
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: {
          missingPerson: {
            select: { id: true, personType: true, name: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findMineForMissingPerson(userId: string, missingPersonId: string) {
    return this.prisma.informationSubmission.findMany({
      where: { userId, missingPersonId, deletedAt: null }, // NEW (soft delete)
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string) {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: { id },
      include: {
        missingPerson: {
          select: { id: true, personType: true, name: true, status: true },
        },
      },
    });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    if (submission.userId !== userId) {
      throw new ForbiddenException('not_authorized');
    }

    return submission;
  }

  async countMyUnreadUpdates(user: CurrentUserDto): Promise<{ count: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count
      FROM information_submission s
      WHERE s."userId" = ${user.id}
        AND s."deletedAt" IS NULL
        AND (
          s.status <> s."informantSeenStatus"
          OR EXISTS (
            SELECT 1 FROM information_timeline_event e
            WHERE e."submissionId" = s.id
              AND e.type::text IN ('QUESTION_ASKED', 'MESSAGE')
              AND e."createdAt" > COALESCE(s."informantSeenAt", s."createdAt")
          )
        )
    `);
    return { count: rows[0]?.count ?? 0 };
  }

  async getMySummary(user: CurrentUserDto) {
    const [byStatus, openQuestions, unread] = await Promise.all([
      this.prisma.informationSubmission.groupBy({
        by: ['status'],
        where: { userId: user.id, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.informationQuestion.count({
        where: { answeredAt: null, submission: { userId: user.id, deletedAt: null } },
      }),
      this.countMyUnreadUpdates(user),
    ]);

    const counts = Object.fromEntries(
      Object.values(InformationStatus).map((s) => [s, 0]),
    ) as Record<InformationStatus, number>;
    for (const row of byStatus) {
      counts[row.status] = row._count._all;
    }

    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      pending: counts.PENDING,
      underReview: counts.UNDER_REVIEW,
      reviewed: counts.REVIEWED,
      rejected: counts.REJECTED,
      openQuestions,
      unreadUpdates: unread.count,
    };
  }

  // Raw so that marking seen doesn't bump updatedAt.
  async markAllMineSeen(user: CurrentUserDto) {
    const updated = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE information_submission
      SET "informantSeenStatus" = status, "informantSeenAt" = NOW()
      WHERE "userId" = ${user.id} AND "deletedAt" IS NULL
    `);
    return { updated };
  }

  async markMineSeen(user: CurrentUserDto, id: string) {
    await this.informationSubmissionCommonService.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
    );

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE information_submission
      SET "informantSeenStatus" = status, "informantSeenAt" = NOW()
      WHERE id = ${id}
    `);
    return { id, seen: true };
  }

  async getMyTimeline(user: CurrentUserDto, id: string) {
    const submission = await this.informationSubmissionCommonService.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
    );

    const statusActions: Array<{ action: AuditEventEnum; status: InformationStatus }> = [
      { action: AuditEventEnum.INFORMATION_UNDER_REVIEW, status: InformationStatus.UNDER_REVIEW },
      { action: AuditEventEnum.INFORMATION_REVIEWED, status: InformationStatus.REVIEWED },
      { action: AuditEventEnum.INFORMATION_REJECTED, status: InformationStatus.REJECTED },
    ];

    const [events, statusRows] = await Promise.all([
      this.prisma.informationTimelineEvent.findMany({
        where: { submissionId: id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, type: true, message: true, data: true, createdAt: true },
      }),
      this.prisma.auditLog.findMany({
        where: {
          entity: 'InformationSubmission',
          entityId: id,
          outcome: AuditOutcome.SUCCESS,
          action: { in: statusActions.map((s) => s.action as string) },
        },
        orderBy: { createdAt: 'asc' },
        select: { action: true, reason: true, createdAt: true },
      }),
    ]);

    const entries = [
      {
        type: 'SUBMITTED',
        at: submission.createdAt,
        status: InformationStatus.PENDING,
        message: null as string | null,
      },
      ...statusRows.map((row) => ({
        type: 'STATUS_CHANGED',
        at: row.createdAt,
        status: statusActions.find((s) => (s.action as string) === row.action)?.status ?? null,
        message: row.reason ?? null,
      })),
      ...events.map((e) => ({
        type: e.type as string,
        at: e.createdAt,
        status: null as InformationStatus | null,
        message: e.message,
        eventId: e.id,
      })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());

    return { submissionId: id, status: submission.status, entries };
  }

  async getMyQuestions(user: CurrentUserDto, id: string) {
    await this.informationSubmissionCommonService.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
    );

    return this.prisma.informationQuestion.findMany({
      where: { submissionId: id, answeredAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, question: true, createdAt: true },
    });
  }

  async getMyOutcome(user: CurrentUserDto, id: string) {
    const submission = await this.informationSubmissionCommonService.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
    );

    const [claims, appeal] = await Promise.all([
      this.prisma.rewardClaim.findMany({
        where: { informationSubmissionId: id },
        select: { status: true },
      }),
      this.prisma.informationAppeal.findUnique({
        where: { submissionId: id },
        select: { status: true },
      }),
    ]);

    let outcome: 'IN_PROGRESS' | 'ACCEPTED' | 'NOT_ACCEPTED' | 'DUPLICATE' | 'ALREADY_KNOWN';
    if (OPEN_STATUSES.includes(submission.status)) {
      outcome = 'IN_PROGRESS';
    } else if (submission.status === InformationStatus.REVIEWED) {
      outcome = 'ACCEPTED';
    } else if (submission.resolution === 'DUPLICATE') {
      outcome = 'DUPLICATE';
    } else if (submission.resolution === 'ALREADY_KNOWN') {
      outcome = 'ALREADY_KNOWN';
    } else {
      outcome = 'NOT_ACCEPTED';
    }

    const positive: RewardClaimStatus[] = [
      RewardClaimStatus.VALID,
      RewardClaimStatus.APPROVED_FOR_REWARD,
      RewardClaimStatus.PAID_OUT,
    ];
    const negative: RewardClaimStatus[] = [
      RewardClaimStatus.INVALID,
      RewardClaimStatus.INELIGIBLE,
      RewardClaimStatus.REJECTED,
    ];

    let helped: boolean | null = null;
    if (outcome === 'NOT_ACCEPTED' || outcome === 'DUPLICATE' || outcome === 'ALREADY_KNOWN') {
      helped = false;
    } else if (claims.some((c) => positive.includes(c.status))) {
      helped = true;
    } else if (claims.length > 0 && claims.every((c) => negative.includes(c.status))) {
      helped = false;
    }

    const decidedAt = TERMINAL_STATUSES.includes(submission.status)
      ? await this.informationSubmissionCommonService.decisionAt(
          id,
          [AuditEventEnum.INFORMATION_REVIEWED, AuditEventEnum.INFORMATION_REJECTED],
          submission.updatedAt,
        )
      : null;

    return {
      submissionId: id,
      status: submission.status,
      outcome,
      helped,
      decidedAt,
      appealFiled: !!appeal,
      appealStatus: appeal?.status ?? null,
    };
  }

  // The informant's own reward claim state. Amounts only once a share has been approved.
  async getMyRewardStatus(user: CurrentUserDto, id: string) {
    await this.informationSubmissionCommonService.findOwnedOrThrow(
      user,
      id,
      AuditEventEnum.INFORMATION_SUBMISSION_UPDATED,
    );

    const claims = await this.prisma.rewardClaim.findMany({
      where: { informationSubmissionId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        rewardAmount: true,
        approvedAt: true,
        createdAt: true,
        missingPerson: { select: { rewardCurrency: true } },
        disbursements: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true, executedAt: true },
        },
      },
    });

    const showAmount: RewardClaimStatus[] = [
      RewardClaimStatus.APPROVED_FOR_REWARD,
      RewardClaimStatus.PAID_OUT,
    ];

    return {
      submissionId: id,
      hasClaim: claims.length > 0,
      claims: claims.map((c) => ({
        id: c.id,
        status: c.status,
        rewardAmount: showAmount.includes(c.status) ? c.rewardAmount : null,
        currency: c.missingPerson.rewardCurrency,
        approvedAt: c.approvedAt,
        createdAt: c.createdAt,
        payout: c.disbursements[0]
          ? { status: c.disbursements[0].status, paidAt: c.disbursements[0].executedAt }
          : null,
      })),
    };
  }
}

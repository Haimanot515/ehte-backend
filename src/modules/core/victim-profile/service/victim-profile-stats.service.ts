import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AuditOutcome,
  Prisma,
  VictimProfileAppealStatus,
  VictimProfileFlagStatus,
  VictimProfileStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { StatsInterval, StatsQueryDto, StatsTimelineQueryDto } from '../dto/victim-profile.dto';
import {
  money,
  PIPELINE_STATUSES,
  APPROVED_OUTCOME_STATUSES,
  FIRST_REVIEW_ACTIONS,
  DECISION_ACTIONS,
  chunk,
  hoursBetween,
  summarize,
  STATS_ROW_CAP,
} from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  // Not cached: sharing a single global stats cache key across modules risks cross-overwrite.
  async getStats() {
    const [total, grouped, raised] = await this.prisma.$transaction([
      this.prisma.victimProfile.count(),
      this.prisma.victimProfile.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.victimProfile.aggregate({ _sum: { totalRaised: true } }),
    ]);

    const counts = Object.fromEntries(
      Object.values(VictimProfileStatus).map((status) => [status, 0]),
    ) as Record<VictimProfileStatus, number>;

    for (const row of grouped) {
      const rowCount = row._count as { status?: number } | undefined;
      counts[row.status] = rowCount?.status ?? 0;
    }

    return {
      total,
      pending: counts[VictimProfileStatus.PENDING] ?? 0,
      underReview: counts[VictimProfileStatus.UNDER_REVIEW] ?? 0,
      consentPending: counts[VictimProfileStatus.CONSENT_PENDING] ?? 0,
      verified: counts[VictimProfileStatus.VERIFIED] ?? 0,
      approved: counts[VictimProfileStatus.APPROVED] ?? 0,
      published: counts[VictimProfileStatus.PUBLISHED] ?? 0,
      unpublished: counts[VictimProfileStatus.UNPUBLISHED] ?? 0,
      rejected: counts[VictimProfileStatus.REJECTED] ?? 0,
      totalRaisedAllProfiles: money(raised._sum.totalRaised ?? 0),
    };
  }

  private bucketKey(date: Date, interval: StatsInterval): string {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    if (interval === StatsInterval.WEEK) {
      const day = (d.getUTCDay() + 6) % 7; // Monday start
      d.setUTCDate(d.getUTCDate() - day);
    } else if (interval === StatsInterval.MONTH) {
      d.setUTCDate(1);
    }
    return d.toISOString().slice(0, 10);
  }

  // Earliest audit event of the given actions per profile (first review / decision times).
  private async firstAuditTimes(
    ids: string[],
    actions: AuditEventEnum[],
  ): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    for (const part of chunk(ids, 1000)) {
      const rows = await this.prisma.auditLog.groupBy({
        by: ['entityId'],
        where: {
          entity: 'VictimProfile',
          entityId: { in: part },
          action: { in: actions },
          outcome: AuditOutcome.SUCCESS,
        },
        _min: { createdAt: true },
        orderBy: { entityId: 'asc' },
      });
      for (const r of rows)
        if (r.entityId && r._min.createdAt) out.set(r.entityId, r._min.createdAt);
    }
    return out;
  }

  // VP-91
  async getStatsTimeline(_admin: CurrentUserDto, query: StatsTimelineQueryDto) {
    const interval = query.interval ?? StatsInterval.DAY;
    const rows = await this.prisma.victimProfile.findMany({
      where: this.victimProfileCommonService.statsWhere(query),
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: STATS_ROW_CAP,
    });

    const buckets = new Map<string, number>();
    for (const r of rows) {
      const k = this.bucketKey(r.createdAt, interval);
      buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
    return {
      interval,
      truncated: rows.length >= STATS_ROW_CAP,
      series: [...buckets.entries()].map(([date, count]) => ({ date, count })),
    };
  }

  // VP-92
  async getStatsByStatus(_admin: CurrentUserDto, query: StatsQueryDto) {
    const grouped = await this.prisma.victimProfile.groupBy({
      by: ['status'],
      where: this.victimProfileCommonService.statsWhere(query),
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });
    const counts = Object.fromEntries(
      Object.values(VictimProfileStatus).map((s) => [s, 0]),
    ) as Record<VictimProfileStatus, number>;
    for (const r of grouped) counts[r.status] = r._count._all;
    return { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts };
  }

  // VP-93
  async getStatsByCategory(_admin: CurrentUserDto, query: StatsQueryDto) {
    const grouped = await this.prisma.victimProfile.groupBy({
      by: ['supportType'],
      where: this.victimProfileCommonService.statsWhere(query),
      _count: { _all: true },
      _sum: { totalRaised: true },
      orderBy: { supportType: 'asc' },
    });
    return grouped.map((r) => ({
      category: r.supportType ?? 'UNSPECIFIED',
      count: r._count._all,
      totalRaised: money(r._sum.totalRaised),
    }));
  }

  // VP-94  (derived from the audit trail, so it also covers decisions made by the older methods)
  async getStatsReviewTime(_admin: CurrentUserDto, query: StatsQueryDto) {
    const profiles = await this.prisma.victimProfile.findMany({
      where: this.victimProfileCommonService.statsWhere(query),
      select: { id: true, createdAt: true, involvesChild: true },
      orderBy: { createdAt: 'desc' },
      take: STATS_ROW_CAP,
    });
    const ids = profiles.map((p) => p.id);

    const [firstReview, decision] = await Promise.all([
      this.firstAuditTimes(ids, FIRST_REVIEW_ACTIONS),
      this.firstAuditTimes(ids, DECISION_ACTIONS),
    ]);

    const collect = (times: Map<string, Date>, child?: boolean) =>
      profiles
        .filter((p) => (child === undefined ? true : p.involvesChild === child) && times.has(p.id))
        .map((p) => hoursBetween(p.createdAt, times.get(p.id) as Date))
        .filter((h) => h >= 0);

    return {
      sampled: profiles.length,
      timeToFirstReview: summarize(collect(firstReview)),
      timeToDecision: summarize(collect(decision)),
      childInvolved: {
        timeToFirstReview: summarize(collect(firstReview, true)),
        timeToDecision: summarize(collect(decision, true)),
      },
      notYetReviewed: profiles.filter((p) => !firstReview.has(p.id)).length,
    };
  }

  // VP-95  (daily count of profiles that existed and were still undecided; default window = last 30 days)
  async getStatsBacklog(_admin: CurrentUserDto, query: StatsQueryDto) {
    const { from, to } = this.victimProfileCommonService.parseRange(query);
    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - 29 * 86_400_000);
    if (end.getTime() - start.getTime() > 366 * 86_400_000) {
      throw new BadRequestException('date_range_too_large');
    }

    // The window applies to the days shown, not to which profiles are counted.
    const { createdAt: _ignored, ...baseWhere } = this.victimProfileCommonService.statsWhere({
      ...query,
      from: undefined,
      to: undefined,
    }) as Prisma.VictimProfileWhereInput & { createdAt?: unknown };
    const profiles = await this.prisma.victimProfile.findMany({
      where: { ...baseWhere, createdAt: { lte: end } },
      select: { id: true, createdAt: true },
      take: STATS_ROW_CAP,
    });
    const decided = await this.firstAuditTimes(
      profiles.map((p) => p.id),
      [
        ...DECISION_ACTIONS,
        AuditEventEnum.VICTIM_PROFILE_DELETED,
        AuditEventEnum.VICTIM_PROFILE_WITHDRAWN,
      ],
    );

    const series: Array<{ date: string; pending: number }> = [];
    for (
      let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
      t <= end.getTime();
      t += 86_400_000
    ) {
      const endOfDay = t + 86_400_000 - 1;
      let pending = 0;
      for (const p of profiles) {
        if (p.createdAt.getTime() > endOfDay) continue;
        const d = decided.get(p.id);
        if (!d || d.getTime() > endOfDay) pending += 1;
      }
      series.push({ date: new Date(t).toISOString().slice(0, 10), pending });
    }
    return { series, truncated: profiles.length >= STATS_ROW_CAP };
  }

  // VP-96
  async getStatsAging(_admin: CurrentUserDto, query: StatsQueryDto) {
    const where: Prisma.VictimProfileWhereInput = {
      AND: [this.victimProfileCommonService.statsWhere(query), { status: { in: PIPELINE_STATUSES } }],
    };
    const rows = await this.prisma.victimProfile.findMany({
      where,
      select: { createdAt: true, involvesChild: true },
      take: STATS_ROW_CAP,
    });

    const edges = [
      { label: 'under_24h', max: 24 },
      { label: '1_to_3_days', max: 72 },
      { label: '3_to_7_days', max: 168 },
      { label: '7_to_14_days', max: 336 },
      { label: 'over_14_days', max: Infinity },
    ];
    const buckets = edges.map((e) => ({ bucket: e.label, count: 0, childInvolved: 0 }));
    const now = new Date();
    for (const r of rows) {
      const age = hoursBetween(r.createdAt, now);
      const i = edges.findIndex((e) => age < e.max);
      buckets[i].count += 1;
      if (r.involvesChild) buckets[i].childInvolved += 1;
    }
    return { totalPending: rows.length, buckets };
  }

  // VP-97  (basis: current status. approved = APPROVED / PUBLISHED / COMPLETED, rejected = REJECTED)
  async getStatsApprovalRate(_admin: CurrentUserDto, query: StatsQueryDto) {
    const { byStatus } = await this.getStatsByStatus(_admin, query);
    const approved = APPROVED_OUTCOME_STATUSES.reduce((n, s) => n + byStatus[s], 0);
    const rejected = byStatus[VictimProfileStatus.REJECTED];
    const decided = approved + rejected;
    return {
      basis: 'current_status',
      approved,
      rejected,
      decided,
      approvalRate: decided ? Math.round((approved / decided) * 10_000) / 100 : null,
    };
  }

  // VP-98  (monthly series of PAID support payments: gross, recipient share, platform share, provider fee, paid out)
  async getStatsFunding(_admin: CurrentUserDto, query: StatsQueryDto) {
    const { from, to } = this.victimProfileCommonService.parseRange(query);
    const { createdAt: _ignored, ...profileWhere } = this.victimProfileCommonService.statsWhere({
      ...query,
      from: undefined,
      to: undefined,
    }) as Prisma.VictimProfileWhereInput & { createdAt?: unknown };

    const payments = await this.prisma.payment.findMany({
      where: {
        type: 'SUPPORT',
        status: 'PAID',
        support: { status: { not: 'CANCELLED' } },
        victimProfile: { is: profileWhere },
        ...(from || to
          ? { paidAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      select: {
        paidAt: true,
        createdAt: true,
        amount: true,
        chapaFee: true,
        allocations: {
          select: {
            partyType: true,
            amount: true,
            disbursements: { where: { status: 'PAID_OUT' }, select: { amount: true } },
          },
        },
      },
      take: STATS_ROW_CAP,
    });

    type Row = {
      gross: Prisma.Decimal;
      recipient: Prisma.Decimal;
      platform: Prisma.Decimal;
      providerFee: Prisma.Decimal;
      paidOut: Prisma.Decimal;
      payments: number;
    };
    const zero = (): Row => ({
      gross: new Prisma.Decimal(0),
      recipient: new Prisma.Decimal(0),
      platform: new Prisma.Decimal(0),
      providerFee: new Prisma.Decimal(0),
      paidOut: new Prisma.Decimal(0),
      payments: 0,
    });
    const total = zero();
    const months = new Map<string, Row>();

    for (const p of payments) {
      const key = this.bucketKey(p.paidAt ?? p.createdAt, StatsInterval.MONTH);
      const row = months.get(key) ?? zero();
      for (const target of [row, total]) {
        target.payments += 1;
        target.gross = target.gross.add(p.amount);
        if (p.chapaFee) target.providerFee = target.providerFee.add(p.chapaFee);
        for (const a of p.allocations) {
          if (a.partyType === 'RECIPIENT') {
            target.recipient = target.recipient.add(a.amount);
            for (const d of a.disbursements) target.paidOut = target.paidOut.add(d.amount);
          } else if (a.partyType === 'PLATFORM') {
            target.platform = target.platform.add(a.amount);
          }
        }
      }
      months.set(key, row);
    }

    const fmt = (r: Row) => ({
      payments: r.payments,
      gross: money(r.gross),
      recipientShare: money(r.recipient),
      platformShare: money(r.platform),
      providerFees: money(r.providerFee),
      paidOut: money(r.paidOut),
      awaitingPayout: money(Prisma.Decimal.max(r.recipient.sub(r.paidOut), 0)),
    });

    return {
      currency: 'ETB',
      truncated: payments.length >= STATS_ROW_CAP,
      totals: fmt(total),
      series: [...months.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, r]) => ({ month, ...fmt(r) })),
    };
  }

  // VP-99
  async getStatsGoalProgress(_admin: CurrentUserDto, query: StatsQueryDto) {
    const rows = await this.prisma.victimProfile.findMany({
      where: { AND: [this.victimProfileCommonService.statsWhere(query), { supportGoal: { gt: 0 } }] },
      select: { supportGoal: true, totalRaised: true },
      take: STATS_ROW_CAP,
    });

    const buckets = [
      { bucket: '0_to_24', min: 0, count: 0 },
      { bucket: '25_to_49', min: 25, count: 0 },
      { bucket: '50_to_74', min: 50, count: 0 },
      { bucket: '75_to_99', min: 75, count: 0 },
      { bucket: '100_plus', min: 100, count: 0 },
    ];
    for (const r of rows) {
      const pct = new Prisma.Decimal(r.totalRaised)
        .div(r.supportGoal as Prisma.Decimal)
        .mul(100)
        .toNumber();
      for (let i = buckets.length - 1; i >= 0; i--) {
        if (pct >= buckets[i].min) {
          buckets[i].count += 1;
          break;
        }
      }
    }
    return {
      profilesWithGoal: rows.length,
      buckets: buckets.map(({ bucket, count }) => ({ bucket, count })),
    };
  }

  // VP-100
  async getStatsChildInvolved(_admin: CurrentUserDto, query: StatsQueryDto) {
    const base = this.victimProfileCommonService.statsWhere({ ...query, involvesChild: true });
    const [total, byStatus, awaitingFirst, awaitingSecond, reviewed, published] = await Promise.all(
      [
        this.prisma.victimProfile.count({ where: base }),
        this.prisma.victimProfile.groupBy({
          by: ['status'],
          where: base,
          _count: { _all: true },
          orderBy: { status: 'asc' },
        }),
        this.prisma.victimProfile.count({
          where: {
            AND: [
              base,
              {
                isChildSafetyReviewed: false,
                childSafetyFirstConfirmedByUserId: null,
                status: { in: PIPELINE_STATUSES },
              },
            ],
          },
        }),
        this.prisma.victimProfile.count({
          where: {
            AND: [
              base,
              { isChildSafetyReviewed: false, childSafetyFirstConfirmedByUserId: { not: null } },
            ],
          },
        }),
        this.prisma.victimProfile.count({
          where: { AND: [base, { isChildSafetyReviewed: true }] },
        }),
        this.prisma.victimProfile.count({
          where: { AND: [base, { status: VictimProfileStatus.PUBLISHED }] },
        }),
      ],
    );

    return {
      total,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      reviewPath: {
        awaitingFirstConfirmation: awaitingFirst,
        awaitingSecondConfirmation: awaitingSecond,
        childSafetyReviewed: reviewed,
        published,
      },
    };
  }

  // VP-101  (super admin) workload = what each reviewer holds now; speed = created -> decision for decisions they made in range
  async getStatsByAdmin(_admin: CurrentUserDto, query: StatsQueryDto) {
    const where = this.victimProfileCommonService.statsWhere({ ...query, assignedTo: undefined });
    const { from, to } = this.victimProfileCommonService.parseRange(query);

    const [assigned, claimed, decisions] = await Promise.all([
      this.prisma.victimProfile.groupBy({
        by: ['assignedReviewerId'],
        where: {
          AND: [where, { assignedReviewerId: { not: null }, status: { in: PIPELINE_STATUSES } }],
        },
        _count: { _all: true },
        orderBy: { assignedReviewerId: 'asc' },
      }),
      this.prisma.victimProfile.groupBy({
        by: ['claimedByUserId'],
        where: {
          AND: [where, { claimedByUserId: { not: null }, status: { in: PIPELINE_STATUSES } }],
        },
        _count: { _all: true },
        orderBy: { claimedByUserId: 'asc' },
      }),
      this.prisma.auditLog.findMany({
        where: {
          entity: 'VictimProfile',
          action: { in: [...DECISION_ACTIONS, AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED] },
          outcome: AuditOutcome.SUCCESS,
          userId: { not: null },
          ...(from || to
            ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
            : {}),
        },
        select: { userId: true, entityId: true, action: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: STATS_ROW_CAP,
      }),
    ]);

    const created = new Map<string, Date>();
    for (const part of chunk(
      [...new Set(decisions.map((d) => d.entityId).filter((x): x is string => !!x))],
      1000,
    )) {
      const ps = await this.prisma.victimProfile.findMany({
        where: { id: { in: part } },
        select: { id: true, createdAt: true },
      });
      for (const p of ps) created.set(p.id, p.createdAt);
    }

    type Row = {
      assigned: number;
      claimed: number;
      published: number;
      rejected: number;
      changesRequested: number;
      hours: number[];
    };
    const admins = new Map<string, Row>();
    const row = (id: string): Row => {
      const r = admins.get(id) ?? {
        assigned: 0,
        claimed: 0,
        published: 0,
        rejected: 0,
        changesRequested: 0,
        hours: [],
      };
      admins.set(id, r);
      return r;
    };
    for (const a of assigned) row(a.assignedReviewerId as string).assigned = a._count._all;
    for (const c of claimed) row(c.claimedByUserId as string).claimed = c._count._all;
    for (const d of decisions) {
      const r = row(d.userId as string);
      if (d.action === AuditEventEnum.VICTIM_PROFILE_PUBLISHED) r.published += 1;
      else if (d.action === AuditEventEnum.VICTIM_PROFILE_REJECTED) r.rejected += 1;
      else r.changesRequested += 1;
      const c = d.entityId ? created.get(d.entityId) : undefined;
      if (c) r.hours.push(hoursBetween(c, d.createdAt));
    }

    const names = await this.victimProfileCommonService.creatorNames([...admins.keys()]);
    return [...admins.entries()].map(([adminId, r]) => ({
      adminId,
      name: names.get(adminId) ?? null,
      currentlyAssigned: r.assigned,
      currentlyClaimed: r.claimed,
      decisions: {
        published: r.published,
        rejected: r.rejected,
        changesRequested: r.changesRequested,
      },
      turnaround: summarize(r.hours.filter((h) => h >= 0)),
    }));
  }

  // VP-102
  async getStatsOverview(admin: CurrentUserDto, query: StatsQueryDto) {
    const [
      byStatus,
      byCategory,
      aging,
      approval,
      funding,
      child,
      reviewTime,
      openFlags,
      openAppeals,
      paused,
    ] = await Promise.all([
      this.getStatsByStatus(admin, query),
      this.getStatsByCategory(admin, query),
      this.getStatsAging(admin, query),
      this.getStatsApprovalRate(admin, query),
      this.getStatsFunding(admin, query),
      this.getStatsChildInvolved(admin, query),
      this.getStatsReviewTime(admin, query),
      this.prisma.victimProfileFlag.count({ where: { status: VictimProfileFlagStatus.OPEN } }),
      this.prisma.victimProfileAppeal.count({ where: { status: VictimProfileAppealStatus.OPEN } }),
      this.prisma.victimProfile.count({
        where: { AND: [this.victimProfileCommonService.statsWhere(query), { donationsPaused: true }] },
      }),
    ]);

    return {
      totals: {
        profiles: byStatus.total,
        published: byStatus.byStatus[VictimProfileStatus.PUBLISHED],
        pending: aging.totalPending,
        donationsPaused: paused,
        totalRaised: funding.totals.recipientShare,
      },
      byStatus: byStatus.byStatus,
      byCategory,
      aging: aging.buckets,
      approvalRate: approval,
      funding: funding.totals,
      childInvolved: child,
      reviewTime: {
        timeToFirstReview: reviewTime.timeToFirstReview,
        timeToDecision: reviewTime.timeToDecision,
      },
      queues: { openFlags, openAppeals },
    };
  }
}

import { Injectable } from '@nestjs/common';
import {
  Prisma,
  SupportDisputeOutcome,
  SupportDisputeReason,
  SupportDisputeSide,
  SupportDisputeStatus,
  SupportStatus,
  SupportType,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import {
  SupportStatsInterval,
  SupportStatsQueryDto,
  SupportStatsTimelineQueryDto,
} from '../dto/support.dto';
import { COUNTED_STATUSES } from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supportCommonService: SupportCommonService,
  ) {}

  // Admin dashboard stats: totals by status and type, total confirmed amount, and offer counts.
  async getStats() {
    const [total, byStatus, byType, byTypeAndStatus, countedSum] = await this.prisma.$transaction([
      this.prisma.support.count(),
      this.prisma.support.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.support.groupBy({
        by: ['type'],
        _count: { type: true },
        orderBy: { type: 'asc' },
      }),
      this.prisma.support.groupBy({
        by: ['type', 'status'],
        _count: { _all: true },
        orderBy: [{ type: 'asc' }, { status: 'asc' }],
      }),
      this.prisma.support.aggregate({
        where: { type: SupportType.FINANCIAL, status: { in: COUNTED_STATUSES } },
        _sum: { recipientAmount: true, amount: true },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(SupportStatus).map((status) => [status, 0]),
    ) as Record<SupportStatus, number>;

    for (const row of byStatus) {
      const rowCount = row._count as { status?: number } | undefined;
      statusCounts[row.status] = rowCount?.status ?? 0;
    }

    const typeCounts = Object.fromEntries(
      Object.values(SupportType).map((type) => [type, 0]),
    ) as Record<SupportType, number>;

    for (const row of byType) {
      const rowCount = row._count as { type?: number } | undefined;
      typeCounts[row.type] = rowCount?.type ?? 0;
    }

    const nonFinancial = { pending: 0, received: 0, delivered: 0, cancelled: 0 };
    for (const row of byTypeAndStatus) {
      if (row.type !== SupportType.NON_FINANCIAL) continue;
      const n = (row._count as { _all?: number } | undefined)?._all ?? 0;
      if (row.status === SupportStatus.PENDING) nonFinancial.pending += n;
      if (row.status === SupportStatus.CONFIRMED || row.status === SupportStatus.COMPLETED) {
        nonFinancial.received += n;
      }
      if (row.status === SupportStatus.COMPLETED) nonFinancial.delivered += n;
      if (row.status === SupportStatus.CANCELLED) nonFinancial.cancelled += n;
    }

    return {
      total,
      pending: statusCounts[SupportStatus.PENDING] ?? 0,
      confirmed: statusCounts[SupportStatus.CONFIRMED] ?? 0,
      completed: statusCounts[SupportStatus.COMPLETED] ?? 0,
      cancelled: statusCounts[SupportStatus.CANCELLED] ?? 0,
      failed: statusCounts[SupportStatus.FAILED] ?? 0,
      byType: typeCounts,
      nonFinancial,
      totalConfirmedAmount: Number(countedSum._sum.recipientAmount ?? countedSum._sum.amount ?? 0),
    };
  }

  // Same filters as SQL conditions on the alias `s`, for the raw statistics queries.
  private statsConditions(q: SupportStatsQueryDto): Prisma.Sql[] {
    const conds: Prisma.Sql[] = [];
    if (q.from) conds.push(Prisma.sql`s."createdAt" >= ${new Date(q.from)}`);
    if (q.to) conds.push(Prisma.sql`s."createdAt" <= ${new Date(q.to)}`);
    if (q.status) conds.push(Prisma.sql`s."status" = ${q.status}::"SupportStatus"`);
    if (q.type) conds.push(Prisma.sql`s."type" = ${q.type}::"SupportType"`);
    if (q.victimProfileId) conds.push(Prisma.sql`s."victimProfileId" = ${q.victimProfileId}`);
    if (q.supporterId) conds.push(Prisma.sql`s."userId" = ${q.supporterId}`);
    return conds;
  }

  private whereSql(conds: Prisma.Sql[]): Prisma.Sql {
    return conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
  }

  // ═════════════════ admin: statistics (SP-61 .. SP-68) ═════════════════
  // Every route takes from, to, status, type, victimProfileId and supporterId.

  // SP-61
  async getSupportStatsTimeline(admin: CurrentUserDto, query: SupportStatsTimelineQueryDto) {
    void admin;
    const interval = query.interval ?? SupportStatsInterval.DAY;
    const unit =
      interval === SupportStatsInterval.WEEK
        ? 'week'
        : interval === SupportStatsInterval.MONTH
          ? 'month'
          : 'day';

    const rows = await this.prisma.$queryRaw<
      Array<{
        bucket: Date;
        total: bigint;
        nonFinancial: bigint;
        financial: bigint;
        completed: bigint;
        cancelled: bigint;
      }>
    >(Prisma.sql`
      SELECT date_trunc(${Prisma.raw(`'${unit}'`)}, s."createdAt") AS bucket,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE s."type" = 'NON_FINANCIAL') AS "nonFinancial",
             COUNT(*) FILTER (WHERE s."type" = 'FINANCIAL') AS financial,
             COUNT(*) FILTER (WHERE s."status" = 'COMPLETED') AS completed,
             COUNT(*) FILTER (WHERE s."status" = 'CANCELLED') AS cancelled
      FROM "Support" s
      ${this.whereSql(this.statsConditions(query))}
      GROUP BY 1
      ORDER BY 1 ASC
      LIMIT 1000
    `);

    return {
      interval,
      points: rows.map((r) => ({
        bucket: r.bucket,
        total: this.supportCommonService.num(r.total),
        nonFinancial: this.supportCommonService.num(r.nonFinancial),
        financial: this.supportCommonService.num(r.financial),
        completed: this.supportCommonService.num(r.completed),
        cancelled: this.supportCommonService.num(r.cancelled),
      })),
    };
  }

  // SP-62
  async getSupportStatsByStatus(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    void admin;
    const rows = await this.prisma.support.groupBy({
      by: ['status'],
      where: this.supportCommonService.buildStatsWhere(query),
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });
    const counts = Object.fromEntries(Object.values(SupportStatus).map((s) => [s, 0])) as Record<
      SupportStatus,
      number
    >;
    for (const row of rows) counts[row.status] = (row._count as { _all?: number })?._all ?? 0;
    return { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts };
  }

  // SP-63
  async getSupportStatsByType(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    void admin;
    const rows = await this.prisma.support.groupBy({
      by: ['type'],
      where: this.supportCommonService.buildStatsWhere(query),
      _count: { _all: true },
      _sum: { amount: true, recipientAmount: true },
      orderBy: { type: 'asc' },
    });

    const byType = Object.fromEntries(
      Object.values(SupportType).map((t) => [t, { count: 0, amount: 0, recipientAmount: 0 }]),
    ) as Record<SupportType, { count: number; amount: number; recipientAmount: number }>;
    for (const row of rows) {
      byType[row.type] = {
        count: (row._count as { _all?: number })?._all ?? 0,
        amount: Number(row._sum?.amount ?? 0),
        recipientAmount: Number(row._sum?.recipientAmount ?? 0),
      };
    }
    return { byType };
  }

  // SP-64. Hours from the offer being made to it being completed.
  async getSupportStatsFulfilmentTime(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    void admin;
    const conds = [
      ...this.statsConditions(query),
      Prisma.sql`s."status" = 'COMPLETED'`,
      Prisma.sql`s."completedAt" IS NOT NULL`,
    ];
    const secs = Prisma.sql`EXTRACT(EPOCH FROM (s."completedAt" - s."createdAt"))`;

    const [row] = await this.prisma.$queryRaw<
      Array<{
        completed: bigint;
        avg: number | null;
        median: number | null;
        p90: number | null;
        min: number | null;
        max: number | null;
      }>
    >(Prisma.sql`
      SELECT COUNT(*) AS completed,
             AVG(${secs}) AS avg,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${secs}) AS median,
             PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ${secs}) AS p90,
             MIN(${secs}) AS min,
             MAX(${secs}) AS max
      FROM "Support" s
      ${this.whereSql(conds)}
    `);

    const hours = (v: number | null | undefined) =>
      v === null || v === undefined ? null : Number((Number(v) / 3600).toFixed(2));
    return {
      completed: this.supportCommonService.num(row?.completed),
      unit: 'hours',
      average: hours(row?.avg),
      median: hours(row?.median),
      p90: hours(row?.p90),
      fastest: hours(row?.min),
      slowest: hours(row?.max),
    };
  }

  // SP-65
  async getSupportStatsCompletionRate(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    const { byStatus, total } = await this.getSupportStatsByStatus(admin, query);
    const completed = byStatus[SupportStatus.COMPLETED];
    const cancelled = byStatus[SupportStatus.CANCELLED];
    const failed = byStatus[SupportStatus.FAILED];
    const closed = completed + cancelled + failed;
    const rate = (n: number) => (closed === 0 ? null : Number((n / closed).toFixed(4)));

    return {
      total,
      open: byStatus[SupportStatus.PENDING] + byStatus[SupportStatus.CONFIRMED],
      closed,
      completed,
      cancelled,
      failed,
      // Shares of the closed offers only, so open ones do not drag the rate down.
      completionRate: rate(completed),
      cancellationRate: rate(cancelled),
      failureRate: rate(failed),
    };
  }

  // SP-66
  async getSupportStatsDisputes(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    void admin;
    const where: Prisma.SupportDisputeWhereInput = { support: this.supportCommonService.buildStatsWhere(query) };

    const [byStatus, byOutcome, byReason, bySide, perMonth] = await Promise.all([
      this.prisma.supportDispute.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.supportDispute.groupBy({
        by: ['outcome'],
        where,
        _count: { _all: true },
        orderBy: { outcome: 'asc' },
      }),
      this.prisma.supportDispute.groupBy({
        by: ['reason'],
        where,
        _count: { _all: true },
        orderBy: { reason: 'asc' },
      }),
      this.prisma.supportDispute.groupBy({
        by: ['side'],
        where,
        _count: { _all: true },
        orderBy: { side: 'asc' },
      }),
      this.prisma.$queryRaw<Array<{ bucket: Date; opened: bigint; resolved: bigint }>>(Prisma.sql`
        SELECT date_trunc('month', d."createdAt") AS bucket,
               COUNT(*) AS opened,
               COUNT(*) FILTER (WHERE d."status" = 'RESOLVED') AS resolved
        FROM "support_dispute" d
        JOIN "Support" s ON s."id" = d."supportId"
        ${this.whereSql(this.statsConditions(query))}
        GROUP BY 1
        ORDER BY 1 ASC
        LIMIT 120
      `),
    ]);

    const toMap = <K extends string>(
      rows: Array<{ _count: unknown } & Record<string, unknown>>,
      key: string,
    ) =>
      Object.fromEntries(
        rows.map((r) => [
          String(r[key] ?? 'UNRESOLVED') as K,
          (r._count as { _all?: number })?._all ?? 0,
        ]),
      ) as Record<K, number>;

    const status = toMap<SupportDisputeStatus>(byStatus, 'status');
    return {
      total: Object.values(status).reduce((a, b) => a + b, 0),
      byStatus: status,
      byOutcome: toMap<SupportDisputeOutcome | 'UNRESOLVED'>(byOutcome, 'outcome'),
      byReason: toMap<SupportDisputeReason>(byReason, 'reason'),
      bySide: toMap<SupportDisputeSide>(bySide, 'side'),
      perMonth: perMonth.map((r) => ({
        bucket: r.bucket,
        opened: this.supportCommonService.num(r.opened),
        resolved: this.supportCommonService.num(r.resolved),
      })),
    };
  }

  // SP-67. Pending offers only; any status filter is ignored because aging only makes sense for PENDING.
  async getSupportStatsAging(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    void admin;
    const base = this.supportCommonService.buildStatsWhere({ ...query, status: undefined });
    const now = Date.now();
    const day = 86_400_000;

    const buckets: Array<{ label: string; fromDays: number; toDays: number | null }> = [
      { label: 'under_1_day', fromDays: 0, toDays: 1 },
      { label: '1_to_3_days', fromDays: 1, toDays: 3 },
      { label: '3_to_7_days', fromDays: 3, toDays: 7 },
      { label: '7_to_14_days', fromDays: 7, toDays: 14 },
      { label: 'over_14_days', fromDays: 14, toDays: null },
    ];

    const [counts, oldest] = await Promise.all([
      Promise.all(
        buckets.map((b) =>
          this.prisma.support.count({
            where: {
              AND: [
                base,
                { status: SupportStatus.PENDING },
                {
                  createdAt: {
                    lte: new Date(now - b.fromDays * day),
                    ...(b.toDays !== null ? { gt: new Date(now - b.toDays * day) } : {}),
                  },
                },
              ],
            },
          }),
        ),
      ),
      this.prisma.support.aggregate({
        where: { AND: [base, { status: SupportStatus.PENDING }] },
        _min: { createdAt: true },
      }),
    ]);

    return {
      totalPending: counts.reduce((a, b) => a + b, 0),
      oldestPendingAt: oldest._min.createdAt,
      buckets: buckets.map((b, i) => ({ bucket: b.label, count: counts[i] })),
    };
  }

  // SP-68. The dashboard in one call.
  async getSupportStatsOverview(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    const where = this.supportCommonService.buildStatsWhere(query);
    const [status, type, completion, aging, fulfilment, disputes, financial, flagged] =
      await Promise.all([
        this.getSupportStatsByStatus(admin, query),
        this.getSupportStatsByType(admin, query),
        this.getSupportStatsCompletionRate(admin, query),
        this.getSupportStatsAging(admin, query),
        this.getSupportStatsFulfilmentTime(admin, query),
        this.getSupportStatsDisputes(admin, query),
        this.prisma.support.aggregate({
          where: {
            AND: [where, { type: SupportType.FINANCIAL, status: { in: COUNTED_STATUSES } }],
          },
          _sum: { recipientAmount: true, amount: true },
        }),
        this.prisma.support.count({ where: { ...where, flags: { some: {} } } }),
      ]);

    return {
      total: status.total,
      byStatus: status.byStatus,
      byType: type.byType,
      completion,
      aging,
      fulfilment,
      disputes: {
        total: disputes.total,
        open: disputes.byStatus[SupportDisputeStatus.OPEN] ?? 0,
        byOutcome: disputes.byOutcome,
      },
      flagged,
      totalConfirmedAmount: Number(financial._sum.recipientAmount ?? financial._sum.amount ?? 0),
    };
  }
}

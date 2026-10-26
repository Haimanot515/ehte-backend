import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, ReportIntegrityFlag, ReportStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { ReportStatsQueryDto, StatsTimelineQueryDto } from '../dto/report.dto';
import { REPORT_TABLE } from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  async getStats() {
    const [
      total,
      statusGrouped,
      categoryGrouped,
      assignedCount,
      unassignedCount,
      escalatedCount,
      resolutionAgg,
      dailyTrend,
    ] = await this.prisma.$transaction([
      this.prisma.report.count(),

      this.prisma.report.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),

      this.prisma.report.groupBy({
        by: ['category'],
        _count: { category: true },
        orderBy: { category: 'asc' },
      }),

      this.prisma.report.count({ where: { assignedToId: { not: null } } }),
      this.prisma.report.count({ where: { assignedToId: null } }),
      this.prisma.report.count({ where: { status: ReportStatus.ESCALATED } }),

      this.prisma.$queryRaw<{ avg_hours: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) / 3600) AS avg_hours
        FROM ${REPORT_TABLE}
        WHERE status = 'CLOSED'
      `,

      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM ${REPORT_TABLE}
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY day
        ORDER BY day ASC
      `,
    ]);

    const byStatus = Object.fromEntries(
      Object.values(ReportStatus).map((status) => [status, 0]),
    ) as Record<ReportStatus, number>;

    for (const row of statusGrouped) {
      const c = row._count as { status?: number } | undefined;
      byStatus[row.status] = c?.status ?? 0;
    }

    const byCategory: Record<string, number> = {};
    for (const row of categoryGrouped) {
      const c = row._count as { category?: number } | undefined;
      byCategory[String(row.category)] = c?.category ?? 0;
    }

    const rejected = byStatus[ReportStatus.REJECTED] ?? 0;
    const closed = byStatus[ReportStatus.CLOSED] ?? 0;

    return {
      total,
      byStatus,
      byCategory,

      assignment: {
        assigned: assignedCount,
        unassigned: unassignedCount,
      },

      escalatedCount,

      rejectionRate: total > 0 ? Number((rejected / total).toFixed(4)) : 0,
      closureRate: total > 0 ? Number((closed / total).toFixed(4)) : 0,

      avgResolutionHours:
        resolutionAgg[0]?.avg_hours != null
          ? Number(Number(resolutionAgg[0].avg_hours).toFixed(2))
          : null,

      dailyTrend: dailyTrend.map((row) => ({
        date: row.day.toISOString().slice(0, 10),
        count: Number(row.count),
      })),
    };
  }

  private round(n: number | null | undefined, digits = 2): number | null {
    return n == null || !Number.isFinite(Number(n)) ? null : Number(Number(n).toFixed(digits));
  }

  // Default window when the caller gives no from/to: last `days` days
  private resolveRange(q: ReportStatsQueryDto, days: number, maxDays = 366) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - days * 86400000);
    if (from.getTime() > to.getTime()) throw new BadRequestException('from_must_be_before_to');
    if ((to.getTime() - from.getTime()) / 86400000 > maxDays) {
      throw new BadRequestException(`range_too_large:max_${maxDays}_days`);
    }
    return { from, to };
  }

  private withRange(q: ReportStatsQueryDto, from: Date, to: Date): ReportStatsQueryDto {
    return { ...q, from: from.toISOString(), to: to.toISOString() };
  }

  // RPT-33 GET /reports/stats/timeline
  async getStatsTimeline(admin: CurrentUserDto, query: StatsTimelineQueryDto) {
    const bucket = query.bucket ?? 'day';
    if (!['day', 'week', 'month'].includes(bucket)) throw new BadRequestException('invalid_bucket');
    const { from, to } = this.resolveRange(query, bucket === 'day' ? 30 : 180);
    const where = this.reportCommonService.statsFilterSql(this.withRange(query, from, to), admin);
    const unit = Prisma.raw(`'${bucket}'`);

    const rows = await this.prisma.$queryRaw<Array<{ bucket: Date; count: number }>>`
      SELECT date_trunc(${unit}, r."createdAt") AS bucket, COUNT(*)::int AS count
      FROM ${REPORT_TABLE} r
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    return {
      bucket,
      from,
      to,
      total: rows.reduce((s, r) => s + r.count, 0),
      items: rows.map((r) => ({ date: r.bucket.toISOString().slice(0, 10), count: r.count })),
    };
  }

  private async periodMetrics(admin: CurrentUserDto, q: ReportStatsQueryDto, from: Date, to: Date) {
    const where = this.reportCommonService.statsFilterSql(this.withRange(q, from, to), admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        total: number;
        closed: number;
        rejected: number;
        escalated: number;
        avg_hours: number | null;
      }>
    >`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE r.status::text = 'CLOSED')::int AS closed,
             COUNT(*) FILTER (WHERE r.status::text = 'REJECTED')::int AS rejected,
             COUNT(*) FILTER (WHERE r.status::text = 'ESCALATED')::int AS escalated,
             AVG(EXTRACT(EPOCH FROM (COALESCE(r."closedAt", r."updatedAt") - r."createdAt")) / 3600)
               FILTER (WHERE r.status::text = 'CLOSED') AS avg_hours
      FROM ${REPORT_TABLE} r
      WHERE ${where}
    `;
    const r = rows[0];
    return {
      total: r?.total ?? 0,
      closed: r?.closed ?? 0,
      rejected: r?.rejected ?? 0,
      escalated: r?.escalated ?? 0,
      avgCloseHours: this.round(r?.avg_hours),
    };
  }

  // RPT-34 GET /reports/stats/compare   (period vs the equal-length period before it)
  async getStatsCompare(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const { from, to } = this.resolveRange(query, 30);
    const span = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - span);

    const [current, previous] = await Promise.all([
      this.periodMetrics(admin, query, from, to),
      this.periodMetrics(admin, query, prevFrom, prevTo),
    ]);

    const delta = (a: number | null, b: number | null) => {
      if (a == null || b == null) return { change: null, changePct: null };
      return {
        change: this.round(a - b),
        changePct: b === 0 ? null : this.round(((a - b) / b) * 100, 1),
      };
    };

    return {
      current: { from, to, ...current },
      previous: { from: prevFrom, to: prevTo, ...previous },
      delta: {
        total: delta(current.total, previous.total),
        closed: delta(current.closed, previous.closed),
        rejected: delta(current.rejected, previous.rejected),
        escalated: delta(current.escalated, previous.escalated),
        avgCloseHours: delta(current.avgCloseHours, previous.avgCloseHours),
      },
    };
  }

  // RPT-35 GET /reports/stats/by-hour   (hour of day x weekday, in REPORT_STATS_TZ)
  async getStatsByHour(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const tz = this.configService.get<string>('REPORT_STATS_TZ') ?? 'Africa/Addis_Ababa';
    const where = this.reportCommonService.statsFilterSql(query, admin);

    const rows = await this.prisma.$queryRaw<Array<{ dow: number; hour: number; count: number }>>`
      SELECT EXTRACT(DOW FROM (r."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::int AS dow,
             EXTRACT(HOUR FROM (r."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::int AS hour,
             COUNT(*)::int AS count
      FROM ${REPORT_TABLE} r
      WHERE ${where}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;

    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    const byWeekday = Array.from({ length: 7 }, (_, d) => ({ weekday: d, count: 0 })); // 0 = Sunday
    for (const r of rows) {
      byHour[r.hour].count += r.count;
      byWeekday[r.dow].count += r.count;
    }
    return { timezone: tz, matrix: rows, byHour, byWeekday };
  }

  // RPT-36 GET /reports/stats/resolution-time
  // Close time falls back to updatedAt for reports closed before closedAt was recorded.
  async getStatsResolutionTime(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.reportCommonService.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        resp_n: number;
        resp_avg: number | null;
        resp_p50: number | null;
        resp_p90: number | null;
        close_n: number;
        close_avg: number | null;
        close_p50: number | null;
        close_p90: number | null;
      }>
    >`
      WITH x AS (
        SELECT EXTRACT(EPOCH FROM (r."firstRespondedAt" - r."createdAt")) / 3600 AS resp_h,
               CASE WHEN r.status::text = 'CLOSED'
                    THEN EXTRACT(EPOCH FROM (COALESCE(r."closedAt", r."updatedAt") - r."createdAt")) / 3600 END AS close_h
        FROM ${REPORT_TABLE} r
        WHERE ${where}
      )
      SELECT COUNT(resp_h)::int AS resp_n,
             AVG(resp_h) AS resp_avg,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY resp_h) AS resp_p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY resp_h) AS resp_p90,
             COUNT(close_h)::int AS close_n,
             AVG(close_h) AS close_avg,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY close_h) AS close_p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY close_h) AS close_p90
      FROM x
    `;
    const r = rows[0];
    return {
      firstResponseHours: {
        samples: r?.resp_n ?? 0,
        avg: this.round(r?.resp_avg),
        median: this.round(r?.resp_p50),
        p90: this.round(r?.resp_p90),
      },
      closeHours: {
        samples: r?.close_n ?? 0,
        avg: this.round(r?.close_avg),
        median: this.round(r?.close_p50),
        p90: this.round(r?.close_p90),
      },
    };
  }

  // RPT-37 GET /reports/stats/backlog   (open reports at the end of each day)
  // from/to bound the chart days; the other filters still narrow which reports count.
  async getStatsBacklog(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const { from, to } = this.resolveRange(query, 30);
    const { from: _f, to: _t, ...rest } = query;
    const where = this.reportCommonService.statsFilterSql(rest, admin);

    const rows = await this.prisma.$queryRaw<Array<{ day: Date; open: number }>>`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', ${from.toISOString()}::timestamp),
          date_trunc('day', ${to.toISOString()}::timestamp),
          interval '1 day'
        ) AS d
      )
      SELECT d AS day,
             (SELECT COUNT(*)::int FROM ${REPORT_TABLE} r
              WHERE ${where}
                AND r."createdAt" < d + interval '1 day'
                AND (r.status::text NOT IN ('CLOSED','REJECTED')
                     OR COALESCE(r."closedAt", r."updatedAt") >= d + interval '1 day')) AS open
      FROM days
      ORDER BY d
    `;
    return {
      from,
      to,
      items: rows.map((r) => ({ date: r.day.toISOString().slice(0, 10), open: r.open })),
    };
  }

  // RPT-38 GET /reports/stats/by-status
  async getStatsByStatus(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    return this.reportCommonService.countBy(admin, query, 'status');
  }

  // RPT-39 GET /reports/stats/by-category
  async getStatsByCategory(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    return this.reportCommonService.countBy(admin, query, 'category');
  }

  // RPT-40 GET /reports/stats/by-channel
  async getStatsByChannel(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    return this.reportCommonService.countBy(admin, query, 'channel');
  }

  // RPT-42 GET /reports/stats/by-priority
  async getStatsByPriority(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    return this.reportCommonService.countBy(admin, query, 'priority');
  }

  // GP-08 GET /reports/stats/by-region
  async getStatsByRegion(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    return this.reportCommonService.countBy(admin, query, 'region');
  }

  // RPT-41 GET /reports/stats/by-admin   (Super Admin)
  async getStatsByAdmin(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.reportCommonService.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        adminId: string;
        total: number;
        open: number;
        closed: number;
        overdue: number;
        avg_hours: number | null;
      }>
    >`
      SELECT r."assignedToId" AS "adminId",
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE r.status::text NOT IN ('CLOSED','REJECTED'))::int AS open,
             COUNT(*) FILTER (WHERE r.status::text = 'CLOSED')::int AS closed,
             COUNT(*) FILTER (WHERE r.status::text NOT IN ('CLOSED','REJECTED')
                                AND r."dueAt" IS NOT NULL AND r."dueAt" < NOW())::int AS overdue,
             AVG(EXTRACT(EPOCH FROM (COALESCE(r."closedAt", r."updatedAt") - r."createdAt")) / 3600)
               FILTER (WHERE r.status::text = 'CLOSED') AS avg_hours
      FROM ${REPORT_TABLE} r
      WHERE ${where} AND r."assignedToId" IS NOT NULL
      GROUP BY 1
      ORDER BY total DESC
    `;

    const users = rows.length
      ? await this.prisma.user.findMany({
          where: { id: { in: rows.map((r) => r.adminId) } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    return {
      items: rows.map((r) => ({
        adminId: r.adminId,
        name: names.get(r.adminId) ?? null,
        total: r.total,
        open: r.open,
        closed: r.closed,
        overdue: r.overdue,
        avgCloseHours: this.round(r.avg_hours),
      })),
    };
  }

  // RPT-44 GET /reports/stats/overview   (the dashboard in one call)
  async getStatsOverview(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.reportCommonService.statsFilterSql(query, admin);

    const [byStatus, byCategory, byPriority, assignment, timeline, resolution, extras] =
      await Promise.all([
        this.reportCommonService.countBy(admin, query, 'status'),
        this.reportCommonService.countBy(admin, query, 'category'),
        this.reportCommonService.countBy(admin, query, 'priority'),
        this.reportCommonService.getStatsAssignment(admin, query),
        this.getStatsTimeline(admin, { ...query, bucket: 'day' }),
        this.getStatsResolutionTime(admin, query),
        this.prisma.$queryRaw<
          Array<{
            open: number;
            overdue: number;
            escalated: number;
            unreadForMe: number;
            closedLast7d: number;
          }>
        >`
          SELECT COUNT(*) FILTER (WHERE r.status::text NOT IN ('CLOSED','REJECTED'))::int AS open,
                 COUNT(*) FILTER (WHERE r.status::text NOT IN ('CLOSED','REJECTED')
                                    AND r."dueAt" IS NOT NULL AND r."dueAt" < NOW())::int AS overdue,
                 COUNT(*) FILTER (WHERE r.status::text = 'ESCALATED')::int AS escalated,
                 COUNT(*) FILTER (WHERE NOT EXISTS (
                   SELECT 1 FROM report_admin_read ar WHERE ar."reportId" = r.id AND ar."adminId" = ${admin.id}
                 ) AND r."archivedAt" IS NULL)::int AS "unreadForMe",
                 COUNT(*) FILTER (WHERE r.status::text = 'CLOSED'
                                    AND COALESCE(r."closedAt", r."updatedAt") >= NOW() - INTERVAL '7 days')::int AS "closedLast7d"
          FROM ${REPORT_TABLE} r
          WHERE ${where}
        `,
      ]);

    const closed = byStatus.items.find((i) => i.key === 'CLOSED')?.count ?? 0;
    const rejected = byStatus.items.find((i) => i.key === 'REJECTED')?.count ?? 0;
    const total = byStatus.total;

    return {
      total,
      open: extras[0]?.open ?? 0,
      overdue: extras[0]?.overdue ?? 0,
      escalated: extras[0]?.escalated ?? 0,
      unreadForMe: extras[0]?.unreadForMe ?? 0,
      closedLast7d: extras[0]?.closedLast7d ?? 0,
      closureRate: total ? this.round(closed / total, 4) : 0,
      rejectionRate: total ? this.round(rejected / total, 4) : 0,
      byStatus: byStatus.items,
      byCategory: byCategory.items,
      byPriority: byPriority.items,
      assignment,
      resolution,
      timeline: timeline.items,
    };
  }

  // RPT-152 GET /reports/stats/aging   (open reports by age bucket)
  async getStatsAging(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.reportCommonService.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<Array<{ bucket: string; count: number }>>`
      SELECT CASE
               WHEN age < INTERVAL '1 day'   THEN '0-1d'
               WHEN age < INTERVAL '3 days'  THEN '1-3d'
               WHEN age < INTERVAL '7 days'  THEN '3-7d'
               WHEN age < INTERVAL '14 days' THEN '7-14d'
               WHEN age < INTERVAL '30 days' THEN '14-30d'
               ELSE '30d+'
             END AS bucket,
             COUNT(*)::int AS count
      FROM (
        SELECT NOW() - r."createdAt" AS age
        FROM ${REPORT_TABLE} r
        WHERE ${where} AND r.status::text NOT IN ('CLOSED','REJECTED')
      ) t
      GROUP BY 1
    `;
    const order = ['0-1d', '1-3d', '3-7d', '7-14d', '14-30d', '30d+'];
    const map = new Map(rows.map((r) => [r.bucket, r.count]));
    return {
      total: rows.reduce((s, r) => s + r.count, 0),
      items: order.map((bucket) => ({ bucket, count: map.get(bucket) ?? 0 })),
    };
  }

  // RPT-153 GET /reports/stats/sla   (within SLA)
  async getStatsSla(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.reportCommonService.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        with_deadline: number;
        met: number;
        breached: number;
        running: number;
        at_risk: number;
      }>
    >`
      SELECT COUNT(*) FILTER (WHERE r."dueAt" IS NOT NULL)::int AS with_deadline,
             COUNT(*) FILTER (WHERE r."dueAt" IS NOT NULL AND r.status::text IN ('CLOSED','REJECTED')
                                AND COALESCE(r."closedAt", r."updatedAt") <= r."dueAt")::int AS met,
             COUNT(*) FILTER (WHERE r."dueAt" IS NOT NULL AND (
                                (r.status::text IN ('CLOSED','REJECTED') AND COALESCE(r."closedAt", r."updatedAt") > r."dueAt")
                             OR (r.status::text NOT IN ('CLOSED','REJECTED') AND r."dueAt" < NOW())))::int AS breached,
             COUNT(*) FILTER (WHERE r."dueAt" IS NOT NULL AND r.status::text NOT IN ('CLOSED','REJECTED')
                                AND r."dueAt" >= NOW())::int AS running,
             COUNT(*) FILTER (WHERE r."dueAt" IS NOT NULL AND r.status::text NOT IN ('CLOSED','REJECTED')
                                AND r."dueAt" >= NOW() AND r."dueAt" < NOW() + INTERVAL '24 hours')::int AS at_risk
      FROM ${REPORT_TABLE} r
      WHERE ${where}
    `;
    const r = rows[0];
    const decided = (r?.met ?? 0) + (r?.breached ?? 0);
    return {
      withDeadline: r?.with_deadline ?? 0,
      met: r?.met ?? 0,
      breached: r?.breached ?? 0,
      running: r?.running ?? 0,
      atRisk24h: r?.at_risk ?? 0,
      complianceRate: decided ? this.round((r?.met ?? 0) / decided, 4) : null,
    };
  }

  // RPT-154 GET /reports/stats/feedback   (satisfaction)
  async getStatsFeedback(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.reportCommonService.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<Array<{ rating: number; count: number }>>`
      SELECT f.rating AS rating, COUNT(*)::int AS count
      FROM report_feedback f
      JOIN ${REPORT_TABLE} r ON r.id = f."reportId"
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1
    `;
    const distribution = [1, 2, 3, 4, 5].map((rating) => ({
      rating,
      count: rows.find((r) => r.rating === rating)?.count ?? 0,
    }));
    const responses = distribution.reduce((s, d) => s + d.count, 0);
    const sum = distribution.reduce((s, d) => s + d.rating * d.count, 0);

    const closedRows = await this.prisma.$queryRaw<Array<{ closed: number }>>`
      SELECT COUNT(*)::int AS closed FROM ${REPORT_TABLE} r
      WHERE ${where} AND r.status::text = 'CLOSED'
    `;
    const closed = closedRows[0]?.closed ?? 0;

    return {
      responses,
      averageRating: responses ? this.round(sum / responses) : null,
      satisfiedShare: responses
        ? this.round((distribution[3].count + distribution[4].count) / responses, 4)
        : null,
      responseRate: closed ? this.round(responses / closed, 4) : null,
      distribution,
    };
  }

  // RPT-155 GET /reports/stats/reopened   (reopen rate)
  async getStatsReopened(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.reportCommonService.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        requests: number;
        reports: number;
        approved: number;
        pending: number;
        denied: number;
        closed: number;
      }>
    >`
      SELECT (SELECT COUNT(*)::int FROM report_reopen_request q JOIN ${REPORT_TABLE} r ON r.id = q."reportId" WHERE ${where}) AS requests,
             (SELECT COUNT(DISTINCT q."reportId")::int FROM report_reopen_request q JOIN ${REPORT_TABLE} r ON r.id = q."reportId" WHERE ${where}) AS reports,
             (SELECT COUNT(*)::int FROM report_reopen_request q JOIN ${REPORT_TABLE} r ON r.id = q."reportId" WHERE ${where} AND q.approved IS TRUE) AS approved,
             (SELECT COUNT(*)::int FROM report_reopen_request q JOIN ${REPORT_TABLE} r ON r.id = q."reportId" WHERE ${where} AND q."handledAt" IS NULL) AS pending,
             (SELECT COUNT(*)::int FROM report_reopen_request q JOIN ${REPORT_TABLE} r ON r.id = q."reportId" WHERE ${where} AND q.approved IS FALSE) AS denied,
             (SELECT COUNT(*)::int FROM ${REPORT_TABLE} r WHERE ${where} AND r.status::text IN ('CLOSED','REJECTED')) AS closed
    `;
    const r = rows[0];
    return {
      requests: r?.requests ?? 0,
      reportsWithRequests: r?.reports ?? 0,
      approved: r?.approved ?? 0,
      denied: r?.denied ?? 0,
      pending: r?.pending ?? 0,
      requestRate: r?.closed ? this.round((r.reports ?? 0) / r.closed, 4) : null,
      approvedReopenRate: r?.closed ? this.round((r.approved ?? 0) / r.closed, 4) : null,
    };
  }

  async getStatsEscalations(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.reportCommonService.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<
      Array<{
        recorded: number;
        de_escalated: number;
        avg_hours: number | null;
        current: number;
        reports: number;
      }>
    >`
      SELECT (SELECT COUNT(*)::int FROM report_escalation e JOIN ${REPORT_TABLE} r ON r.id = e."reportId" WHERE ${where}) AS recorded,
             (SELECT COUNT(*)::int FROM report_escalation e JOIN ${REPORT_TABLE} r ON r.id = e."reportId" WHERE ${where} AND e."deEscalatedAt" IS NOT NULL) AS de_escalated,
             (SELECT AVG(EXTRACT(EPOCH FROM (e."deEscalatedAt" - e."createdAt")) / 3600)
                FROM report_escalation e JOIN ${REPORT_TABLE} r ON r.id = e."reportId"
               WHERE ${where} AND e."deEscalatedAt" IS NOT NULL) AS avg_hours,
             (SELECT COUNT(*)::int FROM ${REPORT_TABLE} r WHERE ${where} AND r.status::text = 'ESCALATED') AS current,
             (SELECT COUNT(*)::int FROM ${REPORT_TABLE} r WHERE ${where}) AS reports
    `;
    const r = rows[0];
    return {
      recorded: r?.recorded ?? 0,
      deEscalated: r?.de_escalated ?? 0,
      avgHoursToDeEscalate: this.round(r?.avg_hours),
      currentlyEscalated: r?.current ?? 0,
      escalatedShare: r?.reports ? this.round((r.current ?? 0) / r.reports, 4) : 0,
    };
  }

  // RPT-157 GET /reports/stats/spam   (spam / false-report rate)
  async getStatsSpam(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.reportCommonService.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<Array<{ flag: string | null; count: number }>>`
      SELECT r."integrityFlag"::text AS flag, COUNT(*)::int AS count
      FROM ${REPORT_TABLE} r
      WHERE ${where}
      GROUP BY 1
    `;
    const total = rows.reduce((s, r) => s + r.count, 0);
    const flagged = rows.filter((r) => r.flag).reduce((s, r) => s + r.count, 0);
    const byFlag: Record<string, number> = {};
    for (const flag of Object.values(ReportIntegrityFlag)) {
      byFlag[flag] = rows.find((r) => r.flag === flag)?.count ?? 0;
    }
    return {
      total,
      flagged,
      flaggedRate: total ? this.round(flagged / total, 4) : 0,
      byFlag,
    };
  }

  // RPT-158 GET /reports/stats/by-tag
  async getStatsByTag(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const where = this.reportCommonService.statsFilterSql(query, admin);
    const rows = await this.prisma.$queryRaw<Array<{ tagId: string; name: string; count: number }>>`
      SELECT t.id AS "tagId", t.name AS name, COUNT(*)::int AS count
      FROM report_tag_on_report x
      JOIN report_tag t ON t.id = x."tagId"
      JOIN ${REPORT_TABLE} r ON r.id = x."reportId"
      WHERE ${where}
      GROUP BY 1, 2
      ORDER BY count DESC, name ASC
      LIMIT 200
    `;
    return { items: rows };
  }
}

import { Injectable } from '@nestjs/common';
import {
  MissingPersonAppealState,
  MissingPersonFlagState,
  MissingPersonStatus,
  MissingPersonType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import {
  MissingPersonStatsInterval,
  MissingPersonStatsQueryDto,
  MissingPersonStatsTimelineQueryDto,
} from '../dto/missing-person.dto';
import { ADMIN_BASE_WHERE } from './missing-person.constants';

@Injectable()
export class MissingPersonStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats() {
    const [
      total,
      statusGrouped,
      typeGrouped,
      claimedCount,
      rewardOfferedCount,
      rewardApprovedCount,
      pendingChildSafetyConfirmation,
      totalInformationSubmissions,
      pendingToApprovedAgg,
      approvedToFoundAgg,
      dailyTrend,
    ] = await this.prisma.$transaction([
      this.prisma.missingPerson.count(),

      this.prisma.missingPerson.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),

      this.prisma.missingPerson.groupBy({
        by: ['personType'],
        _count: { personType: true },
        orderBy: { personType: 'asc' },
      }),

      this.prisma.missingPerson.count({ where: { claimedByUserId: { not: null } } }),
      this.prisma.missingPerson.count({ where: { rewardOffered: true } }),
      this.prisma.missingPerson.count({ where: { rewardApproved: true } }),

      this.prisma.missingPerson.count({
        where: {
          personType: MissingPersonType.CHILD,
          childSafetyFirstConfirmedByUserId: { not: null },
          status: MissingPersonStatus.UNDER_REVIEW,
        },
      }),

      this.prisma.informationSubmission.count(),

      this.prisma.$queryRaw<{ avg_hours: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) / 3600) AS avg_hours
        FROM "MissingPerson"
        WHERE status = 'APPROVED'
      `,

      this.prisma.$queryRaw<{ avg_hours: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) / 3600) AS avg_hours
        FROM "MissingPerson"
        WHERE status = 'FOUND'
      `,

      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "MissingPerson"
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY day
        ORDER BY day ASC
      `,
    ]);

    const byStatus = Object.fromEntries(
      Object.values(MissingPersonStatus).map((status) => [status, 0]),
    ) as Record<MissingPersonStatus, number>;

    for (const row of statusGrouped) {
      const c = row._count as { status?: number } | undefined;
      byStatus[row.status] = c?.status ?? 0;
    }

    const byPersonType = Object.fromEntries(
      Object.values(MissingPersonType).map((type) => [type, 0]),
    ) as Record<MissingPersonType, number>;

    for (const row of typeGrouped) {
      const c = row._count as { personType?: number } | undefined;
      byPersonType[row.personType] = c?.personType ?? 0;
    }

    const rejected = byStatus[MissingPersonStatus.REJECTED] ?? 0;
    const found = byStatus[MissingPersonStatus.FOUND] ?? 0;

    return {
      total,
      byStatus,
      byPersonType,

      claimedCount,
      pendingChildSafetyConfirmation,

      reward: {
        offeredCount: rewardOfferedCount,
        approvedCount: rewardApprovedCount,
      },

      rejectionRate: total > 0 ? Number((rejected / total).toFixed(4)) : 0,
      resolutionRate: total > 0 ? Number((found / total).toFixed(4)) : 0,

      avgApprovalHours:
        pendingToApprovedAgg[0]?.avg_hours != null
          ? Number(Number(pendingToApprovedAgg[0].avg_hours).toFixed(2))
          : null,
      avgTimeToFoundHours:
        approvedToFoundAgg[0]?.avg_hours != null
          ? Number(Number(approvedToFoundAgg[0].avg_hours).toFixed(2))
          : null,

      informationSubmissions: {
        total: totalInformationSubmissions,
        avgPerCase: total > 0 ? Number((totalInformationSubmissions / total).toFixed(2)) : 0,
      },

      dailyTrend: dailyTrend.map((row) => ({
        date: row.day.toISOString().slice(0, 10),
        count: Number(row.count),
      })),
    };
  }

    // Builds the shared WHERE for the stats queries. Table is aliased mp, enum params are cast.
  private statsWhereSql(
    query: MissingPersonStatsQueryDto,
    opts: { skipDates?: boolean } = {},
  ): Prisma.Sql {
    const c: Prisma.Sql[] = [
      Prisma.sql`mp."deletedAt" IS NULL`,
      Prisma.sql`mp."mergedIntoId" IS NULL`,
    ];
    if (!opts.skipDates && query.from)
      c.push(Prisma.sql`mp."createdAt" >= ${new Date(query.from)}`);
    if (!opts.skipDates && query.to) c.push(Prisma.sql`mp."createdAt" <= ${new Date(query.to)}`);
    if (query.status) c.push(Prisma.sql`mp.status = ${query.status}::"MissingPersonStatus"`);
    if (query.area) c.push(Prisma.sql`mp."lastKnownArea" ILIKE ${`%${query.area}%`}`);
    if (query.gender) c.push(Prisma.sql`UPPER(mp.gender) = ${query.gender.toUpperCase()}`);
    if (query.ageGroup) c.push(Prisma.sql`mp."ageGroup" = ${query.ageGroup}`);
    if (query.involvesChild === true)
      c.push(Prisma.sql`mp."personType" = 'CHILD'::"MissingPersonType"`);
    if (query.involvesChild === false)
      c.push(Prisma.sql`mp."personType" <> 'CHILD'::"MissingPersonType"`);
    if (query.assignedTo) c.push(Prisma.sql`mp."assignedToUserId" = ${query.assignedTo}`);
    return Prisma.join(c, ' AND ');
  }

  // Expects an inner query that returns one float8 column named h (hours).
  private async hoursSummary(inner: Prisma.Sql) {
    const rows = await this.prisma.$queryRaw<
      {
        count: number;
        avg: number | null;
        median: number | null;
        p90: number | null;
        min: number | null;
        max: number | null;
      }[]
    >`
      SELECT COUNT(h)::int AS count,
             ROUND(AVG(h)::numeric, 2)::float8 AS avg,
             ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY h))::numeric, 2)::float8 AS median,
             ROUND((percentile_cont(0.9) WITHIN GROUP (ORDER BY h))::numeric, 2)::float8 AS p90,
             ROUND(MIN(h)::numeric, 2)::float8 AS min,
             ROUND(MAX(h)::numeric, 2)::float8 AS max
      FROM (${inner}) t
    `;
    const r = rows[0];
    return {
      count: r?.count ?? 0,
      avgHours: r?.avg ?? null,
      medianHours: r?.median ?? null,
      p90Hours: r?.p90 ?? null,
      minHours: r?.min ?? null,
      maxHours: r?.max ?? null,
    };
  }

  private unitSql(interval: MissingPersonStatsInterval | undefined): Prisma.Sql {
    switch (interval) {
      case MissingPersonStatsInterval.WEEK:
        return Prisma.raw(`'week'`);
      case MissingPersonStatsInterval.MONTH:
        return Prisma.raw(`'month'`);
      default:
        return Prisma.raw(`'day'`);
    }
  }

  async getStatsTimeline(query: MissingPersonStatsTimelineQueryDto) {
    const w = this.statsWhereSql(query);
    const unit = this.unitSql(query.interval);
    const rows = await this.prisma.$queryRaw<{ bucket: Date; count: number }[]>`
      SELECT date_trunc(${unit}, mp."createdAt") AS bucket, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE ${w}
      GROUP BY 1
      ORDER BY 1
    `;
    return {
      interval: query.interval ?? MissingPersonStatsInterval.DAY,
      data: rows.map((r) => ({ period: r.bucket.toISOString().slice(0, 10), count: r.count })),
    };
  }

  async getStatsByStatus(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const rows = await this.prisma.$queryRaw<{ status: string; count: number }[]>`
      SELECT mp.status::text AS status, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE ${w}
      GROUP BY 1
    `;
    const byStatus = Object.fromEntries(
      Object.values(MissingPersonStatus).map((s) => [s, 0]),
    ) as Record<string, number>;
    for (const row of rows) byStatus[row.status] = row.count;
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

    return {
      total,
      data: Object.entries(byStatus).map(([status, count]) => ({
        status,
        count,
        share: total > 0 ? Number((count / total).toFixed(4)) : 0,
      })),
    };
  }

  // Area text is "Area, Region", so the last comma-separated part is treated as the region.
  async getStatsByArea(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const rows = await this.prisma.$queryRaw<{ area: string; count: number }[]>`
      SELECT mp."lastKnownArea" AS area, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE ${w}
      GROUP BY 1
      ORDER BY count DESC
    `;

    const regions = new Map<
      string,
      { total: number; areas: Array<{ area: string; count: number }> }
    >();
    for (const row of rows) {
      const parts = row.area
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const region = parts.length > 1 ? parts[parts.length - 1] : 'Unspecified';
      const area = parts.length > 1 ? parts.slice(0, -1).join(', ') : row.area;
      const entry = regions.get(region) ?? { total: 0, areas: [] };
      entry.total += row.count;
      entry.areas.push({ area, count: row.count });
      regions.set(region, entry);
    }

    return {
      total: rows.reduce((sum, r) => sum + r.count, 0),
      regions: [...regions.entries()]
        .map(([region, v]) => ({ region, ...v }))
        .sort((a, b) => b.total - a.total),
    };
  }

  // Gender and age group are optional columns, cases without them show as UNSPECIFIED.
  async getStatsByDemographics(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const rows = await this.prisma.$queryRaw<
      { personType: string; gender: string; ageGroup: string; count: number }[]
    >`
      SELECT mp."personType"::text AS "personType",
             COALESCE(mp.gender, 'UNSPECIFIED') AS gender,
             COALESCE(mp."ageGroup", 'UNSPECIFIED') AS "ageGroup",
             COUNT(*)::int AS count
      FROM missing_person mp
      WHERE ${w}
      GROUP BY 1, 2, 3
      ORDER BY count DESC
    `;

    const tally = (key: 'personType' | 'gender' | 'ageGroup') => {
      const map: Record<string, number> = {};
      for (const r of rows) map[r[key]] = (map[r[key]] ?? 0) + r.count;
      return map;
    };

    return {
      total: rows.reduce((sum, r) => sum + r.count, 0),
      byPersonType: tally('personType'),
      byGender: tally('gender'),
      byAgeGroup: tally('ageGroup'),
      breakdown: rows,
    };
  }

  // Listing to found, using the FOUND audit event when there is one.
  async getStatsResolutionTime(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    return this.hoursSummary(Prisma.sql`
      SELECT (EXTRACT(EPOCH FROM (
               COALESCE(
                 (SELECT MIN(a."createdAt") FROM audit_log a
                   WHERE a.entity = 'MissingPerson' AND a."entityId" = mp.id
                     AND a.action = ${AuditEventEnum.MISSING_PERSON_FOUND} AND a.outcome = 'SUCCESS'),
                 mp."updatedAt"
               ) - mp."createdAt")) / 3600)::float8 AS h
      FROM missing_person mp
      WHERE ${w} AND mp.status = 'FOUND'
    `);
  }

  // Cases grouped by the month they were created, with how many of them ended up found.
  async getStatsFoundRate(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const rows = await this.prisma.$queryRaw<
      { bucket: Date; created: number; found: number; open: number }[]
    >`
      SELECT date_trunc('month', mp."createdAt") AS bucket,
             COUNT(*)::int AS created,
             COUNT(*) FILTER (WHERE mp.status = 'FOUND')::int AS found,
             COUNT(*) FILTER (WHERE mp.status = 'APPROVED')::int AS open
      FROM missing_person mp
      WHERE ${w}
      GROUP BY 1
      ORDER BY 1
    `;
    return {
      data: rows.map((r) => ({
        period: r.bucket.toISOString().slice(0, 7),
        created: r.created,
        found: r.found,
        stillMissing: r.open,
        foundRate: r.created > 0 ? Number((r.found / r.created).toFixed(4)) : 0,
      })),
    };
  }

  // First review is the first admin audit event after creation, decision is approve or reject.
  async getStatsReviewTime(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const decisionActions = Prisma.join([
      AuditEventEnum.MISSING_PERSON_APPROVED,
      AuditEventEnum.MISSING_PERSON_REJECTED,
    ]);

    const [firstReview, decision] = await Promise.all([
      this.hoursSummary(Prisma.sql`
        SELECT (EXTRACT(EPOCH FROM (x.first_at - x."createdAt")) / 3600)::float8 AS h
        FROM (
          SELECT mp."createdAt",
                 (SELECT MIN(a."createdAt") FROM audit_log a
                   WHERE a.entity = 'MissingPerson' AND a."entityId" = mp.id
                     AND a.outcome = 'SUCCESS'
                     AND a."actorType" IN ('ADMIN', 'SUPER_ADMIN')
                     AND a.action <> ${AuditEventEnum.MISSING_PERSON_CREATED}) AS first_at
          FROM missing_person mp
          WHERE ${w}
        ) x
        WHERE x.first_at IS NOT NULL
      `),
      this.hoursSummary(Prisma.sql`
        SELECT (EXTRACT(EPOCH FROM (x.decided_at - x."createdAt")) / 3600)::float8 AS h
        FROM (
          SELECT mp."createdAt",
                 (SELECT MIN(a."createdAt") FROM audit_log a
                   WHERE a.entity = 'MissingPerson' AND a."entityId" = mp.id
                     AND a.outcome = 'SUCCESS'
                     AND a.action IN (${decisionActions})) AS decided_at
          FROM missing_person mp
          WHERE ${w}
        ) x
        WHERE x.decided_at IS NOT NULL
      `),
    ]);

    return { timeToFirstReview: firstReview, timeToDecision: decision };
  }

  // Daily count of cases still waiting on a first decision. Range defaults to the last 30 days.
  async getStatsBacklog(query: MissingPersonStatsQueryDto) {
    const to = query.to ? new Date(query.to) : new Date();
    const fromDefault = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    let from = query.from ? new Date(query.from) : fromDefault;
    const maxDays = 366;
    if (to.getTime() - from.getTime() > maxDays * 24 * 60 * 60 * 1000) {
      from = new Date(to.getTime() - maxDays * 24 * 60 * 60 * 1000);
    }

    const w = this.statsWhereSql(query, { skipDates: true });
    const decisionActions = Prisma.join([
      AuditEventEnum.MISSING_PERSON_APPROVED,
      AuditEventEnum.MISSING_PERSON_REJECTED,
    ]);

    const rows = await this.prisma.$queryRaw<{ day: Date; count: number }[]>`
      WITH c AS (
        SELECT mp."createdAt",
               COALESCE(
                 (SELECT MIN(a."createdAt") FROM audit_log a
                   WHERE a.entity = 'MissingPerson' AND a."entityId" = mp.id
                     AND a.outcome = 'SUCCESS' AND a.action IN (${decisionActions})),
                 CASE WHEN mp.status NOT IN ('PENDING', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUESTED')
                      THEN mp."updatedAt" END
               ) AS decided_at
        FROM missing_person mp
        WHERE ${w}
      )
      SELECT d::date AS day, COUNT(c."createdAt")::int AS count
      FROM generate_series(
             date_trunc('day', ${from}::timestamp),
             date_trunc('day', ${to}::timestamp),
             interval '1 day'
           ) AS d
      LEFT JOIN c
        ON c."createdAt" < d + interval '1 day'
       AND (c.decided_at IS NULL OR c.decided_at >= d + interval '1 day')
      GROUP BY d
      ORDER BY d
    `;

    return {
      data: rows.map((r) => ({ date: r.day.toISOString().slice(0, 10), pending: r.count })),
    };
  }

  async getStatsAging(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const rows = await this.prisma.$queryRaw<{ createdAt: Date }[]>`
      SELECT mp."createdAt" AS "createdAt"
      FROM missing_person mp
      WHERE ${w} AND mp.status IN ('PENDING', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUESTED')
    `;

    const buckets = [
      { label: '0-24h', maxHours: 24, count: 0 },
      { label: '1-3d', maxHours: 72, count: 0 },
      { label: '3-7d', maxHours: 168, count: 0 },
      { label: '7-14d', maxHours: 336, count: 0 },
      { label: '14d+', maxHours: Infinity, count: 0 },
    ];
    const now = Date.now();
    for (const row of rows) {
      const hours = (now - row.createdAt.getTime()) / (60 * 60 * 1000);
      const bucket = buckets.find((b) => hours < b.maxHours);
      if (bucket) bucket.count += 1;
    }

    return {
      total: rows.length,
      data: buckets.map(({ label, count }) => ({ bucket: label, count })),
    };
  }

  async getStatsTips(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);

    const [totals, firstTip] = await Promise.all([
      this.prisma.$queryRaw<{ cases: number; casesWithTips: number; tips: number }[]>`
        SELECT COUNT(DISTINCT mp.id)::int AS cases,
               COUNT(DISTINCT mp.id) FILTER (WHERE i.id IS NOT NULL)::int AS "casesWithTips",
               COUNT(i.id)::int AS tips
        FROM missing_person mp
        LEFT JOIN information_submission i ON i."missingPersonId" = mp.id
        WHERE ${w}
      `,
      this.hoursSummary(Prisma.sql`
        SELECT (EXTRACT(EPOCH FROM (MIN(i."createdAt") - mp."createdAt")) / 3600)::float8 AS h
        FROM missing_person mp
        JOIN information_submission i ON i."missingPersonId" = mp.id
        WHERE ${w}
        GROUP BY mp.id, mp."createdAt"
      `),
    ]);

    const t = totals[0] ?? { cases: 0, casesWithTips: 0, tips: 0 };
    return {
      cases: t.cases,
      casesWithTips: t.casesWithTips,
      totalTips: t.tips,
      avgTipsPerCase: t.cases > 0 ? Number((t.tips / t.cases).toFixed(2)) : 0,
      timeToFirstTip: firstTip,
    };
  }

  // Decisions come from audit rows. Open workload counts cases assigned and still in the backlog.
  async getStatsByAdmin(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const decisionActions = Prisma.join([
      AuditEventEnum.MISSING_PERSON_APPROVED,
      AuditEventEnum.MISSING_PERSON_REJECTED,
      AuditEventEnum.MISSING_PERSON_MORE_INFO_REQUESTED,
      AuditEventEnum.MISSING_PERSON_FOUND,
    ]);

    const [decisions, workload] = await Promise.all([
      this.prisma.$queryRaw<
        {
          adminId: string;
          decisions: number;
          approved: number;
          rejected: number;
          avgHours: number | null;
        }[]
      >`
        SELECT a."userId" AS "adminId",
               COUNT(*)::int AS decisions,
               COUNT(*) FILTER (WHERE a.action = ${AuditEventEnum.MISSING_PERSON_APPROVED})::int AS approved,
               COUNT(*) FILTER (WHERE a.action = ${AuditEventEnum.MISSING_PERSON_REJECTED})::int AS rejected,
               ROUND(AVG(EXTRACT(EPOCH FROM (a."createdAt" - mp."createdAt")) / 3600)::numeric, 2)::float8 AS "avgHours"
        FROM audit_log a
        JOIN missing_person mp ON mp.id = a."entityId"
        WHERE a.entity = 'MissingPerson' AND a.outcome = 'SUCCESS' AND a."userId" IS NOT NULL
          AND a.action IN (${decisionActions}) AND ${w}
        GROUP BY a."userId"
        ORDER BY decisions DESC
      `,
      this.prisma.$queryRaw<{ adminId: string; open: number }[]>`
        SELECT mp."assignedToUserId" AS "adminId", COUNT(*)::int AS open
        FROM missing_person mp
        WHERE ${w} AND mp."assignedToUserId" IS NOT NULL
          AND mp.status IN ('PENDING', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUESTED')
        GROUP BY 1
      `,
    ]);

    const ids = [
      ...new Set([...decisions.map((d) => d.adminId), ...workload.map((x) => x.adminId)]),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const openOf = new Map(workload.map((x) => [x.adminId, x.open]));
    const decisionOf = new Map(decisions.map((d) => [d.adminId, d]));

    return {
      data: ids
        .map((adminId) => {
          const d = decisionOf.get(adminId);
          return {
            adminId,
            adminName: nameOf.get(adminId) ?? null,
            openAssigned: openOf.get(adminId) ?? 0,
            decisions: d?.decisions ?? 0,
            approved: d?.approved ?? 0,
            rejected: d?.rejected ?? 0,
            avgHoursToDecision: d?.avgHours ?? null,
          };
        })
        .sort((a, b) => b.decisions - a.decisions),
    };
  }

  // Everything the dashboard home needs in one round trip.
  async getStatsOverview(query: MissingPersonStatsQueryDto) {
    const [
      byStatus,
      aging,
      reviewTime,
      resolutionTime,
      tips,
      openFlags,
      pendingAppeals,
      pendingFoundClaims,
      legalHolds,
      timeline,
    ] = await Promise.all([
      this.getStatsByStatus(query),
      this.getStatsAging(query),
      this.getStatsReviewTime(query),
      this.getStatsResolutionTime(query),
      this.getStatsTips(query),
      this.prisma.missingPersonFlag.count({ where: { status: MissingPersonFlagState.OPEN } }),
      this.prisma.missingPersonAppeal.count({
        where: { status: MissingPersonAppealState.PENDING },
      }),
      this.prisma.missingPerson.count({
        where: {
          ...ADMIN_BASE_WHERE,
          status: MissingPersonStatus.APPROVED,
          foundReportedAt: { not: null },
          foundReportResolvedAt: null,
        },
      }),
      this.prisma.missingPerson.count({ where: { legalHold: true } }),
      this.getStatsTimeline({ ...query, interval: MissingPersonStatsInterval.DAY }),
    ]);

    const count = (s: MissingPersonStatus) => byStatus.data.find((r) => r.status === s)?.count ?? 0;

    return {
      total: byStatus.total,
      active: count(MissingPersonStatus.APPROVED),
      found: count(MissingPersonStatus.FOUND),
      backlog: aging.total,
      byStatus: byStatus.data,
      aging: aging.data,
      reviewTime,
      resolutionTime,
      tips,
      queues: { openFlags, pendingAppeals, pendingFoundClaims, legalHolds },
      timeline: timeline.data,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { InformationStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import {
  InformationStatsInterval,
  InformationStatsQueryDto,
  InformationStatsTimelineQueryDto,
} from '../dto/information-submission.dto';
import { OPEN_STATUSES } from './information-submission.constants';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

  // Admin dashboard stats: totals by status.
  async getStats() {
    const [total, byStatus] = await this.prisma.$transaction([
      this.prisma.informationSubmission.count({ where: { deletedAt: null } }), // NEW (soft delete)
      this.prisma.informationSubmission.groupBy({
        by: ['status'],
        where: { deletedAt: null }, // NEW (soft delete)
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(InformationStatus).map((status) => [status, 0]),
    ) as Record<InformationStatus, number>;

    for (const row of byStatus) {
      const rowCount = row._count as { status?: number } | undefined;
      statusCounts[row.status] = rowCount?.status ?? 0;
    }

    return {
      total,
      pending: statusCounts[InformationStatus.PENDING] ?? 0,
      underReview: statusCounts[InformationStatus.UNDER_REVIEW] ?? 0,
      reviewed: statusCounts[InformationStatus.REVIEWED] ?? 0,
      rejected: statusCounts[InformationStatus.REJECTED] ?? 0,
    };
  }

  private statsWhere(q: InformationStatsQueryDto): Prisma.InformationSubmissionWhereInput {
    return {
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.missingPersonId ? { missingPersonId: q.missingPersonId } : {}),
      ...(q.assignedTo ? { assignedToId: q.assignedTo } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
  }

  // Same filters as raw SQL conditions on alias `s`.
  private statsSql(q: InformationStatsQueryDto, opts: { dates?: boolean; status?: boolean } = {}) {
    const dates = opts.dates ?? true;
    const status = opts.status ?? true;
    const conds: Prisma.Sql[] = [Prisma.sql`s."deletedAt" IS NULL`];
    if (status && q.status) conds.push(Prisma.sql`s.status = ${q.status}::"InformationStatus"`);
    if (q.missingPersonId) conds.push(Prisma.sql`s."missingPersonId" = ${q.missingPersonId}`);
    if (q.assignedTo) conds.push(Prisma.sql`s."assignedToId" = ${q.assignedTo}`);
    if (dates && q.from) conds.push(Prisma.sql`s."createdAt" >= ${new Date(q.from)}`);
    if (dates && q.to) conds.push(Prisma.sql`s."createdAt" <= ${new Date(q.to)}`);
    return Prisma.join(conds, ' AND ');
  }

  private auditActionList(actions: AuditEventEnum[]) {
    return Prisma.join(actions.map((a) => a as string));
  }

  private round(n: number | null | undefined, digits = 1): number | null {
    return n === null || n === undefined
      ? null
      : Math.round(Number(n) * 10 ** digits) / 10 ** digits;
  }

  async getStatsTimeline(query: InformationStatsTimelineQueryDto) {
    const interval = Object.values(InformationStatsInterval).includes(
      query.interval as InformationStatsInterval,
    )
      ? (query.interval as string)
      : 'day';

    const rows = await this.prisma.$queryRaw<
      Array<{ bucket: Date; total: number; reviewed: number; rejected: number }>
    >(Prisma.sql`
      SELECT date_trunc(${interval}::text, s."createdAt") AS bucket,
             COUNT(*)::int AS total,
             (COUNT(*) FILTER (WHERE s.status = 'REVIEWED'))::int AS reviewed,
             (COUNT(*) FILTER (WHERE s.status = 'REJECTED'))::int AS rejected
      FROM information_submission s
      WHERE ${this.statsSql(query)}
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    return { interval, data: rows };
  }

  async getStatsByStatus(query: InformationStatsQueryDto) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['status'],
      where: this.statsWhere(query),
      _count: { _all: true },
    });

    const counts = Object.fromEntries(
      Object.values(InformationStatus).map((s) => [s, 0]),
    ) as Record<InformationStatus, number>;
    for (const row of rows) counts[row.status] = row._count._all;

    return { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts };
  }

  async getStatsByCase(query: InformationStatsQueryDto) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['missingPersonId'],
      where: this.statsWhere(query),
      _count: { _all: true },
      orderBy: { _count: { missingPersonId: 'desc' } },
      take: 50,
    });

    const cases = await this.informationSubmissionCommonService.caseNameMap(rows.map((r) => r.missingPersonId));

    return rows.map((r) => ({
      missingPersonId: r.missingPersonId,
      name: cases.get(r.missingPersonId)?.name ?? null,
      total: r._count._all,
    }));
  }

  async getStatsReviewTime(query: InformationStatsQueryDto) {
    const reviewActions = this.auditActionList([AuditEventEnum.INFORMATION_UNDER_REVIEW]);
    const decisionActions = this.auditActionList([
      AuditEventEnum.INFORMATION_REVIEWED,
      AuditEventEnum.INFORMATION_REJECTED,
    ]);

    const [row] = await this.prisma.$queryRaw<
      Array<{
        firstReviewCount: number;
        decidedCount: number;
        avgFirstReview: number | null;
        medianFirstReview: number | null;
        p90FirstReview: number | null;
        avgDecision: number | null;
        medianDecision: number | null;
        p90Decision: number | null;
      }>
    >(Prisma.sql`
      WITH t AS (
        SELECT s."createdAt",
          (SELECT MIN(a."createdAt") FROM audit_log a
            WHERE a.entity = 'InformationSubmission' AND a."entityId" = s.id
              AND a.outcome = 'SUCCESS' AND a.action IN (${reviewActions})) AS first_review_at,
          (SELECT MIN(a."createdAt") FROM audit_log a
            WHERE a.entity = 'InformationSubmission' AND a."entityId" = s.id
              AND a.outcome = 'SUCCESS' AND a.action IN (${decisionActions})) AS decided_at
        FROM information_submission s
        WHERE ${this.statsSql(query)}
      ),
      h AS (
        SELECT EXTRACT(EPOCH FROM (first_review_at - "createdAt")) / 3600 AS first_h,
               EXTRACT(EPOCH FROM (decided_at - "createdAt")) / 3600 AS decision_h
        FROM t
      )
      SELECT COUNT(first_h)::int AS "firstReviewCount",
             COUNT(decision_h)::int AS "decidedCount",
             AVG(first_h)::float AS "avgFirstReview",
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY first_h))::float AS "medianFirstReview",
             (percentile_cont(0.9) WITHIN GROUP (ORDER BY first_h))::float AS "p90FirstReview",
             AVG(decision_h)::float AS "avgDecision",
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY decision_h))::float AS "medianDecision",
             (percentile_cont(0.9) WITHIN GROUP (ORDER BY decision_h))::float AS "p90Decision"
      FROM h
    `);

    return {
      unit: 'hours',
      timeToFirstReview: {
        count: row?.firstReviewCount ?? 0,
        average: this.round(row?.avgFirstReview),
        median: this.round(row?.medianFirstReview),
        p90: this.round(row?.p90FirstReview),
      },
      timeToDecision: {
        count: row?.decidedCount ?? 0,
        average: this.round(row?.avgDecision),
        median: this.round(row?.medianDecision),
        p90: this.round(row?.p90Decision),
      },
    };
  }

  // Open tips at the end of each day. Range defaults to the last 30 days, max 180.
  // The status/date filters are ignored here (they'd contradict "open on that day").
  async getStatsBacklog(query: InformationStatsQueryDto) {
    const to = query.to ? new Date(query.to) : new Date();
    let from = query.from ? new Date(query.from) : new Date(to.getTime() - 29 * 86_400_000);
    const maxMs = 179 * 86_400_000;
    if (to.getTime() - from.getTime() > maxMs) from = new Date(to.getTime() - maxMs);

    const decisionActions = this.auditActionList([
      AuditEventEnum.INFORMATION_REVIEWED,
      AuditEventEnum.INFORMATION_REJECTED,
    ]);

    const rows = await this.prisma.$queryRaw<Array<{ day: Date; open: number }>>(Prisma.sql`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', ${from}::timestamp),
          date_trunc('day', ${to}::timestamp),
          interval '1 day'
        ) AS day
      ),
      t AS (
        SELECT s.id, s."createdAt",
          (SELECT MIN(a."createdAt") FROM audit_log a
            WHERE a.entity = 'InformationSubmission' AND a."entityId" = s.id
              AND a.outcome = 'SUCCESS' AND a.action IN (${decisionActions})) AS decided_at
        FROM information_submission s
        WHERE ${this.statsSql(query, { dates: false, status: false })}
      )
      SELECT d.day, COUNT(t.id)::int AS open
      FROM days d
      LEFT JOIN t
        ON t."createdAt" < d.day + interval '1 day'
       AND (t.decided_at IS NULL OR t.decided_at >= d.day + interval '1 day')
      GROUP BY d.day
      ORDER BY d.day ASC
    `);

    return { from, to, data: rows };
  }

  async getStatsAging(query: InformationStatsQueryDto) {
    const base = this.statsWhere({ ...query, status: undefined, from: undefined, to: undefined });
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * 86_400_000);

    const bucket = (gte?: Date, lt?: Date) =>
      this.prisma.informationSubmission.count({
        where: {
          ...base,
          status: { in: OPEN_STATUSES },
          createdAt: { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) },
        },
      });

    const [under1d, d1to3, d3to7, d7to14, over14d] = await Promise.all([
      bucket(ago(1)),
      bucket(ago(3), ago(1)),
      bucket(ago(7), ago(3)),
      bucket(ago(14), ago(7)),
      bucket(undefined, ago(14)),
    ]);

    return {
      totalOpen: under1d + d1to3 + d3to7 + d7to14 + over14d,
      buckets: [
        { label: '<1d', count: under1d },
        { label: '1-3d', count: d1to3 },
        { label: '3-7d', count: d3to7 },
        { label: '7-14d', count: d7to14 },
        { label: '14d+', count: over14d },
      ],
    };
  }

  async getStatsUsefulness(query: InformationStatsQueryDto) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['status', 'resolution'],
      where: this.statsWhere(query),
      _count: { _all: true },
    });

    let useful = 0;
    let duplicate = 0;
    let alreadyKnown = 0;
    let rejectedOther = 0;
    let open = 0;

    for (const r of rows) {
      const n = r._count._all;
      if (r.status === InformationStatus.REVIEWED) useful += n;
      else if (r.status === InformationStatus.REJECTED) {
        if (r.resolution === 'DUPLICATE') duplicate += n;
        else if (r.resolution === 'ALREADY_KNOWN') alreadyKnown += n;
        else rejectedOther += n;
      } else open += n;
    }

    const decided = useful + duplicate + alreadyKnown + rejectedOther;
    const share = (n: number) => (decided ? this.round(n / decided, 3) : null);

    return {
      decided,
      open,
      useful: { count: useful, share: share(useful) },
      duplicate: { count: duplicate, share: share(duplicate) },
      alreadyKnown: { count: alreadyKnown, share: share(alreadyKnown) },
      rejectedOther: { count: rejectedOther, share: share(rejectedOther) },
    };
  }

  // Questions asked in the period: how many were answered and how fast (hours).
  async getStatsResponseTime(query: InformationStatsQueryDto) {
    const submissionWhere = this.statsWhere({
      ...query,
      status: undefined,
      from: undefined,
      to: undefined,
    });

    const questions = await this.prisma.informationQuestion.findMany({
      where: {
        submission: submissionWhere,
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      select: { createdAt: true, answeredAt: true },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
    });

    const hours = questions
      .filter((q) => q.answeredAt)
      .map((q) => (q.answeredAt!.getTime() - q.createdAt.getTime()) / 3_600_000)
      .sort((a, b) => a - b);

    const pick = (p: number) =>
      hours.length ? hours[Math.min(hours.length - 1, Math.floor(p * hours.length))] : null;

    return {
      unit: 'hours',
      asked: questions.length,
      answered: hours.length,
      open: questions.length - hours.length,
      answerRate: questions.length ? this.round(hours.length / questions.length, 3) : null,
      average: hours.length ? this.round(hours.reduce((a, b) => a + b, 0) / hours.length) : null,
      median: this.round(pick(0.5)),
      p90: this.round(pick(0.9)),
      sampleCapped: questions.length === 10_000,
    };
  }

  // Per reviewer: decisions made in the period and how long those tips waited, plus their
  // currently open assigned tips.
  async getStatsByAdmin(query: InformationStatsQueryDto) {
    const reviewed = AuditEventEnum.INFORMATION_REVIEWED as string;
    const rejected = AuditEventEnum.INFORMATION_REJECTED as string;

    const rows = await this.prisma.$queryRaw<
      Array<{
        adminId: string;
        reviewed: number;
        rejected: number;
        avgHoursToDecision: number | null;
      }>
    >(Prisma.sql`
      SELECT a."userId" AS "adminId",
             (COUNT(*) FILTER (WHERE a.action = ${reviewed}))::int AS reviewed,
             (COUNT(*) FILTER (WHERE a.action = ${rejected}))::int AS rejected,
             AVG(EXTRACT(EPOCH FROM (a."createdAt" - s."createdAt")) / 3600)::float AS "avgHoursToDecision"
      FROM audit_log a
      JOIN information_submission s ON s.id = a."entityId"
      WHERE a.entity = 'InformationSubmission'
        AND a.outcome = 'SUCCESS'
        AND a.action IN (${reviewed}, ${rejected})
        AND a."userId" IS NOT NULL
        ${query.from ? Prisma.sql`AND a."createdAt" >= ${new Date(query.from)}` : Prisma.empty}
        ${query.to ? Prisma.sql`AND a."createdAt" <= ${new Date(query.to)}` : Prisma.empty}
        ${query.missingPersonId ? Prisma.sql`AND s."missingPersonId" = ${query.missingPersonId}` : Prisma.empty}
      GROUP BY a."userId"
    `);

    const open = await this.prisma.informationSubmission.groupBy({
      by: ['assignedToId'],
      where: { deletedAt: null, assignedToId: { not: null }, status: { in: OPEN_STATUSES } },
      _count: { _all: true },
    });
    const openMap = new Map(open.map((o) => [o.assignedToId as string, o._count._all]));

    const adminIds = [...new Set([...rows.map((r) => r.adminId), ...openMap.keys()])];
    const names = await this.informationSubmissionCommonService.userNameMap(adminIds);

    return adminIds
      .map((adminId) => {
        const r = rows.find((x) => x.adminId === adminId);
        return {
          adminId,
          name: names.get(adminId) ?? null,
          reviewed: r?.reviewed ?? 0,
          rejected: r?.rejected ?? 0,
          decisions: (r?.reviewed ?? 0) + (r?.rejected ?? 0),
          avgHoursToDecision: this.round(r?.avgHoursToDecision),
          openAssigned: openMap.get(adminId) ?? 0,
        };
      })
      .sort((a, b) => b.decisions - a.decisions);
  }

  // One call for the dashboard. Reuses the endpoints above plus a few quick counts.
  async getStatsOverview(query: InformationStatsQueryDto) {
    const base = this.statsWhere({ ...query, status: undefined });

    const [
      totals,
      aging,
      usefulness,
      reviewTime,
      unassignedOpen,
      urgentOpen,
      openQuestions,
      pendingAppeals,
    ] = await Promise.all([
      this.getStats(),
      this.getStatsAging(query),
      this.getStatsUsefulness(query),
      this.getStatsReviewTime(query),
      this.prisma.informationSubmission.count({
        where: { ...base, assignedToId: null, status: { in: OPEN_STATUSES } },
      }),
      this.prisma.informationSubmission.count({
        where: { ...base, priority: 'URGENT', status: { in: OPEN_STATUSES } },
      }),
      this.prisma.informationQuestion.count({
        where: { answeredAt: null, submission: { deletedAt: null } },
      }),
      this.prisma.informationAppeal.count({ where: { status: 'PENDING' } }),
    ]);

    return {
      totals,
      aging,
      usefulness,
      reviewTime,
      attention: { unassignedOpen, urgentOpen, openQuestions, pendingAppeals },
    };
  }
}

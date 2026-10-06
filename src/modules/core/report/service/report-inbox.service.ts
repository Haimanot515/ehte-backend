import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReportCategory, ReportStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import {
  ReportCountsQueryDto,
  UnreadReportsQueryDto,
  ByUserQueryDto,
  UserReportsQueryDto,
  RepeatReportersQueryDto,
  ReadAllReportsDto,
} from '../dto/report.dto';
import { ANON_KEY_PREFIX } from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  // Public so the controller / existing list routes can add `isRead` (small change #3)
  async attachIsRead<T extends { id: string }>(
    adminId: string,
    items: T[],
  ): Promise<Array<T & { isRead: boolean }>> {
    if (!items.length) return [];
    const reads = await this.prisma.reportAdminRead.findMany({
      where: { adminId, reportId: { in: items.map((i) => i.id) } },
      select: { reportId: true },
    });
    const readIds = new Set(reads.map((r) => r.reportId));
    return items.map((i) => ({ ...i, isRead: readIds.has(i.id) }));
  }

  private unreadFilter(adminId: string): Prisma.ReportWhereInput {
    return { adminReads: { none: { adminId } } };
  }

  // Normal inbox scope: not deleted, not archived
  private inboxWhere(extra: Prisma.ReportWhereInput = {}): Prisma.ReportWhereInput {
    return { AND: [{ deletedAt: null, archivedAt: null }, extra] };
  }

  private async markManyRead(adminId: string, reportIds: string[]): Promise<number> {
    let marked = 0;
    for (let i = 0; i < reportIds.length; i += 1000) {
      const chunk = reportIds.slice(i, i + 1000);
      const res = await this.prisma.reportAdminRead.createMany({
        data: chunk.map((reportId) => ({ reportId, adminId })),
        skipDuplicates: true,
      });
      marked += res.count;
    }
    return marked;
  }

  // RPT-14 PATCH /reports/:id/read
  async markRead(admin: CurrentUserDto, reportId: string) {
    await this.reportCommonService.loadForAdmin(admin, reportId);
    await this.prisma.reportAdminRead.upsert({
      where: { reportId_adminId: { reportId, adminId: admin.id } },
      create: { reportId, adminId: admin.id },
      update: {},
    });
    return { id: reportId, isRead: true };
  }

  // RPT-15 PATCH /reports/:id/unread
  async markUnread(admin: CurrentUserDto, reportId: string) {
    await this.reportCommonService.loadForAdmin(admin, reportId);
    await this.prisma.reportAdminRead.deleteMany({ where: { reportId, adminId: admin.id } });
    return { id: reportId, isRead: false };
  }

  // RPT-16 PATCH /reports/bulk/read
  async bulkMarkRead(admin: CurrentUserDto, ids: string[]) {
    const unique = [...new Set(ids)];
    const visible = await this.prisma.report.findMany({
      where: { AND: [{ id: { in: unique }, deletedAt: null }, this.reportCommonService.visibilityWhere(admin)] },
      select: { id: true },
    });
    const visibleIds = visible.map((r) => r.id);
    await this.markManyRead(admin.id, visibleIds);
    const visibleSet = new Set(visibleIds);
    return {
      requested: unique.length,
      updated: visibleIds.length,
      notFound: unique.filter((id) => !visibleSet.has(id)),
    };
  }

  // RPT-17 PATCH /reports/bulk/unread
  async bulkMarkUnread(admin: CurrentUserDto, ids: string[]) {
    const unique = [...new Set(ids)];
    const res = await this.prisma.reportAdminRead.deleteMany({
      where: {
        adminId: admin.id,
        reportId: { in: unique },
        report: { AND: [{ deletedAt: null }, this.reportCommonService.visibilityWhere(admin)] },
      },
    });
    return { requested: unique.length, updated: res.count };
  }

  // RPT-18 PATCH /reports/read-all  (everything matching the filter that is still unread)
  async readAll(admin: CurrentUserDto, dto: ReadAllReportsDto) {
    const where = this.inboxWhere({
      ...this.unreadFilter(admin.id),
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.category ? { category: dto.category } : {}),
      ...(dto.assignedTo ? { assignedToId: dto.assignedTo } : {}),
    });
    const rows = await this.prisma.report.findMany({
      where: { AND: [where, this.reportCommonService.visibilityWhere(admin)] },
      select: { id: true },
      take: 20000,
    });
    const marked = await this.markManyRead(
      admin.id,
      rows.map((r) => r.id),
    );
    return { marked };
  }

  // RPT-19 GET /reports/unread
  async listUnread(admin: CurrentUserDto, query: UnreadReportsQueryDto) {
    return this.reportCommonService.pagedReports(
      admin,
      this.inboxWhere({
        ...this.unreadFilter(admin.id),
        ...(query.status ? { status: query.status } : {}),
        ...(query.category ? { category: query.category } : {}),
      }),
      query,
    );
  }

  // RPT-20 GET /reports/unread/count
  async countUnread(admin: CurrentUserDto) {
    const count = await this.prisma.report.count({
      where: {
        AND: [this.inboxWhere(this.unreadFilter(admin.id)), this.reportCommonService.visibilityWhere(admin)],
      },
    });
    return { count };
  }

  // RPT-21 GET /reports/unread/count/by-status
  async countUnreadByStatus(admin: CurrentUserDto) {
    const grouped = await this.prisma.report.groupBy({
      by: ['status'],
      where: { AND: [this.inboxWhere(this.unreadFilter(admin.id)), this.reportCommonService.visibilityWhere(admin)] },
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });
    const byStatus = Object.fromEntries(Object.values(ReportStatus).map((s) => [s, 0])) as Record<
      ReportStatus,
      number
    >;
    let total = 0;
    for (const row of grouped) {
      const c = (row._count as { _all?: number } | undefined)?._all ?? 0;
      byStatus[row.status] = c;
      total += c;
    }
    return { total, byStatus };
  }

  // RPT-22 GET /reports/unread/count/by-category
  async countUnreadByCategory(admin: CurrentUserDto) {
    const grouped = await this.prisma.report.groupBy({
      by: ['category'],
      where: { AND: [this.inboxWhere(this.unreadFilter(admin.id)), this.reportCommonService.visibilityWhere(admin)] },
      _count: { _all: true },
      orderBy: { category: 'asc' },
    });
    const byCategory = Object.fromEntries(
      Object.values(ReportCategory).map((c) => [c, 0]),
    ) as Record<ReportCategory, number>;
    let total = 0;
    for (const row of grouped) {
      const c = (row._count as { _all?: number } | undefined)?._all ?? 0;
      byCategory[row.category] = c;
      total += c;
    }
    return { total, byCategory };
  }

  // RPT-159 GET /reports/counts   total / read / unread for this admin
  async getCounts(admin: CurrentUserDto, query: ReportCountsQueryDto) {
    const filter: Prisma.ReportWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.assignedTo ? { assignedToId: query.assignedTo } : {}),
    };
    const base = this.inboxWhere(filter);
    const vis = this.reportCommonService.visibilityWhere(admin);

    const [total, unread] = await Promise.all([
      this.prisma.report.count({ where: { AND: [base, vis] } }),
      this.prisma.report.count({ where: { AND: [base, vis, this.unreadFilter(admin.id)] } }),
    ]);
    return { total, read: total - unread, unread };
  }

  private async resolveUserScope(key: string): Promise<{ userId: string; isAnonymous: boolean }> {
    if (key.startsWith(ANON_KEY_PREFIX)) {
      const rows = await this.prisma.report.findMany({
        where: { isAnonymous: true, userId: { not: null } },
        distinct: ['userId'],
        select: { userId: true },
      });
      const hit = rows.find((r) => r.userId && this.reportCommonService.maskUserId(r.userId) === key);
      if (!hit?.userId) throw new NotFoundException('reporter_not_found');
      return { userId: hit.userId, isAnonymous: true };
    }
    return { userId: key, isAnonymous: false };
  }

  private scopeWhere(scope: { userId: string; isAnonymous: boolean }): Prisma.ReportWhereInput {
    return { userId: scope.userId, isAnonymous: scope.isAnonymous, deletedAt: null };
  }

  private auditReporterView(
    admin: CurrentUserDto,
    view: string,
    scope?: { userId: string; isAnonymous: boolean },
    extra: Record<string, unknown> = {},
  ): void {
    this.reportCommonService.emitAudit({
      userId: admin.id,
      // Never write the real id of an anonymous reporter into the audit target
      ...(scope && !scope.isAnonymous ? { targetUserId: scope.userId } : {}),
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: AuditEventEnum.REPORTER_INFORMATION_OPENED,
      entity: 'Report',
      entityId: `by-user:${view}`,
      diff: { result: 'success', view, anonymousGroup: scope?.isAnonymous ?? null, ...extra },
    });
  }

  // One row per (reporter | masked anonymous reporter) with total / read / unread
  private async buildUserRows(admin: CurrentUserDto) {
    const base: Prisma.ReportWhereInput = {
      AND: [{ deletedAt: null, userId: { not: null } }, this.reportCommonService.visibilityWhere(admin)],
    };

    const [totals, unreads] = await Promise.all([
      this.prisma.report.groupBy({
        by: ['userId', 'isAnonymous'],
        where: base,
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { userId: 'asc' },
      }),
      this.prisma.report.groupBy({
        by: ['userId', 'isAnonymous'],
        where: { AND: [base, this.unreadFilter(admin.id)] },
        _count: { _all: true },
        orderBy: { userId: 'asc' },
      }),
    ]);

    const unreadMap = new Map<string, number>();
    for (const u of unreads) {
      unreadMap.set(
        `${u.userId}:${u.isAnonymous}`,
        (u._count as { _all?: number } | undefined)?._all ?? 0,
      );
    }

    const identifiedIds = totals.filter((t) => !t.isAnonymous && t.userId).map((t) => t.userId!);
    const users = identifiedIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: identifiedIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameMap = new Map(users.map((u) => [u.id, u.name]));

    return totals.map((t) => {
      const totalReports = (t._count as { _all?: number } | undefined)?._all ?? 0;
      const unread = unreadMap.get(`${t.userId}:${t.isAnonymous}`) ?? 0;
      const lastReportAt = (t._max as { createdAt?: Date | null } | undefined)?.createdAt ?? null;
      return {
        key: t.isAnonymous ? this.reportCommonService.maskUserId(t.userId!) : t.userId!,
        anonymous: t.isAnonymous,
        name: t.isAnonymous ? null : (nameMap.get(t.userId!) ?? null),
        totalReports,
        unread,
        read: totalReports - unread,
        lastReportAt,
      };
    });
  }

  private sortRows<T extends { totalReports: number; unread: number; lastReportAt: Date | null }>(
    rows: T[],
    sortBy: 'totalReports' | 'unread' | 'lastReportAt' = 'lastReportAt',
    order: 'asc' | 'desc' = 'desc',
  ): T[] {
    const dir = order === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sortBy === 'lastReportAt' ? (a.lastReportAt?.getTime() ?? 0) : a[sortBy];
      const bv = sortBy === 'lastReportAt' ? (b.lastReportAt?.getTime() ?? 0) : b[sortBy];
      return (av - bv) * dir;
    });
  }

  // RPT-23 GET /reports/by-user
  async listByUser(admin: CurrentUserDto, query: ByUserQueryDto) {
    const rows = this.sortRows(await this.buildUserRows(admin), query.sortBy, query.order);
    const { page, limit, skip } = this.reportCommonService.paging(query);
    const totals = rows.reduce(
      (acc, r) => ({
        total: acc.total + r.totalReports,
        unread: acc.unread + r.unread,
        read: acc.read + r.read,
      }),
      { total: 0, unread: 0, read: 0 },
    );

    this.auditReporterView(admin, 'list', undefined, { rows: Math.min(limit, rows.length) });
    return { items: rows.slice(skip, skip + limit), total: rows.length, page, limit, totals };
  }

  // RPT-24 GET /reports/by-user/:userId
  async getUserReports(admin: CurrentUserDto, userKey: string, query: UserReportsQueryDto) {
    const scope = await this.resolveUserScope(userKey);

    const filter: Prisma.ReportWhereInput = {
      ...this.scopeWhere(scope),
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.isRead === true ? { adminReads: { some: { adminId: admin.id } } } : {}),
      ...(query.isRead === false ? this.unreadFilter(admin.id) : {}),
    };

    const header = { AND: [this.scopeWhere(scope), this.reportCommonService.visibilityWhere(admin)] };
    const [list, total, unread, user] = await Promise.all([
      this.reportCommonService.pagedReports(admin, filter, query),
      this.prisma.report.count({ where: header }),
      this.prisma.report.count({ where: { AND: [header, this.unreadFilter(admin.id)] } }),
      scope.isAnonymous
        ? Promise.resolve(null)
        : this.prisma.user.findUnique({
            where: { id: scope.userId },
            select: { id: true, name: true },
          }),
    ]);

    if (!total && !user && !scope.isAnonymous) throw new NotFoundException('reporter_not_found');

    this.auditReporterView(admin, 'reports', scope);
    return {
      reporter: scope.isAnonymous
        ? { anonymous: true, key: userKey }
        : { anonymous: false, id: user?.id ?? scope.userId, name: user?.name ?? null },
      totals: { total, read: total - unread, unread },
      ...list,
    };
  }

  // RPT-25 GET /reports/by-user/:userId/summary
  async getUserSummary(admin: CurrentUserDto, userKey: string) {
    const scope = await this.resolveUserScope(userKey);
    const where = { AND: [this.scopeWhere(scope), this.reportCommonService.visibilityWhere(admin)] };

    const [byStatusRows, byCategoryRows, unread] = await Promise.all([
      this.prisma.report.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.report.groupBy({
        by: ['category'],
        where,
        _count: { _all: true },
        orderBy: { category: 'asc' },
      }),
      this.prisma.report.count({ where: { AND: [where, this.unreadFilter(admin.id)] } }),
    ]);

    const byStatus: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let total = 0;
    for (const r of byStatusRows) {
      const c = (r._count as { _all?: number } | undefined)?._all ?? 0;
      byStatus[r.status] = c;
      total += c;
    }
    for (const r of byCategoryRows) {
      byCategory[r.category] = (r._count as { _all?: number } | undefined)?._all ?? 0;
    }

    this.auditReporterView(admin, 'summary', scope);
    return { key: userKey, total, read: total - unread, unread, byStatus, byCategory };
  }

  // RPT-26 GET /reports/by-user/:userId/timeline   (reports per month)
  async getUserTimeline(admin: CurrentUserDto, userKey: string) {
    const scope = await this.resolveUserScope(userKey);
    const rows = await this.prisma.report.findMany({
      where: { AND: [this.scopeWhere(scope), this.reportCommonService.visibilityWhere(admin)] },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const buckets = new Map<string, number>();
    for (const r of rows) {
      const month = r.createdAt.toISOString().slice(0, 7);
      buckets.set(month, (buckets.get(month) ?? 0) + 1);
    }

    this.auditReporterView(admin, 'timeline', scope);
    return {
      key: userKey,
      items: [...buckets.entries()].map(([month, count]) => ({ month, count })),
    };
  }

  // RPT-27 PATCH /reports/by-user/:userId/read
  async markUserReportsRead(admin: CurrentUserDto, userKey: string) {
    const scope = await this.resolveUserScope(userKey);
    const rows = await this.prisma.report.findMany({
      where: {
        AND: [this.scopeWhere(scope), this.reportCommonService.visibilityWhere(admin), this.unreadFilter(admin.id)],
      },
      select: { id: true },
    });
    const marked = await this.markManyRead(
      admin.id,
      rows.map((r) => r.id),
    );
    return { key: userKey, marked };
  }

  // RPT-160 PATCH /reports/by-user/:userId/unread
  async markUserReportsUnread(admin: CurrentUserDto, userKey: string) {
    const scope = await this.resolveUserScope(userKey);
    const res = await this.prisma.reportAdminRead.deleteMany({
      where: {
        adminId: admin.id,
        report: { AND: [this.scopeWhere(scope), this.reportCommonService.visibilityWhere(admin)] },
      },
    });
    return { key: userKey, updated: res.count };
  }

  // RPT-28 GET /reports/by-user/repeat
  async listRepeatReporters(admin: CurrentUserDto, query: RepeatReportersQueryDto) {
    const min = query.minReports ?? 2;
    const rows = this.sortRows(
      (await this.buildUserRows(admin)).filter((r) => r.totalReports >= min),
      'totalReports',
      'desc',
    );
    const { page, limit, skip } = this.reportCommonService.paging(query);

    this.auditReporterView(admin, 'repeat', undefined, { minReports: min });
    return { items: rows.slice(skip, skip + limit), total: rows.length, page, limit };
  }
}

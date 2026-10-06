import { Injectable } from '@nestjs/common';
import { AuditOutcome, LoginResultEnum, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import {
  DeletionRequestStatus,
  StatsInterval,
  UserStatsQueryDto,
  UserStatsTimelineQueryDto,
} from '../dto/user.dto';
import { UserCommonService } from './user-common.service';

@Injectable()
export class UserStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly userCommonService: UserCommonService,
  ) {}

  // ── ADMIN — DASHBOARD STATS ──

  async getDashboardStats() {
    // Heavy multi-count aggregate: serve from cache for a short TTL (TTL.ADMIN_DASHBOARD_STATS).
    return this.cache.wrapStats('user-dashboard', () => this.getDashboardStatsUncached());
  }

  private async getDashboardStatsUncached() {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalUsers,
      activeUsers,
      inactiveUsers,
      discreetModeEnabledUsers,
      newUsersLast7Days,
      newUsersLast30Days,
      roles,
      superAdminCount,
      adminCount,
      regularUserCount,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { isActive: false } }),
      this.prisma.user.count({ where: { discreetModeEnabled: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      this.prisma.role.findMany({
        select: { id: true, name: true, _count: { select: { userRoles: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.user.count({
        where: { userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } } },
      }),
      this.prisma.user.count({
        where: { userRoles: { some: { role: { name: RolesEnum.ADMIN } } } },
      }),
      this.prisma.user.count({
        where: {
          userRoles: { none: { role: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] } } } },
        },
      }),
    ]);

    return {
      totalUsers,
      activeUsers,
      inactiveUsers,
      discreetModeEnabledUsers,
      newUsersLast7Days,
      newUsersLast30Days,
      superAdminCount,
      adminCount,
      regularUserCount,
      usersByRole: roles.map((role) => ({
        roleId: role.id,
        roleName: role.name,
        userCount: role._count.userRoles,
      })),
    };
  }

  async getUserStatsTimeline(actor: CurrentUserDto, query: UserStatsTimelineQueryDto) {
    const { from, to } = this.userCommonService.rangeOf(query, 30);
    const interval = query.interval ?? StatsInterval.DAY;
    const rows = await this.prisma.user.findMany({
      where: { ...this.userCommonService.statsWhere(query), createdAt: { gte: from, lte: to } },
      select: { createdAt: true },
      take: 200_000,
    });
    return {
      from,
      to,
      interval,
      series: this.userCommonService.bucketDates(
        rows.map((r) => r.createdAt),
        interval,
      ),
    };
  }

  async getUserStatsActive(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const userWhere = this.userCommonService.statsWhere({
      ...query,
      from: undefined,
      to: undefined,
    });
    const activeSince = async (days: number) =>
      (
        await this.prisma.loginAttempt.groupBy({
          by: ['userId'],
          where: {
            result: LoginResultEnum.SUCCESS,
            userId: { not: null },
            createdAt: { gte: new Date(Date.now() - days * 86_400_000) },
            user: { is: userWhere },
          },
        })
      ).length;
    const [dau, wau, mau, total] = await Promise.all([
      activeSince(1),
      activeSince(7),
      activeSince(30),
      this.prisma.user.count({ where: userWhere }),
    ]);
    return { dau, wau, mau, total, stickiness: mau ? Number((dau / mau).toFixed(3)) : 0 };
  }

  async getUserStatsByRole(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const groups = await this.prisma.userRole.groupBy({
      by: ['roleId'],
      where: { user: this.userCommonService.statsWhere(query) },
      _count: { _all: true },
    });
    const roles = await this.prisma.role.findMany({
      where: { id: { in: groups.map((g) => g.roleId) } },
      select: { id: true, name: true },
    });
    const name = new Map(roles.map((r) => [r.id, r.name]));
    return groups
      .map((g) => ({ roleId: g.roleId, role: name.get(g.roleId) ?? null, count: g._count._all }))
      .sort((a, b) => b.count - a.count);
  }

  async getUserStatsByRegion(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const where = this.userCommonService.statsWhere(query);
    const [groups, total] = await Promise.all([
      this.prisma.userProfile.groupBy({
        by: ['region'],
        where: { user: where },
        _count: { _all: true },
      }),
      this.prisma.user.count({ where }),
    ]);
    const rows = groups.map((g) => ({ region: g.region ?? 'unknown', count: g._count._all }));
    // Users with no profile row have no region at all.
    const withProfile = groups.reduce((sum, g) => sum + g._count._all, 0);
    if (total > withProfile) rows.push({ region: 'unknown', count: total - withProfile });
    return rows.sort((a, b) => b.count - a.count);
  }

  async getUserStatsVerificationFunnel(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const { from, to } = this.userCommonService.rangeOf(query, 30);
    const where = {
      ...this.userCommonService.statsWhere(query),
      createdAt: { gte: from, lte: to },
    };
    const [started, codeSent, verified, active] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.userOtp
        .groupBy({ by: ['userId'], where: { createdAt: { gte: from, lte: to } } })
        .then((rows) => rows.length),
      this.userCommonService.db.user.count({ where: { ...where, isPhoneVerified: true } }),
      this.prisma.user.count({
        where: {
          ...where,
          isActive: true,
          loginAttempts: { some: { result: LoginResultEnum.SUCCESS } },
        },
      }),
    ]);
    const rate = (n: number) => (started ? Number((n / started).toFixed(3)) : 0);
    return {
      from,
      to,
      steps: [
        { step: 'started', count: started, rate: 1 },
        { step: 'code_sent', count: codeSent, rate: rate(codeSent) },
        { step: 'verified', count: verified, rate: rate(verified) },
        { step: 'active', count: active, rate: rate(active) },
      ],
    };
  }

  async getUserStatsRetention(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const { from, to } = this.userCommonService.rangeOf(query, 120);
    const userWhere: Prisma.UserWhereInput = {
      ...this.userCommonService.statsWhere(query),
      createdAt: { gte: from, lte: to },
    };
    const [users, lastSeen] = await Promise.all([
      this.prisma.user.findMany({
        where: userWhere,
        select: { id: true, createdAt: true },
        take: 100_000,
      }),
      this.prisma.loginAttempt.groupBy({
        by: ['userId'],
        where: { result: LoginResultEnum.SUCCESS, user: { is: userWhere } },
        _max: { createdAt: true },
      }),
    ]);
    const lastLogin = new Map(lastSeen.map((l) => [l.userId, l._max.createdAt]));
    const rows = users.map((u) => ({
      createdAt: u.createdAt,
      lastLoginAt: lastLogin.get(u.id) ?? null,
    }));
    const now = Date.now();
    const windows = [7, 30, 90].map((days) => {
      const eligible = rows.filter((r) => r.createdAt.getTime() <= now - days * 86_400_000);
      const retained = eligible.filter(
        (r) =>
          r.lastLoginAt && r.lastLoginAt.getTime() >= r.createdAt.getTime() + days * 86_400_000,
      );
      return {
        days,
        eligible: eligible.length,
        retained: retained.length,
        rate: eligible.length ? Number((retained.length / eligible.length).toFixed(3)) : 0,
      };
    });
    return { from, to, cohortSize: rows.length, windows };
  }

  async getUserStatsDeactivations(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const { from, to } = this.userCommonService.rangeOf(query, 30);
    const [events, deletionsApproved] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          action: {
            in: [AuditEventEnum.USER_DEACTIVATED, AuditEventEnum.USER_DEACTIVATED_BY_ADMIN],
          },
          outcome: AuditOutcome.SUCCESS,
          createdAt: { gte: from, lte: to },
        },
        select: { createdAt: true, reason: true },
        take: 100_000,
      }),
      this.userCommonService.countFor('userDeletionRequest', {
        status: DeletionRequestStatus.APPROVED,
        decidedAt: { gte: from, lte: to },
      }),
    ]);
    const reasons = new Map<string, number>();
    for (const e of events) {
      const key = e.reason?.trim() || 'unspecified';
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    return {
      from,
      to,
      total: events.length,
      deletionsApproved,
      timeline: this.userCommonService.bucketDates(events.map((e) => e.createdAt)),
      reasons: [...reasons.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, 20)
        .map(([reason, count]) => ({ reason, count })),
    };
  }

  async getUserStatsLoginFailures(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const { from, to } = this.userCommonService.rangeOf(query, 30);
    const range = { gte: from, lte: to };
    const [failures, lockEvents, currentlyLocked] = await Promise.all([
      this.prisma.loginAttempt.findMany({
        where: {
          result: { in: [LoginResultEnum.FAILED, LoginResultEnum.LOCKED] },
          createdAt: range,
        },
        select: { createdAt: true },
        take: 200_000,
      }),
      this.prisma.loginAttempt.count({
        where: { result: LoginResultEnum.LOCKED, createdAt: range },
      }),
      this.prisma.user.count({ where: { lockedUntil: { gt: new Date() } } }),
    ]);
    return {
      from,
      to,
      totalFailures: failures.length,
      lockEvents,
      currentlyLocked,
      timeline: this.userCommonService.bucketDates(failures.map((f) => f.createdAt)),
    };
  }

  async getUserStatsRestrictions(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const { from, to } = this.userCommonService.rangeOf(query, 30);
    const range = { createdAt: { gte: from, lte: to } };
    const [restrictions, warnings] = await Promise.all([
      this.userCommonService.listFor('userRestriction', {
        where: range,
        select: { createdAt: true, ability: true },
        take: 100_000,
      }),
      this.userCommonService.listFor('userWarning', {
        where: range,
        select: { createdAt: true },
        take: 100_000,
      }),
    ]);
    const byAbility = new Map<string, number>();
    for (const r of restrictions) byAbility.set(r.ability, (byAbility.get(r.ability) ?? 0) + 1);
    return {
      from,
      to,
      restrictions: {
        total: restrictions.length,
        timeline: this.userCommonService.bucketDates(restrictions.map((r) => r.createdAt)),
        byAbility: [...byAbility.entries()].map(([ability, count]) => ({ ability, count })),
      },
      warnings: {
        total: warnings.length,
        timeline: this.userCommonService.bucketDates(warnings.map((w) => w.createdAt)),
      },
    };
  }

  async getUserStatsOverview(actor: CurrentUserDto, query: UserStatsQueryDto) {
    return this.cache.wrapStats(`user-stats-overview:${JSON.stringify(query)}`, async () => {
      const [
        dashboard,
        timeline,
        active,
        byRole,
        byRegion,
        funnel,
        retention,
        deactivations,
        loginFailures,
        restrictions,
      ] = await Promise.all([
        this.getDashboardStatsUncached(),
        this.getUserStatsTimeline(actor, { ...query, interval: StatsInterval.DAY }),
        this.getUserStatsActive(actor, query),
        this.getUserStatsByRole(actor, query),
        this.getUserStatsByRegion(actor, query),
        this.getUserStatsVerificationFunnel(actor, query),
        this.getUserStatsRetention(actor, query),
        this.getUserStatsDeactivations(actor, query),
        this.getUserStatsLoginFailures(actor, query),
        this.getUserStatsRestrictions(actor, query),
      ]);
      return {
        dashboard,
        timeline,
        active,
        byRole,
        byRegion,
        funnel,
        retention,
        deactivations,
        loginFailures,
        restrictions,
      };
    });
  }
}

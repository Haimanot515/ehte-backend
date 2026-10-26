import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { UsersPagedQueryDto, UserStatsQueryDto } from '../dto/user.dto';
import { UserCommonService } from './user-common.service';
import { VIEW_ENTITY, USER_CONTENT_SOURCES } from './user.constants';

@Injectable()
export class UserInspectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userCommonService: UserCommonService,
  ) {}

  async getUserSummary(actor: CurrentUserDto, userId: string) {
    await this.userCommonService.requireUser(userId);
    this.userCommonService.recordView(actor, userId, 'summary');
    const [counts, openFlags, warnings, activeRestrictions] = await Promise.all([
      this.userCommonService.buildSummary(userId),
      this.userCommonService.countFor('abuseReport', { targetUserId: userId, status: 'OPEN' }),
      this.userCommonService.countFor('userWarning', { userId }),
      this.userCommonService.countFor('userRestriction', { userId, ...this.userCommonService.activeRestrictionWhere() }),
    ]);
    return { ...counts, openFlags, warnings, activeRestrictions };
  }

  async getUserTimeline(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.userCommonService.requireUser(userId);
    this.userCommonService.recordView(actor, userId, 'timeline');
    return this.userCommonService.auditPage(
      { OR: [{ userId }, { targetUserId: userId }], entity: { not: VIEW_ENTITY } },
      query,
      (row) => ({
        id: row.id,
        event: row.action,
        outcome: row.outcome,
        at: row.createdAt,
        actorId: row.userId,
        byAdmin: !!row.targetUserId && row.userId !== userId,
        reason: row.reason ?? null,
      }),
    );
  }

  async getUserSecurityEvents(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.userCommonService.requireUser(userId);
    this.userCommonService.recordView(actor, userId, 'security_events');
    return this.userCommonService.securityEvents(userId, query);
  }

  async getUserLoginHistory(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.userCommonService.requireUser(userId);
    this.userCommonService.recordView(actor, userId, 'login_history');
    return this.userCommonService.loginHistory(userId, query);
  }

  async getUserDevices(actor: CurrentUserDto, userId: string) {
    await this.userCommonService.requireUser(userId);
    this.userCommonService.recordView(actor, userId, 'devices');
    const devices = await this.userCommonService.listFor('deviceToken', {
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return devices.map((d) => ({
      ...d,
      token: typeof d.token === 'string' ? `${d.token.slice(0, 6)}…${d.token.slice(-4)}` : null,
    }));
  }

  async getUserActivity(actor: CurrentUserDto, userId: string, query: UserStatsQueryDto) {
    await this.userCommonService.requireUser(userId);
    this.userCommonService.recordView(actor, userId, 'activity');
    const { from, to } = this.userCommonService.rangeOf(query, 90);
    const entries = await Promise.all(
      Object.entries(USER_CONTENT_SOURCES).map(async ([key, [model, field]]) => {
        const rows = await this.userCommonService.listFor(model, {
          where: { [field]: userId, createdAt: { gte: from, lte: to } },
          select: { createdAt: true },
          take: 5000,
        });
        return [key, this.userCommonService.bucketDates(rows.map((r) => r.createdAt))] as const;
      }),
    );
    return { from, to, series: Object.fromEntries(entries) };
  }

  async getUserPermissions(actor: CurrentUserDto, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { userRoles: { select: { role: { select: { id: true, name: true } } } } },
    });
    if (!user) throw new NotFoundException('user_not_found');
    this.userCommonService.recordView(actor, userId, 'permissions');

    const roles = user.userRoles.map((ur) => ur.role);
    const withPermissions = await this.userCommonService.listFor('role', {
      where: { id: { in: roles.map((r) => r.id) } },
      include: { rolePermissions: { include: { permission: true } } },
    });
    const permissions = new Set<string>();
    for (const role of withPermissions) {
      for (const rp of role.rolePermissions ?? []) {
        const name = rp.permission?.name ?? rp.name;
        if (name) permissions.add(name);
      }
    }
    return { userId, roles: roles.map((r) => r.name), permissions: [...permissions].sort() };
  }

  async getUserFlags(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.userCommonService.requireUser(userId);
    this.userCommonService.recordView(actor, userId, 'flags');
    const { page, limit, skip } = this.userCommonService.paging(query);
    const page_ = { orderBy: { createdAt: 'desc' }, skip, take: limit };
    const [abuseReports, warnings, restrictions] = await Promise.all([
      this.userCommonService.listFor('abuseReport', { where: { targetUserId: userId }, ...page_ }),
      this.userCommonService.listFor('userWarning', { where: { userId }, ...page_ }),
      this.userCommonService.listFor('userRestriction', { where: { userId }, ...page_ }),
    ]);
    return { page, limit, abuseReports, warnings, restrictions };
  }

  async getRestrictions(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.userCommonService.requireUser(userId);
    const { page, limit, skip } = this.userCommonService.paging(query);
    const [rows, total] = await Promise.all([
      this.userCommonService.db.userRestriction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.userCommonService.db.userRestriction.count({ where: { userId } }),
    ]);
    const now = Date.now();
    return {
      data: rows.map((r: any) => ({
        ...r,
        active: !r.liftedAt && (!r.endsAt || new Date(r.endsAt).getTime() > now),
      })),
      meta: this.userCommonService.pageMeta(page, limit, total),
    };
  }

  async getWarnings(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.userCommonService.requireUser(userId);
    const { page, limit, skip } = this.userCommonService.paging(query);
    const [rows, total] = await Promise.all([
      this.userCommonService.db.userWarning.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.userCommonService.db.userWarning.count({ where: { userId } }),
    ]);
    return { data: rows, meta: this.userCommonService.pageMeta(page, limit, total) };
  }

  async getUserAccessLog(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.userCommonService.requireUser(userId);
    return this.userCommonService.auditPage({ entity: VIEW_ENTITY, entityId: userId }, query, (row) => ({
      id: row.id,
      viewedBy: row.userId,
      section: (row.metadata as { section?: string } | null)?.section ?? null,
      at: row.createdAt,
    }));
  }
}

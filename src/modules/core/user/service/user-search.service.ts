import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PENDING_REGISTRATION_WHERE } from 'src/common/utils/registration-state.util';
import { LoginResultEnum, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import {
  InactiveUsersQueryDto,
  ListDeleteRequestsQueryDto,
  ListUsersQueryDto,
  UserSearchQueryDto,
  UsersPagedQueryDto,
  UserStatsQueryDto,
} from '../dto/user.dto';
import { UserCommonService } from './user-common.service';
import { LIST_USER_SELECT } from './user.constants';

@Injectable()
export class UserSearchService {
  private readonly logger = new Logger(UserSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly userCommonService: UserCommonService,
  ) {}

  // ── ADMIN — LIST USERS ──
  // Address fields deliberately excluded from this select.

  async listUsers(query: ListUsersQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;
    const where: any = {};

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.discreetModeEnabled !== undefined)
      where.discreetModeEnabled = query.discreetModeEnabled;
    if (query.roleId) where.userRoles = { some: { roleId: query.roleId } };
    if (query.registrationStatus === 'pending') {
      // Same definition as listPendingRegistrations: an open invite on an inactive account.
      Object.assign(where, PENDING_REGISTRATION_WHERE);
    } else if (query.registrationStatus === 'completed') where.passwordHash = { not: null };

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          isActive: true,
          discreetModeEnabled: true,
          discreetModeUpdatedAt: true,
          createdAt: true,
          updatedAt: true,
          userRoles: { select: { role: { select: { id: true, name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users.map((user) => this.userCommonService.shapeProfile(user)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // GET /users/me/audit-log and GET /users/:id/audit-log share this.
  async getHistory(userId: string) {
    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      throw new NotFoundException('user_not_found');
    }
    return this.prisma.auditLog.findMany({
      where: { entity: 'User', entityId: userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listRestricted(actor: CurrentUserDto, query: UsersPagedQueryDto) {
    const { page, limit, skip } = this.userCommonService.paging(query);
    const where = this.userCommonService.activeRestrictionWhere();
    const [rows, total] = await Promise.all([
      this.userCommonService.db.userRestriction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: LIST_USER_SELECT } },
      }),
      this.userCommonService.db.userRestriction.count({ where }),
    ]);
    return {
      data: rows.map((r: any) => ({ ...r, user: r.user ? this.userCommonService.shapeListed(actor, r.user) : null })),
      meta: this.userCommonService.pageMeta(page, limit, total),
    };
  }

  async listLocked(actor: CurrentUserDto, query: UsersPagedQueryDto) {
    const { page, limit, skip } = this.userCommonService.paging(query);
    const where: Prisma.UserWhereInput = { lockedUntil: { gt: new Date() } };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: { ...LIST_USER_SELECT, failedLoginAttempts: true },
        orderBy: { lockedUntil: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.userCommonService.shapeListed(actor, r)),
      meta: this.userCommonService.pageMeta(page, limit, total),
    };
  }

  async listInactive(actor: CurrentUserDto, query: InactiveUsersQueryDto) {
    const { page, limit, skip } = this.userCommonService.paging(query);
    const days = query.days && query.days > 0 ? query.days : 90;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    // Inactive = older than the cutoff with no successful sign-in since then (or ever).
    const where: Prisma.UserWhereInput = {
      isActive: true,
      createdAt: { lt: cutoff },
      loginAttempts: { none: { result: LoginResultEnum.SUCCESS, createdAt: { gte: cutoff } } },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: LIST_USER_SELECT,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    const last = rows.length
      ? await this.prisma.loginAttempt.groupBy({
          by: ['userId'],
          where: { userId: { in: rows.map((r) => r.id) }, result: LoginResultEnum.SUCCESS },
          _max: { createdAt: true },
        })
      : [];
    const lastLogin = new Map(last.map((l) => [l.userId, l._max.createdAt]));
    return {
      data: rows.map((r) => ({
        ...this.userCommonService.shapeListed(actor, r),
        lastLoginAt: lastLogin.get(r.id) ?? null,
      })),
      meta: { ...this.userCommonService.pageMeta(page, limit, total), days },
    };
  }

  async listDuplicates(actor: CurrentUserDto, query: UsersPagedQueryDto) {
    const { page, limit, skip } = this.userCommonService.paging(query);
    const groupArgs = {
      by: ['name' as const],
      where: { name: { not: null } },
      having: { name: { _count: { gt: 1 } } },
    };
    const [groups, allGroups] = await Promise.all([
      this.prisma.user.groupBy({
        ...groupArgs,
        _count: { _all: true },
        orderBy: { name: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.user.groupBy({ ...groupArgs, _count: { _all: true }, orderBy: { name: 'asc' } }),
    ]);

    const names = groups.map((g) => g.name as string);
    const users = names.length
      ? await this.prisma.user.findMany({
          where: { name: { in: names } },
          select: LIST_USER_SELECT,
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const byName = groups.map((g) => ({
      name: g.name,
      count: g._count._all,
      users: users.filter((u) => u.name === g.name).map((u) => this.userCommonService.shapeListed(actor, u)),
    }));

    let byDevice: unknown[] = [];
    try {
      byDevice = await this.userCommonService.db.deviceToken.groupBy({
        by: ['token'],
        _count: { userId: true },
        having: { userId: { _count: { gt: 1 } } },
        take: 50,
      });
    } catch (err) {
      this.logger.warn(`device duplicate scan failed: ${err instanceof Error ? err.message : err}`);
    }

    return {
      byName: { data: byName, meta: this.userCommonService.pageMeta(page, limit, allGroups.length) },
      byDevice,
    };
  }

  async getPossibleDuplicates(actor: CurrentUserDto, userId: string) {
    const target = await this.userCommonService.db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true },
    });
    if (!target) throw new NotFoundException('user_not_found');
    this.userCommonService.recordView(actor, userId, 'possible_duplicates');

    const phoneTail = target.phone ? String(target.phone).replace(/\D/g, '').slice(-9) : null;
    const or: Prisma.UserWhereInput[] = [];
    if (target.name) or.push({ name: { equals: target.name, mode: 'insensitive' } });
    if (phoneTail) or.push({ phone: { endsWith: phoneTail } });
    const candidates = or.length
      ? await this.prisma.user.findMany({
          where: { id: { not: userId }, OR: or },
          select: LIST_USER_SELECT,
          take: 50,
        })
      : [];

    const devices = await this.userCommonService.listFor('deviceToken', {
      where: { userId },
      select: { token: true },
    });
    const deviceIds = devices.map((d) => d.token).filter(Boolean);
    const shared = deviceIds.length
      ? await this.userCommonService.listFor('deviceToken', {
          where: { token: { in: deviceIds }, userId: { not: userId } },
          select: { userId: true },
        })
      : [];
    const sharedIds = new Set(shared.map((d) => d.userId as string));

    return candidates.map((c) => ({
      ...this.userCommonService.shapeListed(actor, c),
      reasons: [
        ...(target.name && c.name?.toLowerCase() === String(target.name).toLowerCase()
          ? ['same_name']
          : []),
        ...(phoneTail && c.phone?.endsWith(phoneTail) ? ['similar_phone'] : []),
        ...(sharedIds.has(c.id) ? ['shared_device'] : []),
      ],
    }));
  }

  async listAbuseReports(actor: CurrentUserDto, query: UsersPagedQueryDto) {
    const { page, limit, skip } = this.userCommonService.paging(query);
    const where = { targetUserId: { not: null } };
    const [rows, total] = await Promise.all([
      this.userCommonService.db.abuseReport.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.userCommonService.db.abuseReport.count({ where }),
    ]);
    return { data: rows, meta: this.userCommonService.pageMeta(page, limit, total) };
  }

  async listDeleteRequests(actor: CurrentUserDto, query: ListDeleteRequestsQueryDto) {
    const { page, limit, skip } = this.userCommonService.paging(query);
    const where = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.userCommonService.db.userDeletionRequest.findMany({
        where,
        orderBy: { scheduledFor: 'asc' },
        skip,
        take: limit,
        include: { user: { select: LIST_USER_SELECT } },
      }),
      this.userCommonService.db.userDeletionRequest.count({ where }),
    ]);
    return {
      data: rows.map((r: any) => ({ ...r, user: r.user ? this.userCommonService.shapeListed(actor, r.user) : null })),
      meta: this.userCommonService.pageMeta(page, limit, total),
    };
  }

  async searchUsers(actor: CurrentUserDto, query: UserSearchQueryDto) {
    const { page, limit, skip } = this.userCommonService.paging(query);
    const where = this.userCommonService.searchWhere(query.q, query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: LIST_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.userCommonService.shapeListed(actor, r)),
      meta: this.userCommonService.pageMeta(page, limit, total),
    };
  }

  async getUserFacets(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const where = this.userCommonService.statsWhere(query);
    const [total, active, locked, roleGroups, regionGroups] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.count({ where: { ...where, isActive: true } }),
      this.prisma.user.count({ where: { ...where, lockedUntil: { gt: new Date() } } }),
      this.prisma.userRole.groupBy({
        by: ['roleId'],
        where: { user: where },
        _count: { _all: true },
      }),
      this.prisma.userProfile.groupBy({
        by: ['region'],
        where: { user: where },
        _count: { _all: true },
      }),
    ]);
    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleGroups.map((g) => g.roleId) } },
      select: { id: true, name: true },
    });
    const roleName = new Map(roles.map((r) => [r.id, r.name]));

    return {
      total,
      status: { active, inactive: total - active, locked },
      roles: roleGroups.map((g) => ({
        roleId: g.roleId,
        name: roleName.get(g.roleId) ?? null,
        count: g._count._all,
      })),
      regions: regionGroups.map((g) => ({ region: g.region ?? 'unknown', count: g._count._all })),
    };
  }

  async getUserFilterOptions(actor: CurrentUserDto) {
    const [roles, regions] = await Promise.all([
      this.prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.userProfile.findMany({
        where: { region: { not: null } },
        distinct: ['region'],
        select: { region: true },
        orderBy: { region: 'asc' },
      }),
    ]);
    return {
      roles,
      regions: regions.map((r) => r.region),
      statuses: ['active', 'inactive', 'locked'],
      languages: ['am', 'en'],
    };
  }
}
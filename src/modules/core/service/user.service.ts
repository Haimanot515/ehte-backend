import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import {
  AssignUserRoleDto,
  ListUsersQueryDto,
  UpdateDiscreetModeDto,
  UpdateUserDto,
} from '../dto/user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { RolesEnum } from 'src/common/enums/roles.enum';
@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}
  // ─────────────────────────────────────────────
  // GET CURRENT USER
  // ─────────────────────────────────────────────
  async getMe(currentUser: CurrentUserDto) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: currentUser.id,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        isActive: true,
        discreetModeEnabled: true,
        discreetModeUpdatedAt: true,
        createdAt: true,
        updatedAt: true,
        userRoles: {
          select: {
            role: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    const roles = user.userRoles.map((userRole) => userRole.role);
    const { userRoles: _userRoles, ...userData } = user;
    return {
      ...userData,
      roles,
    };
  }
  // ─────────────────────────────────────────────
  // ADMIN — GET USER BY ID
  // GET /users/:id
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // PRD 23: Admin Portal > Users
  // ─────────────────────────────────────────────
  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: {
        id,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        isActive: true,
        discreetModeEnabled: true,
        discreetModeUpdatedAt: true,
        createdAt: true,
        updatedAt: true,
        userRoles: {
          select: {
            role: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    const roles = user.userRoles.map((userRole) => userRole.role);
    const { userRoles: _userRoles, ...userData } = user;
    return {
      ...userData,
      roles,
    };
  }
  // ─────────────────────────────────────────────
  // UPDATE PROFILE
  // ─────────────────────────────────────────────
  async updateMe(currentUser: CurrentUserDto, data: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: currentUser.id,
      },
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    const updatedUser = await this.prisma.user.update({
      where: {
        id: currentUser.id,
      },
      data: {
        ...(data.name !== undefined && {
          name: data.name.trim(),
        }),
      },
      select: {
        id: true,
        name: true,
        phone: true,
        isActive: true,
        discreetModeEnabled: true,
        discreetModeUpdatedAt: true,
        createdAt: true,
        updatedAt: true,
        userRoles: {
          select: {
            role: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });
    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────
    this.eventEmitter.emit(AuditEventEnum.USER_UPDATED, {
      userId: currentUser.id,
      entityId: currentUser.id,
      entityType: 'USER',
    });
    const roles = updatedUser.userRoles.map((userRole) => userRole.role);
    const { userRoles: _userRoles, ...userData } = updatedUser;
    return {
      ...userData,
      roles,
    };
  }
  // ─────────────────────────────────────────────
  // DISCREET MODE
  // ─────────────────────────────────────────────
  async updateDiscreetMode(currentUser: CurrentUserDto, data: UpdateDiscreetModeDto) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: currentUser.id,
      },
      select: {
        id: true,
        isActive: true,
        discreetModeEnabled: true,
      },
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    if (!user.isActive) {
      throw new BadRequestException('account_inactive');
    }
    // ───────────────────────────────────────────
    // NO CHANGE
    // ───────────────────────────────────────────
    if (user.discreetModeEnabled === data.enabled) {
      return {
        message: data.enabled ? 'discreet_mode_enabled' : 'discreet_mode_disabled',
        discreetModeEnabled: user.discreetModeEnabled,
        discreetModeUpdatedAt: undefined,
      };
    }
    const updatedUser = await this.prisma.user.update({
      where: {
        id: currentUser.id,
      },
      data: {
        discreetModeEnabled: data.enabled,
        discreetModeUpdatedAt: new Date(),
      },
      select: {
        id: true,
        discreetModeEnabled: true,
        discreetModeUpdatedAt: true,
      },
    });
    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────
    this.eventEmitter.emit(
      data.enabled ? AuditEventEnum.DISCREET_MODE_ENABLED : AuditEventEnum.DISCREET_MODE_DISABLED,
      {
        userId: currentUser.id,
        entityId: currentUser.id,
        entityType: 'USER',
        enabled: data.enabled,
      },
    );
    return {
      message: data.enabled ? 'discreet_mode_enabled' : 'discreet_mode_disabled',
      discreetModeEnabled: updatedUser.discreetModeEnabled,
      discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt,
    };
  }
  // ─────────────────────────────────────────────
  // DEACTIVATE ACCOUNT
  // ─────────────────────────────────────────────
  async deactivateMe(currentUser: CurrentUserDto): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: {
        id: currentUser.id,
      },
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    if (!user.isActive) {
      throw new BadRequestException('account_already_inactive');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: {
          id: currentUser.id,
        },
        data: {
          isActive: false,
        },
      }),
      this.prisma.session.deleteMany({
        where: {
          userId: currentUser.id,
        },
      }),
    ]);
    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────
    this.eventEmitter.emit(AuditEventEnum.USER_DEACTIVATED, {
      userId: currentUser.id,
      entityId: currentUser.id,
      entityType: 'USER',
    });
    return {
      message: 'account_deactivated',
    };
  }
  // ─────────────────────────────────────────────
  // ADMIN — DEACTIVATE USER
  // PATCH /users/:id/deactivate
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // Blocks deactivating the last active super admin, mirroring
  // the same protection revokeRole applies.
  // ─────────────────────────────────────────────
  async deactivateUser(actor: CurrentUserDto, targetUserId: string) {
    const targetUser = await this.prisma.user.findUnique({
      where: {
        id: targetUserId,
      },
      select: {
        id: true,
        isActive: true,
        userRoles: {
          select: {
            role: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });
    if (!targetUser) {
      throw new NotFoundException('user_not_found');
    }
    if (!targetUser.isActive) {
      throw new BadRequestException('account_already_inactive');
    }
    const isSuperAdmin = targetUser.userRoles.some(
      (userRole) => userRole.role.name === (RolesEnum.SUPER_ADMIN as string),
    );
    if (isSuperAdmin) {
      const otherActiveSuperAdmins = await this.prisma.user.count({
        where: {
          id: { not: targetUserId },
          isActive: true,
          userRoles: {
            some: {
              role: {
                name: RolesEnum.SUPER_ADMIN,
              },
            },
          },
        },
      });
      if (otherActiveSuperAdmins === 0) {
        throw new ForbiddenException('cannot_deactivate_last_super_admin');
      }
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: {
          id: targetUserId,
        },
        data: {
          isActive: false,
        },
      }),
      this.prisma.session.deleteMany({
        where: {
          userId: targetUserId,
        },
      }),
    ]);
    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────
    this.eventEmitter.emit(AuditEventEnum.USER_DEACTIVATED_BY_ADMIN, {
      userId: actor.id,
      entityId: targetUserId,
      entityType: 'USER',
    });
    return this.getUserById(targetUserId);
  }
  // ─────────────────────────────────────────────
  // ADMIN — REACTIVATE USER
  // PATCH /users/:id/reactivate
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // ─────────────────────────────────────────────
  async reactivateUser(actor: CurrentUserDto, targetUserId: string) {
    const targetUser = await this.prisma.user.findUnique({
      where: {
        id: targetUserId,
      },
      select: {
        id: true,
        isActive: true,
      },
    });
    if (!targetUser) {
      throw new NotFoundException('user_not_found');
    }
    if (targetUser.isActive) {
      throw new BadRequestException('account_already_active');
    }
    await this.prisma.user.update({
      where: {
        id: targetUserId,
      },
      data: {
        isActive: true,
      },
    });
    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────
    this.eventEmitter.emit(AuditEventEnum.USER_REACTIVATED, {
      userId: actor.id,
      entityId: targetUserId,
      entityType: 'USER',
    });
    return this.getUserById(targetUserId);
  }
  // ─────────────────────────────────────────────
  // ADMIN — FORCE LOGOUT
  // POST /users/:id/force-logout
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // Revokes all sessions without touching isActive.
  // ─────────────────────────────────────────────
  async forceLogout(actor: CurrentUserDto, targetUserId: string): Promise<{ message: string }> {
    const targetUser = await this.prisma.user.findUnique({
      where: {
        id: targetUserId,
      },
      select: {
        id: true,
      },
    });
    if (!targetUser) {
      throw new NotFoundException('user_not_found');
    }
    await this.prisma.session.deleteMany({
      where: {
        userId: targetUserId,
      },
    });
    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────
    this.eventEmitter.emit(AuditEventEnum.USER_SESSIONS_REVOKED, {
      userId: actor.id,
      entityId: targetUserId,
      entityType: 'USER',
    });
    return {
      message: 'sessions_revoked',
    };
  }
  // ─────────────────────────────────────────────
  // ADMIN — ASSIGN ROLE
  // PATCH /users/:id/role
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // Grants the target user the given role. Does not remove any
  // other role the user already holds — pass the same role again
  // to no-op, or see revokeRole below to remove one.
  // ─────────────────────────────────────────────
  async assignRole(actor: CurrentUserDto, targetUserId: string, data: AssignUserRoleDto) {
    const targetUser = await this.prisma.user.findUnique({
      where: {
        id: targetUserId,
      },
      select: {
        id: true,
        isActive: true,
      },
    });
    if (!targetUser) {
      throw new NotFoundException('user_not_found');
    }
    const role = await this.prisma.role.findUnique({
      where: {
        name: data.role,
      },
    });
    if (!role) {
      throw new BadRequestException('role_not_found');
    }
    await this.prisma.userRole.upsert({
      where: {
        userId_roleId: {
          userId: targetUserId,
          roleId: role.id,
        },
      },
      create: {
        userId: targetUserId,
        roleId: role.id,
      },
      update: {},
    });
    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────
    this.eventEmitter.emit(AuditEventEnum.USER_ROLE_ASSIGNED, {
      userId: actor.id,
      entityId: targetUserId,
      entityType: 'USER',
      role: data.role,
    });
    return this.getMe({
      id: targetUserId,
    } as CurrentUserDto);
  }
  // ─────────────────────────────────────────────
  // ADMIN — REVOKE ROLE
  // DELETE /users/:id/role/:role
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // Blocks removing the last active super admin so the platform
  // is never left without one.
  // ─────────────────────────────────────────────
  async revokeRole(
    actor: CurrentUserDto,
    targetUserId: string,
    role: RolesEnum.ADMIN | RolesEnum.SUPER_ADMIN,
  ) {
    const targetUser = await this.prisma.user.findUnique({
      where: {
        id: targetUserId,
      },
      select: {
        id: true,
        userRoles: {
          select: {
            role: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });
    if (!targetUser) {
      throw new NotFoundException('user_not_found');
    }
    const roleToRevoke = targetUser.userRoles.find(
      (userRole) => userRole.role.name === (role as string),
    )?.role;
    if (!roleToRevoke) {
      throw new BadRequestException('user_does_not_have_role');
    }
    if (role === RolesEnum.SUPER_ADMIN) {
      const otherActiveSuperAdmins = await this.prisma.user.count({
        where: {
          id: { not: targetUserId },
          isActive: true,
          userRoles: {
            some: {
              role: {
                name: RolesEnum.SUPER_ADMIN,
              },
            },
          },
        },
      });
      if (otherActiveSuperAdmins === 0) {
        throw new ForbiddenException('cannot_remove_last_super_admin');
      }
    }
    await this.prisma.userRole.delete({
      where: {
        userId_roleId: {
          userId: targetUserId,
          roleId: roleToRevoke.id,
        },
      },
    });
    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────
    this.eventEmitter.emit(AuditEventEnum.USER_ROLE_REVOKED, {
      userId: actor.id,
      entityId: targetUserId,
      entityType: 'USER',
      role,
    });
    return this.getMe({
      id: targetUserId,
    } as CurrentUserDto);
  }
  // ─────────────────────────────────────────────
  // ADMIN — LIST USERS
  // GET /users
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // PRD 23: Admin Portal > Users
  // ─────────────────────────────────────────────
  async listUsers(query: ListUsersQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;
    const where: any = {};
    if (query.search) {
      where.OR = [
        {
          name: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
        {
          phone: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
      ];
    }
    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }
    if (query.discreetModeEnabled !== undefined) {
      where.discreetModeEnabled = query.discreetModeEnabled;
    }
    if (query.roleId) {
      where.userRoles = {
        some: {
          roleId: query.roleId,
        },
      };
    }
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          phone: true,
          isActive: true,
          discreetModeEnabled: true,
          discreetModeUpdatedAt: true,
          createdAt: true,
          updatedAt: true,
          userRoles: {
            select: {
              role: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({
        where,
      }),
    ]);
    return {
      data: users.map((user) => {
        const roles = user.userRoles.map((userRole) => userRole.role);
        const { userRoles: _userRoles, ...userData } = user;
        return {
          ...userData,
          roles,
        };
      }),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
  // ─────────────────────────────────────────────
  // ADMIN — DASHBOARD STATS
  // GET /users/stats
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // PRD 23: Admin Portal > Dashboard
  //
  // Only user-related figures live here, matching this file's
  // scope. Report/Post/MissingPerson/Support counts belong in
  // their own services' dashboard methods, combined at the
  // controller/aggregator level if a single Dashboard endpoint
  // is needed later.
  // ─────────────────────────────────────────────
  async getDashboardStats() {
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
      this.prisma.user.count({
        where: { isActive: true },
      }),
      this.prisma.user.count({
        where: { isActive: false },
      }),
      this.prisma.user.count({
        where: {
          discreetModeEnabled: true,
        },
      }),
      this.prisma.user.count({
        where: {
          createdAt: {
            gte: sevenDaysAgo,
          },
        },
      }),
      this.prisma.user.count({
        where: {
          createdAt: {
            gte: thirtyDaysAgo,
          },
        },
      }),
      this.prisma.role.findMany({
        select: {
          id: true,
          name: true,
          _count: {
            select: {
              userRoles: true,
            },
          },
        },
        orderBy: {
          name: 'asc',
        },
      }),
      // ───────────────────────────────────────────
      // SUPER_ADMIN — number of users holding this role
      // ───────────────────────────────────────────
      this.prisma.user.count({
        where: {
          userRoles: {
            some: {
              role: {
                name: RolesEnum.SUPER_ADMIN,
              },
            },
          },
        },
      }),
      // ───────────────────────────────────────────
      // ADMIN — number of users holding this role
      // ───────────────────────────────────────────
      this.prisma.user.count({
        where: {
          userRoles: {
            some: {
              role: {
                name: RolesEnum.ADMIN,
              },
            },
          },
        },
      }),
      // ───────────────────────────────────────────
      // REGULAR USERS — hold neither admin role
      // ───────────────────────────────────────────
      this.prisma.user.count({
        where: {
          userRoles: {
            none: {
              role: {
                name: {
                  in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN],
                },
              },
            },
          },
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
}

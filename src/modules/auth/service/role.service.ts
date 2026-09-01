import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { Role } from '@prisma/client';

import {
  FetchQuery,
  PaginatedResult,
} from 'src/common/fetch-query/crud.types';

import { buildFindManyArgs } from 'src/common/fetch-query/fetch-query.helper';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { CreateRoleDto, UpdateRoleDto } from '../dto/role.dto';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { RolesEnum } from 'src/common/enums/roles.enum';

// Role names seeded by RolesSeeder that must always exist and must
// never be renamed or deleted through this API — doing so would
// silently break every @Roles(RolesEnum.SUPER_ADMIN) /
// @Roles(RolesEnum.ADMIN) check across the app.
const PROTECTED_ROLE_NAMES: string[] = [
  RolesEnum.SUPER_ADMIN,
  RolesEnum.ADMIN,
];

@Injectable()
export class RoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // GET ALL ROLES
  // ─────────────────────────────────────────────

  async findAll(
    query: FetchQuery,
  ): Promise<PaginatedResult<Role>> {
    const args = buildFindManyArgs(query);

    const [items, total] = await Promise.all([
      this.prisma.role.findMany({
        ...args,
        orderBy: {
          createdAt: 'asc',
        },
      }),

      this.prisma.role.count({
        where: args.where,
      }),
    ]);

    const response = new PaginatedResult<Role>();

    response.total = total;
    response.items = items;

    return response;
  }

  // ─────────────────────────────────────────────
  // GET ROLE BY ID
  // ─────────────────────────────────────────────

  async findOne(id: string): Promise<Role> {
    const role = await this.prisma.role.findUnique({
      where: {
        id,
      },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    return role;
  }

  // ─────────────────────────────────────────────
  // GET USERS HOLDING THIS ROLE
  // GET /roles/:id/users
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // ─────────────────────────────────────────────

  async findUsersWithRole(id: string) {
    const role = await this.prisma.role.findUnique({
      where: {
        id,
      },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    const userRoles = await this.prisma.userRole.findMany({
      where: {
        roleId: id,
      },

      select: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
            isActive: true,
            createdAt: true,
          },
        },
      },
    });

    return userRoles.map((userRole) => userRole.user);
  }

  // ─────────────────────────────────────────────
  // CREATE ROLE
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // PRD 23/24/36: Admin Portal > Roles and Permissions
  // ─────────────────────────────────────────────

  async create(
    actor: CurrentUserDto,
    data: CreateRoleDto,
  ): Promise<Role> {
    const existingRole = await this.prisma.role.findUnique({
      where: {
        name: data.name,
      },
    });

    if (existingRole) {
      throw new ConflictException('role_name_already_in_use');
    }

    const role = await this.prisma.role.create({
      data: {
        name: data.name,
      },
    });

    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────

    this.eventEmitter.emit(AuditEventEnum.ROLE_CREATED, {
      userId: actor.id,
      entityId: role.id,
      entityType: 'ROLE',

      diff: {
        name: data.name,
      },
    });

    return role;
  }

  // ─────────────────────────────────────────────
  // UPDATE ROLE
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // Seeded protected roles (PROTECTED_ROLE_NAMES) cannot be renamed,
  // since @Roles() checks elsewhere in the app depend on their name.
  // ─────────────────────────────────────────────

  async update(
    actor: CurrentUserDto,
    id: string,
    data: UpdateRoleDto,
  ): Promise<Role> {
    const role = await this.prisma.role.findUnique({
      where: {
        id,
      },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    if (
      PROTECTED_ROLE_NAMES.includes(role.name) &&
      data.name !== undefined &&
      data.name !== role.name
    ) {
      throw new BadRequestException('protected_role_cannot_be_renamed');
    }

    if (data.name && data.name !== role.name) {
      const nameTaken = await this.prisma.role.findUnique({
        where: {
          name: data.name,
        },
      });

      if (nameTaken) {
        throw new ConflictException('role_name_already_in_use');
      }
    }

    const updatedRole = await this.prisma.role.update({
      where: {
        id,
      },

      data: {
        ...(data.name !== undefined && { name: data.name }),
      },
    });

    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────

    this.eventEmitter.emit(AuditEventEnum.ROLE_UPDATED, {
      userId: actor.id,
      entityId: id,
      entityType: 'ROLE',

      diff: data,
    });

    return updatedRole;
  }

  // ─────────────────────────────────────────────
  // DELETE ROLE
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // Blocked for seeded protected roles, and blocked while any user
  // still holds the role (delete would silently strip their access).
  // ─────────────────────────────────────────────

  async remove(
    actor: CurrentUserDto,
    id: string,
  ): Promise<{ message: string }> {
    const role = await this.prisma.role.findUnique({
      where: {
        id,
      },

      select: {
        id: true,
        name: true,

        _count: {
          select: {
            userRoles: true,
          },
        },
      },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    if (PROTECTED_ROLE_NAMES.includes(role.name)) {
      throw new BadRequestException('protected_role_cannot_be_deleted');
    }

    if (role._count.userRoles > 0) {
      throw new BadRequestException('role_in_use_by_users');
    }

    await this.prisma.role.delete({
      where: {
        id,
      },
    });

    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────

    this.eventEmitter.emit(AuditEventEnum.ROLE_DELETED, {
      userId: actor.id,
      entityId: id,
      entityType: 'ROLE',

      diff: {
        name: role.name,
      },
    });

    return { message: 'role_deleted' };
  }
}
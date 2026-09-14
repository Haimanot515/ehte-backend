import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { Permission } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import { AssignPermissionsDto } from '../dto/permission.dto';

// ─────────────────────────────────────────────
// ASSUMPTIONS ABOUT THE SCHEMA (verify against your schema.prisma):
//
// - `permission` table: seeded 1:1 from PermissionsEnum values.
//   Permissions are assumed FIXED — defined in code, not
//   creatable/renameable through this API — so there is no
//   PermissionController.create()/update()/remove(), only read
//   and role-assignment.
// - `rolePermission` join table: (roleId, permissionId), mirroring
//   the existing `userRole` join table used for role assignment.
//
// If your schema differs, adjust the prisma calls below —
// the audit-log emission shape and method signatures should
// still be a reasonable starting point either way.
// ─────────────────────────────────────────────

@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // GET ALL PERMISSION DEFINITIONS
  // GET /permissions
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  //
  // Permissions are a small, fixed, code-defined set (see
  // PermissionsEnum) — unlike roles this isn't paginated.
  // ─────────────────────────────────────────────

  async findAll(): Promise<Permission[]> {
    return this.prisma.permission.findMany({
      orderBy: {
        name: 'asc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // GET PERMISSIONS CURRENTLY ON A ROLE
  // GET /permissions/roles/:roleId
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // ─────────────────────────────────────────────

  async findForRole(roleId: string): Promise<Permission[]> {
    const role = await this.prisma.role.findUnique({
      where: {
        id: roleId,
      },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: {
        roleId,
      },

      select: {
        permission: true,
      },

      orderBy: {
        permission: {
          name: 'asc',
        },
      },
    });

    return rolePermissions.map((rp) => rp.permission);
  }

  // ─────────────────────────────────────────────
  // ASSIGN PERMISSIONS TO A ROLE
  // POST /permissions/roles/:roleId
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  //
  // Additive and idempotent: permissions already on the role are
  // skipped rather than causing a conflict, so re-submitting the
  // same list is safe.
  // ─────────────────────────────────────────────

  async assignToRole(
    actor: CurrentUserDto,
    roleId: string,
    data: AssignPermissionsDto,
  ): Promise<Permission[]> {
    const role = await this.prisma.role.findUnique({
      where: {
        id: roleId,
      },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    const permissions = await this.prisma.permission.findMany({
      where: {
        name: {
          in: data.permissions,
        },
      },
    });

    const foundNames = new Set(permissions.map((p) => p.name));
    const missing = data.permissions.filter((name) => !foundNames.has(name));

    if (missing.length > 0) {
      throw new BadRequestException(`unknown_permission: ${missing.join(', ')}`);
    }

    const existing = await this.prisma.rolePermission.findMany({
      where: {
        roleId,
        permissionId: {
          in: permissions.map((p) => p.id),
        },
      },
    });

    const existingPermissionIds = new Set(existing.map((rp) => rp.permissionId));
    const toCreate = permissions.filter((p) => !existingPermissionIds.has(p.id));

    if (toCreate.length > 0) {
      await this.prisma.rolePermission.createMany({
        data: toCreate.map((p) => ({
          roleId,
          permissionId: p.id,
        })),
      });

      // ─────────────────────────────────────────
      // AUDIT LOG
      // ─────────────────────────────────────────

      this.eventEmitter.emit(AuditEventEnum.PERMISSION_ASSIGNED, {
        userId: actor.id,
        entityId: roleId,
        entityType: 'ROLE',

        diff: {
          added: toCreate.map((p) => p.name),
        },
      });
    }

    return this.findForRole(roleId);
  }

  // ─────────────────────────────────────────────
  // REVOKE A PERMISSION FROM A ROLE
  // DELETE /permissions/roles/:roleId/:permissionName
  // Restricted to SUPER_ADMIN at the controller (Roles guard)
  // ─────────────────────────────────────────────

  async revokeFromRole(
    actor: CurrentUserDto,
    roleId: string,
    permissionName: PermissionsEnum,
  ): Promise<{ message: string }> {
    const role = await this.prisma.role.findUnique({
      where: {
        id: roleId,
      },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    const permission = await this.prisma.permission.findUnique({
      where: {
        name: permissionName,
      },
    });

    if (!permission) {
      throw new NotFoundException('permission_not_found');
    }

    const rolePermission = await this.prisma.rolePermission.findFirst({
      where: {
        roleId,
        permissionId: permission.id,
      },
    });

    if (!rolePermission) {
      throw new NotFoundException('role_does_not_have_permission');
    }

    await this.prisma.rolePermission.delete({
      where: {
        id: rolePermission.id,
      },
    });

    // ───────────────────────────────────────────
    // AUDIT LOG
    // ───────────────────────────────────────────

    this.eventEmitter.emit(AuditEventEnum.PERMISSION_REVOKED, {
      userId: actor.id,
      entityId: roleId,

      entityType: 'ROLE',

      diff: {
        removed: permission.name,
      },
    });

    return { message: 'permission_revoked' };
  }
}

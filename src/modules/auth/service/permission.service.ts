import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { AuditOutcome, AuditSeverity, Permission, Prisma } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import { AssignPermissionsDto, RevokePermissionsDto, SetPermissionsDto } from '../dto/permission.dto';

// Permission table is seeded 1:1 from PermissionsEnum; rolePermission is the
// (roleId, permissionId) join table. Requires the AuditEventEnum additions.

@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private isNotFoundError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
  }

  async findAll(): Promise<Permission[]> {
    return this.prisma.permission.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async findForRole(roleId: string): Promise<Permission[]> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: true },
      orderBy: { permission: { name: 'asc' } },
    });

    return rolePermissions.map((rp) => rp.permission);
  }

  // Reverse lookup: which roles currently have a given permission.
  async findRolesForPermission(permissionName: PermissionsEnum) {
    const permission = await this.prisma.permission.findUnique({
      where: { name: permissionName },
    });

    if (!permission) {
      throw new NotFoundException('permission_not_found');
    }

    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { permissionId: permission.id },
      select: { role: true },
      orderBy: { role: { name: 'asc' } },
    });

    return rolePermissions.map((rp) => rp.role);
  }

  // Aggregates permissions across every role a user holds. Admin support tool, not self-service.
  async getEffectivePermissionsForUser(userId: string): Promise<Permission[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      select: {
        role: {
          select: {
            rolePermissions: {
              select: { permission: true },
            },
          },
        },
      },
    });

    const byId = new Map<string, Permission>();

    for (const ur of userRoles) {
      for (const rp of ur.role.rolePermissions) {
        byId.set(rp.permission.id, rp.permission);
      }
    }

    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async assignToRole(
    actor: CurrentUserDto,
    roleId: string,
    data: AssignPermissionsDto,
  ): Promise<Permission[]> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { _count: { select: { userRoles: true } } },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    const permissions = await this.prisma.permission.findMany({
      where: { name: { in: data.permissions } },
    });

    const foundNames = new Set(permissions.map((p) => p.name));
    const missing = data.permissions.filter((name) => !foundNames.has(name));

    if (missing.length > 0) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action: AuditEventEnum.PERMISSION_ASSIGNED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: roleId,
        entityLabel: role.name,
        diff: {
          result: 'failure',
          reason: 'unknown_permission',
          missingPermissions: missing,
        },
        metadata: { requestedCount: data.permissions.length },
      });
      throw new BadRequestException(`unknown_permission: ${missing.join(', ')}`);
    }

    const existing = await this.prisma.rolePermission.findMany({
      where: { roleId, permissionId: { in: permissions.map((p) => p.id) } },
    });

    const existingPermissionIds = new Set(existing.map((rp) => rp.permissionId));
    const toCreate = permissions.filter((p) => !existingPermissionIds.has(p.id));

    if (toCreate.length > 0) {
      // skipDuplicates makes this atomic — a concurrent duplicate insert is silently skipped, not thrown.
      await this.prisma.rolePermission.createMany({
        data: toCreate.map((p) => ({ roleId, permissionId: p.id })),
        skipDuplicates: true,
      });

      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action: AuditEventEnum.PERMISSION_ASSIGNED,
        entity: 'Role',
        entityId: roleId,
        entityLabel: role.name,
        diff: {
          result: 'success',
          added: toCreate.map((p) => p.name),
        },
        metadata: {
          usersWithRole: role._count.userRoles,
          requestedCount: data.permissions.length,
          skippedAlreadyAssigned: permissions.length - toCreate.length,
        },
      });
    }

    return this.findForRole(roleId);
  }

  // Bulk revoke. POST, not DELETE-with-body — some clients/proxies strip DELETE bodies.
  async revokeManyFromRole(
    actor: CurrentUserDto,
    roleId: string,
    data: RevokePermissionsDto,
  ): Promise<Permission[]> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { _count: { select: { userRoles: true } } },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    const permissions = await this.prisma.permission.findMany({
      where: { name: { in: data.permissions } },
    });

    const foundNames = new Set(permissions.map((p) => p.name));
    const missing = data.permissions.filter((name) => !foundNames.has(name));

    if (missing.length > 0) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action: AuditEventEnum.PERMISSIONS_BULK_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: roleId,
        entityLabel: role.name,
        diff: {
          result: 'failure',
          reason: 'unknown_permission',
          missingPermissions: missing,
        },
        metadata: { requestedCount: data.permissions.length },
      });
      throw new BadRequestException(`unknown_permission: ${missing.join(', ')}`);
    }

    const { count } = await this.prisma.rolePermission.deleteMany({
      where: { roleId, permissionId: { in: permissions.map((p) => p.id) } },
    });

    if (count > 0) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action: AuditEventEnum.PERMISSIONS_BULK_REVOKED,
        entity: 'Role',
        entityId: roleId,
        entityLabel: role.name,
        diff: {
          result: 'success',
          removed: permissions.map((p) => p.name),
        },
        metadata: {
          usersWithRole: role._count.userRoles,
          requestedCount: data.permissions.length,
          actuallyRemoved: count,
        },
      });
    }

    return this.findForRole(roleId);
  }

  // Replace the role's entire permission list in one transaction; diff computed against current state.
  async setForRole(
    actor: CurrentUserDto,
    roleId: string,
    data: SetPermissionsDto,
  ): Promise<Permission[]> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { _count: { select: { userRoles: true } } },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    const targetPermissions = await this.prisma.permission.findMany({
      where: { name: { in: data.permissions } },
    });

    const foundNames = new Set(targetPermissions.map((p) => p.name));
    const missing = data.permissions.filter((name) => !foundNames.has(name));

    if (missing.length > 0) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action: AuditEventEnum.PERMISSIONS_SET_REPLACED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: roleId,
        entityLabel: role.name,
        diff: {
          result: 'failure',
          reason: 'unknown_permission',
          missingPermissions: missing,
        },
        metadata: { requestedCount: data.permissions.length },
      });
      throw new BadRequestException(`unknown_permission: ${missing.join(', ')}`);
    }

    const current = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: true },
    });

    const currentIds = new Set(current.map((rp) => rp.permission.id));
    const targetIds = new Set(targetPermissions.map((p) => p.id));

    const toAdd = targetPermissions.filter((p) => !currentIds.has(p.id));
    const toRemove = current.map((rp) => rp.permission).filter((p) => !targetIds.has(p.id));

    if (toAdd.length === 0 && toRemove.length === 0) {
      return this.findForRole(roleId);
    }

    await this.prisma.$transaction([
      ...(toRemove.length > 0
        ? [
            this.prisma.rolePermission.deleteMany({
              where: { roleId, permissionId: { in: toRemove.map((p) => p.id) } },
            }),
          ]
        : []),
      ...(toAdd.length > 0
        ? [
            this.prisma.rolePermission.createMany({
              data: toAdd.map((p) => ({ roleId, permissionId: p.id })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action: AuditEventEnum.PERMISSIONS_SET_REPLACED,
      entity: 'Role',
      entityId: roleId,
      entityLabel: role.name,
      diff: {
        result: 'success',
        added: toAdd.map((p) => p.name),
        removed: toRemove.map((p) => p.name),
      },
      metadata: {
        usersWithRole: role._count.userRoles,
        finalCount: data.permissions.length,
      },
    });

    return this.findForRole(roleId);
  }

  async revokeFromRole(
    actor: CurrentUserDto,
    roleId: string,
    permissionName: PermissionsEnum,
  ): Promise<{ message: string }> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { _count: { select: { userRoles: true } } },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    const permission = await this.prisma.permission.findUnique({
      where: { name: permissionName },
    });

    if (!permission) {
      throw new NotFoundException('permission_not_found');
    }

    const rolePermission = await this.prisma.rolePermission.findFirst({
      where: { roleId, permissionId: permission.id },
    });

    if (!rolePermission) {
      throw new NotFoundException('role_does_not_have_permission');
    }

    try {
      await this.prisma.rolePermission.delete({ where: { id: rolePermission.id } });
    } catch (error) {
      if (this.isNotFoundError(error)) {
        // Deleted concurrently between the check and this call.
        throw new NotFoundException('role_does_not_have_permission');
      }
      throw error;
    }

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action: AuditEventEnum.PERMISSION_REVOKED,
      entity: 'Role',
      entityId: roleId,
      entityLabel: role.name,
      diff: { result: 'success', removed: permission.name },
      metadata: { usersWithRole: role._count.userRoles },
    });

    return { message: 'permission_revoked' };
  }
}
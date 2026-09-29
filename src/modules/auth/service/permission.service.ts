import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { AuditOutcome, AuditSeverity, Permission, Prisma } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CacheService } from 'src/services/redis/cache.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import {
  AssignPermissionsDto,
  RevokePermissionsDto,
  SetPermissionsDto,
} from '../dto/permission.dto';

import { isPermissionLockedRole } from '../util/role-protection.util';

// Permission table is seeded 1:1 from PermissionsEnum; rolePermission is the
// (roleId, permissionId) join table. Requires the AuditEventEnum additions.

const INVALIDATION_CHUNK_SIZE = 500;

type RoleWithCount = {
  id: string;
  name: string;
  _count: { userRoles: number };
};

type InvalidationResult = {
  usersInvalidated: number;
  sessionsRevoked: number;
  invalidationFailed: boolean;
};

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: CacheService,
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

  private isForeignKeyError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
  }

  private isWriteConflictError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
  }

  // ─── shared helpers ────────────────────────────────────────────────────

  private async loadRoleOrThrow(
    actor: CurrentUserDto,
    roleId: string,
    action: AuditEventEnum,
  ): Promise<RoleWithCount> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { _count: { select: { userRoles: true } } },
    });

    if (!role) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: roleId,
        diff: { result: 'failure', reason: 'role_not_found' },
      });
      throw new NotFoundException('role_not_found');
    }

    return role;
  }

  // GAP FIX #1: PermissionService previously ignored role protection entirely,
  // so PUT /permissions/roles/:id with [] could strip SUPER_ADMIN.
  private assertPermissionsEditable(
    actor: CurrentUserDto,
    role: RoleWithCount,
    action: AuditEventEnum,
    attempted: string[],
  ): void {
    if (!isPermissionLockedRole(role)) return;

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action,
      outcome: AuditOutcome.DENIED,
      severity: AuditSeverity.WARNING,
      entity: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      diff: {
        result: 'denied',
        reason: 'protected_role_permissions_locked',
        attemptedPermissions: attempted,
      },
    });

    throw new ForbiddenException('protected_role_permissions_locked');
  }

  private async resolvePermissionsOrThrow(
    actor: CurrentUserDto,
    role: RoleWithCount,
    names: PermissionsEnum[],
    action: AuditEventEnum,
  ): Promise<Permission[]> {
    const permissions = await this.prisma.permission.findMany({
      where: { name: { in: names } },
    });

    const foundNames = new Set(permissions.map((p) => p.name));
    const missing = names.filter((name) => !foundNames.has(name));

    if (missing.length > 0) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: role.id,
        entityLabel: role.name,
        diff: {
          result: 'failure',
          reason: 'unknown_permission',
          missingPermissions: missing,
        },
        metadata: { requestedCount: names.length },
      });
      throw new BadRequestException(`unknown_permission: ${missing.join(', ')}`);
    }

    return permissions;
  }

  // GAP FIX #2: permissions are baked into the JWT at login, so a change to a
  // role used to have no effect until the token expired.
  //
  //  - revokeSessions=true  (something was REMOVED): delete every session of
  //    every holder, so their refresh token dies and the next login/refresh
  //    rebuilds permissions from the DB. Sessions are deleted (not marked
  //    revokedAt) because AuthService.refresh() treats a revokedAt session as
  //    a stolen-token replay and raises a false SECURITY_ALERT.
  //  - revokeSessions=false (only ADDED): just purge the Redis profile/session
  //    cache; holders pick the new permission up on next refresh.
  //
  // Failures here must not undo a committed permission change, so they are
  // logged and reported in the audit metadata instead of thrown.
  private async invalidateRoleHolders(
    roleId: string,
    revokeSessions: boolean,
  ): Promise<InvalidationResult> {
    const result: InvalidationResult = {
      usersInvalidated: 0,
      sessionsRevoked: 0,
      invalidationFailed: false,
    };

    try {
      const holders = await this.prisma.userRole.findMany({
        where: { roleId },
        select: { userId: true },
      });

      const userIds = [...new Set(holders.map((h) => h.userId))];
      result.usersInvalidated = userIds.length;

      for (let i = 0; i < userIds.length; i += INVALIDATION_CHUNK_SIZE) {
        const chunk = userIds.slice(i, i + INVALIDATION_CHUNK_SIZE);

        if (revokeSessions) {
          const deleted = await this.prisma.session.deleteMany({
            where: { userId: { in: chunk } },
          });
          result.sessionsRevoked += deleted.count;
        }

        await Promise.all(chunk.map((userId) => this.cache.purgeUserCache(userId)));
      }
    } catch (error) {
      result.invalidationFailed = true;
      this.logger.error(
        `Failed to invalidate holders of role ${roleId} after a permission change`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return result;
  }

  // ─── reads ─────────────────────────────────────────────────────────────

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

  // ─── writes ────────────────────────────────────────────────────────────

  async assignToRole(
    actor: CurrentUserDto,
    roleId: string,
    data: AssignPermissionsDto,
  ): Promise<Permission[]> {
    const role = await this.loadRoleOrThrow(actor, roleId, AuditEventEnum.PERMISSION_ASSIGNED);

    this.assertPermissionsEditable(
      actor,
      role,
      AuditEventEnum.PERMISSION_ASSIGNED,
      data.permissions,
    );

    const permissions = await this.resolvePermissionsOrThrow(
      actor,
      role,
      data.permissions,
      AuditEventEnum.PERMISSION_ASSIGNED,
    );

    const existing = await this.prisma.rolePermission.findMany({
      where: { roleId, permissionId: { in: permissions.map((p) => p.id) } },
    });

    const existingPermissionIds = new Set(existing.map((rp) => rp.permissionId));
    const toCreate = permissions.filter((p) => !existingPermissionIds.has(p.id));

    if (toCreate.length > 0) {
      try {
        // skipDuplicates makes this atomic — a concurrent duplicate insert is silently skipped, not thrown.
        await this.prisma.rolePermission.createMany({
          data: toCreate.map((p) => ({ roleId, permissionId: p.id })),
          skipDuplicates: true,
        });
      } catch (error) {
        // Role was deleted between the lookup and the insert.
        if (this.isForeignKeyError(error)) {
          throw new NotFoundException('role_not_found');
        }
        throw error;
      }

      // Additions only: purge caches, no need to kill sessions.
      const invalidation = await this.invalidateRoleHolders(roleId, false);

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
          ...invalidation,
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
    const role = await this.loadRoleOrThrow(
      actor,
      roleId,
      AuditEventEnum.PERMISSIONS_BULK_REVOKED,
    );

    this.assertPermissionsEditable(
      actor,
      role,
      AuditEventEnum.PERMISSIONS_BULK_REVOKED,
      data.permissions,
    );

    const permissions = await this.resolvePermissionsOrThrow(
      actor,
      role,
      data.permissions,
      AuditEventEnum.PERMISSIONS_BULK_REVOKED,
    );

    const { count } = await this.prisma.rolePermission.deleteMany({
      where: { roleId, permissionId: { in: permissions.map((p) => p.id) } },
    });

    if (count > 0) {
      // Something was removed: holders must not keep the old permission in a live token.
      const invalidation = await this.invalidateRoleHolders(roleId, true);

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
          ...invalidation,
        },
      });
    }

    return this.findForRole(roleId);
  }

  // Replace the role's entire permission list in ONE serializable transaction.
  // GAP FIX: the current-state read used to happen outside the transaction, so
  // two concurrent PUTs computed diffs from stale data (last write silently won).
  async setForRole(
    actor: CurrentUserDto,
    roleId: string,
    data: SetPermissionsDto,
  ): Promise<Permission[]> {
    const role = await this.loadRoleOrThrow(actor, roleId, AuditEventEnum.PERMISSIONS_SET_REPLACED);

    this.assertPermissionsEditable(
      actor,
      role,
      AuditEventEnum.PERMISSIONS_SET_REPLACED,
      data.permissions,
    );

    const targetPermissions = await this.resolvePermissionsOrThrow(
      actor,
      role,
      data.permissions,
      AuditEventEnum.PERMISSIONS_SET_REPLACED,
    );

    const targetIds = new Set(targetPermissions.map((p) => p.id));

    let diff: { toAdd: Permission[]; toRemove: Permission[] };

    try {
      diff = await this.prisma.$transaction(
        async (tx) => {
          const current = await tx.rolePermission.findMany({
            where: { roleId },
            select: { permission: true },
          });

          const currentIds = new Set(current.map((rp) => rp.permission.id));

          const toAdd = targetPermissions.filter((p) => !currentIds.has(p.id));
          const toRemove = current.map((rp) => rp.permission).filter((p) => !targetIds.has(p.id));

          if (toRemove.length > 0) {
            await tx.rolePermission.deleteMany({
              where: { roleId, permissionId: { in: toRemove.map((p) => p.id) } },
            });
          }

          if (toAdd.length > 0) {
            await tx.rolePermission.createMany({
              data: toAdd.map((p) => ({ roleId, permissionId: p.id })),
              skipDuplicates: true,
            });
          }

          return { toAdd, toRemove };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (this.isWriteConflictError(error)) {
        this.emitAudit({
          userId: actor.id,
          actorType: resolveActorType(actor.roles ?? []),
          action: AuditEventEnum.PERMISSIONS_SET_REPLACED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'Role',
          entityId: roleId,
          entityLabel: role.name,
          diff: { result: 'failure', reason: 'concurrent_permission_update' },
        });
        throw new ConflictException('concurrent_permission_update_retry');
      }
      if (this.isForeignKeyError(error)) {
        throw new NotFoundException('role_not_found');
      }
      throw error;
    }

    const { toAdd, toRemove } = diff;

    if (toAdd.length === 0 && toRemove.length === 0) {
      return this.findForRole(roleId);
    }

    const invalidation = await this.invalidateRoleHolders(roleId, toRemove.length > 0);

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
        ...invalidation,
      },
    });

    return this.findForRole(roleId);
  }

  async revokeFromRole(
    actor: CurrentUserDto,
    roleId: string,
    permissionName: PermissionsEnum,
  ): Promise<{ message: string }> {
    const role = await this.loadRoleOrThrow(actor, roleId, AuditEventEnum.PERMISSION_REVOKED);

    this.assertPermissionsEditable(actor, role, AuditEventEnum.PERMISSION_REVOKED, [
      permissionName,
    ]);

    const permission = await this.prisma.permission.findUnique({
      where: { name: permissionName },
    });

    // GAP FIX: these two failure paths used to be un-audited.
    if (!permission) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action: AuditEventEnum.PERMISSION_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: roleId,
        entityLabel: role.name,
        diff: { result: 'failure', reason: 'permission_not_found', attempted: permissionName },
      });
      throw new NotFoundException('permission_not_found');
    }

    const rolePermission = await this.prisma.rolePermission.findFirst({
      where: { roleId, permissionId: permission.id },
    });

    if (!rolePermission) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action: AuditEventEnum.PERMISSION_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: roleId,
        entityLabel: role.name,
        diff: {
          result: 'failure',
          reason: 'role_does_not_have_permission',
          attempted: permissionName,
        },
      });
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

    const invalidation = await this.invalidateRoleHolders(roleId, true);

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action: AuditEventEnum.PERMISSION_REVOKED,
      entity: 'Role',
      entityId: roleId,
      entityLabel: role.name,
      diff: { result: 'success', removed: permission.name },
      metadata: { usersWithRole: role._count.userRoles, ...invalidation },
    });

    return { message: 'permission_revoked' };
  }
}

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
  SimulatePermissionDto,
  PermissionDiffQueryDto,
} from '../dto/permission.dto';

import { isPermissionLockedRole } from '../util/role-protection.util';
import { findDutyConflicts, isSensitivePermission } from 'src/common/utils/permission-risk.util';

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
    const role = await this.loadRoleOrThrow(actor, roleId, AuditEventEnum.PERMISSIONS_BULK_REVOKED);

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

  private groupOf(name: string): string {
    const cut = name.indexOf('_');
    return cut > 0 ? name.slice(0, cut) : name;
  }

  // AR-47
  async groups() {
    const permissions = await this.prisma.permission.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, description: true },
    });

    const groups = new Map<string, typeof permissions>();

    for (const permission of permissions) {
      const key = this.groupOf(permission.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(permission);
    }

    return [...groups.entries()].map(([group, items]) => ({
      group,
      count: items.length,
      permissions: items,
    }));
  }

  // AR-48
  async findOneWithRoles(name: PermissionsEnum) {
    const permission = await this.prisma.permission.findUnique({
      where: { name },
      include: {
        rolePermissions: { select: { role: { select: { id: true, name: true } } } },
      },
    });

    if (!permission) {
      throw new NotFoundException('permission_not_found');
    }

    return {
      id: permission.id,
      name: permission.name,
      description: permission.description,
      group: this.groupOf(permission.name),
      sensitive: isSensitivePermission(permission.name),
      roles: permission.rolePermissions
        .map((rp) => rp.role)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // AR-49. Each role lists the permission names it holds; the client draws the grid.
  async matrix() {
    const [permissions, roles] = await Promise.all([
      this.prisma.permission.findMany({ orderBy: { name: 'asc' }, select: { name: true } }),
      this.prisma.role.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          archivedAt: true,
          rolePermissions: { select: { permission: { select: { name: true } } } },
        },
      }),
    ]);

    return {
      permissions: permissions.map((p) => p.name),
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        archived: role.archivedAt !== null,
        granted: role.rolePermissions.map((rp) => rp.permission.name).sort(),
      })),
    };
  }

  // AR-50. Route usage is not checked here: that needs the route metadata scan,
  // which this service cannot see. Only "held by no role" is reported.
  async unused() {
    const permissions = await this.prisma.permission.findMany({
      where: { rolePermissions: { none: {} } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, description: true },
    });

    return { heldByNoRole: permissions, routeUsageChecked: false };
  }

  // AR-51. Adds any PermissionsEnum value missing from the table. Never deletes or edits rows.
  async sync(actor: CurrentUserDto) {
    const wanted = Object.values(PermissionsEnum) as string[];

    const existing = await this.prisma.permission.findMany({ select: { name: true } });
    const existingNames = new Set(existing.map((p) => p.name));

    const missing = wanted.filter((name) => !existingNames.has(name));
    const orphaned = [...existingNames].filter((name) => !wanted.includes(name));

    if (missing.length > 0) {
      await this.prisma.permission.createMany({
        data: missing.map((name) => ({ name })),
        skipDuplicates: true,
      });
    }

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action: AuditEventEnum.PERMISSIONS_SYNCED,
      entity: 'Permission',
      entityId: null,
      diff: { result: 'success', created: missing, orphaned },
      metadata: { createdCount: missing.length, orphanedCount: orphaned.length },
    });

    return { created: missing, orphanedInDatabase: orphaned, total: wanted.length };
  }

  // AR-52. Read-only. Pass roleIds, or a userId to test that person's current roles.
  async simulate(data: SimulatePermissionDto) {
    let roleFilter: Prisma.RoleWhereInput;
    let subject: { type: 'roles' | 'user'; id?: string };

    if (data.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: data.userId },
        select: { id: true },
      });
      if (!user) {
        throw new NotFoundException('user_not_found');
      }
      roleFilter = { userRoles: { some: { userId: user.id } } };
      subject = { type: 'user', id: user.id };
    } else if (data.roleIds && data.roleIds.length > 0) {
      roleFilter = { id: { in: data.roleIds } };
      subject = { type: 'roles' };
    } else {
      throw new BadRequestException('role_ids_or_user_id_required');
    }

    const roles = await this.prisma.role.findMany({
      where: roleFilter,
      select: {
        id: true,
        name: true,
        rolePermissions: {
          where: { permission: { name: data.permission } },
          select: { permissionId: true },
        },
      },
    });

    if (data.roleIds && !data.userId && roles.length !== new Set(data.roleIds).size) {
      throw new NotFoundException('role_not_found');
    }

    const grantedBy = roles.filter((r) => r.rolePermissions.length > 0).map((r) => r.name);

    return {
      permission: data.permission,
      subject,
      decision: grantedBy.length > 0 ? 'allow' : 'deny',
      grantedBy,
      evaluatedRoles: roles.map((r) => r.name),
    };
  }

  // AR-53
  async sensitive() {
    const permissions = await this.prisma.permission.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        rolePermissions: { select: { role: { select: { id: true, name: true } } } },
      },
    });

    return permissions
      .filter((p) => isSensitivePermission(p.name))
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        roles: p.rolePermissions.map((rp) => rp.role),
      }));
  }

  // AR-54. Conflicts inside one role, and conflicts that appear when a person holds several roles.
  async conflicts() {
    const roles = await this.prisma.role.findMany({
      select: {
        id: true,
        name: true,
        rolePermissions: { select: { permission: { select: { name: true } } } },
      },
    });

    const permissionsByRole = new Map(
      roles.map((r) => [r.id, new Set(r.rolePermissions.map((rp) => rp.permission.name))]),
    );

    const withinRole = roles
      .map((role) => ({
        role: { id: role.id, name: role.name },
        conflicts: findDutyConflicts(permissionsByRole.get(role.id)!),
      }))
      .filter((entry) => entry.conflicts.length > 0);

    // Staff only (anyone holding more than one role), capped so the call stays fast.
    const staff = await this.prisma.user.findMany({
      where: { userRoles: { some: {} }, isActive: true },
      take: 500,
      select: {
        id: true,
        name: true,
        email: true,
        userRoles: { select: { role: { select: { id: true, name: true } } } },
      },
    });

    const acrossRoles = staff
      .filter((user) => user.userRoles.length > 1)
      .map((user) => {
        const union = new Set<string>();
        for (const ur of user.userRoles) {
          for (const name of permissionsByRole.get(ur.role.id) ?? []) union.add(name);
        }
        return {
          user: { id: user.id, name: user.name, email: user.email },
          roles: user.userRoles.map((ur) => ur.role.name),
          conflicts: findDutyConflicts(union),
        };
      })
      .filter((entry) => entry.conflicts.length > 0);

    // Conflicts already inside one role would repeat for every holder; keep the second list to
    // conflicts that only appear because of the combination.
    const roleConflictKeys = new Set(
      withinRole.flatMap((e) => e.conflicts.map((c) => `${e.role.id}:${c.permissions.join('|')}`)),
    );

    return {
      withinRole,
      acrossRoles: acrossRoles.filter((entry) => entry.roles.length > 1 || !roleConflictKeys.size),
    };
  }

  // AR-55. Built from audit events, so it shows what changed and when, not a full before/after
  // snapshot of the permission set.
  async diffForUser(userId: string, query: PermissionDiffQueryDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    const from = new Date(query.from);
    const to = query.to ? new Date(query.to) : new Date();

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new BadRequestException('invalid_period');
    }

    const heldRoleIds = (
      await this.prisma.userRole.findMany({ where: { userId }, select: { roleId: true } })
    ).map((ur) => ur.roleId);

    const events = await this.prisma.auditLog.findMany({
      where: {
        createdAt: { gte: from, lte: to },
        outcome: 'SUCCESS',
        OR: [
          {
            targetUserId: userId,
            action: {
              in: [
                AuditEventEnum.USER_ROLE_ASSIGNED,
                AuditEventEnum.USER_ROLE_REVOKED,
                AuditEventEnum.ROLE_TEMPORARY_GRANTED,
                AuditEventEnum.ROLE_TEMPORARY_EXPIRED,
                AuditEventEnum.ROLE_ASSIGNMENT_APPROVED,
              ],
            },
          },
          {
            entity: 'Role',
            entityId: { in: heldRoleIds },
            action: {
              in: [
                AuditEventEnum.PERMISSIONS_SET_REPLACED,
                AuditEventEnum.PERMISSION_REVOKED,
                AuditEventEnum.PERMISSION_ASSIGNED,
                AuditEventEnum.PERMISSIONS_BULK_REVOKED,
              ],
            },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
      select: {
        createdAt: true,
        action: true,
        entity: true,
        entityId: true,
        entityLabel: true,
        diff: true,
      },
    });

    return {
      userId,
      period: { from, to },
      currentEffective: (await this.getEffectivePermissionsForUser(userId)).map((p) => p.name),
      events,
    };
  }

  // AR-81
  async statsUsage() {
    const permissions = await this.prisma.permission.findMany({
      orderBy: { name: 'asc' },
      select: {
        name: true,
        rolePermissions: {
          select: { role: { select: { id: true, _count: { select: { userRoles: true } } } } },
        },
      },
    });

    // Distinct holders per permission need a second pass, since one user can hold several roles.
    const holders = await this.prisma.userRole.findMany({
      select: { userId: true, roleId: true },
    });
    const usersByRole = new Map<string, Set<string>>();
    for (const h of holders) {
      if (!usersByRole.has(h.roleId)) usersByRole.set(h.roleId, new Set());
      usersByRole.get(h.roleId)!.add(h.userId);
    }

    const rows = permissions.map((permission) => {
      const users = new Set<string>();
      for (const rp of permission.rolePermissions) {
        for (const id of usersByRole.get(rp.role.id) ?? []) users.add(id);
      }
      return {
        name: permission.name,
        roleCount: permission.rolePermissions.length,
        userCount: users.size,
        sensitive: isSensitivePermission(permission.name),
      };
    });

    return {
      permissions: rows,
      totals: {
        permissions: rows.length,
        heldByNoRole: rows.filter((r) => r.roleCount === 0).length,
        heldByNoUser: rows.filter((r) => r.userCount === 0).length,
      },
      routeUsageChecked: false,
    };
  }
}

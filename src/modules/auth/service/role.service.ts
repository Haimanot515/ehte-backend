import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { AuditOutcome, AuditSeverity, Prisma, Role } from '@prisma/client';

import { FetchQuery, PaginatedResult } from 'src/common/fetch-query/crud.types';

import { buildFindManyArgs } from 'src/common/fetch-query/fetch-query.helper';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import {
  CreateRoleDto,
  UpdateRoleDto,
  AssignRoleToUserDto,
  RemoveRoleFromUserDto,
  BulkRoleAssignmentDto,
  RequestRoleAssignmentDto,
  ReviewRoleAssignmentRequestDto,
  CloneRoleDto,
  ArchiveRoleDto,
  CompareRolesQueryDto,
  ApplyRoleTemplateDto,
  TemporaryRoleAssignmentDto,
} from '../dto/role.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';
import {
  hasStaffRole,
  isPermissionLockedRole,
  isProtectedRole,
} from '../util/role-protection.util';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { requiresTwoPersonApproval } from 'src/common/utils/permission-risk.util';
import { CacheService } from 'src/services/redis/cache.service';

// ── constants for the new role features ──
const ASSIGNMENT_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TEMPORARY_ASSIGNMENT_MS = 365 * 24 * 60 * 60 * 1000;

const ROLE_TEMPLATES: {
  id: string;
  name: string;
  description: string;
  permissions: PermissionsEnum[];
}[] = [
  {
    id: 'reviewer',
    name: 'REVIEWER',
    description:
      'Reads and reviews reports, posts, missing-person cases, tips and victim profiles.',
    permissions: [
      PermissionsEnum.DASHBOARD_READ,
      PermissionsEnum.REPORT_READ,
      PermissionsEnum.REPORT_REVIEW,
      PermissionsEnum.REPORT_REQUEST_INFO,
      PermissionsEnum.POST_READ,
      PermissionsEnum.POST_REVIEW,
      PermissionsEnum.MISSING_PERSON_READ,
      PermissionsEnum.MISSING_PERSON_REVIEW,
      PermissionsEnum.MISSING_PERSON_INFO_READ,
      PermissionsEnum.MISSING_PERSON_INFO_REVIEW,
      PermissionsEnum.PROFILE_READ,
      PermissionsEnum.PROFILE_REVIEW,
    ],
  },
  {
    id: 'finance-officer',
    name: 'FINANCE_OFFICER',
    description:
      'Reads support and payments, verifies reward claims and prepares disbursements. Cannot approve or pay them out.',
    permissions: [
      PermissionsEnum.DASHBOARD_READ,
      PermissionsEnum.SUPPORT_READ,
      PermissionsEnum.SUPPORT_PAYMENT_READ,
      PermissionsEnum.REWARDS_VERIFY_CLAIM,
      PermissionsEnum.DISBURSEMENTS_CREATE,
    ],
  },
  {
    id: 'support-agent',
    name: 'SUPPORT_AGENT',
    description:
      'Read-only view of cases, posts, profiles, support and users, to help people who write in.',
    permissions: [
      PermissionsEnum.DASHBOARD_READ,
      PermissionsEnum.REPORT_READ,
      PermissionsEnum.POST_READ,
      PermissionsEnum.MISSING_PERSON_READ,
      PermissionsEnum.PROFILE_READ,
      PermissionsEnum.SUPPORT_READ,
      PermissionsEnum.USER_READ,
      PermissionsEnum.NOTIFICATION_READ,
    ],
  },
];

@Injectable()
export class RoleService {
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

  private isProtected(role: { name: string; isProtected?: boolean }): boolean {
    return isProtectedRole(role);
  }

  async findAll(query: FetchQuery): Promise<PaginatedResult<Role>> {
    const args = buildFindManyArgs(query);

    const [items, total] = await Promise.all([
      this.prisma.role.findMany({
        ...args,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.role.count({ where: args.where }),
    ]);

    const response = new PaginatedResult<Role>();
    response.total = total;
    response.items = items;
    return response;
  }

  async findOne(id: string): Promise<Role> {
    const role = await this.prisma.role.findUnique({ where: { id } });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    return role;
  }

  // Now audited — returns other users' names/phones, previously unaudited PII exposure.
  async findUsersWithRole(actor: CurrentUserDto, id: string) {
    const role = await this.prisma.role.findUnique({ where: { id } });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    const userRoles = await this.prisma.userRole.findMany({
      where: { roleId: id },
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

    const users = userRoles.map((userRole) => userRole.user);

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action: AuditEventEnum.ROLE_MEMBERS_VIEWED,
      entity: 'Role',
      entityId: id,
      entityLabel: role.name,
      diff: { result: 'success' },
      metadata: {
        viewedUserCount: users.length,
        viewedUserIds: users.map((u) => u.id),
      },
    });

    return users;
  }

  async create(actor: CurrentUserDto, data: CreateRoleDto): Promise<Role> {
    const existingRole = await this.prisma.role.findUnique({ where: { name: data.name } });

    if (existingRole) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action: AuditEventEnum.ROLE_CREATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: existingRole.id,
        entityLabel: existingRole.name,
        diff: {
          result: 'failure',
          reason: 'role_name_already_in_use',
          attemptedName: data.name,
        },
        metadata: { conflictingRoleId: existingRole.id },
      });
      throw new ConflictException('role_name_already_in_use');
    }

    let role: Role;
    try {
      role = await this.prisma.role.create({
        data: {
          name: data.name,
          description: data.description ?? null,
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        // Lost the race to a concurrent create with the same name.
        const conflicting = await this.prisma.role.findUnique({ where: { name: data.name } });
        this.emitAudit({
          userId: actor.id,
          actorType: resolveActorType(actor.roles ?? []),
          action: AuditEventEnum.ROLE_CREATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'Role',
          entityId: conflicting?.id ?? 'unknown',
          entityLabel: conflicting?.name ?? data.name,
          diff: {
            result: 'failure',
            reason: 'role_name_already_in_use',
            attemptedName: data.name,
          },
          metadata: { concurrentConflict: true },
        });
        throw new ConflictException('role_name_already_in_use');
      }
      throw error;
    }

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action: AuditEventEnum.ROLE_CREATED,
      entity: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      diff: { result: 'success', name: role.name },
    });

    return role;
  }

  async update(actor: CurrentUserDto, id: string, data: UpdateRoleDto): Promise<Role> {
    const role = await this.prisma.role.findUnique({ where: { id } });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    if (this.isProtected(role) && data.name !== undefined && data.name !== role.name) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action: AuditEventEnum.ROLE_UPDATED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: id,
        entityLabel: role.name,
        diff: {
          result: 'denied',
          reason: 'protected_role_cannot_be_renamed',
          attemptedName: data.name,
          currentName: role.name,
        },
      });
      throw new BadRequestException('protected_role_cannot_be_renamed');
    }

    if (data.name && data.name !== role.name) {
      const nameTaken = await this.prisma.role.findUnique({ where: { name: data.name } });

      if (nameTaken) {
        this.emitAudit({
          userId: actor.id,
          actorType: resolveActorType(actor.roles ?? []),
          action: AuditEventEnum.ROLE_UPDATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'Role',
          entityId: id,
          entityLabel: role.name,
          diff: {
            result: 'failure',
            reason: 'role_name_already_in_use',
            attemptedName: data.name,
            currentName: role.name,
          },
          metadata: { conflictingRoleId: nameTaken.id },
        });
        throw new ConflictException('role_name_already_in_use');
      }
    }

    let updatedRole: Role;
    try {
      updatedRole = await this.prisma.role.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        // Lost the race to a concurrent rename to the same name.
        this.emitAudit({
          userId: actor.id,
          actorType: resolveActorType(actor.roles ?? []),
          action: AuditEventEnum.ROLE_UPDATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'Role',
          entityId: id,
          entityLabel: role.name,
          diff: {
            result: 'failure',
            reason: 'role_name_already_in_use',
            attemptedName: data.name,
            currentName: role.name,
          },
          metadata: { concurrentConflict: true },
        });
        throw new ConflictException('role_name_already_in_use');
      }
      throw error;
    }

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action: AuditEventEnum.ROLE_UPDATED,
      entity: 'Role',
      entityId: id,
      entityLabel: updatedRole.name,
      diff: {
        result: 'success',
        previousName: role.name,
        currentName: updatedRole.name,
        previousDescription: role.description ?? null,
        currentDescription: updatedRole.description ?? null,
      },
      metadata: {
        changed:
          role.name !== updatedRole.name ||
          (role.description ?? null) !== (updatedRole.description ?? null),
        nameChanged: role.name !== updatedRole.name,
        descriptionChanged: (role.description ?? null) !== (updatedRole.description ?? null),
      },
    });

    return updatedRole;
  }

  async remove(actor: CurrentUserDto, id: string): Promise<{ message: string }> {
    const role = await this.prisma.role.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        isProtected: true,
        _count: { select: { userRoles: true } },
      },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    if (this.isProtected(role)) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action: AuditEventEnum.ROLE_DELETED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: id,
        entityLabel: role.name,
        diff: { result: 'denied', reason: 'protected_role_cannot_be_deleted' },
      });
      throw new BadRequestException('protected_role_cannot_be_deleted');
    }

    if (role._count.userRoles > 0) {
      this.emitAudit({
        userId: actor.id,
        actorType: resolveActorType(actor.roles ?? []),
        action: AuditEventEnum.ROLE_DELETED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: id,
        entityLabel: role.name,
        diff: { result: 'failure', reason: 'role_in_use_by_users' },
        metadata: { userCount: role._count.userRoles },
      });
      throw new BadRequestException('role_in_use_by_users');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // Re-check immediately before delete to narrow (not eliminate) the race window.
        const freshCount = await tx.userRole.count({ where: { roleId: id } });

        if (freshCount > 0) {
          throw new BadRequestException('role_in_use_by_users');
        }

        await tx.role.delete({ where: { id } });
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.emitAudit({
          userId: actor.id,
          actorType: resolveActorType(actor.roles ?? []),
          action: AuditEventEnum.ROLE_DELETED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'Role',
          entityId: id,
          entityLabel: role.name,
          diff: { result: 'failure', reason: 'role_in_use_by_users' },
          metadata: { detectedAtTransactionTime: true },
        });
      }
      throw error;
    }

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action: AuditEventEnum.ROLE_DELETED,
      entity: 'Role',
      entityId: id,
      entityLabel: role.name,
      diff: { result: 'success', previousName: role.name },
    });

    return { message: 'role_deleted' };
  }

  // ─── shared helpers ────────────────────────────────────────────────────

  private actorTypeOf(actor: CurrentUserDto) {
    return resolveActorType(actor.roles ?? []);
  }

  private async loadRoleOrThrow(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: { rolePermissions: { select: { permission: { select: { name: true } } } } },
    });

    if (!role) {
      throw new NotFoundException('role_not_found');
    }

    return role;
  }

  private isSensitiveRole(role: { rolePermissions: { permission: { name: string } }[] }): boolean {
    return role.rolePermissions.some((rp) => requiresTwoPersonApproval(rp.permission.name));
  }

  // Only custom (non-protected, non-archived) roles can be handed out here.
  // ADMIN goes through /admin/auth/promote; SUPER_ADMIN only by direct DB action.
  private assertRoleAssignable(
    actor: CurrentUserDto,
    role: { id: string; name: string; isProtected?: boolean; archivedAt: Date | null },
    action: AuditEventEnum,
  ): void {
    let reason: string | null = null;

    if (this.isProtected(role)) reason = 'protected_role_cannot_be_assigned_here';
    else if (role.archivedAt) reason = 'role_archived';

    if (!reason) return;

    this.emitAudit({
      userId: actor.id,
      actorType: this.actorTypeOf(actor),
      action,
      outcome: AuditOutcome.DENIED,
      severity: AuditSeverity.WARNING,
      entity: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      diff: { result: 'denied', reason },
    });

    throw new BadRequestException(reason);
  }

  // "Verified staff user": active, email verified, and already holding a staff role
  // (i.e. went through admin registration or promotion first).
  private async loadStaffTargetOrThrow(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        isEmailVerified: true,
        userRoles: { select: { roleId: true, role: { select: { name: true } } } },
      },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    const roleNames = user.userRoles.map((ur) => ur.role.name);

    if (!user.isActive || !user.isEmailVerified || !hasStaffRole(roleNames)) {
      throw new BadRequestException('user_not_verified_staff');
    }

    return { ...user, roleNames };
  }

  // Permissions are baked into the JWT at login, so a role change must reach live sessions.
  // Same rule as PermissionService: removal deletes sessions, addition only purges the cache.
  private async refreshUserAccess(userId: string, revokeSessions: boolean): Promise<void> {
    try {
      if (revokeSessions) {
        await this.prisma.session.deleteMany({ where: { userId } });
      }
      await this.cache.purgeUserCache(userId);
    } catch (error) {
      // The assignment is already committed; a cache failure must not undo it.
      console.error(`[EHTE ROLE] Failed to refresh access for user ${userId}`, error);
    }
  }

  private requireReason(reason: string | undefined): string {
    const trimmed = (reason ?? '').trim();
    if (trimmed.length < 5) {
      throw new BadRequestException('reason_required');
    }
    return trimmed;
  }

  // ─── reads ─────────────────────────────────────────────────────────────

  // AR-37
  async summary() {
    const roles = await this.prisma.role.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        isProtected: true,
        archivedAt: true,
        createdAt: true,
        _count: { select: { userRoles: true, rolePermissions: true } },
      },
    });

    return roles.map(({ _count, ...role }) => ({
      ...role,
      userCount: _count.userRoles,
      permissionCount: _count.rolePermissions,
    }));
  }

  // AR-38
  async findPermissions(id: string) {
    const role = await this.loadRoleOrThrow(id);

    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permission: { select: { id: true, name: true, description: true } } },
      orderBy: { permission: { name: 'asc' } },
    });

    return rolePermissions.map((rp) => rp.permission);
  }

  // AR-33
  async findAssignments(id: string) {
    const role = await this.loadRoleOrThrow(id);

    const [assignments, temporary] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { roleId: role.id },
        orderBy: { assignedAt: 'desc' },
        select: {
          assignedAt: true,
          user: { select: { id: true, name: true, email: true } },
          assignedByUser: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.roleTemporaryAssignment.findMany({
        where: { roleId: role.id, status: 'ACTIVE' },
        select: { userId: true, expiresAt: true },
      }),
    ]);

    const expiryByUser = new Map(temporary.map((t) => [t.userId, t.expiresAt]));

    return assignments.map((a) => ({
      user: a.user,
      assignedAt: a.assignedAt,
      assignedBy: a.assignedByUser,
      temporaryUntil: expiryByUser.get(a.user.id) ?? null,
    }));
  }

  // AR-41. Read from the audit events, newest first.
  async history(id: string) {
    const role = await this.loadRoleOrThrow(id);

    const events = await this.prisma.auditLog.findMany({
      where: { entity: 'Role', entityId: role.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        createdAt: true,
        action: true,
        outcome: true,
        userId: true,
        actorName: true,
        targetUserId: true,
        diff: true,
      },
    });

    return { role: { id: role.id, name: role.name }, events };
  }

  // AR-44. Also the logic behind DELETE /roles/:id, which already refuses a role in use.
  async deleteImpact(id: string) {
    const role = await this.loadRoleOrThrow(id);

    const [holders, pendingRequests, activeTemporary, reviewItems] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { roleId: role.id },
        select: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              userRoles: { select: { roleId: true } },
            },
          },
        },
      }),
      this.prisma.roleAssignmentRequest.count({ where: { roleId: role.id, status: 'PENDING' } }),
      this.prisma.roleTemporaryAssignment.count({ where: { roleId: role.id, status: 'ACTIVE' } }),
      this.prisma.accessReviewItem.count({ where: { roleId: role.id, decision: 'PENDING' } }),
    ]);

    const users = holders.map(({ user }) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      // true when this is their only role, so they would be left with none
      losesAllRoles: user.userRoles.length === 1,
    }));

    return {
      role: { id: role.id, name: role.name, isProtected: this.isProtected(role) },
      userCount: users.length,
      users,
      pendingRequests,
      activeTemporaryAssignments: activeTemporary,
      pendingReviewItems: reviewItems,
      canDelete: !this.isProtected(role) && users.length === 0,
    };
  }

  // AR-40
  async compare(query: CompareRolesQueryDto) {
    const [a, b] = await Promise.all([
      this.loadRoleOrThrow(query.a),
      this.loadRoleOrThrow(query.b),
    ]);

    const setA = new Set(a.rolePermissions.map((rp) => rp.permission.name));
    const setB = new Set(b.rolePermissions.map((rp) => rp.permission.name));

    return {
      a: { id: a.id, name: a.name },
      b: { id: b.id, name: b.name },
      onlyInA: [...setA].filter((name) => !setB.has(name)).sort(),
      onlyInB: [...setB].filter((name) => !setA.has(name)).sort(),
      inBoth: [...setA].filter((name) => setB.has(name)).sort(),
    };
  }

  // AR-45
  listTemplates() {
    return ROLE_TEMPLATES.map(({ id, name, description }) => ({ id, name, description }));
  }

  // AR-57
  async listTemporaryAssignments() {
    return this.prisma.roleTemporaryAssignment.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { expiresAt: 'asc' },
      select: {
        id: true,
        startsAt: true,
        expiresAt: true,
        reason: true,
        user: { select: { id: true, name: true, email: true } },
        role: { select: { id: true, name: true } },
        grantedBy: { select: { id: true, name: true } },
      },
    });
  }

  // AR-35
  async listAssignmentRequests() {
    await this.expireStaleRequests();

    return this.prisma.roleAssignmentRequest.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        reason: true,
        createdAt: true,
        expiresAt: true,
        role: { select: { id: true, name: true } },
        targetUser: { select: { id: true, name: true, email: true } },
        requestedBy: { select: { id: true, name: true } },
      },
    });
  }

  // AR-80
  async statsOverview() {
    const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [roles, archived, assignments, temporary, expiringSoon, pendingRequests] =
      await Promise.all([
        this.prisma.role.count(),
        this.prisma.role.count({ where: { archivedAt: { not: null } } }),
        this.prisma.userRole.count(),
        this.prisma.roleTemporaryAssignment.count({ where: { status: 'ACTIVE' } }),
        this.prisma.roleTemporaryAssignment.count({
          where: { status: 'ACTIVE', expiresAt: { lte: soon } },
        }),
        this.prisma.roleAssignmentRequest.count({
          where: { status: 'PENDING', expiresAt: { gt: new Date() } },
        }),
      ]);

    return {
      roles,
      archivedRoles: archived,
      assignments,
      temporaryAssignments: temporary,
      temporaryExpiringWithin7Days: expiringSoon,
      pendingAssignmentRequests: pendingRequests,
    };
  }

  // ─── role lifecycle ────────────────────────────────────────────────────

  private async createRoleWithPermissions(
    actor: CurrentUserDto,
    action: AuditEventEnum,
    name: string,
    description: string | null,
    permissionIds: string[],
    audit: Record<string, string | number | boolean | null>,
  ): Promise<Role> {
    if (await this.prisma.role.findUnique({ where: { name } })) {
      this.emitAudit({
        userId: actor.id,
        actorType: this.actorTypeOf(actor),
        action,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: null,
        entityLabel: name,
        diff: { result: 'failure', reason: 'role_name_already_in_use', attemptedName: name },
      });
      throw new ConflictException('role_name_already_in_use');
    }

    let role: Role;

    try {
      role = await this.prisma.$transaction(async (tx) => {
        const created = await tx.role.create({ data: { name, description } });

        if (permissionIds.length > 0) {
          await tx.rolePermission.createMany({
            data: permissionIds.map((permissionId) => ({ roleId: created.id, permissionId })),
            skipDuplicates: true,
          });
        }

        return created;
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('role_name_already_in_use');
      }
      throw error;
    }

    this.emitAudit({
      userId: actor.id,
      actorType: this.actorTypeOf(actor),
      action,
      entity: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      diff: { result: 'success', name: role.name, permissionCount: permissionIds.length },
      metadata: audit,
    });

    return role;
  }

  // AR-39
  async clone(actor: CurrentUserDto, id: string, data: CloneRoleDto): Promise<Role> {
    const source = await this.loadRoleOrThrow(id);

    // Cloning SUPER_ADMIN or SYSTEM would hand out a locked role's full power under a new name.
    if (isPermissionLockedRole(source)) {
      this.emitAudit({
        userId: actor.id,
        actorType: this.actorTypeOf(actor),
        action: AuditEventEnum.ROLE_CLONED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: source.id,
        entityLabel: source.name,
        diff: { result: 'denied', reason: 'protected_role_cannot_be_cloned' },
      });
      throw new ForbiddenException('protected_role_cannot_be_cloned');
    }

    const permissions = await this.prisma.rolePermission.findMany({
      where: { roleId: source.id },
      select: { permissionId: true },
    });

    return this.createRoleWithPermissions(
      actor,
      AuditEventEnum.ROLE_CLONED,
      data.name,
      data.description ?? source.description ?? null,
      permissions.map((p) => p.permissionId),
      { sourceRoleId: source.id, sourceRoleName: source.name },
    );
  }

  // AR-46. Templates name permission patterns; the ones that exist in your database are copied.
  async applyTemplate(
    actor: CurrentUserDto,
    templateId: string,
    data: ApplyRoleTemplateDto,
  ): Promise<Role> {
    const template = ROLE_TEMPLATES.find((t) => t.id === templateId);

    if (!template) {
      throw new NotFoundException('role_template_not_found');
    }

    const all = await this.prisma.permission.findMany({ select: { id: true, name: true } });
    const wanted = new Set<string>(template.permissions);
    const matched = all.filter((p) => wanted.has(p.name));

    if (matched.length === 0) {
      throw new BadRequestException('template_has_no_matching_permissions');
    }

    return this.createRoleWithPermissions(
      actor,
      AuditEventEnum.ROLE_CREATED_FROM_TEMPLATE,
      data.name ?? template.name,
      data.description ?? template.description,
      matched.map((p) => p.id),
      { templateId: template.id, matchedPermissions: matched.length },
    );
  }

  // AR-42. Existing holders keep the role until removed; the role just can't be handed out again.
  async archive(actor: CurrentUserDto, id: string, data: ArchiveRoleDto) {
    const role = await this.loadRoleOrThrow(id);

    if (this.isProtected(role)) {
      this.emitAudit({
        userId: actor.id,
        actorType: this.actorTypeOf(actor),
        action: AuditEventEnum.ROLE_ARCHIVED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: role.id,
        entityLabel: role.name,
        diff: { result: 'denied', reason: 'protected_role_cannot_be_archived' },
      });
      throw new BadRequestException('protected_role_cannot_be_archived');
    }

    if (role.archivedAt) {
      throw new ConflictException('role_already_archived');
    }

    const [updated, holders, cancelled] = await this.prisma.$transaction([
      this.prisma.role.update({
        where: { id: role.id },
        data: { archivedAt: new Date(), archivedById: actor.id },
      }),
      this.prisma.userRole.count({ where: { roleId: role.id } }),
      this.prisma.roleAssignmentRequest.updateMany({
        where: { roleId: role.id, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      }),
    ]);

    this.emitAudit({
      userId: actor.id,
      actorType: this.actorTypeOf(actor),
      action: AuditEventEnum.ROLE_ARCHIVED,
      entity: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      diff: { result: 'success', reason: data.reason ?? null },
      metadata: { currentHolders: holders, requestsCancelled: cancelled.count },
    });

    return { ...updated, currentHolders: holders };
  }

  // AR-43
  async unarchive(actor: CurrentUserDto, id: string, data: ArchiveRoleDto) {
    const role = await this.loadRoleOrThrow(id);

    if (!role.archivedAt) {
      throw new ConflictException('role_not_archived');
    }

    const updated = await this.prisma.role.update({
      where: { id: role.id },
      data: { archivedAt: null, archivedById: null },
    });

    this.emitAudit({
      userId: actor.id,
      actorType: this.actorTypeOf(actor),
      action: AuditEventEnum.ROLE_UNARCHIVED,
      entity: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      diff: { result: 'success', reason: data.reason ?? null },
    });

    return updated;
  }

  // ─── role assignment ───────────────────────────────────────────────────

  // AR-29
  async assignToUser(actor: CurrentUserDto, roleId: string, data: AssignRoleToUserDto) {
    const reason = this.requireReason(data.reason);
    const role = await this.loadRoleOrThrow(roleId);
    this.assertRoleAssignable(actor, role, AuditEventEnum.USER_ROLE_ASSIGNED);

    // Roles that carry sensitive permissions go through two-person approval instead.
    if (this.isSensitiveRole(role)) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: data.userId,
        actorType: this.actorTypeOf(actor),
        action: AuditEventEnum.USER_ROLE_ASSIGNED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: role.id,
        entityLabel: role.name,
        diff: { result: 'denied', reason: 'two_person_approval_required' },
      });
      throw new ForbiddenException('two_person_approval_required');
    }

    const target = await this.loadStaffTargetOrThrow(data.userId);

    if (target.userRoles.some((ur) => ur.roleId === role.id)) {
      throw new ConflictException('user_already_has_role');
    }

    await this.prisma.userRole.create({
      data: { userId: target.id, roleId: role.id, assignedBy: actor.id },
    });

    await this.refreshUserAccess(target.id, false);

    this.emitAudit({
      userId: actor.id,
      targetUserId: target.id,
      actorType: this.actorTypeOf(actor),
      action: AuditEventEnum.USER_ROLE_ASSIGNED,
      entity: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      diff: { result: 'success', reason },
      metadata: { targetUserName: target.name ?? null },
    });

    return { message: 'role_assigned', roleId: role.id, userId: target.id };
  }

  // AR-30. A user is never left with no role at all.
  async removeFromUser(
    actor: CurrentUserDto,
    roleId: string,
    userId: string,
    data: RemoveRoleFromUserDto,
  ) {
    const reason = this.requireReason(data.reason);
    const role = await this.loadRoleOrThrow(roleId);

    if (this.isProtected(role)) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: userId,
        actorType: this.actorTypeOf(actor),
        action: AuditEventEnum.USER_ROLE_REVOKED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: role.id,
        entityLabel: role.name,
        diff: { result: 'denied', reason: 'protected_role_cannot_be_removed_here' },
      });
      throw new BadRequestException('protected_role_cannot_be_removed_here');
    }

    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      select: { roleId: true },
    });

    if (!userRoles.some((ur) => ur.roleId === role.id)) {
      throw new NotFoundException('user_does_not_have_role');
    }

    if (userRoles.length <= 1) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: userId,
        actorType: this.actorTypeOf(actor),
        action: AuditEventEnum.USER_ROLE_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Role',
        entityId: role.id,
        entityLabel: role.name,
        diff: { result: 'failure', reason: 'cannot_remove_last_role' },
      });
      throw new BadRequestException('cannot_remove_last_role');
    }

    await this.prisma.$transaction([
      this.prisma.userRole.delete({ where: { userId_roleId: { userId, roleId: role.id } } }),
      this.prisma.roleTemporaryAssignment.updateMany({
        where: { userId, roleId: role.id, status: 'ACTIVE' },
        data: { status: 'REVOKED', endedAt: new Date() },
      }),
    ]);

    await this.refreshUserAccess(userId, true);

    this.emitAudit({
      userId: actor.id,
      targetUserId: userId,
      actorType: this.actorTypeOf(actor),
      action: AuditEventEnum.USER_ROLE_REVOKED,
      entity: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      diff: { result: 'success', reason },
    });

    return { message: 'role_removed', roleId: role.id, userId };
  }

  // AR-31. One bad user does not stop the rest; each outcome is reported.
  async bulkAssign(actor: CurrentUserDto, roleId: string, data: BulkRoleAssignmentDto) {
    const succeeded: string[] = [];
    const failed: { userId: string; reason: string }[] = [];

    for (const userId of data.userIds) {
      try {
        if (data.action === 'ASSIGN') {
          await this.assignToUser(actor, roleId, { userId, reason: data.reason });
        } else {
          await this.removeFromUser(actor, roleId, userId, { reason: data.reason });
        }
        succeeded.push(userId);
      } catch (error) {
        const reason =
          error instanceof Error && 'message' in error ? String(error.message) : 'unknown_error';
        failed.push({ userId, reason });
      }
    }

    this.emitAudit({
      userId: actor.id,
      actorType: this.actorTypeOf(actor),
      action: AuditEventEnum.ROLE_BULK_ASSIGNED,
      entity: 'Role',
      entityId: roleId,
      diff: { result: failed.length === 0 ? 'success' : 'partial', action: data.action },
      metadata: {
        requested: data.userIds.length,
        succeeded: succeeded.length,
        failed: failed.length,
      },
    });

    return { action: data.action, succeeded, failed };
  }

  // AR-34
  async requestAssignment(
    actor: CurrentUserDto,
    roleId: string,
    userId: string,
    data: RequestRoleAssignmentDto,
  ) {
    const reason = this.requireReason(data.reason);
    const role = await this.loadRoleOrThrow(roleId);
    this.assertRoleAssignable(actor, role, AuditEventEnum.ROLE_ASSIGNMENT_REQUESTED);

    const target = await this.loadStaffTargetOrThrow(userId);

    if (target.userRoles.some((ur) => ur.roleId === role.id)) {
      throw new ConflictException('user_already_has_role');
    }

    await this.expireStaleRequests();

    const existing = await this.prisma.roleAssignmentRequest.findFirst({
      where: { roleId: role.id, targetUserId: target.id, status: 'PENDING' },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('assignment_request_already_pending');
    }

    const request = await this.prisma.roleAssignmentRequest.create({
      data: {
        roleId: role.id,
        targetUserId: target.id,
        requestedById: actor.id,
        reason,
        expiresAt: new Date(Date.now() + ASSIGNMENT_REQUEST_TTL_MS),
      },
    });

    this.emitAudit({
      userId: actor.id,
      targetUserId: target.id,
      actorType: this.actorTypeOf(actor),
      action: AuditEventEnum.ROLE_ASSIGNMENT_REQUESTED,
      entity: 'RoleAssignmentRequest',
      entityId: request.id,
      entityLabel: role.name,
      diff: { result: 'success', reason },
      metadata: { roleId: role.id, sensitive: this.isSensitiveRole(role) },
    });

    return request;
  }

  // AR-36. A different Super Admin decides; the requester can never approve their own request.
  async reviewAssignmentRequest(
    actor: CurrentUserDto,
    requestId: string,
    data: ReviewRoleAssignmentRequestDto,
  ) {
    const request = await this.prisma.roleAssignmentRequest.findUnique({
      where: { id: requestId },
      include: {
        role: {
          include: { rolePermissions: { select: { permission: { select: { name: true } } } } },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('assignment_request_not_found');
    }

    const action =
      data.decision === 'APPROVE'
        ? AuditEventEnum.ROLE_ASSIGNMENT_APPROVED
        : AuditEventEnum.ROLE_ASSIGNMENT_REJECTED;

    if (request.requestedById === actor.id) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: request.targetUserId,
        actorType: this.actorTypeOf(actor),
        action,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'RoleAssignmentRequest',
        entityId: request.id,
        entityLabel: request.role.name,
        diff: { result: 'denied', reason: 'requester_cannot_review_own_request' },
      });
      throw new ForbiddenException('requester_cannot_review_own_request');
    }

    if (request.status !== 'PENDING') {
      throw new ConflictException('assignment_request_not_pending');
    }

    if (request.expiresAt <= new Date()) {
      await this.prisma.roleAssignmentRequest.update({
        where: { id: request.id },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException('assignment_request_expired');
    }

    if (data.decision === 'REJECT') {
      const note = (data.note ?? '').trim();
      if (!note) {
        throw new BadRequestException('rejection_note_required');
      }

      const rejected = await this.prisma.roleAssignmentRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          reviewedById: actor.id,
          reviewedAt: new Date(),
          reviewNote: note,
        },
      });

      if (rejected.count === 0) {
        throw new ConflictException('assignment_request_not_pending');
      }

      this.emitAudit({
        userId: actor.id,
        targetUserId: request.targetUserId,
        actorType: this.actorTypeOf(actor),
        action,
        entity: 'RoleAssignmentRequest',
        entityId: request.id,
        entityLabel: request.role.name,
        diff: { result: 'success', decision: 'REJECT', note },
      });

      return { id: request.id, status: 'REJECTED' };
    }

    // APPROVE: everything is re-checked, since time has passed since the request was made.
    this.assertRoleAssignable(actor, request.role, action);
    const target = await this.loadStaffTargetOrThrow(request.targetUserId);

    if (target.userRoles.some((ur) => ur.roleId === request.roleId)) {
      throw new ConflictException('user_already_has_role');
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.roleAssignmentRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          reviewedById: actor.id,
          reviewedAt: new Date(),
          reviewNote: data.note?.trim() || null,
        },
      });

      if (claimed.count === 0) {
        throw new ConflictException('assignment_request_not_pending');
      }

      await tx.userRole.create({
        data: { userId: target.id, roleId: request.roleId, assignedBy: request.requestedById },
      });
    });

    await this.refreshUserAccess(target.id, false);

    this.emitAudit({
      userId: actor.id,
      targetUserId: target.id,
      actorType: this.actorTypeOf(actor),
      action,
      entity: 'RoleAssignmentRequest',
      entityId: request.id,
      entityLabel: request.role.name,
      diff: { result: 'success', decision: 'APPROVE' },
      metadata: { requestedById: request.requestedById, roleId: request.roleId },
    });

    return { id: request.id, status: 'APPROVED' };
  }

  private async expireStaleRequests(): Promise<void> {
    await this.prisma.roleAssignmentRequest.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
  }

  // ─── temporary access ──────────────────────────────────────────────────

  // AR-56
  async assignTemporarily(
    actor: CurrentUserDto,
    roleId: string,
    userId: string,
    data: TemporaryRoleAssignmentDto,
  ) {
    const reason = this.requireReason(data.reason);
    const expiresAt = new Date(data.expiresAt);
    const now = Date.now();

    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now) {
      throw new BadRequestException('expires_at_must_be_in_the_future');
    }

    if (expiresAt.getTime() - now > MAX_TEMPORARY_ASSIGNMENT_MS) {
      throw new BadRequestException('temporary_assignment_too_long');
    }

    const role = await this.loadRoleOrThrow(roleId);
    this.assertRoleAssignable(actor, role, AuditEventEnum.ROLE_TEMPORARY_GRANTED);

    if (this.isSensitiveRole(role)) {
      throw new ForbiddenException('two_person_approval_required');
    }

    const target = await this.loadStaffTargetOrThrow(userId);

    if (target.userRoles.some((ur) => ur.roleId === role.id)) {
      throw new ConflictException('user_already_has_role');
    }

    const assignment = await this.prisma.$transaction(async (tx) => {
      await tx.userRole.create({
        data: { userId: target.id, roleId: role.id, assignedBy: actor.id },
      });

      return tx.roleTemporaryAssignment.create({
        data: { userId: target.id, roleId: role.id, grantedById: actor.id, reason, expiresAt },
      });
    });

    await this.refreshUserAccess(target.id, false);

    this.emitAudit({
      userId: actor.id,
      targetUserId: target.id,
      actorType: this.actorTypeOf(actor),
      action: AuditEventEnum.ROLE_TEMPORARY_GRANTED,
      entity: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      diff: { result: 'success', reason, expiresAt: expiresAt.toISOString() },
    });

    return assignment;
  }

  // Call this from a scheduled job (every few minutes). Removes roles whose end date has passed.
  async expireTemporaryAssignments(): Promise<{ expired: number }> {
    const due = await this.prisma.roleTemporaryAssignment.findMany({
      where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
      include: { role: { select: { name: true } } },
      take: 200,
    });

    let expired = 0;

    for (const item of due) {
      try {
        await this.prisma.$transaction([
          this.prisma.userRole.deleteMany({ where: { userId: item.userId, roleId: item.roleId } }),
          this.prisma.roleTemporaryAssignment.update({
            where: { id: item.id },
            data: { status: 'EXPIRED', endedAt: new Date() },
          }),
        ]);

        await this.refreshUserAccess(item.userId, true);
        expired += 1;

        this.emitAudit({
          userId: null,
          targetUserId: item.userId,
          actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
          action: AuditEventEnum.ROLE_TEMPORARY_EXPIRED,
          entity: 'Role',
          entityId: item.roleId,
          entityLabel: item.role.name,
          diff: { result: 'success', temporaryAssignmentId: item.id },
        });
      } catch (error) {
        console.error(`[EHTE ROLE] Failed to expire temporary assignment ${item.id}`, error);
      }
    }

    return { expired };
  }
}

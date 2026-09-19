import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { AuditOutcome, AuditSeverity, Prisma, Role } from '@prisma/client';

import { FetchQuery, PaginatedResult } from 'src/common/fetch-query/crud.types';

import { buildFindManyArgs } from 'src/common/fetch-query/fetch-query.helper';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { CreateRoleDto, UpdateRoleDto } from '../dto/role.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';
import { RolesEnum } from 'src/common/enums/roles.enum';

// Protection is now data-driven via role.isProtected. This array is a fallback only.
const PROTECTED_ROLE_NAMES: string[] = [RolesEnum.SUPER_ADMIN, RolesEnum.ADMIN, RolesEnum.SYSTEM];

@Injectable()
export class RoleService {
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

  private isProtected(role: { name: string; isProtected?: boolean }): boolean {
    return role.isProtected === true || PROTECTED_ROLE_NAMES.includes(role.name);
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
      },
      metadata: { changed: role.name !== updatedRole.name },
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
}
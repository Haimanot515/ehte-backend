import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditOutcome, AuditSeverity } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AssignUserRoleDto } from '../dto/user.dto';
import { UserCommonService } from './user-common.service';

@Injectable()
export class UserRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly userCommonService: UserCommonService,
  ) {}

  async assignRole(
    actor: CurrentUserDto,
    targetUserId: string,
    data: AssignUserRoleDto,
    reason?: string,
  ) {
    const actorType = resolveActorType(this.userCommonService.getRoles(actor));

    if ((data.role as string) !== RolesEnum.SUPER_ADMIN) {
      throw new BadRequestException('use_admin_promote_flow_for_admin');
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        isEmailVerified: true,
        userRoles: { select: { role: { select: { id: true, name: true } } } },
      },
    });
    if (!targetUser) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_ROLE_ASSIGNED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found', attemptedRole: data.role },
      });
      throw new NotFoundException('user_not_found');
    }
    const targetLabel = this.userCommonService.buildUserLabel(targetUser);
    const previousRoles = targetUser.userRoles.map((userRole) => userRole.role.name);

    // Eligibility: must be active, email-verified, and ALREADY an admin, i.e.
    // someone who went through the email-link promotion.
    const ineligibleReason = !targetUser.isActive
      ? 'user_inactive'
      : !targetUser.isEmailVerified
        ? 'email_not_verified'
        : !previousRoles.includes(RolesEnum.ADMIN)
          ? 'user_must_be_admin_first'
          : null;
    if (ineligibleReason) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_ROLE_ASSIGNED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        reason: reason ?? null,
        diff: { result: 'failure', reason: ineligibleReason, attemptedRole: data.role },
        metadata: { previousRoles },
      });
      throw new BadRequestException(ineligibleReason);
    }

    const role = await this.prisma.role.findUnique({ where: { name: data.role } });
    if (!role) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_ROLE_ASSIGNED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'role_not_found', attemptedRole: data.role },
      });
      throw new BadRequestException('role_not_found');
    }

    const alreadyHeld = previousRoles.includes(role.name);

    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId: targetUserId, roleId: role.id } },
      create: { userId: targetUserId, roleId: role.id },
      update: {},
    });

    if (!alreadyHeld) {
      // Cached session/profile may carry the old role set.
      await this.cache.purgeUserCache(targetUserId);
    }

    this.userCommonService.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_ROLE_ASSIGNED,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: targetLabel,
      reason: reason ?? null,
      diff: {
        result: 'success',
        assignedRole: data.role,
        previousRoles,
        currentRoles: alreadyHeld ? previousRoles : [...previousRoles, role.name],
      },
      metadata: { roleId: role.id, alreadyHeld },
    });

    return this.userCommonService.getUserById(targetUserId);
  }

  async revokeRole(
    actor: CurrentUserDto,
    targetUserId: string,
    role: RolesEnum.ADMIN | RolesEnum.SUPER_ADMIN,
    reason?: string,
  ) {
    const actorType = resolveActorType(this.userCommonService.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        userRoles: { select: { role: { select: { id: true, name: true } } } },
      },
    });
    if (!targetUser) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_ROLE_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found', attemptedRole: role },
      });
      throw new NotFoundException('user_not_found');
    }
    const targetLabel = this.userCommonService.buildUserLabel(targetUser);
    const previousRoles = targetUser.userRoles.map((userRole) => userRole.role.name);

    const roleToRevoke = targetUser.userRoles.find((ur) => ur.role.name === (role as string))?.role;
    if (!roleToRevoke) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_ROLE_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'user_does_not_have_role', attemptedRole: role },
        metadata: { previousRoles },
      });
      throw new BadRequestException('user_does_not_have_role');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        if (role === RolesEnum.SUPER_ADMIN) {
          const otherActiveSuperAdmins = await tx.user.count({
            where: {
              id: { not: targetUserId },
              isActive: true,
              userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
            },
          });
          if (otherActiveSuperAdmins === 0) {
            throw new ForbiddenException('cannot_remove_last_super_admin');
          }
        }

        await tx.userRole.delete({
          where: { userId_roleId: { userId: targetUserId, roleId: roleToRevoke.id } },
        });
      });

      // A revoked admin role must not survive in a cached session.
      await this.cache.purgeUserCache(targetUserId);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        this.userCommonService.emitAudit({
          userId: actor.id,
          targetUserId,
          actorType,
          action: AuditEventEnum.USER_ROLE_REVOKED,
          outcome: AuditOutcome.DENIED,
          severity: AuditSeverity.CRITICAL,
          entity: 'User',
          entityId: targetUserId,
          entityLabel: targetLabel,
          reason: reason ?? null,
          diff: { result: 'denied', reason: 'cannot_remove_last_super_admin' },
          metadata: { previousRoles, otherActiveSuperAdmins: 0 },
        });
      }
      throw err;
    }

    this.userCommonService.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_ROLE_REVOKED,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: targetLabel,
      reason: reason ?? null,
      diff: {
        result: 'success',
        revokedRole: role,
        previousRoles,
        currentRoles: previousRoles.filter((roleName) => roleName !== (role as string)),
      },
      metadata: { roleId: roleToRevoke.id },
    });

    return this.userCommonService.getUserById(targetUserId);
  }
}

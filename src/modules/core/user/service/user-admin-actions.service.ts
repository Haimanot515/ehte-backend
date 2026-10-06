import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { AuditOutcome, AuditSeverity } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import {
  AdminRequiredReasonDto,
  BulkRestrictionDto,
  BulkUserIdsDto,
  BulkUserReasonDto,
  BulkWarningDto,
  CreateRestrictionDto,
  CreateWarningDto,
} from '../dto/user.dto';
import { UserCommonService } from './user-common.service';

@Injectable()
export class UserAdminActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: CacheService,
    private readonly userCommonService: UserCommonService,
  ) {}

  async deactivateUser(actor: CurrentUserDto, targetUserId: string, reason?: string) {
    const actorType = resolveActorType(this.userCommonService.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!targetUser) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_DEACTIVATED_BY_ADMIN,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found' },
      });
      throw new NotFoundException('user_not_found');
    }
    const targetLabel = this.userCommonService.buildUserLabel(targetUser);
    const targetRoleNames = targetUser.userRoles.map((userRole) => userRole.role.name);
    const targetIsSuperAdmin = this.userCommonService.isSuperAdmin(targetRoleNames);

    if (!targetUser.isActive) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_DEACTIVATED_BY_ADMIN,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'account_already_inactive' },
      });
      throw new BadRequestException('account_already_inactive');
    }

    let sessionsRevoked = 0;

    try {
      await this.prisma.$transaction(async (tx) => {
        if (targetIsSuperAdmin) {
          const otherActiveSuperAdmins = await tx.user.count({
            where: {
              id: { not: targetUserId },
              isActive: true,
              userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
            },
          });
          if (otherActiveSuperAdmins === 0) {
            throw new ForbiddenException('cannot_deactivate_last_super_admin');
          }
        }

        const result = await tx.user.updateMany({
          where: { id: targetUserId, isActive: true },
          data: { isActive: false },
        });
        if (result.count === 0) {
          throw new BadRequestException('account_already_inactive');
        }

        const revoked = await tx.session.deleteMany({ where: { userId: targetUserId } });
        sessionsRevoked = revoked.count;
      });

      // Postgres sessions are gone; drop anything Redis still holds for this user (retried if Redis is down).
      await this.cache.purgeUserCache(targetUserId);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        this.userCommonService.emitAudit({
          userId: actor.id,
          targetUserId,
          actorType,
          action: AuditEventEnum.USER_DEACTIVATED_BY_ADMIN,
          outcome: AuditOutcome.DENIED,
          severity: AuditSeverity.CRITICAL,
          entity: 'User',
          entityId: targetUserId,
          entityLabel: targetLabel,
          reason: reason ?? null,
          diff: { result: 'denied', reason: 'cannot_deactivate_last_super_admin' },
          metadata: { targetRoles: targetRoleNames, otherActiveSuperAdmins: 0 },
        });
      } else {
        this.userCommonService.emitAudit({
          userId: actor.id,
          targetUserId,
          actorType,
          action: AuditEventEnum.USER_DEACTIVATED_BY_ADMIN,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'User',
          entityId: targetUserId,
          entityLabel: targetLabel,
          diff: { result: 'failure', reason: 'account_transition_conflict' },
        });
      }
      throw err;
    }

    this.userCommonService.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_DEACTIVATED_BY_ADMIN,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: targetLabel,
      reason: reason ?? null,
      diff: { result: 'success', previousIsActive: true, currentIsActive: false },
      metadata: { targetRoles: targetRoleNames, sessionsRevoked },
    });

    return this.userCommonService.getUserById(targetUserId);
  }

  // ── ADMIN — REACTIVATE USER ──
  // Conditional updateMany for consistency; no last-super-admin concern.

  async reactivateUser(actor: CurrentUserDto, targetUserId: string, reason?: string) {
    const actorType = resolveActorType(this.userCommonService.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        passwordHash: true,
        inviteTokenHash: true,
      },
    });
    if (!targetUser) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_REACTIVATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found' },
      });
      throw new NotFoundException('user_not_found');
    }
    const targetLabel = this.userCommonService.buildUserLabel(targetUser);

    // An invited admin who never set a password is not "deactivated", they are unregistered.
    // Flipping isActive here would skip registration: no password, email never verified, and
    // the invite token stays behind so the account keeps showing as a pending invitation.
    if (!targetUser.passwordHash && targetUser.inviteTokenHash) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_REACTIVATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'registration_not_completed' },
      });
      throw new BadRequestException('registration_not_completed');
    }

    const result = await this.prisma.user.updateMany({
      where: { id: targetUserId, isActive: false },
      data: { isActive: true },
    });

    if (result.count === 0) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_REACTIVATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'account_already_active' },
      });
      throw new BadRequestException('account_already_active');
    }

    this.userCommonService.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_REACTIVATED,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: targetLabel,
      reason: reason ?? null,
      diff: { result: 'success', previousIsActive: false, currentIsActive: true },
    });

    return this.userCommonService.getUserById(targetUserId);
  }

  // ── ADMIN — FORCE LOGOUT (all sessions) ──

  async forceLogout(
    actor: CurrentUserDto,
    targetUserId: string,
    reason?: string,
  ): Promise<{ message: string }> {
    const actorType = resolveActorType(this.userCommonService.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, phone: true, email: true },
    });
    if (!targetUser) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_SESSIONS_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found' },
      });
      throw new NotFoundException('user_not_found');
    }
    const revokedSessions = await this.prisma.session.deleteMany({
      where: { userId: targetUserId },
    });
    await this.cache.purgeUserCache(targetUserId);

    this.userCommonService.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_SESSIONS_REVOKED,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: this.userCommonService.buildUserLabel(targetUser),
      reason: reason ?? null,
      diff: { result: 'success' },
      metadata: { scope: 'all_sessions', sessionsRevoked: revokedSessions.count },
    });

    if (actor.id !== targetUserId) {
      this.eventEmitter.emit(NotificationEventEnum.SECURITY_ALERT, {
        userId: targetUserId,
        reason: 'sessions_revoked_by_admin',
      });
    }

    return { message: 'sessions_revoked' };
  }

  // ── ADMIN — UNLOCK USER ──

  async unlockUser(actor: CurrentUserDto, targetUserId: string, reason?: string) {
    const actorType = resolveActorType(this.userCommonService.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        lockedUntil: true,
        failedLoginAttempts: true,
      },
    });
    if (!targetUser) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_UNLOCKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found' },
      });
      throw new NotFoundException('user_not_found');
    }
    const targetLabel = this.userCommonService.buildUserLabel(targetUser);
    if (!targetUser.lockedUntil && targetUser.failedLoginAttempts === 0) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_UNLOCKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'account_not_locked' },
      });
      throw new BadRequestException('account_not_locked');
    }

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
    });

    // The failed-attempt counter also lives in Redis (keyed by user id or login identifier). Clear all,
    // or the next wrong password can re-lock the account straight after an admin unlock.
    await Promise.all(
      [targetUser.id, targetUser.phone, targetUser.email]
        .filter((id): id is string => !!id)
        .map((id) => this.cache.resetFailedLoginAttempts(id)),
    );

    this.userCommonService.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_UNLOCKED,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: targetLabel,
      reason: reason ?? null,
      diff: {
        result: 'success',
        previousFailedLoginAttempts: targetUser.failedLoginAttempts,
        currentFailedLoginAttempts: 0,
        previousLockedUntil: targetUser.lockedUntil,
        currentLockedUntil: null,
      },
      metadata: {
        wasStillLocked: targetUser.lockedUntil
          ? targetUser.lockedUntil.getTime() > Date.now()
          : false,
      },
    });

    return this.userCommonService.getUserById(targetUserId);
  }

  // Runs one action per user; failures are reported per user, not rolled back.
  private async runBulk(
    actor: CurrentUserDto,
    userIds: string[],
    run: (userId: string) => Promise<unknown>,
  ) {
    const ids = [...new Set(userIds)];
    const failed: { userId: string; reason: string }[] = [];
    let succeeded = 0;
    for (const id of ids) {
      if (id === actor.id) {
        failed.push({ userId: id, reason: 'cannot_target_self' });
        continue;
      }
      try {
        await run(id);
        succeeded++;
      } catch (err) {
        failed.push({
          userId: id,
          reason: err instanceof HttpException ? err.message : 'unexpected_error',
        });
      }
    }
    return { requested: ids.length, succeeded, failed };
  }

  async bulkForceLogout(actor: CurrentUserDto, data: BulkUserIdsDto) {
    return this.runBulk(actor, data.userIds, (id) => this.forceLogout(actor, id, data.reason));
  }

  async bulkDeactivate(actor: CurrentUserDto, data: BulkUserReasonDto) {
    return this.runBulk(actor, data.userIds, (id) => this.deactivateUser(actor, id, data.reason));
  }

  async bulkReactivate(actor: CurrentUserDto, data: BulkUserIdsDto) {
    return this.runBulk(actor, data.userIds, (id) => this.reactivateUser(actor, id, data.reason));
  }

  async bulkUnlock(actor: CurrentUserDto, data: BulkUserIdsDto) {
    return this.runBulk(actor, data.userIds, (id) => this.unlockUser(actor, id, data.reason));
  }

  async bulkWarn(actor: CurrentUserDto, data: BulkWarningDto) {
    return this.runBulk(actor, data.userIds, (id) =>
      this.createWarning(actor, id, { message: data.message }),
    );
  }

  async bulkRestrict(actor: CurrentUserDto, data: BulkRestrictionDto) {
    const { userIds, ...restriction } = data;
    return this.runBulk(actor, userIds, (id) => this.createRestriction(actor, id, restriction));
  }

  async forcePasswordReset(actor: CurrentUserDto, userId: string, data: AdminRequiredReasonDto) {
    if (actor.id === userId) throw new BadRequestException('use_change_password_instead');
    const target = await this.userCommonService.requireUser(userId);

    // Random unknown password: the old one stops working and the user must use "forgot password".
    const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    const revoked = await this.prisma.session.deleteMany({ where: { userId } });
    await this.cache.purgeUserCache(userId);

    this.userCommonService.auditUser(
      actor,
      userId,
      AuditEventEnum.USER_SESSIONS_REVOKED,
      'force_password_reset',
      {
        severity: AuditSeverity.WARNING,
        reason: data.reason,
        label: this.userCommonService.buildUserLabel(target),
        metadata: { sessionsRevoked: revoked.count },
      },
    );
    this.eventEmitter.emit(NotificationEventEnum.SECURITY_ALERT, {
      userId,
      reason: 'password_reset_forced_by_admin',
    });
    return { message: 'password_reset_forced', sessionsRevoked: revoked.count };
  }

  async revealContact(actor: CurrentUserDto, userId: string, data: AdminRequiredReasonDto) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        profile: { select: { alternatePhone: true } },
      },
    });
    if (!target) throw new NotFoundException('user_not_found');

    // The value itself is never written to the audit log, only the fact it was revealed.
    this.userCommonService.auditUser(
      actor,
      userId,
      AuditEventEnum.USER_UPDATED,
      'contact_revealed',
      {
        severity: AuditSeverity.WARNING,
        reason: data.reason,
        label: this.userCommonService.buildUserLabel({ name: target.name }),
        metadata: { revealed: ['phone', 'email', 'alternatePhone'] },
      },
    );
    return {
      userId,
      phone: target.phone,
      email: target.email,
      alternatePhone: target.profile?.alternatePhone ?? null,
    };
  }

  async createRestriction(actor: CurrentUserDto, userId: string, data: CreateRestrictionDto) {
    if (actor.id === userId) throw new BadRequestException('cannot_target_self');
    const target = await this.userCommonService.requireUser(userId);

    const endsAt = data.endsAt ? new Date(data.endsAt) : null;
    if (endsAt && endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('ends_at_must_be_in_future');
    }
    const existing = await this.userCommonService.db.userRestriction.findFirst({
      where: { userId, ability: data.ability, ...this.userCommonService.activeRestrictionWhere() },
    });
    if (existing) throw new BadRequestException('restriction_already_active');

    const restriction = await this.userCommonService.db.userRestriction.create({
      data: { userId, ability: data.ability, reason: data.reason, endsAt, createdById: actor.id },
    });
    await this.cache.purgeUserCache(userId);

    this.userCommonService.auditUser(
      actor,
      userId,
      AuditEventEnum.USER_UPDATED,
      'restriction_created',
      {
        severity: AuditSeverity.WARNING,
        reason: data.reason,
        label: this.userCommonService.buildUserLabel(target),
        diff: { restrictionId: restriction.id, ability: data.ability, endsAt },
      },
    );
    return restriction;
  }

  async liftRestriction(
    actor: CurrentUserDto,
    userId: string,
    restrictionId: string,
    data: AdminRequiredReasonDto,
  ) {
    const restriction = await this.userCommonService.db.userRestriction.findFirst({
      where: { id: restrictionId, userId },
    });
    if (!restriction) throw new NotFoundException('restriction_not_found');
    if (restriction.liftedAt) throw new BadRequestException('restriction_already_lifted');

    const updated = await this.userCommonService.db.userRestriction.update({
      where: { id: restrictionId },
      data: { liftedAt: new Date(), liftedById: actor.id, liftReason: data.reason },
    });
    await this.cache.purgeUserCache(userId);

    this.userCommonService.auditUser(
      actor,
      userId,
      AuditEventEnum.USER_UPDATED,
      'restriction_lifted',
      {
        reason: data.reason,
        diff: { restrictionId, ability: restriction.ability },
      },
    );
    return updated;
  }

  async createWarning(actor: CurrentUserDto, userId: string, data: CreateWarningDto) {
    const target = await this.userCommonService.requireUser(userId);
    const warning = await this.userCommonService.db.userWarning.create({
      data: { userId, message: data.message, issuedById: actor.id },
    });

    this.userCommonService.auditUser(actor, userId, AuditEventEnum.USER_UPDATED, 'warning_issued', {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      label: this.userCommonService.buildUserLabel(target),
      diff: { warningId: warning.id },
    });
    this.eventEmitter.emit(NotificationEventEnum.SECURITY_ALERT, {
      userId,
      reason: 'admin_warning',
    });
    return warning;
  }

  async deactivateUserWithReason(
    actor: CurrentUserDto,
    userId: string,
    data: AdminRequiredReasonDto,
  ) {
    return this.deactivateUser(actor, userId, data.reason);
  }
}
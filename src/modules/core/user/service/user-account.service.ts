import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { AuditOutcome, AuditSeverity, OtpChannelEnum, UserOtpPurposeEnum } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { OtpUtil } from 'src/common/utils/otp.util';
import { LockoutUtil } from 'src/common/utils/lockout.util';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import {
  ChangePhoneInitiateDto,
  ChangePhoneVerifyDto,
  ResendPhoneOtpDto,
  UsersPagedQueryDto,
} from '../dto/user.dto';
import { UserCommonService } from './user-common.service';
import { OTP_RESEND_COOLDOWN_MS, LINKED_PROVIDERS } from './user.constants';

@Injectable()
export class UserAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly otpUtil: OtpUtil,
    private readonly lockoutUtil: LockoutUtil,
    private readonly cache: CacheService,
    private readonly userCommonService: UserCommonService,
  ) {}

  async deactivateMe(currentUser: CurrentUserDto): Promise<{ message: string }> {
    const actorType = resolveActorType(this.userCommonService.getRoles(currentUser));

    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    if (!user.isActive) {
      this.userCommonService.emitAudit({
        userId: currentUser.id,
        actorType,
        action: AuditEventEnum.USER_DEACTIVATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: currentUser.id,
        entityLabel: this.userCommonService.buildUserLabel(user),
        diff: { result: 'failure', reason: 'account_already_inactive' },
      });
      throw new BadRequestException('account_already_inactive');
    }

    const roleNames = user.userRoles.map((userRole) => userRole.role.name);
    const selfIsSuperAdmin = this.userCommonService.isSuperAdmin(roleNames);

    let sessionsRevoked = 0;

    try {
      await this.prisma.$transaction(async (tx) => {
        if (selfIsSuperAdmin) {
          const otherActiveSuperAdmins = await tx.user.count({
            where: {
              id: { not: currentUser.id },
              isActive: true,
              userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
            },
          });
          if (otherActiveSuperAdmins === 0) {
            throw new ForbiddenException('cannot_deactivate_last_super_admin');
          }
        }

        const result = await tx.user.updateMany({
          where: { id: currentUser.id, isActive: true },
          data: { isActive: false },
        });
        if (result.count === 0) {
          throw new BadRequestException('account_already_inactive');
        }

        const revoked = await tx.session.deleteMany({ where: { userId: currentUser.id } });
        sessionsRevoked = revoked.count;
      });

      // Postgres sessions are gone; drop anything Redis still holds for this user (retried if Redis is down).
      await this.cache.purgeUserCache(currentUser.id);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        this.userCommonService.emitAudit({
          userId: currentUser.id,
          actorType,
          action: AuditEventEnum.USER_DEACTIVATED,
          outcome: AuditOutcome.DENIED,
          severity: AuditSeverity.CRITICAL,
          entity: 'User',
          entityId: currentUser.id,
          entityLabel: this.userCommonService.buildUserLabel(user),
          diff: { result: 'denied', reason: 'cannot_deactivate_last_super_admin' },
          metadata: { selfService: true, targetRoles: roleNames, otherActiveSuperAdmins: 0 },
        });
      } else {
        this.userCommonService.emitAudit({
          userId: currentUser.id,
          actorType,
          action: AuditEventEnum.USER_DEACTIVATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'User',
          entityId: currentUser.id,
          entityLabel: this.userCommonService.buildUserLabel(user),
          diff: { result: 'failure', reason: 'account_transition_conflict' },
          metadata: { selfService: true },
        });
      }
      throw err;
    }

    this.userCommonService.emitAudit({
      userId: currentUser.id,
      actorType,
      action: AuditEventEnum.USER_DEACTIVATED,
      entity: 'User',
      entityId: currentUser.id,
      entityLabel: this.userCommonService.buildUserLabel(user),
      diff: { result: 'success', previousIsActive: true, currentIsActive: false },
      metadata: { selfService: true, sessionsRevoked, wasSuperAdmin: selfIsSuperAdmin },
    });

    return { message: 'account_deactivated' };
  }

  async revokeSession(
    actor: CurrentUserDto,
    targetUserId: string,
    sessionId: string,
  ): Promise<{ message: string }> {
    const actorType = resolveActorType(this.userCommonService.getRoles(actor));
    const isSelfService = actor.id === targetUserId;

    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId: targetUserId },
    });

    if (!session) {
      this.userCommonService.emitAudit({
        userId: actor.id,
        ...(isSelfService ? {} : { targetUserId }),
        actorType,
        action: AuditEventEnum.USER_SESSIONS_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Session',
        entityId: sessionId,
        diff: { result: 'failure', reason: 'session_not_found' },
        metadata: { scope: 'single_session' },
      });
      throw new NotFoundException('session_not_found');
    }

    await this.prisma.session.delete({ where: { id: sessionId } });
    await this.cache.purgeUserCache(targetUserId);

    this.userCommonService.emitAudit({
      userId: actor.id,
      ...(isSelfService ? {} : { targetUserId }),
      actorType,
      action: AuditEventEnum.USER_SESSIONS_REVOKED,
      entity: 'Session',
      entityId: sessionId,
      diff: { result: 'success' },
      metadata: { scope: 'single_session', selfService: isSelfService },
    });

    return { message: 'session_revoked' };
  }

  async changePhoneInitiate(
    user: CurrentUserDto,
    data: ChangePhoneInitiateDto,
  ): Promise<{ verificationId: string }> {
    const actorType = resolveActorType(this.userCommonService.getRoles(user));
    const newPhone = this.userCommonService.normalizePhoneOrThrow(data.newPhone);

    const dbUser = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!dbUser) {
      throw new NotFoundException('user_not_found');
    }

    if (dbUser.phone === newPhone) {
      this.userCommonService.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.INFO,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userCommonService.buildUserLabel(dbUser),
        diff: { result: 'failure', reason: 'phone_unchanged', context: 'change_phone_initiated' },
      });
      throw new BadRequestException('phone_unchanged');
    }

    const phoneInUse = await this.prisma.user.findUnique({ where: { phone: newPhone } });
    if (phoneInUse && phoneInUse.id !== user.id) {
      this.userCommonService.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userCommonService.buildUserLabel(dbUser),
        diff: {
          result: 'failure',
          reason: 'phone_already_registered',
          context: 'change_phone_initiated',
        },
        metadata: { attemptedPhone: this.userCommonService.maskPhone(newPhone) },
      });
      throw new BadRequestException('phone_already_registered');
    }

    try {
      await this.prisma.user.update({ where: { id: user.id }, data: { pendingPhone: newPhone } });
    } catch (error) {
      if (this.userCommonService.isUniqueConstraintError(error)) {
        this.userCommonService.emitAudit({
          userId: user.id,
          actorType,
          action: AuditEventEnum.USER_UPDATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'User',
          entityId: user.id,
          entityLabel: this.userCommonService.buildUserLabel(dbUser),
          diff: {
            result: 'failure',
            reason: 'phone_already_registered',
            context: 'change_phone_initiated',
          },
          metadata: {
            attemptedPhone: this.userCommonService.maskPhone(newPhone),
            detectedBy: 'unique_constraint',
          },
        });
        throw new BadRequestException('phone_already_registered');
      }
      throw error;
    }

    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      user.id,
      newPhone,
      UserOtpPurposeEnum.phone_change,
      OtpChannelEnum.sms,
    );

    this.userCommonService.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.USER_UPDATED,
      entity: 'User',
      entityId: user.id,
      entityLabel: this.userCommonService.buildUserLabel(dbUser),
      diff: {
        result: 'success',
        context: 'change_phone_initiated',
        previousPhoneMasked: this.userCommonService.maskPhone(dbUser.phone),
        newPhoneMasked: this.userCommonService.maskPhone(newPhone),
      },
    });

    return { verificationId };
  }

  async changePhoneVerify(
    user: CurrentUserDto,
    data: ChangePhoneVerifyDto,
  ): Promise<{ message: string }> {
    const actorType = resolveActorType(this.userCommonService.getRoles(user));

    const otpRecord = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      include: { user: { select: { id: true, name: true, phone: true, pendingPhone: true } } },
    });

    if (
      !otpRecord ||
      otpRecord.userId !== user.id ||
      otpRecord.purpose !== UserOtpPurposeEnum.phone_change ||
      otpRecord.usedAt ||
      otpRecord.expiresAt < new Date()
    ) {
      this.userCommonService.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord?.id ?? null,
        entityLabel: 'phone_change OTP',
        diff: {
          purpose: 'phone_change',
          result: 'failure',
          reason: !otpRecord
            ? 'otp_not_found'
            : otpRecord.userId !== user.id
              ? 'otp_owner_mismatch'
              : otpRecord.purpose !== UserOtpPurposeEnum.phone_change
                ? 'wrong_purpose'
                : otpRecord.usedAt
                  ? 'already_used'
                  : 'expired',
        },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (!otpRecord.user.pendingPhone) {
      this.userCommonService.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        entityLabel: 'phone_change OTP',
        diff: { purpose: 'phone_change', result: 'failure', reason: 'no_pending_phone_change' },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.attempts >= 5) {
      await this.lockoutUtil.lockAccountForOtpAbuse(user.id);
      this.userCommonService.emitAudit({
        targetUserId: user.id,
        actorType: 'SYSTEM',
        action: AuditEventEnum.SECURITY_ALERT,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        entityLabel: 'phone_change OTP',
        diff: { result: 'denied', reason: 'too_many_otp_attempts', accountLocked: true },
        metadata: { purpose: 'phone_change', attempts: otpRecord.attempts },
      });
      throw new BadRequestException('too_many_otp_attempts');
    }

    const validOtp = await bcrypt.compare(data.otp, otpRecord.otpHash);

    if (!validOtp) {
      const updatedOtp = await this.prisma.userOtp.update({
        where: { id: otpRecord.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });

      if (updatedOtp.attempts >= 5) {
        await this.lockoutUtil.lockAccountForOtpAbuse(user.id);
        this.userCommonService.emitAudit({
          targetUserId: user.id,
          actorType: 'SYSTEM',
          action: AuditEventEnum.SECURITY_ALERT,
          outcome: AuditOutcome.DENIED,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: 'phone_change OTP',
          diff: { result: 'denied', reason: 'too_many_otp_attempts', accountLocked: true },
          metadata: { purpose: 'phone_change', attempts: updatedOtp.attempts },
        });
      } else {
        this.userCommonService.emitAudit({
          userId: user.id,
          actorType,
          action: AuditEventEnum.OTP_VERIFIED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: 'phone_change OTP',
          diff: { purpose: 'phone_change', result: 'failure', reason: 'wrong_otp' },
          metadata: { attempts: updatedOtp.attempts },
        });
      }
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const newPhone = otpRecord.user.pendingPhone;

    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.userOtp.updateMany({
          where: {
            id: data.verificationId,
            usedAt: null,
            attempts: { lt: 5 },
            expiresAt: { gt: new Date() },
          },
          data: { usedAt: new Date() },
        });
        if (claimed.count === 0) {
          throw new BadRequestException('invalid_or_expired_otp');
        }

        await tx.user.update({
          where: { id: user.id },
          data: { phone: newPhone, pendingPhone: null },
        });
      });
    } catch (error) {
      if (this.userCommonService.isUniqueConstraintError(error)) {
        this.userCommonService.emitAudit({
          userId: user.id,
          actorType,
          action: AuditEventEnum.OTP_VERIFIED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: 'phone_change OTP',
          diff: {
            purpose: 'phone_change',
            result: 'failure',
            reason: 'phone_claimed_by_another_account',
          },
        });
        throw new BadRequestException('phone_already_registered');
      }
      if (error instanceof BadRequestException) {
        this.userCommonService.emitAudit({
          userId: user.id,
          actorType,
          action: AuditEventEnum.OTP_VERIFIED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: 'phone_change OTP',
          diff: { purpose: 'phone_change', result: 'failure', reason: 'otp_claim_conflict' },
        });
      }
      throw error;
    }

    // Cached profile/session still carry the old phone number.
    await this.cache.purgeUserCache(user.id);

    this.userCommonService.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.OTP_VERIFIED,
      entity: 'UserOtp',
      entityId: otpRecord.id,
      entityLabel: 'phone_change OTP',
      diff: { purpose: 'phone_change', result: 'success' },
      metadata: {
        previousPhoneMasked: this.userCommonService.maskPhone(otpRecord.user.phone),
        newPhoneMasked: this.userCommonService.maskPhone(newPhone),
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.SECURITY_ALERT, {
      userId: user.id,
      reason: 'phone_changed',
    });

    return { message: 'phone_number_changed' };
  }

  async revokeMyOtherSessions(currentUser: CurrentUserDto) {
    const currentSessionId = (currentUser as unknown as { sessionId?: string }).sessionId;
    if (!currentSessionId) throw new BadRequestException('current_session_unknown');

    const revoked = await this.prisma.session.deleteMany({
      where: { userId: currentUser.id, id: { not: currentSessionId } },
    });
    await this.cache.purgeUserCache(currentUser.id);

    this.userCommonService.auditUser(
      currentUser,
      currentUser.id,
      AuditEventEnum.USER_SESSIONS_REVOKED,
      'other_sessions',
      {
        metadata: { scope: 'other_sessions', sessionsRevoked: revoked.count, selfService: true },
      },
    );
    return { message: 'other_sessions_revoked', sessionsRevoked: revoked.count };
  }

  async getMyLoginHistory(currentUser: CurrentUserDto, query: UsersPagedQueryDto) {
    return this.userCommonService.loginHistory(currentUser.id, query);
  }

  async getMySecurityEvents(currentUser: CurrentUserDto, query: UsersPagedQueryDto) {
    return this.userCommonService.securityEvents(currentUser.id, query);
  }

  async getMySummary(currentUser: CurrentUserDto) {
    return this.userCommonService.buildSummary(currentUser.id);
  }

  async getMyLinkedAccounts(currentUser: CurrentUserDto) {
    const { providers, hasPassword } = await this.userCommonService.linkedProviders(currentUser.id);
    return { accounts: providers.map((provider) => ({ provider })), hasPassword };
  }

  async unlinkMyAccount(
    currentUser: CurrentUserDto,
    provider: string,
  ): Promise<{ message: string }> {
    const name = provider.toLowerCase();
    if (!LINKED_PROVIDERS.includes(name)) throw new BadRequestException('unsupported_provider');

    const { providers, hasPassword } = await this.userCommonService.linkedProviders(currentUser.id);
    if (!providers.includes(name)) throw new NotFoundException('linked_account_not_found');
    if (!hasPassword && providers.length <= 1) {
      throw new BadRequestException('no_other_sign_in_method');
    }

    await this.userCommonService.db.user.update({
      where: { id: currentUser.id },
      data: { [`${name}Id`]: null },
    });
    await this.cache.purgeUserCache(currentUser.id);

    this.userCommonService.auditUser(
      currentUser,
      currentUser.id,
      AuditEventEnum.USER_UPDATED,
      'account_unlinked',
      {
        severity: AuditSeverity.WARNING,
        diff: { provider: name },
      },
    );
    return { message: 'account_unlinked' };
  }

  async getMyConsents(currentUser: CurrentUserDto) {
    return this.userCommonService.listFor('userConsent', {
      where: { userId: currentUser.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async resendChangePhoneOtp(currentUser: CurrentUserDto, data: ResendPhoneOtpDto) {
    const otp = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      include: { user: { select: { pendingPhone: true } } },
    });
    if (
      !otp ||
      otp.userId !== currentUser.id ||
      otp.purpose !== UserOtpPurposeEnum.phone_change ||
      otp.usedAt ||
      !otp.user.pendingPhone
    ) {
      throw new BadRequestException('invalid_or_expired_otp');
    }
    if (Date.now() - otp.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      throw new BadRequestException('otp_resend_too_soon');
    }

    // Retire the old code so only the newest one verifies.
    await this.prisma.userOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      currentUser.id,
      otp.user.pendingPhone,
      UserOtpPurposeEnum.phone_change,
      OtpChannelEnum.sms,
    );

    this.userCommonService.auditUser(
      currentUser,
      currentUser.id,
      AuditEventEnum.USER_UPDATED,
      'change_phone_otp_resent',
      {
        diff: { newPhoneMasked: this.userCommonService.maskPhone(otp.user.pendingPhone) },
      },
    );
    return { verificationId };
  }
}

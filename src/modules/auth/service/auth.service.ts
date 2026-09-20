import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  AuditOutcome,
  AuditSeverity,
  UserOtpPurposeEnum,
  OtpChannelEnum,
  Prisma,
} from '@prisma/client';

import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { normalizePhoneNumber } from 'src/common/utils/phone.util';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { OtpUtil } from 'src/common/utils/otp.util';
import { LockoutUtil } from 'src/common/utils/lockout.util';
import { TokenUtil } from 'src/common/utils/token.util';

import { sendSms } from 'src/services/sms/sendet.service';
import { renderOtpSms } from 'src/services/sms/templates/sms-otp.template';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import {
  PasswordChangedEvent,
  PasswordResetEvent,
} from 'src/modules/misc/events/notification.events';

import {
  ChangePasswordInitiateDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshTokenDto,
  ResetPasswordDto,
  SignupDto,
  SignupVerifyDto,
} from '../dto/auth.dto';

type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

type LoginResult =
  | TokenPair
  | {
      requiresVerification: true;
      verificationId: string;
      message: string;
    };

type ForgotPasswordResult = {
  verificationId: string;
  purpose?: 'password_reset' | 'phone_verification';
};

const ADMIN_ROLES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

type UserRoleWithPermissions = {
  role: {
    name: string;
    rolePermissions: { permission: { name: string } }[];
  };
};

type OtpAuditRecord = { id: string; purpose: UserOtpPurposeEnum; attempts: number };
type OtpAuditUser = { id: string; name: string | null };

type AuditMetadata = Record<string, string | number | boolean | null>;

const SYSTEM_ACTOR = 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly otpUtil: OtpUtil,
    private readonly lockoutUtil: LockoutUtil,
    private readonly tokenUtil: TokenUtil,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  private maskPhone(phone: string): string {
    return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
  }

  private emitOtpRejected(args: {
    action: AuditEventEnum;
    reason: string;
    outcome: AuditOutcome;
    severity: AuditSeverity;
    otp?: OtpAuditRecord;
    user?: OtpAuditUser;
    roles?: string[];
    metadata?: AuditMetadata;
  }): void {
    const { action, reason, outcome, severity, otp, user, roles, metadata } = args;

    this.emitAudit({
      userId: user?.id ?? null,
      actorType: resolveActorType(roles ?? []),
      action,
      outcome,
      severity,
      entity: 'UserOtp',
      entityId: otp?.id ?? null,
      entityLabel: otp ? `${otp.purpose} OTP` : undefined,
      diff: { result: outcome === AuditOutcome.DENIED ? 'denied' : 'failure', reason },
      metadata: {
        ...(otp ? { purpose: otp.purpose, attempts: otp.attempts } : {}),
        ...(metadata ?? {}),
      },
    });
  }

  private emitOtpLockout(otp: OtpAuditRecord, user: OtpAuditUser): void {
    this.emitAudit({
      targetUserId: user.id,
      actorType: SYSTEM_ACTOR,
      action: AuditEventEnum.SECURITY_ALERT,
      outcome: AuditOutcome.DENIED,
      severity: AuditSeverity.WARNING,
      entity: 'UserOtp',
      entityId: otp.id,
      entityLabel: `${otp.purpose} OTP`,
      diff: { result: 'denied', reason: 'too_many_otp_attempts', accountLocked: true },
      metadata: {
        purpose: otp.purpose,
        attempts: otp.attempts,
        targetUserName: user.name ?? null,
      },
    });
  }

  private requirePhone(phone: string | null): string {
    if (!phone) {
      throw new BadRequestException('phone_number_missing');
    }
    return phone;
  }

  private hasAdminRole(roles: string[]): boolean {
    return roles.some((role) => ADMIN_ROLES.includes(role as RolesEnum));
  }

  private derivePermissions(userRoles: UserRoleWithPermissions[]): string[] {
    return [
      ...new Set(
        userRoles.flatMap((userRole) =>
          userRole.role.rolePermissions.map((rp) => rp.permission.name),
        ),
      ),
    ];
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  async signup(data: SignupDto): Promise<{ verificationId: string }> {
    const phone = this.normalizePhoneOrThrow(data.phone);

    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
    });

    if (existingUser) {
      if (existingUser.isPhoneVerified) {
        this.emitAudit({
          targetUserId: existingUser.id,
          actorType: resolveActorType([]),
          action: AuditEventEnum.USER_CREATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.INFO,
          entity: 'User',
          entityId: existingUser.id,
          entityLabel: existingUser.name ?? undefined,
          diff: { result: 'failure', reason: 'phone_already_registered' },
        });
        throw new BadRequestException('phone_already_registered');
      }

      const { verificationId } = await this.otpUtil.issueAndSendOtp(
        existingUser.id,
        this.requirePhone(existingUser.phone),
        UserOtpPurposeEnum.phone_verification,
        OtpChannelEnum.sms,
      );

      return { verificationId };
    }

    const userRole = await this.prisma.role.findUnique({
      where: { name: RolesEnum.USER },
    });

    if (!userRole) {
      this.emitAudit({
        actorType: resolveActorType([]),
        action: AuditEventEnum.USER_CREATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.CRITICAL,
        entity: 'User',
        entityId: null,
        diff: { result: 'failure', reason: 'user_role_not_configured' },
        metadata: { attemptedPhone: this.maskPhone(phone) },
      });
      throw new BadRequestException('user_role_not_configured');
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    let result: { verificationId: string; otp: string; phone: string | null; userId: string };

    try {
      result = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: data.name,
            phone,
            passwordHash: hashedPassword,
            userRoles: {
              create: { roleId: userRole.id },
            },
          },
        });

        const otp = this.otpUtil.generateOtp();
        const otpHash = await bcrypt.hash(otp, 12);

        const otpExpiresInMinutes = this.configService.get<number>('otp.expiresInMinutes', 10);

        const userOtp = await tx.userOtp.create({
          data: {
            userId: user.id,
            otpHash,
            expiresAt: new Date(Date.now() + otpExpiresInMinutes * 60 * 1000),
            purpose: UserOtpPurposeEnum.phone_verification,
            channel: OtpChannelEnum.sms,
          },
        });

        return {
          verificationId: userOtp.id,
          otp,
          phone: user.phone,
          userId: user.id,
        };
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        this.emitAudit({
          actorType: resolveActorType([]),
          action: AuditEventEnum.USER_CREATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.INFO,
          entity: 'User',
          entityId: null,
          diff: { result: 'failure', reason: 'phone_already_registered' },
          metadata: { attemptedPhone: this.maskPhone(phone), raceLost: true },
        });
        throw new BadRequestException('phone_already_registered');
      }
      throw error;
    }

    const smsMessage = renderOtpSms({
      otp: result.otp,
      expiresInMinutes: this.configService.get<number>('otp.expiresInMinutes', 10),
      purpose: UserOtpPurposeEnum.phone_verification,
    });

    let smsDelivered = true;

    try {
      await sendSms(this.requirePhone(result.phone), smsMessage);
    } catch (error) {
      smsDelivered = false;
      this.logger.error(
        `Failed to send signup OTP to ${this.maskPhone(phone)}`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    this.emitAudit({
      userId: result.userId,
      actorType: resolveActorType([userRole.name]),
      action: AuditEventEnum.USER_CREATED,
      entity: 'User',
      entityId: result.userId,
      entityLabel: data.name,
      diff: { result: 'success' },
      metadata: { otpChannel: 'sms', smsDelivered },
    });

    return { verificationId: result.verificationId };
  }

  async verifySignupOtp(data: SignupVerifyDto): Promise<TokenPair> {
    const phone = this.normalizePhoneOrThrow(data.phone);

    const otpRecord = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: {
                  include: {
                    rolePermissions: { include: { permission: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!otpRecord) {
      this.emitOtpRejected({
        action: AuditEventEnum.OTP_VERIFIED,
        reason: 'otp_not_found',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        metadata: { attemptedVerificationId: data.verificationId },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const roles = otpRecord.user.userRoles.map((userRole) => userRole.role.name);
    const permissions = this.derivePermissions(otpRecord.user.userRoles);

    const otpAudit: OtpAuditRecord = {
      id: otpRecord.id,
      purpose: otpRecord.purpose,
      attempts: otpRecord.attempts,
    };
    const userAudit: OtpAuditUser = { id: otpRecord.user.id, name: otpRecord.user.name };

    if (otpRecord.user.phone !== phone) {
      this.emitOtpRejected({
        action: AuditEventEnum.OTP_VERIFIED,
        reason: 'phone_mismatch',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        otp: otpAudit,
        user: userAudit,
        roles,
        metadata: { attemptedPhone: this.maskPhone(phone) },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.purpose !== UserOtpPurposeEnum.phone_verification) {
      this.emitOtpRejected({
        action: AuditEventEnum.OTP_VERIFIED,
        reason: 'otp_purpose_mismatch',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        otp: otpAudit,
        user: userAudit,
        roles,
        metadata: { expectedPurpose: UserOtpPurposeEnum.phone_verification },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.usedAt) {
      this.emitOtpRejected({
        action: AuditEventEnum.OTP_VERIFIED,
        reason: 'otp_already_used',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        otp: otpAudit,
        user: userAudit,
        roles,
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.expiresAt < new Date()) {
      this.emitOtpRejected({
        action: AuditEventEnum.OTP_VERIFIED,
        reason: 'otp_expired',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.INFO,
        otp: otpAudit,
        user: userAudit,
        roles,
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.attempts >= 5) {
      await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

      this.emitOtpLockout(otpAudit, userAudit);

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
        await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

        this.emitOtpLockout({ ...otpAudit, attempts: updatedOtp.attempts }, userAudit);
      } else {
        this.emitOtpRejected({
          action: AuditEventEnum.OTP_VERIFIED,
          reason: 'invalid_otp',
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          otp: { ...otpAudit, attempts: updatedOtp.attempts },
          user: userAudit,
          roles,
        });
      }

      throw new BadRequestException('invalid_or_expired_otp');
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.userOtp.updateMany({
        where: {
          id: otpRecord.id,
          usedAt: null,
          attempts: { lt: 5 },
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });

      if (claimed.count === 0) {
        this.emitOtpRejected({
          action: AuditEventEnum.OTP_VERIFIED,
          reason: 'otp_claim_conflict',
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          otp: otpAudit,
          user: userAudit,
          roles,
        });
        throw new BadRequestException('invalid_or_expired_otp');
      }

      await tx.user.update({
        where: { id: otpRecord.user.id },
        data: { isPhoneVerified: true },
      });
    });

    this.emitAudit({
      userId: otpRecord.user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.OTP_VERIFIED,
      entity: 'UserOtp',
      entityId: otpRecord.id,
      entityLabel: `${otpRecord.purpose} OTP`,
      diff: {
        result: 'success',
        previousIsPhoneVerified: otpRecord.user.isPhoneVerified,
        currentIsPhoneVerified: true,
      },
      metadata: { purpose: otpRecord.purpose },
    });

    return this.tokenUtil.issueTokens(
      otpRecord.user.id,
      { phone: otpRecord.user.phone },
      roles,
      permissions,
    );
  }

  async resendSignupOtp(verificationId: string): Promise<{ verificationId: string }> {
    const oldOtp = await this.prisma.userOtp.findUnique({
      where: { id: verificationId },
      include: { user: true },
    });

    if (!oldOtp || oldOtp.purpose !== UserOtpPurposeEnum.phone_verification) {
      throw new BadRequestException('invalid_verification');
    }

    if (oldOtp.usedAt) {
      throw new BadRequestException('phone_already_verified');
    }

    const { verificationId: newVerificationId } = await this.otpUtil.issueAndSendOtp(
      oldOtp.userId,
      this.requirePhone(oldOtp.user.phone),
      UserOtpPurposeEnum.phone_verification,
      OtpChannelEnum.sms,
    );

    return { verificationId: newVerificationId };
  }

  async login(data: LoginDto): Promise<LoginResult> {
    const phone = this.normalizePhoneOrThrow(data.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
              },
            },
          },
        },
      },
    });

    if (!user || !user.passwordHash) {
      this.emitAudit({
        userId: user?.id ?? null,
        actorType: resolveActorType(
          user ? user.userRoles.map((userRole) => userRole.role.name) : [],
        ),
        action: AuditEventEnum.LOGIN_FAILED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user?.id ?? null,
        entityLabel: user?.name ?? undefined,
        diff: { result: 'failed', reason: user ? 'no_password_set' : 'unknown_account' },
        metadata: {
          method: 'password',
          ...(user ? {} : { attemptedPhone: this.maskPhone(phone) }),
        },
      });

      throw new UnauthorizedException('invalid_credentials');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);
    const permissions = this.derivePermissions(user.userRoles);

    // Password is verified before any account-state check so failures stay indistinguishable.
    const validPassword = await bcrypt.compare(data.password, user.passwordHash);

    if (!validPassword) {
      await this.lockoutUtil.recordFailedLogin(user.id);

      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: user.name ?? undefined,
        diff: { result: 'failed', reason: 'wrong_password' },
        metadata: { method: 'password' },
      });

      throw new UnauthorizedException('invalid_credentials');
    }

    if (!roles.includes(RolesEnum.USER)) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: user.name ?? undefined,
        diff: {
          result: 'failed',
          reason: 'no_user_role_use_admin_login',
        },
        metadata: { method: 'password' },
      });

      throw new UnauthorizedException('use_admin_login');
    }

    try {
      this.lockoutUtil.assertNotLocked(user);
    } catch (err) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: user.name ?? undefined,
        diff: {
          result: 'failed',
          reason: 'account_locked',
        },
        metadata: { method: 'password' },
      });
      throw err;
    }

    await this.lockoutUtil.resetLoginAttempts(user);

    if (!user.isActive) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: user.name ?? undefined,
        diff: {
          result: 'failed',
          reason: 'account_inactive',
        },
        metadata: { method: 'password' },
      });

      throw new UnauthorizedException('account_inactive');
    }

    if (!user.isPhoneVerified) {
      const { verificationId } = await this.otpUtil.issueAndSendOtp(
        user.id,
        this.requirePhone(user.phone),
        UserOtpPurposeEnum.phone_verification,
        OtpChannelEnum.sms,
      );

      return {
        requiresVerification: true,
        verificationId,
        message: 'phone_not_verified_otp_sent',
      };
    }

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.LOGIN_SUCCESS,
      entity: 'User',
      entityId: user.id,
      entityLabel: user.name ?? undefined,
      diff: { result: 'success' },
      metadata: { method: 'password' },
    });

    return this.tokenUtil.issueTokens(
      user.id,
      { phone: user.phone, email: user.email },
      roles,
      permissions,
    );
  }

  async forgotPassword(data: ForgotPasswordDto): Promise<ForgotPasswordResult> {
    const phone = this.normalizePhoneOrThrow(data.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: {
        id: true,
        name: true,
        phone: true,
        isPhoneVerified: true,
        isActive: true,
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });

    const roles = user?.userRoles.map((userRole) => userRole.role.name) ?? [];

    if (!user || !user.isActive || this.hasAdminRole(roles)) {
      this.emitAudit({
        userId: user?.id ?? null,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.PASSWORD_RESET,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user?.id ?? null,
        entityLabel: user?.name ?? undefined,
        diff: {
          result: 'denied',
          reason: !user
            ? 'unknown_account'
            : !user.isActive
              ? 'account_inactive'
              : 'admin_role_use_admin_flow',
        },
        metadata: {
          stage: 'forgot_password_request',
          ...(user ? {} : { attemptedPhone: this.maskPhone(phone) }),
        },
      });

      return { verificationId: '' };
    }

    if (!user.isPhoneVerified) {
      const { verificationId } = await this.otpUtil.issueAndSendOtp(
        user.id,
        this.requirePhone(user.phone),
        UserOtpPurposeEnum.phone_verification,
        OtpChannelEnum.sms,
      );

      return { verificationId, purpose: 'phone_verification' };
    }

    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      user.id,
      this.requirePhone(user.phone),
      UserOtpPurposeEnum.password_reset,
      OtpChannelEnum.sms,
    );

    return { verificationId, purpose: 'password_reset' };
  }

  async resetPassword(data: ResetPasswordDto): Promise<{ message: string }> {
    const otpRecord = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            userRoles: { include: { role: true } },
          },
        },
      },
    });

    if (!otpRecord) {
      this.emitOtpRejected({
        action: AuditEventEnum.PASSWORD_RESET,
        reason: 'otp_not_found',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        metadata: { attemptedVerificationId: data.verificationId },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const roles = otpRecord.user.userRoles.map((userRole) => userRole.role.name);

    const otpAudit: OtpAuditRecord = {
      id: otpRecord.id,
      purpose: otpRecord.purpose,
      attempts: otpRecord.attempts,
    };
    const userAudit: OtpAuditUser = { id: otpRecord.user.id, name: otpRecord.user.name };

    if (otpRecord.purpose !== UserOtpPurposeEnum.password_reset) {
      this.emitOtpRejected({
        action: AuditEventEnum.PASSWORD_RESET,
        reason: 'otp_purpose_mismatch',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        otp: otpAudit,
        user: userAudit,
        roles,
        metadata: { expectedPurpose: UserOtpPurposeEnum.password_reset },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.usedAt) {
      this.emitOtpRejected({
        action: AuditEventEnum.PASSWORD_RESET,
        reason: 'otp_already_used',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        otp: otpAudit,
        user: userAudit,
        roles,
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.expiresAt < new Date()) {
      this.emitOtpRejected({
        action: AuditEventEnum.PASSWORD_RESET,
        reason: 'otp_expired',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.INFO,
        otp: otpAudit,
        user: userAudit,
        roles,
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.attempts >= 5) {
      await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

      this.emitOtpLockout(otpAudit, userAudit);

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
        await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

        this.emitOtpLockout({ ...otpAudit, attempts: updatedOtp.attempts }, userAudit);
      } else {
        this.emitOtpRejected({
          action: AuditEventEnum.PASSWORD_RESET,
          reason: 'invalid_otp',
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          otp: { ...otpAudit, attempts: updatedOtp.attempts },
          user: userAudit,
          roles,
        });
      }

      throw new BadRequestException('invalid_or_expired_otp');
    }

    const hashedPassword = await bcrypt.hash(data.newPassword, 10);

    let sessionsRevoked = 0;

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
        this.emitOtpRejected({
          action: AuditEventEnum.PASSWORD_RESET,
          reason: 'otp_claim_conflict',
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          otp: otpAudit,
          user: userAudit,
          roles,
        });
        throw new BadRequestException('invalid_or_expired_otp');
      }

      await tx.user.update({
        where: { id: otpRecord.user.id },
        data: { passwordHash: hashedPassword },
      });

      const revoked = await tx.session.deleteMany({
        where: { userId: otpRecord.user.id },
      });
      sessionsRevoked = revoked.count;
    });

    this.emitAudit({
      userId: otpRecord.user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.PASSWORD_RESET,
      entity: 'User',
      entityId: otpRecord.user.id,
      entityLabel: otpRecord.user.name ?? undefined,
      diff: { result: 'success' },
      metadata: { method: 'otp', sessionsRevoked },
    });

    const resetEvent: PasswordResetEvent = { userId: otpRecord.user.id };
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_RESET, resetEvent);

    return { message: 'password_reset_successful' };
  }

  async refresh(data: RefreshTokenDto): Promise<TokenPair> {
    let payload: {
      sub: string;
      phone: string;
      roles: string[];
      type: string;
    };

    const refreshSecret =
      this.configService.get<string>('jwt.refreshSecret') ??
      this.configService.getOrThrow<string>('jwt.secret');

    try {
      payload = this.jwtService.verify(data.refreshToken, {
        secret: refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('invalid_refresh_token');
    }

    if (payload.type !== 'refresh') {
      this.emitAudit({
        userId: payload.sub,
        actorType: resolveActorType(payload.roles ?? []),
        action: AuditEventEnum.SECURITY_ALERT,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: payload.sub,
        diff: { result: 'denied', reason: 'wrong_token_type' },
        metadata: { method: 'refresh_token', presentedTokenType: payload.type ?? null },
      });
      throw new UnauthorizedException('invalid_refresh_token');
    }

    const refreshTokenHash = this.tokenUtil.hashOpaqueToken(data.refreshToken, 'refresh');

    const session = await this.prisma.session.findFirst({
      where: {
        userId: payload.sub,
        refreshToken: refreshTokenHash,
      },
    });

    if (!session) {
      throw new UnauthorizedException('session_expired_or_invalid');
    }

    if (session.revokedAt) {
      // Reuse of a rotated refresh token means it was stolen, so every session is revoked.
      const wiped = await this.prisma.session.updateMany({
        where: { userId: payload.sub, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      this.emitAudit({
        targetUserId: payload.sub,
        actorType: SYSTEM_ACTOR,
        action: AuditEventEnum.SECURITY_ALERT,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.CRITICAL,
        entity: 'Session',
        entityId: session.id,
        diff: {
          result: 'denied',
          reason: 'refresh_token_reuse_detected',
          sessionsRevoked: wiped.count,
        },
        metadata: { reusedTokenRevokedAt: session.revokedAt.toISOString() },
      });

      throw new UnauthorizedException('session_expired_or_invalid');
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('session_expired_or_invalid');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
              },
            },
          },
        },
      },
    });

    if (!user || !user.isActive) {
      this.emitAudit({
        userId: payload.sub,
        actorType: resolveActorType(payload.roles ?? []),
        action: AuditEventEnum.LOGIN_FAILED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: payload.sub,
        entityLabel: user?.name ?? undefined,
        diff: { result: 'failed', reason: user ? 'account_inactive' : 'user_not_found' },
        metadata: { method: 'refresh_token', sessionId: session.id },
      });
      throw new UnauthorizedException('user_inactive');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);
    const permissions = this.derivePermissions(user.userRoles);

    return this.prisma.$transaction(async (tx) => {
      const rotated = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      if (rotated.count === 0) {
        this.emitAudit({
          userId: user.id,
          actorType: resolveActorType(roles),
          action: AuditEventEnum.LOGIN_FAILED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'User',
          entityId: user.id,
          entityLabel: user.name ?? undefined,
          diff: { result: 'failed', reason: 'refresh_rotation_conflict' },
          metadata: { method: 'refresh_token', sessionId: session.id },
        });
        throw new UnauthorizedException('session_expired_or_invalid');
      }

      return this.tokenUtil.issueTokens(
        user.id,
        { phone: user.phone, email: user.email },
        roles,
        permissions,
        tx,
      );
    });
  }

  async me(currentUser: CurrentUserDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        discreetModeEnabled: true,
        discreetModeUpdatedAt: true,
        createdAt: true,
        updatedAt: true,
        userRoles: {
          select: {
            role: { select: { name: true } },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);
    const { userRoles: _userRoles, ...userData } = user;

    return { ...userData, roles };
  }

  async changePasswordInitiate(
    user: CurrentUserDto,
    data: ChangePasswordInitiateDto,
  ): Promise<{ verificationId: string }> {
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: {
        userRoles: { include: { role: true } },
      },
    });

    if (!dbUser) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(user.roles ?? []),
        action: AuditEventEnum.PASSWORD_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        diff: { result: 'failure', reason: 'user_not_found' },
        metadata: { stage: 'initiate' },
      });
      throw new NotFoundException('user_not_found');
    }

    const roles = dbUser.userRoles.map((userRole) => userRole.role.name);

    if (this.hasAdminRole(roles)) {
      this.emitAudit({
        userId: dbUser.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.PASSWORD_CHANGED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: dbUser.id,
        entityLabel: dbUser.name ?? undefined,
        diff: { result: 'denied', reason: 'use_admin_change_password' },
        metadata: { stage: 'initiate' },
      });
      throw new UnauthorizedException('use_admin_change_password');
    }

    if (!dbUser.passwordHash) {
      this.emitAudit({
        userId: dbUser.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.PASSWORD_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: dbUser.id,
        entityLabel: dbUser.name ?? undefined,
        diff: { result: 'failure', reason: 'password_not_set' },
        metadata: { stage: 'initiate' },
      });
      throw new BadRequestException('password_not_set');
    }

    const validPassword = await bcrypt.compare(data.currentPassword, dbUser.passwordHash);

    if (!validPassword) {
      this.emitAudit({
        userId: dbUser.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.PASSWORD_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: dbUser.id,
        entityLabel: dbUser.name ?? undefined,
        diff: { result: 'failure', reason: 'wrong_current_password' },
        metadata: { stage: 'initiate' },
      });
      throw new BadRequestException('wrong_current_password');
    }

    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      dbUser.id,
      this.requirePhone(dbUser.phone),
      UserOtpPurposeEnum.password_change,
      OtpChannelEnum.sms,
    );

    return { verificationId };
  }

  async changePasswordVerify(data: ResetPasswordDto): Promise<{ message: string }> {
    const otpRecord = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            userRoles: { include: { role: true } },
          },
        },
      },
    });

    if (!otpRecord) {
      this.emitOtpRejected({
        action: AuditEventEnum.PASSWORD_CHANGED,
        reason: 'otp_not_found',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        metadata: { attemptedVerificationId: data.verificationId, stage: 'verify' },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const roles = otpRecord.user.userRoles.map((userRole) => userRole.role.name);

    const otpAudit: OtpAuditRecord = {
      id: otpRecord.id,
      purpose: otpRecord.purpose,
      attempts: otpRecord.attempts,
    };
    const userAudit: OtpAuditUser = { id: otpRecord.user.id, name: otpRecord.user.name };

    if (otpRecord.purpose !== UserOtpPurposeEnum.password_change) {
      this.emitOtpRejected({
        action: AuditEventEnum.PASSWORD_CHANGED,
        reason: 'otp_purpose_mismatch',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        otp: otpAudit,
        user: userAudit,
        roles,
        metadata: { expectedPurpose: UserOtpPurposeEnum.password_change, stage: 'verify' },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.usedAt) {
      this.emitOtpRejected({
        action: AuditEventEnum.PASSWORD_CHANGED,
        reason: 'otp_already_used',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        otp: otpAudit,
        user: userAudit,
        roles,
        metadata: { stage: 'verify' },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.expiresAt < new Date()) {
      this.emitOtpRejected({
        action: AuditEventEnum.PASSWORD_CHANGED,
        reason: 'otp_expired',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.INFO,
        otp: otpAudit,
        user: userAudit,
        roles,
        metadata: { stage: 'verify' },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.attempts >= 5) {
      await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

      this.emitOtpLockout(otpAudit, userAudit);

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
        await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

        this.emitOtpLockout({ ...otpAudit, attempts: updatedOtp.attempts }, userAudit);
      } else {
        this.emitOtpRejected({
          action: AuditEventEnum.PASSWORD_CHANGED,
          reason: 'invalid_otp',
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          otp: { ...otpAudit, attempts: updatedOtp.attempts },
          user: userAudit,
          roles,
          metadata: { stage: 'verify' },
        });
      }

      throw new BadRequestException('invalid_or_expired_otp');
    }

    const hashedPassword = await bcrypt.hash(data.newPassword, 10);

    let sessionsRevoked = 0;

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
        this.emitOtpRejected({
          action: AuditEventEnum.PASSWORD_CHANGED,
          reason: 'otp_claim_conflict',
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          otp: otpAudit,
          user: userAudit,
          roles,
          metadata: { stage: 'verify' },
        });
        throw new BadRequestException('invalid_or_expired_otp');
      }

      await tx.user.update({
        where: { id: otpRecord.user.id },
        data: { passwordHash: hashedPassword },
      });

      const revoked = await tx.session.deleteMany({
        where: { userId: otpRecord.user.id },
      });
      sessionsRevoked = revoked.count;
    });

    this.emitAudit({
      userId: otpRecord.user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.PASSWORD_CHANGED,
      entity: 'User',
      entityId: otpRecord.user.id,
      entityLabel: otpRecord.user.name ?? undefined,
      diff: { result: 'success' },
      metadata: { method: 'otp', stage: 'verify', sessionsRevoked },
    });

    const changedEvent: PasswordChangedEvent = { userId: otpRecord.user.id };
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_CHANGED, changedEvent);

    return { message: 'password_changed' };
  }

  async logout(user: CurrentUserDto, req: any): Promise<{ message: string }> {
    const refreshToken = req?.body?.refreshToken || req?.headers?.['x-refresh-token'];

    let sessionsRevoked: number;

    if (refreshToken) {
      const deleted = await this.prisma.session.deleteMany({
        where: {
          userId: user.id,
          refreshToken: this.tokenUtil.hashOpaqueToken(refreshToken, 'refresh'),
        },
      });
      sessionsRevoked = deleted.count;
    } else {
      const deleted = await this.prisma.session.deleteMany({
        where: { userId: user.id },
      });
      sessionsRevoked = deleted.count;
    }

    const roles = user.roles ?? [];

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.LOGOUT,
      entity: 'User',
      entityId: user.id,
      diff: { result: 'success' },
      metadata: {
        scope: refreshToken ? 'single_session' : 'all_sessions',
        sessionsRevoked,
      },
    });

    return { message: 'logout_successful' };
  }

  private normalizePhoneOrThrow(phone: string): string {
    try {
      return normalizePhoneNumber(phone);
    } catch {
      throw new BadRequestException('invalid_phone_number');
    }
  }
}
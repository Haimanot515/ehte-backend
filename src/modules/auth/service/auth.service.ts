import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
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
  TwoFactorMethodEnum,
  TwoFactorChallengePurposeEnum,
} from '@prisma/client';

import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { normalizePhoneNumber } from 'src/common/utils/phone.util';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { hasStaffRole } from 'src/common/utils/role-protection.util';

import { OtpUtil } from 'src/common/utils/otp.util';
import { LockoutUtil } from 'src/common/utils/lockout.util';
import { TokenUtil } from 'src/common/utils/token.util';
import { SocialAuthUtil, SocialProfile } from 'src/common/utils/social-auth.util';
import { CacheService } from 'src/infrastructure/redis/cache.service'; // REDIS

import { sendSms } from 'src/infrastructure/sms/sendet.service';
import { renderOtpSms } from 'src/infrastructure/sms/templates/sms-otp.template';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import {
  PasswordChangedEvent,
  PasswordResetEvent,
} from 'src/modules/misc/notification/events/notification.events';

import {
  ChangePasswordInitiateDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshTokenDto,
  ResetPasswordDto,
  SignupDto,
  SignupVerifyDto,
} from '../dto/auth.dto';

import {
  SocialProviderEnum,
  TwoFactorMethodEnum as TwoFactorMethodDtoEnum,
  VerifyResetOtpDto,
  ReactivateInitiateDto,
  ReactivateVerifyDto,
  LinkSocialDto,
  SetPasswordDto,
  SignupStatusDto,
  RevokeRefreshTokenDto,
  TwoFactorSetupDto,
  TwoFactorVerifyDto,
  TwoFactorDisableDto,
  TwoFactorRegenerateDto,
  TwoFactorLoginVerifyDto,
  TwoFactorLoginRecoveryDto,
  TwoFactorLoginResendDto,
  TwoFactorStepUpDto,
} from '../dto/auth.dto';

import {
  buildOtpAuthUri,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotp,
} from 'src/common/utils/two-factor.util';

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

export type SocialProvider = 'google' | 'facebook' | 'apple';

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

// ── constants for the new auth features ──
const OTP_RESEND_HOURLY_CAP = 5;
const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TWO_FACTOR_MAX_ATTEMPTS = 5;
const TWO_FACTOR_RECOVERY_CODE_COUNT = 10;
const STEP_UP_TTL_SECONDS = 5 * 60;

// What loadUserForSecurity() returns, written out so finishChallenge() can name it.
type SecurityUser = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  userRoles: UserRoleWithPermissions[];
};

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
    private readonly socialAuthUtil: SocialAuthUtil,
    private readonly cache: CacheService, // REDIS
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

  // Kept in sync with AdminAuthService: any role other than USER / SYSTEM is "staff".
  private hasAdminRole(roles: string[]): boolean {
    return hasStaffRole(roles);
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

  /** Password hashing cost. Read once per call site rather than cached, so a
   * changed env value takes effect on the next request without a restart. */
  private get bcryptSaltRounds(): number {
    return this.configService.get<number>('security.bcryptSaltRounds', 10);
  }

  /** OTP hashing cost, intentionally separate from password hashing cost. */
  private get bcryptOtpSaltRounds(): number {
    return this.configService.get<number>('security.bcryptOtpSaltRounds', 12);
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

    const hashedPassword = await bcrypt.hash(data.password, this.bcryptSaltRounds);

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
        const otpHash = await bcrypt.hash(otp, this.bcryptOtpSaltRounds);

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
    const otpMaxAttempts = this.configService.get<number>('otp.maxAttempts', 5);

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

    if (otpRecord.attempts >= otpMaxAttempts) {
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

      if (updatedOtp.attempts >= otpMaxAttempts) {
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
          attempts: { lt: otpMaxAttempts },
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

  // SOCIAL LOGIN — GOOGLE. Controller passes the raw ID token straight through;
  // only SocialAuthUtil's own verified-token payload is trusted for the email.
  async loginWithGoogle(data: { idToken: string }): Promise<TokenPair> {
    const profile = await this.socialAuthUtil.verifyGoogleIdToken(data.idToken);
    return this.socialAuth('google', profile);
  }

  // SOCIAL LOGIN — FACEBOOK.
  async loginWithFacebook(data: { accessToken: string }): Promise<TokenPair> {
    const profile = await this.socialAuthUtil.verifyFacebookAccessToken(data.accessToken);
    return this.socialAuth('facebook', profile);
  }

  async loginWithApple(data: { idToken: string; name?: string }): Promise<TokenPair> {
    const profile = await this.socialAuthUtil.verifyAppleIdToken(data.idToken, data.name);
    return this.socialAuth('apple', profile);
  }

  private async socialAuth(provider: SocialProvider, profile: SocialProfile): Promise<TokenPair> {
    if (!profile.emailVerified) {
      throw new UnauthorizedException('unverified_social_email');
    }

    const providerWhere: Prisma.UserWhereInput =
      provider === 'google'
        ? { googleId: profile.providerId }
        : provider === 'facebook'
          ? { facebookId: profile.providerId }
          : { appleId: profile.providerId };
    const providerData =
      provider === 'google'
        ? { googleId: profile.providerId }
        : provider === 'facebook'
          ? { facebookId: profile.providerId }
          : { appleId: profile.providerId };

    const includeRoles = {
      userRoles: {
        include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
      },
    };

    let user = await this.prisma.user.findFirst({
      where: providerWhere,
      include: includeRoles,
    });

    let isNewUser = false;

    if (!user) {
      const existingByEmail = await this.prisma.user.findUnique({
        where: { email: profile.email },
        include: includeRoles,
      });

      if (existingByEmail) {
        user = await this.prisma.user.update({
          where: { id: existingByEmail.id },
          data: { ...providerData, isEmailVerified: true },
          include: includeRoles,
        });
      } else {
        const userRole = await this.prisma.role.findUnique({ where: { name: RolesEnum.USER } });

        if (!userRole) {
          this.emitAudit({
            actorType: resolveActorType([]),
            action: AuditEventEnum.USER_CREATED,
            outcome: AuditOutcome.FAILURE,
            severity: AuditSeverity.CRITICAL,
            entity: 'User',
            entityId: null,
            diff: { result: 'failure', reason: 'user_role_not_configured' },
            metadata: { provider, attemptedEmail: profile.email },
          });
          throw new BadRequestException('user_role_not_configured');
        }

        try {
          user = await this.prisma.user.create({
            data: {
              name: profile.name ?? profile.email.split('@')[0],
              email: profile.email,
              isEmailVerified: true,
              isActive: true,
              ...providerData,
              userRoles: { create: { roleId: userRole.id } },
            },
            include: includeRoles,
          });
        } catch (error) {
          if (this.isUniqueConstraintError(error)) {
            throw new BadRequestException('email_already_registered');
          }
          throw error;
        }

        isNewUser = true;
      }
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);
    const permissions = this.derivePermissions(user.userRoles);

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
        diff: { result: 'failed', reason: 'no_user_role_use_admin_login' },
        metadata: { method: provider },
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
        diff: { result: 'failed', reason: 'account_locked' },
        metadata: { method: provider },
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
        diff: { result: 'failed', reason: 'account_inactive' },
        metadata: { method: provider },
      });
      throw new UnauthorizedException('account_inactive');
    }

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(roles),
      action: isNewUser ? AuditEventEnum.USER_CREATED : AuditEventEnum.LOGIN_SUCCESS,
      entity: 'User',
      entityId: user.id,
      entityLabel: user.name ?? undefined,
      diff: { result: 'success' },
      metadata: { method: provider, linkedExistingAccount: !isNewUser },
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
    const otpMaxAttempts = this.configService.get<number>('otp.maxAttempts', 5);

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

    if (otpRecord.attempts >= otpMaxAttempts) {
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

      if (updatedOtp.attempts >= otpMaxAttempts) {
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

    const hashedPassword = await bcrypt.hash(data.newPassword, this.bcryptSaltRounds);

    let sessionsRevoked = 0;

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.userOtp.updateMany({
        where: {
          id: data.verificationId,
          usedAt: null,
          attempts: { lt: otpMaxAttempts },
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

    // REDIS: every Postgres session is gone; drop the cached session/profile too (retried if Redis is down).
    await this.cache.purgeUserCache(otpRecord.user.id);

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

      // REDIS: same event, same reason: nothing cached for this user may outlive the revocation.
      await this.cache.purgeUserCache(payload.sub);

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
    return this.cache.wrapProfile(currentUser.id, async () => {
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
    });
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
    const otpMaxAttempts = this.configService.get<number>('otp.maxAttempts', 5);

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

    if (otpRecord.attempts >= otpMaxAttempts) {
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

      if (updatedOtp.attempts >= otpMaxAttempts) {
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

    const hashedPassword = await bcrypt.hash(data.newPassword, this.bcryptSaltRounds);

    let sessionsRevoked = 0;

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.userOtp.updateMany({
        where: {
          id: data.verificationId,
          usedAt: null,
          attempts: { lt: otpMaxAttempts },
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

    // REDIS: every Postgres session is gone; drop the cached session/profile too (retried if Redis is down).
    await this.cache.purgeUserCache(otpRecord.user.id);

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

    // REDIS: the cached session key is per user, so drop it for single-session logout too;
    // the guard then re-checks Postgres.
    await this.cache.purgeUserCache(user.id);

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

  // ─── shared helpers for the new methods ────────────────────────────────

  private async checkOtpOrThrow(args: {
    verificationId: string;
    otp: string;
    purpose: UserOtpPurposeEnum;
    action: AuditEventEnum;
    consume: boolean;
    onValid?: (tx: Prisma.TransactionClient, userId: string) => Promise<void>;
  }): Promise<{ userId: string; name: string | null; roles: string[] }> {
    const { verificationId, otp, purpose, action, consume, onValid } = args;
    const otpMaxAttempts = this.configService.get<number>('otp.maxAttempts', 5);

    const record = await this.prisma.userOtp.findUnique({
      where: { id: verificationId },
      include: {
        user: { select: { id: true, name: true, userRoles: { include: { role: true } } } },
      },
    });

    if (!record) {
      this.emitOtpRejected({
        action,
        reason: 'otp_not_found',
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        metadata: { attemptedVerificationId: verificationId },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const roles = record.user.userRoles.map((userRole) => userRole.role.name);
    const otpAudit: OtpAuditRecord = {
      id: record.id,
      purpose: record.purpose,
      attempts: record.attempts,
    };
    const userAudit: OtpAuditUser = { id: record.user.id, name: record.user.name };

    const reject = (reason: string, outcome: AuditOutcome, severity: AuditSeverity): never => {
      this.emitOtpRejected({
        action,
        reason,
        outcome,
        severity,
        otp: otpAudit,
        user: userAudit,
        roles,
      });
      throw new BadRequestException('invalid_or_expired_otp');
    };

    if (record.purpose !== purpose) {
      reject('otp_purpose_mismatch', AuditOutcome.DENIED, AuditSeverity.WARNING);
    }
    if (record.usedAt) {
      reject('otp_already_used', AuditOutcome.DENIED, AuditSeverity.WARNING);
    }
    if (record.expiresAt < new Date()) {
      reject('otp_expired', AuditOutcome.DENIED, AuditSeverity.INFO);
    }

    if (record.attempts >= otpMaxAttempts) {
      await this.lockoutUtil.lockAccountForOtpAbuse(record.user.id);
      this.emitOtpLockout(otpAudit, userAudit);
      throw new BadRequestException('too_many_otp_attempts');
    }

    const valid = await bcrypt.compare(otp, record.otpHash);

    if (!valid) {
      const updated = await this.prisma.userOtp.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });

      if (updated.attempts >= otpMaxAttempts) {
        await this.lockoutUtil.lockAccountForOtpAbuse(record.user.id);
        this.emitOtpLockout({ ...otpAudit, attempts: updated.attempts }, userAudit);
      } else {
        this.emitOtpRejected({
          action,
          reason: 'invalid_otp',
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          otp: { ...otpAudit, attempts: updated.attempts },
          user: userAudit,
          roles,
        });
      }

      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (consume) {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.userOtp.updateMany({
          where: {
            id: record.id,
            usedAt: null,
            attempts: { lt: otpMaxAttempts },
            expiresAt: { gt: new Date() },
          },
          data: { usedAt: new Date() },
        });

        if (claimed.count === 0) {
          reject('otp_claim_conflict', AuditOutcome.FAILURE, AuditSeverity.WARNING);
        }

        if (onValid) await onValid(tx, record.user.id);
      });
    }

    return { userId: record.user.id, name: record.user.name, roles };
  }

  private async loadUserForSecurity(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        isPhoneVerified: true,
        passwordHash: true,
        googleId: true,
        facebookId: true,
        appleId: true,
        failedLoginAttempts: true,
        lockedUntil: true,
        twoFactorRequiredAt: true,
        userRoles: {
          include: {
            role: { include: { rolePermissions: { include: { permission: true } } } },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    return user;
  }

  private get twoFactorKey(): string {
    return this.configService.getOrThrow<string>('security.twoFactorEncryptionKey');
  }

  // Neutral on purpose: nothing a third party could read on a lock screen names the app.
  private get twoFactorIssuer(): string {
    return this.configService.get<string>('twoFactor.issuer', 'Account');
  }

  private socialColumn(provider: SocialProviderEnum): 'googleId' | 'facebookId' | 'appleId' {
    return provider === SocialProviderEnum.GOOGLE
      ? 'googleId'
      : provider === SocialProviderEnum.FACEBOOK
        ? 'facebookId'
        : 'appleId';
  }

  private socialData(column: 'googleId' | 'facebookId' | 'appleId', value: string | null) {
    return column === 'googleId'
      ? { googleId: value }
      : column === 'facebookId'
        ? { facebookId: value }
        : { appleId: value };
  }

  private async requireEnabledSecret(userId: string) {
    const secret = await this.prisma.twoFactorSecret.findUnique({ where: { userId } });

    if (!secret || !secret.isEnabled) {
      throw new BadRequestException('two_factor_not_enabled');
    }

    return secret;
  }

  // Checks a TOTP code against the stored secret, with replay protection.
  // Returns the used step; the caller persists it after the whole action succeeds.
  private checkTotpOrNull(
    secret: { secretEncrypted: string; lastUsedStep: number | null },
    code: string,
  ): number | null {
    return verifyTotp(
      decryptSecret(secret.secretEncrypted, this.twoFactorKey),
      code,
      secret.lastUsedStep,
    );
  }

  private async issueRecoveryCodes(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<string[]> {
    const codes = generateRecoveryCodes(TWO_FACTOR_RECOVERY_CODE_COUNT);

    await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
    await tx.twoFactorRecoveryCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
    });

    return codes;
  }

  private emitSecurityAudit(
    user: { id: string; name?: string | null },
    roles: string[],
    action: AuditEventEnum,
    diff: Record<string, string | number | boolean | null>,
    outcome: AuditOutcome = AuditOutcome.SUCCESS,
    severity: AuditSeverity = AuditSeverity.INFO,
  ): void {
    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(roles),
      action,
      outcome,
      severity,
      entity: 'User',
      entityId: user.id,
      entityLabel: user.name ?? undefined,
      diff: { result: outcome === AuditOutcome.SUCCESS ? 'success' : 'failure', ...diff },
    });
  }

  // ─── user authentication (AR-01 … AR-12) ───────────────────────────────

  // AR-01. Throttled per route; this adds a 30-second gap and an hourly cap per account.
  async resendForgotPasswordOtp(verificationId: string): Promise<{ verificationId: string }> {
    const oldOtp = await this.prisma.userOtp.findUnique({
      where: { id: verificationId },
      include: {
        user: {
          select: {
            id: true,
            phone: true,
            isActive: true,
            userRoles: { select: { role: { select: { name: true } } } },
          },
        },
      },
    });

    if (!oldOtp || oldOtp.purpose !== UserOtpPurposeEnum.password_reset) {
      throw new BadRequestException('invalid_verification');
    }

    // Used up by a reset, or replaced by a newer code: either way this id is finished.
    if (oldOtp.usedAt) {
      throw new BadRequestException('invalid_verification');
    }

    const roles = oldOtp.user.userRoles.map((userRole) => userRole.role.name);

    if (!oldOtp.user.isActive || this.hasAdminRole(roles)) {
      throw new BadRequestException('invalid_verification');
    }

    // OtpUtil silently returns the SAME id inside its own cooldown, so refuse out loud instead.
    const cooldownMs = this.configService.get<number>('otp.resendCooldownSeconds', 60) * 1000;

    if (Date.now() - oldOtp.createdAt.getTime() < cooldownMs) {
      throw new BadRequestException('resend_too_soon');
    }

    const recent = await this.prisma.userOtp.count({
      where: {
        userId: oldOtp.userId,
        purpose: UserOtpPurposeEnum.password_reset,
        createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) },
      },
    });

    if (recent >= OTP_RESEND_HOURLY_CAP) {
      throw new BadRequestException('too_many_resend_requests');
    }

    // issueAndSendOtp ends every earlier unused code for this purpose, so the old one stops working.
    const { verificationId: newVerificationId } = await this.otpUtil.issueAndSendOtp(
      oldOtp.userId,
      this.requirePhone(oldOtp.user.phone),
      UserOtpPurposeEnum.password_reset,
      OtpChannelEnum.sms,
    );

    return { verificationId: newVerificationId };
  }

  // AR-02. Checks the code without using it up, so the reset call can still use it.
  async verifyResetOtp(data: VerifyResetOtpDto): Promise<{ valid: true }> {
    const result = await this.checkOtpOrThrow({
      verificationId: data.verificationId,
      otp: data.otp,
      purpose: UserOtpPurposeEnum.password_reset,
      action: AuditEventEnum.PASSWORD_RESET,
      consume: false,
    });

    if (this.hasAdminRole(result.roles)) {
      throw new BadRequestException('invalid_or_expired_otp');
    }

    return { valid: true };
  }

  // AR-03
  async logoutAll(
    user: CurrentUserDto,
    _req: any,
  ): Promise<{ message: string; sessionsRevoked: number }> {
    const deleted = await this.prisma.session.deleteMany({ where: { userId: user.id } });

    await this.cache.purgeUserCache(user.id);

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.LOGOUT,
      entity: 'User',
      entityId: user.id,
      diff: { result: 'success' },
      metadata: { scope: 'all_sessions_explicit', sessionsRevoked: deleted.count },
    });

    return { message: 'logout_all_successful', sessionsRevoked: deleted.count };
  }

  async reactivateInitiate(data: ReactivateInitiateDto): Promise<{ verificationId: string }> {
    if (!this.configService.get<boolean>('auth.selfReactivationEnabled', false)) {
      return { verificationId: '' };
    }

    const phone = this.normalizePhoneOrThrow(data.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: {
        id: true,
        name: true,
        phone: true,
        isActive: true,
        isPhoneVerified: true,
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });

    const roles = user?.userRoles.map((userRole) => userRole.role.name) ?? [];

    // Same empty answer for every refusal, so the route cannot be used to find accounts.
    if (!user || user.isActive || !user.isPhoneVerified || this.hasAdminRole(roles)) {
      this.emitAudit({
        userId: user?.id ?? null,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.ACCOUNT_REACTIVATION_REQUESTED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.INFO,
        entity: 'User',
        entityId: user?.id ?? null,
        diff: {
          result: 'denied',
          reason: !user
            ? 'unknown_account'
            : user.isActive
              ? 'account_already_active'
              : !user.isPhoneVerified
                ? 'phone_not_verified'
                : 'staff_account',
        },
        metadata: user ? {} : { attemptedPhone: this.maskPhone(phone) },
      });
      return { verificationId: '' };
    }

    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      user.id,
      this.requirePhone(user.phone),
      UserOtpPurposeEnum.account_reactivation,
      OtpChannelEnum.sms,
    );

    this.emitSecurityAudit(user, roles, AuditEventEnum.ACCOUNT_REACTIVATION_REQUESTED, {
      context: 'self_reactivation',
    });

    return { verificationId };
  }

  // AR-05. Turns the account back on; the person then signs in normally.
  async reactivateVerify(data: ReactivateVerifyDto): Promise<{ message: string }> {
    if (!this.configService.get<boolean>('auth.selfReactivationEnabled', false)) {
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const result = await this.checkOtpOrThrow({
      verificationId: data.verificationId,
      otp: data.otp,
      purpose: UserOtpPurposeEnum.account_reactivation,
      action: AuditEventEnum.USER_REACTIVATED,
      consume: true,
      onValid: async (tx, userId) => {
        await tx.user.update({
          where: { id: userId },
          data: { isActive: true, failedLoginAttempts: 0, lockedUntil: null },
        });
      },
    });

    await this.cache.purgeUserCache(result.userId);

    this.emitSecurityAudit(
      { id: result.userId, name: result.name },
      result.roles,
      AuditEventEnum.USER_REACTIVATED,
      { context: 'self_reactivation' },
    );

    return { message: 'account_reactivated' };
  }

  // AR-06
  async linkSocial(user: CurrentUserDto, provider: SocialProviderEnum, data: LinkSocialDto) {
    const profile =
      provider === SocialProviderEnum.GOOGLE
        ? await this.socialAuthUtil.verifyGoogleIdToken(data.token)
        : provider === SocialProviderEnum.FACEBOOK
          ? await this.socialAuthUtil.verifyFacebookAccessToken(data.token)
          : await this.socialAuthUtil.verifyAppleIdToken(data.token);

    if (!profile.emailVerified) {
      throw new UnauthorizedException('unverified_social_email');
    }

    const column = this.socialColumn(provider);

    const current = await this.loadUserForSecurity(user.id);
    const roles = current.userRoles.map((ur) => ur.role.name);

    if (current[column] === profile.providerId) {
      return { message: 'social_account_already_linked', provider };
    }

    if (current[column]) {
      throw new BadRequestException('another_account_of_this_provider_already_linked');
    }

    const takenBy = await this.prisma.user.findFirst({
      where: { ...this.socialData(column, profile.providerId), NOT: { id: user.id } },
      select: { id: true },
    });

    if (takenBy) {
      this.emitSecurityAudit(
        current,
        roles,
        AuditEventEnum.SOCIAL_ACCOUNT_LINKED,
        { reason: 'social_account_in_use', provider },
        AuditOutcome.FAILURE,
        AuditSeverity.WARNING,
      );
      throw new BadRequestException('social_account_already_linked_elsewhere');
    }

    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: this.socialData(column, profile.providerId),
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new BadRequestException('social_account_already_linked_elsewhere');
      }
      throw error;
    }

    await this.cache.purgeUserCache(user.id);
    this.emitSecurityAudit(current, roles, AuditEventEnum.SOCIAL_ACCOUNT_LINKED, { provider });

    return { message: 'social_account_linked', provider };
  }

  // AR-07. Refuses to remove the last way to sign in.
  async unlinkSocial(user: CurrentUserDto, provider: SocialProviderEnum) {
    const current = await this.loadUserForSecurity(user.id);
    const roles = current.userRoles.map((ur) => ur.role.name);

    const column = this.socialColumn(provider);

    if (!current[column]) {
      throw new NotFoundException('social_account_not_linked');
    }

    const otherProviders = (['googleId', 'facebookId', 'appleId'] as const).filter(
      (c) => c !== column && current[c],
    ).length;

    // Password sign-in only counts if there is a phone to sign in with.
    const hasPasswordLogin = Boolean(current.passwordHash && current.phone);

    if (otherProviders === 0 && !hasPasswordLogin) {
      this.emitSecurityAudit(
        current,
        roles,
        AuditEventEnum.SOCIAL_ACCOUNT_UNLINKED,
        { reason: 'cannot_unlink_last_sign_in_method', provider },
        AuditOutcome.DENIED,
        AuditSeverity.WARNING,
      );
      throw new BadRequestException('cannot_unlink_last_sign_in_method');
    }

    await this.prisma.user.update({ where: { id: user.id }, data: this.socialData(column, null) });

    await this.cache.purgeUserCache(user.id);
    this.emitSecurityAudit(current, roles, AuditEventEnum.SOCIAL_ACCOUNT_UNLINKED, { provider });

    return { message: 'social_account_unlinked', provider };
  }

  // AR-08. Password sign-in is by phone, so a social-only account needs a phone first.
  async setPassword(user: CurrentUserDto, data: SetPasswordDto) {
    const current = await this.loadUserForSecurity(user.id);
    const roles = current.userRoles.map((ur) => ur.role.name);

    if (current.passwordHash) {
      throw new BadRequestException('password_already_set');
    }

    if (!current.phone || !current.isPhoneVerified) {
      throw new BadRequestException('verified_phone_required_to_set_password');
    }

    const hashed = await bcrypt.hash(data.newPassword, this.bcryptSaltRounds);

    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashed } });

    await this.cache.purgeUserCache(user.id);

    this.emitSecurityAudit(current, roles, AuditEventEnum.PASSWORD_SET, {
      method: 'social_account_add_password',
    });

    const changedEvent: PasswordChangedEvent = { userId: user.id };
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_CHANGED, changedEvent);

    return { message: 'password_set' };
  }

  // AR-09. Read straight from the database, not the profile cache, so it is never stale.
  async myPermissions(user: CurrentUserDto) {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId: user.id },
      select: {
        assignedAt: true,
        role: {
          select: {
            id: true,
            name: true,
            rolePermissions: { select: { permission: { select: { name: true } } } },
          },
        },
      },
    });

    return {
      roles: userRoles.map((ur) => ({
        id: ur.role.id,
        name: ur.role.name,
        assignedAt: ur.assignedAt,
      })),
      permissions: this.derivePermissions(userRoles).sort(),
    };
  }

  // AR-10
  passwordPolicy() {
    return {
      minLength: this.configService.get<number>('security.passwordMinLength', 8),
      maxLength: 128,
    };
  }

  // AR-11
  async signupStatus(data: SignupStatusDto) {
    const otp = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      select: {
        purpose: true,
        usedAt: true,
        expiresAt: true,
        user: { select: { phone: true, isPhoneVerified: true } },
      },
    });

    if (!otp || otp.purpose !== UserOtpPurposeEnum.phone_verification) {
      return { status: 'unknown' as const };
    }

    if (otp.usedAt || otp.user.isPhoneVerified) {
      return { status: 'verified' as const };
    }

    return {
      status: otp.expiresAt < new Date() ? ('expired' as const) : ('pending' as const),
      expiresAt: otp.expiresAt,
      phone: otp.user.phone ? this.maskPhone(otp.user.phone) : null,
      canResend: true,
    };
  }

  // AR-12. Deletes the session (never marks it revoked): refresh() treats a revoked session as
  // a stolen-token replay and would wipe every session of the user.
  async revokeRefreshToken(user: CurrentUserDto, data: RevokeRefreshTokenDto) {
    const deleted = await this.prisma.session.deleteMany({
      where: {
        userId: user.id,
        refreshToken: this.tokenUtil.hashOpaqueToken(data.refreshToken, 'refresh'),
      },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('session_not_found');
    }

    await this.cache.purgeUserCache(user.id);

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.LOGOUT,
      entity: 'User',
      entityId: user.id,
      diff: { result: 'success' },
      metadata: { scope: 'refresh_token_revoked', sessionsRevoked: deleted.count },
    });

    return { message: 'refresh_token_revoked' };
  }

  // ─── two-factor authentication (AR-61 … AR-69) ─────────────────────────

  // AR-61
  async twoFactorStatus(user: CurrentUserDto) {
    const [secret, remaining, current] = await Promise.all([
      this.prisma.twoFactorSecret.findUnique({ where: { userId: user.id } }),
      this.prisma.twoFactorRecoveryCode.count({ where: { userId: user.id, usedAt: null } }),
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: { twoFactorRequiredAt: true },
      }),
    ]);

    const enabled = Boolean(secret?.isEnabled);

    return {
      enabled,
      methods: enabled && secret ? [secret.method] : [],
      setupPending: Boolean(secret && !secret.isEnabled),
      recoveryCodesRemaining: enabled ? remaining : 0,
      enrollmentRequired: Boolean(current?.twoFactorRequiredAt) && !enabled,
    };
  }

  // AR-62. Authenticator app (TOTP) only for now. A new call replaces any unfinished setup.
  async twoFactorSetup(user: CurrentUserDto, data: TwoFactorSetupDto) {
    if (data.method && data.method !== TwoFactorMethodDtoEnum.TOTP) {
      throw new BadRequestException('two_factor_method_not_available');
    }

    const current = await this.loadUserForSecurity(user.id);
    const roles = current.userRoles.map((ur) => ur.role.name);

    const existing = await this.prisma.twoFactorSecret.findUnique({ where: { userId: user.id } });

    if (existing?.isEnabled) {
      throw new ConflictException('two_factor_already_enabled');
    }

    const secret = generateTotpSecret();
    const secretEncrypted = encryptSecret(secret, this.twoFactorKey);

    await this.prisma.twoFactorSecret.upsert({
      where: { userId: user.id },
      create: { userId: user.id, method: TwoFactorMethodEnum.TOTP, secretEncrypted },
      update: { secretEncrypted, isEnabled: false, confirmedAt: null, lastUsedStep: null },
    });

    this.emitSecurityAudit(current, roles, AuditEventEnum.TWO_FACTOR_SETUP_STARTED, {
      method: 'TOTP',
    });

    return {
      method: 'TOTP',
      manualKey: secret,
      otpauthUri: buildOtpAuthUri({
        issuer: this.twoFactorIssuer,
        account: current.email ?? current.phone ?? current.id,
        secret,
      }),
    };
  }

  // AR-63. Recovery codes are returned here once and never again.
  async twoFactorVerify(user: CurrentUserDto, data: TwoFactorVerifyDto) {
    const current = await this.loadUserForSecurity(user.id);
    const roles = current.userRoles.map((ur) => ur.role.name);
    this.lockoutUtil.assertNotLocked(current);

    const secret = await this.prisma.twoFactorSecret.findUnique({ where: { userId: user.id } });

    if (!secret) {
      throw new BadRequestException('no_pending_two_factor_setup');
    }

    if (secret.isEnabled) {
      throw new ConflictException('two_factor_already_enabled');
    }

    const step = this.checkTotpOrNull(secret, data.code);

    if (step === null) {
      await this.lockoutUtil.recordFailedLogin(user.id);
      this.emitSecurityAudit(
        current,
        roles,
        AuditEventEnum.TWO_FACTOR_ENABLED,
        { reason: 'invalid_code' },
        AuditOutcome.FAILURE,
        AuditSeverity.WARNING,
      );
      throw new BadRequestException('invalid_two_factor_code');
    }

    const recoveryCodes = await this.prisma.$transaction(async (tx) => {
      await tx.twoFactorSecret.update({
        where: { userId: user.id },
        data: { isEnabled: true, confirmedAt: new Date(), lastUsedStep: step },
      });
      await tx.user.update({ where: { id: user.id }, data: { twoFactorRequiredAt: null } });
      return this.issueRecoveryCodes(tx, user.id);
    });

    await this.cache.purgeUserCache(user.id);
    this.emitSecurityAudit(current, roles, AuditEventEnum.TWO_FACTOR_ENABLED, { method: 'TOTP' });

    return { enabled: true, recoveryCodes };
  }

  // AR-64. The route already re-checked the password; if one is sent it is checked again.
  async twoFactorDisable(user: CurrentUserDto, data: TwoFactorDisableDto) {
    const current = await this.loadUserForSecurity(user.id);
    const roles = current.userRoles.map((ur) => ur.role.name);
    this.lockoutUtil.assertNotLocked(current);

    const secret = await this.requireEnabledSecret(user.id);

    if (this.hasAdminRole(roles)) {
      const policy = await this.prisma.twoFactorPolicy.findUnique({ where: { id: 'default' } });

      if (policy?.adminRequired ?? true) {
        this.emitSecurityAudit(
          current,
          roles,
          AuditEventEnum.TWO_FACTOR_DISABLED,
          { reason: 'two_factor_required_by_policy' },
          AuditOutcome.DENIED,
          AuditSeverity.WARNING,
        );
        throw new ForbiddenException('two_factor_required_by_policy');
      }
    }

    if (data.password !== undefined && current.passwordHash) {
      const validPassword = await bcrypt.compare(data.password, current.passwordHash);

      if (!validPassword) {
        await this.lockoutUtil.recordFailedLogin(user.id);
        throw new UnauthorizedException('invalid_credentials');
      }
    }

    const step = this.checkTotpOrNull(secret, data.code);

    if (step === null) {
      await this.lockoutUtil.recordFailedLogin(user.id);
      this.emitSecurityAudit(
        current,
        roles,
        AuditEventEnum.TWO_FACTOR_DISABLED,
        { reason: 'invalid_code' },
        AuditOutcome.FAILURE,
        AuditSeverity.WARNING,
      );
      throw new BadRequestException('invalid_two_factor_code');
    }

    await this.prisma.$transaction([
      this.prisma.twoFactorRecoveryCode.deleteMany({ where: { userId: user.id } }),
      this.prisma.twoFactorSecret.delete({ where: { userId: user.id } }),
    ]);

    await this.cache.purgeUserCache(user.id);
    this.emitSecurityAudit(current, roles, AuditEventEnum.TWO_FACTOR_DISABLED, { method: 'TOTP' });

    return { enabled: false };
  }

  // AR-65
  async twoFactorRegenerateRecoveryCodes(user: CurrentUserDto, data: TwoFactorRegenerateDto) {
    const current = await this.loadUserForSecurity(user.id);
    const roles = current.userRoles.map((ur) => ur.role.name);
    this.lockoutUtil.assertNotLocked(current);

    const secret = await this.requireEnabledSecret(user.id);
    const step = this.checkTotpOrNull(secret, data.code);

    if (step === null) {
      await this.lockoutUtil.recordFailedLogin(user.id);
      throw new BadRequestException('invalid_two_factor_code');
    }

    const recoveryCodes = await this.prisma.$transaction(async (tx) => {
      await tx.twoFactorSecret.update({ where: { userId: user.id }, data: { lastUsedStep: step } });
      return this.issueRecoveryCodes(tx, user.id);
    });

    this.emitSecurityAudit(
      current,
      roles,
      AuditEventEnum.TWO_FACTOR_RECOVERY_CODES_REGENERATED,
      {},
    );

    return { recoveryCodes };
  }

  // Called by the login change (UP-05), after the password check passes and the account has 2FA on.
  // Login then returns { requires2fa: true, challengeId, methods } instead of tokens.
  async issueTwoFactorChallenge(userId: string, ipAddress?: string) {
    const secret = await this.prisma.twoFactorSecret.findUnique({ where: { userId } });

    if (!secret?.isEnabled) {
      return null;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, isPhoneVerified: true },
    });

    const methods: TwoFactorMethodEnum[] = [TwoFactorMethodEnum.TOTP];

    if (
      this.configService.get<boolean>('twoFactor.smsEnabled', false) &&
      user?.phone &&
      user.isPhoneVerified
    ) {
      methods.push(TwoFactorMethodEnum.SMS);
    }

    // Older unfinished challenges for this person are dropped.
    await this.prisma.twoFactorChallenge.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const challenge = await this.prisma.twoFactorChallenge.create({
      data: {
        userId,
        methods,
        ipAddress: ipAddress ?? null,
        expiresAt: new Date(Date.now() + TWO_FACTOR_CHALLENGE_TTL_MS),
      },
    });

    return { requires2fa: true as const, challengeId: challenge.id, methods };
  }

  private async loadChallengeOrThrow(challengeId: string) {
    const challenge = await this.prisma.twoFactorChallenge.findUnique({
      where: { id: challengeId },
      include: { user: { select: { id: true } } },
    });

    if (
      !challenge ||
      challenge.consumedAt ||
      challenge.expiresAt < new Date() ||
      challenge.purpose !== TwoFactorChallengePurposeEnum.LOGIN ||
      challenge.attempts >= TWO_FACTOR_MAX_ATTEMPTS
    ) {
      throw new UnauthorizedException('invalid_or_expired_challenge');
    }

    const user = await this.loadUserForSecurity(challenge.userId);

    if (!user.isActive) {
      throw new UnauthorizedException('invalid_or_expired_challenge');
    }

    this.lockoutUtil.assertNotLocked(user);

    return { challenge, user, roles: user.userRoles.map((ur) => ur.role.name) };
  }

  private async failChallenge(
    challenge: { id: string },
    user: { id: string; name: string | null },
    roles: string[],
    reason: string,
  ): Promise<never> {
    const updated = await this.prisma.twoFactorChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });

    // Too many wrong tries burn the challenge: the person has to sign in again.
    if (updated.attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
      await this.prisma.twoFactorChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
    }

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
      diff: { result: 'failed', reason },
      metadata: { method: 'two_factor', attempts: updated.attempts },
    });

    throw new UnauthorizedException('invalid_two_factor_code');
  }

  private async finishChallenge(
    challenge: { id: string },
    user: SecurityUser,
    roles: string[],
    method: string,
  ): Promise<TokenPair> {
    const claimed = await this.prisma.twoFactorChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    if (claimed.count === 0) {
      throw new UnauthorizedException('invalid_or_expired_challenge');
    }

    await this.lockoutUtil.resetLoginAttempts(user);

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.LOGIN_SUCCESS,
      entity: 'User',
      entityId: user.id,
      entityLabel: user.name ?? undefined,
      diff: { result: 'success' },
      metadata: { method: 'two_factor', factor: method },
    });

    return this.tokenUtil.issueTokens(
      user.id,
      { phone: user.phone, email: user.email },
      roles,
      this.derivePermissions(user.userRoles),
    );
  }

  // AR-66
  async twoFactorLoginVerify(data: TwoFactorLoginVerifyDto): Promise<TokenPair> {
    const { challenge, user, roles } = await this.loadChallengeOrThrow(data.challengeId);

    // An SMS code, if one was sent for this challenge.
    if (challenge.smsCodeHash && (await bcrypt.compare(data.code, challenge.smsCodeHash))) {
      return this.finishChallenge(challenge, user, roles, 'sms');
    }

    const secret = await this.requireEnabledSecret(user.id);
    const step = this.checkTotpOrNull(secret, data.code);

    if (step === null) {
      return this.failChallenge(challenge, user, roles, 'invalid_two_factor_code');
    }

    // Saving the step before issuing tokens means the same code cannot be used a second time.
    const advanced = await this.prisma.twoFactorSecret.updateMany({
      where: {
        userId: user.id,
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
      },
      data: { lastUsedStep: step },
    });

    if (advanced.count === 0) {
      return this.failChallenge(challenge, user, roles, 'two_factor_code_replayed');
    }

    return this.finishChallenge(challenge, user, roles, 'totp');
  }

  // AR-67
  async twoFactorLoginRecovery(
    data: TwoFactorLoginRecoveryDto,
  ): Promise<TokenPair & { recoveryCodesRemaining: number }> {
    const { challenge, user, roles } = await this.loadChallengeOrThrow(data.challengeId);

    const code = await this.prisma.twoFactorRecoveryCode.findFirst({
      where: { userId: user.id, codeHash: hashRecoveryCode(data.recoveryCode), usedAt: null },
      select: { id: true },
    });

    if (!code) {
      return this.failChallenge(challenge, user, roles, 'invalid_recovery_code');
    }

    // Single use: the claim only succeeds for whoever gets there first.
    const claimed = await this.prisma.twoFactorRecoveryCode.updateMany({
      where: { id: code.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    if (claimed.count === 0) {
      return this.failChallenge(challenge, user, roles, 'recovery_code_already_used');
    }

    const tokens = await this.finishChallenge(challenge, user, roles, 'recovery_code');
    const remaining = await this.prisma.twoFactorRecoveryCode.count({
      where: { userId: user.id, usedAt: null },
    });

    this.emitSecurityAudit(
      user,
      roles,
      AuditEventEnum.TWO_FACTOR_RECOVERY_USED,
      { recoveryCodesRemaining: remaining },
      AuditOutcome.SUCCESS,
      remaining <= 2 ? AuditSeverity.WARNING : AuditSeverity.INFO,
    );

    return { ...tokens, recoveryCodesRemaining: remaining };
  }

  // AR-68. Only when the challenge offered SMS. The message does not name the app.
  async twoFactorLoginResend(data: TwoFactorLoginResendDto): Promise<{ message: string }> {
    const { challenge, user } = await this.loadChallengeOrThrow(data.challengeId);

    if (!challenge.methods.includes(TwoFactorMethodEnum.SMS) || !user.phone) {
      throw new BadRequestException('sms_not_available');
    }

    const code = this.otpUtil.generateOtp();
    const smsCodeHash = await bcrypt.hash(code, this.bcryptOtpSaltRounds);

    await this.prisma.twoFactorChallenge.update({
      where: { id: challenge.id },
      data: { smsCodeHash },
    });

    try {
      await sendSms(
        this.requirePhone(user.phone),
        `Your verification code is ${code}. It expires in 5 minutes.`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send 2FA SMS to ${this.maskPhone(user.phone)}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadRequestException('sms_delivery_failed');
    }

    return { message: 'two_factor_sms_sent' };
  }

  // AR-69. Returns a short-lived token a sensitive route can ask for. The token is stateless:
  // the route that needs it must verify it (type 'step_up', same user, not expired).
  async twoFactorStepUp(user: CurrentUserDto, data: TwoFactorStepUpDto) {
    const current = await this.loadUserForSecurity(user.id);
    const roles = current.userRoles.map((ur) => ur.role.name);
    this.lockoutUtil.assertNotLocked(current);

    const secret = await this.requireEnabledSecret(user.id);
    const step = this.checkTotpOrNull(secret, data.code);

    if (step === null) {
      await this.lockoutUtil.recordFailedLogin(user.id);
      this.emitSecurityAudit(
        current,
        roles,
        AuditEventEnum.TWO_FACTOR_STEP_UP,
        { reason: 'invalid_code', action: data.action ?? null },
        AuditOutcome.FAILURE,
        AuditSeverity.WARNING,
      );
      throw new BadRequestException('invalid_two_factor_code');
    }

    await this.prisma.twoFactorSecret.update({
      where: { userId: user.id },
      data: { lastUsedStep: step },
    });

    const stepUpToken = this.jwtService.sign(
      { sub: user.id, type: 'step_up', action: data.action ?? null },
      {
        secret: this.configService.getOrThrow<string>('jwt.secret'),
        expiresIn: STEP_UP_TTL_SECONDS,
      },
    );

    this.emitSecurityAudit(current, roles, AuditEventEnum.TWO_FACTOR_STEP_UP, {
      action: data.action ?? null,
    });

    return { stepUpToken, expiresInSeconds: STEP_UP_TTL_SECONDS };
  }
}

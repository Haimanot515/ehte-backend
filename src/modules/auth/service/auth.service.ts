import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { UserOtpPurposeEnum, OtpChannelEnum, Prisma } from '@prisma/client';

import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { normalizePhoneNumber } from 'src/common/utils/phone.util';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { OtpUtil } from 'src/common/utils/otp.util';
import { LockoutUtil } from 'src/common/utils/lockout.util';
import { TokenUtil } from 'src/common/utils/token.util';

import { sendSms } from 'src/services/sms/afro-message.service';
import { renderOtpSms } from 'src/services/sms/templates/sms-otp.template';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import {
  PasswordChangedEvent,
  PasswordResetEvent,
} from 'src/modules/misc/events/notification.events';

import {
  ChangePasswordDto,
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

// login() result; if phone isn't verified, a fresh OTP is sent instead of tokens.
type LoginResult =
  | TokenPair
  | {
      requiresVerification: true;
      verificationId: string;
      message: string;
    };

// forgotPassword() result; purpose tells client which OTP screen to use.
type ForgotPasswordResult = {
  verificationId: string;
  purpose?: 'password_reset' | 'phone_verification';
};

const ADMIN_ROLES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

// Shape shared by every userRoles->role->rolePermissions->permission Prisma query result.
type UserRoleWithPermissions = {
  role: {
    name: string;
    rolePermissions: { permission: { name: string } }[];
  };
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly otpUtil: OtpUtil,
    private readonly lockoutUtil: LockoutUtil,
    private readonly tokenUtil: TokenUtil,
  ) {}

  // Typed audit-emit helper so a missing field is caught at compile time, not silently dropped.
  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // Narrows `string | null` -> `string` for phone; throws instead of passing null downstream.
  private requirePhone(phone: string | null): string {
    if (!phone) {
      throw new BadRequestException('phone_number_missing');
    }
    return phone;
  }

  // Shared "is this role set an admin?" check — duplicated in AdminAuthService by design
  // (auth/ and admin-auth/ deliberately don't import from each other).
  private hasAdminRole(roles: string[]): boolean {
    return roles.some((role) => ADMIN_ROLES.includes(role as RolesEnum));
  }

  // Flattens every permission across every role a user holds into one deduped array.
  private derivePermissions(userRoles: UserRoleWithPermissions[]): string[] {
    return [
      ...new Set(
        userRoles.flatMap((userRole) =>
          userRole.role.rolePermissions.map((rp) => rp.permission.name),
        ),
      ),
    ];
  }

  // Detects a Prisma P2002 unique-constraint violation for clean 400s on races.
  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  // SIGN UP

  async signup(data: SignupDto): Promise<{ verificationId: string }> {
    const phone = this.normalizePhoneOrThrow(data.phone);

    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
    });

    if (existingUser) {
      if (existingUser.isPhoneVerified) {
        throw new BadRequestException('phone_already_registered');
      }

      // Unverified existing account: resend OTP instead of blocking or duplicating.
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
      throw new BadRequestException('user_role_not_configured');
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    // Create user + OTP in one transaction; SMS sent outside it.
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
      // Concurrent request created this phone between our lookup and this write.
      if (this.isUniqueConstraintError(error)) {
        throw new BadRequestException('phone_already_registered');
      }
      throw error;
    }

    // Send signup OTP SMS
    const smsMessage = renderOtpSms({
      otp: result.otp,
      expiresInMinutes: this.configService.get<number>('otp.expiresInMinutes', 10),
    });

    try {
      await sendSms(this.requirePhone(result.phone), smsMessage);
    } catch (error) {
      // Log failure only; user/OTP already persisted, client can use resendSignupOtp().
      console.error(`[EHTE SMS] Failed to send signup OTP to ${result.phone}`, error);
    }

    // DEV ONLY: remove before production
    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] Signup OTP for ${result.phone}: ${result.otp}`);
    }

    // Audit user creation (never include password/OTP/token data)
    this.emitAudit({
      userId: result.userId,
      actorType: resolveActorType([userRole.name]),
      action: AuditEventEnum.USER_CREATED,
      entity: 'User',
      entityId: result.userId,
      diff: { result: 'success' },
    });

    return { verificationId: result.verificationId };
  }

  // VERIFY SIGNUP OTP

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
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.user.phone !== phone) {
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (
      otpRecord.purpose !== UserOtpPurposeEnum.phone_verification ||
      otpRecord.usedAt ||
      otpRecord.expiresAt < new Date()
    ) {
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const roles = otpRecord.user.userRoles.map((userRole) => userRole.role.name);
    const permissions = this.derivePermissions(otpRecord.user.userRoles);

    // Enforce max OTP attempts
    if (otpRecord.attempts >= 5) {
      await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

      this.emitAudit({
        userId: otpRecord.user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.SECURITY_ALERT,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        diff: {
          reason: 'too_many_otp_attempts',
          purpose: 'phone_verification',
        },
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

      // Lock the account once failed attempts hit the max, not just alert.
      if (updatedOtp.attempts >= 5) {
        await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

        this.emitAudit({
          userId: otpRecord.user.id,
          actorType: resolveActorType(roles),
          action: AuditEventEnum.SECURITY_ALERT,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          diff: {
            reason: 'too_many_otp_attempts',
            purpose: 'phone_verification',
          },
        });
      }

      throw new BadRequestException('invalid_or_expired_otp');
    }

    // Atomically claim the OTP (usedAt: null in where) and flip isPhoneVerified together.
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
        // Lost the race, already consumed, or expired
        throw new BadRequestException('invalid_or_expired_otp');
      }

      await tx.user.update({
        where: { id: otpRecord.user.id },
        data: { isPhoneVerified: true },
      });
    });

    // Audit successful verification
    this.emitAudit({
      userId: otpRecord.user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.OTP_VERIFIED,
      entity: 'UserOtp',
      entityId: otpRecord.id,
      diff: { purpose: 'phone_verification', result: 'success' },
    });

    return this.tokenUtil.issueTokens(
      otpRecord.user.id,
      { phone: otpRecord.user.phone },
      roles,
      permissions,
    );
  }

  // RESEND SIGNUP OTP

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

  // LOGIN — requires isPhoneVerified + the USER role; a pure admin account is rejected here.

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
        entity: 'User',
        entityId: user?.id ?? null,
        diff: { method: 'password', result: 'failed' },
      });

      throw new UnauthorizedException('invalid_credentials');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);
    const permissions = this.derivePermissions(user.userRoles);

    // Password checked before any account-state gate, so failure reasons stay indistinguishable.
    const validPassword = await bcrypt.compare(data.password, user.passwordHash);

    if (!validPassword) {
      await this.lockoutUtil.recordFailedLogin(user.id);

      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: { method: 'password', result: 'failed' },
      });

      throw new UnauthorizedException('invalid_credentials');
    }

    // Roles are additive; only accounts that never held USER at all are blocked here.
    if (!roles.includes(RolesEnum.USER)) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: {
          method: 'password',
          result: 'failed',
          reason: 'no_user_role_use_admin_login',
        },
      });

      throw new UnauthorizedException('use_admin_login');
    }

    // Lock check runs only after password verification, so it can't be used as an oracle.
    try {
      this.lockoutUtil.assertNotLocked(user);
    } catch (err) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: {
          method: 'password',
          result: 'failed',
          reason: 'account_locked',
        },
      });
      throw err;
    }

    // Correct password clears any prior failure count/lock
    await this.lockoutUtil.resetLoginAttempts(user);

    if (!user.isActive) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: {
          method: 'password',
          result: 'failed',
          reason: 'account_inactive',
        },
      });

      throw new UnauthorizedException('account_inactive');
    }

    if (!user.isPhoneVerified) {
      // Password was correct — route to verification instead of dead-ending, not a failure.
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
      diff: { method: 'password', result: 'success' },
    });

    return this.tokenUtil.issueTokens(
      user.id,
      { phone: user.phone, email: user.email },
      roles,
      permissions,
    );
  }

  // FORGOT PASSWORD — masks "no account", "inactive", and "holds an admin role" identically.

  async forgotPassword(data: ForgotPasswordDto): Promise<ForgotPasswordResult> {
    const phone = this.normalizePhoneOrThrow(data.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: {
        id: true,
        phone: true,
        isPhoneVerified: true,
        isActive: true,
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });

    const roles = user?.userRoles.map((userRole) => userRole.role.name) ?? [];

    // Masks "no account", "inactive", and "admin role" identically (shared password risk).
    if (!user || !user.isActive || this.hasAdminRole(roles)) {
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

  // RESET PASSWORD

  async resetPassword(data: ResetPasswordDto): Promise<{ message: string }> {
    const otpRecord = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      include: {
        user: {
          select: {
            id: true,
            userRoles: { include: { role: true } },
          },
        },
      },
    });

    if (
      !otpRecord ||
      otpRecord.purpose !== UserOtpPurposeEnum.password_reset ||
      otpRecord.usedAt ||
      otpRecord.expiresAt < new Date()
    ) {
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const roles = otpRecord.user.userRoles.map((userRole) => userRole.role.name);

    if (otpRecord.attempts >= 5) {
      await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

      this.emitAudit({
        userId: otpRecord.user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.SECURITY_ALERT,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        diff: {
          reason: 'too_many_otp_attempts',
          purpose: 'password_reset',
        },
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
        await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

        this.emitAudit({
          userId: otpRecord.user.id,
          actorType: resolveActorType(roles),
          action: AuditEventEnum.SECURITY_ALERT,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          diff: {
            reason: 'too_many_otp_attempts',
            purpose: 'password_reset',
          },
        });
      }

      throw new BadRequestException('invalid_or_expired_otp');
    }

    const hashedPassword = await bcrypt.hash(data.newPassword, 10);

    // Same atomic-claim pattern as verifySignupOtp()
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
        where: { id: otpRecord.user.id },
        data: { passwordHash: hashedPassword },
      });

      // Invalidate every existing session
      await tx.session.deleteMany({
        where: { userId: otpRecord.user.id },
      });
    });

    // Audit after successful transaction
    this.emitAudit({
      userId: otpRecord.user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.PASSWORD_RESET,
      entity: 'User',
      entityId: otpRecord.user.id,
      diff: { method: 'otp', result: 'success' },
    });

    // Notify after successful transaction
    const resetEvent: PasswordResetEvent = { userId: otpRecord.user.id };
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_RESET, resetEvent);

    return { message: 'password_reset_successful' };
  }

  // REFRESH TOKEN — soft-revokes (not deletes) so a replayed rotated token is detectable.

  async refresh(data: RefreshTokenDto): Promise<TokenPair> {
    let payload: {
      sub: string;
      phone: string;
      roles: string[];
      type: string;
    };

    // Verify with dedicated refresh secret, falling back to access-token secret.
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
      throw new UnauthorizedException('invalid_refresh_token');
    }

    const refreshTokenHash = this.tokenUtil.hashOpaqueToken(data.refreshToken, 'refresh');

    // Look up by hash alone so we can distinguish "never existed" from "already used".
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
      // This token was already rotated once — reuse means it was stolen; wipe all sessions.
      await this.prisma.session.updateMany({
        where: { userId: payload.sub, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      this.emitAudit({
        userId: payload.sub,
        actorType: resolveActorType(payload.roles ?? []),
        action: AuditEventEnum.SECURITY_ALERT,
        entity: 'Session',
        entityId: session.id,
        diff: { reason: 'refresh_token_reuse_detected' },
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
      throw new UnauthorizedException('user_inactive');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);
    const permissions = this.derivePermissions(user.userRoles);

    // Soft-revoke the old session, then mint a new one, in one transaction.
    return this.prisma.$transaction(async (tx) => {
      const rotated = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      if (rotated.count === 0) {
        // Lost a race with a concurrent refresh using the same token
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

  // CURRENT USER

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

  // CHANGE PASSWORD

  async changePassword(
    user: CurrentUserDto,
    data: ChangePasswordDto,
  ): Promise<{ message: string }> {
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: {
        userRoles: { include: { role: true } },
      },
    });

    if (!dbUser) {
      throw new NotFoundException('user_not_found');
    }

    if (!dbUser.passwordHash) {
      throw new BadRequestException('password_not_set');
    }

    const validPassword = await bcrypt.compare(data.currentPassword, dbUser.passwordHash);

    if (!validPassword) {
      throw new BadRequestException('wrong_current_password');
    }

    const hashedPassword = await bcrypt.hash(data.newPassword, 10);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: hashedPassword },
      }),

      // Force re-login after password change
      this.prisma.session.deleteMany({
        where: { userId: user.id },
      }),
    ]);

    const roles = dbUser.userRoles.map((userRole) => userRole.role.name);

    // Audit after successful transaction
    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.PASSWORD_CHANGED,
      entity: 'User',
      entityId: user.id,
      diff: { result: 'success' },
    });

    // Notify after successful transaction
    const changedEvent: PasswordChangedEvent = { userId: user.id };
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_CHANGED, changedEvent);

    return { message: 'password_changed' };
  }

  // LOGOUT

  async logout(user: CurrentUserDto, req: any): Promise<{ message: string }> {
    const refreshToken = req?.body?.refreshToken || req?.headers?.['x-refresh-token'];

    if (refreshToken) {
      await this.prisma.session.deleteMany({
        where: {
          userId: user.id,
          refreshToken: this.tokenUtil.hashOpaqueToken(refreshToken, 'refresh'),
        },
      });
    } else {
      await this.prisma.session.deleteMany({
        where: { userId: user.id },
      });
    }

    // Roles come straight from JWT payload via CurrentUserDto
    const roles = user.roles ?? [];

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.LOGOUT,
      entity: 'User',
      entityId: user.id,
      diff: { result: 'success' },
    });

    return { message: 'logout_successful' };
  }

  // Wraps normalizePhoneNumber() so malformed input yields a clean 400, not a raw 500.
  private normalizePhoneOrThrow(phone: string): string {
    try {
      return normalizePhoneNumber(phone);
    } catch {
      throw new BadRequestException('invalid_phone_number');
    }
  }
}

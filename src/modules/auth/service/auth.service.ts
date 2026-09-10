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
import { randomInt, randomBytes, createHmac, randomUUID } from 'crypto';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { normalizePhoneNumber } from 'src/common/utils/phone.util';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { sendSms } from 'src/services/sms/afro-message.service';
import { renderOtpSms } from 'src/services/sms/templates/sms-otp.template';

import { sendEmail } from 'src/services/email/email.service';
import {
  renderOtpEmailSubject,
  renderOtpEmailHtml,
} from 'src/services/email/templates/otp-email.template';

import {
  renderAdminInviteEmailSubject,
  renderAdminInviteEmailHtml,
} from 'src/services/email/templates/admin-invite-email.template';

import {
  renderPromotionEmailSubject,
  renderPromotionEmailHtml,
} from 'src/services/email/templates/promotion-email.template';

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
  AdminInviteDto,
  AdminInviteResendDto,
  AdminSetPasswordDto,
  AdminLoginEmailDto,
  AdminForgotPasswordDto,
  PromoteUserDto,
  PromoteUserResendDto,
  PromoteVerifyDto,
} from '../dto/auth.dto';

type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

/** If phone isn't verified, login() sends a fresh OTP instead of tokens. */
type LoginResult =
  | TokenPair
  | {
      requiresVerification: true;
      verificationId: string;
      message: string;
    };

/** forgotPassword() result; purpose tells client which OTP screen to use, empty verificationId means no account. */
type ForgotPasswordResult = {
  verificationId: string;
  purpose?: 'password_reset' | 'phone_verification';
};

const INVITE_TOKEN_EXPIRES_MINUTES = 60 * 24; // 24h to accept an invite
const PROMOTION_TOKEN_EXPIRES_MINUTES = 60 * 24; // 24h to click the promotion email link

const ADMIN_ROLES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // AUDIT EMIT (typed helper): routes every audit emit through AuditEventPayload so a
  // missing field (actorType, entity, etc.) is caught at compile time, not silently dropped

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // PHONE ASSERTION: narrows `string | null` -> `string` at call sites where the user
  // was found or created via a phone-keyed lookup, so phone is structurally guaranteed
  // to be set even though the column is nullable (email-only admins have no phone).
  // Throws instead of silently passing null into sendSms()/issueAndSendOtp().
  private requirePhone(phone: string | null): string {
    if (!phone) {
      throw new BadRequestException('phone_number_missing');
    }
    return phone;
  }

  // ROLE CHECK HELPER: shared by forgotPassword() (and elsewhere) so every route agrees on
  // exactly which roles count as "admin" (Phase 1 #1, #2 — user-facing phone flows
  // must never authenticate or recover a password for an ADMIN/SUPER_ADMIN account).
  private hasAdminRole(roles: string[]): boolean {
    return roles.some((role) => ADMIN_ROLES.includes(role as RolesEnum));
  }

  // UNIQUE CONSTRAINT CHECK: detects a Prisma P2002 violation so concurrent
  // signup/invite/promote requests for the same phone or email fail with a
  // clean 400 instead of an unhandled 500 (closes the check-then-write race).

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  // OTP ABUSE LOCKOUT: once an OTP hits its max attempts, lock the account the
  // same way a failed-password lockout does, instead of only logging a
  // SECURITY_ALERT. Without this, a distributed attacker could keep requesting
  // fresh OTPs (rate-limited to one per cooldown window) and get 5 free
  // guesses each, indefinitely, against one target account.

  private async lockAccountForOtpAbuse(userId: string): Promise<void> {
    const lockoutMinutes = this.configService.get<number>('security.lockoutDurationMinutes', 15);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        lockedUntil: new Date(Date.now() + lockoutMinutes * 60 * 1000),
        failedLoginAttempts: 0,
      },
    });
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

      // Unverified existing account: resend OTP instead of blocking or duplicating
      const { verificationId } = await this.issueAndSendOtp(
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

    // Create user + OTP in one transaction; SMS sent outside it
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

        const otp = this.generateOtp();
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
      // A concurrent request created this phone number between our lookup above
      // and this write — same outcome as finding it up front, just discovered late
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
      // Log failure only; user/OTP already persisted, client can use resendSignupOtp()
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
            userRoles: { include: { role: true } },
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

    // Enforce max OTP attempts
    if (otpRecord.attempts >= 5) {
      await this.lockAccountForOtpAbuse(otpRecord.user.id);

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

      // Lock the account once failed attempts hit the max, not just alert
      if (updatedOtp.attempts >= 5) {
        await this.lockAccountForOtpAbuse(otpRecord.user.id);

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

    // Atomically claim the OTP (usedAt: null in where) and flip isPhoneVerified together
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

    return this.issueTokens(otpRecord.user.id, { phone: otpRecord.user.phone }, roles);
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

    const { verificationId: newVerificationId } = await this.issueAndSendOtp(
      oldOtp.userId,
      this.requirePhone(oldOtp.user.phone),
      UserOtpPurposeEnum.phone_verification,
      OtpChannelEnum.sms,
    );

    return { verificationId: newVerificationId };
  }

  // LOGIN: Requires User.isPhoneVerified; account lockout enforced via failedLoginAttempts/lockedUntil.
  // Restricted to accounts holding the USER role (roles are additive — see the
  // promotion-model note above promoteUserVerify() below). A promoted account
  // (USER + ADMIN) still logs in here for the ordinary user app; a pure
  // invite-created admin (ADMIN/SUPER_ADMIN only, no USER role, and usually no
  // phone at all) is rejected and must use AdminAuthController.login()
  // (email + password) instead.

  async login(data: LoginDto): Promise<LoginResult> {
    const phone = this.normalizePhoneOrThrow(data.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: {
        userRoles: { include: { role: true } },
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

    // Password checked before any account-state gate (lock, active, verified,
    // role) — keeps "no such account", "wrong password", "locked account",
    // and "this account has no USER role" all indistinguishable to someone
    // who hasn't already proven they know the password.
    const validPassword = await bcrypt.compare(data.password, user.passwordHash);

    if (!validPassword) {
      await this.recordFailedLogin(user.id);

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

    // FIX (Phase 1 #1, revised for additive roles): /auth/login requires the
    // USER role, checked positively rather than by excluding admin roles.
    // Roles are additive (Doc §3 promotion model) — a promoted account keeps
    // USER alongside ADMIN/SUPER_ADMIN and is meant to keep using this
    // endpoint for the ordinary app. What must stay blocked is an account
    // that was only ever onboarded as an admin (invite flow) and never held
    // a USER role at all. Checked only after the password has been proven
    // correct, so this never becomes an unauthenticated "does this phone
    // number have a USER role" oracle.
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

    // FIX (previously identified): lock check now runs only after the
    // password has been verified correct, so a locked account can't be
    // distinguished from "wrong password"/"no such account" by an attacker
    // who doesn't already know the password.
    try {
      this.assertNotLocked(user);
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
    await this.resetLoginAttempts(user);

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
      // Password WAS correct here — this isn't a failed login, it's a
      // successful one that's being redirected to verification. Emitting
      // LOGIN_FAILED would pollute any alerting built on that event.

      // Unverified: send fresh OTP and route client to verification instead of dead-ending
      const { verificationId } = await this.issueAndSendOtp(
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

    return this.issueTokens(user.id, { phone: user.phone, email: user.email }, roles);
  }

  // FORGOT PASSWORD: Unverified accounts get a phone_verification OTP instead of password_reset;
  // "no account", "deactivated account", and (Phase 1 #2) "account holds an admin role" are all
  // masked identically — this is intentionally NOT mirrored to login()'s USER-role check.
  //
  // Rationale: passwordHash is shared by the whole account — the same password gates both
  // /auth/login and /admin/auth/login. If a USER+ADMIN account could reset that shared
  // password over SMS, the admin side would inherit SIM-swap-able recovery, defeating the
  // point of admin password recovery being email-only. So ANY account holding an admin role
  // is masked here regardless of whether it also holds USER — admin recovery must always go
  // through AdminAuthController.forgotPassword() (email-based) instead.

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

    // FIX (Phase 1 #2): mask "no account", "deactivated account", AND "this
    // account holds an admin role" identically — see the method-level note
    // above for why this is a positive admin-role check, not a USER-role
    // check, and deliberately not symmetric with login().
    if (!user || !user.isActive || this.hasAdminRole(roles)) {
      return { verificationId: '' };
    }

    if (!user.isPhoneVerified) {
      const { verificationId } = await this.issueAndSendOtp(
        user.id,
        this.requirePhone(user.phone),
        UserOtpPurposeEnum.phone_verification,
        OtpChannelEnum.sms,
      );

      return { verificationId, purpose: 'phone_verification' };
    }

    const { verificationId } = await this.issueAndSendOtp(
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
      await this.lockAccountForOtpAbuse(otpRecord.user.id);

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
        await this.lockAccountForOtpAbuse(otpRecord.user.id);

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

  // ADMIN — RESET PASSWORD: thin wrapper around resetPassword() that actually
  // enforces the route is admin-scoped (gap #7 — previously /admin/auth/reset-password
  // silently accepted any valid password_reset OTP for any account, admin or not).
  // Same generic error on mismatch so this can't be used to probe which accounts are admins.
  //
  // FIX (Phase 1 #3): AdminAuthController.resetPassword() now calls THIS method
  // instead of calling resetPassword() directly — otherwise this admin check
  // was written but never actually wired up to the route it exists to protect.

  async adminResetPassword(data: ResetPasswordDto): Promise<{ message: string }> {
    const otpRecord = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      select: {
        user: {
          select: {
            userRoles: { select: { role: { select: { name: true } } } },
          },
        },
      },
    });

    if (!otpRecord) {
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const roles = otpRecord.user.userRoles.map((userRole) => userRole.role.name);

    const isAdmin = this.hasAdminRole(roles);

    if (!isAdmin) {
      throw new BadRequestException('invalid_or_expired_otp');
    }

    return this.resetPassword(data);
  }

  // REFRESH TOKEN: rotates via soft-revoke (Session.revokedAt) instead of delete,
  // enabling reuse detection — a replayed already-rotated token wipes all sessions for the user

  async refresh(data: RefreshTokenDto): Promise<TokenPair> {
    let payload: {
      sub: string;
      phone: string;
      roles: string[];
      type: string;
    };

    // Verify with dedicated refresh secret, falling back to access-token secret
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

    const refreshTokenHash = this.hashOpaqueToken(data.refreshToken, 'refresh');

    // FIX: look up by hash alone (no expiresAt/revokedAt filter here) so we can
    // distinguish "never existed" from "already used" (reuse) from "expired"
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
      // FIX: this exact refresh token was already rotated once — a second use
      // means it was stolen and replayed. Wipe every active session for this
      // user and raise an alert rather than trying to tell attacker from owner apart.
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
        userRoles: { include: { role: true } },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('user_inactive');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);

    // FIX: soft-revoke (not delete) the old session, then mint a new one, in one
    // transaction — the revoked row stays so a replay of this token is detectable
    return this.prisma.$transaction(async (tx) => {
      const rotated = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      if (rotated.count === 0) {
        // Lost a race with a concurrent refresh using the same token
        throw new UnauthorizedException('session_expired_or_invalid');
      }

      return this.issueTokens(user.id, { phone: user.phone, email: user.email }, roles, tx);
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
          refreshToken: this.hashOpaqueToken(refreshToken, 'refresh'),
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

  // ═══════════════════════════════════════════════════════════
  // Admin onboarding — invite-based flow (Doc §2). Super Admin
  // supplies email + full name + roles; no password is created or
  // known by the creator. The account stays inactive ("INVITED")
  // until the new admin uses their invite-link token to set their
  // own password, which also activates the account.
  // ═══════════════════════════════════════════════════════════

  // ADMIN — INVITE: Super Admin supplies email + full name + roles.
  // No password is created or known by the creator. Account is left
  // inactive/unverified ("INVITED") until the new admin sets their
  // own password via adminSetPasswordFromInvite().

  async adminInvite(
    creator: CurrentUserDto,
    data: AdminInviteDto,
  ): Promise<{ adminId: string; message: string }> {
    // Restricted to SUPER_ADMIN per doc §2 ("Super Admin enters email only").
    const creatorRoles = creator.roles ?? [];

    if (!creatorRoles.includes(RolesEnum.SUPER_ADMIN)) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const email = data.email.trim().toLowerCase();

    // Defense-in-depth: AdminInviteDto's @IsIn already restricts this, but a
    // service-level check protects against DTO validation ever being bypassed
    // (e.g. a future internal caller). Inviting with a non-admin role would
    // create an account with no phone and no admin role — permanently locked out.
    const invitableRoles = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];
    if (data.roles.some((role) => !invitableRoles.includes(role))) {
      throw new BadRequestException('only_admin_roles_may_be_invited');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new BadRequestException('email_already_registered');
    }

    // Resolve every requested role up front so a typo'd/unconfigured role
    // fails before the user row (and invite email) is created
    const roleRecords = await this.prisma.role.findMany({
      where: { name: { in: data.roles } },
    });

    if (roleRecords.length !== new Set(data.roles).size) {
      throw new BadRequestException('one_or_more_roles_not_configured');
    }

    const rawInviteToken = randomBytes(32).toString('hex');
    const inviteTokenHash = this.hashOpaqueToken(rawInviteToken, 'invite');
    const inviteTokenExpiresAt = new Date(Date.now() + INVITE_TOKEN_EXPIRES_MINUTES * 60 * 1000);

    let admin: { id: string };

    try {
      admin = await this.prisma.user.create({
        data: {
          email,
          name: data.name,
          // No phone, no password — this is the "INVITED" state:
          passwordHash: null,
          isPhoneVerified: false,
          isEmailVerified: false,
          isActive: false,
          inviteTokenHash,
          inviteTokenExpiresAt,
          userRoles: {
            create: roleRecords.map((role) => ({ roleId: role.id })),
          },
        },
      });
    } catch (error) {
      // FIX: closes the race between the existingUser check above and this write —
      // a concurrent invite for the same email now fails cleanly instead of 500ing
      if (this.isUniqueConstraintError(error)) {
        throw new BadRequestException('email_already_registered');
      }
      throw error;
    }

    // Reuses the same 'app.url' value main.ts and EmailTemplateService already
    // read (mapped from APP_URL in configuration.ts), so the link always points
    // at the real deployed frontend instead of a hardcoded placeholder domain.
    const appUrl = this.configService.get<string>('app.url', 'https://ehte.org');
    const inviteLink = `${appUrl}/admin/invite?token=${rawInviteToken}`;

    const inviteExpiresInHours = Math.round(INVITE_TOKEN_EXPIRES_MINUTES / 60);

    try {
      await sendEmail(
        email,
        renderAdminInviteEmailSubject(),
        renderAdminInviteEmailHtml({
          inviteLink,
          expiresInHours: inviteExpiresInHours,
        }),
      );
    } catch (error) {
      console.error(`[EHTE EMAIL] Failed to send admin invite to ${email}`, error);
    }

    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] Admin invite link for ${email}: ${inviteLink}`);
    }

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(data.roles),
      // TODO: swap for a dedicated ADMIN_INVITED value once AuditEventEnum is extended
      action: AuditEventEnum.USER_CREATED,
      entity: 'User',
      entityId: admin.id,
      diff: {
        result: 'success',
        roles: data.roles,
        status: 'invited',
        invitedBy: creator.id,
      },
    });

    return { adminId: admin.id, message: 'admin_invited' };
  }

  // ADMIN — RESEND INVITE (Phase 1 #6): re-sends the invite email with a
  // freshly generated token. Only valid while the account is still sitting
  // in the "INVITED" state (no password set, never activated) — this closes
  // the gap where a failed sendEmail() in adminInvite() left a permanently
  // stuck, un-onboardable admin account with no recovery path.

  async adminInviteResend(
    creator: CurrentUserDto,
    data: AdminInviteResendDto,
  ): Promise<{ message: string }> {
    const creatorRoles = creator.roles ?? [];

    if (!creatorRoles.includes(RolesEnum.SUPER_ADMIN)) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const email = data.email.trim().toLowerCase();

    const admin = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!admin) {
      throw new NotFoundException('invite_not_found');
    }

    // Once a password has been set (or the account activated) the invite
    // flow is complete — nothing left to resend.
    if (admin.passwordHash || admin.isActive) {
      throw new BadRequestException('invite_already_completed');
    }

    const rawInviteToken = randomBytes(32).toString('hex');
    const inviteTokenHash = this.hashOpaqueToken(rawInviteToken, 'invite');
    const inviteTokenExpiresAt = new Date(Date.now() + INVITE_TOKEN_EXPIRES_MINUTES * 60 * 1000);

    // Overwriting the token invalidates any previous unused invite link —
    // only the most recently sent one can ever be valid.
    await this.prisma.user.update({
      where: { id: admin.id },
      data: { inviteTokenHash, inviteTokenExpiresAt },
    });

    const appUrl = this.configService.get<string>('app.url', 'https://ehte.org');
    const inviteLink = `${appUrl}/admin/invite?token=${rawInviteToken}`;
    const inviteExpiresInHours = Math.round(INVITE_TOKEN_EXPIRES_MINUTES / 60);

    try {
      await sendEmail(
        email,
        renderAdminInviteEmailSubject(),
        renderAdminInviteEmailHtml({
          inviteLink,
          expiresInHours: inviteExpiresInHours,
        }),
      );
    } catch (error) {
      console.error(`[EHTE EMAIL] Failed to resend admin invite to ${email}`, error);
    }

    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] Resent admin invite link for ${email}: ${inviteLink}`);
    }

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType([]),
      // TODO: swap for a dedicated ADMIN_INVITE_RESENT value once AuditEventEnum is extended
      action: AuditEventEnum.USER_CREATED,
      entity: 'User',
      entityId: admin.id,
      diff: {
        result: 'success',
        context: 'invite_resent',
        resentBy: creator.id,
      },
    });

    return { message: 'invite_resent' };
  }

  // ADMIN — SET PASSWORD FROM INVITE: anonymous; invited admin uses the raw
  // token from their invite email to set their own password. Possessing the
  // token proves control of the invited inbox, so this also activates the
  // account and returns tokens directly — no separate post-password OTP step.

  async adminSetPasswordFromInvite(data: AdminSetPasswordDto): Promise<TokenPair> {
    const inviteTokenHash = this.hashOpaqueToken(data.inviteToken, 'invite');

    const admin = await this.prisma.user.findUnique({
      where: { inviteTokenHash },
      include: {
        userRoles: { include: { role: true } },
      },
    });

    if (!admin || !admin.inviteTokenExpiresAt || admin.inviteTokenExpiresAt < new Date()) {
      throw new BadRequestException('invalid_or_expired_invite');
    }

    if (admin.passwordHash) {
      // Invite already used to set a password once
      throw new BadRequestException('invite_already_used');
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);
    const roles = admin.userRoles.map((userRole) => userRole.role.name);

    await this.prisma.user.update({
      where: { id: admin.id },
      data: {
        passwordHash: hashedPassword,
        // Possessing the token proved control of the invited inbox — activate now
        isEmailVerified: true,
        isActive: true,
        // Single-use: clear the invite token now that it's been consumed
        inviteTokenHash: null,
        inviteTokenExpiresAt: null,
      },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.PASSWORD_CHANGED,
      entity: 'User',
      entityId: admin.id,
      diff: { result: 'success', context: 'admin_invite_set_password_and_activate' },
    });

    if (!admin.email) {
      // Shouldn't happen for an invite-created admin, but guard anyway
      throw new BadRequestException('admin_email_missing');
    }

    // Admin has no phone at this point — issue tokens with email set, phone left null
    return this.issueTokens(admin.id, { email: admin.email }, roles);
  }

  // ═══════════════════════════════════════════════════════════
  // Existing user → admin promotion (Doc §3). Closes gap 3.4.
  //
  // ROLE MODEL — ADDITIVE, NOT REPLACEMENT: promoting a USER grants
  // ADMIN *alongside* the existing USER role, not instead of it.
  // A promoted account keeps phone + password login on /auth/login
  // for the ordinary user app, and gains email + password login on
  // /admin/auth/login for the admin portal. The two role systems
  // (USER → user app, ADMIN/SUPER_ADMIN → admin portal) are
  // independent capabilities layered on one identity, not mutually
  // exclusive states. See promoteUserVerify() below for where this
  // is enforced, and login()/forgotPassword() above for how the
  // USER-facing phone routes account for it.
  // ═══════════════════════════════════════════════════════════

  // ADMIN — PROMOTE EXISTING USER (STEP 1): Super Admin selects an existing
  // USER by phone and supplies an email to attach. The user's existing
  // password is untouched. The ADMIN role is NOT granted yet — only once
  // the email OTP is verified in promoteUserVerify().

  async promoteUserInitiate(
    actor: CurrentUserDto,
    data: PromoteUserDto,
  ): Promise<{ message: string }> {
    const actorRoles = actor.roles ?? [];

    if (!actorRoles.includes(RolesEnum.SUPER_ADMIN)) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const phone = this.normalizePhoneOrThrow(data.phone);
    const email = data.email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    // FIX (Phase 1 #7 / "Priority 7"): require the existing account to be
    // active and phone-verified before it can be promoted. A promoted admin
    // built on an unverified or deactivated identity has a weaker provenance
    // than one onboarded through the invite flow, which always requires
    // proof of inbox control before activation.
    if (!user.isActive) {
      throw new BadRequestException('user_not_eligible_for_promotion');
    }

    if (!user.isPhoneVerified) {
      throw new BadRequestException('user_not_eligible_for_promotion');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);

    if (this.hasAdminRole(roles)) {
      throw new BadRequestException('user_already_admin');
    }

    const emailInUse = await this.prisma.user.findUnique({ where: { email } });

    if (emailInUse && emailInUse.id !== user.id) {
      throw new BadRequestException('email_already_registered');
    }

    // Attach the email now (unverified) — the ADMIN role is granted only
    // after promoteUserVerify() confirms the user controls this inbox.
    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { email, isEmailVerified: false },
      });
    } catch (error) {
      // FIX: closes the race between the emailInUse check above and this write
      if (this.isUniqueConstraintError(error)) {
        throw new BadRequestException('email_already_registered');
      }
      throw error;
    }

    // A clickable link, not a typed-in code — the link itself is the proof
    // of inbox ownership, so we issue a high-entropy raw token (same shape
    // as the admin-invite flow) rather than a bcrypt-hashed 6-digit OTP.
    // The HMAC hash is deterministic, so promoteUserVerify() can look this
    // record up directly by token — no verificationId needed on the client.
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashOpaqueToken(rawToken, 'promotion');
    const expiresAt = new Date(Date.now() + PROMOTION_TOKEN_EXPIRES_MINUTES * 60 * 1000);

    // Invalidate any previous unused promotion link for this user so only
    // the most recently sent link can ever be valid
    await this.prisma.userOtp.updateMany({
      where: { userId: user.id, purpose: UserOtpPurposeEnum.promotion_verification, usedAt: null },
      data: { usedAt: new Date() },
    });

    const promotionOtp = await this.prisma.userOtp.create({
      data: {
        userId: user.id,
        otpHash: tokenHash,
        purpose: UserOtpPurposeEnum.promotion_verification,
        channel: OtpChannelEnum.email,
        expiresAt,
      },
    });

    const appUrl = this.configService.get<string>('app.url', 'https://ehte.org');
    const promotionLink = `${appUrl}/admin/promote/verify?token=${rawToken}`;
    const expiresInHours = Math.round(PROMOTION_TOKEN_EXPIRES_MINUTES / 60);

    try {
      await sendEmail(
        email,
        renderPromotionEmailSubject(),
        renderPromotionEmailHtml({ promotionLink, expiresInHours }),
      );
    } catch (error) {
      console.error(`[EHTE EMAIL] Failed to send promotion link to ${email}`, error);
    }

    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] Promotion link for ${email}: ${promotionLink}`);
    }

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(roles),
      // TODO: swap for a dedicated USER_PROMOTION_INITIATED value once AuditEventEnum is extended
      action: AuditEventEnum.USER_CREATED,
      entity: 'User',
      entityId: user.id,
      diff: {
        result: 'success',
        context: 'promotion_initiated',
        initiatedBy: actor.id,
        otpId: promotionOtp.id,
      },
    });

    return { message: 'promotion_email_sent' };
  }

  // ADMIN — RESEND PROMOTION (Phase 1 #6): re-sends the promotion email with
  // a freshly generated token, for a user whose promotion is still pending
  // (email attached via promoteUserInitiate(), not yet verified). Closes the
  // gap where a failed sendEmail() there left the user with an attached but
  // unusable email and no way to complete the promotion.

  async promoteUserResend(
    actor: CurrentUserDto,
    data: PromoteUserResendDto,
  ): Promise<{ message: string }> {
    const actorRoles = actor.roles ?? [];

    if (!actorRoles.includes(RolesEnum.SUPER_ADMIN)) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const phone = this.normalizePhoneOrThrow(data.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    if (!user.email) {
      // promoteUserInitiate() was never called for this user
      throw new BadRequestException('promotion_not_initiated');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);

    if (this.hasAdminRole(roles)) {
      throw new BadRequestException('user_already_admin');
    }

    if (user.isEmailVerified) {
      // Already completed — nothing pending to resend
      throw new BadRequestException('promotion_already_completed');
    }

    // Invalidate any previous unused promotion link, same as promoteUserInitiate()
    await this.prisma.userOtp.updateMany({
      where: { userId: user.id, purpose: UserOtpPurposeEnum.promotion_verification, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashOpaqueToken(rawToken, 'promotion');
    const expiresAt = new Date(Date.now() + PROMOTION_TOKEN_EXPIRES_MINUTES * 60 * 1000);

    await this.prisma.userOtp.create({
      data: {
        userId: user.id,
        otpHash: tokenHash,
        purpose: UserOtpPurposeEnum.promotion_verification,
        channel: OtpChannelEnum.email,
        expiresAt,
      },
    });

    const appUrl = this.configService.get<string>('app.url', 'https://ehte.org');
    const promotionLink = `${appUrl}/admin/promote/verify?token=${rawToken}`;
    const expiresInHours = Math.round(PROMOTION_TOKEN_EXPIRES_MINUTES / 60);

    try {
      await sendEmail(
        user.email,
        renderPromotionEmailSubject(),
        renderPromotionEmailHtml({ promotionLink, expiresInHours }),
      );
    } catch (error) {
      console.error(`[EHTE EMAIL] Failed to resend promotion link to ${user.email}`, error);
    }

    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] Resent promotion link for ${user.email}: ${promotionLink}`);
    }

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(roles),
      // TODO: swap for a dedicated USER_PROMOTION_RESENT value once AuditEventEnum is extended
      action: AuditEventEnum.USER_CREATED,
      entity: 'User',
      entityId: user.id,
      diff: {
        result: 'success',
        context: 'promotion_resent',
        resentBy: actor.id,
      },
    });

    return { message: 'promotion_email_resent' };
  }

  // ADMIN — PROMOTE EXISTING USER (STEP 2): the user being promoted clicks
  // the emailed link and the frontend submits just the token from the URL.
  // Possessing the token IS the proof of email ownership — same trust model
  // as adminSetPasswordFromInvite(). No OTP compare, no attempts/lockout
  // logic: this is a 256-bit random token looked up by exact hash match,
  // not a 6-digit code that benefits from brute-force protection.
  //
  // FIX (revised): promotion is now ADDITIVE, not a role replacement. On
  // success, isEmailVerified flips to true and the ADMIN role is granted
  // ALONGSIDE the user's existing roles (USER stays) — USER + ADMIN, not
  // USER → ADMIN. This is what lets a promoted admin keep logging into the
  // ordinary user app via /auth/login (see the USER-role check there) while
  // gaining admin-portal access via /admin/auth/login. promoteUserInitiate()
  // already guarantees the user holds no admin role yet at this point, so a
  // plain create (not a delete-then-create) is safe and can't collide with
  // the @@unique([userId, roleId]) constraint. Their existing password is
  // unchanged.

  async promoteUserVerify(data: PromoteVerifyDto): Promise<{ message: string }> {
    const tokenHash = this.hashOpaqueToken(data.token, 'promotion');

    const otpRecord = await this.prisma.userOtp.findFirst({
      where: {
        otpHash: tokenHash,
        purpose: UserOtpPurposeEnum.promotion_verification,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
          include: { userRoles: { include: { role: true } } },
        },
      },
    });

    if (!otpRecord) {
      throw new BadRequestException('invalid_or_expired_token');
    }

    const user = otpRecord.user;
    const roles = user.userRoles.map((userRole) => userRole.role.name);

    const adminRole = await this.prisma.role.findUnique({
      where: { name: RolesEnum.ADMIN },
    });

    if (!adminRole) {
      throw new BadRequestException('admin_role_not_configured');
    }

    await this.prisma.$transaction(async (tx) => {
      // Atomically claim the token (usedAt: null in where) so a replayed
      // link can't be used twice, same pattern as every other OTP claim
      const claimed = await tx.userOtp.updateMany({
        where: {
          id: otpRecord.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });

      if (claimed.count === 0) {
        throw new BadRequestException('invalid_or_expired_token');
      }

      await tx.user.update({
        where: { id: user.id },
        data: { isEmailVerified: true },
      });

      // FIX: promotion is ADDITIVE — grant ADMIN alongside every role the
      // user already has (USER stays). promoteUserInitiate() already
      // guarantees hasAdminRole(roles) was false when this token was
      // issued, so this create can't collide with an existing ADMIN row
      // under the @@unique([userId, roleId]) constraint. No deleteMany.
      await tx.userRole.create({
        data: { userId: user.id, roleId: adminRole.id },
      });
    });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType([...roles, RolesEnum.ADMIN]),
      action: AuditEventEnum.OTP_VERIFIED,
      entity: 'UserOtp',
      entityId: otpRecord.id,
      diff: {
        purpose: 'promotion_verification',
        result: 'success',
        previousRoles: roles,
        addedRole: RolesEnum.ADMIN,
        retainedRoles: roles,
      },
    });

    return { message: 'user_promoted_to_admin' };
  }

  // ADMIN — FORGOT PASSWORD: email-only, no phone. Masks whether the
  // email belongs to an admin at all (mirrors forgotPassword()'s masking
  // of phone existence) so enumeration can't distinguish "no account",
  // "not an admin", and "inactive admin". Reuses resetPassword() as-is —
  // that method only ever needed verificationId + otp, never a phone
  // number, so it already works for this email-delivered OTP unchanged.

  async adminForgotPassword(
    data: AdminForgotPasswordDto,
  ): Promise<{ verificationId: string }> {
    const email = data.email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { userRoles: { include: { role: true } } },
    });

    const roles = user?.userRoles.map((userRole) => userRole.role.name) ?? [];

    const isAdmin = this.hasAdminRole(roles);

    // Mask: no account, not an admin, or inactive all look identical externally
    if (!user || !isAdmin || !user.isActive) {
      return { verificationId: '' };
    }

    const { verificationId } = await this.issueAndSendOtp(
      user.id,
      email,
      UserOtpPurposeEnum.password_reset,
      OtpChannelEnum.email,
    );

    return { verificationId };
  }

  // ADMIN — LOGIN BY EMAIL (Doc §1, §7): the only admin credential path.
  // Phone-based admin login has been removed — admins/super-admins always
  // authenticate with email + password. Covers admins created via
  // adminInvite()/adminSetPasswordFromInvite() (who may have no phone at
  // all) and promoted users who now hold ADMIN alongside their existing
  // USER role and a verified email.
  //
  // FIX (Phase 1 #4 / "Priority 9"): now also requires isEmailVerified.
  // Both existing paths to a real admin account already guarantee this
  // (adminSetPasswordFromInvite() sets it on activation; promoteUserVerify()
  // sets it on promotion) — this is a defense-in-depth check against a
  // future code path or manual DB edit ever producing an admin account
  // whose email was never actually proven.

  async adminLoginByEmail(data: AdminLoginEmailDto): Promise<TokenPair> {
    const email = data.email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        userRoles: { include: { role: true } },
      },
    });

    const roles = user?.userRoles.map((userRole) => userRole.role.name) ?? [];

    const isAdmin = this.hasAdminRole(roles);

    if (!user || !user.passwordHash || !isAdmin || !user.isEmailVerified) {
      this.emitAudit({
        userId: user?.id ?? null,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user?.id ?? null,
        diff: {
          method: 'password',
          context: 'admin_login_email',
          result: 'failed',
        },
      });

      throw new UnauthorizedException('invalid_credentials');
    }

    try {
      this.assertNotLocked(user);
    } catch (err) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: {
          method: 'password',
          context: 'admin_login_email',
          result: 'failed',
          reason: 'account_locked',
        },
      });
      throw err;
    }

    if (!user.isActive) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: {
          method: 'password',
          context: 'admin_login_email',
          result: 'failed',
          reason: 'account_inactive',
        },
      });

      throw new UnauthorizedException('account_inactive');
    }

    const validPassword = await bcrypt.compare(data.password, user.passwordHash);

    if (!validPassword) {
      await this.recordFailedLogin(user.id);

      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: {
          method: 'password',
          context: 'admin_login_email',
          result: 'failed',
        },
      });

      throw new UnauthorizedException('invalid_credentials');
    }

    await this.resetLoginAttempts(user);

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.LOGIN_SUCCESS,
      entity: 'User',
      entityId: user.id,
      diff: {
        method: 'password',
        context: 'admin_login_email',
        result: 'success',
      },
    });

    return this.issueTokens(user.id, { phone: user.phone, email: user.email }, roles);
  }

  // LOCKOUT — ASSERT NOT LOCKED: throws before password comparison if the account is currently locked

  private assertNotLocked(user: { lockedUntil: Date | null }): void {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('account_locked');
    }
  }

  // LOCKOUT — RECORD FAILED ATTEMPT: increments failedLoginAttempts; sets lockedUntil once the threshold is hit

  private async recordFailedLogin(userId: string): Promise<void> {
    const maxAttempts = this.configService.get<number>('security.maxLoginAttempts', 5);

    const lockoutMinutes = this.configService.get<number>('security.lockoutDurationMinutes', 15);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });

    if (updated.failedLoginAttempts >= maxAttempts) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          lockedUntil: new Date(Date.now() + lockoutMinutes * 60 * 1000),
          failedLoginAttempts: 0,
        },
      });
    }
  }

  // LOCKOUT — RESET ON SUCCESS: clears any accumulated attempts/lock once the correct password is provided

  private async resetLoginAttempts(user: {
    id: string;
    failedLoginAttempts: number;
    lockedUntil: Date | null;
  }): Promise<void> {
    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }
  }

  // ISSUE TOKENS

  private async issueTokens(
    userId: string,
    // FIX: phone and email are now separate, honest fields — previously a caller with
    // no phone (an email-only admin) had to pass their email into a param literally
    // named `phone`, which then got embedded in the JWT under the `phone` claim.
    identity: { phone?: string | null; email?: string | null },
    roles: string[],
    // Optional tx client so refresh() creates the new session inside the same transaction as the old session's revocation
    tx: Pick<typeof this.prisma, 'session'> = this.prisma,
  ): Promise<TokenPair> {
    const phone = identity.phone ?? null;
    const email = identity.email ?? null;

    // FIX: both durations now go through the same bare-number normalization.
    // Previously only expiresIn special-cased bare numbers as hours; a bare
    // numeric refreshExpiresIn (e.g. "168" meaning 168 hours) fell through
    // untouched to jsonwebtoken, which treats bare numbers as SECONDS — so
    // "168" would silently expire the refresh token in under 3 minutes.
    const expiresInStr = this.normalizeDurationString(
      this.configService.get<string>('jwt.expiresIn', '24h'),
    );

    const expiresIn = expiresInStr as any;

    const accessToken = this.jwtService.sign({ sub: userId, phone, email, roles }, { expiresIn });

    // Refresh tokens use a dedicated secret/TTL so a leaked access secret can't forge them
    const refreshSecret =
      this.configService.get<string>('jwt.refreshSecret') ??
      this.configService.getOrThrow<string>('jwt.secret');

    const refreshExpiresIn = this.normalizeDurationString(
      this.configService.get<string>('jwt.refreshExpiresIn', '7d'),
    );

    const refreshToken = this.jwtService.sign(
      {
        sub: userId,
        phone,
        email,
        roles,
        type: 'refresh',
        // Unique jti so same-second tokens stay distinguishable (future reuse detection)
        jti: randomUUID(),
      },
      {
        secret: refreshSecret,
        expiresIn: refreshExpiresIn as any,
      },
    );

    await tx.session.create({
      data: {
        userId,
        // Store an HMAC hash, not the raw token, so a DB read can't be replayed
        refreshToken: this.hashOpaqueToken(refreshToken, 'refresh'),
        expiresAt: new Date(Date.now() + this.parseDurationToMs(refreshExpiresIn)),
      },
    });

    return { accessToken, refreshToken };
  }

  // HASH OPAQUE TOKEN: Deterministic HMAC-SHA256 for lookup by equality (bcrypt can't be
  // queried directly). FIX (gap #12): refresh tokens and invite tokens now use separate
  // secrets — previously both shared jwt.refreshSecret, so one HMAC key covered two
  // structurally different token types. jwt.inviteSecret is optional; falls back to
  // jwt.refreshSecret then jwt.secret if not configured, so this is non-breaking until
  // you add a dedicated INVITE_TOKEN_SECRET env var.

  private hashOpaqueToken(
    token: string,
    purpose: 'refresh' | 'invite' | 'promotion' = 'refresh',
  ): string {
    const secret =
      purpose !== 'refresh'
        ? this.configService.get<string>('jwt.inviteSecret') ??
          this.configService.get<string>('jwt.refreshSecret') ??
          this.configService.getOrThrow<string>('jwt.secret')
        : this.configService.get<string>('jwt.refreshSecret') ??
          this.configService.getOrThrow<string>('jwt.secret');

    return createHmac('sha256', secret).update(token).digest('hex');
  }

  // NORMALIZE DURATION STRING (gap #11): a bare number means hours, applied
  // consistently to every duration config value passed to jwtService.sign() or
  // parseDurationToMs() — not just jwt.expiresIn. jsonwebtoken's own bare-number
  // handling (seconds) is bypassed entirely so both TTLs behave identically.

  private normalizeDurationString(raw: string): string {
    const trimmed = raw.trim();
    return /^\d+$/.test(trimmed) ? `${trimmed}h` : trimmed;
  }

  // PARSE DURATION STRING: Converts "7d"/"24h"/"30m"/"45s" or bare seconds into ms, kept in sync with jwt.refreshExpiresIn

  private parseDurationToMs(duration: string): number {
    const match = /^(\d+)\s*(d|h|m|s)?$/.exec(duration.trim());

    if (!match) {
      throw new BadRequestException('invalid_duration_config');
    }

    const value = Number(match[1]);
    const unit = match[2] ?? 's';

    const unitMs: Record<string, number> = {
      d: 24 * 60 * 60 * 1000,
      h: 60 * 60 * 1000,
      m: 60 * 1000,
      s: 1000,
    };

    return value * unitMs[unit];
  }

  // ISSUE + SEND OTP (shared helper): Invalidates prior unused OTP of this purpose, creates a
  // new one, sends via the requested channel (SMS or email); cooldown reuses existing
  // verificationId instead of throwing. `contact` is a phone number for channel=sms, or an
  // email address for channel=email.

  private async issueAndSendOtp(
    userId: string,
    contact: string,
    purpose: UserOtpPurposeEnum,
    channel: OtpChannelEnum = OtpChannelEnum.sms,
  ): Promise<{ verificationId: string }> {
    const cooldownSeconds = this.configService.get<number>('otp.resendCooldownSeconds', 60);

    const otpExpiresInMinutes = this.configService.get<number>('otp.expiresInMinutes', 10);

    const otp = this.generateOtp();
    const otpHash = await bcrypt.hash(otp, 12);

    // Cooldown check + create/invalidate wrapped in one transaction to narrow the race window
    const result = await this.prisma.$transaction(async (tx) => {
      // FIX (gap #5): scoped to channel too, not just purpose. A user with both
      // a phone and an email (e.g. a promoted admin) hitting SMS forgot-password
      // and email forgot-password within the same cooldown window are now
      // independent — neither silently swallows the other's OTP send.
      const latestOtp = await tx.userOtp.findFirst({
        where: { userId, purpose, channel },
        orderBy: { createdAt: 'desc' },
      });

      const cooldownActive =
        !!latestOtp &&
        !latestOtp.usedAt &&
        Date.now() - latestOtp.createdAt.getTime() < cooldownSeconds * 1000;

      if (cooldownActive) {
        // Reuse existing OTP/verificationId; nothing regenerated, no message sent
        return { reused: true as const, verificationId: latestOtp.id };
      }

      await tx.userOtp.updateMany({
        where: { userId, purpose, channel, usedAt: null },
        data: { usedAt: new Date() },
      });

      const created = await tx.userOtp.create({
        data: {
          userId,
          otpHash,
          expiresAt: new Date(Date.now() + otpExpiresInMinutes * 60 * 1000),
          purpose,
          channel,
        },
      });

      return { reused: false as const, verificationId: created.id };
    });

    if (result.reused) {
      // Cooldown active: no message, no dev log
      return { verificationId: result.verificationId };
    }

    if (channel === OtpChannelEnum.email) {
      try {
        await sendEmail(
          contact,
          renderOtpEmailSubject(),
          renderOtpEmailHtml({ otp, expiresInMinutes: otpExpiresInMinutes }),
        );
      } catch (error) {
        console.error(`[EHTE EMAIL] Failed to send OTP (${purpose}) to ${contact}`, error);
      }
    } else {
      const smsMessage = renderOtpSms({ otp, expiresInMinutes: otpExpiresInMinutes });

      try {
        await sendSms(contact, smsMessage);
      } catch (error) {
        console.error(`[EHTE SMS] Failed to send OTP (${purpose}) to ${contact}`, error);
      }
    }

    // DEV ONLY
    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] OTP (${purpose}, ${channel}) for ${contact}: ${otp}`);
    }

    return { verificationId: result.verificationId };
  }

  // PHONE NORMALIZATION (wrapper): Wraps normalizePhoneNumber() so malformed input yields a clean 400, not a raw 500

  private normalizePhoneOrThrow(phone: string): string {
    try {
      return normalizePhoneNumber(phone);
    } catch {
      throw new BadRequestException('invalid_phone_number');
    }
  }

  // GENERATE OTP: Uses crypto.randomInt (CSPRNG), never Math.random()

  private generateOtp(): string {
    return randomInt(100000, 1000000).toString();
  }
}
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { UserOtpPurposeEnum } from '@prisma/client';

import * as bcrypt from 'bcrypt';
import { randomInt, createHmac, randomUUID } from 'crypto';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { normalizePhoneNumber } from 'src/common/utils/phone.util';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { sendSms } from 'src/common/sms/afro-message.service';

import { renderOtpSms } from 'src/common/sms/templates/sms-otp.template';

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
  AdminRegisterDto,
  AdminVerifyDto,
  AdminLoginDto,
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

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

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
        existingUser.phone,
        UserOtpPurposeEnum.phone_verification,
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
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: data.name,
          phone,
          password: hashedPassword,
          userRoles: {
            create: { roleId: userRole.id },
          },
        },
      });

      const otp = this.generateOtp();
      const otpHash = await bcrypt.hash(otp, 12);

      const otpExpiresInMinutes = this.configService.get<number>(
        'otp.expiresInMinutes',
        10,
      );

      const userOtp = await tx.userOtp.create({
        data: {
          userId: user.id,
          otpHash,
          expiresAt: new Date(Date.now() + otpExpiresInMinutes * 60 * 1000),
          purpose: UserOtpPurposeEnum.phone_verification,
        },
      });

      return {
        verificationId: userOtp.id,
        otp,
        phone: user.phone,
        userId: user.id,
      };
    });

    // Send signup OTP SMS
    const smsMessage = renderOtpSms({
      otp: result.otp,
      expiresInMinutes: this.configService.get<number>(
        'otp.expiresInMinutes',
        10,
      ),
    });

    try {
      await sendSms(result.phone, smsMessage);
    } catch (error) {
      // Log failure only; user/OTP already persisted, client can use resendSignupOtp()
      console.error(
        `[EHTE SMS] Failed to send signup OTP to ${result.phone}`,
        error,
      );
    }

    // DEV ONLY: remove before production
    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] Signup OTP for ${result.phone}: ${result.otp}`);
    }

    // Audit user creation (never include password/OTP/token data)
    this.eventEmitter.emit(AuditEventEnum.USER_CREATED, {
      userId: result.userId,
      actorType: resolveActorType([userRole.name]),
      action: AuditEventEnum.USER_CREATED,
      entity: 'User',
      entityId: result.userId,
      diff: { result: 'success' },
    } as AuditEventPayload);

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
      this.eventEmitter.emit(AuditEventEnum.SECURITY_ALERT, {
        userId: otpRecord.user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.SECURITY_ALERT,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        diff: {
          reason: 'too_many_otp_attempts',
          purpose: 'phone_verification',
        },
      } as AuditEventPayload);

      throw new BadRequestException('too_many_otp_attempts');
    }

    const validOtp = await bcrypt.compare(data.otp, otpRecord.otpHash);

    if (!validOtp) {
      const updatedOtp = await this.prisma.userOtp.update({
        where: { id: otpRecord.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });

      // Alert once failed attempts hit the max
      if (updatedOtp.attempts >= 5) {
        this.eventEmitter.emit(AuditEventEnum.SECURITY_ALERT, {
          userId: otpRecord.user.id,
          actorType: resolveActorType(roles),
          action: AuditEventEnum.SECURITY_ALERT,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          diff: {
            reason: 'too_many_otp_attempts',
            purpose: 'phone_verification',
          },
        } as AuditEventPayload);
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
    this.eventEmitter.emit(AuditEventEnum.OTP_VERIFIED, {
      userId: otpRecord.user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.OTP_VERIFIED,
      entity: 'UserOtp',
      entityId: otpRecord.id,
      diff: { purpose: 'phone_verification', result: 'success' },
    } as AuditEventPayload);

    return this.issueTokens(otpRecord.user.id, otpRecord.user.phone, roles);
  }

  // RESEND SIGNUP OTP

  async resendSignupOtp(
    verificationId: string,
  ): Promise<{ verificationId: string }> {
    const oldOtp = await this.prisma.userOtp.findUnique({
      where: { id: verificationId },
      include: { user: true },
    });

    if (
      !oldOtp ||
      oldOtp.purpose !== UserOtpPurposeEnum.phone_verification
    ) {
      throw new BadRequestException('invalid_verification');
    }

    if (oldOtp.usedAt) {
      throw new BadRequestException('phone_already_verified');
    }

    const { verificationId: newVerificationId } = await this.issueAndSendOtp(
      oldOtp.userId,
      oldOtp.user.phone,
      UserOtpPurposeEnum.phone_verification,
    );

    return { verificationId: newVerificationId };
  }

  // LOGIN: Requires User.isPhoneVerified; account lockout enforced via failedLoginAttempts/lockedUntil

  async login(data: LoginDto): Promise<LoginResult> {
    const phone = this.normalizePhoneOrThrow(data.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: {
        userRoles: { include: { role: true } },
      },
    });

    if (!user || !user.password) {
      this.eventEmitter.emit(AuditEventEnum.LOGIN_FAILED, {
        userId: user?.id ?? null,
        actorType: resolveActorType(
          user ? user.userRoles.map((userRole) => userRole.role.name) : [],
        ),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user?.id ?? null,
        diff: { method: 'password', result: 'failed' },
      } as AuditEventPayload);

      throw new UnauthorizedException('invalid_credentials');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);

    // FIX: reject before spending a bcrypt compare if the account is currently locked
    try {
      this.assertNotLocked(user);
    } catch (err) {
      this.eventEmitter.emit(AuditEventEnum.LOGIN_FAILED, {
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
      } as AuditEventPayload);
      throw err;
    }

    // Check password before isActive/verified gates to avoid leaking account state
    const validPassword = await bcrypt.compare(data.password, user.password);

    if (!validPassword) {
      // FIX: count the failure, possibly locking the account
      await this.recordFailedLogin(user.id);

      this.eventEmitter.emit(AuditEventEnum.LOGIN_FAILED, {
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: { method: 'password', result: 'failed' },
      } as AuditEventPayload);

      throw new UnauthorizedException('invalid_credentials');
    }

    // FIX: correct password clears any prior failure count/lock
    await this.resetLoginAttempts(user);

    if (!user.isActive) {
      this.eventEmitter.emit(AuditEventEnum.LOGIN_FAILED, {
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
      } as AuditEventPayload);

      throw new UnauthorizedException('account_inactive');
    }

    if (!user.isPhoneVerified) {
      this.eventEmitter.emit(AuditEventEnum.LOGIN_FAILED, {
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: {
          method: 'password',
          result: 'failed',
          reason: 'phone_not_verified',
        },
      } as AuditEventPayload);

      // Unverified: send fresh OTP and route client to verification instead of dead-ending
      const { verificationId } = await this.issueAndSendOtp(
        user.id,
        user.phone,
        UserOtpPurposeEnum.phone_verification,
      );

      return {
        requiresVerification: true,
        verificationId,
        message: 'phone_not_verified_otp_sent',
      };
    }

    this.eventEmitter.emit(AuditEventEnum.LOGIN_SUCCESS, {
      userId: user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.LOGIN_SUCCESS,
      entity: 'User',
      entityId: user.id,
      diff: { method: 'password', result: 'success' },
    } as AuditEventPayload);

    return this.issueTokens(user.id, user.phone, roles);
  }

  // FORGOT PASSWORD: Unverified accounts get a phone_verification OTP instead of password_reset; only "no account" is masked

  async forgotPassword(
    data: ForgotPasswordDto,
  ): Promise<ForgotPasswordResult> {
    const phone = this.normalizePhoneOrThrow(data.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true, phone: true, isPhoneVerified: true },
    });

    // Don't reveal whether the phone exists
    if (!user) {
      return { verificationId: '' };
    }

    if (!user.isPhoneVerified) {
      const { verificationId } = await this.issueAndSendOtp(
        user.id,
        user.phone,
        UserOtpPurposeEnum.phone_verification,
      );

      return { verificationId, purpose: 'phone_verification' };
    }

    const { verificationId } = await this.issueAndSendOtp(
      user.id,
      user.phone,
      UserOtpPurposeEnum.password_reset,
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
      this.eventEmitter.emit(AuditEventEnum.SECURITY_ALERT, {
        userId: otpRecord.user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.SECURITY_ALERT,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        diff: {
          reason: 'too_many_otp_attempts',
          purpose: 'password_reset',
        },
      } as AuditEventPayload);

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
        this.eventEmitter.emit(AuditEventEnum.SECURITY_ALERT, {
          userId: otpRecord.user.id,
          actorType: resolveActorType(roles),
          action: AuditEventEnum.SECURITY_ALERT,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          diff: {
            reason: 'too_many_otp_attempts',
            purpose: 'password_reset',
          },
        } as AuditEventPayload);
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
        data: { password: hashedPassword },
      });

      // Invalidate every existing session
      await tx.session.deleteMany({
        where: { userId: otpRecord.user.id },
      });
    });

    // Audit after successful transaction
    this.eventEmitter.emit(AuditEventEnum.PASSWORD_RESET, {
      userId: otpRecord.user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.PASSWORD_RESET,
      entity: 'User',
      entityId: otpRecord.user.id,
      diff: { method: 'otp', result: 'success' },
    } as AuditEventPayload);

    // Notify after successful transaction
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_RESET, {
      userId: otpRecord.user.id,
    } as PasswordResetEvent);

    return { message: 'password_reset_successful' };
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

    const refreshTokenHash = this.hashRefreshToken(data.refreshToken);

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

      this.eventEmitter.emit(AuditEventEnum.SECURITY_ALERT, {
        userId: payload.sub,
        actorType: resolveActorType(payload.roles ?? []),
        action: AuditEventEnum.SECURITY_ALERT,
        entity: 'Session',
        entityId: session.id,
        diff: { reason: 'refresh_token_reuse_detected' },
      } as AuditEventPayload);

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

      return this.issueTokens(user.id, user.phone, roles, tx);
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
    const { userRoles, ...userData } = user;

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

    if (!dbUser.password) {
      throw new BadRequestException('password_not_set');
    }

    const validPassword = await bcrypt.compare(
      data.currentPassword,
      dbUser.password,
    );

    if (!validPassword) {
      throw new BadRequestException('wrong_current_password');
    }

    const hashedPassword = await bcrypt.hash(data.newPassword, 10);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword },
      }),

      // Force re-login after password change
      this.prisma.session.deleteMany({
        where: { userId: user.id },
      }),
    ]);

    const roles = dbUser.userRoles.map((userRole) => userRole.role.name);

    // Audit after successful transaction
    this.eventEmitter.emit(AuditEventEnum.PASSWORD_CHANGED, {
      userId: user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.PASSWORD_CHANGED,
      entity: 'User',
      entityId: user.id,
      diff: { result: 'success' },
    } as AuditEventPayload);

    // Notify after successful transaction
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_CHANGED, {
      userId: user.id,
    } as PasswordChangedEvent);

    return { message: 'password_changed' };
  }

  // LOGOUT

  async logout(user: CurrentUserDto, req: any): Promise<{ message: string }> {
    const refreshToken =
      req?.body?.refreshToken || req?.headers?.['x-refresh-token'];

    if (refreshToken) {
      await this.prisma.session.deleteMany({
        where: {
          userId: user.id,
          refreshToken: this.hashRefreshToken(refreshToken),
        },
      });
    } else {
      await this.prisma.session.deleteMany({
        where: { userId: user.id },
      });
    }

    // Roles come straight from JWT payload via CurrentUserDto
    const roles = user.roles ?? [];

    this.eventEmitter.emit(AuditEventEnum.LOGOUT, {
      userId: user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.LOGOUT,
      entity: 'User',
      entityId: user.id,
      diff: { result: 'success' },
    } as AuditEventPayload);

    return { message: 'logout_successful' };
  }

  // ADMIN — REGISTER: Admin/super-admin only; creates a pending admin (inactive/unverified) until adminVerify()

  async adminRegister(
    creator: CurrentUserDto,
    data: AdminRegisterDto,
  ): Promise<{ adminId: string; verificationId: string }> {
    // Defense-in-depth: don't rely solely on the controller's @Roles guard
    const creatorRoles = creator.roles ?? [];

    if (
      !creatorRoles.some((role) =>
        [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN].includes(role as RolesEnum),
      )
    ) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const phone = this.normalizePhoneOrThrow(data.phone);

    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
    });

    if (existingUser) {
      throw new BadRequestException('phone_already_registered');
    }

    // Creator can provision ADMIN only, not SUPER_ADMIN
    const adminRole = await this.prisma.role.findUnique({
      where: { name: RolesEnum.ADMIN },
    });

    if (!adminRole) {
      throw new BadRequestException('admin_role_not_configured');
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const result = await this.prisma.$transaction(async (tx) => {
      const admin = await tx.user.create({
        data: {
          name: data.name,
          phone,
          password: hashedPassword,
          isPhoneVerified: false,
          isActive: false,
          userRoles: {
            create: { roleId: adminRole.id },
          },
        },
      });

      const otp = this.generateOtp();
      const otpHash = await bcrypt.hash(otp, 12);

      const otpExpiresInMinutes = this.configService.get<number>(
        'otp.expiresInMinutes',
        10,
      );

      const adminOtp = await tx.userOtp.create({
        data: {
          userId: admin.id,
          otpHash,
          expiresAt: new Date(Date.now() + otpExpiresInMinutes * 60 * 1000),
          purpose: UserOtpPurposeEnum.admin_verification,
        },
      });

      return {
        adminId: admin.id,
        verificationId: adminOtp.id,
        otp,
        phone: admin.phone,
      };
    });

    const smsMessage = renderOtpSms({
      otp: result.otp,
      expiresInMinutes: this.configService.get<number>(
        'otp.expiresInMinutes',
        10,
      ),
    });

    try {
      await sendSms(result.phone, smsMessage);
    } catch (error) {
      console.error(
        `[EHTE SMS] Failed to send admin registration OTP to ${result.phone}`,
        error,
      );
    }

    // DEV ONLY
    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(
        `[EHTE DEV] Admin registration OTP for ${result.phone}: ${result.otp}`,
      );
    }

    this.eventEmitter.emit(AuditEventEnum.USER_CREATED, {
      userId: result.adminId,
      actorType: resolveActorType([RolesEnum.ADMIN]),
      action: AuditEventEnum.USER_CREATED,
      entity: 'User',
      entityId: result.adminId,
      diff: {
        result: 'success',
        role: RolesEnum.ADMIN,
        createdBy: creator.id,
      },
    } as AuditEventPayload);

    return {
      adminId: result.adminId,
      verificationId: result.verificationId,
    };
  }

  // ADMIN — VERIFY REGISTRATION: Looks up pending admin by adminId, verifies against that admin's own stored OTP

  async adminVerify(
    verifier: CurrentUserDto,
    adminId: string,
    data: AdminVerifyDto,
  ): Promise<{ message: string }> {
    // Defense-in-depth: don't rely solely on the controller's @Roles guard
    const verifierRoles = verifier.roles ?? [];

    if (
      !verifierRoles.some((role) =>
        [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN].includes(role as RolesEnum),
      )
    ) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      include: {
        userRoles: { include: { role: true } },
      },
    });

    const roles = admin?.userRoles.map((userRole) => userRole.role.name) ?? [];

    if (
      !admin ||
      !roles.some((role) =>
        [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN].includes(role as RolesEnum),
      )
    ) {
      throw new NotFoundException('admin_not_found');
    }

    if (admin.isActive) {
      throw new BadRequestException('admin_already_verified');
    }

    // Match against the exact verificationId issued by adminRegister()
    const otpRecord = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
    });

    if (
      !otpRecord ||
      otpRecord.userId !== admin.id ||
      otpRecord.purpose !== UserOtpPurposeEnum.admin_verification ||
      otpRecord.usedAt ||
      otpRecord.expiresAt < new Date()
    ) {
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.attempts >= 5) {
      this.eventEmitter.emit(AuditEventEnum.SECURITY_ALERT, {
        userId: admin.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.SECURITY_ALERT,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        diff: {
          reason: 'too_many_otp_attempts',
          purpose: 'admin_verification',
          verifiedBy: verifier.id,
        },
      } as AuditEventPayload);

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
        this.eventEmitter.emit(AuditEventEnum.SECURITY_ALERT, {
          userId: admin.id,
          actorType: resolveActorType(roles),
          action: AuditEventEnum.SECURITY_ALERT,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          diff: {
            reason: 'too_many_otp_attempts',
            purpose: 'admin_verification',
            verifiedBy: verifier.id,
          },
        } as AuditEventPayload);
      }

      throw new BadRequestException('invalid_or_expired_otp');
    }

    // Same atomic-claim pattern as verifySignupOtp()
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.userOtp.updateMany({
        where: {
          id: otpRecord.id,
          userId: admin.id,
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
        where: { id: admin.id },
        data: { isPhoneVerified: true, isActive: true },
      });
    });

    this.eventEmitter.emit(AuditEventEnum.OTP_VERIFIED, {
      userId: admin.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.OTP_VERIFIED,
      entity: 'UserOtp',
      entityId: otpRecord.id,
      diff: {
        purpose: 'admin_verification',
        result: 'success',
        verifiedBy: verifier.id,
      },
    } as AuditEventPayload);

    return { message: 'admin_verified' };
  }

  // ADMIN — LOGIN: Restricted to ADMIN/SUPER_ADMIN; checks isActive + lockout, not isPhoneVerified (seeded super-admin skips OTP)

  async adminLogin(data: AdminLoginDto): Promise<TokenPair> {
    const phone = this.normalizePhoneOrThrow(data.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: {
        userRoles: { include: { role: true } },
      },
    });

    const roles = user?.userRoles.map((userRole) => userRole.role.name) ?? [];

    const isAdmin = roles.some((role) =>
      [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN].includes(role as RolesEnum),
    );

    if (!user || !user.password || !isAdmin) {
      this.eventEmitter.emit(AuditEventEnum.LOGIN_FAILED, {
        userId: user?.id ?? null,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user?.id ?? null,
        diff: {
          method: 'password',
          context: 'admin_login',
          result: 'failed',
        },
      } as AuditEventPayload);

      throw new UnauthorizedException('invalid_credentials');
    }

    // FIX: lockout check, before isActive/password
    try {
      this.assertNotLocked(user);
    } catch (err) {
      this.eventEmitter.emit(AuditEventEnum.LOGIN_FAILED, {
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: {
          method: 'password',
          context: 'admin_login',
          result: 'failed',
          reason: 'account_locked',
        },
      } as AuditEventPayload);
      throw err;
    }

    if (!user.isActive) {
      this.eventEmitter.emit(AuditEventEnum.LOGIN_FAILED, {
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: {
          method: 'password',
          context: 'admin_login',
          result: 'failed',
          reason: 'account_inactive',
        },
      } as AuditEventPayload);

      // Covers deactivated and not-yet-verified admins; activation only via adminVerify()
      throw new UnauthorizedException('account_inactive');
    }

    const validPassword = await bcrypt.compare(data.password, user.password);

    if (!validPassword) {
      // FIX: count the failure, possibly locking the account
      await this.recordFailedLogin(user.id);

      this.eventEmitter.emit(AuditEventEnum.LOGIN_FAILED, {
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.LOGIN_FAILED,
        entity: 'User',
        entityId: user.id,
        diff: {
          method: 'password',
          context: 'admin_login',
          result: 'failed',
        },
      } as AuditEventPayload);

      throw new UnauthorizedException('invalid_credentials');
    }

    // FIX: correct password clears any prior failure count/lock
    await this.resetLoginAttempts(user);

    this.eventEmitter.emit(AuditEventEnum.LOGIN_SUCCESS, {
      userId: user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.LOGIN_SUCCESS,
      entity: 'User',
      entityId: user.id,
      diff: {
        method: 'password',
        context: 'admin_login',
        result: 'success',
      },
    } as AuditEventPayload);

    return this.issueTokens(user.id, user.phone, roles);
  }

  // LOCKOUT — ASSERT NOT LOCKED: throws before password comparison if the account is currently locked

  private assertNotLocked(user: { lockedUntil: Date | null }): void {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('account_locked');
    }
  }

  // LOCKOUT — RECORD FAILED ATTEMPT: increments failedLoginAttempts; sets lockedUntil once the threshold is hit

  private async recordFailedLogin(userId: string): Promise<void> {
    const maxAttempts = this.configService.get<number>(
      'security.maxLoginAttempts',
      5,
    );

    const lockoutMinutes = this.configService.get<number>(
      'security.lockoutDurationMinutes',
      15,
    );

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
    phone: string,
    roles: string[],
    // Optional tx client so refresh() creates the new session inside the same transaction as the old session's revocation
    tx: Pick<typeof this.prisma, 'session'> = this.prisma,
  ): Promise<TokenPair> {
    let expiresInStr = this.configService.get<string>('jwt.expiresIn', '24h');

    // Support bare numbers like "24" -> "24h"
    if (/^\d+$/.test(expiresInStr)) {
      expiresInStr = `${expiresInStr}h`;
    }

    const expiresIn = expiresInStr as any;

    const accessToken = this.jwtService.sign(
      { sub: userId, phone, roles },
      { expiresIn },
    );

    // Refresh tokens use a dedicated secret/TTL so a leaked access secret can't forge them
    const refreshSecret =
      this.configService.get<string>('jwt.refreshSecret') ??
      this.configService.getOrThrow<string>('jwt.secret');

    const refreshExpiresIn = this.configService.get<string>(
      'jwt.refreshExpiresIn',
      '7d',
    );

    const refreshToken = this.jwtService.sign(
      {
        sub: userId,
        phone,
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
        refreshToken: this.hashRefreshToken(refreshToken),
        expiresAt: new Date(
          Date.now() + this.parseDurationToMs(refreshExpiresIn),
        ),
      },
    });

    return { accessToken, refreshToken };
  }

  // HASH REFRESH TOKEN: Deterministic HMAC-SHA256 for lookup by equality (bcrypt can't be queried directly)

  private hashRefreshToken(token: string): string {
    const refreshSecret =
      this.configService.get<string>('jwt.refreshSecret') ??
      this.configService.getOrThrow<string>('jwt.secret');

    return createHmac('sha256', refreshSecret).update(token).digest('hex');
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

  // ISSUE + SEND OTP (shared helper): Invalidates prior unused OTP of this purpose, creates a new one, sends SMS; cooldown reuses existing verificationId instead of throwing

  private async issueAndSendOtp(
    userId: string,
    phone: string,
    purpose: UserOtpPurposeEnum,
  ): Promise<{ verificationId: string }> {
    const cooldownSeconds = this.configService.get<number>(
      'otp.resendCooldownSeconds',
      60,
    );

    const otpExpiresInMinutes = this.configService.get<number>(
      'otp.expiresInMinutes',
      10,
    );

    const otp = this.generateOtp();
    const otpHash = await bcrypt.hash(otp, 12);

    // Cooldown check + create/invalidate wrapped in one transaction to narrow the race window
    const result = await this.prisma.$transaction(async (tx) => {
      const latestOtp = await tx.userOtp.findFirst({
        where: { userId, purpose },
        orderBy: { createdAt: 'desc' },
      });

      const cooldownActive =
        !!latestOtp &&
        !latestOtp.usedAt &&
        Date.now() - latestOtp.createdAt.getTime() < cooldownSeconds * 1000;

      if (cooldownActive) {
        // Reuse existing OTP/verificationId; nothing regenerated, no SMS sent
        return { reused: true as const, verificationId: latestOtp!.id };
      }

      await tx.userOtp.updateMany({
        where: { userId, purpose, usedAt: null },
        data: { usedAt: new Date() },
      });

      const created = await tx.userOtp.create({
        data: {
          userId,
          otpHash,
          expiresAt: new Date(Date.now() + otpExpiresInMinutes * 60 * 1000),
          purpose,
        },
      });

      return { reused: false as const, verificationId: created.id };
    });

    if (result.reused) {
      // Cooldown active: no SMS, no dev log
      return { verificationId: result.verificationId };
    }

    const smsMessage = renderOtpSms({ otp, expiresInMinutes: otpExpiresInMinutes });

    try {
      await sendSms(phone, smsMessage);
    } catch (error) {
      console.error(
        `[EHTE SMS] Failed to send OTP (${purpose}) to ${phone}`,
        error,
      );
    }

    // DEV ONLY
    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] OTP (${purpose}) for ${phone}: ${otp}`);
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
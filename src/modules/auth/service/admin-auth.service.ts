import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { UserOtpPurposeEnum, OtpChannelEnum, Prisma } from '@prisma/client';

import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { normalizePhoneNumber } from 'src/common/utils/phone.util';
import { normalizeEmail } from 'src/common/utils/email.util';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { OtpUtil } from 'src/common/utils/otp.util';
import { LockoutUtil } from 'src/common/utils/lockout.util';
import { TokenUtil } from 'src/common/utils/token.util';

import { sendEmail } from 'src/services/email/email.service';
import {
  renderOtpEmailSubject,
  renderOtpEmailHtml,
} from 'src/services/email/templates/otp-email.template';

import {
  renderAdminRegistrationEmailSubject,
  renderAdminRegistrationEmailHtml,
} from 'src/services/email/templates/admin-registration-email.template';

import {
  renderPromotionEmailSubject,
  renderPromotionEmailHtml,
} from 'src/services/email/templates/promotion-email.template';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import {
  ResetPasswordDto,
  AdminRegisterDto,
  AdminRegisterResendDto,
  AdminCompleteRegistrationDto,
  AdminLoginEmailDto,
  AdminForgotPasswordDto,
  AdminCancelRegistrationDto,
  AdminChangeEmailDto,
  AdminChangeEmailVerifyDto,
  AdminChangePasswordInitiateDto,
  PromoteUserDto,
  PromoteUserResendDto,
  PromoteVerifyDto,
} from '../dto/admin-auth.dto';

type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

const REGISTRATION_TOKEN_EXPIRES_MINUTES = 60 * 24; // 24h to complete registration
const PROMOTION_TOKEN_EXPIRES_MINUTES = 60 * 24; // 24h to click the promotion email link
const EMAIL_CHANGE_TOKEN_EXPIRES_MINUTES = 60; // 1h to click the email-change verification link

const ADMIN_ROLES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

// Shape shared by every userRoles->role->rolePermissions->permission Prisma query result.
type UserRoleWithPermissions = {
  role: {
    name: string;
    rolePermissions: { permission: { name: string } }[];
  };
};

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
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

  // Shared "is this role set an admin?" check — duplicated from AuthService by design
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

  // ADMIN — REGISTER: leaves the account inactive/"REGISTERING" until password is set.

  async adminRegister(
    creator: CurrentUserDto,
    data: AdminRegisterDto,
  ): Promise<{ adminId: string; message: string }> {
    // Restricted to SUPER_ADMIN
    const creatorRoles = creator.roles ?? [];

    if (!creatorRoles.includes(RolesEnum.SUPER_ADMIN)) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const email = this.normalizeEmailOrThrow(data.email);

    // Defense-in-depth check against inviting with a non-admin role (permanently locked out).
    const invitableRoles = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];
    if (data.roles.some((role) => !invitableRoles.includes(role))) {
      throw new BadRequestException('only_admin_roles_may_be_registered');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new BadRequestException('email_already_registered');
    }

    // Resolve every requested role up front so a typo'd role fails before any writes.
    const roleRecords = await this.prisma.role.findMany({
      where: { name: { in: data.roles } },
    });

    if (roleRecords.length !== new Set(data.roles).size) {
      throw new BadRequestException('one_or_more_roles_not_configured');
    }

    const rawRegistrationToken = randomBytes(32).toString('hex');
    const inviteTokenHash = this.tokenUtil.hashOpaqueToken(rawRegistrationToken, 'registration');
    const inviteTokenExpiresAt = new Date(
      Date.now() + REGISTRATION_TOKEN_EXPIRES_MINUTES * 60 * 1000,
    );

    let admin: { id: string };

    try {
      admin = await this.prisma.user.create({
        data: {
          email,
          name: data.name,
          // No phone, no password — this is the "REGISTERING" state
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
      // Closes the race between the existingUser check above and this write.
      if (this.isUniqueConstraintError(error)) {
        throw new BadRequestException('email_already_registered');
      }
      throw error;
    }

    // Uses app.adminUrl (falls back to app.url) — registration links must land on the admin site.
    const appUrl = this.configService.get<string>('app.adminUrl', 'https://ehte.org');
    const registrationLink = `${appUrl}/admin/register?token=${rawRegistrationToken}`;

    const registrationExpiresInHours = Math.round(REGISTRATION_TOKEN_EXPIRES_MINUTES / 60);

    try {
      await sendEmail(
        email,
        renderAdminRegistrationEmailSubject(),
        renderAdminRegistrationEmailHtml({
          registrationLink,
          expiresInHours: registrationExpiresInHours,
        }),
      );
    } catch (error) {
      console.error(`[EHTE EMAIL] Failed to send admin registration email to ${email}`, error);
    }

    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] Admin registration link for ${email}: ${registrationLink}`);
    }

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(data.roles),
      action: AuditEventEnum.ADMIN_REGISTERED,
      entity: 'User',
      entityId: admin.id,
      diff: {
        result: 'success',
        roles: data.roles,
        status: 'registered',
        registeredBy: creator.id,
      },
    });

    return { adminId: admin.id, message: 'admin_registered' };
  }

  // ADMIN — RESEND REGISTRATION: only valid while still "REGISTERING" (no password set).

  async adminRegisterResend(
    creator: CurrentUserDto,
    data: AdminRegisterResendDto,
  ): Promise<{ message: string }> {
    const creatorRoles = creator.roles ?? [];

    if (!creatorRoles.includes(RolesEnum.SUPER_ADMIN)) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const email = this.normalizeEmailOrThrow(data.email);

    const admin = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!admin) {
      throw new NotFoundException('registration_not_found');
    }

    // Once a password has been set (or activated), the registration flow is complete.
    if (admin.passwordHash || admin.isActive) {
      throw new BadRequestException('registration_already_completed');
    }

    const rawRegistrationToken = randomBytes(32).toString('hex');
    const inviteTokenHash = this.tokenUtil.hashOpaqueToken(rawRegistrationToken, 'registration');
    const inviteTokenExpiresAt = new Date(
      Date.now() + REGISTRATION_TOKEN_EXPIRES_MINUTES * 60 * 1000,
    );

    // Overwriting the token invalidates any previous unused registration link.
    await this.prisma.user.update({
      where: { id: admin.id },
      data: { inviteTokenHash, inviteTokenExpiresAt },
    });

    const appUrl = this.configService.get<string>('app.adminUrl', 'https://ehte.org');
    const registrationLink = `${appUrl}/admin/register?token=${rawRegistrationToken}`;
    const registrationExpiresInHours = Math.round(REGISTRATION_TOKEN_EXPIRES_MINUTES / 60);

    try {
      await sendEmail(
        email,
        renderAdminRegistrationEmailSubject(),
        renderAdminRegistrationEmailHtml({
          registrationLink,
          expiresInHours: registrationExpiresInHours,
        }),
      );
    } catch (error) {
      console.error(`[EHTE EMAIL] Failed to resend admin registration email to ${email}`, error);
    }

    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] Resent admin registration link for ${email}: ${registrationLink}`);
    }

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType([]),
      action: AuditEventEnum.ADMIN_REGISTRATION_RESENT,
      entity: 'User',
      entityId: admin.id,
      diff: {
        result: 'success',
        context: 'registration_resent',
        resentBy: creator.id,
      },
    });

    return { message: 'registration_resent' };
  }

  // ADMIN — COMPLETE REGISTRATION: token proves inbox control, sets password + activates.

  async adminCompleteRegistration(data: AdminCompleteRegistrationDto): Promise<TokenPair> {
    const inviteTokenHash = this.tokenUtil.hashOpaqueToken(data.registrationToken, 'registration');

    const admin = await this.prisma.user.findUnique({
      where: { inviteTokenHash },
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

    if (!admin || !admin.inviteTokenExpiresAt || admin.inviteTokenExpiresAt < new Date()) {
      throw new BadRequestException('invalid_or_expired_registration_token');
    }

    if (admin.passwordHash) {
      // Registration token already used to set a password once
      throw new BadRequestException('registration_token_already_used');
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);
    const roles = admin.userRoles.map((userRole) => userRole.role.name);
    const permissions = this.derivePermissions(admin.userRoles);

    await this.prisma.user.update({
      where: { id: admin.id },
      data: {
        passwordHash: hashedPassword,
        // Possessing the token proved control of the registering inbox — activate now
        isEmailVerified: true,
        isActive: true,
        // Single-use: clear the registration token now that it's been consumed
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
      diff: { result: 'success', context: 'admin_registration_completed' },
    });

    if (!admin.email) {
      // Shouldn't happen for a registration-created admin, but guard anyway
      throw new BadRequestException('admin_email_missing');
    }

    // Admin has no phone at this point — issue tokens with email set, phone left null.
    return this.tokenUtil.issueTokens(admin.id, { email: admin.email }, roles, permissions);
  }

  // ADMIN — CANCEL PENDING REGISTRATION: only valid pre-activation; deletes the row outright.

  async adminCancelRegistration(
    actor: CurrentUserDto,
    data: AdminCancelRegistrationDto,
  ): Promise<{ message: string }> {
    const actorRoles = actor.roles ?? [];

    if (!actorRoles.includes(RolesEnum.SUPER_ADMIN)) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const email = this.normalizeEmailOrThrow(data.email);

    const admin = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!admin) {
      throw new NotFoundException('registration_not_found');
    }

    if (admin.passwordHash || admin.isActive) {
      // Already completed — use UserController's deactivate/revoke-role endpoints instead.
      throw new BadRequestException('registration_already_completed');
    }

    await this.prisma.user.delete({
      where: { id: admin.id },
    });

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actorRoles),
      action: AuditEventEnum.ADMIN_REGISTRATION_CANCELLED,
      entity: 'User',
      entityId: admin.id,
      diff: {
        result: 'success',
        context: 'registration_cancelled',
        cancelledEmail: email,
        cancelledBy: actor.id,
      },
    });

    return { message: 'registration_cancelled' };
  }

  // ADMIN — PROMOTE EXISTING USER (STEP 1): attaches an email; ADMIN role granted at verify.

  async promoteUserInitiate(
    actor: CurrentUserDto,
    data: PromoteUserDto,
  ): Promise<{ message: string }> {
    const actorRoles = actor.roles ?? [];

    if (!actorRoles.includes(RolesEnum.SUPER_ADMIN)) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const phone = this.normalizePhoneOrThrow(data.phone);
    const email = this.normalizeEmailOrThrow(data.email);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    // Requires the existing account to be active and phone-verified before promotion.
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

    // Attach the email now (unverified); ADMIN role granted only after verify.
    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { email, isEmailVerified: false },
      });
    } catch (error) {
      // Closes the race between the emailInUse check above and this write.
      if (this.isUniqueConstraintError(error)) {
        throw new BadRequestException('email_already_registered');
      }
      throw error;
    }

    // The clickable link is the proof of inbox ownership, so a high-entropy raw token is used.
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.tokenUtil.hashOpaqueToken(rawToken, 'promotion');
    const expiresAt = new Date(Date.now() + PROMOTION_TOKEN_EXPIRES_MINUTES * 60 * 1000);

    // Invalidate any previous unused promotion link for this user.
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

    const appUrl = this.configService.get<string>('app.adminUrl', 'https://ehte.org');
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
      action: AuditEventEnum.USER_PROMOTION_INITIATED,
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

  // ADMIN — RESEND PROMOTION: fresh token for a still-pending (unverified) promotion.

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

    // Invalidate any previous unused promotion link, same as promoteUserInitiate().
    await this.prisma.userOtp.updateMany({
      where: { userId: user.id, purpose: UserOtpPurposeEnum.promotion_verification, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.tokenUtil.hashOpaqueToken(rawToken, 'promotion');
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

    const appUrl = this.configService.get<string>('app.adminUrl', 'https://ehte.org');
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
      action: AuditEventEnum.USER_PROMOTION_RESENT,
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

  // ADMIN — PROMOTE EXISTING USER (STEP 2): possessing the token proves email ownership.

  async promoteUserVerify(data: PromoteVerifyDto): Promise<{ message: string }> {
    const tokenHash = this.tokenUtil.hashOpaqueToken(data.token, 'promotion');

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
      // Atomically claim the token so a replayed link can't be used twice.
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

      // Additive: grant ADMIN alongside every role the user already has (USER stays).
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

  // ADMIN — FORGOT PASSWORD: email-only; masks "no account"/"not admin"/"inactive" identically.
  // Already the email-OTP path (see OtpChannelEnum.email below) — kept unchanged.

  async adminForgotPassword(data: AdminForgotPasswordDto): Promise<{ verificationId: string }> {
    const email = this.normalizeEmailOrThrow(data.email);

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { userRoles: { include: { role: true } } },
    });

    const roles = user?.userRoles.map((userRole) => userRole.role.name) ?? [];

    const isAdmin = this.hasAdminRole(roles);

    // Mask: no account, not an admin, or inactive all look identical externally.
    if (!user || !isAdmin || !user.isActive) {
      return { verificationId: '' };
    }

    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      user.id,
      email,
      UserOtpPurposeEnum.password_reset,
      OtpChannelEnum.email,
    );

    return { verificationId };
  }

  // ADMIN — LOGIN BY EMAIL: the only admin credential path; also requires isEmailVerified.

  async adminLoginByEmail(data: AdminLoginEmailDto): Promise<TokenPair> {
    const email = this.normalizeEmailOrThrow(data.email);

    const user = await this.prisma.user.findUnique({
      where: { email },
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

    const roles = user?.userRoles.map((userRole) => userRole.role.name) ?? [];
    const permissions = user ? this.derivePermissions(user.userRoles) : [];

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
      await this.lockoutUtil.recordFailedLogin(user.id);

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

    await this.lockoutUtil.resetLoginAttempts(user);

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

    return this.tokenUtil.issueTokens(
      user.id,
      { phone: user.phone, email: user.email },
      roles,
      permissions,
    );
  }

  // ADMIN — RESET PASSWORD (FORGOT-PASSWORD FLOW): verifies the OTP owner is actually an
  // admin, then runs the same OTP-claim + password-update flow AuthService.resetPassword()
  // uses (duplicated here since admin-auth/ doesn't import from auth/). Reached only via
  // adminForgotPassword() — i.e. the admin does NOT already know their current password.
  // Contrast with adminChangePasswordInitiate/Verify below, which is for an admin who DOES
  // know their current password and wants to change it while logged in.

  async adminResetPassword(data: ResetPasswordDto): Promise<{ message: string }> {
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

    if (!this.hasAdminRole(roles)) {
      throw new BadRequestException('invalid_or_expired_otp');
    }

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

    this.emitAudit({
      userId: otpRecord.user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.PASSWORD_RESET,
      entity: 'User',
      entityId: otpRecord.user.id,
      diff: { method: 'otp', result: 'success', context: 'admin_reset_password' },
    });

    // NOTE: AuthService.resetPassword() also emits a NotificationEventEnum.PASSWORD_RESET
    // event here to trigger a user-facing notification. Wire the equivalent up on this
    // side (event-emitter + PasswordResetEvent import) if admins should get the same
    // notification — omitted here rather than guessed at.

    return { message: 'password_reset_successful' };
  }

  // ADMIN — CHANGE PASSWORD (STEP 1): authenticated admin proves they still know their
  // current password, then an OTP is emailed to their own address before a new password
  // is accepted. This is the dedicated admin-only self-service flow — the shared USER
  // /auth/change-password endpoint (AuthService.changePassword()) now rejects any
  // account holding an admin role and points it here instead.

  async adminChangePasswordInitiate(
    actor: CurrentUserDto,
    data: AdminChangePasswordInitiateDto,
  ): Promise<{ verificationId: string }> {
    const actorRoles = actor.roles ?? [];

    if (!this.hasAdminRole(actorRoles)) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const admin = await this.prisma.user.findUnique({
      where: { id: actor.id },
    });

    if (!admin) {
      throw new NotFoundException('user_not_found');
    }

    if (!admin.passwordHash) {
      throw new BadRequestException('password_not_set');
    }

    const validPassword = await bcrypt.compare(data.currentPassword, admin.passwordHash);

    if (!validPassword) {
      throw new BadRequestException('wrong_current_password');
    }

    if (!admin.email) {
      // Shouldn't happen for an admin account, but guard anyway — there's nowhere to send the OTP.
      throw new BadRequestException('admin_email_missing');
    }

    // Reuses the password_reset purpose + email channel — same proof-of-inbox pattern as
    // adminForgotPassword(), just reached only after the current-password check above
    // (adminForgotPassword() has no such check, since it's for admins who've lost their password).
    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      admin.id,
      admin.email,
      UserOtpPurposeEnum.password_reset,
      OtpChannelEnum.email,
    );

    return { verificationId };
  }

  // ADMIN — CHANGE PASSWORD (STEP 2): possessing the emailed OTP proves inbox control.
  // Mirrors adminResetPassword()'s OTP-claim pattern; kept as a separate method (rather
  // than calling adminResetPassword() directly) so the two flows stay independently
  // auditable, matching this file's existing register/promote/reset duplication pattern.

  async adminChangePasswordVerify(data: ResetPasswordDto): Promise<{ message: string }> {
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

    if (!this.hasAdminRole(roles)) {
      throw new BadRequestException('invalid_or_expired_otp');
    }

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
          purpose: 'admin_change_password',
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
            purpose: 'admin_change_password',
          },
        });
      }

      throw new BadRequestException('invalid_or_expired_otp');
    }

    const hashedPassword = await bcrypt.hash(data.newPassword, 10);

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

      // Invalidate every existing session, including the one used to call step 1.
      await tx.session.deleteMany({
        where: { userId: otpRecord.user.id },
      });
    });

    this.emitAudit({
      userId: otpRecord.user.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.PASSWORD_CHANGED,
      entity: 'User',
      entityId: otpRecord.user.id,
      diff: { method: 'otp', result: 'success', context: 'admin_change_password_completed' },
    });

    // NOTE: same as adminResetPassword() — wire a NotificationEventEnum.PASSWORD_CHANGED
    // event here if admins should get a user-facing notification on top of the audit log.

    return { message: 'password_changed' };
  }

  // Self-service admin email change (STEP 1): gated by re-authentication at the controller.

  async adminChangeEmailInitiate(
    actor: CurrentUserDto,
    data: AdminChangeEmailDto,
  ): Promise<{ message: string }> {
    const actorRoles = actor.roles ?? [];

    if (!this.hasAdminRole(actorRoles)) {
      throw new UnauthorizedException('insufficient_permissions');
    }

    const newEmail = this.normalizeEmailOrThrow(data.newEmail);

    const admin = await this.prisma.user.findUnique({
      where: { id: actor.id },
    });

    if (!admin) {
      throw new NotFoundException('user_not_found');
    }

    if (admin.email === newEmail) {
      throw new BadRequestException('email_unchanged');
    }

    const emailInUse = await this.prisma.user.findUnique({ where: { email: newEmail } });

    if (emailInUse && emailInUse.id !== admin.id) {
      throw new BadRequestException('email_already_registered');
    }

    // Attach the new email now (unverified) — same immediate-attach pattern as promotion.
    try {
      await this.prisma.user.update({
        where: { id: admin.id },
        data: { email: newEmail, isEmailVerified: false },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new BadRequestException('email_already_registered');
      }
      throw error;
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.tokenUtil.hashOpaqueToken(rawToken, 'email_change');
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TOKEN_EXPIRES_MINUTES * 60 * 1000);

    // Reuses email_verification purpose — no dedicated "email change" enum value exists.
    // Invalidate any previous unused email-change request for this admin.
    await this.prisma.userOtp.updateMany({
      where: {
        userId: admin.id,
        purpose: UserOtpPurposeEnum.email_verification,
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });

    await this.prisma.userOtp.create({
      data: {
        userId: admin.id,
        otpHash: tokenHash,
        purpose: UserOtpPurposeEnum.email_verification,
        channel: OtpChannelEnum.email,
        expiresAt,
      },
    });

    const appUrl = this.configService.get<string>('app.adminUrl', 'https://ehte.org');
    const changeEmailLink = `${appUrl}/admin/change-email/verify?token=${rawToken}`;
    const expiresInHours = Math.round(EMAIL_CHANGE_TOKEN_EXPIRES_MINUTES / 60) || 1;

    // Reuses the OTP email template as a stand-in; swap for a dedicated template later.
    try {
      await sendEmail(
        newEmail,
        renderOtpEmailSubject(),
        renderOtpEmailHtml({
          otp: changeEmailLink,
          expiresInMinutes: EMAIL_CHANGE_TOKEN_EXPIRES_MINUTES,
        }),
      );
    } catch (error) {
      console.error(`[EHTE EMAIL] Failed to send email-change verification to ${newEmail}`, error);
    }

    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] Email-change verification link for ${newEmail}: ${changeEmailLink}`);
    }

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(actorRoles),
      action: AuditEventEnum.ADMIN_EMAIL_CHANGE_INITIATED,
      entity: 'User',
      entityId: admin.id,
      diff: {
        result: 'success',
        context: 'admin_email_change_initiated',
        newEmail,
      },
    });

    return { message: 'email_change_verification_sent' };
  }

  // ADMIN — CHANGE EMAIL (STEP 2): possessing the token proves control of the new inbox.

  async adminChangeEmailVerify(data: AdminChangeEmailVerifyDto): Promise<{ message: string }> {
    const tokenHash = this.tokenUtil.hashOpaqueToken(data.token, 'email_change');

    const otpRecord = await this.prisma.userOtp.findFirst({
      where: {
        otpHash: tokenHash,
        purpose: UserOtpPurposeEnum.email_verification,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!otpRecord) {
      throw new BadRequestException('invalid_or_expired_token');
    }

    await this.prisma.$transaction(async (tx) => {
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
        where: { id: otpRecord.userId },
        data: { isEmailVerified: true },
      });
    });

    this.emitAudit({
      userId: otpRecord.userId,
      actorType: resolveActorType([]),
      action: AuditEventEnum.ADMIN_EMAIL_CHANGE_VERIFIED,
      entity: 'UserOtp',
      entityId: otpRecord.id,
      diff: { purpose: 'email_change_verification', result: 'success' },
    });

    return { message: 'email_changed' };
  }

  // Wraps normalizePhoneNumber() so malformed input yields a clean 400, not a raw 500.
  private normalizePhoneOrThrow(phone: string): string {
    try {
      return normalizePhoneNumber(phone);
    } catch {
      throw new BadRequestException('invalid_phone_number');
    }
  }

  // Wraps normalizeEmail() so malformed input yields a clean 400, not a raw 500.
  private normalizeEmailOrThrow(email: string): string {
    try {
      return normalizeEmail(email);
    } catch {
      throw new BadRequestException('invalid_email');
    }
  }
}
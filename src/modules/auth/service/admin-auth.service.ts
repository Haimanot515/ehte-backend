import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  AuditOutcome,
  AuditSeverity,
  UserOtpPurposeEnum,
  OtpChannelEnum,
  Prisma,
} from '@prisma/client';

import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { normalizePhoneNumber } from 'src/common/utils/phone.util';
import { normalizeEmail } from 'src/common/utils/email.util';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { hasStaffRole, NON_INVITABLE_ROLE_NAMES } from '../util/role-protection.util';

import { OtpUtil } from 'src/common/utils/otp.util';
import { LockoutUtil } from 'src/common/utils/lockout.util';
import { TokenUtil } from 'src/common/utils/token.util';

import { EmailService } from 'src/services/email/email.service';
import {
  renderEmailChangeVerificationSubject,
  renderEmailChangeVerificationHtml,
} from 'src/services/email/templates/email-change-verification.template';

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

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import {
  PasswordChangedEvent,
  PasswordResetEvent,
} from 'src/modules/misc/events/notification.events';

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
  PromoteCancelDto,
  AdminChangeEmailResendDto,
  DemoteAdminDto,
  AdminStatsQueryDto,
  AdminLoginHistoryQueryDto,
} from '../dto/admin-auth.dto';

import { RefreshTokenDto } from '../dto/auth.dto';
import { AuthService } from './auth.service';
import { CacheService } from 'src/services/redis/cache.service';

type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

const REGISTRATION_TOKEN_EXPIRES_MINUTES = 60 * 24;
const PROMOTION_TOKEN_EXPIRES_MINUTES = 60 * 24;
const EMAIL_CHANGE_TOKEN_EXPIRES_MINUTES = 60;

// Cast until AuditEventPayload's actorType union gains a SYSTEM variant, same as ReportService/PostService
const SYSTEM_ACTOR_TYPE = 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>;

type UserRoleWithPermissions = {
  role: {
    name: string;
    rolePermissions: { permission: { name: string } }[];
  };
};

// ── constants for the new admin auth features ──
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_RESEND_HOURLY_CAP = 5;
// Admin login events carry this context in their audit diff (see adminLoginByEmail).
const ADMIN_LOGIN_CONTEXT = 'admin_login_email';

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly otpUtil: OtpUtil,
    private readonly lockoutUtil: LockoutUtil,
    private readonly tokenUtil: TokenUtil,
    private readonly emailService: EmailService,
    private readonly authService: AuthService,
    private readonly cache: CacheService,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  private userLabel(user: { name?: string | null; email?: string | null }): string | undefined {
    return user.name ?? user.email ?? undefined;
  }

  private assertSuperAdmin(
    actor: CurrentUserDto,
    action: AuditEventEnum,
    metadata?: AuditEventPayload['metadata'],
  ): void {
    const roles = actor.roles ?? [];

    if (roles.includes(RolesEnum.SUPER_ADMIN)) return;

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(roles),
      action,
      outcome: AuditOutcome.DENIED,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: null,
      diff: {
        result: 'denied',
        reason: 'insufficient_permissions',
        requiredRole: RolesEnum.SUPER_ADMIN,
      },
      ...(metadata ? { metadata } : {}),
    });

    throw new UnauthorizedException('insufficient_permissions');
  }

  private assertActorIsAdmin(actor: CurrentUserDto, action: AuditEventEnum): void {
    const roles = actor.roles ?? [];

    if (this.hasAdminRole(roles)) return;

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(roles),
      action,
      outcome: AuditOutcome.DENIED,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: actor.id,
      diff: {
        result: 'denied',
        reason: 'insufficient_permissions',
        requiredRole: 'ADMIN_OR_SUPER_ADMIN',
      },
    });

    throw new UnauthorizedException('insufficient_permissions');
  }

  private emitOtpAbuseAlert(
    otpId: string,
    targetUserId: string,
    purpose: 'password_reset' | 'password_change',
    attempts: number,
  ): void {
    this.emitAudit({
      targetUserId,
      actorType: SYSTEM_ACTOR_TYPE,
      action: AuditEventEnum.SECURITY_ALERT,
      outcome: AuditOutcome.DENIED,
      severity: AuditSeverity.WARNING,
      entity: 'UserOtp',
      entityId: otpId,
      entityLabel: `${purpose} OTP`,
      diff: {
        reason: 'too_many_otp_attempts',
        purpose,
      },
      metadata: { attempts, accountLocked: true },
    });
  }

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

  private async issueRegistrationInvite(adminId: string, email: string): Promise<void> {
    const rawRegistrationToken = randomBytes(32).toString('hex');
    const inviteTokenHash = this.tokenUtil.hashOpaqueToken(rawRegistrationToken, 'registration');
    const inviteTokenExpiresAt = new Date(
      Date.now() + REGISTRATION_TOKEN_EXPIRES_MINUTES * 60 * 1000,
    );

    await this.prisma.user.update({
      where: { id: adminId },
      data: { inviteTokenHash, inviteTokenExpiresAt },
    });

    const appUrl = this.configService.get<string>('app.adminUrl', 'https://ehte.org');
    const registrationLink = `${appUrl}/admin/register?token=${rawRegistrationToken}`;
    const registrationExpiresInHours = Math.round(REGISTRATION_TOKEN_EXPIRES_MINUTES / 60);

    try {
      await this.emailService.send(
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
  }

  async adminRegister(
    creator: CurrentUserDto,
    data: AdminRegisterDto,
  ): Promise<{ adminId: string; message: string }> {
    const creatorRoles = creator.roles ?? [];
    const actorType = resolveActorType(creatorRoles);

    this.assertSuperAdmin(creator, AuditEventEnum.ADMIN_REGISTERED, {
      attemptedRoles: data.roles,
    });

    const email = this.normalizeEmailOrThrow(data.email);

    if (data.roles.some((role) => NON_INVITABLE_ROLE_NAMES.includes(role))) {
      this.emitAudit({
        userId: creator.id,
        actorType,
        action: AuditEventEnum.ADMIN_REGISTERED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: null,
        entityLabel: data.name,
        diff: { result: 'failure', reason: 'only_admin_roles_may_be_registered' },
        metadata: { attemptedRoles: data.roles, attemptedEmail: email },
      });
      throw new BadRequestException('only_admin_roles_may_be_registered');
    }

    const roleRecords = await this.prisma.role.findMany({
      where: { name: { in: data.roles } },
    });

    if (roleRecords.length !== new Set(data.roles).size) {
      this.emitAudit({
        userId: creator.id,
        actorType,
        action: AuditEventEnum.ADMIN_REGISTERED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: null,
        entityLabel: data.name,
        diff: { result: 'failure', reason: 'one_or_more_roles_not_configured' },
        metadata: {
          requestedRoles: data.roles,
          configuredRoles: roleRecords.map((role) => role.name),
          attemptedEmail: email,
        },
      });
      throw new BadRequestException('one_or_more_roles_not_configured');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      include: { userRoles: { include: { role: true } } },
    });

    if (existingUser) {
      if (existingUser.passwordHash || existingUser.isActive) {
        this.emitAudit({
          userId: creator.id,
          targetUserId: existingUser.id,
          actorType,
          action: AuditEventEnum.ADMIN_REGISTERED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'User',
          entityId: existingUser.id,
          entityLabel: this.userLabel(existingUser),
          diff: { result: 'failure', reason: 'email_already_registered' },
          metadata: { attemptedEmail: email, attemptedRoles: data.roles },
        });
        throw new BadRequestException('email_already_registered');
      }

      // GAP FIX: a re-invite used to silently keep the OLD roles and ignore data.roles.
      // The account is still inactive with no password, so replacing roles is safe.
      const previousRoles = existingUser.userRoles.map((userRole) => userRole.role.name);
      await this.prisma.$transaction([
        this.prisma.userRole.deleteMany({ where: { userId: existingUser.id } }),
        this.prisma.userRole.createMany({
          data: roleRecords.map((role) => ({ userId: existingUser.id, roleId: role.id })),
        }),
      ]);

      await this.issueRegistrationInvite(existingUser.id, email);

      this.emitAudit({
        userId: creator.id,
        targetUserId: existingUser.id,
        actorType,
        action: AuditEventEnum.ADMIN_REGISTRATION_RESENT,
        entity: 'User',
        entityId: existingUser.id,
        entityLabel: this.userLabel(existingUser),
        diff: {
          result: 'success',
          context: 'registration_resent_via_register_endpoint',
          previousRoles,
          currentRoles: roleRecords.map((role) => role.name),
        },
      });

      return { adminId: existingUser.id, message: 'admin_registered' };
    }

    let admin: { id: string };

    try {
      admin = await this.prisma.user.create({
        data: {
          email,
          name: data.name,
          passwordHash: null,
          isPhoneVerified: false,
          isEmailVerified: false,
          isActive: false,
          userRoles: {
            create: roleRecords.map((role) => ({ roleId: role.id })),
          },
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        this.emitAudit({
          userId: creator.id,
          actorType,
          action: AuditEventEnum.ADMIN_REGISTERED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'User',
          entityId: null,
          entityLabel: data.name,
          diff: { result: 'failure', reason: 'email_already_registered' },
          metadata: {
            attemptedEmail: email,
            attemptedRoles: data.roles,
            detectedBy: 'unique_constraint',
          },
        });
        throw new BadRequestException('email_already_registered');
      }
      throw error;
    }

    await this.issueRegistrationInvite(admin.id, email);

    this.emitAudit({
      userId: creator.id,
      targetUserId: admin.id,
      actorType,
      action: AuditEventEnum.ADMIN_REGISTERED,
      entity: 'User',
      entityId: admin.id,
      entityLabel: data.name,
      diff: {
        result: 'success',
        roles: data.roles,
        status: 'registered',
      },
      metadata: { invitedEmail: email },
    });

    return { adminId: admin.id, message: 'admin_registered' };
  }

  async adminRegisterResend(
    creator: CurrentUserDto,
    data: AdminRegisterResendDto,
  ): Promise<{ message: string }> {
    const creatorRoles = creator.roles ?? [];
    const actorType = resolveActorType(creatorRoles);

    this.assertSuperAdmin(creator, AuditEventEnum.ADMIN_REGISTRATION_RESENT);

    const email = this.normalizeEmailOrThrow(data.email);

    const admin = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!admin) {
      throw new NotFoundException('registration_not_found');
    }

    if (admin.passwordHash || admin.isActive) {
      this.emitAudit({
        userId: creator.id,
        targetUserId: admin.id,
        actorType,
        action: AuditEventEnum.ADMIN_REGISTRATION_RESENT,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: admin.id,
        entityLabel: this.userLabel(admin),
        diff: { result: 'failure', reason: 'registration_already_completed' },
      });
      throw new BadRequestException('registration_already_completed');
    }

    await this.issueRegistrationInvite(admin.id, email);

    this.emitAudit({
      userId: creator.id,
      targetUserId: admin.id,
      actorType,
      action: AuditEventEnum.ADMIN_REGISTRATION_RESENT,
      entity: 'User',
      entityId: admin.id,
      entityLabel: this.userLabel(admin),
      diff: {
        result: 'success',
        context: 'registration_resent',
      },
    });

    return { message: 'registration_resent' };
  }

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
      this.emitAudit({
        userId: admin?.id ?? null,
        actorType: resolveActorType(admin?.userRoles.map((userRole) => userRole.role.name) ?? []),
        action: AuditEventEnum.PASSWORD_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: admin?.id ?? null,
        entityLabel: admin ? this.userLabel(admin) : undefined,
        diff: {
          result: 'failure',
          context: 'admin_registration_completed',
          reason: !admin ? 'invalid_registration_token' : 'expired_registration_token',
        },
      });
      throw new BadRequestException('invalid_or_expired_registration_token');
    }

    if (admin.passwordHash) {
      this.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(admin.userRoles.map((userRole) => userRole.role.name)),
        action: AuditEventEnum.PASSWORD_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: admin.id,
        entityLabel: this.userLabel(admin),
        diff: {
          result: 'failure',
          context: 'admin_registration_completed',
          reason: 'registration_token_already_used',
        },
      });
      throw new BadRequestException('registration_token_already_used');
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);
    const roles = admin.userRoles.map((userRole) => userRole.role.name);
    const permissions = this.derivePermissions(admin.userRoles);

    await this.prisma.user.update({
      where: { id: admin.id },
      data: {
        passwordHash: hashedPassword,
        isEmailVerified: true,
        isActive: true,
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
      entityLabel: this.userLabel(admin),
      diff: { result: 'success', context: 'admin_registration_completed' },
    });

    if (!admin.email) {
      throw new BadRequestException('admin_email_missing');
    }

    return this.tokenUtil.issueTokens(admin.id, { email: admin.email }, roles, permissions);
  }

  async adminCancelRegistration(
    actor: CurrentUserDto,
    data: AdminCancelRegistrationDto,
  ): Promise<{ message: string }> {
    const actorRoles = actor.roles ?? [];
    const actorType = resolveActorType(actorRoles);

    this.assertSuperAdmin(actor, AuditEventEnum.ADMIN_REGISTRATION_CANCELLED);

    const email = this.normalizeEmailOrThrow(data.email);

    const admin = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!admin) {
      throw new NotFoundException('registration_not_found');
    }

    if (admin.passwordHash || admin.isActive) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: admin.id,
        actorType,
        action: AuditEventEnum.ADMIN_REGISTRATION_CANCELLED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: admin.id,
        entityLabel: this.userLabel(admin),
        diff: { result: 'failure', reason: 'registration_already_completed' },
      });
      throw new BadRequestException('registration_already_completed');
    }

    await this.prisma.user.delete({
      where: { id: admin.id },
    });

    // targetUserId is omitted on success because the target row is deleted in this same call
    this.emitAudit({
      userId: actor.id,
      actorType,
      action: AuditEventEnum.ADMIN_REGISTRATION_CANCELLED,
      entity: 'User',
      entityId: admin.id,
      entityLabel: email,
      diff: {
        result: 'success',
        context: 'registration_cancelled',
      },
    });

    return { message: 'registration_cancelled' };
  }

  async promoteUserInitiate(
    actor: CurrentUserDto,
    data: PromoteUserDto,
  ): Promise<{ message: string }> {
    const actorRoles = actor.roles ?? [];
    const actorType = resolveActorType(actorRoles);

    this.assertSuperAdmin(actor, AuditEventEnum.USER_PROMOTION_INITIATED);

    const phone = this.normalizePhoneOrThrow(data.phone);
    const email = this.normalizeEmailOrThrow(data.email);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    if (!user.isActive) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: user.id,
        actorType,
        action: AuditEventEnum.USER_PROMOTION_INITIATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userLabel(user),
        diff: { result: 'failure', reason: 'user_inactive' },
      });
      throw new BadRequestException('user_not_eligible_for_promotion');
    }

    if (!user.isPhoneVerified) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: user.id,
        actorType,
        action: AuditEventEnum.USER_PROMOTION_INITIATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userLabel(user),
        diff: { result: 'failure', reason: 'phone_not_verified' },
      });
      throw new BadRequestException('user_not_eligible_for_promotion');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);

    if (this.hasAdminRole(roles)) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: user.id,
        actorType,
        action: AuditEventEnum.USER_PROMOTION_INITIATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userLabel(user),
        diff: { result: 'failure', reason: 'user_already_admin' },
        metadata: { existingRoles: roles },
      });
      throw new BadRequestException('user_already_admin');
    }

    const emailInUse = await this.prisma.user.findUnique({ where: { email } });

    if (emailInUse && emailInUse.id !== user.id) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: user.id,
        actorType,
        action: AuditEventEnum.USER_PROMOTION_INITIATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userLabel(user),
        diff: { result: 'failure', reason: 'email_already_registered' },
        metadata: { attemptedEmail: email, conflictingUserId: emailInUse.id },
      });
      throw new BadRequestException('email_already_registered');
    }

    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { email, isEmailVerified: false },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        this.emitAudit({
          userId: actor.id,
          targetUserId: user.id,
          actorType,
          action: AuditEventEnum.USER_PROMOTION_INITIATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'User',
          entityId: user.id,
          entityLabel: this.userLabel(user),
          diff: { result: 'failure', reason: 'email_already_registered' },
          metadata: { attemptedEmail: email, detectedBy: 'unique_constraint' },
        });
        throw new BadRequestException('email_already_registered');
      }
      throw error;
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.tokenUtil.hashOpaqueToken(rawToken, 'promotion');
    const expiresAt = new Date(Date.now() + PROMOTION_TOKEN_EXPIRES_MINUTES * 60 * 1000);

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
      await this.emailService.send(
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
      userId: actor.id,
      targetUserId: user.id,
      actorType,
      action: AuditEventEnum.USER_PROMOTION_INITIATED,
      entity: 'User',
      entityId: user.id,
      entityLabel: this.userLabel(user),
      diff: {
        result: 'success',
        context: 'promotion_initiated',
      },
      metadata: { promotionOtpId: promotionOtp.id, promotionEmail: email },
    });

    return { message: 'promotion_email_sent' };
  }

  async promoteUserResend(
    actor: CurrentUserDto,
    data: PromoteUserResendDto,
  ): Promise<{ message: string }> {
    const actorRoles = actor.roles ?? [];
    const actorType = resolveActorType(actorRoles);

    this.assertSuperAdmin(actor, AuditEventEnum.USER_PROMOTION_RESENT);

    const phone = this.normalizePhoneOrThrow(data.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    if (!user.email) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: user.id,
        actorType,
        action: AuditEventEnum.USER_PROMOTION_RESENT,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userLabel(user),
        diff: { result: 'failure', reason: 'promotion_not_initiated' },
      });
      throw new BadRequestException('promotion_not_initiated');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);

    if (this.hasAdminRole(roles)) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: user.id,
        actorType,
        action: AuditEventEnum.USER_PROMOTION_RESENT,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userLabel(user),
        diff: { result: 'failure', reason: 'user_already_admin' },
        metadata: { existingRoles: roles },
      });
      throw new BadRequestException('user_already_admin');
    }

    if (user.isEmailVerified) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: user.id,
        actorType,
        action: AuditEventEnum.USER_PROMOTION_RESENT,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userLabel(user),
        diff: { result: 'failure', reason: 'promotion_already_completed' },
      });
      throw new BadRequestException('promotion_already_completed');
    }

    await this.prisma.userOtp.updateMany({
      where: { userId: user.id, purpose: UserOtpPurposeEnum.promotion_verification, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.tokenUtil.hashOpaqueToken(rawToken, 'promotion');
    const expiresAt = new Date(Date.now() + PROMOTION_TOKEN_EXPIRES_MINUTES * 60 * 1000);

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
      await this.emailService.send(
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
      userId: actor.id,
      targetUserId: user.id,
      actorType,
      action: AuditEventEnum.USER_PROMOTION_RESENT,
      entity: 'User',
      entityId: user.id,
      entityLabel: this.userLabel(user),
      diff: {
        result: 'success',
        context: 'promotion_resent',
      },
      metadata: { promotionOtpId: promotionOtp.id, promotionEmail: user.email },
    });

    return { message: 'promotion_email_resent' };
  }

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
      this.emitAudit({
        userId: null,
        actorType: resolveActorType([]),
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: null,
        entityLabel: 'promotion_verification',
        diff: {
          purpose: 'promotion_verification',
          result: 'failure',
          reason: 'invalid_or_expired_token',
        },
      });
      throw new BadRequestException('invalid_or_expired_token');
    }

    const user = otpRecord.user;
    const roles = user.userRoles.map((userRole) => userRole.role.name);

    const adminRole = await this.prisma.role.findUnique({
      where: { name: RolesEnum.ADMIN },
    });

    if (!adminRole) {
      this.emitAudit({
        userId: user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        entityLabel: this.userLabel(user),
        diff: {
          purpose: 'promotion_verification',
          result: 'failure',
          reason: 'admin_role_not_configured',
        },
      });
      throw new BadRequestException('admin_role_not_configured');
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
        this.emitAudit({
          userId: user.id,
          actorType: resolveActorType(roles),
          action: AuditEventEnum.OTP_VERIFIED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: this.userLabel(user),
          diff: {
            purpose: 'promotion_verification',
            result: 'failure',
            reason: 'token_already_claimed',
          },
        });
        throw new BadRequestException('invalid_or_expired_token');
      }

      await tx.user.update({
        where: { id: user.id },
        data: { isEmailVerified: true },
      });

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
      entityLabel: this.userLabel(user),
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

  async adminForgotPassword(data: AdminForgotPasswordDto): Promise<{ verificationId: string }> {
    const email = this.normalizeEmailOrThrow(data.email);

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { userRoles: { include: { role: true } } },
    });

    const roles = user?.userRoles.map((userRole) => userRole.role.name) ?? [];

    const isAdmin = this.hasAdminRole(roles);

    if (!user || !isAdmin || !user.isActive) {
      this.emitAudit({
        userId: user?.id ?? null,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.PASSWORD_RESET,
        outcome: AuditOutcome.DENIED,
        severity: user ? AuditSeverity.WARNING : AuditSeverity.INFO,
        entity: 'User',
        entityId: user?.id ?? null,
        entityLabel: user ? this.userLabel(user) : undefined,
        diff: {
          result: 'denied',
          context: 'admin_forgot_password',
          reason: !user ? 'unknown_account' : !isAdmin ? 'not_an_admin' : 'account_inactive',
        },
        metadata: { attemptedEmail: email },
      });
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
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user?.id ?? null,
        entityLabel: user ? this.userLabel(user) : undefined,
        diff: {
          method: 'password',
          context: 'admin_login_email',
          result: 'failed',
          reason: !user
            ? 'unknown_account'
            : !isAdmin
              ? 'not_an_admin'
              : !user.passwordHash
                ? 'password_not_set'
                : 'email_not_verified',
        },
        metadata: { attemptedEmail: email },
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
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userLabel(user),
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
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userLabel(user),
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
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userLabel(user),
        diff: {
          method: 'password',
          context: 'admin_login_email',
          result: 'failed',
          reason: 'wrong_password',
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
      entityLabel: this.userLabel(user),
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

  async adminResetPassword(data: ResetPasswordDto): Promise<{ message: string }> {
    const otpRecord = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
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
      this.emitAudit({
        userId: otpRecord?.user.id ?? null,
        actorType: resolveActorType(
          otpRecord?.user.userRoles.map((userRole) => userRole.role.name) ?? [],
        ),
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord?.id ?? null,
        entityLabel: otpRecord ? this.userLabel(otpRecord.user) : 'password_reset OTP',
        diff: {
          purpose: 'password_reset',
          result: 'failure',
          reason: !otpRecord
            ? 'otp_not_found'
            : otpRecord.purpose !== UserOtpPurposeEnum.password_reset
              ? 'wrong_purpose'
              : otpRecord.usedAt
                ? 'already_used'
                : 'expired',
        },
        ...(otpRecord ? {} : { metadata: { attemptedVerificationId: data.verificationId } }),
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const roles = otpRecord.user.userRoles.map((userRole) => userRole.role.name);

    if (!this.hasAdminRole(roles)) {
      this.emitAudit({
        userId: otpRecord.user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        entityLabel: this.userLabel(otpRecord.user),
        diff: {
          purpose: 'password_reset',
          result: 'denied',
          reason: 'otp_owner_not_admin',
        },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.attempts >= 5) {
      await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

      this.emitOtpAbuseAlert(otpRecord.id, otpRecord.user.id, 'password_reset', otpRecord.attempts);

      throw new BadRequestException('too_many_otp_attempts');
    }

    const validOtp = await bcrypt.compare(data.otp, otpRecord.otpHash);

    if (!validOtp) {
      const updatedOtp = await this.prisma.userOtp.update({
        where: { id: otpRecord.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });

      this.emitAudit({
        userId: otpRecord.user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        entityLabel: this.userLabel(otpRecord.user),
        diff: {
          purpose: 'password_reset',
          result: 'failure',
          reason: 'wrong_otp',
        },
        metadata: { attempts: updatedOtp.attempts },
      });

      if (updatedOtp.attempts >= 5) {
        await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

        this.emitOtpAbuseAlert(
          otpRecord.id,
          otpRecord.user.id,
          'password_reset',
          updatedOtp.attempts,
        );
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
        this.emitAudit({
          userId: otpRecord.user.id,
          actorType: resolveActorType(roles),
          action: AuditEventEnum.OTP_VERIFIED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: this.userLabel(otpRecord.user),
          diff: {
            purpose: 'password_reset',
            result: 'failure',
            reason: 'otp_already_claimed',
          },
        });
        throw new BadRequestException('invalid_or_expired_otp');
      }

      await tx.user.update({
        where: { id: otpRecord.user.id },
        data: { passwordHash: hashedPassword },
      });

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
      entityLabel: this.userLabel(otpRecord.user),
      diff: { method: 'otp', result: 'success', context: 'admin_reset_password' },
    });

    const resetEvent: PasswordResetEvent = { userId: otpRecord.user.id };
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_RESET, resetEvent);

    return { message: 'password_reset_successful' };
  }

  async adminChangePasswordInitiate(
    actor: CurrentUserDto,
    data: AdminChangePasswordInitiateDto,
  ): Promise<{ verificationId: string }> {
    const actorRoles = actor.roles ?? [];
    const actorType = resolveActorType(actorRoles);

    this.assertActorIsAdmin(actor, AuditEventEnum.PASSWORD_CHANGED);

    const admin = await this.prisma.user.findUnique({
      where: { id: actor.id },
    });

    if (!admin) {
      throw new NotFoundException('user_not_found');
    }

    if (!admin.passwordHash) {
      this.emitAudit({
        userId: actor.id,
        actorType,
        action: AuditEventEnum.PASSWORD_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: admin.id,
        entityLabel: this.userLabel(admin),
        diff: {
          result: 'failure',
          context: 'admin_change_password_initiated',
          reason: 'password_not_set',
        },
      });
      throw new BadRequestException('password_not_set');
    }

    const validPassword = await bcrypt.compare(data.currentPassword, admin.passwordHash);

    if (!validPassword) {
      this.emitAudit({
        userId: actor.id,
        actorType,
        action: AuditEventEnum.PASSWORD_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: admin.id,
        entityLabel: this.userLabel(admin),
        diff: {
          result: 'failure',
          context: 'admin_change_password_initiated',
          reason: 'wrong_current_password',
        },
      });
      throw new BadRequestException('wrong_current_password');
    }

    if (!admin.email) {
      this.emitAudit({
        userId: actor.id,
        actorType,
        action: AuditEventEnum.PASSWORD_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: admin.id,
        entityLabel: this.userLabel(admin),
        diff: {
          result: 'failure',
          context: 'admin_change_password_initiated',
          reason: 'admin_email_missing',
        },
      });
      throw new BadRequestException('admin_email_missing');
    }

    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      admin.id,
      admin.email,
      UserOtpPurposeEnum.password_change,
      OtpChannelEnum.email,
    );

    return { verificationId };
  }

  async adminChangePasswordVerify(data: ResetPasswordDto): Promise<{ message: string }> {
    const otpRecord = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            userRoles: { include: { role: true } },
          },
        },
      },
    });

    if (
      !otpRecord ||
      otpRecord.purpose !== UserOtpPurposeEnum.password_change ||
      otpRecord.usedAt ||
      otpRecord.expiresAt < new Date()
    ) {
      this.emitAudit({
        userId: otpRecord?.user.id ?? null,
        actorType: resolveActorType(
          otpRecord?.user.userRoles.map((userRole) => userRole.role.name) ?? [],
        ),
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord?.id ?? null,
        entityLabel: otpRecord ? this.userLabel(otpRecord.user) : 'password_change OTP',
        diff: {
          purpose: 'password_change',
          result: 'failure',
          reason: !otpRecord
            ? 'otp_not_found'
            : otpRecord.purpose !== UserOtpPurposeEnum.password_change
              ? 'wrong_purpose'
              : otpRecord.usedAt
                ? 'already_used'
                : 'expired',
        },
        ...(otpRecord ? {} : { metadata: { attemptedVerificationId: data.verificationId } }),
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const roles = otpRecord.user.userRoles.map((userRole) => userRole.role.name);

    if (!this.hasAdminRole(roles)) {
      this.emitAudit({
        userId: otpRecord.user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        entityLabel: this.userLabel(otpRecord.user),
        diff: {
          purpose: 'password_change',
          result: 'denied',
          reason: 'otp_owner_not_admin',
        },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.attempts >= 5) {
      await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

      this.emitOtpAbuseAlert(
        otpRecord.id,
        otpRecord.user.id,
        'password_change',
        otpRecord.attempts,
      );

      throw new BadRequestException('too_many_otp_attempts');
    }

    const validOtp = await bcrypt.compare(data.otp, otpRecord.otpHash);

    if (!validOtp) {
      const updatedOtp = await this.prisma.userOtp.update({
        where: { id: otpRecord.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });

      this.emitAudit({
        userId: otpRecord.user.id,
        actorType: resolveActorType(roles),
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        entityLabel: this.userLabel(otpRecord.user),
        diff: {
          purpose: 'password_change',
          result: 'failure',
          reason: 'wrong_otp',
        },
        metadata: { attempts: updatedOtp.attempts },
      });

      if (updatedOtp.attempts >= 5) {
        await this.lockoutUtil.lockAccountForOtpAbuse(otpRecord.user.id);

        this.emitOtpAbuseAlert(
          otpRecord.id,
          otpRecord.user.id,
          'password_change',
          updatedOtp.attempts,
        );
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
        this.emitAudit({
          userId: otpRecord.user.id,
          actorType: resolveActorType(roles),
          action: AuditEventEnum.OTP_VERIFIED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: this.userLabel(otpRecord.user),
          diff: {
            purpose: 'password_change',
            result: 'failure',
            reason: 'otp_already_claimed',
          },
        });
        throw new BadRequestException('invalid_or_expired_otp');
      }

      await tx.user.update({
        where: { id: otpRecord.user.id },
        data: { passwordHash: hashedPassword },
      });

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
      entityLabel: this.userLabel(otpRecord.user),
      diff: { method: 'otp', result: 'success', context: 'admin_change_password_completed' },
    });

    const changedEvent: PasswordChangedEvent = { userId: otpRecord.user.id };
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_CHANGED, changedEvent);

    return { message: 'password_changed' };
  }

  async adminChangeEmailInitiate(
    actor: CurrentUserDto,
    data: AdminChangeEmailDto,
  ): Promise<{ message: string }> {
    const actorRoles = actor.roles ?? [];
    const actorType = resolveActorType(actorRoles);

    this.assertActorIsAdmin(actor, AuditEventEnum.ADMIN_EMAIL_CHANGE_INITIATED);

    const newEmail = this.normalizeEmailOrThrow(data.newEmail);

    const admin = await this.prisma.user.findUnique({
      where: { id: actor.id },
    });

    if (!admin) {
      throw new NotFoundException('user_not_found');
    }

    if (admin.email === newEmail) {
      this.emitAudit({
        userId: actor.id,
        actorType,
        action: AuditEventEnum.ADMIN_EMAIL_CHANGE_INITIATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.INFO,
        entity: 'User',
        entityId: admin.id,
        entityLabel: this.userLabel(admin),
        diff: { result: 'failure', reason: 'email_unchanged' },
      });
      throw new BadRequestException('email_unchanged');
    }

    const emailInUse = await this.prisma.user.findUnique({ where: { email: newEmail } });

    if (emailInUse && emailInUse.id !== admin.id) {
      this.emitAudit({
        userId: actor.id,
        actorType,
        action: AuditEventEnum.ADMIN_EMAIL_CHANGE_INITIATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: admin.id,
        entityLabel: this.userLabel(admin),
        diff: { result: 'failure', reason: 'email_already_registered' },
        metadata: { attemptedEmail: newEmail, conflictingUserId: emailInUse.id },
      });
      throw new BadRequestException('email_already_registered');
    }

    try {
      await this.prisma.user.update({
        where: { id: admin.id },
        data: { email: newEmail, isEmailVerified: false },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        this.emitAudit({
          userId: actor.id,
          actorType,
          action: AuditEventEnum.ADMIN_EMAIL_CHANGE_INITIATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'User',
          entityId: admin.id,
          entityLabel: this.userLabel(admin),
          diff: { result: 'failure', reason: 'email_already_registered' },
          metadata: { attemptedEmail: newEmail, detectedBy: 'unique_constraint' },
        });
        throw new BadRequestException('email_already_registered');
      }
      throw error;
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.tokenUtil.hashOpaqueToken(rawToken, 'email_change');
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TOKEN_EXPIRES_MINUTES * 60 * 1000);

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

    try {
      await this.emailService.send(
        newEmail,
        renderEmailChangeVerificationSubject(),
        renderEmailChangeVerificationHtml({
          changeEmailLink,
          expiresInHours,
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
      actorType,
      action: AuditEventEnum.ADMIN_EMAIL_CHANGE_INITIATED,
      entity: 'User',
      entityId: admin.id,
      entityLabel: this.userLabel(admin),
      diff: {
        result: 'success',
        context: 'admin_email_change_initiated',
        previousEmail: admin.email,
        newEmail,
      },
    });

    return { message: 'email_change_verification_sent' };
  }

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
      this.emitAudit({
        userId: null,
        actorType: resolveActorType([]),
        action: AuditEventEnum.ADMIN_EMAIL_CHANGE_VERIFIED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: null,
        entityLabel: 'email_change_verification',
        diff: {
          purpose: 'email_change_verification',
          result: 'failure',
          reason: 'invalid_or_expired_token',
        },
      });
      throw new BadRequestException('invalid_or_expired_token');
    }

    const verifiedUser = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.userOtp.updateMany({
        where: {
          id: otpRecord.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });

      if (claimed.count === 0) {
        this.emitAudit({
          userId: otpRecord.userId,
          actorType: resolveActorType([]),
          action: AuditEventEnum.ADMIN_EMAIL_CHANGE_VERIFIED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: 'email_change_verification',
          diff: {
            purpose: 'email_change_verification',
            result: 'failure',
            reason: 'token_already_claimed',
          },
        });
        throw new BadRequestException('invalid_or_expired_token');
      }

      return tx.user.update({
        where: { id: otpRecord.userId },
        data: { isEmailVerified: true },
        include: { userRoles: { include: { role: true } } },
      });
    });

    this.emitAudit({
      userId: otpRecord.userId,
      actorType: resolveActorType(verifiedUser.userRoles.map((userRole) => userRole.role.name)),
      action: AuditEventEnum.ADMIN_EMAIL_CHANGE_VERIFIED,
      entity: 'UserOtp',
      entityId: otpRecord.id,
      entityLabel: verifiedUser.email ?? undefined,
      diff: { purpose: 'email_change_verification', result: 'success' },
    });

    return { message: 'email_changed' };
  }

  private normalizePhoneOrThrow(phone: string): string {
    try {
      return normalizePhoneNumber(phone);
    } catch {
      throw new BadRequestException('invalid_phone_number');
    }
  }

  private normalizeEmailOrThrow(email: string): string {
    try {
      return normalizeEmail(email);
    } catch {
      throw new BadRequestException('invalid_email');
    }
  }

  private maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    return `${local.slice(0, 1)}***@${domain}`;
  }

  // AR-13. Undoes a pending promotion: the emailed link stops working and the unverified
  // email that initiate wrote on the account is cleared. The user keeps their normal account.
  async promoteUserCancel(
    actor: CurrentUserDto,
    data: PromoteCancelDto,
  ): Promise<{ message: string }> {
    const actorType = resolveActorType(actor.roles ?? []);

    this.assertSuperAdmin(actor, AuditEventEnum.USER_PROMOTION_CANCELLED);

    const phone = this.normalizePhoneOrThrow(data.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);

    if (this.hasAdminRole(roles) || user.isEmailVerified) {
      this.emitAudit({
        userId: actor.id,
        targetUserId: user.id,
        actorType,
        action: AuditEventEnum.USER_PROMOTION_CANCELLED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userLabel(user),
        diff: { result: 'failure', reason: 'promotion_already_completed' },
      });
      throw new BadRequestException('promotion_already_completed');
    }

    const pending = await this.prisma.userOtp.findFirst({
      where: { userId: user.id, purpose: UserOtpPurposeEnum.promotion_verification, usedAt: null },
      select: { id: true },
    });

    if (!pending) {
      throw new NotFoundException('no_pending_promotion');
    }

    const cancelledEmail = user.email;

    await this.prisma.$transaction([
      this.prisma.userOtp.updateMany({
        where: {
          userId: user.id,
          purpose: UserOtpPurposeEnum.promotion_verification,
          usedAt: null,
        },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({ where: { id: user.id }, data: { email: null } }),
    ]);

    this.emitAudit({
      userId: actor.id,
      targetUserId: user.id,
      actorType,
      action: AuditEventEnum.USER_PROMOTION_CANCELLED,
      entity: 'User',
      entityId: user.id,
      entityLabel: this.userLabel(user),
      diff: { result: 'success', context: 'promotion_cancelled' },
      metadata: { cancelledEmail },
    });

    return { message: 'promotion_cancelled' };
  }

  // AR-14
  async listPendingPromotions(actor: CurrentUserDto) {
    this.assertSuperAdmin(actor, AuditEventEnum.USER_PROMOTION_INITIATED);

    const pending = await this.prisma.userOtp.findMany({
      where: { purpose: UserOtpPurposeEnum.promotion_verification, usedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        user: { select: { id: true, name: true, phone: true, email: true } },
      },
    });

    const now = new Date();

    return pending.map((item) => ({
      id: item.id,
      userId: item.user.id,
      name: item.user.name,
      phone: item.user.phone,
      email: item.user.email,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      expired: item.expiresAt < now,
    }));
  }

  // AR-15. A registration is pending while the invited admin has not set a password yet.
  async listPendingRegistrations(actor: CurrentUserDto) {
    this.assertSuperAdmin(actor, AuditEventEnum.ADMIN_REGISTERED);

    const pending = await this.prisma.user.findMany({
      where: { passwordHash: null, inviteTokenHash: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        inviteTokenExpiresAt: true,
      },
    });

    const now = new Date();

    return pending.map((item) => ({
      id: item.id,
      name: item.name,
      email: item.email,
      createdAt: item.createdAt,
      expiresAt: item.inviteTokenExpiresAt,
      expired: item.inviteTokenExpiresAt ? item.inviteTokenExpiresAt < now : true,
    }));
  }

  // AR-16. Same empty-handed refusals as adminForgotPassword, plus a 30-second gap and an hourly cap.
  async adminResendForgotPasswordOtp(verificationId: string): Promise<{ verificationId: string }> {
    const oldOtp = await this.prisma.userOtp.findUnique({
      where: { id: verificationId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
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

    if (!oldOtp.user.isActive || !oldOtp.user.email || !this.hasAdminRole(roles)) {
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

    const { verificationId: newVerificationId } = await this.otpUtil.issueAndSendOtp(
      oldOtp.userId,
      oldOtp.user.email,
      UserOtpPurposeEnum.password_reset,
      OtpChannelEnum.email,
    );

    return { verificationId: newVerificationId };
  }

  // AR-17. Sends a fresh link to the pending new email; the old link stops working.
  async adminChangeEmailResend(
    actor: CurrentUserDto,
    data: AdminChangeEmailResendDto,
  ): Promise<{ message: string }> {
    const actorType = resolveActorType(actor.roles ?? []);

    this.assertActorIsAdmin(actor, AuditEventEnum.ADMIN_EMAIL_CHANGE_INITIATED);

    const admin = await this.prisma.user.findUnique({ where: { id: actor.id } });

    if (!admin) {
      throw new NotFoundException('user_not_found');
    }

    // An email change in progress is an unverified email on the account.
    if (!admin.email || admin.isEmailVerified) {
      throw new BadRequestException('no_pending_email_change');
    }

    if (data.newEmail && this.normalizeEmailOrThrow(data.newEmail) !== admin.email) {
      throw new BadRequestException('email_does_not_match_pending_change');
    }

    const lastOtp = await this.prisma.userOtp.findFirst({
      where: { userId: admin.id, purpose: UserOtpPurposeEnum.email_verification },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (lastOtp && Date.now() - lastOtp.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      throw new BadRequestException('resend_too_soon');
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.tokenUtil.hashOpaqueToken(rawToken, 'email_change');
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TOKEN_EXPIRES_MINUTES * 60 * 1000);

    await this.prisma.userOtp.updateMany({
      where: { userId: admin.id, purpose: UserOtpPurposeEnum.email_verification, usedAt: null },
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

    try {
      await this.emailService.send(
        admin.email,
        renderEmailChangeVerificationSubject(),
        renderEmailChangeVerificationHtml({ changeEmailLink, expiresInHours }),
      );
    } catch (error) {
      console.error(
        `[EHTE EMAIL] Failed to resend email-change verification to ${admin.email}`,
        error,
      );
    }

    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] Resent email-change link for ${admin.email}: ${changeEmailLink}`);
    }

    this.emitAudit({
      userId: admin.id,
      actorType,
      action: AuditEventEnum.ADMIN_EMAIL_CHANGE_INITIATED,
      entity: 'User',
      entityId: admin.id,
      entityLabel: this.userLabel(admin),
      diff: { result: 'success', context: 'admin_email_change_resent' },
      metadata: { pendingEmail: this.maskEmail(admin.email) },
    });

    return { message: 'email_change_verification_resent' };
  }

  // AR-18 / AR-19 / AR-20. These reuse the user-side logic, which already handles the refresh
  // token, the session cache and the audit trail, so there is one implementation to maintain.
  async adminLogout(actor: CurrentUserDto, req: any): Promise<{ message: string }> {
    this.assertActorIsAdmin(actor, AuditEventEnum.LOGOUT);
    return this.authService.logout(actor, req);
  }

  async adminRefresh(data: RefreshTokenDto): Promise<TokenPair> {
    return this.authService.refresh(data);
  }

  async adminLogoutAll(actor: CurrentUserDto, req: any) {
    this.assertActorIsAdmin(actor, AuditEventEnum.LOGOUT);
    return this.authService.logoutAll(actor, req);
  }

  // AR-21
  async adminMe(actor: CurrentUserDto) {
    this.assertActorIsAdmin(actor, AuditEventEnum.LOGIN_SUCCESS);

    const user = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
        isEmailVerified: true,
        createdAt: true,
        userRoles: {
          select: {
            role: {
              select: {
                name: true,
                rolePermissions: { select: { permission: { select: { name: true } } } },
              },
            },
          },
        },
        twoFactorSecret: { select: { isEnabled: true } },
      },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    // The newest sign-in is this session's own; the one before it is the "last sign-in" to show.
    const signIns = await this.prisma.auditLog.findMany({
      where: { userId: actor.id, action: AuditEventEnum.LOGIN_SUCCESS },
      orderBy: { createdAt: 'desc' },
      take: 2,
      select: { createdAt: true, ipAddress: true, country: true, city: true, userAgent: true },
    });

    const { userRoles, twoFactorSecret, ...profile } = user;

    return {
      ...profile,
      roles: userRoles.map((userRole) => userRole.role.name),
      permissions: this.derivePermissions(userRoles).sort(),
      twoFactorEnabled: Boolean(twoFactorSecret?.isEnabled),
      currentSignIn: signIns[0] ?? null,
      lastSignIn: signIns[1] ?? null,
    };
  }

  // AR-22. Removes only the ADMIN role. The user keeps every other role; if that would leave
  // them with none, they go back to USER. Sessions are ended so the old permissions stop at once.
  async demoteAdmin(
    actor: CurrentUserDto,
    data: DemoteAdminDto,
  ): Promise<{ message: string; remainingRoles: string[] }> {
    const actorType = resolveActorType(actor.roles ?? []);

    this.assertSuperAdmin(actor, AuditEventEnum.ADMIN_DEMOTED);

    const reason = (data.reason ?? '').trim();

    if (reason.length < 5) {
      throw new BadRequestException('reason_required');
    }

    const deny = (code: string, targetId: string, label?: string): never => {
      this.emitAudit({
        userId: actor.id,
        targetUserId: targetId,
        actorType,
        action: AuditEventEnum.ADMIN_DEMOTED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetId,
        entityLabel: label,
        diff: { result: 'denied', reason: code },
      });
      throw new BadRequestException(code);
    };

    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    const roles = user.userRoles.map((userRole) => userRole.role.name);

    if (user.id === actor.id) deny('cannot_demote_self', user.id, this.userLabel(user));

    // The last Super Admin (and any Super Admin) is never demoted through this route.
    if (roles.includes(RolesEnum.SUPER_ADMIN)) {
      deny('cannot_demote_super_admin', user.id, this.userLabel(user));
    }

    const adminRow = user.userRoles.find((userRole) => userRole.role.name === RolesEnum.ADMIN);

    if (!adminRow) deny('user_is_not_admin', user.id, this.userLabel(user));

    const remaining = roles.filter((name) => name !== RolesEnum.ADMIN);
    const needsUserRole = remaining.length === 0;

    let sessionsRevoked = 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.delete({ where: { id: adminRow!.id } });

      if (needsUserRole) {
        const userRole = await tx.role.findUnique({ where: { name: RolesEnum.USER } });

        if (!userRole) {
          throw new BadRequestException('user_role_not_configured');
        }

        await tx.userRole.create({
          data: { userId: user.id, roleId: userRole.id, assignedBy: actor.id },
        });
      }

      const revoked = await tx.session.deleteMany({ where: { userId: user.id } });
      sessionsRevoked = revoked.count;
    });

    await this.cache.purgeUserCache(user.id);

    const remainingRoles = needsUserRole ? [RolesEnum.USER] : remaining;

    this.emitAudit({
      userId: actor.id,
      targetUserId: user.id,
      actorType,
      action: AuditEventEnum.ADMIN_DEMOTED,
      entity: 'User',
      entityId: user.id,
      entityLabel: this.userLabel(user),
      diff: {
        result: 'success',
        reason,
        previousRoles: roles,
        removedRole: RolesEnum.ADMIN,
        remainingRoles,
      },
      metadata: { sessionsRevoked },
    });

    return { message: 'admin_demoted', remainingRoles };
  }

  // AR-24
  async listMySessions(actor: CurrentUserDto) {
    this.assertActorIsAdmin(actor, AuditEventEnum.LOGIN_SUCCESS);

    return this.prisma.session.findMany({
      where: { userId: actor.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        lastActiveAt: true,
        deviceLabel: true,
        userAgent: true,
        ipAddress: true,
      },
    });
  }

  // AR-25. Deletes the session; marking it revoked would look like a stolen token on refresh.
  async revokeMySession(actor: CurrentUserDto, sessionId: string): Promise<{ message: string }> {
    this.assertActorIsAdmin(actor, AuditEventEnum.ADMIN_SESSION_REVOKED);

    const deleted = await this.prisma.session.deleteMany({
      where: { id: sessionId, userId: actor.id },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('session_not_found');
    }

    await this.cache.purgeUserCache(actor.id);

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action: AuditEventEnum.ADMIN_SESSION_REVOKED,
      entity: 'Session',
      entityId: sessionId,
      diff: { result: 'success' },
    });

    return { message: 'session_revoked' };
  }

  // AR-28. Built from the audit trail, so it needs no extra writes in the login code.
  async loginHistory(actor: CurrentUserDto, query: AdminLoginHistoryQueryDto) {
    this.assertSuperAdmin(actor, AuditEventEnum.LOGIN_SUCCESS);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const actions =
      query.result === 'SUCCESS'
        ? [AuditEventEnum.LOGIN_SUCCESS]
        : query.result
          ? [AuditEventEnum.LOGIN_FAILED]
          : [AuditEventEnum.LOGIN_SUCCESS, AuditEventEnum.LOGIN_FAILED];

    const where: Prisma.AuditLogWhereInput = {
      action: { in: actions },
      diff: { path: ['context'], equals: ADMIN_LOGIN_CONTEXT },
      ...(query.adminId ? { userId: query.adminId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          createdAt: true,
          action: true,
          userId: true,
          actorName: true,
          entityLabel: true,
          ipAddress: true,
          userAgent: true,
          country: true,
          city: true,
          diff: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const items = rows.map(({ diff, action, ...row }) => {
      const reason =
        diff && typeof diff === 'object' && !Array.isArray(diff) && typeof diff.reason === 'string'
          ? diff.reason
          : null;
      const result =
        action === AuditEventEnum.LOGIN_SUCCESS
          ? 'SUCCESS'
          : reason && reason.includes('lock')
            ? 'LOCKED'
            : 'FAILED';

      return { ...row, result, reason };
    });

    return {
      items: query.result === 'LOCKED' ? items.filter((i) => i.result === 'LOCKED') : items,
      total,
      page,
      limit,
    };
  }

  // AR-78
  async statsLogins(actor: CurrentUserDto, query: AdminStatsQueryDto) {
    this.assertSuperAdmin(actor, AuditEventEnum.LOGIN_SUCCESS);

    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const interval =
      query.interval === 'week' || query.interval === 'month' ? query.interval : 'day';

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new BadRequestException('invalid_period');
    }

    const rows = await this.prisma.$queryRaw<{ bucket: Date; action: string; count: bigint }[]>(
      Prisma.sql`
        SELECT date_trunc(${interval}::text, "createdAt") AS bucket, action, COUNT(*)::bigint AS count
        FROM audit_log
        WHERE "createdAt" >= ${from}
          AND "createdAt" <= ${to}
          AND action IN (${Prisma.join([AuditEventEnum.LOGIN_SUCCESS, AuditEventEnum.LOGIN_FAILED])})
          AND diff->>'context' = ${ADMIN_LOGIN_CONTEXT}
        GROUP BY 1, 2
        ORDER BY 1
      `,
    );

    const buckets = new Map<string, { date: string; signIns: number; failures: number }>();

    for (const row of rows) {
      const key = row.bucket.toISOString();
      if (!buckets.has(key)) buckets.set(key, { date: key, signIns: 0, failures: 0 });
      const bucket = buckets.get(key)!;
      if (row.action === AuditEventEnum.LOGIN_SUCCESS) bucket.signIns = Number(row.count);
      else bucket.failures = Number(row.count);
    }

    const series = [...buckets.values()];

    const lockedNow = await this.prisma.user.count({
      where: {
        lockedUntil: { gt: new Date() },
        userRoles: { some: { role: { name: { notIn: NON_INVITABLE_ROLE_NAMES } } } },
      },
    });

    return {
      period: { from, to, interval },
      totals: {
        signIns: series.reduce((sum, b) => sum + b.signIns, 0),
        failures: series.reduce((sum, b) => sum + b.failures, 0),
        // Lockouts are a point-in-time count: admin accounts locked right now.
        adminsLockedNow: lockedNow,
      },
      series,
    };
  }

  // AR-79. Staff roles only; the USER role is excluded so the counts stay fast and meaningful.
  async stats2faAdoption(actor: CurrentUserDto) {
    this.assertSuperAdmin(actor, AuditEventEnum.LOGIN_SUCCESS);

    const roles = await this.prisma.role.findMany({
      where: { name: { notIn: NON_INVITABLE_ROLE_NAMES } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });

    const rows = await Promise.all(
      roles.map(async (role) => {
        const [total, enrolled] = await Promise.all([
          this.prisma.userRole.count({ where: { roleId: role.id } }),
          this.prisma.userRole.count({
            where: { roleId: role.id, user: { twoFactorSecret: { isEnabled: true } } },
          }),
        ]);

        return {
          role: role.name,
          accounts: total,
          withTwoFactor: enrolled,
          percent: total === 0 ? 0 : Math.round((enrolled / total) * 1000) / 10,
        };
      }),
    );

    return { roles: rows };
  }
}

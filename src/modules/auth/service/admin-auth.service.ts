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
} from '../dto/admin-auth.dto';

type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

const REGISTRATION_TOKEN_EXPIRES_MINUTES = 60 * 24;
const PROMOTION_TOKEN_EXPIRES_MINUTES = 60 * 24;
const EMAIL_CHANGE_TOKEN_EXPIRES_MINUTES = 60;

const ADMIN_ROLES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

// Cast until AuditEventPayload's actorType union gains a SYSTEM variant, same as ReportService/PostService
const SYSTEM_ACTOR_TYPE = 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>;

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
    private readonly emailService: EmailService,
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
      await this.emailService.sendEmail(
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

    const invitableRoles = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];
    if (data.roles.some((role) => !invitableRoles.includes(role))) {
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
        },
      });

      return { adminId: existingUser.id, message: 'admin_registered' };
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
      await this.emailService.sendEmail(
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
      await this.emailService.sendEmail(
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
      await this.emailService.sendEmail(
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
}

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

import { sendEmail } from 'src/services/email/email.service';
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

const REGISTRATION_TOKEN_EXPIRES_MINUTES = 60 * 24; // 24h to complete registration
const PROMOTION_TOKEN_EXPIRES_MINUTES = 60 * 24; // 24h to click the promotion email link
const EMAIL_CHANGE_TOKEN_EXPIRES_MINUTES = 60; // 1h to click the email-change verification link

const ADMIN_ROLES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

// ASSUMPTION: resolveActorType only knows about role-bearing actors; cast until
// AuditEventPayload's actorType union is extended with a SYSTEM variant. Same cast
// ReportService/PostService use for system-triggered rows.
const SYSTEM_ACTOR_TYPE = 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>;

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

  // Human-readable label for a User entity row — name, falling back to email — so an
  // audit list identifies *which* user without joining back to the users table.
  private userLabel(user: { name?: string | null; email?: string | null }): string | undefined {
    return user.name ?? user.email ?? undefined;
  }

  // ─────────────────────────────────────────────
  // ACCESS CONTROL HELPERS
  //
  // FIX (audit review, item #1): every SUPER_ADMIN-only / admin-only guard in this file
  // threw 'insufficient_permissions' with no audit trail at all. These two helpers write
  // a DENIED/WARNING row before throwing, so a non-super-admin attempting to invite,
  // promote, or cancel admins is visible in the log instead of leaving no trace.
  // Callers pass the specific action being attempted so the row records what was
  // actually blocked.
  // ─────────────────────────────────────────────

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

  // FIX (audit review, items #1/#2): the OTP-abuse lockout is a SYSTEM action taken
  // against the account that owns the OTP — there is no human actor. Previously this was
  // written as userId = the locked account with no outcome/severity, which read as a
  // routine SUCCESS/INFO row performed *by* that user. It is now recorded as
  // targetUserId + SYSTEM actor, outcome DENIED, severity WARNING. Shared by both
  // OTP-claim flows (reset / change password), and by both attempt-limit branches in each.
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

  // Shared token/link/email logic for issuing (or re-issuing) an admin registration
  // invite. Used by adminRegister() — both on first invite and when re-inviting an
  // email whose registration is still pending — and by adminRegisterResend().
  // Overwrites any previous invite token, so a stale/leaked link is invalidated as a
  // side effect of calling this.
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
  }

  // ADMIN — REGISTER: leaves the account inactive/"REGISTERING" until password is set.
  //
  // If the email belongs to a still-pending (never-completed) registration — i.e. no
  // password has ever been set and the account was never activated — this re-issues a
  // fresh invite instead of blocking with "email_already_registered". This mirrors
  // AuthService.signup()'s "unverified existing account: resend" behavior on the user
  // side. Only an email whose registration has actually completed (passwordHash set,
  // or isActive) is refused as genuinely taken.
  //
  // FIX (audit review, item #2): the actor here is the SUPER_ADMIN doing the inviting,
  // and the affected user is the invited admin. Both rows previously had that backwards —
  // userId was the invited admin (with actorType resolved from the *invited* roles) and
  // the real actor was smuggled into diff.registeredBy. Now userId = creator,
  // targetUserId = invited admin, actorType resolved from the creator's roles, and the
  // redundant diff.registeredBy is gone.
  //
  // FIX (audit review, item #1): every guard here (insufficient permissions, non-admin
  // role in the invite, email already registered — both the up-front check and the P2002
  // race — and unconfigured roles) threw with no audit row. All now emit DENIED/FAILURE
  // first. The pre-creation failures use entityId: null since there is no User row yet
  // (same null-entityId shape LOGIN_FAILED already uses for unknown accounts).

  async adminRegister(
    creator: CurrentUserDto,
    data: AdminRegisterDto,
  ): Promise<{ adminId: string; message: string }> {
    // Restricted to SUPER_ADMIN
    const creatorRoles = creator.roles ?? [];
    const actorType = resolveActorType(creatorRoles);

    this.assertSuperAdmin(creator, AuditEventEnum.ADMIN_REGISTERED, {
      attemptedRoles: data.roles,
    });

    const email = this.normalizeEmailOrThrow(data.email);

    // Defense-in-depth check against inviting with a non-admin role (permanently locked out).
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
      // Registration already completed (password set, or account active) — genuinely taken.
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

      // Pending, never-completed registration — re-issue a fresh invite rather than
      // blocking the super admin with no way to recover (e.g. the original email
      // bounced or was mistyped).
      //
      // NOTE: this does not update existingUser's roles to match data.roles if they
      // differ from the original invite — only the invite token/link is refreshed. If
      // the invited roles need to change, cancel the pending registration
      // (adminCancelRegistration) and re-invite from scratch instead.
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

    // Resolve every requested role up front so a typo'd role fails before any writes.
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
          // No phone, no password — this is the "REGISTERING" state
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
      // Closes the race between the existingUser check above and this write.
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
          metadata: { attemptedEmail: email, attemptedRoles: data.roles, detectedBy: 'unique_constraint' },
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

  // ADMIN — RESEND REGISTRATION: only valid while still "REGISTERING" (no password set).
  //
  // FIX (audit review, item #2): same actor/target inversion as adminRegister() — userId
  // was the invited admin, actorType was resolveActorType([]) (i.e. no roles at all), and
  // the SUPER_ADMIN who actually triggered the resend was only in diff.resentBy. Now
  // userId = creator (with their real actorType), targetUserId = invited admin.
  //
  // FIX (audit review, item #1): insufficient-permissions and registration-already-
  // completed guards now emit before throwing.

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

    // Once a password has been set (or activated), the registration flow is complete.
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

  // ADMIN — COMPLETE REGISTRATION: token proves inbox control, sets password + activates.
  //
  // FIX (audit review, item #1): both token guards (invalid/expired, and already-used)
  // threw with no audit row. This is an unauthenticated endpoint, so a burst of failures
  // here is exactly what someone guessing registration tokens looks like. Both now emit a
  // FAILURE/WARNING row first. Uses the same PASSWORD_CHANGED action + context as the
  // success row below, so the two are easy to pair up. When the token doesn't match any
  // user there is no account to attach the row to, so userId/entityId are null (same
  // shape LOGIN_FAILED uses for unknown accounts).
  //
  // NOTE (not changed): the `admin_email_missing` guard further down runs AFTER the
  // password has been set and the account activated, and after the success row has been
  // emitted — so in that (should-never-happen) case the log says SUCCESS but the caller
  // gets a 400 and no tokens. Worth moving the guard above the write; left alone here
  // because that's a behavior change rather than an audit fix.

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
      // Registration token already used to set a password once
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
      entityLabel: this.userLabel(admin),
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
  //
  // FIX (audit review, item #1): insufficient-permissions and registration-already-
  // completed guards now emit before throwing.
  //
  // FIX (audit review, item #4): the row being deleted is gone by the time anyone reads
  // this log, so entityLabel now carries the cancelled invite's email (it used to live
  // only in diff.cancelledEmail, and diff.cancelledBy just duplicated userId).
  //
  // NOTE (item #2, deliberately NOT applied on the success row): targetUserId is left off
  // because the target user is deleted in this same call — if AuditLog.targetUserId is a
  // foreign key to User, writing a deleted user's id there would fail the insert. entityId
  // still records the id; the failure rows above (user still exists) do set targetUserId.

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
      // Already completed — use UserController's deactivate/revoke-role endpoints instead.
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

  // ADMIN — PROMOTE EXISTING USER (STEP 1): attaches an email; ADMIN role granted at verify.
  //
  // FIX (audit review, item #2): the promoted user is the affected party, the SUPER_ADMIN
  // is the actor. userId was the promoted user (actorType from *their* roles) with the
  // real actor in diff.initiatedBy. Now userId = actor, targetUserId = promoted user.
  //
  // FIX (audit review, item #1): every guard (insufficient permissions, user inactive,
  // phone unverified, already admin, email already registered — both the up-front check
  // and the P2002 race) now emits before throwing. The two "not eligible" guards share
  // one error code externally, but are recorded with distinct reasons.
  //
  // FIX (audit review, item #5): otpId isn't a diff of anything — moved to metadata as
  // promotionOtpId.

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

    // Requires the existing account to be active and phone-verified before promotion.
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

    // Attach the email now (unverified); ADMIN role granted only after verify.
    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { email, isEmailVerified: false },
      });
    } catch (error) {
      // Closes the race between the emailInUse check above and this write.
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

    // The clickable link is the proof of inbox ownership, so a high-entropy raw token is used.
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.tokenUtil.hashOpaqueToken(rawToken, 'promotion');
    const expiresAt = new Date(Date.now() + PROMOTION_TOKEN_EXPIRES_MINUTES * 60 * 1000);

    // Invalidate any previous unused promotion link for this user. This also makes a
    // repeat call to promoteUserInitiate() for the same still-pending user safe: it
    // simply supersedes the old link with a fresh one rather than erroring.
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

  // ADMIN — RESEND PROMOTION: fresh token for a still-pending (unverified) promotion.
  //
  // FIX (audit review, item #2): same actor/target inversion as promoteUserInitiate() —
  // now userId = actor, targetUserId = user being promoted (diff.resentBy dropped).
  //
  // FIX (audit review, item #1): insufficient-permissions, promotion-not-initiated,
  // already-admin, and promotion-already-completed guards now emit before throwing.

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
      // promoteUserInitiate() was never called for this user
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
      // Already completed — nothing pending to resend
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

    // Invalidate any previous unused promotion link, same as promoteUserInitiate().
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

  // ADMIN — PROMOTE EXISTING USER (STEP 2): possessing the token proves email ownership.
  //
  // FIX (audit review, item #1): the invalid/expired-token guard, the
  // admin-role-not-configured guard, and the lost-the-claim-race guard inside the
  // transaction all threw with no audit row. All now emit OTP_VERIFIED / FAILURE first
  // (the same action + entity the success row uses). When the token doesn't match any
  // OTP there is no entity to attach to, so entityId is null. The raw token / hash is
  // never written to the log.
  //
  // FIX (audit review, item #4): entityLabel added — the promoted user's name/email on
  // the UserOtp row, so the list shows who the row is about without a join.

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

  // ADMIN — FORGOT PASSWORD: email-only; masks "no account"/"not admin"/"inactive" identically.
  // Already the email-OTP path (see OtpChannelEnum.email below) — kept unchanged.
  //
  // FIX (audit review, item #1): the masked branch returned an empty verificationId with
  // no trace at all — so probing the admin forgot-password endpoint with non-admin or
  // deactivated accounts was invisible. The *response* to the caller is still masked
  // identically, but an internal DENIED row now records why. Severity is WARNING when a
  // real account was targeted (not an admin / inactive) and INFO for a plain unknown
  // email, which is noisy typo traffic on a public endpoint.
  //
  // NOTE: no success row is added here — OtpUtil.issueAndSendOtp() is outside this file
  // and may already audit the issuance; adding one here risked double-logging.

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

  // ADMIN — LOGIN BY EMAIL: the only admin credential path; also requires isEmailVerified.
  //
  // FIX (audit review, item #1): every LOGIN_FAILED row here was written with no outcome
  // or severity, so each one fell through to the default SUCCESS/INFO — a failed admin
  // login was being recorded as a successful, informational event. Now:
  //   - bad credentials / unknown account / not an admin / email unverified → FAILURE
  //   - locked account, inactive account (policy refusals)                  → DENIED
  // all at WARNING severity. The first branch also gains a specific diff.reason
  // (unknown_account / not_an_admin / password_not_set / email_not_verified) — internal
  // only, the caller still gets the same masked 'invalid_credentials'.
  //
  // FIX (audit review, item #5): the attempted email goes in metadata on the
  // unknown-account/not-admin branch — without it a failed login for an account that
  // doesn't exist has nothing identifying what was tried.
  //
  // (userId stays as the account being logged into on these rows — for unauthenticated
  // self-service flows there is no separate actor, which is the convention LOGIN_FAILED
  // already established here.)

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

  // ADMIN — RESET PASSWORD (FORGOT-PASSWORD FLOW): verifies the OTP owner is actually an
  // admin, then runs the same OTP-claim + password-update flow AuthService.resetPassword()
  // uses (duplicated here since admin-auth/ doesn't import from auth/). Reached only via
  // adminForgotPassword() — i.e. the admin does NOT already know their current password.
  // Contrast with adminChangePasswordInitiate/Verify below, which is for an admin who DOES
  // know their current password and wants to change it while logged in.
  //
  // FIX (audit review, item #1): the OTP guards here left no trace except the
  // attempts >= 5 SECURITY_ALERT. Now:
  //   - invalid / wrong-purpose / used / expired OTP     → OTP_VERIFIED FAILURE
  //   - OTP owner isn't an admin                          → OTP_VERIFIED DENIED
  //   - wrong OTP value (below the lockout threshold)     → OTP_VERIFIED FAILURE, with the
  //     running attempt count in metadata (the individual attempts leading up to a lockout
  //     were previously invisible; only the final SECURITY_ALERT existed)
  //   - lost the claim race inside the transaction        → OTP_VERIFIED FAILURE
  // Each carries a specific diff.reason. Uses the UserOtp entity, matching the SECURITY_ALERT
  // rows and promoteUserVerify's OTP_VERIFIED rows.
  //
  // FIX (audit review, items #1/#2): both SECURITY_ALERT rows now go through
  // emitOtpAbuseAlert() — SYSTEM actor, targetUserId = the locked account, DENIED/WARNING.
  //
  // FIX (audit review, item #4): the OTP lookup now also selects the user's name/email
  // so rows can carry an entityLabel.

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
      entityLabel: this.userLabel(otpRecord.user),
      diff: { method: 'otp', result: 'success', context: 'admin_reset_password' },
    });

    // Notify after successful transaction — same as AuthService.resetPassword().
    const resetEvent: PasswordResetEvent = { userId: otpRecord.user.id };
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_RESET, resetEvent);

    return { message: 'password_reset_successful' };
  }

  // ADMIN — CHANGE PASSWORD (STEP 1): authenticated admin proves they still know their
  // current password, then an OTP is emailed to their own address before a new password
  // is accepted. This is the dedicated admin-only self-service flow — the shared USER
  // /auth/change-password endpoint (AuthService.changePassword()) now rejects any
  // account holding an admin role and points it here instead.
  //
  // FIX (audit review, item #1): the not-an-admin, password-not-set, WRONG CURRENT
  // PASSWORD, and admin-email-missing guards all threw with no audit row. The wrong-
  // current-password one matters most — on an already-authenticated session it can mean
  // a hijacked session probing for the real password. All now emit before throwing, under
  // PASSWORD_CHANGED (there is no dedicated "password change initiated" event) with
  // context 'admin_change_password_initiated' to pair with the existing
  // 'admin_change_password_completed' success row from step 2.
  //
  // NOTE (not changed — needs a decision): there is still no *success* audit row for step
  // 1, because no suitable AuditEventEnum value exists for it (unlike
  // ADMIN_EMAIL_CHANGE_INITIATED / USER_PROMOTION_INITIATED on the sibling flows). Adding
  // one means adding it to the audit catalog. Also, unlike login, a wrong current password
  // here isn't counted toward any lockout, so it can be retried without limit.

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
      // Shouldn't happen for an admin account, but guard anyway — there's nowhere to send the OTP.
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

    // Dedicated password_change purpose (distinct from password_reset, which stays
    // scoped to adminForgotPassword()/adminResetPassword()) — same email channel and
    // proof-of-inbox pattern, just reached only after the current-password check above,
    // and no longer redeemable via the forgot-password /verify endpoint or vice versa.
    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      admin.id,
      admin.email,
      UserOtpPurposeEnum.password_change,
      OtpChannelEnum.email,
    );

    return { verificationId };
  }

  // ADMIN — CHANGE PASSWORD (STEP 2): possessing the emailed OTP proves inbox control.
  // Mirrors adminResetPassword()'s OTP-claim pattern; kept as a separate method (rather
  // than calling adminResetPassword() directly) so the two flows stay independently
  // auditable, matching this file's existing register/promote/reset duplication pattern.
  //
  // FIX (audit review, items #1/#2/#4): identical treatment to adminResetPassword() — the
  // OTP guards now emit OTP_VERIFIED FAILURE/DENIED rows, both SECURITY_ALERT rows go
  // through emitOtpAbuseAlert() (SYSTEM actor, targetUserId), and the OTP lookup selects
  // name/email for entityLabel.

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

      this.emitOtpAbuseAlert(otpRecord.id, otpRecord.user.id, 'password_change', otpRecord.attempts);

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
      entityLabel: this.userLabel(otpRecord.user),
      diff: { method: 'otp', result: 'success', context: 'admin_change_password_completed' },
    });

    // Notify after successful transaction — same as AuthService.changePasswordVerify().
    const changedEvent: PasswordChangedEvent = { userId: otpRecord.user.id };
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_CHANGED, changedEvent);

    return { message: 'password_changed' };
  }

  // Self-service admin email change (STEP 1): gated by re-authentication at the controller.
  //
  // FIX (audit review, item #1): the not-an-admin, email-unchanged, and email-already-
  // registered (up-front check and P2002 race) guards now emit before throwing.
  //
  // FIX (audit review): diff now records previousEmail alongside newEmail — the row
  // describes a state change (old address -> new address), and without the old value an
  // email swap on an admin account couldn't be reconstructed from the log.

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

    // Attach the new email now (unverified) — same immediate-attach pattern as promotion.
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

    // Dedicated link-based template — previously this borrowed the OTP-code template
    // as a stand-in, which read wrong ("Your OTP is: https://...") for a clickable link.
    try {
      await sendEmail(
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

  // ADMIN — CHANGE EMAIL (STEP 2): possessing the token proves control of the new inbox.
  //
  // FIX (audit review, item #1): the invalid/expired-token guard and the lost-the-claim-
  // race guard inside the transaction now emit ADMIN_EMAIL_CHANGE_VERIFIED / FAILURE
  // before throwing. With no matching OTP there's no entity to attach to, so entityId is
  // null (the token itself is never logged).
  //
  // FIX (audit review, items #4): the success row previously used resolveActorType([]) —
  // i.e. an actor with no roles at all — because the user was never loaded. The
  // transaction's user update now returns the user + roles, so actorType resolves from
  // their real roles and entityLabel can carry the verified email.

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
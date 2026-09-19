import {
  BadRequestException,
  Injectable,
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

// Minimal shapes the OTP audit helpers need, so each call site can pass
// exactly what it has without dragging the whole Prisma row through.
type OtpAuditRecord = { id: string; purpose: UserOtpPurposeEnum; attempts: number };
type OtpAuditUser = { id: string; name: string | null };

// JSON-safe scalar map for audit `metadata` — keeps helper params assignable to
// whatever JSON type AuditEventPayload.metadata is declared as.
type AuditMetadata = Record<string, string | number | boolean | null>;

// ASSUMPTION: resolveActorType only knows about role-bearing actors; cast until
// AuditEventPayload's actorType union is extended with a SYSTEM variant. Same
// cast ReportService/PostService use.
const SYSTEM_ACTOR = 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>;

// ─────────────────────────────────────────────
// AUDIT CONVENTIONS USED IN THIS FILE (FIX — audit review)
//
// - outcome DENIED  : access blocked even though the request was well-formed
//                     (account locked/inactive, wrong role for this endpoint,
//                     OTP that isn't valid for this operation).
// - outcome FAILURE : the attempt itself failed (bad credentials, wrong OTP
//                     digits, lost a concurrency race, bad current password).
// - severity        : WARNING on every denied/failed path so they're filterable;
//                     INFO only for routine expiry; CRITICAL for events that
//                     imply compromise or a broken system (see the two call
//                     sites using it).
// - diff.reason     : machine-readable failure code. No call site in this
//                     service carries a human-written note (there are no admin
//                     notes/rejection reasons in auth), so nothing needs to be
//                     promoted to the top-level `reason` column.
// - metadata        : context that is not a state change (auth method, OTP
//                     purpose, attempt counts, revoked-session counts, masked
//                     attempted phone).
//
// DELIBERATELY UNAUDITED (no trustworthy identity/entity, or routine noise):
// - normalizePhoneOrThrow / requirePhone: malformed-input and data-integrity
//   400s with no identity attached.
// - refresh(): JWT signature/expiry failure (no verified identity to attach
//   to), and "session missing" / "session expired" — both are routine token
//   lifecycle (logout and password change hard-delete sessions), so a
//   SECURITY_ALERT per stale client would drown real signals. If you want
//   them, add a low-severity action to AuditEventEnum first.
// - resendSignupOtp(): no suitable AuditEventEnum member exists for OTP
//   resend (e.g. OTP_RESENT). Needs an enum addition, not a guess. OTP
//   *issuance* auditing presumably lives in OtpUtil.issueAndSendOtp — not
//   verifiable from this file.
//
// NOTE (entityLabel): self-actions on an authenticated request (logout) are
// already labelled by ActorContextInterceptor's actorName, so no extra read is
// made just to duplicate it. Pre-auth flows (signup, login, OTP, refresh) have
// no interceptor context, so they pass the user's name as entityLabel wherever
// it's already in hand.
// ─────────────────────────────────────────────

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

  // FIX (audit review, item #5): the attempted phone is the only forensic handle on
  // a row for an unknown account (no userId/entityId exists). Stored masked (last 4
  // digits only) so the audit log doesn't become a phone-number directory.
  private maskPhone(phone: string): string {
    return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
  }

  // FIX (audit review, items #1/#4/#5): shared emitter for OTP rejections. Every OTP
  // gate (not found / phone mismatch / wrong purpose / used / expired / wrong digits /
  // claim race) used to throw with no trace, and the OTP-abuse SECURITY_ALERT rows had
  // no outcome/severity. One helper keeps the three OTP flows (signup verify, reset,
  // change-password verify) emitting identical shapes.
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

  // FIX (audit review, items #1/#2/#4/#5): OTP-abuse lockout. The lock is a
  // system-triggered action against the user's account, so the user is recorded as
  // targetUserId (not userId) with a SYSTEM actor — same treatment as
  // ReportService.handleUserSuspended. Previously: userId = the locked user, no
  // outcome/severity (so a lockout was stored as SUCCESS/INFO), purpose buried in diff.
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
  //
  // FIX (audit review, item #1): three throws here left no trace — the
  // already-registered check, the concurrent-registration race, and the
  // missing-USER-role config error. All now emit before throwing.
  //
  // FIX (audit review, item #2): on an already-registered phone, the existing
  // account is the affected party, not the actor (the actor is an unauthenticated
  // caller), so it's recorded as targetUserId with no userId.
  //
  // FIX (audit review, item #4): success row now carries the new user's name.
  //
  // FIX (audit review, item #5): whether the signup OTP SMS actually went out was
  // only console.error'd; it's now on the success row as metadata.smsDelivered.

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
          // Routine (people re-register / forget they have an account), so INFO,
          // but still recorded — repeated hits on one account are enumeration signal.
          severity: AuditSeverity.INFO,
          entity: 'User',
          entityId: existingUser.id,
          entityLabel: existingUser.name ?? undefined,
          diff: { result: 'failure', reason: 'phone_already_registered' },
        });
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
      this.emitAudit({
        actorType: resolveActorType([]),
        action: AuditEventEnum.USER_CREATED,
        outcome: AuditOutcome.FAILURE,
        // ASSUMPTION: AuditSeverity has a CRITICAL member. A missing USER role
        // means *every* signup fails — a broken system, not a bad request.
        severity: AuditSeverity.CRITICAL,
        entity: 'User',
        entityId: null,
        diff: { result: 'failure', reason: 'user_role_not_configured' },
        metadata: { attemptedPhone: this.maskPhone(phone) },
      });
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
        this.emitAudit({
          actorType: resolveActorType([]),
          action: AuditEventEnum.USER_CREATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.INFO,
          entity: 'User',
          // The winning row's id isn't in hand (and re-reading just for the log
          // isn't worth it), so the attempted phone is the handle.
          entityId: null,
          diff: { result: 'failure', reason: 'phone_already_registered' },
          metadata: { attemptedPhone: this.maskPhone(phone), raceLost: true },
        });
        throw new BadRequestException('phone_already_registered');
      }
      throw error;
    }

    // Send signup OTP SMS
    const smsMessage = renderOtpSms({
      otp: result.otp,
      expiresInMinutes: this.configService.get<number>('otp.expiresInMinutes', 10),
    });

    let smsDelivered = true;

    try {
      await sendSms(this.requirePhone(result.phone), smsMessage);
    } catch (error) {
      smsDelivered = false;
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
      entityLabel: data.name,
      diff: { result: 'success' },
      metadata: { otpChannel: 'sms', smsDelivered },
    });

    return { verificationId: result.verificationId };
  }

  // VERIFY SIGNUP OTP
  //
  // FIX (audit review, item #1): every rejection in this method used to throw
  // with no row (missing record, phone mismatch, wrong purpose, already used,
  // expired, wrong digits below the threshold, lost claim race). All now emit
  // first. When the wrong-digits attempt is the one that crosses the threshold,
  // only the lockout SECURITY_ALERT is emitted (not both) to avoid a duplicate.
  //
  // FIX (audit review, items #1/#2/#3/#5): OTP-abuse SECURITY_ALERT rows now
  // carry outcome/severity, target the locked user via targetUserId, and move
  // `purpose` out of diff into metadata (see emitOtpLockout).
  //
  // FIX (audit review, items #4/#5): success row gets an entityLabel, a real
  // before/after diff of isPhoneVerified, and `purpose` as metadata.

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
      // No record → no user/entity to attach to; entityId is null (same as the
      // unknown-account LOGIN_FAILED row), the probed id goes in metadata.
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
        // Routine — the user was just slow.
        severity: AuditSeverity.INFO,
        otp: otpAudit,
        user: userAudit,
        roles,
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    // Enforce max OTP attempts
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

      // Lock the account once failed attempts hit the max, not just alert.
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
        // Lost the race, already consumed, or expired.
        // NOTE: emitAudit goes through the event listener, not `tx`, so this row
        // is not rolled back by the throw below.
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

    // Audit successful verification
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

  // RESEND SIGNUP OTP
  //
  // NOTE (audit review, item #1 — deliberately NOT fixed here): the two throws
  // below (invalid_verification, phone_already_verified) leave no audit row, and
  // neither does a successful resend. AuditEventEnum has no member that fits
  // "OTP resent" (e.g. OTP_RESENT), and reusing OTP_VERIFIED for a resend would
  // mislabel it. Needs an enum addition first — flagging rather than guessing.

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
  //
  // FIX (audit review, item #1): every LOGIN_FAILED row was emitted with the
  // default SUCCESS outcome and INFO severity. Now:
  //   - bad credentials (unknown account / no password / wrong password) → FAILURE
  //   - correct password but access blocked (no USER role / locked / inactive)
  //     → DENIED
  //   both at WARNING. `diff.result: 'failed'` is left as-is on these existing
  //   rows so anything already filtering on it keeps working.
  //
  // FIX (audit review, item #4): pass the user's name as entityLabel — login is
  // unauthenticated, so ActorContextInterceptor has no actorName to fall back on.
  //
  // FIX (audit review, item #5): `method: 'password'` describes how the attempt
  // was made, not a state change — moved from diff to metadata. The unknown-account
  // row gets a masked attemptedPhone (its only forensic handle), and diff.reason
  // now distinguishes unknown_account from no_password_set (audit-only; the HTTP
  // response stays identical so the endpoint still doesn't leak which it was).

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

    // Password checked before any account-state gate, so failure reasons stay indistinguishable.
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

    // Roles are additive; only accounts that never held USER at all are blocked here.
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

    // Lock check runs only after password verification, so it can't be used as an oracle.
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

    // Correct password clears any prior failure count/lock
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

  // FORGOT PASSWORD — masks "no account", "inactive", and "holds an admin role" identically.
  //
  // FIX (audit review, item #1): the masked early-return is a silent denial as far
  // as the *client* is concerned — which is exactly why it needs an audit row, since
  // it's the only place the real reason is visible. Now emits DENIED/WARNING with
  // the true reason in diff.reason (audit-only; the response is unchanged).
  // Action is PASSWORD_RESET (the attempted operation), same convention as
  // ReportService using REPORT_UPDATED for a failed update.
  //
  // FIX (audit review, item #4): `name` added to the select for entityLabel.
  //
  // NOTE: the *success* path (OTP issued) is not audited here — same OTP-issuance
  // caveat as resendSignupOtp().

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

    // Masks "no account", "inactive", and "admin role" identically (shared password risk).
    // Admins never go through this phone-based flow — they use
    // AdminAuthController's /admin/auth/forgot-password (email-based) instead.
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

  // RESET PASSWORD
  //
  // FIX (audit review, items #1/#2/#3/#5): same OTP-gate treatment as
  // verifySignupOtp() — every rejection now emits (action PASSWORD_RESET), lockout
  // rows target the user via targetUserId with a SYSTEM actor, and the single
  // combined invalid-record check is split so each rejection reason is recorded
  // distinctly (the HTTP error code is unchanged: still invalid_or_expired_otp).
  //
  // FIX (audit review, items #4/#5): `name` added to the select for entityLabel;
  // success row gets metadata.sessionsRevoked (the deleteMany count was being
  // thrown away) and `method` moves from diff to metadata.

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

      // Invalidate every existing session
      const revoked = await tx.session.deleteMany({
        where: { userId: otpRecord.user.id },
      });
      sessionsRevoked = revoked.count;
    });

    // Audit after successful transaction
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

    // Notify after successful transaction
    const resetEvent: PasswordResetEvent = { userId: otpRecord.user.id };
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_RESET, resetEvent);

    return { message: 'password_reset_successful' };
  }

  // REFRESH TOKEN — soft-revokes (not deletes) so a replayed rotated token is detectable.
  //
  // FIX (audit review, items #1/#2/#5): the refresh-token-reuse SECURITY_ALERT is
  // the most serious event in this file and was stored as SUCCESS/INFO, attributed
  // to the *victim* as userId, with the wipe count discarded. Now: outcome DENIED,
  // severity CRITICAL, the token owner as targetUserId under a SYSTEM actor (the
  // system revoked their sessions; the person replaying the token isn't them), the
  // number of sessions revoked in diff (it's a state change), and when the reused
  // token was originally rotated in metadata.
  // ASSUMPTION: AuditSeverity has a CRITICAL member.
  //
  // FIX (audit review, item #1): three more throws were silent — wrong token type
  // (a signed access token presented as a refresh token), deactivated/deleted user,
  // and losing the rotation race. All now emit. They reuse LOGIN_FAILED with
  // metadata.method = 'refresh_token', since a failed refresh is a failed attempt
  // to (re)establish a session.
  //
  // NOT audited (see the block comment above the class): bad JWT signature/expiry,
  // session-not-found, and session-expired.
  //
  // NOTE (item #4): the reuse row has no entityLabel — the only thing in hand is
  // the Session row, which has nothing human-readable, and re-reading the user just
  // for a label isn't worth an extra query on a security path.

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
      // Signature verified, so payload.sub is trustworthy even though the token
      // type is wrong.
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

    // Soft-revoke the old session, then mint a new one, in one transaction.
    return this.prisma.$transaction(async (tx) => {
      const rotated = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      if (rotated.count === 0) {
        // Lost a race with a concurrent refresh using the same token.
        // Could be a double-tap or a replay — WARNING, not CRITICAL; the
        // reuse-detection branch above is what escalates a *later* replay.
        // NOTE: emitAudit goes through the event listener, not `tx`, so this row
        // is not rolled back by the throw below.
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

  // CHANGE PASSWORD (STEP 1) — USER accounts only. Any account holding an admin role
  // is rejected here and must use the dedicated admin flow instead: AdminAuthController's
  // POST /admin/auth/change-password/initiate + /verify (current-password check + an
  // OTP EMAILED to the admin). This USER flow is the phone-first counterpart: current
  // password is checked here, then an OTP is TEXTED to the user's own registered phone
  // number, and the actual change only happens once that OTP is verified in step 2.
  //
  // FIX (audit review, item #1): all four throws (user missing, admin role, no
  // password set, wrong current password) were silent. Now emit PASSWORD_CHANGED
  // rows — DENIED for the admin-role block, FAILURE for the rest — at WARNING.
  // The wrong-current-password row matters most: on an authenticated request it
  // can indicate a hijacked session probing for the password.
  //
  // FIX (audit review, items #4/#5): dbUser.name as entityLabel (already loaded);
  // metadata.stage = 'initiate' distinguishes these from step-2 rows, since both
  // steps share the PASSWORD_CHANGED action.

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

    // Dedicated password_change purpose (distinct from password_reset, which stays
    // scoped to forgotPassword()/resetPassword()) — same SMS channel and proof-of-phone
    // pattern, just reached only after the current-password check above, and no longer
    // redeemable via the forgot-password /verify endpoint or vice versa.
    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      dbUser.id,
      this.requirePhone(dbUser.phone),
      UserOtpPurposeEnum.password_change,
      OtpChannelEnum.sms,
    );

    return { verificationId };
  }

  // CHANGE PASSWORD (STEP 2) — possessing the texted OTP proves phone control.
  // Mirrors resetPassword()'s OTP-claim pattern; kept as a separate method (rather than
  // calling resetPassword() directly) so the two flows — "forgot it entirely" vs.
  // "know it, want to change it" — stay independently auditable.
  //
  // FIX (audit review, items #1–#5): identical treatment to resetPassword() (action
  // PASSWORD_CHANGED). Also fixes a label inconsistency: lockout rows used
  // `purpose: 'change_password'` in diff, which matched neither the enum value
  // (`password_change`) nor the success row's `context: 'change_password_completed'`.
  // Purpose now comes from the OTP row itself (metadata.purpose), and the stray
  // `context` string is dropped in favour of metadata.stage = 'verify'.

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

      // Invalidate every existing session, including the one used to call step 1.
      const revoked = await tx.session.deleteMany({
        where: { userId: otpRecord.user.id },
      });
      sessionsRevoked = revoked.count;
    });

    // Audit after successful transaction
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

    // Notify after successful transaction
    const changedEvent: PasswordChangedEvent = { userId: otpRecord.user.id };
    this.eventEmitter.emit(NotificationEventEnum.PASSWORD_CHANGED, changedEvent);

    return { message: 'password_changed' };
  }

  // LOGOUT
  //
  // FIX (audit review, item #5): whether this logged out one session or all of
  // them, and how many rows that actually removed, weren't recorded anywhere.
  // Both now on the row as metadata (the deleteMany count was being discarded).
  //
  // NOTE (item #4): no entityLabel — logout is an authenticated self-action, so
  // ActorContextInterceptor already populates actorName; a separate user read
  // just to duplicate that isn't worth it. No failure path exists here to audit.

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

    // Roles come straight from JWT payload via CurrentUserDto
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

  // Wraps normalizePhoneNumber() so malformed input yields a clean 400, not a raw 500.
  private normalizePhoneOrThrow(phone: string): string {
    try {
      return normalizePhoneNumber(phone);
    } catch {
      throw new BadRequestException('invalid_phone_number');
    }
  }
}
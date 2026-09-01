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

/*
 * login() no longer always returns tokens — if the
 * account's phone hasn't been verified yet, it instead
 * triggers a fresh OTP send and returns this shape so
 * the client can route the user straight to the OTP
 * screen instead of a dead-end error.
 */
type LoginResult =
  | TokenPair
  | {
      requiresVerification: true;
      verificationId: string;
      message: string;
    };

/*
 * forgotPassword() result shape.
 *
 * purpose tells the client which OTP screen to route
 * to next:
 * - 'password_reset': normal flow, submit this OTP to
 *   /auth/reset-password.
 * - 'phone_verification': the account exists but was
 *   never verified — password reset doesn't apply to
 *   an unconfirmed account, so we send a verification
 *   OTP instead and the client should route to
 *   /auth/signup/verify.
 *
 * verificationId is '' when no matching account exists
 * at all, to avoid revealing whether the phone is
 * registered.
 */
type ForgotPasswordResult = {
  verificationId: string;
  purpose?:
    | 'password_reset'
    | 'phone_verification';
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // SIGN UP
  // ─────────────────────────────────────────────

  async signup(
    data: SignupDto,
  ): Promise<{ verificationId: string }> {
    const phone = this.normalizePhoneOrThrow(data.phone);

    const existingUser =
      await this.prisma.user.findUnique({
        where: {
          phone,
        },
      });

    if (existingUser) {
      if (existingUser.isPhoneVerified) {
        throw new BadRequestException(
          'phone_already_registered',
        );
      }

      /*
       * The phone is registered but never completed
       * verification — a real-world app shouldn't
       * dead-end this user with "already registered".
       * Treat it as a resend: send a fresh OTP for the
       * existing account rather than creating a second
       * one or blocking them outright.
       *
       * issueAndSendOtp() never throws on cooldown — if
       * one is active it just hands back the still-valid
       * verificationId from the last send.
       */
      const { verificationId } =
        await this.issueAndSendOtp(
          existingUser.id,
          existingUser.phone,
          UserOtpPurposeEnum.phone_verification,
        );

      return {
        verificationId,
      };
    }

    const userRole =
      await this.prisma.role.findUnique({
        where: {
          name: RolesEnum.USER,
        },
      });

    if (!userRole) {
      throw new BadRequestException(
        'user_role_not_configured',
      );
    }

    const hashedPassword =
      await bcrypt.hash(
        data.password,
        10,
      );

    /*
     * Create user + OTP inside one transaction.
     *
     * SMS is intentionally NOT sent inside the transaction.
     */
    const result =
      await this.prisma.$transaction(
        async (tx) => {
          const user =
            await tx.user.create({
              data: {
                name: data.name,
                phone,
                password: hashedPassword,

                userRoles: {
                  create: {
                    roleId: userRole.id,
                  },
                },
              },
            });

          const otp =
            this.generateOtp();

          const otpHash =
            await bcrypt.hash(
              otp,
              12,
            );

          const otpExpiresInMinutes =
            this.configService.get<number>(
              'otp.expiresInMinutes',
              10,
            );

          const userOtp =
            await tx.userOtp.create({
              data: {
                userId: user.id,
                otpHash,

                expiresAt:
                  new Date(
                    Date.now() +
                      otpExpiresInMinutes *
                        60 *
                        1000,
                  ),

                purpose:
                  UserOtpPurposeEnum.phone_verification,
              },
            });

          return {
            verificationId:
              userOtp.id,
            otp,
            phone: user.phone,
            userId: user.id,
          };
        },
      );

    /*
     * ─────────────────────────────────────────────
     * SEND SIGNUP OTP SMS
     * ─────────────────────────────────────────────
     */

    const smsMessage =
      renderOtpSms({
        otp: result.otp,
        expiresInMinutes:
          this.configService.get<number>(
            'otp.expiresInMinutes',
            10,
          ),
      });

    try {
      await sendSms(
        result.phone,
        smsMessage,
      );
    } catch (error) {
      /*
       * Log SMS failure without exposing OTP.
       *
       * The user has already been created and the OTP
       * has already been stored securely.
       */
      console.error(
        `[EHTE SMS] Failed to send signup OTP to ${result.phone}`,
        error,
      );

      /*
       * We do NOT include the OTP in the error.
       *
       * The client can use resendSignupOtp().
       */
    }

    /*
     * DEVELOPMENT ONLY
     *
     * Remove this in production.
     */
    if (
      this.configService.get<boolean>(
        'app.debug',
        false,
      )
    ) {
      console.log(
        `[EHTE DEV] Signup OTP for ${result.phone}: ${result.otp}`,
      );
    }

    /*
     * User creation audit.
     *
     * Never include:
     * - password
     * - password hash
     * - OTP
     * - OTP hash
     * - access token
     * - refresh token
     */
    this.eventEmitter.emit(
      AuditEventEnum.USER_CREATED,
      {
        userId:
          result.userId,

        actorType:
          resolveActorType([
            userRole.name,
          ]),

        action:
          AuditEventEnum.USER_CREATED,

        entity: 'User',

        entityId:
          result.userId,

        diff: {
          result: 'success',
        },
      } as AuditEventPayload,
    );

    return {
      verificationId:
        result.verificationId,
    };
  }

  // ─────────────────────────────────────────────
  // VERIFY SIGNUP OTP
  // ─────────────────────────────────────────────

  async verifySignupOtp(
    data: SignupVerifyDto,
  ): Promise<TokenPair> {
    const phone =
      this.normalizePhoneOrThrow(
        data.phone,
      );

    const otpRecord =
      await this.prisma.userOtp.findUnique({
        where: {
          id: data.verificationId,
        },

        include: {
          user: {
            include: {
              userRoles: {
                include: {
                  role: true,
                },
              },
            },
          },
        },
      });

    if (!otpRecord) {
      throw new BadRequestException(
        'invalid_or_expired_otp',
      );
    }

    if (
      otpRecord.user.phone !==
      phone
    ) {
      throw new BadRequestException(
        'invalid_or_expired_otp',
      );
    }

    if (
      otpRecord.purpose !==
        UserOtpPurposeEnum.phone_verification ||
      otpRecord.usedAt ||
      otpRecord.expiresAt < new Date()
    ) {
      throw new BadRequestException(
        'invalid_or_expired_otp',
      );
    }

    const roles =
      otpRecord.user.userRoles.map(
        (userRole) =>
          userRole.role.name,
      );

    /*
     * Maximum OTP attempts.
     */
    if (
      otpRecord.attempts >= 5
    ) {
      this.eventEmitter.emit(
        AuditEventEnum.SECURITY_ALERT,
        {
          userId:
            otpRecord.user.id,

          actorType:
            resolveActorType(
              roles,
            ),

          action:
            AuditEventEnum.SECURITY_ALERT,

          entity: 'UserOtp',

          entityId:
            otpRecord.id,

          diff: {
            reason:
              'too_many_otp_attempts',

            purpose:
              'phone_verification',
          },
        } as AuditEventPayload,
      );

      throw new BadRequestException(
        'too_many_otp_attempts',
      );
    }

    const validOtp =
      await bcrypt.compare(
        data.otp,
        otpRecord.otpHash,
      );

    if (!validOtp) {
      const updatedOtp =
        await this.prisma.userOtp.update({
          where: {
            id: otpRecord.id,
          },

          data: {
            attempts: {
              increment: 1,
            },
          },

          select: {
            attempts: true,
          },
        });

      /*
       * Emit SECURITY_ALERT when
       * failed attempts reach maximum.
       */
      if (
        updatedOtp.attempts >= 5
      ) {
        this.eventEmitter.emit(
          AuditEventEnum.SECURITY_ALERT,
          {
            userId:
              otpRecord.user.id,

            actorType:
              resolveActorType(
                roles,
              ),

            action:
              AuditEventEnum.SECURITY_ALERT,

            entity: 'UserOtp',

            entityId:
              otpRecord.id,

            diff: {
              reason:
                'too_many_otp_attempts',

              purpose:
                'phone_verification',
            },
          } as AuditEventPayload,
        );
      }

      throw new BadRequestException(
        'invalid_or_expired_otp',
      );
    }

    /*
     * Atomically CLAIM the OTP before trusting it's
     * still ours to use: updateMany with usedAt: null
     * in the where-clause means only one of two
     * concurrent requests can ever flip it to used —
     * the loser gets count === 0 and is rejected, even
     * though both requests may have passed the earlier
     * bcrypt.compare() check on the same still-unused
     * row. Wrapping the claim and the phone-verified
     * flip in one interactive transaction also means
     * the two facts can never drift apart (e.g. OTP
     * marked used but the verification flag failing
     * to persist, or vice versa).
     *
     * Requires User.isPhoneVerified (see schema note
     * above login()) — this is the ONLY place that
     * should ever set it to true.
     */
    await this.prisma.$transaction(
      async (tx) => {
        const claimed =
          await tx.userOtp.updateMany({
            where: {
              id: otpRecord.id,
              usedAt: null,

              attempts: {
                lt: 5,
              },

              expiresAt: {
                gt: new Date(),
              },
            },

            data: {
              usedAt: new Date(),
            },
          });

        if (claimed.count === 0) {
          /*
           * Lost the race — another request already
           * consumed this OTP, pushed its attempts to
           * 5, or it expired between our read and this
           * claim attempt.
           */
          throw new BadRequestException(
            'invalid_or_expired_otp',
          );
        }

        await tx.user.update({
          where: {
            id: otpRecord.user.id,
          },

          data: {
            isPhoneVerified: true,
          },
        });
      },
    );

    /*
     * Successful OTP verification.
     */
    this.eventEmitter.emit(
      AuditEventEnum.OTP_VERIFIED,
      {
        userId:
          otpRecord.user.id,

        actorType:
          resolveActorType(
            roles,
          ),

        action:
          AuditEventEnum.OTP_VERIFIED,

        entity: 'UserOtp',

        entityId:
          otpRecord.id,

        diff: {
          purpose:
            'phone_verification',

          result:
            'success',
        },
      } as AuditEventPayload,
    );

    return this.issueTokens(
      otpRecord.user.id,
      otpRecord.user.phone,
      roles,
    );
  }

  // ─────────────────────────────────────────────
  // RESEND SIGNUP OTP
  // ─────────────────────────────────────────────

  async resendSignupOtp(
    verificationId: string,
  ): Promise<{
    verificationId: string;
  }> {
    const oldOtp =
      await this.prisma.userOtp.findUnique({
        where: {
          id: verificationId,
        },

        include: {
          user: true,
        },
      });

    if (
      !oldOtp ||
      oldOtp.purpose !==
        UserOtpPurposeEnum.phone_verification
    ) {
      throw new BadRequestException(
        'invalid_verification',
      );
    }

    if (oldOtp.usedAt) {
      throw new BadRequestException(
        'phone_already_verified',
      );
    }

    const { verificationId: newVerificationId } =
      await this.issueAndSendOtp(
        oldOtp.userId,
        oldOtp.user.phone,
        UserOtpPurposeEnum.phone_verification,
      );

    return {
      verificationId: newVerificationId,
    };
  }

  // ─────────────────────────────────────────────
  // LOGIN
  //
  // REQUIRES: User.isPhoneVerified (Prisma schema
  // migration — see note above). Without it, a user
  // could sign up and log in immediately without ever
  // completing OTP verification, which defeats the
  // point of gating verifySignupOtp() in the first
  // place. Real-world flow: signup -> must verify OTP
  // -> only then can they log in.
  //
  // TODO(security): persistent account lockout.
  // This still only *audits* LOGIN_FAILED events;
  // it does not lock the account after N failures.
  // Doing that safely requires new columns on User
  // (e.g. failedLoginAttempts, lockedUntil) added
  // via a Prisma migration, which is out of scope
  // for this file alone. Wire it in here once that
  // migration exists — the audit events below are
  // already emitted so the trigger point is ready.
  // ─────────────────────────────────────────────

  async login(
    data: LoginDto,
  ): Promise<LoginResult> {
    const phone =
      this.normalizePhoneOrThrow(
        data.phone,
      );

    const user =
      await this.prisma.user.findUnique({
        where: {
          phone,
        },

        include: {
          userRoles: {
            include: {
              role: true,
            },
          },
        },
      });

    if (
      !user ||
      !user.password
    ) {
      this.eventEmitter.emit(
        AuditEventEnum.LOGIN_FAILED,
        {
          userId:
            user?.id ?? null,

          actorType:
            resolveActorType(
              user
                ? user.userRoles.map(
                    (userRole) =>
                      userRole.role.name,
                  )
                : [],
            ),

          action:
            AuditEventEnum.LOGIN_FAILED,

          entity: 'User',

          entityId:
            user?.id ?? null,

          diff: {
            method:
              'password',

            result:
              'failed',
          },
        } as AuditEventPayload,
      );

      throw new UnauthorizedException(
        'invalid_credentials',
      );
    }

    const roles =
      user.userRoles.map(
        (userRole) =>
          userRole.role.name,
      );

    /*
     * Password is checked BEFORE both the isActive
     * gate and the phone-verification gate below, on
     * purpose. An attacker who only knows a phone
     * number and guesses the wrong password should
     * always get the same generic invalid_credentials
     * — checking isActive first would leak whether that
     * phone number belongs to an inactive account to
     * someone who hasn't even proven they know the
     * password. Checking password first also means the
     * phone-verification OTP send further below can
     * only be triggered by someone who actually knows
     * the account's password, which prevents this
     * endpoint from being used as a free SMS-bombing
     * vector.
     */
    const validPassword =
      await bcrypt.compare(
        data.password,
        user.password,
      );

    if (!validPassword) {
      this.eventEmitter.emit(
        AuditEventEnum.LOGIN_FAILED,
        {
          userId:
            user.id,

          actorType:
            resolveActorType(
              roles,
            ),

          action:
            AuditEventEnum.LOGIN_FAILED,

          entity: 'User',

          entityId:
            user.id,

          diff: {
            method:
              'password',

            result:
              'failed',
          },
        } as AuditEventPayload,
      );

      throw new UnauthorizedException(
        'invalid_credentials',
      );
    }

    if (!user.isActive) {
      this.eventEmitter.emit(
        AuditEventEnum.LOGIN_FAILED,
        {
          userId:
            user.id,

          actorType:
            resolveActorType(
              roles,
            ),

          action:
            AuditEventEnum.LOGIN_FAILED,

          entity: 'User',

          entityId:
            user.id,

          diff: {
            method:
              'password',

            result:
              'failed',

            reason:
              'account_inactive',
          },
        } as AuditEventPayload,
      );

      throw new UnauthorizedException(
        'account_inactive',
      );
    }

    if (!user.isPhoneVerified) {
      this.eventEmitter.emit(
        AuditEventEnum.LOGIN_FAILED,
        {
          userId:
            user.id,

          actorType:
            resolveActorType(
              roles,
            ),

          action:
            AuditEventEnum.LOGIN_FAILED,

          entity: 'User',

          entityId:
            user.id,

          diff: {
            method:
              'password',

            result:
              'failed',

            reason:
              'phone_not_verified',
          },
        } as AuditEventPayload,
      );

      /*
       * Real-world flow: rather than dead-ending here,
       * check the DB, send a fresh OTP, and hand the
       * client a verificationId so it can route straight
       * to the OTP screen. issueAndSendOtp() invalidates
       * any stale unused OTP and applies a resend cooldown
       * — and never throws on that cooldown, so a user who
       * hits login twice in quick succession while
       * unverified still gets a clean, usable
       * verificationId back both times.
       */
      const { verificationId } =
        await this.issueAndSendOtp(
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

    this.eventEmitter.emit(
      AuditEventEnum.LOGIN_SUCCESS,
      {
        userId:
          user.id,

        actorType:
          resolveActorType(
            roles,
          ),

        action:
          AuditEventEnum.LOGIN_SUCCESS,

        entity: 'User',

        entityId:
          user.id,

        diff: {
          method:
            'password',

          result:
            'success',
        },
      } as AuditEventPayload,
    );

    return this.issueTokens(
      user.id,
      user.phone,
      roles,
    );
  }

  // ─────────────────────────────────────────────
  // FORGOT PASSWORD
  //
  // An unverified account never had its phone number
  // confirmed, so "resetting its password" doesn't
  // make sense — the real next step for that account
  // is completing signup verification, not password
  // reset. Rather than sending a password_reset OTP
  // (or silently doing nothing) for an unverified
  // account, this sends a phone_verification OTP
  // instead and tells the client which flow to route
  // into via `purpose`.
  //
  // The "does this phone exist" case and the "phone
  // exists but never verified" case both still need
  // to be indistinguishable from each other from the
  // client's point of view when NO account exists at
  // all — otherwise this endpoint becomes a way to
  // enumerate which phone numbers have started
  // (but not finished) signup. Only "no account" is
  // masked with an empty verificationId; once we know
  // an OTP was actually sent, the purpose is safe to
  // reveal since the requester has just been sent a
  // real code to that real phone.
  // ─────────────────────────────────────────────

  async forgotPassword(
    data: ForgotPasswordDto,
  ): Promise<ForgotPasswordResult> {
    const phone =
      this.normalizePhoneOrThrow(
        data.phone,
      );

    const user =
      await this.prisma.user.findUnique({
        where: {
          phone,
        },

        select: {
          id: true,
          phone: true,
          isPhoneVerified: true,
        },
      });

    /*
     * Do not reveal whether
     * the phone exists.
     */
    if (!user) {
      return {
        verificationId: '',
      };
    }

    if (!user.isPhoneVerified) {
      const { verificationId } =
        await this.issueAndSendOtp(
          user.id,
          user.phone,
          UserOtpPurposeEnum.phone_verification,
        );

      return {
        verificationId,
        purpose: 'phone_verification',
      };
    }

    const { verificationId } =
      await this.issueAndSendOtp(
        user.id,
        user.phone,
        UserOtpPurposeEnum.password_reset,
      );

    return {
      verificationId,
      purpose: 'password_reset',
    };
  }

  // ─────────────────────────────────────────────
  // RESET PASSWORD
  // ─────────────────────────────────────────────

  async resetPassword(
    data: ResetPasswordDto,
  ): Promise<{
    message: string;
  }> {
    const otpRecord =
      await this.prisma.userOtp.findUnique({
        where: {
          id: data.verificationId,
        },

        include: {
          user: {
            select: {
              id: true,

              userRoles: {
                include: {
                  role: true,
                },
              },
            },
          },
        },
      });

    if (
      !otpRecord ||
      otpRecord.purpose !==
        UserOtpPurposeEnum.password_reset ||
      otpRecord.usedAt ||
      otpRecord.expiresAt <
        new Date()
    ) {
      throw new BadRequestException(
        'invalid_or_expired_otp',
      );
    }

    const roles =
      otpRecord.user.userRoles.map(
        (userRole) =>
          userRole.role.name,
      );

    if (
      otpRecord.attempts >= 5
    ) {
      this.eventEmitter.emit(
        AuditEventEnum.SECURITY_ALERT,
        {
          userId:
            otpRecord.user.id,

          actorType:
            resolveActorType(
              roles,
            ),

          action:
            AuditEventEnum.SECURITY_ALERT,

          entity: 'UserOtp',

          entityId:
            otpRecord.id,

          diff: {
            reason:
              'too_many_otp_attempts',

            purpose:
              'password_reset',
          },
        } as AuditEventPayload,
      );

      throw new BadRequestException(
        'too_many_otp_attempts',
      );
    }

    const validOtp =
      await bcrypt.compare(
        data.otp,
        otpRecord.otpHash,
      );

    if (!validOtp) {
      const updatedOtp =
        await this.prisma.userOtp.update({
          where: {
            id: otpRecord.id,
          },

          data: {
            attempts: {
              increment: 1,
            },
          },

          select: {
            attempts: true,
          },
        });

      if (
        updatedOtp.attempts >= 5
      ) {
        this.eventEmitter.emit(
          AuditEventEnum.SECURITY_ALERT,
          {
            userId:
              otpRecord.user.id,

            actorType:
              resolveActorType(
                roles,
              ),

            action:
              AuditEventEnum.SECURITY_ALERT,

            entity: 'UserOtp',

            entityId:
              otpRecord.id,

            diff: {
              reason:
                'too_many_otp_attempts',

              purpose:
                'password_reset',
            },
          } as AuditEventPayload,
        );
      }

      throw new BadRequestException(
        'invalid_or_expired_otp',
      );
    }

    const hashedPassword =
      await bcrypt.hash(
        data.newPassword,
        10,
      );

    /*
     * Same atomic-claim pattern as verifySignupOtp():
     * updateMany with usedAt: null in the where-clause
     * ensures only one of two concurrent requests can
     * consume this OTP, even if both already passed
     * bcrypt.compare() on the same still-unused row.
     */
    await this.prisma.$transaction(
      async (tx) => {
        const claimed =
          await tx.userOtp.updateMany({
            where: {
              id: data.verificationId,
              usedAt: null,

              attempts: {
                lt: 5,
              },

              expiresAt: {
                gt: new Date(),
              },
            },

            data: {
              usedAt: new Date(),
            },
          });

        if (claimed.count === 0) {
          throw new BadRequestException(
            'invalid_or_expired_otp',
          );
        }

        await tx.user.update({
          where: {
            id: otpRecord.user.id,
          },

          data: {
            password:
              hashedPassword,
          },
        });

        /*
         * Invalidate every
         * existing session.
         */
        await tx.session.deleteMany({
          where: {
            userId:
              otpRecord.user.id,
          },
        });
      },
    );

    /*
     * Audit AFTER successful transaction.
     */
    this.eventEmitter.emit(
      AuditEventEnum.PASSWORD_RESET,
      {
        userId:
          otpRecord.user.id,

        actorType:
          resolveActorType(
            roles,
          ),

        action:
          AuditEventEnum.PASSWORD_RESET,

        entity: 'User',

        entityId:
          otpRecord.user.id,

        diff: {
          method:
            'otp',

          result:
            'success',
        },
      } as AuditEventPayload,
    );

    /*
     * Notification AFTER
     * successful transaction.
     */
    this.eventEmitter.emit(
      NotificationEventEnum.PASSWORD_RESET,
      {
        userId:
          otpRecord.user.id,
      } as PasswordResetEvent,
    );

    return {
      message:
        'password_reset_successful',
    };
  }

  // ─────────────────────────────────────────────
  // REFRESH TOKEN
  // ─────────────────────────────────────────────

  async refresh(
    data: RefreshTokenDto,
  ): Promise<TokenPair> {
    let payload: {
      sub: string;
      phone: string;
      roles: string[];
      type: string;
    };

    /*
     * Verify with the dedicated refresh secret,
     * falling back to the access-token secret only
     * if no refresh secret is configured. Access and
     * refresh tokens should not share a secret in
     * production — set JWT_REFRESH_SECRET.
     */
    const refreshSecret =
      this.configService.get<string>(
        'jwt.refreshSecret',
      ) ??
      this.configService.getOrThrow<string>(
        'jwt.secret',
      );

    try {
      payload =
        this.jwtService.verify(
          data.refreshToken,
          {
            secret: refreshSecret,
          },
        );
    } catch {
      throw new UnauthorizedException(
        'invalid_refresh_token',
      );
    }

    if (
      payload.type !==
      'refresh'
    ) {
      throw new UnauthorizedException(
        'invalid_refresh_token',
      );
    }

    const refreshTokenHash =
      this.hashRefreshToken(
        data.refreshToken,
      );

    const session =
      await this.prisma.session.findFirst({
        where: {
          userId:
            payload.sub,

          refreshToken:
            refreshTokenHash,

          expiresAt: {
            gt: new Date(),
          },
        },
      });

    if (!session) {
      /*
       * TODO(security): refresh-token reuse detection.
       * If a refresh token was already rotated/deleted
       * but is presented again, this branch fires with
       * no way to distinguish "expired" from "stolen and
       * already used by someone else". Consider keeping
       * a short-lived tombstone of consumed refresh
       * tokens (or a per-user token family/version) so
       * reuse can trigger a SECURITY_ALERT and force a
       * full session wipe for the user.
       */
      throw new UnauthorizedException(
        'session_expired_or_invalid',
      );
    }

    const user =
      await this.prisma.user.findUnique({
        where: {
          id: payload.sub,
        },

        include: {
          userRoles: {
            include: {
              role: true,
            },
          },
        },
      });

    if (
      !user ||
      !user.isActive
    ) {
      throw new UnauthorizedException(
        'user_inactive',
      );
    }

    const roles =
      user.userRoles.map(
        (userRole) =>
          userRole.role.name,
      );

    /*
     * Rotate refresh token atomically: the old
     * session's deletion and the new session's
     * creation now happen in one transaction, so
     * there's no window where the old session is gone
     * but the replacement hasn't landed yet. deleteMany
     * (scoped to this exact session id) + a count check
     * still guards against two concurrent refresh()
     * calls both passing the earlier findFirst and both
     * trying to rotate the same session — the loser
     * gets count === 0 and is rejected rather than
     * silently minting a second token pair.
     */
    return this.prisma.$transaction(
      async (tx) => {
        const rotated =
          await tx.session.deleteMany({
            where: {
              id: session.id,
            },
          });

        if (rotated.count === 0) {
          throw new UnauthorizedException(
            'session_expired_or_invalid',
          );
        }

        return this.issueTokens(
          user.id,
          user.phone,
          roles,
          tx,
        );
      },
    );
  }

  // ─────────────────────────────────────────────
  // CURRENT USER
  // ─────────────────────────────────────────────

  async me(
    currentUser: CurrentUserDto,
  ) {
    const user =
      await this.prisma.user.findUnique({
        where: {
          id: currentUser.id,
        },

        select: {
          id: true,
          name: true,
          phone: true,
          isActive: true,

          discreetModeEnabled:
            true,

          discreetModeUpdatedAt:
            true,

          createdAt: true,
          updatedAt: true,

          userRoles: {
            select: {
              role: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      });

    if (!user) {
      throw new NotFoundException(
        'user_not_found',
      );
    }

    const roles =
      user.userRoles.map(
        (userRole) =>
          userRole.role.name,
      );

    const {
      userRoles,
      ...userData
    } = user;

    return {
      ...userData,
      roles,
    };
  }

  // ─────────────────────────────────────────────
  // CHANGE PASSWORD
  // ─────────────────────────────────────────────

  async changePassword(
    user: CurrentUserDto,
    data: ChangePasswordDto,
  ): Promise<{
    message: string;
  }> {
    const dbUser =
      await this.prisma.user.findUnique({
        where: {
          id: user.id,
        },

        include: {
          userRoles: {
            include: {
              role: true,
            },
          },
        },
      });

    if (!dbUser) {
      throw new NotFoundException(
        'user_not_found',
      );
    }

    if (!dbUser.password) {
      throw new BadRequestException(
        'password_not_set',
      );
    }

    const validPassword =
      await bcrypt.compare(
        data.currentPassword,
        dbUser.password,
      );

    if (!validPassword) {
      throw new BadRequestException(
        'wrong_current_password',
      );
    }

    const hashedPassword =
      await bcrypt.hash(
        data.newPassword,
        10,
      );

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: {
          id: user.id,
        },

        data: {
          password:
            hashedPassword,
        },
      }),

      /*
       * Force re-login after
       * password change.
       */
      this.prisma.session.deleteMany({
        where: {
          userId: user.id,
        },
      }),
    ]);

    const roles =
      dbUser.userRoles.map(
        (userRole) =>
          userRole.role.name,
      );

    /*
     * Audit event AFTER
     * successful transaction.
     */
    this.eventEmitter.emit(
      AuditEventEnum.PASSWORD_CHANGED,
      {
        userId:
          user.id,

        actorType:
          resolveActorType(
            roles,
          ),

        action:
          AuditEventEnum.PASSWORD_CHANGED,

        entity: 'User',

        entityId:
          user.id,

        diff: {
          result:
            'success',
        },
      } as AuditEventPayload,
    );

    /*
     * Notification AFTER
     * successful transaction.
     */
    this.eventEmitter.emit(
      NotificationEventEnum.PASSWORD_CHANGED,
      {
        userId:
          user.id,
      } as PasswordChangedEvent,
    );

    return {
      message:
        'password_changed',
    };
  }

  // ─────────────────────────────────────────────
  // LOGOUT
  // ─────────────────────────────────────────────

  async logout(
    user: CurrentUserDto,
    req: any,
  ): Promise<{
    message: string;
  }> {
    const refreshToken =
      req?.body?.refreshToken ||
      req?.headers?.['x-refresh-token'];

    if (refreshToken) {
      await this.prisma.session.deleteMany({
        where: {
          userId: user.id,
          refreshToken:
            this.hashRefreshToken(
              refreshToken,
            ),
        },
      });
    } else {
      await this.prisma.session.deleteMany({
        where: {
          userId: user.id,
        },
      });
    }

    /*
     * CurrentUserDto now carries roles as a real,
     * required field (populated by JwtStrategy.validate()
     * from the JWT payload), so this can read straight
     * off `user.roles` — the old unknown-cast workaround
     * is no longer needed here.
     */
    const roles = user.roles ?? [];

    this.eventEmitter.emit(
      AuditEventEnum.LOGOUT,
      {
        userId:
          user.id,

        actorType:
          resolveActorType(
            roles,
          ),

        action:
          AuditEventEnum.LOGOUT,

        entity: 'User',

        entityId:
          user.id,

        diff: {
          result:
            'success',
        },
      } as AuditEventPayload,
    );

    return {
      message:
        'logout_successful',
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — REGISTER
  //
  // Only reachable by an authenticated ADMIN /
  // SUPER_ADMIN (enforced by @Roles on the
  // controller — `creator` is that admin).
  //
  // Creates a PENDING admin: isPhoneVerified: false,
  // isActive: false. Both stay false until the
  // creating admin submits the OTP via adminVerify().
  // login() already rejects inactive accounts before
  // it ever checks the password, so a pending admin
  // cannot log in — and because this issues an OTP
  // with a dedicated purpose (admin_verification, NOT
  // phone_verification), the pending admin also can't
  // self-verify through /auth/signup/verify.
  //
  // REQUIRES a Prisma schema change:
  //   UserOtpPurposeEnum needs an `admin_verification`
  //   value added alongside the existing
  //   `phone_verification` / `password_reset`.
  // ─────────────────────────────────────────────

  async adminRegister(
    creator: CurrentUserDto,
    data: AdminRegisterDto,
  ): Promise<{
    adminId: string;
    verificationId: string;
  }> {
    /*
     * Defense-in-depth: don't rely solely on the
     * controller's @Roles guard. CurrentUserDto now
     * carries roles as a real, required field
     * (JwtStrategy.validate() populates it from the JWT
     * payload), so this reads straight off
     * `creator.roles` rather than an unknown-cast
     * workaround.
     */
    const creatorRoles = creator.roles ?? [];

    if (
      !creatorRoles.some((role) =>
        [
          RolesEnum.ADMIN,
          RolesEnum.SUPER_ADMIN,
        ].includes(role as RolesEnum),
      )
    ) {
      throw new UnauthorizedException(
        'insufficient_permissions',
      );
    }

    const phone =
      this.normalizePhoneOrThrow(
        data.phone,
      );

    const existingUser =
      await this.prisma.user.findUnique({
        where: {
          phone,
        },
      });

    if (existingUser) {
      throw new BadRequestException(
        'phone_already_registered',
      );
    }

    /*
     * Creator can provision ADMIN accounts only.
     * Promoting to SUPER_ADMIN is a separate,
     * deliberate action — not something this
     * self-service registration flow should grant.
     */
    const adminRole =
      await this.prisma.role.findUnique({
        where: {
          name: RolesEnum.ADMIN,
        },
      });

    if (!adminRole) {
      throw new BadRequestException(
        'admin_role_not_configured',
      );
    }

    const hashedPassword =
      await bcrypt.hash(
        data.password,
        10,
      );

    const result =
      await this.prisma.$transaction(
        async (tx) => {
          const admin =
            await tx.user.create({
              data: {
                name: data.name,
                phone,
                password: hashedPassword,

                isPhoneVerified: false,
                isActive: false,

                userRoles: {
                  create: {
                    roleId: adminRole.id,
                  },
                },
              },
            });

          const otp =
            this.generateOtp();

          const otpHash =
            await bcrypt.hash(
              otp,
              12,
            );

          const otpExpiresInMinutes =
            this.configService.get<number>(
              'otp.expiresInMinutes',
              10,
            );

          const adminOtp =
            await tx.userOtp.create({
              data: {
                userId: admin.id,
                otpHash,

                expiresAt:
                  new Date(
                    Date.now() +
                      otpExpiresInMinutes *
                        60 *
                        1000,
                  ),

                purpose:
                  UserOtpPurposeEnum.admin_verification,
              },
            });

          return {
            adminId: admin.id,
            verificationId:
              adminOtp.id,
            otp,
            phone: admin.phone,
          };
        },
      );

    const smsMessage =
      renderOtpSms({
        otp: result.otp,
        expiresInMinutes:
          this.configService.get<number>(
            'otp.expiresInMinutes',
            10,
          ),
      });

    try {
      await sendSms(
        result.phone,
        smsMessage,
      );
    } catch (error) {
      console.error(
        `[EHTE SMS] Failed to send admin registration OTP to ${result.phone}`,
        error,
      );
    }

    /*
     * DEVELOPMENT ONLY
     */
    if (
      this.configService.get<boolean>(
        'app.debug',
        false,
      )
    ) {
      console.log(
        `[EHTE DEV] Admin registration OTP for ${result.phone}: ${result.otp}`,
      );
    }

    this.eventEmitter.emit(
      AuditEventEnum.USER_CREATED,
      {
        userId:
          result.adminId,

        actorType:
          resolveActorType([
            RolesEnum.ADMIN,
          ]),

        action:
          AuditEventEnum.USER_CREATED,

        entity: 'User',

        entityId:
          result.adminId,

        diff: {
          result: 'success',
          role: RolesEnum.ADMIN,
          createdBy: creator.id,
        },
      } as AuditEventPayload,
    );

    return {
      adminId: result.adminId,
      verificationId:
        result.verificationId,
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — VERIFY REGISTRATION
  //
  // Only reachable by an authenticated ADMIN /
  // SUPER_ADMIN (`verifier`). Looks up the pending
  // admin by adminId (the :id route param) — never
  // trusts a phone number from the request body — and
  // compares the submitted OTP against that admin's
  // own stored, unused admin_verification OTP.
  // ─────────────────────────────────────────────

  async adminVerify(
    verifier: CurrentUserDto,
    adminId: string,
    data: AdminVerifyDto,
  ): Promise<{
    message: string;
  }> {
    /*
     * Defense-in-depth: the controller's @Roles guard
     * is expected to already restrict this route to
     * ADMIN/SUPER_ADMIN, but the service shouldn't
     * assume that will always be true — a future
     * refactor of the controller/guard shouldn't be
     * able to silently turn this into an anonymous
     * write. CurrentUserDto carries roles as a real,
     * required field, so this reads straight off
     * `verifier.roles`.
     */
    const verifierRoles = verifier.roles ?? [];

    if (
      !verifierRoles.some((role) =>
        [
          RolesEnum.ADMIN,
          RolesEnum.SUPER_ADMIN,
        ].includes(role as RolesEnum),
      )
    ) {
      throw new UnauthorizedException(
        'insufficient_permissions',
      );
    }

    const admin =
      await this.prisma.user.findUnique({
        where: {
          id: adminId,
        },

        include: {
          userRoles: {
            include: {
              role: true,
            },
          },
        },
      });

    const roles =
      admin?.userRoles.map(
        (userRole) =>
          userRole.role.name,
      ) ?? [];

    if (
      !admin ||
      !roles.some((role) =>
        [
          RolesEnum.ADMIN,
          RolesEnum.SUPER_ADMIN,
        ].includes(role as RolesEnum),
      )
    ) {
      throw new NotFoundException(
        'admin_not_found',
      );
    }

    if (admin.isActive) {
      throw new BadRequestException(
        'admin_already_verified',
      );
    }

    /*
     * Look up the OTP by the exact verificationId the
     * client was handed by adminRegister(), rather than
     * "whatever's newest and unused" — that avoids the
     * verify endpoint implicitly guessing which OTP the
     * caller means, and closes the door on a stale
     * verificationId being silently matched against a
     * newer OTP for the same admin. AdminVerifyDto must
     * carry `verificationId` alongside `otp` for this.
     */
    const otpRecord =
      await this.prisma.userOtp.findUnique({
        where: {
          id: data.verificationId,
        },
      });

    if (
      !otpRecord ||
      otpRecord.userId !== admin.id ||
      otpRecord.purpose !==
        UserOtpPurposeEnum.admin_verification ||
      otpRecord.usedAt ||
      otpRecord.expiresAt < new Date()
    ) {
      throw new BadRequestException(
        'invalid_or_expired_otp',
      );
    }

    if (
      otpRecord.attempts >= 5
    ) {
      this.eventEmitter.emit(
        AuditEventEnum.SECURITY_ALERT,
        {
          userId: admin.id,

          actorType:
            resolveActorType(
              roles,
            ),

          action:
            AuditEventEnum.SECURITY_ALERT,

          entity: 'UserOtp',

          entityId:
            otpRecord.id,

          diff: {
            reason:
              'too_many_otp_attempts',

            purpose:
              'admin_verification',

            verifiedBy:
              verifier.id,
          },
        } as AuditEventPayload,
      );

      throw new BadRequestException(
        'too_many_otp_attempts',
      );
    }

    const validOtp =
      await bcrypt.compare(
        data.otp,
        otpRecord.otpHash,
      );

    if (!validOtp) {
      const updatedOtp =
        await this.prisma.userOtp.update({
          where: {
            id: otpRecord.id,
          },

          data: {
            attempts: {
              increment: 1,
            },
          },

          select: {
            attempts: true,
          },
        });

      if (
        updatedOtp.attempts >= 5
      ) {
        this.eventEmitter.emit(
          AuditEventEnum.SECURITY_ALERT,
          {
            userId: admin.id,

            actorType:
              resolveActorType(
                roles,
              ),

            action:
              AuditEventEnum.SECURITY_ALERT,

            entity: 'UserOtp',

            entityId:
              otpRecord.id,

            diff: {
              reason:
                'too_many_otp_attempts',

              purpose:
                'admin_verification',

              verifiedBy:
                verifier.id,
            },
          } as AuditEventPayload,
        );
      }

      throw new BadRequestException(
        'invalid_or_expired_otp',
      );
    }

    /*
     * Same atomic-claim pattern as verifySignupOtp():
     * updateMany with usedAt: null in the where-clause
     * ensures only one of two concurrent verify
     * requests can consume this OTP, even if both
     * already passed bcrypt.compare() on the same
     * still-unused row. Activating the admin inside
     * the same transaction means the OTP-used and
     * account-active facts can never drift apart.
     */
    await this.prisma.$transaction(
      async (tx) => {
        const claimed =
          await tx.userOtp.updateMany({
            where: {
              id: otpRecord.id,
              userId: admin.id,
              usedAt: null,

              attempts: {
                lt: 5,
              },

              expiresAt: {
                gt: new Date(),
              },
            },

            data: {
              usedAt: new Date(),
            },
          });

        if (claimed.count === 0) {
          throw new BadRequestException(
            'invalid_or_expired_otp',
          );
        }

        await tx.user.update({
          where: {
            id: admin.id,
          },

          data: {
            isPhoneVerified: true,
            isActive: true,
          },
        });
      },
    );

    this.eventEmitter.emit(
      AuditEventEnum.OTP_VERIFIED,
      {
        userId: admin.id,

        actorType:
          resolveActorType(
            roles,
          ),

        action:
          AuditEventEnum.OTP_VERIFIED,

        entity: 'UserOtp',

        entityId:
          otpRecord.id,

        diff: {
          purpose:
            'admin_verification',

          result:
            'success',

          verifiedBy:
            verifier.id,
        },
      } as AuditEventPayload,
    );

    return {
      message:
        'admin_verified',
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — LOGIN
  //
  // Same phone + password check as login(), but
  // restricted to accounts holding ADMIN or
  // SUPER_ADMIN — a regular user's credentials
  // should not authenticate against this endpoint,
  // and vice versa is left to the client (an admin
  // could in principle still call /auth/login, but
  // that's a separate decision from this endpoint's
  // job of gating access to admin-only clients).
  //
  // NOTE: unlike login(), this does not check
  // isPhoneVerified — only isActive. This is
  // intentional: an admin only ever becomes isActive
  // via adminVerify(), which sets isPhoneVerified and
  // isActive together in one transaction, so in the
  // normal flow the two facts already move in lockstep.
  // The seeded SUPER_ADMIN account (AdminSeeder) is
  // created isActive: true without ever going through
  // adminVerify(), so it may not have isPhoneVerified
  // set — adding that check here would lock the seeded
  // super-admin out of their own system.
  // ─────────────────────────────────────────────

  async adminLogin(
    data: AdminLoginDto,
  ): Promise<TokenPair> {
    const phone =
      this.normalizePhoneOrThrow(
        data.phone,
      );

    const user =
      await this.prisma.user.findUnique({
        where: {
          phone,
        },

        include: {
          userRoles: {
            include: {
              role: true,
            },
          },
        },
      });

    const roles =
      user?.userRoles.map(
        (userRole) =>
          userRole.role.name,
      ) ?? [];

    const isAdmin = roles.some(
      (role) =>
        [
          RolesEnum.ADMIN,
          RolesEnum.SUPER_ADMIN,
        ].includes(role as RolesEnum),
    );

    if (
      !user ||
      !user.password ||
      !isAdmin
    ) {
      this.eventEmitter.emit(
        AuditEventEnum.LOGIN_FAILED,
        {
          userId:
            user?.id ?? null,

          actorType:
            resolveActorType(
              roles,
            ),

          action:
            AuditEventEnum.LOGIN_FAILED,

          entity: 'User',

          entityId:
            user?.id ?? null,

          diff: {
            method:
              'password',

            context: 'admin_login',

            result:
              'failed',
          },
        } as AuditEventPayload,
      );

      throw new UnauthorizedException(
        'invalid_credentials',
      );
    }

    if (!user.isActive) {
      this.eventEmitter.emit(
        AuditEventEnum.LOGIN_FAILED,
        {
          userId: user.id,

          actorType:
            resolveActorType(
              roles,
            ),

          action:
            AuditEventEnum.LOGIN_FAILED,

          entity: 'User',

          entityId: user.id,

          diff: {
            method:
              'password',

            context: 'admin_login',

            result:
              'failed',

            reason:
              'account_inactive',
          },
        } as AuditEventPayload,
      );

      /*
       * Covers both a deactivated admin AND a
       * pending admin that hasn't been verified by
       * its creator yet — either way, no OTP is
       * sent from here. Admin activation only ever
       * happens through adminVerify().
       */
      throw new UnauthorizedException(
        'account_inactive',
      );
    }

    const validPassword =
      await bcrypt.compare(
        data.password,
        user.password,
      );

    if (!validPassword) {
      this.eventEmitter.emit(
        AuditEventEnum.LOGIN_FAILED,
        {
          userId: user.id,

          actorType:
            resolveActorType(
              roles,
            ),

          action:
            AuditEventEnum.LOGIN_FAILED,

          entity: 'User',

          entityId: user.id,

          diff: {
            method:
              'password',

            context: 'admin_login',

            result:
              'failed',
          },
        } as AuditEventPayload,
      );

      throw new UnauthorizedException(
        'invalid_credentials',
      );
    }

    this.eventEmitter.emit(
      AuditEventEnum.LOGIN_SUCCESS,
      {
        userId: user.id,

        actorType:
          resolveActorType(
            roles,
          ),

        action:
          AuditEventEnum.LOGIN_SUCCESS,

        entity: 'User',

        entityId: user.id,

        diff: {
          method:
            'password',

          context: 'admin_login',

          result:
            'success',
        },
      } as AuditEventPayload,
    );

    return this.issueTokens(
      user.id,
      user.phone,
      roles,
    );
  }

  // ─────────────────────────────────────────────
  // ISSUE TOKENS
  // ─────────────────────────────────────────────

  private async issueTokens(
    userId: string,
    phone: string,
    roles: string[],
    /*
     * Optional Prisma transaction client. Passed by
     * refresh() so the new session is created inside
     * the same transaction as the old session's
     * deletion — otherwise there'd be a brief window
     * where the old session is gone and the new one
     * doesn't exist yet. Every other caller (login,
     * verifySignupOtp, adminLogin, ...) omits this and
     * gets the default top-level `this.prisma` client.
     */
    tx: Pick<
      typeof this.prisma,
      'session'
    > = this.prisma,
  ): Promise<TokenPair> {
    let expiresInStr =
      this.configService.get<string>(
        'jwt.expiresIn',
        '24h',
      );

    /*
     * Support:
     *
     * jwt.expiresIn = "24"
     *
     * which becomes "24h".
     */
    if (
      /^\d+$/.test(
        expiresInStr,
      )
    ) {
      expiresInStr =
        `${expiresInStr}h`;
    }

    const expiresIn =
      expiresInStr as any;

    const accessToken =
      this.jwtService.sign(
        {
          sub: userId,
          phone,
          roles,
        },
        {
          expiresIn,
        },
      );

    /*
     * Refresh tokens are signed with a dedicated
     * secret/TTL where configured, so a leaked
     * access-token secret alone can't be used to
     * forge refresh tokens. Falls back to the
     * access-token secret/7d only if no refresh
     * config is set — set JWT_REFRESH_SECRET and
     * JWT_REFRESH_EXPIRES_IN in production.
     */
    const refreshSecret =
      this.configService.get<string>(
        'jwt.refreshSecret',
      ) ??
      this.configService.getOrThrow<string>(
        'jwt.secret',
      );

    const refreshExpiresIn =
      this.configService.get<string>(
        'jwt.refreshExpiresIn',
        '7d',
      );

    const refreshToken =
      this.jwtService.sign(
        {
          sub: userId,
          phone,
          roles,
          type: 'refresh',
          /*
           * jti gives each refresh token a unique
           * identity independent of its payload, so
           * two tokens minted in the same second for
           * the same user (e.g. concurrent logins)
           * are still distinguishable — useful for
           * future reuse-detection/tombstoning work.
           */
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

        /*
         * Store a hash of the refresh token, not the
         * raw token. If the sessions table is ever
         * read (a DB dump, a misconfigured backup, an
         * insider with read access), a hash can't be
         * replayed the way a raw refresh token could.
         * Lookups still work because the hash is
         * deterministic (HMAC-SHA256 keyed on the
         * refresh secret) — hash the incoming token the
         * same way and compare by equality; see
         * hashRefreshToken() below. The raw token is
         * still returned to the client here — only
         * server-side storage changes.
         */
        refreshToken:
          this.hashRefreshToken(
            refreshToken,
          ),

        expiresAt:
          new Date(
            Date.now() +
              this.parseDurationToMs(
                refreshExpiresIn,
              ),
          ),
      },
    });

    return {
      accessToken,
      refreshToken,
    };
  }

  // ─────────────────────────────────────────────
  // HASH REFRESH TOKEN
  //
  // Deterministic HMAC-SHA256 keyed on the refresh
  // secret, so the same raw token always hashes to the
  // same value and can be looked up by equality — unlike
  // bcrypt, which salts per-call and can't be queried
  // directly. This is specifically for indexing/lookup,
  // not password-style storage; the refresh token itself
  // is already a high-entropy signed JWT, so HMAC is
  // sufficient to prevent a DB-read from yielding a
  // replayable token.
  // ─────────────────────────────────────────────

  private hashRefreshToken(
    token: string,
  ): string {
    const refreshSecret =
      this.configService.get<string>(
        'jwt.refreshSecret',
      ) ??
      this.configService.getOrThrow<string>(
        'jwt.secret',
      );

    return createHmac(
      'sha256',
      refreshSecret,
    )
      .update(token)
      .digest('hex');
  }

  // ─────────────────────────────────────────────
  // PARSE DURATION STRING
  //
  // Converts a config duration like "7d", "24h",
  // "30m", "45s", or a bare number of seconds ("3600")
  // into milliseconds. Used so the DB session's
  // expiresAt always matches whatever jwt.refreshExpiresIn
  // is actually configured to, instead of a value
  // hard-coded separately from it — the two must never
  // be able to drift apart.
  // ─────────────────────────────────────────────

  private parseDurationToMs(
    duration: string,
  ): number {
    const match =
      /^(\d+)\s*(d|h|m|s)?$/.exec(
        duration.trim(),
      );

    if (!match) {
      throw new BadRequestException(
        'invalid_duration_config',
      );
    }

    const value = Number(match[1]);
    const unit = match[2] ?? 's';

    const unitMs: Record<
      string,
      number
    > = {
      d: 24 * 60 * 60 * 1000,
      h: 60 * 60 * 1000,
      m: 60 * 1000,
      s: 1000,
    };

    return value * unitMs[unit];
  }

  // ─────────────────────────────────────────────
  // ISSUE + SEND OTP (shared helper)
  //
  // Invalidates any outstanding, unused OTP of the
  // given purpose for this user, creates a fresh one,
  // and sends it via SMS. Used by every code path that
  // needs to (re)send an OTP: signup's "existing but
  // unverified account" branch, resendSignupOtp,
  // forgotPassword, and login's verification-required
  // branch.
  //
  // A short cooldown guards against this being used to
  // spam SMS — e.g. someone repeatedly hitting login or
  // signup with a known phone number to trigger sends.
  // The global ThrottlerGuard (app.module.ts) also
  // covers this at the request-rate level; this is a
  // second, per-user/per-purpose guard on top of that.
  //
  // FIX: previously this threw BadRequestException
  // ('otp_recently_sent') when called again inside the
  // cooldown window, but none of its callers (signup,
  // login, forgotPassword) caught that exception — so a
  // legitimate, ordinary retry (e.g. a user hitting
  // login twice in a row while unverified) surfaced as
  // a raw, unhandled 400 instead of a clean response.
  // Now, when the cooldown is active, this simply
  // returns the existing, still-valid verificationId
  // without regenerating the OTP or re-sending SMS —
  // every caller gets a normal, usable response either
  // way.
  // ─────────────────────────────────────────────

  private async issueAndSendOtp(
    userId: string,
    phone: string,
    purpose: UserOtpPurposeEnum,
  ): Promise<{ verificationId: string }> {
    const cooldownSeconds =
      this.configService.get<number>(
        'otp.resendCooldownSeconds',
        60,
      );

    const otpExpiresInMinutes =
      this.configService.get<number>(
        'otp.expiresInMinutes',
        10,
      );

    const otp =
      this.generateOtp();

    const otpHash =
      await bcrypt.hash(
        otp,
        12,
      );

    /*
     * The cooldown check and the create+invalidate
     * step are wrapped in one interactive transaction
     * so the window between "read the latest OTP" and
     * "write the new one" is as small as it can be at
     * the application layer. This narrows the race
     * significantly but does not fully close it —
     * Prisma's default transaction isolation lets two
     * concurrent transactions both read the same
     * "no recent OTP" state before either commits its
     * write. Fully closing it requires a DB-level
     * guard (e.g. a partial unique index on
     * (userId, purpose) where usedAt IS NULL, or
     * SELECT ... FOR UPDATE via a raw query) — add
     * one of those once the schema is available.
     */
    const result =
      await this.prisma.$transaction(
        async (tx) => {
          const latestOtp =
            await tx.userOtp.findFirst({
              where: {
                userId,
                purpose,
              },

              orderBy: {
                createdAt: 'desc',
              },
            });

          const cooldownActive =
            !!latestOtp &&
            !latestOtp.usedAt &&
            Date.now() -
              latestOtp.createdAt.getTime() <
              cooldownSeconds * 1000;

          if (cooldownActive) {
            /*
             * Reuse the existing OTP/verificationId
             * rather than throwing. Nothing is
             * regenerated and no SMS is sent — the
             * client already has (or can look up) the
             * code tied to this verificationId from
             * the earlier send.
             */
            return {
              reused: true as const,
              verificationId: latestOtp!.id,
            };
          }

          await tx.userOtp.updateMany({
            where: {
              userId,
              purpose,
              usedAt: null,
            },

            data: {
              usedAt: new Date(),
            },
          });

          const created =
            await tx.userOtp.create({
              data: {
                userId,
                otpHash,

                expiresAt:
                  new Date(
                    Date.now() +
                      otpExpiresInMinutes *
                        60 *
                        1000,
                  ),

                purpose,
              },
            });

          return {
            reused: false as const,
            verificationId: created.id,
          };
        },
      );

    if (result.reused) {
      /*
       * Cooldown still active — don't resend SMS or
       * log a dev OTP, since no new code was generated.
       */
      return {
        verificationId: result.verificationId,
      };
    }

    const smsMessage =
      renderOtpSms({
        otp,
        expiresInMinutes:
          otpExpiresInMinutes,
      });

    try {
      await sendSms(
        phone,
        smsMessage,
      );
    } catch (error) {
      console.error(
        `[EHTE SMS] Failed to send OTP (${purpose}) to ${phone}`,
        error,
      );
    }

    /*
     * DEVELOPMENT ONLY
     */
    if (
      this.configService.get<boolean>(
        'app.debug',
        false,
      )
    ) {
      console.log(
        `[EHTE DEV] OTP (${purpose}) for ${phone}: ${otp}`,
      );
    }

    return {
      verificationId: result.verificationId,
    };
  }

  // ─────────────────────────────────────────────
  // PHONE NORMALIZATION (wrapper)
  //
  // normalizePhoneNumber() throws a raw Error on
  // malformed input (see phone.util.ts — it now
  // validates against a strict Ethiopian mobile
  // regex). Wrap it here so every call site gets a
  // clean 400 BadRequestException instead of an
  // unhandled 500.
  // ─────────────────────────────────────────────

  private normalizePhoneOrThrow(
    phone: string,
  ): string {
    try {
      return normalizePhoneNumber(phone);
    } catch {
      throw new BadRequestException(
        'invalid_phone_number',
      );
    }
  }

  // ─────────────────────────────────────────────
  // GENERATE OTP
  //
  // Uses crypto.randomInt (CSPRNG) instead of
  // Math.random(), which is not cryptographically
  // secure and must never be used for anything
  // security-sensitive like an OTP.
  // ─────────────────────────────────────────────

  private generateOtp(): string {
    return randomInt(
      100000,
      1000000,
    ).toString();
  }
}
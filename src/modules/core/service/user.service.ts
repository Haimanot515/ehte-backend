import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import {
  AuditOutcome,
  AuditSeverity,
  LoginResultEnum,
  OtpChannelEnum,
  Prisma,
  UserOtpPurposeEnum,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { normalizePhoneNumber } from 'src/common/utils/phone.util';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import { OtpUtil } from 'src/common/utils/otp.util';
import { LockoutUtil } from 'src/common/utils/lockout.util';
import { MinioService } from 'src/services/minio/minio.service';
import { CacheService } from 'src/services/redis/cache.service';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import {
  AdminActionReasonDto,
  AdminChangePhoneDto,
  AdminRequiredReasonDto,
  AdminUpdateDiscreetModeDto,
  AdminUpdateUserDto,
  AssignUserRoleDto,
  BulkRestrictionDto,
  BulkUserIdsDto,
  BulkUserReasonDto,
  BulkWarningDto,
  ChangePhoneInitiateDto,
  ChangePhoneVerifyDto,
  CreateRestrictionDto,
  CreateWarningDto,
  DecideDeletionRequestDto,
  DeletionDecision,
  DeletionRequestStatus,
  InactiveUsersQueryDto,
  LegalHoldDto,
  ListDeleteRequestsQueryDto,
  ListUsersQueryDto,
  MergeUserDto,
  RequestAccountDeletionDto,
  ResendPhoneOtpDto,
  StatsInterval,
  UpdateDiscreetModeDto,
  UpdateLanguageDto,
  UpdateProfilePictureDto,
  UpdateUserDto,
  UserExportQueryDto,
  UserSearchQueryDto,
  UsersPagedQueryDto,
  UserStatsQueryDto,
  UserStatsTimelineQueryDto,
} from '../dto/user.dto';

// ASSUMPTIONS: UserOtpPurposeEnum needs a `phone_change` member (see
// schema-additions.prisma). Session is assumed to have `createdAt`.
// The new methods at the bottom also assume the models/fields listed in the
// "NEW" section; they are reached through `this.db` so the file compiles
// before the schema is aligned.

const DELETION_GRACE_DAYS = 30;
const EXPORT_ROW_CAP = 5000;
const EXPORT_JOB_ROW_CAP = 50000;
const EXPORT_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60_000;
const LINKED_PROVIDERS = ['google', 'facebook', 'apple'];
const OPEN_DELETION_STATUSES = [DeletionRequestStatus.PENDING, DeletionRequestStatus.DELAYED];
const VIEW_ENTITY = 'UserRecordView';

// key -> [prisma model, column pointing at the user]. Edit to match the schema.
const USER_CONTENT_SOURCES: Record<string, [string, string]> = {
  reports: ['report', 'reporterId'],
  informationSubmissions: ['informationSubmission', 'ownerId'],
  posts: ['post', 'ownerId'],
  missingPersons: ['missingPerson', 'ownerId'],
  victimProfiles: ['victimProfile', 'createdById'],
  supports: ['support', 'supporterId'],
  payments: ['payment', 'userId'],
};

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly otpUtil: OtpUtil,
    private readonly lockoutUtil: LockoutUtil,
    private readonly minioService: MinioService,
    private readonly cache: CacheService,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  private getRoles(user: CurrentUserDto): string[] {
    return (user as unknown as { roles?: string[] }).roles ?? [];
  }

  private buildUserLabel(user: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  }): string | undefined {
    return user.name ?? user.phone ?? user.email ?? undefined;
  }

  // Last-4-digits mask, same convention as AuthService.maskPhone.
  private maskPhone(phone: string | null | undefined): string {
    if (!phone) return '****';
    return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
  }

  private normalizePhoneOrThrow(phone: string): string {
    try {
      return normalizePhoneNumber(phone);
    } catch {
      throw new BadRequestException('invalid_phone_number');
    }
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private isSuperAdmin(roleNames: string[]): boolean {
    return roleNames.includes(RolesEnum.SUPER_ADMIN);
  }

  // Profile fields now live on the related UserProfile table (one row per
  // user, created lazily on first updateMe() call touching those fields).
  private readonly profileFieldsSelect = {
    region: true,
    zone: true,
    city: true,
    subCity: true,
    woreda: true,
    kebele: true,
    preferredLanguage: true,
    dateOfBirth: true,
    gender: true,
    alternatePhone: true,
    occupation: true,
    profilePictureUrl: true,
  } as const;

  // Returned when a user has no UserProfile row yet (pre-migration users,
  // or anyone who's never touched a profile field).
  private readonly emptyProfileFields = {
    region: null,
    zone: null,
    city: null,
    subCity: null,
    woreda: null,
    kebele: null,
    preferredLanguage: null,
    dateOfBirth: null,
    gender: null,
    alternatePhone: null,
    occupation: null,
    profilePictureUrl: null,
  } as const;

  // Shared select for getMe/getUserById. Excluded from listUsers()'s
  // select on purpose — see that method.
  private readonly fullProfileSelect = {
    id: true,
    name: true,
    phone: true,
    email: true,
    isActive: true,
    discreetModeEnabled: true,
    discreetModeUpdatedAt: true,
    createdAt: true,
    updatedAt: true,
    profile: { select: this.profileFieldsSelect },
    userRoles: {
      select: { role: { select: { id: true, name: true } } },
    },
  } as const;

  // `profile` is optional here on purpose: listUsers()'s select omits it
  // entirely (bulk address data is out of scope for that endpoint), so
  // this only merges profile fields when the caller actually selected them.
  private shapeProfile<
    T extends {
      userRoles: { role: { id: string; name: string } }[];
      profile?: Record<string, unknown> | null;
    },
  >(user: T) {
    const roles = user.userRoles.map((userRole) => userRole.role);
    const { userRoles: _userRoles, profile, ...userData } = user;
    if (profile === undefined) {
      return { ...userData, roles };
    }
    return { ...userData, ...(profile ?? this.emptyProfileFields), roles };
  }

  // Maps only the fields actually present in an UpdateUserDto into a
  // Prisma UserProfile data object — same defined-check pattern updateMe
  // already used before the profile table split.
  private buildProfileUpsertData(data: UpdateUserDto): Record<string, unknown> {
    return {
      ...(data.region !== undefined && { region: data.region.trim() }),
      ...(data.zone !== undefined && { zone: data.zone.trim() }),
      ...(data.city !== undefined && { city: data.city.trim() }),
      ...(data.subCity !== undefined && { subCity: data.subCity.trim() }),
      ...(data.woreda !== undefined && { woreda: data.woreda.trim() }),
      ...(data.kebele !== undefined && { kebele: data.kebele.trim() }),
      ...(data.preferredLanguage !== undefined && { preferredLanguage: data.preferredLanguage }),
      ...(data.dateOfBirth !== undefined && { dateOfBirth: new Date(data.dateOfBirth) }),
      ...(data.gender !== undefined && { gender: data.gender }),
      ...(data.alternatePhone !== undefined && { alternatePhone: data.alternatePhone.trim() }),
      ...(data.occupation !== undefined && { occupation: data.occupation.trim() }),
    };
  }

  // ── GET CURRENT USER / GET USER BY ID (ADMIN) ──

  async getMe(currentUser: CurrentUserDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
      select: this.fullProfileSelect,
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    return this.shapeProfile(user);
  }

  // No view-audit here — also called internally by deactivate/reactivate/
  // unlock/assignRole/revokeRole, which would double-log every write.
  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: this.fullProfileSelect,
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    return this.shapeProfile(user);
  }

  // ── UPDATE PROFILE ──

  async updateMe(currentUser: CurrentUserDto, data: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: currentUser.id } });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    const profileData = this.buildProfileUpsertData(data);
    const profileTouched = Object.keys(profileData).length > 0;

    if (data.name !== undefined) {
      await this.prisma.user.update({
        where: { id: currentUser.id },
        data: { name: data.name.trim() },
      });
      // `GET /auth/me` is cached and includes the name.
      await this.cache.invalidateProfile(currentUser.id);
    }

    if (profileTouched) {
      // Lazily creates the UserProfile row on first touch — most users
      // will never have one until they fill in an address/demographic field.
      await this.prisma.userProfile.upsert({
        where: { userId: currentUser.id },
        create: { userId: currentUser.id, ...profileData },
        update: profileData,
      });
    }

    const updatedUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: currentUser.id },
      select: this.fullProfileSelect,
    });

    // Address/demographic fields kept out of the diff on purpose — not
    // security-relevant, and ten optional fields would add noise.
    this.emitAudit({
      userId: currentUser.id,
      actorType: resolveActorType(this.getRoles(currentUser)),
      action: AuditEventEnum.USER_UPDATED,
      entity: 'User',
      entityId: currentUser.id,
      entityLabel: this.buildUserLabel(updatedUser),
      diff: {
        result: 'success',
        previousName: user.name ?? null,
        currentName: updatedUser.name ?? null,
        profileUpdated: profileTouched,
      },
    });

    return this.shapeProfile(updatedUser);
  }

  // ── UPDATE PROFILE (ADMIN) ──
  // Same safe fields as updateMe. Role/email/phone/isActive are not touched.

  async adminUpdateUser(
    actor: CurrentUserDto,
    targetUserId: string,
    data: AdminUpdateUserDto,
    reason?: string,
  ) {
    const actorType = resolveActorType(this.getRoles(actor));

    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found' },
      });
      throw new NotFoundException('user_not_found');
    }

    const profileData = this.buildProfileUpsertData(data);
    const profileTouched = Object.keys(profileData).length > 0;
    const nameTouched = data.name !== undefined;

    if (!nameTouched && !profileTouched) {
      throw new BadRequestException('no_changes_provided');
    }

    if (nameTouched) {
      await this.prisma.user.update({
        where: { id: targetUserId },
        data: { name: data.name!.trim() },
      });
    }

    if (profileTouched) {
      await this.prisma.userProfile.upsert({
        where: { userId: targetUserId },
        create: { userId: targetUserId, ...profileData },
        update: profileData,
      });
    }

    // Cached `GET /auth/me` for that user may carry the old values.
    await this.cache.invalidateProfile(targetUserId);

    const updatedUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: targetUserId },
      select: this.fullProfileSelect,
    });

    this.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_UPDATED,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: this.buildUserLabel(updatedUser),
      reason: reason ?? null,
      diff: {
        result: 'success',
        previousName: target.name ?? null,
        currentName: updatedUser.name ?? null,
        profileUpdated: profileTouched,
      },
      metadata: { editedByAdmin: true },
    });

    return this.shapeProfile(updatedUser);
  }

  // ── DISCREET MODE (self-service) ──

  async updateDiscreetMode(currentUser: CurrentUserDto, data: UpdateDiscreetModeDto) {
    const actorType = resolveActorType(this.getRoles(currentUser));

    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        discreetModeEnabled: true,
      },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    if (!user.isActive) {
      this.emitAudit({
        userId: currentUser.id,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: currentUser.id,
        entityLabel: this.buildUserLabel(user),
        diff: { result: 'failure', reason: 'account_inactive' },
        metadata: { attemptedEnabled: data.enabled },
      });
      throw new BadRequestException('account_inactive');
    }

    if (!data.enabled) {
      const updatedUser = await this.prisma.user.update({
        where: { id: currentUser.id },
        data: {
          discreetModeEnabled: false,
          discreetModePasscodeHash: null,
          discreetModeUpdatedAt: new Date(),
        },
        select: { id: true, discreetModeEnabled: true, discreetModeUpdatedAt: true },
      });

      // `GET /auth/me` is cached (discreet-mode fields are part of it).
      await this.cache.invalidateProfile(currentUser.id);

      this.emitAudit({
        userId: currentUser.id,
        actorType,
        action: AuditEventEnum.DISCREET_MODE_DISABLED,
        entity: 'User',
        entityId: currentUser.id,
        entityLabel: this.buildUserLabel(user),
        diff: {
          result: 'success',
          previousEnabled: user.discreetModeEnabled,
          currentEnabled: false,
        },
        metadata: {
          passcodeCleared: true,
          discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt,
        },
      });

      return {
        message: 'discreet_mode_disabled',
        discreetModeEnabled: updatedUser.discreetModeEnabled,
        discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt,
      };
    }

    if (!data.passcode) {
      this.emitAudit({
        userId: currentUser.id,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: currentUser.id,
        entityLabel: this.buildUserLabel(user),
        diff: { result: 'failure', reason: 'discreet_mode_passcode_required' },
        metadata: { wasAlreadyEnabled: user.discreetModeEnabled },
      });
      throw new BadRequestException('discreet_mode_passcode_required');
    }

    const wasAlreadyEnabled = user.discreetModeEnabled;
    const discreetModePasscodeHash = await bcrypt.hash(data.passcode, 10);

    const updatedUser = await this.prisma.user.update({
      where: { id: currentUser.id },
      data: {
        discreetModeEnabled: true,
        discreetModePasscodeHash,
        discreetModeUpdatedAt: new Date(),
      },
      select: { id: true, discreetModeEnabled: true, discreetModeUpdatedAt: true },
    });

    // `GET /auth/me` is cached (discreet-mode fields are part of it).
    await this.cache.invalidateProfile(currentUser.id);

    this.emitAudit({
      userId: currentUser.id,
      actorType,
      action: wasAlreadyEnabled
        ? AuditEventEnum.DISCREET_MODE_PASSCODE_CHANGED
        : AuditEventEnum.DISCREET_MODE_ENABLED,
      entity: 'User',
      entityId: currentUser.id,
      entityLabel: this.buildUserLabel(user),
      diff: { result: 'success', previousEnabled: wasAlreadyEnabled, currentEnabled: true },
      metadata: {
        passcodeRotation: wasAlreadyEnabled,
        discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt,
      },
    });

    return {
      message: wasAlreadyEnabled ? 'discreet_mode_passcode_changed' : 'discreet_mode_enabled',
      discreetModeEnabled: updatedUser.discreetModeEnabled,
      discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt,
    };
  }

  // ── DISCREET MODE (admin, on behalf of another user) ──
  // No notification fired to the target — see NOTES.md.

  async adminUpdateDiscreetMode(
    actor: CurrentUserDto,
    targetUserId: string,
    data: UpdateDiscreetModeDto,
    reason?: string,
  ) {
    const actorType = resolveActorType(this.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        discreetModeEnabled: true,
      },
    });

    if (!targetUser) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found' },
        metadata: { attemptedEnabled: data.enabled },
      });
      throw new NotFoundException('user_not_found');
    }

    const targetLabel = this.buildUserLabel(targetUser);

    if (!targetUser.isActive) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'account_inactive' },
        metadata: { attemptedEnabled: data.enabled, triggeredByAdmin: true },
      });
      throw new BadRequestException('account_inactive');
    }

    if (!data.enabled) {
      const updatedUser = await this.prisma.user.update({
        where: { id: targetUserId },
        data: {
          discreetModeEnabled: false,
          discreetModePasscodeHash: null,
          discreetModeUpdatedAt: new Date(),
        },
        select: { id: true, discreetModeEnabled: true, discreetModeUpdatedAt: true },
      });

      // `GET /auth/me` is cached (discreet-mode fields are part of it).
      await this.cache.invalidateProfile(targetUserId);

      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.DISCREET_MODE_DISABLED,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        reason: reason ?? null,
        diff: {
          result: 'success',
          previousEnabled: targetUser.discreetModeEnabled,
          currentEnabled: false,
        },
        metadata: {
          passcodeCleared: true,
          triggeredByAdmin: true,
          discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt,
        },
      });

      return {
        message: 'discreet_mode_disabled',
        discreetModeEnabled: updatedUser.discreetModeEnabled,
        discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt,
      };
    }

    if (!data.passcode) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'discreet_mode_passcode_required' },
        metadata: { wasAlreadyEnabled: targetUser.discreetModeEnabled, triggeredByAdmin: true },
      });
      throw new BadRequestException('discreet_mode_passcode_required');
    }

    const wasAlreadyEnabled = targetUser.discreetModeEnabled;
    const discreetModePasscodeHash = await bcrypt.hash(data.passcode, 10);

    const updatedUser = await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        discreetModeEnabled: true,
        discreetModePasscodeHash,
        discreetModeUpdatedAt: new Date(),
      },
      select: { id: true, discreetModeEnabled: true, discreetModeUpdatedAt: true },
    });

    // `GET /auth/me` is cached (discreet-mode fields are part of it).
    await this.cache.invalidateProfile(targetUserId);

    this.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: wasAlreadyEnabled
        ? AuditEventEnum.DISCREET_MODE_PASSCODE_CHANGED
        : AuditEventEnum.DISCREET_MODE_ENABLED,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: targetLabel,
      reason: reason ?? null,
      diff: { result: 'success', previousEnabled: wasAlreadyEnabled, currentEnabled: true },
      metadata: {
        passcodeRotation: wasAlreadyEnabled,
        triggeredByAdmin: true,
        discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt,
      },
    });

    return {
      message: wasAlreadyEnabled ? 'discreet_mode_passcode_changed' : 'discreet_mode_enabled',
      discreetModeEnabled: updatedUser.discreetModeEnabled,
      discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt,
    };
  }

  // ── DEACTIVATE ACCOUNT (self-service) ──
  // Now blocks a last-active super admin from deactivating themselves,
  // atomically via transaction — closes the same race as deactivateUser below.

  async deactivateMe(currentUser: CurrentUserDto): Promise<{ message: string }> {
    const actorType = resolveActorType(this.getRoles(currentUser));

    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    if (!user.isActive) {
      this.emitAudit({
        userId: currentUser.id,
        actorType,
        action: AuditEventEnum.USER_DEACTIVATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: currentUser.id,
        entityLabel: this.buildUserLabel(user),
        diff: { result: 'failure', reason: 'account_already_inactive' },
      });
      throw new BadRequestException('account_already_inactive');
    }

    const roleNames = user.userRoles.map((userRole) => userRole.role.name);
    const selfIsSuperAdmin = this.isSuperAdmin(roleNames);

    let sessionsRevoked = 0;

    try {
      await this.prisma.$transaction(async (tx) => {
        if (selfIsSuperAdmin) {
          const otherActiveSuperAdmins = await tx.user.count({
            where: {
              id: { not: currentUser.id },
              isActive: true,
              userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
            },
          });
          if (otherActiveSuperAdmins === 0) {
            throw new ForbiddenException('cannot_deactivate_last_super_admin');
          }
        }

        const result = await tx.user.updateMany({
          where: { id: currentUser.id, isActive: true },
          data: { isActive: false },
        });
        if (result.count === 0) {
          throw new BadRequestException('account_already_inactive');
        }

        const revoked = await tx.session.deleteMany({ where: { userId: currentUser.id } });
        sessionsRevoked = revoked.count;
      });

      // Postgres sessions are gone; drop anything Redis still holds for this user (retried if Redis is down).
      await this.cache.purgeUserCache(currentUser.id);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        this.emitAudit({
          userId: currentUser.id,
          actorType,
          action: AuditEventEnum.USER_DEACTIVATED,
          outcome: AuditOutcome.DENIED,
          severity: AuditSeverity.CRITICAL,
          entity: 'User',
          entityId: currentUser.id,
          entityLabel: this.buildUserLabel(user),
          diff: { result: 'denied', reason: 'cannot_deactivate_last_super_admin' },
          metadata: { selfService: true, targetRoles: roleNames, otherActiveSuperAdmins: 0 },
        });
      } else {
        this.emitAudit({
          userId: currentUser.id,
          actorType,
          action: AuditEventEnum.USER_DEACTIVATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'User',
          entityId: currentUser.id,
          entityLabel: this.buildUserLabel(user),
          diff: { result: 'failure', reason: 'account_transition_conflict' },
          metadata: { selfService: true },
        });
      }
      throw err;
    }

    this.emitAudit({
      userId: currentUser.id,
      actorType,
      action: AuditEventEnum.USER_DEACTIVATED,
      entity: 'User',
      entityId: currentUser.id,
      entityLabel: this.buildUserLabel(user),
      diff: { result: 'success', previousIsActive: true, currentIsActive: false },
      metadata: { selfService: true, sessionsRevoked, wasSuperAdmin: selfIsSuperAdmin },
    });

    return { message: 'account_deactivated' };
  }

  // ── ADMIN — DEACTIVATE USER ──
  // Last-super-admin count check and write now share one transaction
  // (conditional updateMany), closing a two-admin-racing TOCTOU gap.

  async deactivateUser(actor: CurrentUserDto, targetUserId: string, reason?: string) {
    const actorType = resolveActorType(this.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!targetUser) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_DEACTIVATED_BY_ADMIN,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found' },
      });
      throw new NotFoundException('user_not_found');
    }
    const targetLabel = this.buildUserLabel(targetUser);
    const targetRoleNames = targetUser.userRoles.map((userRole) => userRole.role.name);
    const targetIsSuperAdmin = this.isSuperAdmin(targetRoleNames);

    if (!targetUser.isActive) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_DEACTIVATED_BY_ADMIN,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'account_already_inactive' },
      });
      throw new BadRequestException('account_already_inactive');
    }

    let sessionsRevoked = 0;

    try {
      await this.prisma.$transaction(async (tx) => {
        if (targetIsSuperAdmin) {
          const otherActiveSuperAdmins = await tx.user.count({
            where: {
              id: { not: targetUserId },
              isActive: true,
              userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
            },
          });
          if (otherActiveSuperAdmins === 0) {
            throw new ForbiddenException('cannot_deactivate_last_super_admin');
          }
        }

        const result = await tx.user.updateMany({
          where: { id: targetUserId, isActive: true },
          data: { isActive: false },
        });
        if (result.count === 0) {
          throw new BadRequestException('account_already_inactive');
        }

        const revoked = await tx.session.deleteMany({ where: { userId: targetUserId } });
        sessionsRevoked = revoked.count;
      });

      // Postgres sessions are gone; drop anything Redis still holds for this user (retried if Redis is down).
      await this.cache.purgeUserCache(targetUserId);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        this.emitAudit({
          userId: actor.id,
          targetUserId,
          actorType,
          action: AuditEventEnum.USER_DEACTIVATED_BY_ADMIN,
          outcome: AuditOutcome.DENIED,
          severity: AuditSeverity.CRITICAL,
          entity: 'User',
          entityId: targetUserId,
          entityLabel: targetLabel,
          reason: reason ?? null,
          diff: { result: 'denied', reason: 'cannot_deactivate_last_super_admin' },
          metadata: { targetRoles: targetRoleNames, otherActiveSuperAdmins: 0 },
        });
      } else {
        this.emitAudit({
          userId: actor.id,
          targetUserId,
          actorType,
          action: AuditEventEnum.USER_DEACTIVATED_BY_ADMIN,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'User',
          entityId: targetUserId,
          entityLabel: targetLabel,
          diff: { result: 'failure', reason: 'account_transition_conflict' },
        });
      }
      throw err;
    }

    this.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_DEACTIVATED_BY_ADMIN,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: targetLabel,
      reason: reason ?? null,
      diff: { result: 'success', previousIsActive: true, currentIsActive: false },
      metadata: { targetRoles: targetRoleNames, sessionsRevoked },
    });

    return this.getUserById(targetUserId);
  }

  // ── ADMIN — REACTIVATE USER ──
  // Conditional updateMany for consistency; no last-super-admin concern.

  async reactivateUser(actor: CurrentUserDto, targetUserId: string, reason?: string) {
    const actorType = resolveActorType(this.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, phone: true, email: true, isActive: true },
    });
    if (!targetUser) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_REACTIVATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found' },
      });
      throw new NotFoundException('user_not_found');
    }
    const targetLabel = this.buildUserLabel(targetUser);

    const result = await this.prisma.user.updateMany({
      where: { id: targetUserId, isActive: false },
      data: { isActive: true },
    });

    if (result.count === 0) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_REACTIVATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'account_already_active' },
      });
      throw new BadRequestException('account_already_active');
    }

    this.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_REACTIVATED,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: targetLabel,
      reason: reason ?? null,
      diff: { result: 'success', previousIsActive: false, currentIsActive: true },
    });

    return this.getUserById(targetUserId);
  }

  // ── ADMIN — FORCE LOGOUT (all sessions) ──

  async forceLogout(
    actor: CurrentUserDto,
    targetUserId: string,
    reason?: string,
  ): Promise<{ message: string }> {
    const actorType = resolveActorType(this.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, phone: true, email: true },
    });
    if (!targetUser) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_SESSIONS_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found' },
      });
      throw new NotFoundException('user_not_found');
    }
    const revokedSessions = await this.prisma.session.deleteMany({
      where: { userId: targetUserId },
    });
    await this.cache.purgeUserCache(targetUserId);

    this.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_SESSIONS_REVOKED,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: this.buildUserLabel(targetUser),
      reason: reason ?? null,
      diff: { result: 'success' },
      metadata: { scope: 'all_sessions', sessionsRevoked: revokedSessions.count },
    });

    if (actor.id !== targetUserId) {
      this.eventEmitter.emit(NotificationEventEnum.SECURITY_ALERT, {
        userId: targetUserId,
        reason: 'sessions_revoked_by_admin',
      });
    }

    return { message: 'sessions_revoked' };
  }

  // ── SESSIONS — list / revoke one ──
  // Self and admin share these; targetUserId is only recorded when it
  // differs from the actor (i.e. only on the admin path).

  async listSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeSession(
    actor: CurrentUserDto,
    targetUserId: string,
    sessionId: string,
  ): Promise<{ message: string }> {
    const actorType = resolveActorType(this.getRoles(actor));
    const isSelfService = actor.id === targetUserId;

    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId: targetUserId },
    });

    if (!session) {
      this.emitAudit({
        userId: actor.id,
        ...(isSelfService ? {} : { targetUserId }),
        actorType,
        action: AuditEventEnum.USER_SESSIONS_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Session',
        entityId: sessionId,
        diff: { result: 'failure', reason: 'session_not_found' },
        metadata: { scope: 'single_session' },
      });
      throw new NotFoundException('session_not_found');
    }

    await this.prisma.session.delete({ where: { id: sessionId } });
    await this.cache.purgeUserCache(targetUserId);

    this.emitAudit({
      userId: actor.id,
      ...(isSelfService ? {} : { targetUserId }),
      actorType,
      action: AuditEventEnum.USER_SESSIONS_REVOKED,
      entity: 'Session',
      entityId: sessionId,
      diff: { result: 'success' },
      metadata: { scope: 'single_session', selfService: isSelfService },
    });

    return { message: 'session_revoked' };
  }

  // ── CHANGE PHONE (self-service, OTP-gated) ──
  // New phone held in `pendingPhone` until verified, so login on the
  // old number keeps working mid-flow.

  async changePhoneInitiate(
    user: CurrentUserDto,
    data: ChangePhoneInitiateDto,
  ): Promise<{ verificationId: string }> {
    const actorType = resolveActorType(this.getRoles(user));
    const newPhone = this.normalizePhoneOrThrow(data.newPhone);

    const dbUser = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!dbUser) {
      throw new NotFoundException('user_not_found');
    }

    if (dbUser.phone === newPhone) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.INFO,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.buildUserLabel(dbUser),
        diff: { result: 'failure', reason: 'phone_unchanged', context: 'change_phone_initiated' },
      });
      throw new BadRequestException('phone_unchanged');
    }

    const phoneInUse = await this.prisma.user.findUnique({ where: { phone: newPhone } });
    if (phoneInUse && phoneInUse.id !== user.id) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.buildUserLabel(dbUser),
        diff: {
          result: 'failure',
          reason: 'phone_already_registered',
          context: 'change_phone_initiated',
        },
        metadata: { attemptedPhone: this.maskPhone(newPhone) },
      });
      throw new BadRequestException('phone_already_registered');
    }

    try {
      await this.prisma.user.update({ where: { id: user.id }, data: { pendingPhone: newPhone } });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        this.emitAudit({
          userId: user.id,
          actorType,
          action: AuditEventEnum.USER_UPDATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'User',
          entityId: user.id,
          entityLabel: this.buildUserLabel(dbUser),
          diff: {
            result: 'failure',
            reason: 'phone_already_registered',
            context: 'change_phone_initiated',
          },
          metadata: { attemptedPhone: this.maskPhone(newPhone), detectedBy: 'unique_constraint' },
        });
        throw new BadRequestException('phone_already_registered');
      }
      throw error;
    }

    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      user.id,
      newPhone,
      UserOtpPurposeEnum.phone_change,
      OtpChannelEnum.sms,
    );

    this.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.USER_UPDATED,
      entity: 'User',
      entityId: user.id,
      entityLabel: this.buildUserLabel(dbUser),
      diff: {
        result: 'success',
        context: 'change_phone_initiated',
        previousPhoneMasked: this.maskPhone(dbUser.phone),
        newPhoneMasked: this.maskPhone(newPhone),
      },
    });

    return { verificationId };
  }

  async changePhoneVerify(
    user: CurrentUserDto,
    data: ChangePhoneVerifyDto,
  ): Promise<{ message: string }> {
    const actorType = resolveActorType(this.getRoles(user));

    const otpRecord = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      include: { user: { select: { id: true, name: true, phone: true, pendingPhone: true } } },
    });

    if (
      !otpRecord ||
      otpRecord.userId !== user.id ||
      otpRecord.purpose !== UserOtpPurposeEnum.phone_change ||
      otpRecord.usedAt ||
      otpRecord.expiresAt < new Date()
    ) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord?.id ?? null,
        entityLabel: 'phone_change OTP',
        diff: {
          purpose: 'phone_change',
          result: 'failure',
          reason: !otpRecord
            ? 'otp_not_found'
            : otpRecord.userId !== user.id
              ? 'otp_owner_mismatch'
              : otpRecord.purpose !== UserOtpPurposeEnum.phone_change
                ? 'wrong_purpose'
                : otpRecord.usedAt
                  ? 'already_used'
                  : 'expired',
        },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (!otpRecord.user.pendingPhone) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.OTP_VERIFIED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        entityLabel: 'phone_change OTP',
        diff: { purpose: 'phone_change', result: 'failure', reason: 'no_pending_phone_change' },
      });
      throw new BadRequestException('invalid_or_expired_otp');
    }

    if (otpRecord.attempts >= 5) {
      await this.lockoutUtil.lockAccountForOtpAbuse(user.id);
      this.emitAudit({
        targetUserId: user.id,
        actorType: 'SYSTEM',
        action: AuditEventEnum.SECURITY_ALERT,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'UserOtp',
        entityId: otpRecord.id,
        entityLabel: 'phone_change OTP',
        diff: { result: 'denied', reason: 'too_many_otp_attempts', accountLocked: true },
        metadata: { purpose: 'phone_change', attempts: otpRecord.attempts },
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
        await this.lockoutUtil.lockAccountForOtpAbuse(user.id);
        this.emitAudit({
          targetUserId: user.id,
          actorType: 'SYSTEM',
          action: AuditEventEnum.SECURITY_ALERT,
          outcome: AuditOutcome.DENIED,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: 'phone_change OTP',
          diff: { result: 'denied', reason: 'too_many_otp_attempts', accountLocked: true },
          metadata: { purpose: 'phone_change', attempts: updatedOtp.attempts },
        });
      } else {
        this.emitAudit({
          userId: user.id,
          actorType,
          action: AuditEventEnum.OTP_VERIFIED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: 'phone_change OTP',
          diff: { purpose: 'phone_change', result: 'failure', reason: 'wrong_otp' },
          metadata: { attempts: updatedOtp.attempts },
        });
      }
      throw new BadRequestException('invalid_or_expired_otp');
    }

    const newPhone = otpRecord.user.pendingPhone;

    try {
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
          where: { id: user.id },
          data: { phone: newPhone, pendingPhone: null },
        });
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        this.emitAudit({
          userId: user.id,
          actorType,
          action: AuditEventEnum.OTP_VERIFIED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: 'phone_change OTP',
          diff: {
            purpose: 'phone_change',
            result: 'failure',
            reason: 'phone_claimed_by_another_account',
          },
        });
        throw new BadRequestException('phone_already_registered');
      }
      if (error instanceof BadRequestException) {
        this.emitAudit({
          userId: user.id,
          actorType,
          action: AuditEventEnum.OTP_VERIFIED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'UserOtp',
          entityId: otpRecord.id,
          entityLabel: 'phone_change OTP',
          diff: { purpose: 'phone_change', result: 'failure', reason: 'otp_claim_conflict' },
        });
      }
      throw error;
    }

    // Cached profile/session still carry the old phone number.
    await this.cache.purgeUserCache(user.id);

    this.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.OTP_VERIFIED,
      entity: 'UserOtp',
      entityId: otpRecord.id,
      entityLabel: 'phone_change OTP',
      diff: { purpose: 'phone_change', result: 'success' },
      metadata: {
        previousPhoneMasked: this.maskPhone(otpRecord.user.phone),
        newPhoneMasked: this.maskPhone(newPhone),
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.SECURITY_ALERT, {
      userId: user.id,
      reason: 'phone_changed',
    });

    return { message: 'phone_number_changed' };
  }

  // ── PROFILE PICTURE ──
  // Stores only the MinIO key, not a public URL — same convention as
  // Report/Post media; reads go through a presigned URL.

  private async validateProfilePictureFile(filepath: string): Promise<void> {
    const exists = await this.minioService.objectExists(filepath);
    if (!exists) {
      throw new BadRequestException('profile_picture_not_found');
    }

    const stat = await this.minioService.statObject(filepath);
    const maxBytes = 5_242_880;
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

    if (stat.size > maxBytes) {
      throw new BadRequestException('profile_picture_too_large');
    }
    if (!allowedTypes.has(stat.contentType)) {
      throw new BadRequestException('profile_picture_invalid_type');
    }
  }

  async getProfilePictureUrl(user: CurrentUserDto): Promise<{ url: string | null }> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { userId: user.id },
      select: { profilePictureUrl: true },
    });
    if (!profile?.profilePictureUrl) {
      return { url: null };
    }
    const url = await this.minioService.generatePresignedDownloadUrl(profile.profilePictureUrl);
    return { url };
  }

  async updateProfilePicture(user: CurrentUserDto, data: UpdateProfilePictureDto) {
    const actorType = resolveActorType(this.getRoles(user));

    const dbUser = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!dbUser) {
      throw new NotFoundException('user_not_found');
    }

    try {
      await this.validateProfilePictureFile(data.filepath);
    } catch (error) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.buildUserLabel(dbUser),
        diff: {
          result: 'failure',
          context: 'profile_picture_updated',
          reason: error instanceof Error ? error.message : 'validation_failed',
        },
      });
      throw error;
    }

    // Lazily creates the UserProfile row on first picture upload, same as
    // updateMe()'s upsert for other profile fields.
    const previousProfile = await this.prisma.userProfile.findUnique({
      where: { userId: user.id },
      select: { profilePictureUrl: true },
    });
    const previousKey = previousProfile?.profilePictureUrl ?? null;

    await this.prisma.userProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, profilePictureUrl: data.filepath },
      update: { profilePictureUrl: data.filepath },
    });

    // Delete only after the DB write commits.
    if (previousKey && previousKey !== data.filepath) {
      await this.minioService.deleteFile(previousKey).catch(() => undefined);
    }

    this.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.USER_UPDATED,
      entity: 'User',
      entityId: user.id,
      entityLabel: this.buildUserLabel(dbUser),
      diff: { result: 'success', context: 'profile_picture_updated' },
    });

    return { message: 'profile_picture_updated' };
  }

  async removeProfilePicture(user: CurrentUserDto): Promise<{ message: string }> {
    const actorType = resolveActorType(this.getRoles(user));

    const dbUser = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!dbUser) {
      throw new NotFoundException('user_not_found');
    }

    const profile = await this.prisma.userProfile.findUnique({
      where: { userId: user.id },
      select: { profilePictureUrl: true },
    });
    if (!profile?.profilePictureUrl) {
      throw new BadRequestException('no_profile_picture_set');
    }

    const previousKey = profile.profilePictureUrl;
    await this.prisma.userProfile.update({
      where: { userId: user.id },
      data: { profilePictureUrl: null },
    });
    await this.minioService.deleteFile(previousKey).catch(() => undefined);

    this.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.USER_UPDATED,
      entity: 'User',
      entityId: user.id,
      entityLabel: this.buildUserLabel(dbUser),
      diff: { result: 'success', context: 'profile_picture_removed' },
    });

    return { message: 'profile_picture_removed' };
  }

  // ── ADMIN — ASSIGN / REVOKE ROLE ──
  // assignRole only escalates a verified ADMIN to SUPER_ADMIN (ADMIN itself is
  // granted solely by AdminAuthService.promoteUserVerify after the email link).
  // revokeRole gets the same transaction treatment as deactivateUser
  // (last-super-admin race).

  async assignRole(
    actor: CurrentUserDto,
    targetUserId: string,
    data: AssignUserRoleDto,
    reason?: string,
  ) {
    const actorType = resolveActorType(this.getRoles(actor));

    if ((data.role as string) !== RolesEnum.SUPER_ADMIN) {
      throw new BadRequestException('use_admin_promote_flow_for_admin');
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        isEmailVerified: true,
        userRoles: { select: { role: { select: { id: true, name: true } } } },
      },
    });
    if (!targetUser) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_ROLE_ASSIGNED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found', attemptedRole: data.role },
      });
      throw new NotFoundException('user_not_found');
    }
    const targetLabel = this.buildUserLabel(targetUser);
    const previousRoles = targetUser.userRoles.map((userRole) => userRole.role.name);

    // Eligibility: must be active, email-verified, and ALREADY an admin, i.e.
    // someone who went through the email-link promotion.
    const ineligibleReason = !targetUser.isActive
      ? 'user_inactive'
      : !targetUser.isEmailVerified
        ? 'email_not_verified'
        : !previousRoles.includes(RolesEnum.ADMIN)
          ? 'user_must_be_admin_first'
          : null;
    if (ineligibleReason) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_ROLE_ASSIGNED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        reason: reason ?? null,
        diff: { result: 'failure', reason: ineligibleReason, attemptedRole: data.role },
        metadata: { previousRoles },
      });
      throw new BadRequestException(ineligibleReason);
    }

    const role = await this.prisma.role.findUnique({ where: { name: data.role } });
    if (!role) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_ROLE_ASSIGNED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'role_not_found', attemptedRole: data.role },
      });
      throw new BadRequestException('role_not_found');
    }

    const alreadyHeld = previousRoles.includes(role.name);

    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId: targetUserId, roleId: role.id } },
      create: { userId: targetUserId, roleId: role.id },
      update: {},
    });

    if (!alreadyHeld) {
      // Cached session/profile may carry the old role set.
      await this.cache.purgeUserCache(targetUserId);
    }

    this.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_ROLE_ASSIGNED,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: targetLabel,
      reason: reason ?? null,
      diff: {
        result: 'success',
        assignedRole: data.role,
        previousRoles,
        currentRoles: alreadyHeld ? previousRoles : [...previousRoles, role.name],
      },
      metadata: { roleId: role.id, alreadyHeld },
    });

    return this.getUserById(targetUserId);
  }

  async revokeRole(
    actor: CurrentUserDto,
    targetUserId: string,
    role: RolesEnum.ADMIN | RolesEnum.SUPER_ADMIN,
    reason?: string,
  ) {
    const actorType = resolveActorType(this.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        userRoles: { select: { role: { select: { id: true, name: true } } } },
      },
    });
    if (!targetUser) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_ROLE_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found', attemptedRole: role },
      });
      throw new NotFoundException('user_not_found');
    }
    const targetLabel = this.buildUserLabel(targetUser);
    const previousRoles = targetUser.userRoles.map((userRole) => userRole.role.name);

    const roleToRevoke = targetUser.userRoles.find((ur) => ur.role.name === (role as string))?.role;
    if (!roleToRevoke) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_ROLE_REVOKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'user_does_not_have_role', attemptedRole: role },
        metadata: { previousRoles },
      });
      throw new BadRequestException('user_does_not_have_role');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        if (role === RolesEnum.SUPER_ADMIN) {
          const otherActiveSuperAdmins = await tx.user.count({
            where: {
              id: { not: targetUserId },
              isActive: true,
              userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
            },
          });
          if (otherActiveSuperAdmins === 0) {
            throw new ForbiddenException('cannot_remove_last_super_admin');
          }
        }

        await tx.userRole.delete({
          where: { userId_roleId: { userId: targetUserId, roleId: roleToRevoke.id } },
        });
      });

      // A revoked admin role must not survive in a cached session.
      await this.cache.purgeUserCache(targetUserId);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        this.emitAudit({
          userId: actor.id,
          targetUserId,
          actorType,
          action: AuditEventEnum.USER_ROLE_REVOKED,
          outcome: AuditOutcome.DENIED,
          severity: AuditSeverity.CRITICAL,
          entity: 'User',
          entityId: targetUserId,
          entityLabel: targetLabel,
          reason: reason ?? null,
          diff: { result: 'denied', reason: 'cannot_remove_last_super_admin' },
          metadata: { previousRoles, otherActiveSuperAdmins: 0 },
        });
      }
      throw err;
    }

    this.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_ROLE_REVOKED,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: targetLabel,
      reason: reason ?? null,
      diff: {
        result: 'success',
        revokedRole: role,
        previousRoles,
        currentRoles: previousRoles.filter((roleName) => roleName !== (role as string)),
      },
      metadata: { roleId: roleToRevoke.id },
    });

    return this.getUserById(targetUserId);
  }

  // ── ADMIN — UNLOCK USER ──

  async unlockUser(actor: CurrentUserDto, targetUserId: string, reason?: string) {
    const actorType = resolveActorType(this.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        lockedUntil: true,
        failedLoginAttempts: true,
      },
    });
    if (!targetUser) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_UNLOCKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        diff: { result: 'failure', reason: 'user_not_found' },
      });
      throw new NotFoundException('user_not_found');
    }
    const targetLabel = this.buildUserLabel(targetUser);
    if (!targetUser.lockedUntil && targetUser.failedLoginAttempts === 0) {
      this.emitAudit({
        userId: actor.id,
        targetUserId,
        actorType,
        action: AuditEventEnum.USER_UNLOCKED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: targetUserId,
        entityLabel: targetLabel,
        diff: { result: 'failure', reason: 'account_not_locked' },
      });
      throw new BadRequestException('account_not_locked');
    }

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
    });

    // The failed-attempt counter also lives in Redis (keyed by user id or login identifier). Clear all,
    // or the next wrong password can re-lock the account straight after an admin unlock.
    await Promise.all(
      [targetUser.id, targetUser.phone, targetUser.email]
        .filter((id): id is string => !!id)
        .map((id) => this.cache.resetFailedLoginAttempts(id)),
    );

    this.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_UNLOCKED,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: targetLabel,
      reason: reason ?? null,
      diff: {
        result: 'success',
        previousFailedLoginAttempts: targetUser.failedLoginAttempts,
        currentFailedLoginAttempts: 0,
        previousLockedUntil: targetUser.lockedUntil,
        currentLockedUntil: null,
      },
      metadata: {
        wasStillLocked: targetUser.lockedUntil
          ? targetUser.lockedUntil.getTime() > Date.now()
          : false,
      },
    });

    return this.getUserById(targetUserId);
  }

  // ── ADMIN — LIST USERS ──
  // Address fields deliberately excluded from this select.

  async listUsers(query: ListUsersQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;
    const where: any = {};

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.discreetModeEnabled !== undefined)
      where.discreetModeEnabled = query.discreetModeEnabled;
    if (query.roleId) where.userRoles = { some: { roleId: query.roleId } };
    if (query.registrationStatus === 'pending') where.passwordHash = null;
    else if (query.registrationStatus === 'completed') where.passwordHash = { not: null };

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
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
          userRoles: { select: { role: { select: { id: true, name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users.map((user) => this.shapeProfile(user)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // GET /users/me/audit-log and GET /users/:id/audit-log share this.
  async getHistory(userId: string) {
    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      throw new NotFoundException('user_not_found');
    }
    return this.prisma.auditLog.findMany({
      where: { entity: 'User', entityId: userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── ADMIN — DASHBOARD STATS ──

  async getDashboardStats() {
    // Heavy multi-count aggregate: serve from cache for a short TTL (TTL.ADMIN_DASHBOARD_STATS).
    return this.cache.wrapStats('user-dashboard', () => this.getDashboardStatsUncached());
  }

  private async getDashboardStatsUncached() {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalUsers,
      activeUsers,
      inactiveUsers,
      discreetModeEnabledUsers,
      newUsersLast7Days,
      newUsersLast30Days,
      roles,
      superAdminCount,
      adminCount,
      regularUserCount,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { isActive: false } }),
      this.prisma.user.count({ where: { discreetModeEnabled: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      this.prisma.role.findMany({
        select: { id: true, name: true, _count: { select: { userRoles: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.user.count({
        where: { userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } } },
      }),
      this.prisma.user.count({
        where: { userRoles: { some: { role: { name: RolesEnum.ADMIN } } } },
      }),
      this.prisma.user.count({
        where: {
          userRoles: { none: { role: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] } } } },
        },
      }),
    ]);

    return {
      totalUsers,
      activeUsers,
      inactiveUsers,
      discreetModeEnabledUsers,
      newUsersLast7Days,
      newUsersLast30Days,
      superAdminCount,
      adminCount,
      regularUserCount,
      usersByRole: roles.map((role) => ({
        roleId: role.id,
        roleName: role.name,
        userCount: role._count.userRoles,
      })),
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // NEW — shared helpers
  // Needs the schema additions: UserDeletionRequest, UserRestriction, UserWarning, UserConsent,
  // UserExportJob, AbuseReport, and User.legalHold/deletedAt/anonymizedAt.
  // ══════════════════════════════════════════════════════════════════

  private readonly logger = new Logger(UserService.name);

  // Untyped client for the assumed models/fields above; swap to this.prisma once the schema matches.
  private get db(): any {
    return this.prisma as any;
  }

  private readonly listUserSelect = {
    id: true,
    name: true,
    phone: true,
    email: true,
    isActive: true,
    lockedUntil: true,
    createdAt: true,
    userRoles: { select: { role: { select: { id: true, name: true } } } },
  } as const;

  private paging(q: { page?: number; limit?: number }) {
    const page = q.page && q.page > 0 ? q.page : 1;
    const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 100) : 20;
    return { page, limit, skip: (page - 1) * limit };
  }

  private pageMeta(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  private maskEmail(email: string | null | undefined): string | null {
    if (!email) return null;
    const [local, domain] = email.split('@');
    return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
  }

  // Without USER_PII_READ the actor only ever sees masked contact details.
  private canSeePii(actor: CurrentUserDto): boolean {
    const permissions = (actor as unknown as { permissions?: string[] }).permissions ?? [];
    return permissions.includes(PermissionsEnum.USER_PII_READ);
  }

  private maskUser<T extends { phone?: string | null; email?: string | null }>(
    actor: CurrentUserDto,
    user: T,
  ): T {
    if (this.canSeePii(actor)) return user;
    return { ...user, phone: this.maskPhone(user.phone), email: this.maskEmail(user.email) };
  }

  private shapeListed(actor: CurrentUserDto, user: any) {
    const { userRoles, ...rest } = user;
    const roles = (userRoles ?? []).map((ur: { role: unknown }) => ur.role);
    return this.maskUser(actor, { ...rest, roles });
  }

  private async requireUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, phone: true, email: true, isActive: true },
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    return user;
  }

  // Single audit entry for the new methods; targetUserId only set when actor != target.
  private auditUser(
    actor: CurrentUserDto,
    targetUserId: string,
    action: AuditEventEnum,
    context: string,
    opts: {
      reason?: string | null;
      severity?: AuditSeverity;
      outcome?: AuditOutcome;
      label?: string;
      diff?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    this.emitAudit({
      userId: actor.id,
      ...(actor.id === targetUserId ? {} : { targetUserId }),
      actorType: resolveActorType(this.getRoles(actor)),
      action,
      ...(opts.outcome && { outcome: opts.outcome }),
      ...(opts.severity && { severity: opts.severity }),
      entity: 'User',
      entityId: targetUserId,
      entityLabel: opts.label,
      reason: opts.reason ?? null,
      diff: { result: 'success', context, ...opts.diff },
      metadata: opts.metadata,
    });
  }

  // Admin reads of a user's record are logged under their own entity so getHistory() stays clean.
  private recordView(actor: CurrentUserDto, targetUserId: string, section: string): void {
    if (actor.id === targetUserId) return;
    this.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType: resolveActorType(this.getRoles(actor)),
      action: AuditEventEnum.USER_UPDATED,
      entity: VIEW_ENTITY,
      entityId: targetUserId,
      diff: { result: 'success', context: 'record_viewed' },
      metadata: { section },
    });
  }

  private async countFor(model: string, where: Record<string, unknown>): Promise<number> {
    try {
      return await this.db[model].count({ where });
    } catch (err) {
      this.logger.warn(`count on "${model}" failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  private async listFor(model: string, args: Record<string, unknown>): Promise<any[]> {
    try {
      return await this.db[model].findMany(args);
    } catch (err) {
      this.logger.warn(`findMany on "${model}" failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private async purgeRelated(models: string[], userId: string): Promise<void> {
    for (const model of models) {
      try {
        await this.db[model].deleteMany({ where: { userId } });
      } catch (err) {
        this.logger.warn(`purge on "${model}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Social logins are columns on User (googleId, facebookId, appleId), not a separate table.
  private async linkedProviders(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { googleId: true, facebookId: true, appleId: true, passwordHash: true },
    });
    const providers = LINKED_PROVIDERS.filter((p) => !!(user as any)?.[`${p}Id`]);
    return { providers, hasPassword: !!user?.passwordHash };
  }

  private async buildSummary(userId: string): Promise<Record<string, number>> {
    const entries = await Promise.all(
      Object.entries(USER_CONTENT_SOURCES).map(
        async ([key, [model, field]]) => [key, await this.countFor(model, { [field]: userId })] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  // Runtime lookup keeps this working whatever the audit enum calls its login/security events.
  private eventsMatching(pattern: RegExp): AuditEventEnum[] {
    return Object.values(AuditEventEnum).filter((v) => pattern.test(String(v))) as AuditEventEnum[];
  }

  private coarseIp(ip: string | null | undefined): string | null {
    if (!ip) return null;
    if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::`;
    return `${ip.split('.').slice(0, 2).join('.')}.x.x`;
  }

  private shapeEvent(row: any) {
    return {
      id: row.id,
      event: row.action,
      outcome: row.outcome,
      at: row.createdAt,
      device: row.userAgent ?? null,
      location: this.coarseIp(row.ipAddress),
    };
  }

  private async auditPage(
    where: Prisma.AuditLogWhereInput,
    query: { page?: number; limit?: number },
    mapRow?: (row: any) => unknown,
  ) {
    const { page, limit, skip } = this.paging(query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data: mapRow ? rows.map(mapRow) : rows, meta: this.pageMeta(page, limit, total) };
  }

  private rangeOf(q: UserStatsQueryDto, defaultDays: number) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - defaultDays * 86_400_000);
    return { from, to };
  }

  private statsWhere(q: UserStatsQueryDto): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = {};
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from && { gte: new Date(q.from) }),
        ...(q.to && { lte: new Date(q.to) }),
      };
    }
    if (q.role) where.userRoles = { some: { role: { name: q.role } } };
    if (q.region) where.profile = { is: { region: q.region } };
    if (q.status === 'active') where.isActive = true;
    else if (q.status === 'inactive') where.isActive = false;
    else if (q.status === 'locked') where.lockedUntil = { gt: new Date() };
    return where;
  }

  private searchWhere(text: string | undefined, q: UserStatsQueryDto): Prisma.UserWhereInput {
    const base = this.statsWhere(q);
    const term = text?.trim();
    if (!term) return base;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term);
    const or: Prisma.UserWhereInput[] = [
      { name: { contains: term, mode: 'insensitive' } },
      { phone: { contains: term } },
    ];
    if (isUuid) or.push({ id: term });
    return { AND: [base, { OR: or }] };
  }

  private bucketKey(date: Date, interval: StatsInterval): string {
    if (interval === StatsInterval.MONTH) return date.toISOString().slice(0, 7);
    if (interval === StatsInterval.WEEK) {
      const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
      return day.toISOString().slice(0, 10);
    }
    return date.toISOString().slice(0, 10);
  }

  private bucketDates(dates: Date[], interval: StatsInterval = StatsInterval.DAY) {
    const counts = new Map<string, number>();
    for (const d of dates) {
      const key = this.bucketKey(d, interval);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  }

  private activeRestrictionWhere() {
    return { liftedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] };
  }

  // Runs one action per user; failures are reported per user, not rolled back.
  private async runBulk(
    actor: CurrentUserDto,
    userIds: string[],
    run: (userId: string) => Promise<unknown>,
  ) {
    const ids = [...new Set(userIds)];
    const failed: { userId: string; reason: string }[] = [];
    let succeeded = 0;
    for (const id of ids) {
      if (id === actor.id) {
        failed.push({ userId: id, reason: 'cannot_target_self' });
        continue;
      }
      try {
        await run(id);
        succeeded++;
      } catch (err) {
        failed.push({
          userId: id,
          reason: err instanceof HttpException ? err.message : 'unexpected_error',
        });
      }
    }
    return { requested: ids.length, succeeded, failed };
  }

  private csvCell(value: unknown): string {
    let text = value instanceof Date ? value.toISOString() : value == null ? '' : String(value);
    // Stop spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  private async buildUsersCsv(actor: CurrentUserDto, query: UserExportQueryDto, cap: number) {
    const rows = await this.prisma.user.findMany({
      where: this.searchWhere(query.search, query),
      select: this.listUserSelect,
      orderBy: { createdAt: 'desc' },
      take: cap + 1,
    });
    const truncated = rows.length > cap;
    const lines = [['id', 'name', 'phone', 'email', 'isActive', 'roles', 'createdAt'].join(',')];
    for (const row of rows.slice(0, cap)) {
      const u = this.shapeListed(actor, row) as any;
      lines.push(
        [
          u.id,
          u.name,
          u.phone,
          u.email,
          u.isActive,
          u.roles.map((r: { name: string }) => r.name).join('|'),
          u.createdAt,
        ]
          .map((v) => this.csvCell(v))
          .join(','),
      );
    }
    return { csv: lines.join('\n'), rowCount: lines.length - 1, truncated };
  }

  // ══════════════════════════════════════════════════════════════════
  // NEW — self-service (US-01 .. US-14)
  // ══════════════════════════════════════════════════════════════════

  async getMyDataExport(currentUser: CurrentUserDto) {
    const userId = currentUser.id;
    const user = await this.getMe(currentUser);
    const [sessions, activity, consents, linkedAccounts, deletionRequests, notifications, summary] =
      await Promise.all([
        this.listSessions(userId),
        this.prisma.auditLog.findMany({
          where: { OR: [{ userId }, { targetUserId: userId }], entity: { not: VIEW_ENTITY } },
          select: { id: true, action: true, outcome: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 5000,
        }),
        this.listFor('userConsent', { where: { userId }, orderBy: { createdAt: 'desc' } }),
        this.linkedProviders(userId).then((r) => r.providers),
        this.listFor('userDeletionRequest', { where: { userId }, orderBy: { createdAt: 'desc' } }),
        this.listFor('notification', { where: { userId }, orderBy: { createdAt: 'desc' }, take: 1000 }),
        this.buildSummary(userId),
      ]);

    this.auditUser(currentUser, userId, AuditEventEnum.USER_UPDATED, 'data_export');

    return {
      exportedAt: new Date().toISOString(),
      user,
      summary,
      sessions,
      activity,
      consents,
      linkedAccounts,
      deletionRequests,
      notifications,
    };
  }

  async requestMyDeletion(currentUser: CurrentUserDto, data: RequestAccountDeletionDto) {
    const user = await this.db.user.findUnique({
      where: { id: currentUser.id },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        legalHold: true,
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!user) throw new NotFoundException('user_not_found');
    if (user.legalHold) throw new ForbiddenException('account_on_legal_hold');

    const roleNames: string[] = user.userRoles.map((ur: any) => ur.role.name);
    if (this.isSuperAdmin(roleNames)) {
      const others = await this.prisma.user.count({
        where: {
          id: { not: user.id },
          isActive: true,
          userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
        },
      });
      if (others === 0) throw new ForbiddenException('cannot_delete_last_super_admin');
    }

    const open = await this.db.userDeletionRequest.findFirst({
      where: { userId: user.id, status: { in: OPEN_DELETION_STATUSES } },
    });
    if (open) throw new BadRequestException('deletion_already_requested');

    const scheduledFor = new Date(Date.now() + DELETION_GRACE_DAYS * 86_400_000);
    const request = await this.db.userDeletionRequest.create({
      data: {
        userId: user.id,
        reason: data.reason?.trim() || null,
        status: DeletionRequestStatus.PENDING,
        scheduledFor,
      },
    });

    this.auditUser(currentUser, user.id, AuditEventEnum.USER_UPDATED, 'deletion_requested', {
      severity: AuditSeverity.WARNING,
      label: this.buildUserLabel(user),
      diff: { requestId: request.id, scheduledFor },
    });

    return { message: 'deletion_requested', requestId: request.id, scheduledFor };
  }

  async cancelMyDeletionRequest(currentUser: CurrentUserDto): Promise<{ message: string }> {
    const result = await this.db.userDeletionRequest.updateMany({
      where: { userId: currentUser.id, status: { in: OPEN_DELETION_STATUSES } },
      data: { status: DeletionRequestStatus.CANCELLED },
    });
    if (result.count === 0) throw new NotFoundException('no_open_deletion_request');

    this.auditUser(currentUser, currentUser.id, AuditEventEnum.USER_UPDATED, 'deletion_cancelled');
    return { message: 'deletion_request_cancelled' };
  }

  async getMyDeletionRequest(currentUser: CurrentUserDto) {
    const request = await this.db.userDeletionRequest.findFirst({
      where: { userId: currentUser.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, reason: true, scheduledFor: true, createdAt: true },
    });
    return { request: request ?? null };
  }

  async revokeMyOtherSessions(currentUser: CurrentUserDto) {
    const currentSessionId = (currentUser as unknown as { sessionId?: string }).sessionId;
    if (!currentSessionId) throw new BadRequestException('current_session_unknown');

    const revoked = await this.prisma.session.deleteMany({
      where: { userId: currentUser.id, id: { not: currentSessionId } },
    });
    await this.cache.purgeUserCache(currentUser.id);

    this.auditUser(currentUser, currentUser.id, AuditEventEnum.USER_SESSIONS_REVOKED, 'other_sessions', {
      metadata: { scope: 'other_sessions', sessionsRevoked: revoked.count, selfService: true },
    });
    return { message: 'other_sessions_revoked', sessionsRevoked: revoked.count };
  }

  private async loginHistory(userId: string, query: UsersPagedQueryDto) {
    const { page, limit, skip } = this.paging(query);
    const where = { userId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.loginAttempt.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.loginAttempt.count({ where }),
    ]);
    // Never return ipAddress or the raw userAgent (discreet mode); device label and city/country only.
    return {
      data: rows.map((r) => ({
        id: r.id,
        result: r.result,
        failureReason: r.failureReason,
        at: r.createdAt,
        device: r.deviceLabel,
        location: [r.city, r.country].filter(Boolean).join(', ') || null,
      })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  private securityEvents(userId: string, query: UsersPagedQueryDto) {
    return this.auditPage(
      {
        OR: [{ userId }, { targetUserId: userId }],
        action: { in: this.eventsMatching(/password|phone|lock|fail|security|otp|session/i) },
      },
      query,
      (row) => this.shapeEvent(row),
    );
  }

  async getMyLoginHistory(currentUser: CurrentUserDto, query: UsersPagedQueryDto) {
    return this.loginHistory(currentUser.id, query);
  }

  async getMySecurityEvents(currentUser: CurrentUserDto, query: UsersPagedQueryDto) {
    return this.securityEvents(currentUser.id, query);
  }

  async getMySummary(currentUser: CurrentUserDto) {
    return this.buildSummary(currentUser.id);
  }

  async getMyDiscreetMode(currentUser: CurrentUserDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
      select: { discreetModeEnabled: true, discreetModeUpdatedAt: true },
    });
    if (!user) throw new NotFoundException('user_not_found');
    return user;
  }

  async getMyLinkedAccounts(currentUser: CurrentUserDto) {
    const { providers, hasPassword } = await this.linkedProviders(currentUser.id);
    return { accounts: providers.map((provider) => ({ provider })), hasPassword };
  }

  async unlinkMyAccount(currentUser: CurrentUserDto, provider: string): Promise<{ message: string }> {
    const name = provider.toLowerCase();
    if (!LINKED_PROVIDERS.includes(name)) throw new BadRequestException('unsupported_provider');

    const { providers, hasPassword } = await this.linkedProviders(currentUser.id);
    if (!providers.includes(name)) throw new NotFoundException('linked_account_not_found');
    if (!hasPassword && providers.length <= 1) {
      throw new BadRequestException('no_other_sign_in_method');
    }

    await this.db.user.update({ where: { id: currentUser.id }, data: { [`${name}Id`]: null } });
    await this.cache.purgeUserCache(currentUser.id);

    this.auditUser(currentUser, currentUser.id, AuditEventEnum.USER_UPDATED, 'account_unlinked', {
      severity: AuditSeverity.WARNING,
      diff: { provider: name },
    });
    return { message: 'account_unlinked' };
  }

  async getMyConsents(currentUser: CurrentUserDto) {
    return this.listFor('userConsent', {
      where: { userId: currentUser.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateMyLanguage(currentUser: CurrentUserDto, data: UpdateLanguageDto) {
    await this.prisma.userProfile.upsert({
      where: { userId: currentUser.id },
      create: { userId: currentUser.id, preferredLanguage: data.preferredLanguage },
      update: { preferredLanguage: data.preferredLanguage },
    });
    await this.cache.invalidateProfile(currentUser.id);

    this.auditUser(currentUser, currentUser.id, AuditEventEnum.USER_UPDATED, 'language_changed', {
      diff: { preferredLanguage: data.preferredLanguage },
    });
    return { message: 'language_updated', preferredLanguage: data.preferredLanguage };
  }

  async resendChangePhoneOtp(currentUser: CurrentUserDto, data: ResendPhoneOtpDto) {
    const otp = await this.prisma.userOtp.findUnique({
      where: { id: data.verificationId },
      include: { user: { select: { pendingPhone: true } } },
    });
    if (
      !otp ||
      otp.userId !== currentUser.id ||
      otp.purpose !== UserOtpPurposeEnum.phone_change ||
      otp.usedAt ||
      !otp.user.pendingPhone
    ) {
      throw new BadRequestException('invalid_or_expired_otp');
    }
    if (Date.now() - otp.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      throw new BadRequestException('otp_resend_too_soon');
    }

    // Retire the old code so only the newest one verifies.
    await this.prisma.userOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      currentUser.id,
      otp.user.pendingPhone,
      UserOtpPurposeEnum.phone_change,
      OtpChannelEnum.sms,
    );

    this.auditUser(currentUser, currentUser.id, AuditEventEnum.USER_UPDATED, 'change_phone_otp_resent', {
      diff: { newPhoneMasked: this.maskPhone(otp.user.pendingPhone) },
    });
    return { verificationId };
  }

  // ══════════════════════════════════════════════════════════════════
  // NEW — admin lists and queues (US-30 .. US-33, US-40, US-41, US-46, US-48)
  // ══════════════════════════════════════════════════════════════════

  async listRestricted(actor: CurrentUserDto, query: UsersPagedQueryDto) {
    const { page, limit, skip } = this.paging(query);
    const where = this.activeRestrictionWhere();
    const [rows, total] = await Promise.all([
      this.db.userRestriction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: this.listUserSelect } },
      }),
      this.db.userRestriction.count({ where }),
    ]);
    return {
      data: rows.map((r: any) => ({ ...r, user: r.user ? this.shapeListed(actor, r.user) : null })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async listLocked(actor: CurrentUserDto, query: UsersPagedQueryDto) {
    const { page, limit, skip } = this.paging(query);
    const where: Prisma.UserWhereInput = { lockedUntil: { gt: new Date() } };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: { ...this.listUserSelect, failedLoginAttempts: true },
        orderBy: { lockedUntil: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.shapeListed(actor, r)),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async listInactive(actor: CurrentUserDto, query: InactiveUsersQueryDto) {
    const { page, limit, skip } = this.paging(query);
    const days = query.days && query.days > 0 ? query.days : 90;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    // Inactive = older than the cutoff with no successful sign-in since then (or ever).
    const where: Prisma.UserWhereInput = {
      isActive: true,
      createdAt: { lt: cutoff },
      loginAttempts: { none: { result: LoginResultEnum.SUCCESS, createdAt: { gte: cutoff } } },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: this.listUserSelect,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    const last = rows.length
      ? await this.prisma.loginAttempt.groupBy({
          by: ['userId'],
          where: { userId: { in: rows.map((r) => r.id) }, result: LoginResultEnum.SUCCESS },
          _max: { createdAt: true },
        })
      : [];
    const lastLogin = new Map(last.map((l) => [l.userId, l._max.createdAt]));
    return {
      data: rows.map((r) => ({ ...this.shapeListed(actor, r), lastLoginAt: lastLogin.get(r.id) ?? null })),
      meta: { ...this.pageMeta(page, limit, total), days },
    };
  }

  async listDuplicates(actor: CurrentUserDto, query: UsersPagedQueryDto) {
    const { page, limit, skip } = this.paging(query);
    const groupArgs = {
      by: ['name' as const],
      where: { name: { not: null } },
      having: { name: { _count: { gt: 1 } } },
    };
    const [groups, allGroups] = await Promise.all([
      this.prisma.user.groupBy({
        ...groupArgs,
        _count: { _all: true },
        orderBy: { name: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.user.groupBy({ ...groupArgs, _count: { _all: true }, orderBy: { name: 'asc' } }),
    ]);

    const names = groups.map((g) => g.name as string);
    const users = names.length
      ? await this.prisma.user.findMany({
          where: { name: { in: names } },
          select: this.listUserSelect,
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const byName = groups.map((g) => ({
      name: g.name,
      count: g._count._all,
      users: users.filter((u) => u.name === g.name).map((u) => this.shapeListed(actor, u)),
    }));

    let byDevice: unknown[] = [];
    try {
      byDevice = await this.db.deviceToken.groupBy({
        by: ['token'],
        _count: { userId: true },
        having: { userId: { _count: { gt: 1 } } },
        take: 50,
      });
    } catch (err) {
      this.logger.warn(`device duplicate scan failed: ${err instanceof Error ? err.message : err}`);
    }

    return { byName: { data: byName, meta: this.pageMeta(page, limit, allGroups.length) }, byDevice };
  }

  async getPossibleDuplicates(actor: CurrentUserDto, userId: string) {
    const target = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true },
    });
    if (!target) throw new NotFoundException('user_not_found');
    this.recordView(actor, userId, 'possible_duplicates');

    const phoneTail = target.phone ? String(target.phone).replace(/\D/g, '').slice(-9) : null;
    const or: Prisma.UserWhereInput[] = [];
    if (target.name) or.push({ name: { equals: target.name, mode: 'insensitive' } });
    if (phoneTail) or.push({ phone: { endsWith: phoneTail } });
    const candidates = or.length
      ? await this.prisma.user.findMany({
          where: { id: { not: userId }, OR: or },
          select: this.listUserSelect,
          take: 50,
        })
      : [];

    const devices = await this.listFor('deviceToken', { where: { userId }, select: { token: true } });
    const deviceIds = devices.map((d) => d.token).filter(Boolean);
    const shared = deviceIds.length
      ? await this.listFor('deviceToken', {
          where: { token: { in: deviceIds }, userId: { not: userId } },
          select: { userId: true },
        })
      : [];
    const sharedIds = new Set(shared.map((d) => d.userId as string));

    return candidates.map((c) => ({
      ...this.shapeListed(actor, c),
      reasons: [
        ...(target.name && c.name?.toLowerCase() === String(target.name).toLowerCase() ? ['same_name'] : []),
        ...(phoneTail && c.phone?.endsWith(phoneTail) ? ['similar_phone'] : []),
        ...(sharedIds.has(c.id) ? ['shared_device'] : []),
      ],
    }));
  }

  async listAbuseReports(actor: CurrentUserDto, query: UsersPagedQueryDto) {
    const { page, limit, skip } = this.paging(query);
    const where = { targetUserId: { not: null } };
    const [rows, total] = await Promise.all([
      this.db.abuseReport.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.db.abuseReport.count({ where }),
    ]);
    return { data: rows, meta: this.pageMeta(page, limit, total) };
  }

  async listDeleteRequests(actor: CurrentUserDto, query: ListDeleteRequestsQueryDto) {
    const { page, limit, skip } = this.paging(query);
    const where = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.db.userDeletionRequest.findMany({
        where,
        orderBy: { scheduledFor: 'asc' },
        skip,
        take: limit,
        include: { user: { select: this.listUserSelect } },
      }),
      this.db.userDeletionRequest.count({ where }),
    ]);
    return {
      data: rows.map((r: any) => ({ ...r, user: r.user ? this.shapeListed(actor, r.user) : null })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async decideDeleteRequest(actor: CurrentUserDto, requestId: string, data: DecideDeletionRequestDto) {
    const request = await this.db.userDeletionRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('deletion_request_not_found');
    if (!OPEN_DELETION_STATUSES.includes(request.status)) {
      throw new BadRequestException('request_already_decided');
    }

    const target = await this.db.user.findUnique({
      where: { id: request.userId },
      select: { id: true, name: true, phone: true, email: true, legalHold: true },
    });
    if (data.decision === DeletionDecision.APPROVE && target?.legalHold) {
      throw new ForbiddenException('account_on_legal_hold');
    }

    const patch: Record<string, unknown> = {};
    if (data.decision === DeletionDecision.APPROVE) patch.status = DeletionRequestStatus.APPROVED;
    else if (data.decision === DeletionDecision.DECLINE) patch.status = DeletionRequestStatus.DECLINED;
    else {
      const until = data.delayUntil ? new Date(data.delayUntil) : null;
      if (!until || until.getTime() <= Date.now()) {
        throw new BadRequestException('delay_until_must_be_in_future');
      }
      patch.status = DeletionRequestStatus.DELAYED;
      patch.scheduledFor = until;
    }

    const updated = await this.db.userDeletionRequest.update({
      where: { id: requestId },
      data: { ...patch, decidedById: actor.id, decidedAt: new Date(), decisionReason: data.reason },
    });

    this.auditUser(actor, request.userId, AuditEventEnum.USER_UPDATED, 'deletion_decision', {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      label: target ? this.buildUserLabel(target) : undefined,
      diff: { requestId, decision: data.decision, status: updated.status },
    });
    return updated;
  }

  // ══════════════════════════════════════════════════════════════════
  // NEW — search, facets, export (US-54 .. US-60)
  // ══════════════════════════════════════════════════════════════════

  async searchUsers(actor: CurrentUserDto, query: UserSearchQueryDto) {
    const { page, limit, skip } = this.paging(query);
    const where = this.searchWhere(query.q, query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: this.listUserSelect,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.shapeListed(actor, r)),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async getUserFacets(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const where = this.statsWhere(query);
    const [total, active, locked, roleGroups, regionGroups] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.count({ where: { ...where, isActive: true } }),
      this.prisma.user.count({ where: { ...where, lockedUntil: { gt: new Date() } } }),
      this.prisma.userRole.groupBy({
        by: ['roleId'],
        where: { user: where },
        _count: { _all: true },
      }),
      this.prisma.userProfile.groupBy({
        by: ['region'],
        where: { user: where },
        _count: { _all: true },
      }),
    ]);
    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleGroups.map((g) => g.roleId) } },
      select: { id: true, name: true },
    });
    const roleName = new Map(roles.map((r) => [r.id, r.name]));

    return {
      total,
      status: { active, inactive: total - active, locked },
      roles: roleGroups.map((g) => ({
        roleId: g.roleId,
        name: roleName.get(g.roleId) ?? null,
        count: g._count._all,
      })),
      regions: regionGroups.map((g) => ({ region: g.region ?? 'unknown', count: g._count._all })),
    };
  }

  async getUserFilterOptions(actor: CurrentUserDto) {
    const [roles, regions] = await Promise.all([
      this.prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.userProfile.findMany({
        where: { region: { not: null } },
        distinct: ['region'],
        select: { region: true },
        orderBy: { region: 'asc' },
      }),
    ]);
    return {
      roles,
      regions: regions.map((r) => r.region),
      statuses: ['active', 'inactive', 'locked'],
      languages: ['am', 'en'],
    };
  }

  async exportUsersCsv(actor: CurrentUserDto, query: UserExportQueryDto) {
    const { csv, rowCount, truncated } = await this.buildUsersCsv(actor, query, EXPORT_ROW_CAP);
    this.auditUser(actor, actor.id, AuditEventEnum.USER_UPDATED, 'users_exported', {
      severity: AuditSeverity.WARNING,
      diff: { rowCount, truncated, masked: !this.canSeePii(actor), filters: query },
    });
    return { filename: `users-${new Date().toISOString().slice(0, 10)}.csv`, contentType: 'text/csv', rowCount, truncated, csv };
  }

  async createUserExportJob(actor: CurrentUserDto, data: UserExportQueryDto) {
    const job = await this.db.userExportJob.create({
      data: {
        requestedById: actor.id,
        filters: JSON.parse(JSON.stringify(data)),
        status: 'QUEUED',
        expiresAt: new Date(Date.now() + EXPORT_JOB_TTL_MS),
      },
    });
    setImmediate(() => void this.runExportJob(job.id, actor, data));

    this.auditUser(actor, actor.id, AuditEventEnum.USER_UPDATED, 'export_job_created', {
      diff: { jobId: job.id, filters: data },
    });
    return { id: job.id, status: 'QUEUED' };
  }

  private async runExportJob(jobId: string, actor: CurrentUserDto, data: UserExportQueryDto) {
    try {
      await this.db.userExportJob.update({ where: { id: jobId }, data: { status: 'RUNNING' } });
      const { csv, rowCount, truncated } = await this.buildUsersCsv(actor, data, EXPORT_JOB_ROW_CAP);
      await this.db.userExportJob.update({
        where: { id: jobId },
        data: { status: 'DONE', resultCsv: csv, rowCount, truncated, finishedAt: new Date() },
      });
    } catch (err) {
      this.logger.error(`export job ${jobId} failed: ${err instanceof Error ? err.message : err}`);
      await this.db.userExportJob
        .update({
          where: { id: jobId },
          data: { status: 'FAILED', error: 'export_failed', finishedAt: new Date() },
        })
        .catch(() => undefined);
    }
  }

  async getUserExportJob(actor: CurrentUserDto, id: string) {
    const job = await this.db.userExportJob.findFirst({
      where: { id, requestedById: actor.id },
      select: {
        id: true,
        status: true,
        rowCount: true,
        truncated: true,
        error: true,
        createdAt: true,
        finishedAt: true,
        expiresAt: true,
      },
    });
    if (!job) throw new NotFoundException('export_job_not_found');
    return job;
  }

  async getUserExportJobDownload(actor: CurrentUserDto, id: string) {
    const job = await this.db.userExportJob.findFirst({ where: { id, requestedById: actor.id } });
    if (!job) throw new NotFoundException('export_job_not_found');
    if (job.status !== 'DONE') throw new BadRequestException('export_not_ready');
    if (job.expiresAt && job.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('export_expired');
    }

    this.auditUser(actor, actor.id, AuditEventEnum.USER_UPDATED, 'export_job_downloaded', {
      severity: AuditSeverity.WARNING,
      diff: { jobId: id, rowCount: job.rowCount },
    });
    return {
      filename: `users-${id}.csv`,
      contentType: 'text/csv',
      rowCount: job.rowCount,
      truncated: !!job.truncated,
      expiresAt: job.expiresAt,
      csv: job.resultCsv,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // NEW — bulk actions (US-34 .. US-39)
  // Each user goes through the single-user method, so audits and
  // last-super-admin checks behave exactly as on the single routes.
  // ══════════════════════════════════════════════════════════════════

  async bulkForceLogout(actor: CurrentUserDto, data: BulkUserIdsDto) {
    return this.runBulk(actor, data.userIds, (id) => this.forceLogout(actor, id, data.reason));
  }

  async bulkDeactivate(actor: CurrentUserDto, data: BulkUserReasonDto) {
    return this.runBulk(actor, data.userIds, (id) => this.deactivateUser(actor, id, data.reason));
  }

  async bulkReactivate(actor: CurrentUserDto, data: BulkUserIdsDto) {
    return this.runBulk(actor, data.userIds, (id) => this.reactivateUser(actor, id, data.reason));
  }

  async bulkUnlock(actor: CurrentUserDto, data: BulkUserIdsDto) {
    return this.runBulk(actor, data.userIds, (id) => this.unlockUser(actor, id, data.reason));
  }

  async bulkWarn(actor: CurrentUserDto, data: BulkWarningDto) {
    return this.runBulk(actor, data.userIds, (id) =>
      this.createWarning(actor, id, { message: data.message }),
    );
  }

  async bulkRestrict(actor: CurrentUserDto, data: BulkRestrictionDto) {
    const { userIds, ...restriction } = data;
    return this.runBulk(actor, userIds, (id) => this.createRestriction(actor, id, restriction));
  }

  // ══════════════════════════════════════════════════════════════════
  // NEW — statistics (US-61 .. US-70)
  // ══════════════════════════════════════════════════════════════════

  async getUserStatsTimeline(actor: CurrentUserDto, query: UserStatsTimelineQueryDto) {
    const { from, to } = this.rangeOf(query, 30);
    const interval = query.interval ?? StatsInterval.DAY;
    const rows = await this.prisma.user.findMany({
      where: { ...this.statsWhere(query), createdAt: { gte: from, lte: to } },
      select: { createdAt: true },
      take: 200_000,
    });
    return { from, to, interval, series: this.bucketDates(rows.map((r) => r.createdAt), interval) };
  }

  async getUserStatsActive(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const userWhere = this.statsWhere({ ...query, from: undefined, to: undefined });
    const activeSince = async (days: number) =>
      (
        await this.prisma.loginAttempt.groupBy({
          by: ['userId'],
          where: {
            result: LoginResultEnum.SUCCESS,
            userId: { not: null },
            createdAt: { gte: new Date(Date.now() - days * 86_400_000) },
            user: { is: userWhere },
          },
        })
      ).length;
    const [dau, wau, mau, total] = await Promise.all([
      activeSince(1),
      activeSince(7),
      activeSince(30),
      this.prisma.user.count({ where: userWhere }),
    ]);
    return { dau, wau, mau, total, stickiness: mau ? Number((dau / mau).toFixed(3)) : 0 };
  }

  async getUserStatsByRole(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const groups = await this.prisma.userRole.groupBy({
      by: ['roleId'],
      where: { user: this.statsWhere(query) },
      _count: { _all: true },
    });
    const roles = await this.prisma.role.findMany({
      where: { id: { in: groups.map((g) => g.roleId) } },
      select: { id: true, name: true },
    });
    const name = new Map(roles.map((r) => [r.id, r.name]));
    return groups
      .map((g) => ({ roleId: g.roleId, role: name.get(g.roleId) ?? null, count: g._count._all }))
      .sort((a, b) => b.count - a.count);
  }

  async getUserStatsByRegion(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const where = this.statsWhere(query);
    const [groups, total] = await Promise.all([
      this.prisma.userProfile.groupBy({
        by: ['region'],
        where: { user: where },
        _count: { _all: true },
      }),
      this.prisma.user.count({ where }),
    ]);
    const rows = groups.map((g) => ({ region: g.region ?? 'unknown', count: g._count._all }));
    // Users with no profile row have no region at all.
    const withProfile = groups.reduce((sum, g) => sum + g._count._all, 0);
    if (total > withProfile) rows.push({ region: 'unknown', count: total - withProfile });
    return rows.sort((a, b) => b.count - a.count);
  }

  async getUserStatsVerificationFunnel(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const { from, to } = this.rangeOf(query, 30);
    const where = { ...this.statsWhere(query), createdAt: { gte: from, lte: to } };
    const [started, codeSent, verified, active] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.userOtp
        .groupBy({ by: ['userId'], where: { createdAt: { gte: from, lte: to } } })
        .then((rows) => rows.length),
      this.db.user.count({ where: { ...where, isPhoneVerified: true } }),
      this.prisma.user.count({
        where: { ...where, isActive: true, loginAttempts: { some: { result: LoginResultEnum.SUCCESS } } },
      }),
    ]);
    const rate = (n: number) => (started ? Number((n / started).toFixed(3)) : 0);
    return {
      from,
      to,
      steps: [
        { step: 'started', count: started, rate: 1 },
        { step: 'code_sent', count: codeSent, rate: rate(codeSent) },
        { step: 'verified', count: verified, rate: rate(verified) },
        { step: 'active', count: active, rate: rate(active) },
      ],
    };
  }

  async getUserStatsRetention(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const { from, to } = this.rangeOf(query, 120);
    const userWhere: Prisma.UserWhereInput = { ...this.statsWhere(query), createdAt: { gte: from, lte: to } };
    const [users, lastSeen] = await Promise.all([
      this.prisma.user.findMany({ where: userWhere, select: { id: true, createdAt: true }, take: 100_000 }),
      this.prisma.loginAttempt.groupBy({
        by: ['userId'],
        where: { result: LoginResultEnum.SUCCESS, user: { is: userWhere } },
        _max: { createdAt: true },
      }),
    ]);
    const lastLogin = new Map(lastSeen.map((l) => [l.userId, l._max.createdAt]));
    const rows = users.map((u) => ({ createdAt: u.createdAt, lastLoginAt: lastLogin.get(u.id) ?? null }));
    const now = Date.now();
    const windows = [7, 30, 90].map((days) => {
      const eligible = rows.filter((r) => r.createdAt.getTime() <= now - days * 86_400_000);
      const retained = eligible.filter(
        (r) => r.lastLoginAt && r.lastLoginAt.getTime() >= r.createdAt.getTime() + days * 86_400_000,
      );
      return {
        days,
        eligible: eligible.length,
        retained: retained.length,
        rate: eligible.length ? Number((retained.length / eligible.length).toFixed(3)) : 0,
      };
    });
    return { from, to, cohortSize: rows.length, windows };
  }

  async getUserStatsDeactivations(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const { from, to } = this.rangeOf(query, 30);
    const [events, deletionsApproved] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          action: { in: [AuditEventEnum.USER_DEACTIVATED, AuditEventEnum.USER_DEACTIVATED_BY_ADMIN] },
          outcome: AuditOutcome.SUCCESS,
          createdAt: { gte: from, lte: to },
        },
        select: { createdAt: true, reason: true },
        take: 100_000,
      }),
      this.countFor('userDeletionRequest', {
        status: DeletionRequestStatus.APPROVED,
        decidedAt: { gte: from, lte: to },
      }),
    ]);
    const reasons = new Map<string, number>();
    for (const e of events) {
      const key = e.reason?.trim() || 'unspecified';
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    return {
      from,
      to,
      total: events.length,
      deletionsApproved,
      timeline: this.bucketDates(events.map((e) => e.createdAt)),
      reasons: [...reasons.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, 20)
        .map(([reason, count]) => ({ reason, count })),
    };
  }

  async getUserStatsLoginFailures(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const { from, to } = this.rangeOf(query, 30);
    const range = { gte: from, lte: to };
    const [failures, lockEvents, currentlyLocked] = await Promise.all([
      this.prisma.loginAttempt.findMany({
        where: { result: { in: [LoginResultEnum.FAILED, LoginResultEnum.LOCKED] }, createdAt: range },
        select: { createdAt: true },
        take: 200_000,
      }),
      this.prisma.loginAttempt.count({ where: { result: LoginResultEnum.LOCKED, createdAt: range } }),
      this.prisma.user.count({ where: { lockedUntil: { gt: new Date() } } }),
    ]);
    return {
      from,
      to,
      totalFailures: failures.length,
      lockEvents,
      currentlyLocked,
      timeline: this.bucketDates(failures.map((f) => f.createdAt)),
    };
  }

  async getUserStatsRestrictions(actor: CurrentUserDto, query: UserStatsQueryDto) {
    const { from, to } = this.rangeOf(query, 30);
    const range = { createdAt: { gte: from, lte: to } };
    const [restrictions, warnings] = await Promise.all([
      this.listFor('userRestriction', { where: range, select: { createdAt: true, ability: true }, take: 100_000 }),
      this.listFor('userWarning', { where: range, select: { createdAt: true }, take: 100_000 }),
    ]);
    const byAbility = new Map<string, number>();
    for (const r of restrictions) byAbility.set(r.ability, (byAbility.get(r.ability) ?? 0) + 1);
    return {
      from,
      to,
      restrictions: {
        total: restrictions.length,
        timeline: this.bucketDates(restrictions.map((r) => r.createdAt)),
        byAbility: [...byAbility.entries()].map(([ability, count]) => ({ ability, count })),
      },
      warnings: { total: warnings.length, timeline: this.bucketDates(warnings.map((w) => w.createdAt)) },
    };
  }

  async getUserStatsOverview(actor: CurrentUserDto, query: UserStatsQueryDto) {
    return this.cache.wrapStats(`user-stats-overview:${JSON.stringify(query)}`, async () => {
      const [dashboard, timeline, active, byRole, byRegion, funnel, retention, deactivations, loginFailures, restrictions] =
        await Promise.all([
          this.getDashboardStatsUncached(),
          this.getUserStatsTimeline(actor, { ...query, interval: StatsInterval.DAY }),
          this.getUserStatsActive(actor, query),
          this.getUserStatsByRole(actor, query),
          this.getUserStatsByRegion(actor, query),
          this.getUserStatsVerificationFunnel(actor, query),
          this.getUserStatsRetention(actor, query),
          this.getUserStatsDeactivations(actor, query),
          this.getUserStatsLoginFailures(actor, query),
          this.getUserStatsRestrictions(actor, query),
        ]);
      return { dashboard, timeline, active, byRole, byRegion, funnel, retention, deactivations, loginFailures, restrictions };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // NEW — per-user admin reads (US-15 .. US-22, US-26, US-29, US-45, US-53)
  // ══════════════════════════════════════════════════════════════════

  async getUserSummary(actor: CurrentUserDto, userId: string) {
    await this.requireUser(userId);
    this.recordView(actor, userId, 'summary');
    const [counts, openFlags, warnings, activeRestrictions] = await Promise.all([
      this.buildSummary(userId),
      this.countFor('abuseReport', { targetUserId: userId, status: 'OPEN' }),
      this.countFor('userWarning', { userId }),
      this.countFor('userRestriction', { userId, ...this.activeRestrictionWhere() }),
    ]);
    return { ...counts, openFlags, warnings, activeRestrictions };
  }

  async getUserTimeline(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.requireUser(userId);
    this.recordView(actor, userId, 'timeline');
    return this.auditPage(
      { OR: [{ userId }, { targetUserId: userId }], entity: { not: VIEW_ENTITY } },
      query,
      (row) => ({
        id: row.id,
        event: row.action,
        outcome: row.outcome,
        at: row.createdAt,
        actorId: row.userId,
        byAdmin: !!row.targetUserId && row.userId !== userId,
        reason: row.reason ?? null,
      }),
    );
  }

  async getUserSecurityEvents(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.requireUser(userId);
    this.recordView(actor, userId, 'security_events');
    return this.securityEvents(userId, query);
  }

  async getUserLoginHistory(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.requireUser(userId);
    this.recordView(actor, userId, 'login_history');
    return this.loginHistory(userId, query);
  }

  async getUserDevices(actor: CurrentUserDto, userId: string) {
    await this.requireUser(userId);
    this.recordView(actor, userId, 'devices');
    const devices = await this.listFor('deviceToken', {
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return devices.map((d) => ({
      ...d,
      token: typeof d.token === 'string' ? `${d.token.slice(0, 6)}…${d.token.slice(-4)}` : null,
    }));
  }

  async getUserActivity(actor: CurrentUserDto, userId: string, query: UserStatsQueryDto) {
    await this.requireUser(userId);
    this.recordView(actor, userId, 'activity');
    const { from, to } = this.rangeOf(query, 90);
    const entries = await Promise.all(
      Object.entries(USER_CONTENT_SOURCES).map(async ([key, [model, field]]) => {
        const rows = await this.listFor(model, {
          where: { [field]: userId, createdAt: { gte: from, lte: to } },
          select: { createdAt: true },
          take: 5000,
        });
        return [key, this.bucketDates(rows.map((r) => r.createdAt))] as const;
      }),
    );
    return { from, to, series: Object.fromEntries(entries) };
  }

  async getUserPermissions(actor: CurrentUserDto, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { userRoles: { select: { role: { select: { id: true, name: true } } } } },
    });
    if (!user) throw new NotFoundException('user_not_found');
    this.recordView(actor, userId, 'permissions');

    const roles = user.userRoles.map((ur) => ur.role);
    const withPermissions = await this.listFor('role', {
      where: { id: { in: roles.map((r) => r.id) } },
      include: { rolePermissions: { include: { permission: true } } },
    });
    const permissions = new Set<string>();
    for (const role of withPermissions) {
      for (const rp of role.rolePermissions ?? []) {
        const name = rp.permission?.name ?? rp.name;
        if (name) permissions.add(name);
      }
    }
    return { userId, roles: roles.map((r) => r.name), permissions: [...permissions].sort() };
  }

  async getUserFlags(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.requireUser(userId);
    this.recordView(actor, userId, 'flags');
    const { page, limit, skip } = this.paging(query);
    const page_ = { orderBy: { createdAt: 'desc' }, skip, take: limit };
    const [abuseReports, warnings, restrictions] = await Promise.all([
      this.listFor('abuseReport', { where: { targetUserId: userId }, ...page_ }),
      this.listFor('userWarning', { where: { userId }, ...page_ }),
      this.listFor('userRestriction', { where: { userId }, ...page_ }),
    ]);
    return { page, limit, abuseReports, warnings, restrictions };
  }

  async getUserVerification(actor: CurrentUserDto, userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { phone: true, pendingPhone: true, isPhoneVerified: true, isEmailVerified: true, email: true },
    });
    if (!user) throw new NotFoundException('user_not_found');
    this.recordView(actor, userId, 'verification');
    return {
      phone: {
        masked: this.maskPhone(user.phone),
        verified: !!user.isPhoneVerified,
        changePending: !!user.pendingPhone,
      },
      email: { present: !!user.email, verified: !!user.isEmailVerified },
    };
  }

  async getRestrictions(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.requireUser(userId);
    const { page, limit, skip } = this.paging(query);
    const [rows, total] = await Promise.all([
      this.db.userRestriction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.db.userRestriction.count({ where: { userId } }),
    ]);
    const now = Date.now();
    return {
      data: rows.map((r: any) => ({
        ...r,
        active: !r.liftedAt && (!r.endsAt || new Date(r.endsAt).getTime() > now),
      })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async getWarnings(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.requireUser(userId);
    const { page, limit, skip } = this.paging(query);
    const [rows, total] = await Promise.all([
      this.db.userWarning.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.db.userWarning.count({ where: { userId } }),
    ]);
    return { data: rows, meta: this.pageMeta(page, limit, total) };
  }

  async getUserAccessLog(actor: CurrentUserDto, userId: string, query: UsersPagedQueryDto) {
    await this.requireUser(userId);
    return this.auditPage({ entity: VIEW_ENTITY, entityId: userId }, query, (row) => ({
      id: row.id,
      viewedBy: row.userId,
      section: (row.metadata as { section?: string } | null)?.section ?? null,
      at: row.createdAt,
    }));
  }

  // ══════════════════════════════════════════════════════════════════
  // NEW — per-user admin actions (US-23 .. US-28, US-32, US-42 .. US-44, US-47, US-50 .. US-52)
  // ══════════════════════════════════════════════════════════════════

  async forcePasswordReset(actor: CurrentUserDto, userId: string, data: AdminRequiredReasonDto) {
    if (actor.id === userId) throw new BadRequestException('use_change_password_instead');
    const target = await this.requireUser(userId);

    // Random unknown password: the old one stops working and the user must use "forgot password".
    const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    const revoked = await this.prisma.session.deleteMany({ where: { userId } });
    await this.cache.purgeUserCache(userId);

    this.auditUser(actor, userId, AuditEventEnum.USER_SESSIONS_REVOKED, 'force_password_reset', {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      label: this.buildUserLabel(target),
      metadata: { sessionsRevoked: revoked.count },
    });
    this.eventEmitter.emit(NotificationEventEnum.SECURITY_ALERT, {
      userId,
      reason: 'password_reset_forced_by_admin',
    });
    return { message: 'password_reset_forced', sessionsRevoked: revoked.count };
  }

  async revealContact(actor: CurrentUserDto, userId: string, data: AdminRequiredReasonDto) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        profile: { select: { alternatePhone: true } },
      },
    });
    if (!target) throw new NotFoundException('user_not_found');

    // The value itself is never written to the audit log, only the fact it was revealed.
    this.auditUser(actor, userId, AuditEventEnum.USER_UPDATED, 'contact_revealed', {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      label: this.buildUserLabel({ name: target.name }),
      metadata: { revealed: ['phone', 'email', 'alternatePhone'] },
    });
    return {
      userId,
      phone: target.phone,
      email: target.email,
      alternatePhone: target.profile?.alternatePhone ?? null,
    };
  }

  async createRestriction(actor: CurrentUserDto, userId: string, data: CreateRestrictionDto) {
    if (actor.id === userId) throw new BadRequestException('cannot_target_self');
    const target = await this.requireUser(userId);

    const endsAt = data.endsAt ? new Date(data.endsAt) : null;
    if (endsAt && endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('ends_at_must_be_in_future');
    }
    const existing = await this.db.userRestriction.findFirst({
      where: { userId, ability: data.ability, ...this.activeRestrictionWhere() },
    });
    if (existing) throw new BadRequestException('restriction_already_active');

    const restriction = await this.db.userRestriction.create({
      data: { userId, ability: data.ability, reason: data.reason, endsAt, createdById: actor.id },
    });
    await this.cache.purgeUserCache(userId);

    this.auditUser(actor, userId, AuditEventEnum.USER_UPDATED, 'restriction_created', {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      label: this.buildUserLabel(target),
      diff: { restrictionId: restriction.id, ability: data.ability, endsAt },
    });
    return restriction;
  }

  async liftRestriction(
    actor: CurrentUserDto,
    userId: string,
    restrictionId: string,
    data: AdminRequiredReasonDto,
  ) {
    const restriction = await this.db.userRestriction.findFirst({
      where: { id: restrictionId, userId },
    });
    if (!restriction) throw new NotFoundException('restriction_not_found');
    if (restriction.liftedAt) throw new BadRequestException('restriction_already_lifted');

    const updated = await this.db.userRestriction.update({
      where: { id: restrictionId },
      data: { liftedAt: new Date(), liftedById: actor.id, liftReason: data.reason },
    });
    await this.cache.purgeUserCache(userId);

    this.auditUser(actor, userId, AuditEventEnum.USER_UPDATED, 'restriction_lifted', {
      reason: data.reason,
      diff: { restrictionId, ability: restriction.ability },
    });
    return updated;
  }

  async createWarning(actor: CurrentUserDto, userId: string, data: CreateWarningDto) {
    const target = await this.requireUser(userId);
    const warning = await this.db.userWarning.create({
      data: { userId, message: data.message, issuedById: actor.id },
    });

    this.auditUser(actor, userId, AuditEventEnum.USER_UPDATED, 'warning_issued', {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      label: this.buildUserLabel(target),
      diff: { warningId: warning.id },
    });
    this.eventEmitter.emit(NotificationEventEnum.SECURITY_ALERT, {
      userId,
      reason: 'admin_warning',
    });
    return warning;
  }

  async deactivateUserWithReason(actor: CurrentUserDto, userId: string, data: AdminRequiredReasonDto) {
    return this.deactivateUser(actor, userId, data.reason);
  }

  async getErasurePreview(actor: CurrentUserDto, userId: string) {
    const target = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isActive: true,
        legalHold: true,
        anonymizedAt: true,
        profile: { select: { profilePictureUrl: true } },
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!target) throw new NotFoundException('user_not_found');
    this.recordView(actor, userId, 'erasure_preview');

    const roleNames: string[] = target.userRoles.map((ur: any) => ur.role.name);
    const otherSuperAdmins = this.isSuperAdmin(roleNames)
      ? await this.prisma.user.count({
          where: {
            id: { not: userId },
            isActive: true,
            userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
          },
        })
      : null;

    const [sessions, linkedAccounts, devices, auditEntries, content] = await Promise.all([
      this.prisma.session.count({ where: { userId } }),
      this.linkedProviders(userId).then((r) => r.providers.length),
      this.countFor('deviceToken', { userId }),
      this.prisma.auditLog.count({ where: { OR: [{ userId }, { targetUserId: userId }] } }),
      this.buildSummary(userId),
    ]);

    const blockers = [
      ...(target.legalHold ? ['account_on_legal_hold'] : []),
      ...(target.anonymizedAt ? ['already_anonymized'] : []),
      ...(otherSuperAdmins === 0 ? ['last_super_admin'] : []),
      ...(actor.id === userId ? ['cannot_target_self'] : []),
    ];
    return {
      userId,
      canProceed: blockers.length === 0,
      blockers,
      willRemove: {
        name: true,
        phone: true,
        email: true,
        profile: true,
        profilePicture: !!target.profile?.profilePictureUrl,
        sessions,
        linkedAccounts,
        devices,
      },
      willKeep: { auditEntries, content },
    };
  }

  async anonymizeUser(actor: CurrentUserDto, userId: string, data: AdminRequiredReasonDto) {
    if (actor.id === userId) throw new BadRequestException('cannot_anonymize_self');
    const target = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        legalHold: true,
        anonymizedAt: true,
        profile: { select: { profilePictureUrl: true } },
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!target) throw new NotFoundException('user_not_found');
    const label = this.buildUserLabel(target);

    if (target.legalHold) {
      this.auditUser(actor, userId, AuditEventEnum.USER_UPDATED, 'anonymize_denied', {
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.CRITICAL,
        reason: data.reason,
        label,
        diff: { result: 'denied', reason: 'account_on_legal_hold' },
      });
      throw new ForbiddenException('account_on_legal_hold');
    }
    if (target.anonymizedAt) throw new BadRequestException('already_anonymized');

    const roleNames: string[] = target.userRoles.map((ur: any) => ur.role.name);
    if (this.isSuperAdmin(roleNames) && target.isActive) {
      const others = await this.prisma.user.count({
        where: {
          id: { not: userId },
          isActive: true,
          userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
        },
      });
      if (others === 0) throw new ForbiddenException('cannot_anonymize_last_super_admin');
    }

    const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
    const previousPicture: string | null = target.profile?.profilePictureUrl ?? null;

    await this.prisma.$transaction(async (tx) => {
      await (tx as any).user.update({
        where: { id: userId },
        data: {
          name: 'Deleted user',
          // Placeholder keeps the unique phone column valid without leaking the number.
          phone: `anon-${userId}`,
          email: null,
          pendingPhone: null,
          passwordHash,
          isActive: false,
          discreetModeEnabled: false,
          discreetModePasscodeHash: null,
          googleId: null,
          facebookId: null,
          appleId: null,
          anonymizedAt: new Date(),
        },
      });
      await tx.userProfile.deleteMany({ where: { userId } });
      await tx.session.deleteMany({ where: { userId } });
    });

    await this.purgeRelated(['deviceToken'], userId);
    if (previousPicture) await this.minioService.deleteFile(previousPicture).catch(() => undefined);
    await this.cache.purgeUserCache(userId);

    this.auditUser(actor, userId, AuditEventEnum.USER_UPDATED, 'anonymized', {
      severity: AuditSeverity.CRITICAL,
      reason: data.reason,
      label,
    });
    return { message: 'user_anonymized' };
  }

  async setUserLegalHold(actor: CurrentUserDto, userId: string, data: LegalHoldDto) {
    const target = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, email: true, legalHold: true },
    });
    if (!target) throw new NotFoundException('user_not_found');
    if (!!target.legalHold === data.legalHold) {
      throw new BadRequestException(data.legalHold ? 'legal_hold_already_set' : 'no_legal_hold_to_lift');
    }

    await this.db.user.update({ where: { id: userId }, data: { legalHold: data.legalHold } });

    this.auditUser(actor, userId, AuditEventEnum.USER_UPDATED, data.legalHold ? 'legal_hold_set' : 'legal_hold_lifted', {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      label: this.buildUserLabel(target),
      diff: { previousLegalHold: !!target.legalHold, currentLegalHold: data.legalHold },
    });
    return { userId, legalHold: data.legalHold };
  }

  async restoreDeletedUser(actor: CurrentUserDto, userId: string, data: AdminActionReasonDto) {
    const target = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, email: true, deletedAt: true, anonymizedAt: true },
    });
    if (!target) throw new NotFoundException('user_not_found');
    if (target.anonymizedAt) throw new BadRequestException('account_already_erased');

    const approved = await this.db.userDeletionRequest.findFirst({
      where: { userId, status: DeletionRequestStatus.APPROVED },
    });
    if (!target.deletedAt && !approved) throw new BadRequestException('user_not_pending_deletion');
    if (target.deletedAt && Date.now() > target.deletedAt.getTime() + DELETION_GRACE_DAYS * 86_400_000) {
      throw new BadRequestException('grace_period_over');
    }

    await this.db.user.update({ where: { id: userId }, data: { deletedAt: null, isActive: true } });
    await this.db.userDeletionRequest.updateMany({
      where: { userId, status: { in: [DeletionRequestStatus.APPROVED, ...OPEN_DELETION_STATUSES] } },
      data: { status: DeletionRequestStatus.CANCELLED },
    });
    await this.cache.purgeUserCache(userId);

    this.auditUser(actor, userId, AuditEventEnum.USER_REACTIVATED, 'deleted_user_restored', {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      label: this.buildUserLabel(target),
    });
    return this.getUserById(userId);
  }

  async mergeUser(actor: CurrentUserDto, primaryId: string, data: MergeUserDto) {
    const duplicateId = data.duplicateUserId;
    if (duplicateId === primaryId) throw new BadRequestException('cannot_merge_into_self');

    const select = {
      id: true,
      name: true,
      phone: true,
      email: true,
      legalHold: true,
      userRoles: { select: { role: { select: { name: true } } } },
    };
    const [primary, duplicate] = await Promise.all([
      this.db.user.findUnique({ where: { id: primaryId }, select }),
      this.db.user.findUnique({ where: { id: duplicateId }, select }),
    ]);
    if (!primary || !duplicate) throw new NotFoundException('user_not_found');
    if (duplicate.legalHold) throw new ForbiddenException('duplicate_on_legal_hold');

    const privileged = [primary, duplicate].some((u) =>
      u.userRoles.some((ur: any) =>
        ([RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] as string[]).includes(ur.role.name),
      ),
    );
    if (privileged) throw new ForbiddenException('cannot_merge_admin_accounts');

    // One transaction: if any move fails, nothing is merged.
    const moves = Object.values(USER_CONTENT_SOURCES).filter(([model]) => !!this.db[model]);
    const moved: Record<string, number> = {};
    await this.prisma.$transaction(async (tx) => {
      const t = tx as any;
      for (const [model, field] of moves) {
        const result = await t[model].updateMany({
          where: { [field]: duplicateId },
          data: { [field]: primaryId },
        });
        moved[model] = result.count;
      }
      await tx.session.deleteMany({ where: { userId: duplicateId } });
      await t.user.update({ where: { id: duplicateId }, data: { isActive: false } });
    });

    await Promise.all([
      this.cache.purgeUserCache(primaryId),
      this.cache.purgeUserCache(duplicateId),
    ]);

    this.auditUser(actor, primaryId, AuditEventEnum.USER_UPDATED, 'user_merged', {
      severity: AuditSeverity.CRITICAL,
      reason: data.reason,
      label: this.buildUserLabel(primary),
      diff: { duplicateUserId: duplicateId, moved },
    });
    return this.getUserById(primaryId);
  }

  async markPhoneVerified(actor: CurrentUserDto, userId: string, data: AdminRequiredReasonDto) {
    const target = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, email: true, isPhoneVerified: true },
    });
    if (!target) throw new NotFoundException('user_not_found');
    if (target.isPhoneVerified) throw new BadRequestException('phone_already_verified');

    await this.db.user.update({ where: { id: userId }, data: { isPhoneVerified: true } });
    await this.cache.purgeUserCache(userId);

    this.auditUser(actor, userId, AuditEventEnum.USER_UPDATED, 'phone_marked_verified', {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      label: this.buildUserLabel(target),
      diff: { previousVerified: false, currentVerified: true },
    });
    return this.getUserVerification(actor, userId);
  }

  // The code goes to the new number; the user then completes it with POST /users/me/change-phone/verify.
  async adminChangePhone(actor: CurrentUserDto, userId: string, data: AdminChangePhoneDto) {
    const newPhone = this.normalizePhoneOrThrow(data.newPhone);
    const target = await this.requireUser(userId);
    if (target.phone === newPhone) throw new BadRequestException('phone_unchanged');

    const inUse = await this.prisma.user.findUnique({ where: { phone: newPhone } });
    if (inUse && inUse.id !== userId) throw new BadRequestException('phone_already_registered');

    try {
      await this.prisma.user.update({ where: { id: userId }, data: { pendingPhone: newPhone } });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) throw new BadRequestException('phone_already_registered');
      throw error;
    }
    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      userId,
      newPhone,
      UserOtpPurposeEnum.phone_change,
      OtpChannelEnum.sms,
    );

    this.auditUser(actor, userId, AuditEventEnum.USER_UPDATED, 'admin_change_phone_initiated', {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      label: this.buildUserLabel(target),
      diff: {
        previousPhoneMasked: this.maskPhone(target.phone),
        newPhoneMasked: this.maskPhone(newPhone),
      },
    });
    this.eventEmitter.emit(NotificationEventEnum.SECURITY_ALERT, {
      userId,
      reason: 'phone_change_requested_by_admin',
    });
    return { message: 'otp_sent_to_new_phone', verificationId };
  }
}
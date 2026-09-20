import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditOutcome, AuditSeverity, OtpChannelEnum, Prisma, UserOtpPurposeEnum } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { normalizePhoneNumber } from 'src/common/utils/phone.util';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { OtpUtil } from 'src/common/utils/otp.util';
import { LockoutUtil } from 'src/common/utils/lockout.util';
import { MinioService } from 'src/services/minio/minio.service';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import {
  AdminUpdateDiscreetModeDto,
  AssignUserRoleDto,
  ChangePhoneInitiateDto,
  ChangePhoneVerifyDto,
  ListUsersQueryDto,
  UpdateDiscreetModeDto,
  UpdateProfilePictureDto,
  UpdateUserDto,
} from '../dto/user.dto';

// ASSUMPTIONS: UserOtpPurposeEnum needs a `phone_change` member (see
// schema-additions.prisma). Session is assumed to have `createdAt`.

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly otpUtil: OtpUtil,
    private readonly lockoutUtil: LockoutUtil,
    private readonly minioService: MinioService,
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
    return roleNames.includes(RolesEnum.SUPER_ADMIN as string);
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

  // ── DISCREET MODE (self-service) ──

  async updateDiscreetMode(currentUser: CurrentUserDto, data: UpdateDiscreetModeDto) {
    const actorType = resolveActorType(this.getRoles(currentUser));

    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
      select: { id: true, name: true, phone: true, email: true, isActive: true, discreetModeEnabled: true },
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
        data: { discreetModeEnabled: false, discreetModePasscodeHash: null, discreetModeUpdatedAt: new Date() },
        select: { id: true, discreetModeEnabled: true, discreetModeUpdatedAt: true },
      });

      this.emitAudit({
        userId: currentUser.id,
        actorType,
        action: AuditEventEnum.DISCREET_MODE_DISABLED,
        entity: 'User',
        entityId: currentUser.id,
        entityLabel: this.buildUserLabel(user),
        diff: { result: 'success', previousEnabled: user.discreetModeEnabled, currentEnabled: false },
        metadata: { passcodeCleared: true, discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt },
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
      data: { discreetModeEnabled: true, discreetModePasscodeHash, discreetModeUpdatedAt: new Date() },
      select: { id: true, discreetModeEnabled: true, discreetModeUpdatedAt: true },
    });

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
      metadata: { passcodeRotation: wasAlreadyEnabled, discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt },
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
      select: { id: true, name: true, phone: true, email: true, isActive: true, discreetModeEnabled: true },
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
        data: { discreetModeEnabled: false, discreetModePasscodeHash: null, discreetModeUpdatedAt: new Date() },
        select: { id: true, discreetModeEnabled: true, discreetModeUpdatedAt: true },
      });

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
        diff: { result: 'success', previousEnabled: targetUser.discreetModeEnabled, currentEnabled: false },
        metadata: { passcodeCleared: true, triggeredByAdmin: true, discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt },
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
      data: { discreetModeEnabled: true, discreetModePasscodeHash, discreetModeUpdatedAt: new Date() },
      select: { id: true, discreetModeEnabled: true, discreetModeUpdatedAt: true },
    });

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
      metadata: { passcodeRotation: wasAlreadyEnabled, triggeredByAdmin: true, discreetModeUpdatedAt: updatedUser.discreetModeUpdatedAt },
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

  async forceLogout(actor: CurrentUserDto, targetUserId: string, reason?: string): Promise<{ message: string }> {
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
    const revokedSessions = await this.prisma.session.deleteMany({ where: { userId: targetUserId } });

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

  async revokeSession(actor: CurrentUserDto, targetUserId: string, sessionId: string): Promise<{ message: string }> {
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

  async changePhoneInitiate(user: CurrentUserDto, data: ChangePhoneInitiateDto): Promise<{ verificationId: string }> {
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
        diff: { result: 'failure', reason: 'phone_already_registered', context: 'change_phone_initiated' },
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
          diff: { result: 'failure', reason: 'phone_already_registered', context: 'change_phone_initiated' },
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

  async changePhoneVerify(user: CurrentUserDto, data: ChangePhoneVerifyDto): Promise<{ message: string }> {
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
        actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
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
          actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
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
          where: { id: data.verificationId, usedAt: null, attempts: { lt: 5 }, expiresAt: { gt: new Date() } },
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
          diff: { purpose: 'phone_change', result: 'failure', reason: 'phone_claimed_by_another_account' },
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
  // assignRole is a plain upsert (atomic already). revokeRole gets the
  // same transaction treatment as deactivateUser (last-super-admin race).

  async assignRole(actor: CurrentUserDto, targetUserId: string, data: AssignUserRoleDto, reason?: string) {
    const actorType = resolveActorType(this.getRoles(actor));

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
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
      select: { id: true, name: true, phone: true, email: true, lockedUntil: true, failedLoginAttempts: true },
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
      metadata: { wasStillLocked: targetUser.lockedUntil ? targetUser.lockedUntil.getTime() > Date.now() : false },
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
    if (query.discreetModeEnabled !== undefined) where.discreetModeEnabled = query.discreetModeEnabled;
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
        where: { userRoles: { none: { role: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] } } } } },
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
}
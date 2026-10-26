import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditOutcome, AuditSeverity } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import {
  AdminUpdateUserDto,
  UpdateDiscreetModeDto,
  UpdateLanguageDto,
  UpdateProfilePictureDto,
  UpdateUserDto,
} from '../dto/user.dto';
import { UserCommonService } from './user-common.service';
import { FULL_PROFILE_SELECT } from './user.constants';

@Injectable()
export class UserProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly cache: CacheService,
    private readonly userCommonService: UserCommonService,
  ) {}

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
      select: FULL_PROFILE_SELECT,
    });

    // Address/demographic fields kept out of the diff on purpose — not
    // security-relevant, and ten optional fields would add noise.
    this.userCommonService.emitAudit({
      userId: currentUser.id,
      actorType: resolveActorType(this.userCommonService.getRoles(currentUser)),
      action: AuditEventEnum.USER_UPDATED,
      entity: 'User',
      entityId: currentUser.id,
      entityLabel: this.userCommonService.buildUserLabel(updatedUser),
      diff: {
        result: 'success',
        previousName: user.name ?? null,
        currentName: updatedUser.name ?? null,
        profileUpdated: profileTouched,
      },
    });

    return this.userCommonService.shapeProfile(updatedUser);
  }

  // ── UPDATE PROFILE (ADMIN) ──
  // Same safe fields as updateMe. Role/email/phone/isActive are not touched.

  async adminUpdateUser(
    actor: CurrentUserDto,
    targetUserId: string,
    data: AdminUpdateUserDto,
    reason?: string,
  ) {
    const actorType = resolveActorType(this.userCommonService.getRoles(actor));

    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) {
      this.userCommonService.emitAudit({
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
      select: FULL_PROFILE_SELECT,
    });

    this.userCommonService.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType,
      action: AuditEventEnum.USER_UPDATED,
      entity: 'User',
      entityId: targetUserId,
      entityLabel: this.userCommonService.buildUserLabel(updatedUser),
      reason: reason ?? null,
      diff: {
        result: 'success',
        previousName: target.name ?? null,
        currentName: updatedUser.name ?? null,
        profileUpdated: profileTouched,
      },
      metadata: { editedByAdmin: true },
    });

    return this.userCommonService.shapeProfile(updatedUser);
  }

  // ── DISCREET MODE (self-service) ──

  async updateDiscreetMode(currentUser: CurrentUserDto, data: UpdateDiscreetModeDto) {
    const actorType = resolveActorType(this.userCommonService.getRoles(currentUser));

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
      this.userCommonService.emitAudit({
        userId: currentUser.id,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: currentUser.id,
        entityLabel: this.userCommonService.buildUserLabel(user),
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

      this.userCommonService.emitAudit({
        userId: currentUser.id,
        actorType,
        action: AuditEventEnum.DISCREET_MODE_DISABLED,
        entity: 'User',
        entityId: currentUser.id,
        entityLabel: this.userCommonService.buildUserLabel(user),
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
      this.userCommonService.emitAudit({
        userId: currentUser.id,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: currentUser.id,
        entityLabel: this.userCommonService.buildUserLabel(user),
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

    this.userCommonService.emitAudit({
      userId: currentUser.id,
      actorType,
      action: wasAlreadyEnabled
        ? AuditEventEnum.DISCREET_MODE_PASSCODE_CHANGED
        : AuditEventEnum.DISCREET_MODE_ENABLED,
      entity: 'User',
      entityId: currentUser.id,
      entityLabel: this.userCommonService.buildUserLabel(user),
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
    const actorType = resolveActorType(this.userCommonService.getRoles(actor));

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
      this.userCommonService.emitAudit({
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

    const targetLabel = this.userCommonService.buildUserLabel(targetUser);

    if (!targetUser.isActive) {
      this.userCommonService.emitAudit({
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

      this.userCommonService.emitAudit({
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
      this.userCommonService.emitAudit({
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

    this.userCommonService.emitAudit({
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
    const actorType = resolveActorType(this.userCommonService.getRoles(user));

    const dbUser = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!dbUser) {
      throw new NotFoundException('user_not_found');
    }

    try {
      await this.validateProfilePictureFile(data.filepath);
    } catch (error) {
      this.userCommonService.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.USER_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'User',
        entityId: user.id,
        entityLabel: this.userCommonService.buildUserLabel(dbUser),
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

    this.userCommonService.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.USER_UPDATED,
      entity: 'User',
      entityId: user.id,
      entityLabel: this.userCommonService.buildUserLabel(dbUser),
      diff: { result: 'success', context: 'profile_picture_updated' },
    });

    return { message: 'profile_picture_updated' };
  }

  async removeProfilePicture(user: CurrentUserDto): Promise<{ message: string }> {
    const actorType = resolveActorType(this.userCommonService.getRoles(user));

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

    this.userCommonService.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.USER_UPDATED,
      entity: 'User',
      entityId: user.id,
      entityLabel: this.userCommonService.buildUserLabel(dbUser),
      diff: { result: 'success', context: 'profile_picture_removed' },
    });

    return { message: 'profile_picture_removed' };
  }

  async getMyDiscreetMode(currentUser: CurrentUserDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
      select: { discreetModeEnabled: true, discreetModeUpdatedAt: true },
    });
    if (!user) throw new NotFoundException('user_not_found');
    return user;
  }

  async updateMyLanguage(currentUser: CurrentUserDto, data: UpdateLanguageDto) {
    await this.prisma.userProfile.upsert({
      where: { userId: currentUser.id },
      create: { userId: currentUser.id, preferredLanguage: data.preferredLanguage },
      update: { preferredLanguage: data.preferredLanguage },
    });
    await this.cache.invalidateProfile(currentUser.id);

    this.userCommonService.auditUser(
      currentUser,
      currentUser.id,
      AuditEventEnum.USER_UPDATED,
      'language_changed',
      {
        diff: { preferredLanguage: data.preferredLanguage },
      },
    );
    return { message: 'language_updated', preferredLanguage: data.preferredLanguage };
  }
}

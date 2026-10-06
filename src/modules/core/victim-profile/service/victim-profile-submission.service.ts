import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AuditOutcome,
  AuditSeverity,
  Prisma,
  VictimProfile,
  VictimProfileStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { CreateVictimProfileDto, UpdateVictimProfileDto } from '../dto/victim-profile.dto';
import {
  MediaBearing,
  UPDATABLE_FIELD_NAMES,
  money,
  BANK_DETAIL_FIELDS,
} from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly cache: CacheService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  async getMediaDownloadUrl(
    admin: CurrentUserDto,
    id: string,
    key: string,
  ): Promise<{ url: string }> {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const owned = this.victimProfileCommonService.collectMediaFields(profile).includes(key);
    if (!owned) {
      this.victimProfileCommonService.emitAudit({
        userId: admin.id,
        ...this.victimProfileCommonService.targetUserFor(admin, profile),
        actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
        action: AuditEventEnum.VICTIM_PROFILE_MEDIA_DOWNLOADED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'VictimProfile',
        entityId: id,
        entityLabel: this.victimProfileCommonService.profileLabel(profile),
        diff: { result: 'denied', reason: 'media_not_found_on_profile' },
        metadata: { requestedKey: key },
      });
      throw new NotFoundException('media_not_found_on_profile');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      ...this.victimProfileCommonService.targetUserFor(admin, profile),
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_MEDIA_DOWNLOADED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.victimProfileCommonService.profileLabel(profile),
      diff: {
        result: 'success',
      },
      metadata: { key },
    });

    return { url };
  }

  async create(currentUser: CurrentUserDto, data: CreateVictimProfileDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.victimProfile.findFirst({
        where: { createdByUserId: currentUser.id, idempotencyKey },
      });
      if (existing) {
        return existing;
      }
    }

    const merged: MediaBearing = {
      photo: data.photo ?? [],
      video: data.video ?? [],
      audio: data.audio ?? [],
      pdf: data.pdf ?? [],
      document: data.document ?? [],
      other: data.other ?? [],
    };
    this.victimProfileCommonService.assertAttachmentCounts(merged);

    const validated = await this.victimProfileCommonService.validateMediaFilesExist(
      this.victimProfileCommonService.collectMediaFields(merged),
    );
    const totalBytes = validated.reduce((sum, v) => sum + v.size, 0);
    this.victimProfileCommonService.assertTotalBytes(totalBytes);

    let profile: VictimProfile;
    try {
      profile = await this.prisma.victimProfile.create({
        data: {
          name: data.name,
          description: data.description,
          story: data.story,

          supportType: data.supportType,
          supportGoal: data.supportGoal,

          bankAccountName: data.bankAccountName,
          bankAccountNumber: data.bankAccountNumber,
          bankName: data.bankName,

          photo: merged.photo,
          video: merged.video,
          audio: merged.audio,
          pdf: merged.pdf,
          document: merged.document,
          other: merged.other,

          involvesChild: data.involvesChild ?? false,

          status: VictimProfileStatus.PENDING,

          isVerified: false,
          isSafetyReviewed: false,
          isChildSafetyReviewed: false,
          hasConsent: false,
          consentAt: null,
          consentRecordedBy: null,
          isPrivacyReviewed: false,
          isAdminApproved: false,
          isPublished: false,

          createdByUserId: currentUser.id,
          idempotencyKey: idempotencyKey ?? null,
          mediaTotalBytes: totalBytes,

          totalRaised: 0,
        },
      });
    } catch (err) {
      if (
        idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = err.meta?.target as string[] | undefined;
        if (target?.some((t) => t.includes('idempotencyKey'))) {
          const winner = await this.prisma.victimProfile.findFirst({
            where: { createdByUserId: currentUser.id, idempotencyKey },
          });
          if (winner) {
            return winner;
          }
        }
      }
      throw err;
    }

    this.victimProfileCommonService.emitAudit({
      userId: currentUser.id,
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(currentUser)),
      action: AuditEventEnum.VICTIM_PROFILE_CREATED,
      entity: 'VictimProfile',
      entityId: profile.id,
      entityLabel: this.victimProfileCommonService.profileLabel(profile),
      diff: {
        result: 'success',
        status: profile.status,
      },
      metadata: {
        supportType: profile.supportType,
        involvesChild: profile.involvesChild,
        attachmentCount: this.victimProfileCommonService.collectMediaFields(merged).length,
        mediaTotalBytes: totalBytes,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CREATED, {
      userId: profile.createdByUserId,
      victimProfileId: profile.id,
    });

    return profile;
  }

  async findOne(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      include: {
        supports: {
          where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, type: 'FINANCIAL' },
          select: {
            id: true,
            type: true,
            status: true,
            agreementType: true,
            amount: true,
            recipientAmount: true,
            organizationAmount: true,
            platformAmount: true,
            message: true,
            createdAt: true,
          },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    for (const field of BANK_DETAIL_FIELDS) {
      delete (profile as Record<string, unknown>)[field];
    }

    return profile;
  }

  async update(admin: CurrentUserDto, id: string, data: UpdateVictimProfileDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_UPDATED,
    );

    const { added, removed } = this.victimProfileCommonService.diffMediaFields(profile, data);

    const merged: MediaBearing = {
      photo: data.photo ?? profile.photo,
      video: data.video ?? profile.video,
      audio: data.audio ?? profile.audio,
      pdf: data.pdf ?? profile.pdf,
      document: data.document ?? profile.document,
      other: data.other ?? profile.other,
    };

    let newTotalBytes = profile.mediaTotalBytes;

    try {
      this.victimProfileCommonService.assertAttachmentCounts(merged);

      const validatedAdded = await this.victimProfileCommonService.validateMediaFilesExist(added);
      const addedBytes = validatedAdded.reduce((sum, v) => sum + v.size, 0);

      const removedStats = await Promise.allSettled(
        removed.map((fp) => this.minioService.statObject(fp)),
      );
      const removedBytes = removedStats.reduce(
        (sum, r) => sum + (r.status === 'fulfilled' ? r.value.size : 0),
        0,
      );

      newTotalBytes = Math.max(0, profile.mediaTotalBytes + addedBytes - removedBytes);
      this.victimProfileCommonService.assertTotalBytes(newTotalBytes);
    } catch (err) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_UPDATED,
        profile,
        'media_validation_failed',
        { diff: { message: err instanceof Error ? err.message : String(err) } },
      );
      throw err;
    }

    const fieldsUpdated = UPDATABLE_FIELD_NAMES.filter((field) => data[field] !== undefined);
    const bankDetailsChanged =
      (data.bankAccountName !== undefined && data.bankAccountName !== profile.bankAccountName) ||
      (data.bankAccountNumber !== undefined &&
        data.bankAccountNumber !== profile.bankAccountNumber) ||
      (data.bankName !== undefined && data.bankName !== profile.bankName);

    const updatedProfile = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        name: data.name,
        description: data.description,
        story: data.story,

        supportType: data.supportType,
        supportGoal: data.supportGoal,

        bankAccountName: data.bankAccountName,
        bankAccountNumber: data.bankAccountNumber,
        bankName: data.bankName,

        photo: data.photo,
        video: data.video,
        audio: data.audio,
        pdf: data.pdf,
        document: data.document,
        other: data.other,

        involvesChild: data.involvesChild,
        mediaTotalBytes: newTotalBytes,

        status: VictimProfileStatus.PENDING,

        isVerified: false,
        isSafetyReviewed: false,
        isChildSafetyReviewed: false,
        hasConsent: false,

        consentAt: null,
        consentRecordedBy: null,

        isPrivacyReviewed: false,
        isAdminApproved: false,
        isPublished: false,

        childSafetyFirstConfirmedByUserId: null,
        childSafetyFirstConfirmedAt: null,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_UPDATED, profile },
    );

    await this.victimProfileCommonService.deleteMediaFiles(removed);
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      ...this.victimProfileCommonService.targetUserFor(admin, profile),
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_UPDATED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.victimProfileCommonService.profileLabel(updatedProfile),
      diff: {
        result: 'success',
        previousStatus: profile.status,
        newStatus: VictimProfileStatus.PENDING,
        previousIsPublished: profile.isPublished,
        newIsPublished: false,
      },
      metadata: {
        fieldsUpdated,
        bankDetailsChanged,
        mediaAdded: added.length,
        mediaRemoved: removed.length,
        mediaTotalBytes: newTotalBytes,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_UPDATED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  async remove(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_DELETED,
    );

    const unsettled = await this.prisma.payment.findFirst({
      where: {
        victimProfileId: id,
        status: 'PAID',
        allocations: { some: { settlementStatus: 'PENDING' } },
      },
      select: { id: true },
    });
    if (unsettled) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_DELETED,
        profile,
        'victim_profile_has_unsettled_payments',
      );
      throw new ConflictException('victim_profile_has_unsettled_payments');
    }

    const result = await this.prisma.victimProfile.deleteMany({
      where: { id, updatedAt: profile.updatedAt },
    });

    if (result.count === 0) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_DELETED,
        profile,
        'victim_profile_transition_conflict',
      );
      throw new BadRequestException('victim_profile_transition_conflict');
    }

    const mediaKeys = this.victimProfileCommonService.collectMediaFields(profile);
    await this.victimProfileCommonService.deleteMediaFiles(mediaKeys);
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      ...this.victimProfileCommonService.targetUserFor(admin, profile),
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_DELETED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.victimProfileCommonService.profileLabel(profile),
      diff: {
        result: 'success',
        previousStatus: profile.status,
        previousIsPublished: profile.isPublished,
      },
      metadata: {
        involvesChild: profile.involvesChild,
        mediaFilesDeleted: mediaKeys.length,
        mediaTotalBytes: profile.mediaTotalBytes,
        totalRaisedAtDeletion: money(profile.totalRaised),
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_DELETED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return { message: 'victim_profile_deleted', id };
  }
}

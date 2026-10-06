import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditOutcome, AuditSeverity, Prisma, VictimProfileStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  AdminEditVictimProfileDto,
  AnonymizeDto,
  CreateProfileUpdateDto,
  LegalHoldDto,
  PagedQueryDto,
  ReasonDto,
  RedactMediaDto,
  RemoveMediaDto,
} from '../dto/victim-profile.dto';
import { MEDIA_FIELD_NAMES, PIPELINE_STATUSES, CLOSED_STATUSES } from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileAdminOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly cache: CacheService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  // VP-69
  async findTrash(_admin: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where: Prisma.VictimProfileWhereInput = { deletedAt: { not: null } };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        select: {
          id: true,
          name: true,
          involvesChild: true,
          status: true,
          deletedAt: true,
          deletedById: true,
          deleteReason: true,
          legalHold: true,
          anonymizedAt: true,
          createdAt: true,
        },
        orderBy: { deletedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: rows.map(({ name, ...row }) => ({
        ...row,
        label: this.victimProfileCommonService.profileLabel({
          id: row.id,
          name,
          involvesChild: row.involvesChild,
        }),
      })),
      meta: this.victimProfileCommonService.metaOf(page, limit, total),
    };
  }

  // VP-58
  async createAdminUpdate(admin: CurrentUserDto, id: string, data: CreateProfileUpdateDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    if (
      profile.takedownAt ||
      (profile.status !== VictimProfileStatus.PUBLISHED &&
        profile.status !== VictimProfileStatus.COMPLETED)
    ) {
      throw new BadRequestException('updates_require_a_published_profile');
    }

    const update = await this.prisma.victimProfileUpdate.create({
      data: {
        profileId: id,
        authorId: admin.id,
        isStaff: true,
        title: data.title,
        body: data.body,
      },
    });

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_UPDATE_POSTED,
      profile,
      {
        metadata: { updateId: update.id, actor: 'staff' },
      },
    );
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_UPDATE_POSTED, {
      victimProfileId: id,
      updateId: update.id,
      actorId: admin.id,
    });
    return update;
  }

  // VP-61
  async feature(admin: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    if (profile.status !== VictimProfileStatus.PUBLISHED || !profile.isPublished) {
      throw new BadRequestException('only_published_profiles_can_be_featured');
    }
    if (profile.isFeatured) return profile;

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      { isFeatured: true, featuredAt: new Date() },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_FEATURED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);
    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_FEATURED,
      profile,
    );
    return updated;
  }

  // VP-62
  async unfeature(admin: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    if (!profile.isFeatured) return profile;

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      { isFeatured: false, featuredAt: null },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_UNFEATURED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);
    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_UNFEATURED,
      profile,
    );
    return updated;
  }

  // VP-63
  async adminEdit(admin: CurrentUserDto, id: string, data: AdminEditVictimProfileDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_ADMIN_EDITED,
    );

    if (profile.isPublished) throw new BadRequestException('unpublish_before_editing');

    const changes: Record<string, { from: string | null; to: string }> = {};
    for (const field of ['name', 'description', 'story'] as const) {
      const next = data[field];
      if (next !== undefined && next !== profile[field]) {
        changes[field] = { from: profile[field], to: next };
      }
    }
    if (!Object.keys(changes).length) throw new BadRequestException('no_changes_to_apply');

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        ...(changes.name ? { name: changes.name.to } : {}),
        ...(changes.description ? { description: changes.description.to } : {}),
        ...(changes.story ? { story: changes.story.to } : {}),
        // Edited text has to be seen by privacy review again, and can no longer be "approved" as-is.
        isPrivacyReviewed: false,
        isAdminApproved: false,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_ADMIN_EDITED, profile },
    );

    await this.prisma.victimProfileRevision.create({
      data: {
        profileId: id,
        editedById: admin.id,
        reason: data.reason,
        changes: changes as unknown as Prisma.InputJsonValue,
      },
    });

    const status = PIPELINE_STATUSES.includes(updated.status)
      ? this.victimProfileCommonService.deriveStatus({
          involvesChild: updated.involvesChild,
          isVerified: updated.isVerified,
          isSafetyReviewed: updated.isSafetyReviewed,
          isChildSafetyReviewed: updated.isChildSafetyReviewed,
          hasConsent: updated.hasConsent,
          isPrivacyReviewed: false,
          isAdminApproved: false,
        })
      : updated.status;
    const finalProfile =
      status !== updated.status
        ? await this.prisma.victimProfile.update({ where: { id }, data: { status } })
        : updated;

    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_ADMIN_EDITED,
      profile,
      {
        reason: data.reason,
        diff: { previousStatus: profile.status, newStatus: finalProfile.status },
        metadata: { fieldsChanged: Object.keys(changes) },
      },
    );
    return finalProfile;
  }

  private async assertNoUnsettledPayments(profileId: string): Promise<boolean> {
    const unsettled = await this.prisma.payment.findFirst({
      where: {
        victimProfileId: profileId,
        status: 'PAID',
        allocations: { some: { settlementStatus: 'PENDING' } },
      },
      select: { id: true },
    });
    return !!unsettled;
  }

  // VP-67
  async softDelete(admin: CurrentUserDto, id: string, data: ReasonDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    if (profile.deletedAt) throw new ConflictException('victim_profile_already_deleted');

    if (profile.legalHold) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_SOFT_DELETED,
        profile,
        'victim_profile_under_legal_hold',
        {
          outcome: AuditOutcome.DENIED,
        },
      );
      throw new ForbiddenException('victim_profile_under_legal_hold');
    }
    if (await this.assertNoUnsettledPayments(id)) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_SOFT_DELETED,
        profile,
        'victim_profile_has_unsettled_payments',
      );
      throw new ConflictException('victim_profile_has_unsettled_payments');
    }

    // Also unpublished + approval cleared + donations paused: the existing public queries do not
    // look at deletedAt, so this is what actually takes it off the public site.
    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        deletedAt: new Date(),
        deletedById: admin.id,
        deleteReason: data.reason,
        status:
          profile.status === VictimProfileStatus.PUBLISHED
            ? VictimProfileStatus.UNPUBLISHED
            : profile.status,
        isPublished: false,
        isAdminApproved: false,
        isFeatured: false,
        donationsPaused: true,
        donationsPausedReason: profile.donationsPaused ? profile.donationsPausedReason : 'deleted',
        donationsPausedAt: profile.donationsPausedAt ?? new Date(),
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_SOFT_DELETED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_SOFT_DELETED,
      profile,
      {
        severity: AuditSeverity.WARNING,
        reason: data.reason,
        diff: { previousStatus: profile.status, previousIsPublished: profile.isPublished },
      },
    );
    return { message: 'victim_profile_soft_deleted', id, deletedAt: updated.deletedAt };
  }

  // VP-68  (comes back UNPUBLISHED, unapproved and with donations still paused on purpose)
  async restore(admin: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    if (!profile.deletedAt) throw new BadRequestException('victim_profile_not_deleted');
    if (profile.anonymizedAt)
      throw new BadRequestException('anonymized_profiles_cannot_be_restored');

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      { deletedAt: null, deletedById: null, deleteReason: null },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_RESTORED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_RESTORED,
      profile,
      {
        diff: { previousDeleteReason: profile.deleteReason },
      },
    );
    return updated;
  }

  // VP-70
  async getRevisions(admin: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.logAdminView(admin, profile, 'revisions');

    return this.prisma.victimProfileRevision.findMany({
      where: { profileId: id },
      orderBy: { createdAt: 'desc' },
    });
  }

  // VP-77  (scan status / hash are read from object metadata; they stay "unknown" until your upload pipeline sets them)
  async getAttachments(admin: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.logAdminView(admin, profile, 'attachments');

    type StatLike = {
      size: number;
      contentType: string;
      etag?: string;
      metaData?: Record<string, string>;
    };
    const items = MEDIA_FIELD_NAMES.flatMap((field) =>
      profile[field].map((key) => ({ field, key })),
    );

    return Promise.all(
      items.map(async ({ field, key }) => {
        try {
          const stat = (await this.minioService.statObject(key)) as StatLike;
          const meta = stat.metaData ?? {};
          return {
            key,
            field,
            contentType: stat.contentType,
            size: stat.size,
            scanStatus: meta['x-amz-meta-scan-status'] ?? meta['scan-status'] ?? 'UNKNOWN',
            hash: meta['x-amz-meta-sha256'] ?? meta['sha256'] ?? stat.etag ?? null,
          };
        } catch {
          return { key, field, contentType: null, size: null, scanStatus: 'MISSING', hash: null };
        }
      }),
    );
  }

  // VP-78
  async removeMedia(admin: CurrentUserDto, id: string, key: string, data: RemoveMediaDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_MEDIA_REMOVED,
    );

    const field = this.victimProfileCommonService.findMediaField(profile, key);
    if (!field) throw new NotFoundException('media_not_found_on_profile');

    const stat = await this.minioService.statObject(key).catch(() => null);
    const size = stat?.size ?? 0;

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        [field]: profile[field].filter((k) => k !== key),
        mediaTotalBytes: Math.max(0, profile.mediaTotalBytes - size),
      } as Prisma.VictimProfileUncheckedUpdateManyInput,
      { admin, action: AuditEventEnum.VICTIM_PROFILE_MEDIA_REMOVED, profile },
    );
    await this.victimProfileCommonService.deleteMediaFiles([key]);
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_MEDIA_REMOVED,
      profile,
      {
        severity: AuditSeverity.WARNING,
        reason: data.reason ?? null,
        metadata: { key, field, actor: 'staff', bytesFreed: size },
      },
    );
    return { message: 'media_removed', id: updated.id, key };
  }

  // VP-79  (no image processing lives in this service: this validates + records the request and hands it to a worker)
  async redactMedia(admin: CurrentUserDto, id: string, key: string, data: RedactMediaDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_MEDIA_REDACTION_REQUESTED,
    );

    const field = this.victimProfileCommonService.findMediaField(profile, key);
    if (!field) throw new NotFoundException('media_not_found_on_profile');
    if (field !== 'photo' && field !== 'video') {
      throw new BadRequestException('only_photo_and_video_can_be_redacted');
    }

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_MEDIA_REDACTION_REQUESTED,
      profile,
      {
        severity: AuditSeverity.WARNING,
        reason: data.notes ?? null,
        metadata: { key, field, mode: data.mode },
      },
    );
    // Worker contract: replace the object at `key` with the redacted copy, then invalidate the cache.
    this.eventEmitter.emit('victim-profile.media.redact', {
      victimProfileId: id,
      key,
      mode: data.mode,
      requestedBy: admin.id,
    });

    return { id, key, mode: data.mode, status: 'QUEUED' };
  }

  // VP-80
  async getMediaCustody(admin: CurrentUserDto, id: string, key: string) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.logAdminView(admin, profile, 'media_custody');

    const rows = await this.prisma.auditLog.findMany({
      where: {
        entity: 'VictimProfile',
        entityId: id,
        action: {
          in: [
            AuditEventEnum.VICTIM_PROFILE_MEDIA_DOWNLOADED,
            AuditEventEnum.VICTIM_PROFILE_MEDIA_REMOVED,
            AuditEventEnum.VICTIM_PROFILE_MEDIA_REDACTION_REQUESTED,
          ],
        },
        metadata: { path: ['key'], equals: key },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        action: true,
        outcome: true,
        userId: true,
        actorType: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
      },
    });

    return { key, events: rows };
  }

  // VP-81
  async getAccessLog(_admin: CurrentUserDto, id: string, query: PagedQueryDto) {
    await this.victimProfileCommonService.assertProfileExists(id);
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where: Prisma.AuditLogWhereInput = {
      entity: 'VictimProfile',
      entityId: id,
      action: {
        in: [
          AuditEventEnum.VICTIM_PROFILE_ADMIN_VIEWED,
          AuditEventEnum.VICTIM_PROFILE_MEDIA_DOWNLOADED,
        ],
      },
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          userId: true,
          actorName: true,
          action: true,
          outcome: true,
          metadata: true,
          ipAddress: true,
          createdAt: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data: rows, meta: this.victimProfileCommonService.metaOf(page, limit, total) };
  }

  // VP-82
  async setLegalHold(admin: CurrentUserDto, id: string, data: LegalHoldDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    if (profile.legalHold === data.legalHold) {
      throw new BadRequestException(
        data.legalHold ? 'legal_hold_already_set' : 'legal_hold_not_set',
      );
    }

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        legalHold: data.legalHold,
        legalHoldReason: data.legalHold ? data.reason : null,
        legalHoldAt: data.legalHold ? new Date() : null,
        legalHoldById: data.legalHold ? admin.id : null,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_LEGAL_HOLD_CHANGED, profile },
    );

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_LEGAL_HOLD_CHANGED,
      profile,
      {
        severity: AuditSeverity.CRITICAL,
        reason: data.reason,
        diff: { previousLegalHold: profile.legalHold, newLegalHold: data.legalHold },
      },
    );
    return updated;
  }

  // VP-83  (irreversible: only after closure, never under legal hold or with money still owed)
  async anonymize(admin: CurrentUserDto, id: string, data: AnonymizeDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);

    if (profile.anonymizedAt) throw new ConflictException('victim_profile_already_anonymized');
    if (profile.legalHold) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_ANONYMIZED,
        profile,
        'victim_profile_under_legal_hold',
        {
          outcome: AuditOutcome.DENIED,
        },
      );
      throw new ForbiddenException('victim_profile_under_legal_hold');
    }
    if (!CLOSED_STATUSES.includes(profile.status) && !profile.deletedAt) {
      throw new BadRequestException('victim_profile_not_closed');
    }
    if (await this.assertNoUnsettledPayments(id)) {
      throw new ConflictException('victim_profile_has_unsettled_payments');
    }

    const mediaKeys = [
      ...this.victimProfileCommonService.collectMediaFields(profile),
      ...profile.consentDocuments,
    ];

    await this.prisma.$transaction([
      this.prisma.victimProfile.update({
        where: { id },
        data: {
          name: null,
          description: null,
          story: null,
          bankAccountName: null,
          bankAccountNumber: null,
          bankName: null,
          photo: [],
          video: [],
          audio: [],
          pdf: [],
          document: [],
          other: [],
          mediaTotalBytes: 0,
          consentedBy: null,
          consentNotes: null,
          consentDocuments: [],
          consentRecordedBy: null,
          reviewNote: null,
          createdByUserId: null,
          isPublished: false,
          isAdminApproved: false,
          isFeatured: false,
          anonymizedAt: new Date(),
        },
      }),
      this.prisma.payoutDestination.updateMany({
        where: { victimProfileId: id },
        data: {
          accountNumber: null,
          telebirrPhone: null,
          accountHolder: 'ANONYMIZED',
          isVerified: false,
        },
      }),
      this.prisma.victimProfileUpdate.deleteMany({ where: { profileId: id } }),
      this.prisma.victimProfileRevision.deleteMany({ where: { profileId: id } }),
      this.prisma.victimProfileFollow.deleteMany({ where: { profileId: id } }),
      this.prisma.victimProfileView.deleteMany({ where: { profileId: id } }),
    ]);

    await this.victimProfileCommonService.deleteMediaFiles(mediaKeys);
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_ANONYMIZED,
      { ...profile, name: null },
      {
        severity: AuditSeverity.CRITICAL,
        reason: data.reason,
        diff: { previousStatus: profile.status },
        metadata: { mediaFilesDeleted: mediaKeys.length },
      },
    );
    return { message: 'victim_profile_anonymized', id };
  }
}

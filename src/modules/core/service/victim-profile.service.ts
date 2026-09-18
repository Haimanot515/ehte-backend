import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { Prisma, SupportStatus, VictimProfile, VictimProfileStatus } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { MinioService } from 'src/services/minio/minio.service';

import {
  CreateVictimProfileDto,
  FindAllVictimProfilesQueryDto,
  FindPublicVictimProfilesQueryDto,
  RevokeConsentDto,
  UpdateBankDetailsDto,
  UpdateChildSafetyReviewDto,
  UpdateVictimGateDto,
  UpdateVictimProfileDto,
} from '../dto/victim-profile.dto';

// The six media-array fields shared by CreateVictimProfileDto/
// UpdateVictimProfileDto and the VictimProfile model itself.
// Mirrors PostService/ReportService's MEDIA_FIELD_NAMES so every
// module stays in sync if a new media kind is ever added.
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

// Statuses a profile can be "forgotten" in — used by findStalePending().
// PUBLISHED and REJECTED are dead ends (REJECTED can still be resubmitted,
// but that's an explicit admin action, not something a stale sweep should
// nag about).
const STALE_ELIGIBLE_EXCLUDED_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PUBLISHED,
  VictimProfileStatus.REJECTED,
];

// FUNDS/TOTALS NOTE:
// "Money collected" is defined, deliberately and for now, as strictly
// Support rows with status === SupportStatus.CONFIRMED. This is
// intentionally NOT abstracted into a shared constant/helper — there
// is currently only one counting rule and it is used in exactly the
// two places below (reconcileProfileTotal's live recompute, and the
// backfill migration alongside this file) plus SupportService's
// increment/decrement. If a second status ever needs to count (e.g.
// COMPLETED), promote SupportStatus.CONFIRMED to a small shared
// helper at that point rather than before.

@Injectable()
export class VictimProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // AUDIT HELPER
  // ─────────────────────────────────────────────

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // ─────────────────────────────────────────────
  // MEDIA HELPERS
  // ─────────────────────────────────────────────

  private getMediaBucket(): string {
    return this.configService.get<string>('minio.bucketName') ?? 'ehte-media';
  }

  private collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  private diffMediaFields(
    before: MediaBearing,
    incoming: MediaBearingDto,
  ): { added: string[]; removed: string[] } {
    const added: string[] = [];
    const removed: string[] = [];

    for (const field of MEDIA_FIELD_NAMES) {
      const next = incoming[field];
      if (next === undefined) continue;
      const prev = before[field];
      added.push(...next.filter((fp) => !prev.includes(fp)));
      removed.push(...prev.filter((fp) => !next.includes(fp)));
    }

    return { added, removed };
  }

  private async validateMediaFilesExist(
    filepaths: string[],
  ): Promise<Array<{ filepath: string; size: number }>> {
    if (!filepaths.length) return [];

    const maxFileSizeBytes = Number(
      this.configService.get<string>('MEDIA_MAX_FILE_SIZE') ?? 52_428_800,
    );
    const allowedMimeTypes = new Set(
      (this.configService.get<string>('MEDIA_ALLOWED_MIME_TYPES') ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    );

    const checks = await Promise.all(
      filepaths.map(async (filepath) => {
        const exists = await this.minioService.objectExists(filepath);
        if (!exists) {
          return { filepath, ok: false as const, reason: 'not_found', size: 0 };
        }

        const stat = await this.minioService.statObject(filepath);

        if (stat.size > maxFileSizeBytes) {
          return { filepath, ok: false as const, reason: 'too_large', size: stat.size };
        }
        if (allowedMimeTypes.size > 0 && !allowedMimeTypes.has(stat.contentType)) {
          return { filepath, ok: false as const, reason: 'disallowed_type', size: stat.size };
        }
        return { filepath, ok: true as const, size: stat.size };
      }),
    );

    const bad = checks.filter((c) => !c.ok);
    if (bad.length) {
      throw new BadRequestException(
        `media_validation_failed:${bad.map((b) => `${b.filepath}:${b.reason}`).join(',')}`,
      );
    }

    return checks.map((c) => ({ filepath: c.filepath, size: c.size }));
  }

  private assertAttachmentCounts(media: MediaBearing): void {
    const maxPhotos = Number(
      this.configService.get<string>('PROFILE_MAX_PHOTOS') ??
        this.configService.get<string>('CONTENT_MAX_PHOTOS') ??
        10,
    );
    const maxVideos = Number(
      this.configService.get<string>('PROFILE_MAX_VIDEOS') ??
        this.configService.get<string>('CONTENT_MAX_VIDEOS') ??
        1,
    );
    const maxOther = Number(
      this.configService.get<string>('PROFILE_MAX_OTHER_FILES') ??
        this.configService.get<string>('CONTENT_MAX_OTHER_FILES') ??
        3,
    );

    if (media.photo.length > maxPhotos) {
      throw new BadRequestException(`too_many_photos:max_${maxPhotos}`);
    }
    if (media.video.length > maxVideos) {
      throw new BadRequestException(`too_many_videos:max_${maxVideos}`);
    }
    const otherCount =
      media.audio.length + media.pdf.length + media.document.length + media.other.length;
    if (otherCount > maxOther) {
      throw new BadRequestException(`too_many_other_files:max_${maxOther}`);
    }
  }

  private assertTotalBytes(totalBytes: number): void {
    const maxTotalBytes = Number(
      this.configService.get<string>('PROFILE_MAX_TOTAL_UPLOAD_BYTES') ??
        this.configService.get<string>('CONTENT_MAX_TOTAL_UPLOAD_BYTES') ??
        52_428_800,
    );
    if (totalBytes > maxTotalBytes) {
      throw new BadRequestException(`upload_total_size_exceeded:max_${maxTotalBytes}`);
    }
  }

  private async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  private getPubliclyVisibleMediaKeys(
    profile: Pick<VictimProfile, 'photo' | 'involvesChild'>,
  ): string[] {
    return profile.involvesChild ? [] : profile.photo;
  }

  // ─────────────────────────────────────────────
  // ACCESS CONTROL HELPERS
  // ─────────────────────────────────────────────

  private getRoles(user: CurrentUserDto): string[] {
    return (user as unknown as { roles?: string[] }).roles ?? [];
  }

  private assertAdminCanAccessProfile(
    admin: CurrentUserDto,
    profile: { claimedByUserId: string | null },
  ): void {
    const roles = this.getRoles(admin);
    const isSuperAdmin = roles.includes(RolesEnum.SUPER_ADMIN);

    if (!isSuperAdmin && profile.claimedByUserId && profile.claimedByUserId !== admin.id) {
      throw new ForbiddenException('victim_profile_claimed_by_another_admin');
    }
  }

  private async conditionalUpdate(
    id: string,
    expectedUpdatedAt: Date,
    data: Prisma.VictimProfileUpdateManyMutationInput,
  ): Promise<VictimProfile> {
    const result = await this.prisma.victimProfile.updateMany({
      where: { id, updatedAt: expectedUpdatedAt },
      data,
    });

    if (result.count === 0) {
      throw new BadRequestException('victim_profile_transition_conflict');
    }

    return this.prisma.victimProfile.findUniqueOrThrow({ where: { id } });
  }

  // ─────────────────────────────────────────────
  // ADMIN — CLAIM / UNCLAIM
  // ─────────────────────────────────────────────

  async claim(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (existing.claimedByUserId === admin.id) {
      return existing;
    }
    if (existing.claimedByUserId) {
      throw new ForbiddenException('victim_profile_already_claimed');
    }

    const result = await this.prisma.victimProfile.updateMany({
      where: { id, claimedByUserId: null },
      data: { claimedByUserId: admin.id, claimedAt: new Date() },
    });

    if (result.count === 0) {
      throw new ForbiddenException('victim_profile_already_claimed');
    }

    const profile = await this.prisma.victimProfile.findUniqueOrThrow({ where: { id } });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_CLAIMED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        result: 'success',
      },
    });

    return profile;
  }

  async unclaim(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (!existing.claimedByUserId) {
      throw new BadRequestException('victim_profile_not_claimed');
    }

    const roles = this.getRoles(admin);
    const isSuperAdmin = roles.includes(RolesEnum.SUPER_ADMIN);

    if (!isSuperAdmin && existing.claimedByUserId !== admin.id) {
      throw new ForbiddenException('victim_profile_claimed_by_another_admin');
    }

    const result = await this.prisma.victimProfile.updateMany({
      where: { id, claimedByUserId: existing.claimedByUserId },
      data: { claimedByUserId: null, claimedAt: null },
    });

    if (result.count === 0) {
      throw new BadRequestException('victim_profile_transition_conflict');
    }

    const profile = await this.prisma.victimProfile.findUniqueOrThrow({ where: { id } });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(roles),
      action: AuditEventEnum.VICTIM_PROFILE_UNCLAIMED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        previousClaimedByUserId: existing.claimedByUserId,
        result: 'success',
      },
    });

    return profile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET MEDIA DOWNLOAD URL
  // ─────────────────────────────────────────────

  async getMediaDownloadUrl(admin: CurrentUserDto, id: string, key: string): Promise<{ url: string }> {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const owned = this.collectMediaFields(profile).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_profile');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_MEDIA_DOWNLOADED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        key,
        result: 'success',
      },
    });

    return { url };
  }

  // ─────────────────────────────────────────────
  // PUBLIC — GET MEDIA DOWNLOAD URL
  // ─────────────────────────────────────────────

  async getPublicMediaDownloadUrl(id: string, key: string): Promise<{ url: string }> {
    const profile = await this.prisma.victimProfile.findFirst({
      where: {
        id,
        status: VictimProfileStatus.PUBLISHED,
        isPublished: true,
        isVerified: true,
        isSafetyReviewed: true,
        hasConsent: true,
        isPrivacyReviewed: true,
        isAdminApproved: true,
      },
      select: {
        photo: true,
        involvesChild: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const allowedKeys = this.getPubliclyVisibleMediaKeys(profile);
    if (!allowedKeys.includes(key)) {
      throw new NotFoundException('media_not_found_on_profile');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  // ─────────────────────────────────────────────
  // CREATE
  // ─────────────────────────────────────────────

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
    this.assertAttachmentCounts(merged);

    const validated = await this.validateMediaFilesExist(this.collectMediaFields(merged));
    const totalBytes = validated.reduce((sum, v) => sum + v.size, 0);
    this.assertTotalBytes(totalBytes);

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

          // Starts at zero — never client-settable (not present on
          // CreateVictimProfileDto/UpdateVictimProfileDto). Only
          // SupportService.updateStatus and reconcileProfileTotal
          // below may change it.
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

    this.emitAudit({
      userId: currentUser.id,
      actorType: resolveActorType(this.getRoles(currentUser)),
      action: AuditEventEnum.VICTIM_PROFILE_CREATED,
      entity: 'VictimProfile',
      entityId: profile.id,
      diff: {
        result: 'success',
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CREATED, {
      userId: profile.createdByUserId,
      victimProfileId: profile.id,
    });

    return profile;
  }

  // ─────────────────────────────────────────────
  // GET ONE (admin)
  // ─────────────────────────────────────────────

  async findOne(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      include: {
        supports: {
          where: { status: 'CONFIRMED' },
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

    // profile.totalRaised is included automatically — this uses the
    // default full-row `include`, not a narrow `select`.
    return profile;
  }

  async getSupportsSummary(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const supports = await this.prisma.support.findMany({
      where: {
        victimProfileId: id,
        status: 'CONFIRMED',
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalReceived = supports.reduce(
      (sum, support) => sum + Number(support.recipientAmount ?? support.amount ?? 0),
      0,
    );

    return {
      totalReceived,
      supportCount: supports.length,
      supports,
    };
  }

  // ─────────────────────────────────────────────
  // PUBLIC PROFILES — LIST
  // ─────────────────────────────────────────────

  async findPublic(query: FindPublicVictimProfilesQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;

    const where = {
      status: VictimProfileStatus.PUBLISHED,

      isPublished: true,

      isVerified: true,
      isSafetyReviewed: true,
      hasConsent: true,
      isPrivacyReviewed: true,
      isAdminApproved: true,

      ...(query.supportType ? { supportType: query.supportType } : {}),

      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { story: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,

        select: {
          id: true,
          name: true,
          story: true,

          supportType: true,
          supportGoal: true,

          photo: true,
          involvesChild: true,

          // NEW — needed on the public list card ("$X raised of $Y goal").
          totalRaised: true,

          createdAt: true,
        },

        orderBy: { createdAt: 'desc' },

        skip: (page - 1) * limit,
        take: limit,
      }),

      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: profiles.map((profile) => this.serializePublicProfile(profile)),

      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─────────────────────────────────────────────
  // PUBLIC PROFILES — SINGLE
  // ─────────────────────────────────────────────

  async findOnePublic(id: string) {
    const profile = await this.prisma.victimProfile.findFirst({
      where: {
        id,

        status: VictimProfileStatus.PUBLISHED,
        isPublished: true,

        isVerified: true,
        isSafetyReviewed: true,
        hasConsent: true,
        isPrivacyReviewed: true,
        isAdminApproved: true,
      },

      select: {
        id: true,
        name: true,
        story: true,

        supportType: true,
        supportGoal: true,

        photo: true,
        involvesChild: true,

        // NEW
        totalRaised: true,

        createdAt: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    return this.serializePublicProfile(profile);
  }

  private serializePublicProfile(profile: {
    id: string;
    name: string | null;
    story: string | null;
    supportType: unknown;
    supportGoal: Prisma.Decimal | null;
    photo: string[];
    involvesChild: boolean;
    totalRaised: Prisma.Decimal;
    createdAt: Date;
  }) {
    return {
      id: profile.id,
      name: profile.name,
      story: profile.story ?? '',
      supportType: profile.supportType,
      supportGoal: profile.supportGoal ? Number(profile.supportGoal) : null,

      // Child profiles never expose photos publicly.
      photo: profile.involvesChild ? [] : profile.photo,

      // NEW — cached running total of CONFIRMED support for this
      // profile, kept in sync by SupportService.updateStatus and
      // periodically checked by reconcileProfileTotal below.
      totalRaised: Number(profile.totalRaised),

      createdAt: profile.createdAt,
    };
  }

  // ─────────────────────────────────────────────
  // UPDATE PROFILE
  // ─────────────────────────────────────────────

  async update(admin: CurrentUserDto, id: string, data: UpdateVictimProfileDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile);

    const { added, removed } = this.diffMediaFields(profile, data);

    const merged: MediaBearing = {
      photo: data.photo ?? profile.photo,
      video: data.video ?? profile.video,
      audio: data.audio ?? profile.audio,
      pdf: data.pdf ?? profile.pdf,
      document: data.document ?? profile.document,
      other: data.other ?? profile.other,
    };
    this.assertAttachmentCounts(merged);

    const validatedAdded = await this.validateMediaFilesExist(added);
    const addedBytes = validatedAdded.reduce((sum, v) => sum + v.size, 0);

    const removedStats = await Promise.allSettled(
      removed.map((fp) => this.minioService.statObject(fp)),
    );
    const removedBytes = removedStats.reduce(
      (sum, r) => sum + (r.status === 'fulfilled' ? r.value.size : 0),
      0,
    );

    const newTotalBytes = Math.max(0, profile.mediaTotalBytes + addedBytes - removedBytes);
    this.assertTotalBytes(newTotalBytes);

    // NOTE: totalRaised is deliberately NOT touched here — editing a
    // profile's content/media has nothing to do with money already
    // confirmed against it, and UpdateVictimProfileDto has no
    // totalRaised field for a client to supply anyway.
    const updatedProfile = await this.conditionalUpdate(id, profile.updatedAt, {
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
    });

    await this.deleteMediaFiles(removed);

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_UPDATED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        previousStatus: profile.status,
        newStatus: VictimProfileStatus.PENDING,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_UPDATED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────

  async remove(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile);

    const result = await this.prisma.victimProfile.deleteMany({
      where: { id, updatedAt: profile.updatedAt },
    });

    if (result.count === 0) {
      throw new BadRequestException('victim_profile_transition_conflict');
    }

    await this.deleteMediaFiles(this.collectMediaFields(profile));

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_DELETED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        previousStatus: profile.status,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_DELETED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return { message: 'victim_profile_deleted', id };
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ALL
  // ─────────────────────────────────────────────

  async findAllForAdmin(query: FindAllVictimProfilesQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;

    const where = query.status !== undefined ? { status: query.status } : {};

    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        include: {
          supports: {
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    // profiles already include totalRaised via the default full-row
    // include above — no select changes needed here.
    return {
      data: profiles,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — STALE / UNCLAIMED-TOO-LONG PROFILES
  // ─────────────────────────────────────────────

  async findStalePending() {
    const staleHours = Number(
      this.configService.get<string>('PROFILE_STALE_PENDING_HOURS') ??
        this.configService.get<string>('CONTENT_STALE_PENDING_HOURS') ??
        48,
    );
    const staleChildHours = Number(
      this.configService.get<string>('PROFILE_STALE_CHILD_HOURS') ?? 12,
    );

    const now = Date.now();
    const standardCutoff = new Date(now - staleHours * 60 * 60 * 1000);
    const childCutoff = new Date(now - staleChildHours * 60 * 60 * 1000);

    const profiles = await this.prisma.victimProfile.findMany({
      where: {
        status: { notIn: STALE_ELIGIBLE_EXCLUDED_STATUSES },
        claimedByUserId: null,
        OR: [
          { involvesChild: true, createdAt: { lt: childCutoff } },
          { involvesChild: false, createdAt: { lt: standardCutoff } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    return profiles.map((profile) => ({
      ...profile,
      pendingHours: Math.floor((now - profile.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
  }

  // ─────────────────────────────────────────────
  // ADMIN — DASHBOARD STATISTICS
  //
  // FIX (money-collected addition): now also returns
  // totalRaisedAllProfiles, a single aggregate SUM over the cached
  // VictimProfile.totalRaised column across every profile
  // regardless of status (admin-facing, so no PUBLISHED filter).
  // ─────────────────────────────────────────────

  async getStats() {
    const [total, grouped, raised] = await this.prisma.$transaction([
      this.prisma.victimProfile.count(),
      this.prisma.victimProfile.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.victimProfile.aggregate({ _sum: { totalRaised: true } }),
    ]);

    const counts = Object.fromEntries(
      Object.values(VictimProfileStatus).map((status) => [status, 0]),
    ) as Record<VictimProfileStatus, number>;

    for (const row of grouped) {
      const rowCount = row._count as { status?: number } | undefined;
      counts[row.status] = rowCount?.status ?? 0;
    }

    return {
      total,
      pending: counts[VictimProfileStatus.PENDING] ?? 0,
      underReview: counts[VictimProfileStatus.UNDER_REVIEW] ?? 0,
      consentPending: counts[VictimProfileStatus.CONSENT_PENDING] ?? 0,
      verified: counts[VictimProfileStatus.VERIFIED] ?? 0,
      approved: counts[VictimProfileStatus.APPROVED] ?? 0,
      published: counts[VictimProfileStatus.PUBLISHED] ?? 0,
      unpublished: counts[VictimProfileStatus.UNPUBLISHED] ?? 0,
      rejected: counts[VictimProfileStatus.REJECTED] ?? 0,
      totalRaisedAllProfiles: Number(raised._sum.totalRaised ?? 0),
    };
  }

  // ─────────────────────────────────────────────
  // PUBLIC — PLATFORM-WIDE TOTAL RAISED
  // GET /victim-profiles/public/stats
  //
  // NEW. Scoped strictly to PUBLISHED + isPublished profiles so an
  // anonymous caller never sees money tallied against a profile
  // still under review. Reuses the same cached totalRaised column
  // as getStats above — cheap single aggregate, no join to Support.
  // ─────────────────────────────────────────────

  async getPublicStats() {
    const raised = await this.prisma.victimProfile.aggregate({
      where: {
        status: VictimProfileStatus.PUBLISHED,
        isPublished: true,
      },
      _sum: { totalRaised: true },
    });

    return {
      totalRaisedAllProfiles: Number(raised._sum.totalRaised ?? 0),
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — AUDIT HISTORY
  // ─────────────────────────────────────────────

  async getHistory(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    return this.prisma.auditLog.findMany({
      where: {
        entity: 'VictimProfile',
        entityId: id,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET APPROVAL/GATE STATUS
  // ─────────────────────────────────────────────

  async getGates(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: {
        isVerified: true,
        isSafetyReviewed: true,
        isChildSafetyReviewed: true,
        childSafetyFirstConfirmedByUserId: true,
        childSafetyFirstConfirmedAt: true,
        hasConsent: true,
        consentAt: true,
        consentRecordedBy: true,
        isPrivacyReviewed: true,
        isAdminApproved: true,
        involvesChild: true,
        status: true,
        bankAccountName: true,
        bankAccountNumber: true,
        bankName: true,
        claimedByUserId: true,
        claimedAt: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    return {
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      childSafetyFirstConfirmedByUserId: profile.childSafetyFirstConfirmedByUserId,
      childSafetyFirstConfirmedAt: profile.childSafetyFirstConfirmedAt,
      hasConsent: profile.hasConsent,
      consentAt: profile.consentAt,
      consentRecordedBy: profile.consentRecordedBy,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: profile.isAdminApproved,

      involvesChild: profile.involvesChild,
      childSafetySatisfied: !profile.involvesChild || profile.isChildSafetyReviewed,
      hasBankDetails: this.hasBankDetails(profile),

      claimedByUserId: profile.claimedByUserId,
      claimedAt: profile.claimedAt,

      status: profile.status,
    };
  }

  private deriveStatus(gates: {
    involvesChild: boolean;
    isVerified: boolean;
    isSafetyReviewed: boolean;
    isChildSafetyReviewed: boolean;
    hasConsent: boolean;
    isPrivacyReviewed: boolean;
    isAdminApproved: boolean;
  }): VictimProfileStatus {
    const childSafetySatisfied = !gates.involvesChild || gates.isChildSafetyReviewed;

    if (!gates.isVerified) {
      return VictimProfileStatus.PENDING;
    }
    if (!gates.isSafetyReviewed || !childSafetySatisfied) {
      return VictimProfileStatus.UNDER_REVIEW;
    }
    if (!gates.hasConsent) {
      return VictimProfileStatus.CONSENT_PENDING;
    }
    if (!gates.isPrivacyReviewed) {
      return VictimProfileStatus.UNDER_REVIEW;
    }
    if (!gates.isAdminApproved) {
      return VictimProfileStatus.VERIFIED;
    }
    return VictimProfileStatus.APPROVED;
  }

  private hasBankDetails(
    profile: Pick<VictimProfile, 'bankAccountName' | 'bankAccountNumber' | 'bankName'>,
  ) {
    return !!profile.bankAccountName && !!profile.bankAccountNumber && !!profile.bankName;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE APPROVAL GATES
  // ─────────────────────────────────────────────

  async updateGates(admin: CurrentUserDto, id: string, data: UpdateVictimGateDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile);

    const isVerified = data.isVerified ?? profile.isVerified;
    const isSafetyReviewed = data.isSafetyReviewed ?? profile.isSafetyReviewed;
    const isChildSafetyReviewed = profile.isChildSafetyReviewed;
    const hasConsent = data.hasConsent ?? profile.hasConsent;
    const isPrivacyReviewed = data.isPrivacyReviewed ?? profile.isPrivacyReviewed;
    const isAdminApproved = data.isAdminApproved ?? profile.isAdminApproved;

    const childSafetySatisfied = !profile.involvesChild || isChildSafetyReviewed;
    const hasBankDetails = this.hasBankDetails(profile);

    if (
      isAdminApproved &&
      (!isVerified ||
        !isSafetyReviewed ||
        !childSafetySatisfied ||
        !hasConsent ||
        !isPrivacyReviewed ||
        !hasBankDetails)
    ) {
      throw new BadRequestException('all_approval_gates_required');
    }

    const status = this.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified,
      isSafetyReviewed,
      isChildSafetyReviewed,
      hasConsent,
      isPrivacyReviewed,
      isAdminApproved,
    });

    const updatedProfile = await this.conditionalUpdate(id, profile.updatedAt, {
      isVerified,
      isSafetyReviewed,
      hasConsent,
      isPrivacyReviewed,
      isAdminApproved,
      status,
      isPublished: false,
      ...(data.hasConsent === true && !profile.hasConsent
        ? { consentAt: new Date(), consentRecordedBy: admin.id }
        : {}),
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_GATES_UPDATED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        previousStatus: profile.status,
        newStatus: status,

        previousGates: {
          isVerified: profile.isVerified,
          isSafetyReviewed: profile.isSafetyReviewed,
          hasConsent: profile.hasConsent,
          isPrivacyReviewed: profile.isPrivacyReviewed,
          isAdminApproved: profile.isAdminApproved,
        },

        newGates: {
          isVerified,
          isSafetyReviewed,
          hasConsent,
          isPrivacyReviewed,
          isAdminApproved,
        },
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_GATES_UPDATED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — CHILD SAFETY REVIEW
  // ─────────────────────────────────────────────

  async updateChildSafetyReview(
    admin: CurrentUserDto,
    id: string,
    data: UpdateChildSafetyReviewDto,
  ) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile);

    if (!profile.involvesChild) {
      throw new BadRequestException('child_safety_review_not_applicable');
    }

    if (data.isChildSafetyReviewed) {
      if (!profile.childSafetyFirstConfirmedByUserId) {
        const updated = await this.conditionalUpdate(id, profile.updatedAt, {
          childSafetyFirstConfirmedByUserId: admin.id,
          childSafetyFirstConfirmedAt: new Date(),
        });

        this.emitAudit({
          userId: admin.id,
          actorType: resolveActorType(this.getRoles(admin)),
          action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_FIRST_CONFIRMED,
          entity: 'VictimProfile',
          entityId: id,
          diff: {
            reviewNotes: data.reviewNotes,
          },
        });

        return updated;
      }

      if (profile.childSafetyFirstConfirmedByUserId === admin.id) {
        throw new BadRequestException('child_safety_review_requires_second_admin');
      }

      const status = this.deriveStatus({
        involvesChild: profile.involvesChild,
        isVerified: profile.isVerified,
        isSafetyReviewed: profile.isSafetyReviewed,
        isChildSafetyReviewed: true,
        hasConsent: profile.hasConsent,
        isPrivacyReviewed: profile.isPrivacyReviewed,
        isAdminApproved: profile.isAdminApproved,
      });

      const updatedProfile = await this.conditionalUpdate(id, profile.updatedAt, {
        isChildSafetyReviewed: true,
        status,
      });

      this.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
        entity: 'VictimProfile',
        entityId: id,
        diff: {
          previousStatus: profile.status,
          newStatus: status,

          firstConfirmedBy: profile.childSafetyFirstConfirmedByUserId,
          secondConfirmedBy: admin.id,
          reviewNotes: data.reviewNotes,
        },
      });

      this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED, {
        userId: profile.createdByUserId,
        victimProfileId: id,
        status,
      });

      return updatedProfile;
    }

    const status = this.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: false,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: false,
    });

    const updatedProfile = await this.conditionalUpdate(id, profile.updatedAt, {
      isChildSafetyReviewed: false,
      childSafetyFirstConfirmedByUserId: null,
      childSafetyFirstConfirmedAt: null,
      isAdminApproved: false,
      isPublished: false,
      status,
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEW_REVERSED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        previousStatus: profile.status,
        newStatus: status,
        reviewNotes: data.reviewNotes,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVOKE CONSENT
  // ─────────────────────────────────────────────

  async revokeConsent(admin: CurrentUserDto, id: string, data: RevokeConsentDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile);

    if (!profile.hasConsent) {
      throw new BadRequestException('consent_not_currently_recorded');
    }

    const status = this.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: false,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: false,
    });

    const updatedProfile = await this.conditionalUpdate(id, profile.updatedAt, {
      hasConsent: false,
      consentAt: null,
      consentRecordedBy: null,
      isAdminApproved: false,
      isPublished: false,
      status,
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_CONSENT_REVOKED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        previousStatus: profile.status,
        newStatus: status,

        previousConsentAt: profile.consentAt,
        previousConsentRecordedBy: profile.consentRecordedBy,

        reason: data.reason,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CONSENT_REVOKED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE BANK DETAILS
  // ─────────────────────────────────────────────

  async updateBankDetails(admin: CurrentUserDto, id: string, data: UpdateBankDetailsDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile);

    const wasApproved = profile.isAdminApproved;
    const isAdminApproved = wasApproved ? false : profile.isAdminApproved;

    const status = this.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved,
    });

    const updatedProfile = await this.conditionalUpdate(id, profile.updatedAt, {
      bankAccountName: data.bankAccountName,
      bankAccountNumber: data.bankAccountNumber,
      bankName: data.bankName,
      isAdminApproved,
      isPublished: wasApproved ? false : profile.isPublished,
      status,
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        previousStatus: profile.status,
        newStatus: status,

        reapprovalRequired: wasApproved,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      reapprovalRequired: wasApproved,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — PUBLISH
  // ─────────────────────────────────────────────

  async publish(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile);

    const hasBankDetails = this.hasBankDetails(profile);
    const childSafetySatisfied = !profile.involvesChild || profile.isChildSafetyReviewed;

    const allGatesSatisfied =
      profile.isVerified &&
      profile.isSafetyReviewed &&
      childSafetySatisfied &&
      profile.hasConsent &&
      profile.isPrivacyReviewed &&
      profile.isAdminApproved &&
      hasBankDetails;

    if (!allGatesSatisfied) {
      throw new BadRequestException('all_approval_gates_required');
    }

    const updatedProfile = await this.conditionalUpdate(id, profile.updatedAt, {
      status: VictimProfileStatus.PUBLISHED,
      isPublished: true,
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        previousStatus: profile.status,
        newStatus: VictimProfileStatus.PUBLISHED,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_PUBLISHED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UNPUBLISH
  // ─────────────────────────────────────────────

  async unpublish(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile);

    if (!profile.isPublished) {
      throw new BadRequestException('victim_profile_not_published');
    }

    const updatedProfile = await this.conditionalUpdate(id, profile.updatedAt, {
      status: VictimProfileStatus.UNPUBLISHED,
      isPublished: false,
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_UNPUBLISHED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        previousStatus: profile.status,
        newStatus: VictimProfileStatus.UNPUBLISHED,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_UNPUBLISHED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REJECT
  // ─────────────────────────────────────────────

  async reject(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile);

    if (profile.isPublished) {
      throw new BadRequestException('published_profile_cannot_be_rejected');
    }

    const updatedProfile = await this.conditionalUpdate(id, profile.updatedAt, {
      status: VictimProfileStatus.REJECTED,
      isPublished: false,
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_REJECTED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        previousStatus: profile.status,
        newStatus: VictimProfileStatus.REJECTED,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_REJECTED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — RESUBMIT AFTER REJECTION
  // ─────────────────────────────────────────────

  async resubmit(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile);

    if (profile.status !== VictimProfileStatus.REJECTED) {
      throw new BadRequestException('victim_profile_not_rejected');
    }

    const status = this.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: profile.isAdminApproved,
    });

    const updatedProfile = await this.conditionalUpdate(id, profile.updatedAt, {
      status,
      isPublished: false,
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_RESUBMITTED,
      entity: 'VictimProfile',
      entityId: id,
      diff: {
        previousStatus: profile.status,
        newStatus: status,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_RESUBMITTED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — RECONCILE totalRaised (financial-integrity check)
  //
  // NEW. Recomputes the true collected total for one profile
  // straight from Support (status === CONFIRMED, per the current,
  // deliberately un-abstracted counting rule — see the module-level
  // comment at the top of this file), and diffs it against the
  // cached VictimProfile.totalRaised column.
  //
  // autoCorrect=false: read-only diff report (dry run).
  // autoCorrect=true: also writes the corrected value and emits
  // VICTIM_PROFILE_TOTAL_RECONCILED with before/after values, so any
  // rewrite of a financial total leaves an audit trail.
  // ─────────────────────────────────────────────

  async reconcileProfileTotal(admin: CurrentUserDto, id: string, autoCorrect: boolean) {
    const profile = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const supports = await this.prisma.support.findMany({
      where: { victimProfileId: id, status: SupportStatus.CONFIRMED },
      select: { amount: true, recipientAmount: true },
    });

    const liveTotal = supports.reduce(
      (sum, s) => sum + Number(s.recipientAmount ?? s.amount ?? 0),
      0,
    );
    const cachedTotal = Number(profile.totalRaised);
    const mismatch = Math.abs(liveTotal - cachedTotal) > 0.01;

    if (mismatch && autoCorrect) {
      await this.conditionalUpdate(id, profile.updatedAt, { totalRaised: liveTotal });

      this.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.VICTIM_PROFILE_TOTAL_RECONCILED,
        entity: 'VictimProfile',
        entityId: id,
        diff: {
          previousCachedTotal: cachedTotal,
          liveTotal,
          corrected: true,
        },
      });
    }

    return {
      victimProfileId: id,
      cachedTotal,
      liveTotal,
      mismatch,
      corrected: mismatch && autoCorrect,
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — RECONCILE ALL PROFILES
  //
  // NEW. Sweeps every profile and returns only the mismatches — the
  // caller (an ops alert channel, or a future cron job) should treat
  // a non-empty result as something worth paging someone about, not
  // just a routine dashboard number.
  // ─────────────────────────────────────────────

  async reconcileAllTotals(admin: CurrentUserDto, autoCorrect: boolean) {
    const profiles = await this.prisma.victimProfile.findMany({ select: { id: true } });

    const results = await Promise.all(
      profiles.map((p) => this.reconcileProfileTotal(admin, p.id, autoCorrect)),
    );

    return results.filter((r) => r.mismatch);
  }
}
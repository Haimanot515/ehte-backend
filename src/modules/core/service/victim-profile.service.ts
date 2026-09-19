import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import {
  AuditOutcome,
  AuditSeverity,
  Prisma,
  SupportStatus,
  VictimProfile,
  VictimProfileStatus,
} from '@prisma/client';

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

// Six media-array fields shared by the DTOs and the VictimProfile model.
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

// Fields update() may touch — used only to record which fields an edit touched in audit metadata.
const UPDATABLE_FIELD_NAMES = [
  'name',
  'description',
  'story',
  'supportType',
  'supportGoal',
  'bankAccountName',
  'bankAccountNumber',
  'bankName',
  'photo',
  'video',
  'audio',
  'pdf',
  'document',
  'other',
  'involvesChild',
] as const;

type ProfileAuditRef = Pick<VictimProfile, 'id' | 'name' | 'involvesChild' | 'createdByUserId'>;

type ConflictAuditContext = {
  admin: CurrentUserDto;
  action: AuditEventEnum;
  profile: ProfileAuditRef;
};

// PUBLISHED/REJECTED are dead ends for the stale-pending sweep.
const STALE_ELIGIBLE_EXCLUDED_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PUBLISHED,
  VictimProfileStatus.REJECTED,
];

// "Money collected" = Support rows with status CONFIRMED only, used here and in SupportService.
@Injectable()
export class VictimProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  // ─── AUDIT HELPERS ───
  // Bank details are never written to diff/metadata, only whether they changed (booleans).

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // Child profiles get a redacted label so a child's name never lands in the audit table.
  private profileLabel(
    profile: Pick<VictimProfile, 'id' | 'name' | 'involvesChild'>,
  ): string | undefined {
    if (profile.involvesChild) {
      return `Child profile ${profile.id.slice(0, 8)}`;
    }
    return profile.name ?? undefined;
  }

  // Returns the profile's creator as targetUserId, unless the actor IS the creator.
  private targetUserFor(
    actor: CurrentUserDto,
    profile: Pick<VictimProfile, 'createdByUserId'>,
  ): { targetUserId?: string } {
    const creatorId = profile.createdByUserId;
    return creatorId && creatorId !== actor.id ? { targetUserId: creatorId } : {};
  }

  // Single place a DENIED/FAILURE audit row is built, so every guard clause is consistent.
  private emitProfileFailure(
    actor: CurrentUserDto,
    action: AuditEventEnum,
    profile: ProfileAuditRef,
    reason: string,
    opts: {
      outcome?: AuditOutcome;
      diff?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    const outcome = opts.outcome ?? AuditOutcome.FAILURE;

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(this.getRoles(actor)),
      action,
      outcome,
      severity: AuditSeverity.WARNING,
      entity: 'VictimProfile',
      entityId: profile.id,
      entityLabel: this.profileLabel(profile),
      diff: {
        result: outcome === AuditOutcome.DENIED ? 'denied' : 'failure',
        reason,
        ...(opts.diff ?? {}),
      } as AuditEventPayload['diff'],
      ...(opts.metadata ? { metadata: opts.metadata as AuditEventPayload['metadata'] } : {}),
    });
  }

  // ─── MEDIA HELPERS ───

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

  // ─── ACCESS CONTROL HELPERS ───

  private getRoles(user: CurrentUserDto): string[] {
    return (user as unknown as { roles?: string[] }).roles ?? [];
  }

  // Denied access attempts now write a DENIED/WARNING audit row before throwing.
  private assertAdminCanAccessProfile(
    admin: CurrentUserDto,
    profile: ProfileAuditRef & { claimedByUserId: string | null },
    action: AuditEventEnum,
  ): void {
    const roles = this.getRoles(admin);
    const isSuperAdmin = roles.includes(RolesEnum.SUPER_ADMIN);

    if (!isSuperAdmin && profile.claimedByUserId && profile.claimedByUserId !== admin.id) {
      this.emitProfileFailure(admin, action, profile, 'claimed_by_another_admin', {
        outcome: AuditOutcome.DENIED,
        metadata: { claimedByUserId: profile.claimedByUserId },
      });
      throw new ForbiddenException('victim_profile_claimed_by_another_admin');
    }
  }

  // Losing the optimistic-concurrency race now emits a FAILURE row before throwing.
  private async conditionalUpdate(
    id: string,
    expectedUpdatedAt: Date,
    data: Prisma.VictimProfileUpdateManyMutationInput,
    audit: ConflictAuditContext,
  ): Promise<VictimProfile> {
    const result = await this.prisma.victimProfile.updateMany({
      where: { id, updatedAt: expectedUpdatedAt },
      data,
    });

    if (result.count === 0) {
      this.emitProfileFailure(
        audit.admin,
        audit.action,
        audit.profile,
        'victim_profile_transition_conflict',
      );
      throw new BadRequestException('victim_profile_transition_conflict');
    }

    return this.prisma.victimProfile.findUniqueOrThrow({ where: { id } });
  }

  // Names of unsatisfied approval gates — used only for FAILURE audit metadata, not allow/deny logic.
  private getMissingApprovalGates(g: {
    involvesChild: boolean;
    isVerified: boolean;
    isSafetyReviewed: boolean;
    isChildSafetyReviewed: boolean;
    hasConsent: boolean;
    isPrivacyReviewed: boolean;
    hasBankDetails: boolean;
  }): string[] {
    const missing: string[] = [];
    if (!g.isVerified) missing.push('isVerified');
    if (!g.isSafetyReviewed) missing.push('isSafetyReviewed');
    if (g.involvesChild && !g.isChildSafetyReviewed) missing.push('isChildSafetyReviewed');
    if (!g.hasConsent) missing.push('hasConsent');
    if (!g.isPrivacyReviewed) missing.push('isPrivacyReviewed');
    if (!g.hasBankDetails) missing.push('hasBankDetails');
    return missing;
  }

  // ─── ADMIN — CLAIM / UNCLAIM ───

  async claim(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (existing.claimedByUserId === admin.id) {
      return existing;
    }
    if (existing.claimedByUserId) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CLAIMED,
        existing,
        'victim_profile_already_claimed',
        {
          outcome: AuditOutcome.DENIED,
          metadata: { claimedByUserId: existing.claimedByUserId },
        },
      );
      throw new ForbiddenException('victim_profile_already_claimed');
    }

    const result = await this.prisma.victimProfile.updateMany({
      where: { id, claimedByUserId: null },
      data: { claimedByUserId: admin.id, claimedAt: new Date() },
    });

    if (result.count === 0) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CLAIMED,
        existing,
        'victim_profile_already_claimed',
        {
          outcome: AuditOutcome.DENIED,
          metadata: { lostRace: true },
        },
      );
      throw new ForbiddenException('victim_profile_already_claimed');
    }

    const profile = await this.prisma.victimProfile.findUniqueOrThrow({ where: { id } });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_CLAIMED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      diff: {
        result: 'success',
      },
    });

    return profile;
  }

  // Unclaim by SUPER_ADMIN on another admin's claim records that admin as targetUserId.
  async unclaim(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (!existing.claimedByUserId) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_UNCLAIMED,
        existing,
        'victim_profile_not_claimed',
      );
      throw new BadRequestException('victim_profile_not_claimed');
    }

    const roles = this.getRoles(admin);
    const isSuperAdmin = roles.includes(RolesEnum.SUPER_ADMIN);

    if (!isSuperAdmin && existing.claimedByUserId !== admin.id) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_UNCLAIMED,
        existing,
        'claimed_by_another_admin',
        {
          outcome: AuditOutcome.DENIED,
          metadata: { claimedByUserId: existing.claimedByUserId },
        },
      );
      throw new ForbiddenException('victim_profile_claimed_by_another_admin');
    }

    const result = await this.prisma.victimProfile.updateMany({
      where: { id, claimedByUserId: existing.claimedByUserId },
      data: { claimedByUserId: null, claimedAt: null },
    });

    if (result.count === 0) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_UNCLAIMED,
        existing,
        'victim_profile_transition_conflict',
      );
      throw new BadRequestException('victim_profile_transition_conflict');
    }

    const profile = await this.prisma.victimProfile.findUniqueOrThrow({ where: { id } });

    const overrodeAnotherAdmin = existing.claimedByUserId !== admin.id;

    this.emitAudit({
      userId: admin.id,
      ...(overrodeAnotherAdmin ? { targetUserId: existing.claimedByUserId } : {}),
      actorType: resolveActorType(roles),
      action: AuditEventEnum.VICTIM_PROFILE_UNCLAIMED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      diff: {
        previousClaimedByUserId: existing.claimedByUserId,
        result: 'success',
      },
      metadata: { overrodeAnotherAdmin },
    });

    return profile;
  }

  // ─── ADMIN — GET MEDIA DOWNLOAD URL ───
  // A key not actually attached to the profile is a DENIED event, not a silent 404.

  async getMediaDownloadUrl(admin: CurrentUserDto, id: string, key: string): Promise<{ url: string }> {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const owned = this.collectMediaFields(profile).includes(key);
    if (!owned) {
      this.emitAudit({
        userId: admin.id,
        ...this.targetUserFor(admin, profile),
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.VICTIM_PROFILE_MEDIA_DOWNLOADED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'VictimProfile',
        entityId: id,
        entityLabel: this.profileLabel(profile),
        diff: { result: 'denied', reason: 'media_not_found_on_profile' },
        metadata: { requestedKey: key },
      });
      throw new NotFoundException('media_not_found_on_profile');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, profile),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_MEDIA_DOWNLOADED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      diff: {
        result: 'success',
      },
      metadata: { key },
    });

    return { url };
  }

  // ─── PUBLIC — GET MEDIA DOWNLOAD URL ───
  // Anonymous endpoint — no actor to attribute a row to, so no AuditLog write here.

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

  // ─── CREATE ───
  // Callable by admins and by regular users creating their own profile.

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

          // Never client-settable; only SupportService.updateStatus / reconcileProfileTotal change it.
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
      entityLabel: this.profileLabel(profile),
      diff: {
        result: 'success',
        status: profile.status,
      },
      metadata: {
        supportType: profile.supportType,
        involvesChild: profile.involvesChild,
        attachmentCount: this.collectMediaFields(merged).length,
        mediaTotalBytes: totalBytes,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CREATED, {
      userId: profile.createdByUserId,
      victimProfileId: profile.id,
    });

    return profile;
  }

  // ─── GET ONE (admin) ───
  // Full row including bank details, currently un-audited — needs a VICTIM_PROFILE_OPENED event.

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

  // ─── PUBLIC PROFILES — LIST ───

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

  // ─── PUBLIC PROFILES — SINGLE ───

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

      totalRaised: Number(profile.totalRaised),

      createdAt: profile.createdAt,
    };
  }

  // ─── UPDATE PROFILE ───

  async update(admin: CurrentUserDto, id: string, data: UpdateVictimProfileDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_UPDATED);

    const { added, removed } = this.diffMediaFields(profile, data);

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

      newTotalBytes = Math.max(0, profile.mediaTotalBytes + addedBytes - removedBytes);
      this.assertTotalBytes(newTotalBytes);
    } catch (err) {
      this.emitProfileFailure(
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

    // totalRaised is deliberately untouched here — editing content/media has nothing to do with confirmed money.
    const updatedProfile = await this.conditionalUpdate(
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

    await this.deleteMediaFiles(removed);

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, profile),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_UPDATED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(updatedProfile),
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

  // ─── DELETE ───

  async remove(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_DELETED);

    const result = await this.prisma.victimProfile.deleteMany({
      where: { id, updatedAt: profile.updatedAt },
    });

    if (result.count === 0) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_DELETED,
        profile,
        'victim_profile_transition_conflict',
      );
      throw new BadRequestException('victim_profile_transition_conflict');
    }

    const mediaKeys = this.collectMediaFields(profile);
    await this.deleteMediaFiles(mediaKeys);

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, profile),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_DELETED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      diff: {
        result: 'success',
        previousStatus: profile.status,
        previousIsPublished: profile.isPublished,
      },
      metadata: {
        involvesChild: profile.involvesChild,
        mediaFilesDeleted: mediaKeys.length,
        mediaTotalBytes: profile.mediaTotalBytes,
        totalRaisedAtDeletion: Number(profile.totalRaised),
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_DELETED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return { message: 'victim_profile_deleted', id };
  }

  // ─── ADMIN — GET ALL ───

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

  // ─── ADMIN — STALE / UNCLAIMED-TOO-LONG PROFILES ───

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

  // ─── ADMIN — DASHBOARD STATISTICS ───

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

  // ─── PUBLIC — PLATFORM-WIDE TOTAL RAISED ───
  // Scoped strictly to PUBLISHED + isPublished profiles.

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

  // ─── ADMIN — AUDIT HISTORY ───

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

  // ─── ADMIN — GET APPROVAL/GATE STATUS ───

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

  // ─── ADMIN — UPDATE APPROVAL GATES ───

  async updateGates(admin: CurrentUserDto, id: string, data: UpdateVictimGateDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_GATES_UPDATED);

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
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_GATES_UPDATED,
        profile,
        'all_approval_gates_required',
        {
          metadata: {
            missingGates: this.getMissingApprovalGates({
              involvesChild: profile.involvesChild,
              isVerified,
              isSafetyReviewed,
              isChildSafetyReviewed,
              hasConsent,
              isPrivacyReviewed,
              hasBankDetails,
            }),
          },
        },
      );
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

    const consentNewlyRecorded = data.hasConsent === true && !profile.hasConsent;

    const updatedProfile = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        isVerified,
        isSafetyReviewed,
        hasConsent,
        isPrivacyReviewed,
        isAdminApproved,
        status,
        isPublished: false,
        ...(consentNewlyRecorded ? { consentAt: new Date(), consentRecordedBy: admin.id } : {}),
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_GATES_UPDATED, profile },
    );

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, profile),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_GATES_UPDATED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      diff: {
        result: 'success',
        previousStatus: profile.status,
        newStatus: status,
        previousIsPublished: profile.isPublished,
        newIsPublished: false,

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
      metadata: { consentNewlyRecorded },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_GATES_UPDATED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }

  // ─── ADMIN — CHILD SAFETY REVIEW ───
  // Second-admin requirement violation is recorded as DENIED, not a plain FAILURE.

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

    this.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
    );

    if (!profile.involvesChild) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
        profile,
        'child_safety_review_not_applicable',
      );
      throw new BadRequestException('child_safety_review_not_applicable');
    }

    if (data.isChildSafetyReviewed) {
      if (!profile.childSafetyFirstConfirmedByUserId) {
        const updated = await this.conditionalUpdate(
          id,
          profile.updatedAt,
          {
            childSafetyFirstConfirmedByUserId: admin.id,
            childSafetyFirstConfirmedAt: new Date(),
          },
          {
            admin,
            action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_FIRST_CONFIRMED,
            profile,
          },
        );

        this.emitAudit({
          userId: admin.id,
          ...this.targetUserFor(admin, profile),
          actorType: resolveActorType(this.getRoles(admin)),
          action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_FIRST_CONFIRMED,
          entity: 'VictimProfile',
          entityId: id,
          entityLabel: this.profileLabel(profile),
          reason: data.reviewNotes ?? null,
          diff: { result: 'success' },
          metadata: { stage: 'first_confirmation' },
        });

        return updated;
      }

      if (profile.childSafetyFirstConfirmedByUserId === admin.id) {
        this.emitProfileFailure(
          admin,
          AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
          profile,
          'child_safety_review_requires_second_admin',
          {
            outcome: AuditOutcome.DENIED,
            metadata: { firstConfirmedBy: profile.childSafetyFirstConfirmedByUserId },
          },
        );
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

      const updatedProfile = await this.conditionalUpdate(
        id,
        profile.updatedAt,
        {
          isChildSafetyReviewed: true,
          status,
        },
        { admin, action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED, profile },
      );

      this.emitAudit({
        userId: admin.id,
        ...this.targetUserFor(admin, profile),
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
        entity: 'VictimProfile',
        entityId: id,
        entityLabel: this.profileLabel(profile),
        reason: data.reviewNotes ?? null,
        diff: {
          result: 'success',
          previousStatus: profile.status,
          newStatus: status,

          firstConfirmedBy: profile.childSafetyFirstConfirmedByUserId,
          secondConfirmedBy: admin.id,
        },
        metadata: { stage: 'second_confirmation' },
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

    const updatedProfile = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        isChildSafetyReviewed: false,
        childSafetyFirstConfirmedByUserId: null,
        childSafetyFirstConfirmedAt: null,
        isAdminApproved: false,
        isPublished: false,
        status,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEW_REVERSED, profile },
    );

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, profile),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEW_REVERSED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      reason: data.reviewNotes ?? null,
      diff: {
        result: 'success',
        previousStatus: profile.status,
        newStatus: status,
        previousIsAdminApproved: profile.isAdminApproved,
        previousIsPublished: profile.isPublished,
      },
      metadata: { stage: 'reversal' },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }

  // ─── ADMIN — REVOKE CONSENT ───

  async revokeConsent(admin: CurrentUserDto, id: string, data: RevokeConsentDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_CONSENT_REVOKED);

    if (!profile.hasConsent) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CONSENT_REVOKED,
        profile,
        'consent_not_currently_recorded',
      );
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

    const updatedProfile = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        hasConsent: false,
        consentAt: null,
        consentRecordedBy: null,
        isAdminApproved: false,
        isPublished: false,
        status,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_CONSENT_REVOKED, profile },
    );

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, profile),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_CONSENT_REVOKED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      reason: data.reason ?? null,
      diff: {
        result: 'success',
        previousStatus: profile.status,
        newStatus: status,
        previousIsAdminApproved: profile.isAdminApproved,
        previousIsPublished: profile.isPublished,

        previousConsentAt: profile.consentAt,
        previousConsentRecordedBy: profile.consentRecordedBy,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CONSENT_REVOKED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─── ADMIN — UPDATE BANK DETAILS ───
  // Records only WHICH of the three fields changed, never the values (see AUDIT-DATA POLICY above).

  async updateBankDetails(admin: CurrentUserDto, id: string, data: UpdateBankDetailsDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
    );

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

    const updatedProfile = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        bankAccountName: data.bankAccountName,
        bankAccountNumber: data.bankAccountNumber,
        bankName: data.bankName,
        isAdminApproved,
        isPublished: wasApproved ? false : profile.isPublished,
        status,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED, profile },
    );

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, profile),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      diff: {
        result: 'success',
        previousStatus: profile.status,
        newStatus: status,
        previousIsPublished: profile.isPublished,
        newIsPublished: wasApproved ? false : profile.isPublished,

        reapprovalRequired: wasApproved,
      },
      metadata: {
        accountNameChanged:
          data.bankAccountName !== undefined && data.bankAccountName !== profile.bankAccountName,
        accountNumberChanged:
          data.bankAccountNumber !== undefined &&
          data.bankAccountNumber !== profile.bankAccountNumber,
        bankNameChanged: data.bankName !== undefined && data.bankName !== profile.bankName,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      reapprovalRequired: wasApproved,
    });

    return updatedProfile;
  }

  // ─── ADMIN — PUBLISH ───

  async publish(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_PUBLISHED);

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
      const missingGates = this.getMissingApprovalGates({
        involvesChild: profile.involvesChild,
        isVerified: profile.isVerified,
        isSafetyReviewed: profile.isSafetyReviewed,
        isChildSafetyReviewed: profile.isChildSafetyReviewed,
        hasConsent: profile.hasConsent,
        isPrivacyReviewed: profile.isPrivacyReviewed,
        hasBankDetails,
      });
      if (!profile.isAdminApproved) missingGates.push('isAdminApproved');

      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
        profile,
        'all_approval_gates_required',
        { diff: { currentStatus: profile.status }, metadata: { missingGates } },
      );
      throw new BadRequestException('all_approval_gates_required');
    }

    const updatedProfile = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        status: VictimProfileStatus.PUBLISHED,
        isPublished: true,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_PUBLISHED, profile },
    );

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, profile),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      diff: {
        result: 'success',
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

  // ─── ADMIN — UNPUBLISH ───

  async unpublish(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_UNPUBLISHED);

    if (!profile.isPublished) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_UNPUBLISHED,
        profile,
        'victim_profile_not_published',
        { diff: { currentStatus: profile.status } },
      );
      throw new BadRequestException('victim_profile_not_published');
    }

    const updatedProfile = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        status: VictimProfileStatus.UNPUBLISHED,
        isPublished: false,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_UNPUBLISHED, profile },
    );

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, profile),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_UNPUBLISHED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      diff: {
        result: 'success',
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

  // ─── ADMIN — REJECT ───

  async reject(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_REJECTED);

    if (profile.isPublished) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_REJECTED,
        profile,
        'published_profile_cannot_be_rejected',
        { diff: { currentStatus: profile.status } },
      );
      throw new BadRequestException('published_profile_cannot_be_rejected');
    }

    const updatedProfile = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        status: VictimProfileStatus.REJECTED,
        isPublished: false,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_REJECTED, profile },
    );

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, profile),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_REJECTED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      diff: {
        result: 'success',
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

  // ─── ADMIN — RESUBMIT AFTER REJECTION ───

  async resubmit(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_RESUBMITTED);

    if (profile.status !== VictimProfileStatus.REJECTED) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_RESUBMITTED,
        profile,
        'victim_profile_not_rejected',
        { diff: { currentStatus: profile.status } },
      );
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

    const updatedProfile = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        status,
        isPublished: false,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_RESUBMITTED, profile },
    );

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, profile),
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_RESUBMITTED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.profileLabel(profile),
      diff: {
        result: 'success',
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

  // ─── ADMIN — RECONCILE totalRaised (financial-integrity check) ───
  // Any mismatch writes a row (severity WARNING); a clean, matching profile writes nothing.

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

    let corrected = false;

    if (mismatch && autoCorrect) {
      await this.conditionalUpdate(
        id,
        profile.updatedAt,
        { totalRaised: liveTotal },
        { admin, action: AuditEventEnum.VICTIM_PROFILE_TOTAL_RECONCILED, profile },
      );
      corrected = true;
    }

    if (mismatch) {
      this.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.getRoles(admin)),
        action: AuditEventEnum.VICTIM_PROFILE_TOTAL_RECONCILED,
        severity: AuditSeverity.WARNING,
        entity: 'VictimProfile',
        entityId: id,
        entityLabel: this.profileLabel(profile),
        diff: {
          result: corrected ? 'success' : 'mismatch_detected',
          previousCachedTotal: cachedTotal,
          liveTotal,
          corrected,
        },
        metadata: {
          difference: Number((liveTotal - cachedTotal).toFixed(2)),
          confirmedSupportCount: supports.length,
        },
      });
    }

    return {
      victimProfileId: id,
      cachedTotal,
      liveTotal,
      mismatch,
      corrected,
    };
  }

  // ─── ADMIN — RECONCILE ALL PROFILES ───

  async reconcileAllTotals(admin: CurrentUserDto, autoCorrect: boolean) {
    const profiles = await this.prisma.victimProfile.findMany({ select: { id: true } });

    const results = await Promise.all(
      profiles.map((p) => this.reconcileProfileTotal(admin, p.id, autoCorrect)),
    );

    return results.filter((r) => r.mismatch);
  }
}
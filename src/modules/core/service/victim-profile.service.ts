import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { Prisma, VictimProfile, VictimProfileStatus } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';

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

@Injectable()
export class VictimProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // MEDIA HELPERS
  // ─────────────────────────────────────────────

  private getMediaBucket(): string {
    return this.configService.get<string>('minio.bucketName') ?? 'ehte-media';
  }

  private collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  // Diffs each media field individually (not the flattened whole),
  // so a client resending the same array doesn't get treated as
  // "remove and re-add." Only fields present in the incoming DTO
  // are considered — an omitted field means "leave this one alone."
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

  // FIX (item #3): previously only checked existence. Now brought to
  // parity with ReportService.validateMediaFilesExist — also enforces
  // size/MIME-type limits, and returns each validated file's size so
  // callers can maintain mediaTotalBytes without re-statting
  // already-attached files (item #13).
  //
  // NOTE (item #4, EXIF/GPS stripping): deliberately out of scope
  // here, same as Report/Post — belongs in the media-upload module
  // at upload time.
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

  // FIX (item #13): per-field attachment counts, mirroring
  // ReportService.assertAttachmentCounts, reading PROFILE_*-prefixed
  // overrides first, falling back to the shared CONTENT_* defaults.
  // Photo default is higher than Report's (10 vs 5) per the
  // checklist's own example limits for Victim Profile.
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

  // FIX (item #13): total attached-media size cap per profile,
  // mirroring ReportService.assertTotalBytes.
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

  // Best-effort delete against MinIO. A file that's already gone
  // (or MinIO briefly unreachable) must never block the DB write
  // that triggered the cleanup — failures are swallowed per-file
  // via allSettled rather than surfaced to the caller.
  private async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  // The only media field ever exposed on a public profile is
  // `photo` (see serializePublicProfile below), and only when the
  // profile doesn't involve a child.
  private getPubliclyVisibleMediaKeys(
    profile: Pick<VictimProfile, 'photo' | 'involvesChild'>,
  ): string[] {
    return profile.involvesChild ? [] : profile.photo;
  }

  // ─────────────────────────────────────────────
  // ACCESS CONTROL HELPERS
  //
  // FIX (item #9/#17): previously no admin-access gating existed
  // anywhere in this service — any ADMIN could act on any profile
  // regardless of who claimed it, and claimedByUserId/claimedAt sat
  // on the schema unused. Mirrors ReportService's
  // assertAdminCanAccessReport: SUPER_ADMIN may act on any profile;
  // a plain ADMIN may only act on a profile that is unclaimed or
  // claimed specifically by them. Viewing (findOne, getGates,
  // getHistory, getSupportsSummary, admin media download) stays
  // open to any admin, same as Report's read/write split.
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

  // FIX (item #9/#26): optimistic-concurrency helper used by every
  // mutating method below. Guards the write on the `updatedAt` the
  // caller read a moment earlier — same reasoning as Report's
  // conditional updateMany on `status`, generalized here since
  // profile mutations touch far more than just `status` (gates,
  // bank details, claim state, etc). A losing writer gets
  // victim_profile_transition_conflict instead of silently
  // clobbering a concurrent admin's change.
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
  // ADMIN — CLAIM / UNCLAIM (item #17)
  //
  // Self-serve equivalent of Report's SUPER_ADMIN-gated assign(),
  // matching Post's claim pattern instead: any ADMIN/SUPER_ADMIN can
  // claim an unclaimed profile; only the claiming admin (or a
  // SUPER_ADMIN) can release it. Every other mutating method below
  // calls assertAdminCanAccessProfile(), so claiming is what
  // actually prevents two admins from silently working the same
  // profile.
  // ─────────────────────────────────────────────

  async claim(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (existing.claimedByUserId === admin.id) {
      // Already claimed by this admin — idempotent no-op.
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
      // Someone else claimed it in the gap between our read and write.
      throw new ForbiddenException('victim_profile_already_claimed');
    }

    const profile = await this.prisma.victimProfile.findUniqueOrThrow({ where: { id } });

    this.eventEmitter.emit('victim_profile.claimed', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'CLAIM',
      entity: 'VictimProfile',
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

    this.eventEmitter.emit('victim_profile.unclaimed', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'UNCLAIM',
      entity: 'VictimProfile',
      previousClaimedByUserId: existing.claimedByUserId,
    });

    return profile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET MEDIA DOWNLOAD URL
  //
  // FIX (item #14/#25): now emits an audit event on access, matching
  // ReportService.getMediaDownloadUrlForAdmin — previously this
  // route left no trace that a specific admin pulled a specific
  // victim's media.
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

    this.eventEmitter.emit('victim_profile.media_downloaded', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'MEDIA_DOWNLOADED',
      entity: 'VictimProfile',
      key,
    });

    return { url };
  }

  // ─────────────────────────────────────────────
  // PUBLIC — GET MEDIA DOWNLOAD URL
  // (unchanged — already correctly scoped)
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
  //
  // FIX (item #8): createdByUserId is now actually persisted — it
  // was previously omitted entirely despite being on the schema,
  // so profiles had no record of which admin created them.
  //
  // FIX (item #5/#26): optional Idempotency-Key (passed through by
  // the controller) lets a client safely retry after a dropped
  // response. A repeat with the same key returns the original
  // profile. A fast-path lookup runs first; the actual create is
  // wrapped to catch a P2002 race on the new
  // (createdByUserId, idempotencyKey) unique constraint, same
  // pattern as ReportService.createReportWithUniqueCaseReference.
  //
  // FIX (item #13): attachment counts/total size are checked before
  // any MinIO round trips, and the validated sizes are persisted as
  // mediaTotalBytes.
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
          // Lost a race against a concurrent identical retry — the
          // other request's insert won; return that row instead of
          // creating (or failing to create) a duplicate.
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

    this.eventEmitter.emit('victim_profile.created', {
      actorId: currentUser.id,
      victimProfileId: profile.id,
      action: 'CREATE',
      entity: 'VictimProfile',
    });

    this.eventEmitter.emit('notification.victim_profile.created', {
      actorId: currentUser.id,
      victimProfileId: profile.id,
    });

    return profile;
  }

  // ─────────────────────────────────────────────
  // GET ONE (admin) — unchanged, view access stays open to any admin
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
  //
  // FIX (item #7): bankAccountName/bankAccountNumber/bankName are no
  // longer selected or returned here. This was a live bank-detail
  // leak to anonymous callers — the off-platform transfer
  // destination has no business being in a public API response.
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
  // FIX (item #7): same bank-detail exclusion as findPublic above.
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

        createdAt: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    return this.serializePublicProfile(profile);
  }

  // FIX (item #7): bankAccountName/bankAccountNumber/bankName removed
  // from both the input type and the returned payload. Off-platform
  // transfer details are an admin-only field (see
  // getGates/updateBankDetails) and must never reach an anonymous
  // caller — supporters are directed to give through the platform's
  // own support/donation flow, not by wiring money to a bank account
  // printed on a public page.
  private serializePublicProfile(profile: {
    id: string;
    name: string | null;
    story: string | null;
    supportType: unknown;
    supportGoal: Prisma.Decimal | null;
    photo: string[];
    involvesChild: boolean;
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

      createdAt: profile.createdAt,
    };
  }

  // ─────────────────────────────────────────────
  // UPDATE PROFILE
  //
  // FIX (item #9): now requires assertAdminCanAccessProfile — a
  // profile claimed by another admin can no longer be edited out
  // from under them.
  //
  // FIX (item #13): attachment counts are checked against the fully
  // merged post-update media shape before any MinIO calls, and
  // mediaTotalBytes is recomputed from the previous total plus/minus
  // the added/removed files' sizes.
  //
  // FIX (item #26): write is now optimistic-concurrency guarded via
  // conditionalUpdate.
  //
  // An edit also clears any in-progress two-admin child-safety
  // confirmation (item #16) — a profile whose content just changed
  // shouldn't carry over a stale first-confirmation from before the
  // edit.
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

      // Reset approval pipeline after editing.
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

    // Only after the DB write commits.
    await this.deleteMediaFiles(removed);

    this.eventEmitter.emit('victim_profile.updated', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'UPDATE',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: VictimProfileStatus.PENDING,
    });

    this.eventEmitter.emit('notification.victim_profile.updated', {
      actorId: admin.id,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // DELETE
  // FIX (item #9): access-gated; FIX (item #26): concurrency-guarded.
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

    this.eventEmitter.emit('victim_profile.deleted', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'DELETE',
      entity: 'VictimProfile',

      previousStatus: profile.status,
    });

    this.eventEmitter.emit('notification.victim_profile.deleted', {
      actorId: admin.id,
      victimProfileId: id,
    });

    return { message: 'victim_profile_deleted', id };
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ALL (unchanged)
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
  // ADMIN — STALE / UNCLAIMED-TOO-LONG PROFILES (item #15)
  // GET /victim-profiles/admin/stale
  //
  // A profile is "forgotten" if it's both unclaimed AND not yet in a
  // dead-end status (PUBLISHED/REJECTED), same reasoning as
  // ReportService.findStalePending. Child-involving profiles use a
  // shorter threshold per the checklist's own guidance ("for
  // urgent/child-related content, use a shorter threshold").
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
  // ADMIN — DASHBOARD STATISTICS (unchanged)
  // ─────────────────────────────────────────────

  async getStats() {
    const [total, grouped] = await this.prisma.$transaction([
      this.prisma.victimProfile.count(),
      this.prisma.victimProfile.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
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
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — AUDIT HISTORY (unchanged)
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
  // Adds claim state to the checklist payload so the dashboard can
  // show "claimed by X" without a second request.
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
  // FIX (item #9): access-gated. FIX (item #26): concurrency-guarded.
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

    this.eventEmitter.emit('victim_profile.gates_updated', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'UPDATE_APPROVAL_GATES',
      entity: 'VictimProfile',

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
    });

    this.eventEmitter.emit('notification.victim_profile.gates_updated', {
      actorId: admin.id,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — CHILD SAFETY REVIEW (§32 / item #16)
  //
  // FIX (item #16): previously a single admin could flip
  // isChildSafetyReviewed straight to true — the schema had
  // childSafetyFirstConfirmedByUserId/At for two-admin approval but
  // nothing used them. Now:
  //   1. First admin confirms  -> recorded as the first confirmer,
  //      isChildSafetyReviewed stays false.
  //   2. A DIFFERENT admin confirms -> isChildSafetyReviewed flips
  //      to true. The same admin cannot supply both confirmations.
  //   3. Reversing (isChildSafetyReviewed: false) clears the whole
  //      confirmation chain, not just the flag, so a fresh review
  //      always starts from zero — and drops admin approval/publish
  //      state, since those depended on the review being current.
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

        this.eventEmitter.emit('victim_profile.child_safety_first_confirmed', {
          actorId: admin.id,
          victimProfileId: id,
          action: 'CHILD_SAFETY_FIRST_CONFIRM',
          entity: 'VictimProfile',
          reviewNotes: data.reviewNotes,
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

      this.eventEmitter.emit('victim_profile.child_safety_reviewed', {
        actorId: admin.id,
        victimProfileId: id,
        action: 'UPDATE_CHILD_SAFETY_REVIEW',
        entity: 'VictimProfile',

        previousStatus: profile.status,
        newStatus: status,

        firstConfirmedBy: profile.childSafetyFirstConfirmedByUserId,
        secondConfirmedBy: admin.id,
        reviewNotes: data.reviewNotes,
      });

      this.eventEmitter.emit('notification.victim_profile.child_safety_reviewed', {
        actorId: admin.id,
        victimProfileId: id,
        status,
      });

      return updatedProfile;
    }

    // Reversal — clear the confirmation chain and anything downstream.
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

    this.eventEmitter.emit('victim_profile.child_safety_review_reversed', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'UPDATE_CHILD_SAFETY_REVIEW',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: status,
      reviewNotes: data.reviewNotes,
    });

    this.eventEmitter.emit('notification.victim_profile.child_safety_reviewed', {
      actorId: admin.id,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVOKE CONSENT
  // FIX (item #9): access-gated. FIX (item #26): concurrency-guarded.
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

    this.eventEmitter.emit('victim_profile.consent_revoked', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'REVOKE_CONSENT',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: status,

      previousConsentAt: profile.consentAt,
      previousConsentRecordedBy: profile.consentRecordedBy,

      reason: data.reason,
    });

    this.eventEmitter.emit('notification.victim_profile.consent_revoked', {
      actorId: admin.id,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE BANK DETAILS
  // FIX (item #9): access-gated. FIX (item #26): concurrency-guarded.
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

    this.eventEmitter.emit('victim_profile.bank_details_updated', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'UPDATE_BANK_DETAILS',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: status,

      reapprovalRequired: wasApproved,
    });

    this.eventEmitter.emit('notification.victim_profile.bank_details_updated', {
      actorId: admin.id,
      victimProfileId: id,
      reapprovalRequired: wasApproved,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — PUBLISH
  // FIX (item #9): access-gated. FIX (item #26): concurrency-guarded.
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

    this.eventEmitter.emit('victim_profile.published', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'PUBLISH',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: VictimProfileStatus.PUBLISHED,
    });

    this.eventEmitter.emit('notification.victim_profile.published', {
      actorId: admin.id,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UNPUBLISH
  // FIX (item #9): access-gated. FIX (item #26): concurrency-guarded.
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

    this.eventEmitter.emit('victim_profile.unpublished', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'UNPUBLISH',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: VictimProfileStatus.UNPUBLISHED,
    });

    this.eventEmitter.emit('notification.victim_profile.unpublished', {
      actorId: admin.id,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REJECT
  // FIX (item #9): access-gated. FIX (item #26): concurrency-guarded.
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

    this.eventEmitter.emit('victim_profile.rejected', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'REJECT',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: VictimProfileStatus.REJECTED,
    });

    this.eventEmitter.emit('notification.victim_profile.rejected', {
      actorId: admin.id,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — RESUBMIT AFTER REJECTION
  // FIX (item #9): access-gated. FIX (item #26): concurrency-guarded.
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

    this.eventEmitter.emit('victim_profile.resubmitted', {
      actorId: admin.id,
      victimProfileId: id,
      action: 'RESUBMIT',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: status,
    });

    this.eventEmitter.emit('notification.victim_profile.resubmitted', {
      actorId: admin.id,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }
}
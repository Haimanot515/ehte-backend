import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import {
  AuditOutcome,
  AuditSeverity,
  Prisma,
  SupportType,
  VictimProfile,
  VictimProfileStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { DateRangeQueryDto, ReasonDto, StatsQueryDto } from '../dto/victim-profile.dto';
import {
  MEDIA_FIELD_NAMES,
  MediaFieldName,
  MediaBearing,
  MediaBearingDto,
  ProfileAuditRef,
  ConflictAuditContext,
  money,
} from './victim-profile.constants';

@Injectable()
export class VictimProfileCommonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
  ) {}

  emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // Child profiles get a redacted label.
  profileLabel(profile: Pick<VictimProfile, 'id' | 'name' | 'involvesChild'>): string | undefined {
    if (profile.involvesChild) {
      return `Child profile ${profile.id.slice(0, 8)}`;
    }
    return profile.name ?? undefined;
  }

  targetUserFor(
    actor: CurrentUserDto,
    profile: Pick<VictimProfile, 'createdByUserId'>,
  ): { targetUserId?: string } {
    const creatorId = profile.createdByUserId;
    return creatorId && creatorId !== actor.id ? { targetUserId: creatorId } : {};
  }

  emitProfileFailure(
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
      },
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
  }

  getMediaBucket(): string {
    return this.configService.get<string>('minio.bucketName') ?? 'ehte-media';
  }

  collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  diffMediaFields(
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

  async validateMediaFilesExist(
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

  assertAttachmentCounts(media: MediaBearing): void {
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

  assertTotalBytes(totalBytes: number): void {
    const maxTotalBytes = Number(
      this.configService.get<string>('PROFILE_MAX_TOTAL_UPLOAD_BYTES') ??
        this.configService.get<string>('CONTENT_MAX_TOTAL_UPLOAD_BYTES') ??
        52_428_800,
    );
    if (totalBytes > maxTotalBytes) {
      throw new BadRequestException(`upload_total_size_exceeded:max_${maxTotalBytes}`);
    }
  }

  async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  getRoles(user: CurrentUserDto): string[] {
    return (user as unknown as { roles?: string[] }).roles ?? [];
  }

  assertAdminCanAccessProfile(
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

  async conditionalUpdate(
    id: string,
    expectedUpdatedAt: Date,
    data: Prisma.VictimProfileUncheckedUpdateManyInput,
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

  getMissingApprovalGates(g: {
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

  serializePublicProfile(profile: {
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
      supportGoal: profile.supportGoal ? money(profile.supportGoal) : null,

      photo: profile.involvesChild ? [] : profile.photo,

      totalRaised: money(profile.totalRaised),

      createdAt: profile.createdAt,
    };
  }

  deriveStatus(gates: {
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

  /**
   * Approval/publish gate: true only when the profile has a VERIFIED, complete BANK
   * PayoutDestination (account holder, number, bank name and Chapa bank code).
   * Unverified or incomplete destinations do not satisfy the gate.
   */
  async hasBankDetails(profileId: string): Promise<boolean> {
    const d = await this.prisma.payoutDestination.findUnique({
      where: { victimProfileId: profileId },
      select: {
        rail: true,
        isVerified: true,
        accountHolder: true,
        accountNumber: true,
        bankName: true,
        bankCode: true,
      },
    });
    return (
      !!d &&
      d.isVerified &&
      d.rail === 'BANK' &&
      !!d.accountHolder &&
      !!d.accountNumber &&
      !!d.bankName &&
      !!d.bankCode
    );
  }

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

    await this.cache.invalidateVictimProfileEverywhere(id);

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

    await this.cache.invalidateVictimProfileEverywhere(id);

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

    await this.cache.invalidateVictimProfileEverywhere(id);

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
      actorId: admin.id,
    });

    return updatedProfile;
  }

  // ── New shared helpers ──────────────────────────────────────────────────────

  pageOf(q: { page?: number; limit?: number }) {
    const page = q.page && q.page > 0 ? q.page : 1;
    const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 100) : 20;
    return { page, limit, skip: (page - 1) * limit };
  }

  metaOf(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  async getProfileOr404(id: string): Promise<VictimProfile> {
    const profile = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!profile) throw new NotFoundException('victim_profile_not_found');
    return profile;
  }

  async assertProfileExists(id: string): Promise<void> {
    const found = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('victim_profile_not_found');
  }

  // 404 (not 403) for somebody else's profile so ids can't be probed.
  async getMineOr404(user: CurrentUserDto, id: string): Promise<VictimProfile> {
    const profile = await this.prisma.victimProfile.findFirst({
      where: { id, createdByUserId: user.id, deletedAt: null },
    });
    if (!profile) throw new NotFoundException('victim_profile_not_found');
    return profile;
  }

  // Success-path audit helper for the new methods (failures keep using emitProfileFailure()).
  auditSuccess(
    actor: CurrentUserDto,
    action: AuditEventEnum,
    profile: ProfileAuditRef,
    opts: {
      diff?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      reason?: string | null;
      severity?: AuditSeverity;
    } = {},
  ): void {
    this.emitAudit({
      userId: actor.id,
      ...this.targetUserFor(actor, profile),
      actorType: resolveActorType(this.getRoles(actor)),
      action,
      ...(opts.severity ? { severity: opts.severity } : {}),
      entity: 'VictimProfile',
      entityId: profile.id,
      entityLabel: this.profileLabel(profile),
      reason: opts.reason ?? null,
      diff: { result: 'success', ...(opts.diff ?? {}) },
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
  }

  // Sensitive admin reads leave a trail so VP-81 (access log) has something to show.
  logAdminView(admin: CurrentUserDto, profile: ProfileAuditRef, section: string): void {
    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_ADMIN_VIEWED, profile, {
      metadata: { section },
    });
  }

  publicWhere(): Prisma.VictimProfileWhereInput {
    return {
      status: VictimProfileStatus.PUBLISHED,
      isPublished: true,
      isVerified: true,
      isSafetyReviewed: true,
      hasConsent: true,
      isPrivacyReviewed: true,
      isAdminApproved: true,
      deletedAt: null,
    };
  }

  async assertPublishedProfile(id: string) {
    const profile = await this.prisma.victimProfile.findFirst({
      where: { id, ...this.publicWhere() },
      select: {
        id: true,
        name: true,
        involvesChild: true,
        supportType: true,
        supportGoal: true,
        totalRaised: true,
        fundingEndsAt: true,
        createdByUserId: true,
        donationsPaused: true,
      },
    });
    if (!profile) throw new NotFoundException('victim_profile_not_found');
    return profile;
  }

  findMediaField(profile: MediaBearing, key: string): MediaFieldName | null {
    return MEDIA_FIELD_NAMES.find((field) => profile[field].includes(key)) ?? null;
  }

  unreadWhere(
    admin: CurrentUserDto,
    extra: Prisma.VictimProfileWhereInput = {},
  ): Prisma.VictimProfileWhereInput {
    return { deletedAt: null, readStates: { none: { adminId: admin.id } }, ...extra };
  }

  async creatorNames(ids: string[]): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  // Stats filters — shared by search, facets, export and every stats route.
  parseRange(q: DateRangeQueryDto): { from?: Date; to?: Date } {
    const from = q.from ? new Date(q.from) : undefined;
    let to = q.to ? new Date(q.to) : undefined;
    if (q.to && to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
      to = new Date(to.getTime() + 86_400_000 - 1); // date-only `to` is inclusive
    }
    if (from && to && from > to) throw new BadRequestException('invalid_date_range');
    return { from, to };
  }

  statsWhere(q: StatsQueryDto): Prisma.VictimProfileWhereInput {
    const { from, to } = this.parseRange(q);

    // "Need category" is the profile's supportType today.
    let supportType: SupportType | undefined;
    if (q.category) {
      if (!(Object.values(SupportType) as string[]).includes(q.category)) {
        throw new BadRequestException('invalid_category');
      }
      supportType = q.category as SupportType;
    }

    return {
      deletedAt: null,
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(supportType ? { supportType } : {}),
      ...(q.creatorId ? { createdByUserId: q.creatorId } : {}),
      ...(q.involvesChild !== undefined ? { involvesChild: q.involvesChild } : {}),
      ...(q.assignedTo ? { assignedReviewerId: q.assignedTo } : {}),
    };
  }

  // VP-71
  async pauseDonations(admin: CurrentUserDto, id: string, data: ReasonDto) {
    const profile = await this.getProfileOr404(id);
    if (profile.donationsPaused) throw new BadRequestException('donations_already_paused');

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      { donationsPaused: true, donationsPausedReason: data.reason, donationsPausedAt: new Date() },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_DONATIONS_PAUSED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);
    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_DONATIONS_PAUSED, profile, {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
    });
    return updated;
  }
}

import {
  BadRequestException,
  ConflictException,
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
  VictimProfileAppealStatus,
  VictimProfileExportJobStatus,
  VictimProfileFlagStatus,
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
import { CacheService } from 'src/services/redis/cache.service';

import {
  AdminEditVictimProfileDto,
  AdminSearchQueryDto,
  AnonymizeDto,
  AppealDecision,
  AssignReviewerDto,
  BulkAssignDto,
  BulkIdsDto,
  BulkReasonDto,
  BulkRequestChangesDto,
  CompleteProfileDto,
  CreateAppealDto,
  CreateProfileUpdateDto,
  CreateVictimProfileDto,
  DateRangeQueryDto,
  DecideAppealDto,
  ExportQueryDto,
  FindAllVictimProfilesQueryDto,
  FindAppealsQueryDto,
  FindFlagsQueryDto,
  FindPublicVictimProfilesQueryDto,
  FindUnreadVictimProfilesQueryDto,
  FlagReason,
  FlagResolution,
  FlagVictimProfileDto,
  LegalHoldDto,
  LiftTakedownDto,
  PagedQueryDto,
  PublicSearchQueryDto,
  ReadAllDto,
  ReasonDto,
  RecordConsentDto,
  RedactMediaDto,
  RemoveMediaDto,
  RequestChangesDto,
  ResolveFlagDto,
  RevokeConsentDto,
  StatsInterval,
  StatsQueryDto,
  StatsTimelineQueryDto,
  TakedownDto,
  UpdateBankDetailsDto,
  UpdateChildFlagDto,
  UpdateChildSafetyReviewDto,
  UpdateGoalDto,
  UpdateVictimGateDto,
  UpdateVictimProfileDto,
  VerifyBankDetailsDto,
} from '../dto/victim-profile.dto';

const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

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

const STALE_ELIGIBLE_EXCLUDED_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PUBLISHED,
  VictimProfileStatus.REJECTED,
];

const money = (d: Prisma.Decimal | number | string | null | undefined): string =>
  d == null ? '0.00' : new Prisma.Decimal(d).toFixed(2);

async function mapWithConcurrency<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

const BANK_DETAIL_FIELDS = ['bankAccountName', 'bankAccountNumber', 'bankName'] as const;

const CONFIRMED_SUPPORT_STATUSES = ['CONFIRMED', 'COMPLETED'] as const;

// Creator-side lifecycle rules.
const CREATOR_EDITABLE_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PENDING,
  VictimProfileStatus.REJECTED,
  VictimProfileStatus.CHANGES_REQUESTED,
];
const CREATOR_WITHDRAWABLE_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PENDING,
  VictimProfileStatus.UNDER_REVIEW,
  VictimProfileStatus.VERIFIED,
  VictimProfileStatus.CONSENT_PENDING,
  VictimProfileStatus.APPROVED,
  VictimProfileStatus.CHANGES_REQUESTED,
];
const CREATOR_RESUBMITTABLE_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.CHANGES_REQUESTED,
  VictimProfileStatus.REJECTED,
];

// Admin-side lifecycle rules.
const CHANGE_REQUESTABLE_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PENDING,
  VictimProfileStatus.UNDER_REVIEW,
  VictimProfileStatus.VERIFIED,
  VictimProfileStatus.CONSENT_PENDING,
  VictimProfileStatus.APPROVED,
];
// Statuses that are "in the pipeline" (waiting on staff) — used by aging / backlog / child stats.
const PIPELINE_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PENDING,
  VictimProfileStatus.UNDER_REVIEW,
  VictimProfileStatus.VERIFIED,
  VictimProfileStatus.CONSENT_PENDING,
  VictimProfileStatus.APPROVED,
];
// Statuses from which a gate re-derivation is meaningful (anything that is not a closed outcome).
const GATE_DRIVEN_STATUSES: VictimProfileStatus[] = [
  ...PIPELINE_STATUSES,
  VictimProfileStatus.PUBLISHED,
];
const CLOSED_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.REJECTED,
  VictimProfileStatus.WITHDRAWN,
  VictimProfileStatus.COMPLETED,
];
const APPROVED_OUTCOME_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.APPROVED,
  VictimProfileStatus.PUBLISHED,
  VictimProfileStatus.COMPLETED,
];

// Which next statuses each status can reach, and through which endpoint (VP-65).
const STATUS_TRANSITIONS: Record<
  VictimProfileStatus,
  Array<{ to: VictimProfileStatus; via: string }>
> = {
  PENDING: [
    { to: 'UNDER_REVIEW', via: 'PATCH admin/:id/gates' },
    { to: 'CHANGES_REQUESTED', via: 'PATCH admin/:id/request-changes' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  UNDER_REVIEW: [
    { to: 'CONSENT_PENDING', via: 'PATCH admin/:id/gates' },
    { to: 'VERIFIED', via: 'PATCH admin/:id/gates' },
    { to: 'CHANGES_REQUESTED', via: 'PATCH admin/:id/request-changes' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  CONSENT_PENDING: [
    { to: 'UNDER_REVIEW', via: 'POST admin/:id/consent' },
    { to: 'VERIFIED', via: 'POST admin/:id/consent' },
    { to: 'CHANGES_REQUESTED', via: 'PATCH admin/:id/request-changes' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  VERIFIED: [
    { to: 'APPROVED', via: 'PATCH admin/:id/gates (isAdminApproved)' },
    { to: 'CHANGES_REQUESTED', via: 'PATCH admin/:id/request-changes' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  APPROVED: [
    { to: 'PUBLISHED', via: 'PATCH admin/:id/publish' },
    { to: 'CHANGES_REQUESTED', via: 'PATCH admin/:id/request-changes' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  PUBLISHED: [
    { to: 'UNPUBLISHED', via: 'PATCH admin/:id/unpublish' },
    { to: 'UNPUBLISHED', via: 'POST admin/:id/takedown' },
    { to: 'COMPLETED', via: 'PATCH admin/:id/complete' },
  ],
  UNPUBLISHED: [{ to: 'PUBLISHED', via: 'PATCH admin/:id/publish (all gates must still hold)' }],
  CHANGES_REQUESTED: [
    { to: 'PENDING', via: 'PATCH mine/:id/resubmit (creator; re-derived from gates)' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  REJECTED: [
    {
      to: 'PENDING',
      via: 'PATCH admin/:id/resubmit | PATCH mine/:id/resubmit | appeal overturned',
    },
  ],
  WITHDRAWN: [],
  COMPLETED: [{ to: 'PUBLISHED', via: 'PATCH admin/:id/reopen' }],
};

// What a creator is allowed to see in their own timeline. Internal actions (gate flips,
// claims, child-safety confirmations, flags, bank verification...) are deliberately absent.
const CREATOR_VISIBLE_STAFF_ACTIONS: AuditEventEnum[] = [
  AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
  AuditEventEnum.VICTIM_PROFILE_UNPUBLISHED,
  AuditEventEnum.VICTIM_PROFILE_REJECTED,
  AuditEventEnum.VICTIM_PROFILE_RESUBMITTED,
  AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED,
  AuditEventEnum.VICTIM_PROFILE_COMPLETED,
  AuditEventEnum.VICTIM_PROFILE_REOPENED,
  AuditEventEnum.VICTIM_PROFILE_TAKEDOWN,
  AuditEventEnum.VICTIM_PROFILE_TAKEDOWN_LIFTED,
  AuditEventEnum.VICTIM_PROFILE_APPEAL_DECIDED,
  AuditEventEnum.VICTIM_PROFILE_UPDATE_POSTED,
];
const CREATOR_TIMELINE_ACTIONS: AuditEventEnum[] = [
  ...CREATOR_VISIBLE_STAFF_ACTIONS,
  AuditEventEnum.VICTIM_PROFILE_CREATED,
  AuditEventEnum.VICTIM_PROFILE_UPDATED,
  AuditEventEnum.VICTIM_PROFILE_WITHDRAWN,
  AuditEventEnum.VICTIM_PROFILE_APPEAL_CREATED,
];

// Used by the review-time / backlog stats, which are derived from the audit trail so they work
// for transitions made by the existing methods too.
const FIRST_REVIEW_ACTIONS: AuditEventEnum[] = [
  AuditEventEnum.VICTIM_PROFILE_CLAIMED,
  AuditEventEnum.VICTIM_PROFILE_GATES_UPDATED,
  AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_FIRST_CONFIRMED,
  AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
  AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED,
  AuditEventEnum.VICTIM_PROFILE_REJECTED,
  AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
];
const DECISION_ACTIONS: AuditEventEnum[] = [
  AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
  AuditEventEnum.VICTIM_PROFILE_REJECTED,
];

const CHILD_FLAG_PROPOSAL_TTL_MS = 72 * 60 * 60 * 1000;

// Public-facing projection (kept identical to the select used by findPublic / findOnePublic so
// serializePublicProfile() keeps working for every public list).
const PUBLIC_PROFILE_SELECT = {
  id: true,
  name: true,
  story: true,
  supportType: true,
  supportGoal: true,
  photo: true,
  involvesChild: true,
  totalRaised: true,
  createdAt: true,
} satisfies Prisma.VictimProfileSelect;

const maskAccount = (n: string | null | undefined): string | null =>
  n ? `${'•'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}` : null;

// CSV: quote every cell and neutralise spreadsheet-formula injection (=, +, -, @, tab, CR).
const csvCell = (v: unknown): string => {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const hoursBetween = (a: Date, b: Date): number => (b.getTime() - a.getTime()) / 3_600_000;

const summarize = (hours: number[]) => {
  if (!hours.length) return { count: 0, avgHours: null, medianHours: null, p90Hours: null };
  const s = [...hours].sort((x, y) => x - y);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    count: s.length,
    avgHours: r(s.reduce((a, b) => a + b, 0) / s.length),
    medianHours: r(at(0.5)),
    p90Hours: r(at(0.9)),
  };
};

// Bank fields are stripped from every NEW admin listing (same rule G11 applies to findOne).
const stripBank = <T extends object>(p: T): Omit<T, (typeof BANK_DETAIL_FIELDS)[number]> => {
  const copy = { ...p } as Record<string, unknown>;
  for (const f of BANK_DETAIL_FIELDS) delete copy[f];
  return copy as Omit<T, (typeof BANK_DETAIL_FIELDS)[number]>;
};

@Injectable()
export class VictimProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // Child profiles get a redacted label.
  private profileLabel(
    profile: Pick<VictimProfile, 'id' | 'name' | 'involvesChild'>,
  ): string | undefined {
    if (profile.involvesChild) {
      return `Child profile ${profile.id.slice(0, 8)}`;
    }
    return profile.name ?? undefined;
  }

  private targetUserFor(
    actor: CurrentUserDto,
    profile: Pick<VictimProfile, 'createdByUserId'>,
  ): { targetUserId?: string } {
    const creatorId = profile.createdByUserId;
    return creatorId && creatorId !== actor.id ? { targetUserId: creatorId } : {};
  }

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
      },
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
  }

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

  private getRoles(user: CurrentUserDto): string[] {
    return (user as unknown as { roles?: string[] }).roles ?? [];
  }

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

  private async conditionalUpdate(
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

  async findBankDetails(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: {
        id: true,
        bankAccountName: true,
        bankAccountNumber: true,
        bankName: true,
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
        status: { in: ['CONFIRMED', 'COMPLETED'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Only financial supports carry money; non-financial offers never count toward the total.
    const totalReceived = supports
      .filter((support) => support.type === 'FINANCIAL')
      .reduce((sum, support) => sum + Number(support.recipientAmount ?? support.amount ?? 0), 0);

    return {
      totalReceived,
      supportCount: supports.length,
      supports,
    };
  }

  async findPublic(query: FindPublicVictimProfilesQueryDto) {
    return this.cache.wrapVictimProfileList(query as unknown as Record<string, unknown>, () =>
      this.findPublicUncached(query),
    );
  }

  private async findPublicUncached(query: FindPublicVictimProfilesQueryDto) {
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

  async findOnePublic(id: string) {
    const cached =
      await this.cache.getVictimProfile<ReturnType<typeof this.serializePublicProfile>>(id);
    if (cached !== null) return cached;

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

    const serialized = this.serializePublicProfile(profile);
    await this.cache.setVictimProfile(id, serialized);
    return serialized;
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
      supportGoal: profile.supportGoal ? money(profile.supportGoal) : null,

      photo: profile.involvesChild ? [] : profile.photo,

      totalRaised: money(profile.totalRaised),

      createdAt: profile.createdAt,
    };
  }

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
    await this.cache.invalidateVictimProfileEverywhere(id);

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

  async remove(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_DELETED);

    const unsettled = await this.prisma.payment.findFirst({
      where: {
        victimProfileId: id,
        status: 'PAID',
        allocations: { some: { settlementStatus: 'PENDING' } },
      },
      select: { id: true },
    });
    if (unsettled) {
      this.emitProfileFailure(
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
    await this.cache.invalidateVictimProfileEverywhere(id);

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
        totalRaisedAtDeletion: money(profile.totalRaised),
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_DELETED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return { message: 'victim_profile_deleted', id };
  }

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

  // Not cached: sharing a single global stats cache key across modules risks cross-overwrite.
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
      totalRaisedAllProfiles: money(raised._sum.totalRaised ?? 0),
    };
  }

  async getPublicStats() {
    const raised = await this.prisma.victimProfile.aggregate({
      where: {
        status: VictimProfileStatus.PUBLISHED,
        isPublished: true,
      },
      _sum: { totalRaised: true },
    });

    return {
      totalRaisedAllProfiles: money(raised._sum.totalRaised ?? 0),
    };
  }

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

    await this.cache.invalidateVictimProfileEverywhere(id);

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

      await this.cache.invalidateVictimProfileEverywhere(id);

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

    await this.cache.invalidateVictimProfileEverywhere(id);

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

    await this.cache.invalidateVictimProfileEverywhere(id);

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
      actorId: admin.id,
    });

    return updatedProfile;
  }

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

    if (profile.involvesChild && data.accountHolderRelationship === 'SELF') {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
        profile,
        'account_holder_cannot_be_the_child',
      );
      throw new BadRequestException('account_holder_cannot_be_the_child');
    }

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

    await this.prisma.payoutDestination.upsert({
      where: { victimProfileId: id },
      create: {
        rail: 'BANK',
        bankName: data.bankName,
        accountNumber: data.bankAccountNumber,
        accountHolder: data.accountHolderName,
        victimProfileId: id,
      },
      update: {
        bankName: data.bankName,
        accountNumber: data.bankAccountNumber,
        accountHolder: data.accountHolderName,
        isVerified: false,
      },
    });

    await this.cache.invalidateVictimProfileEverywhere(id);

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
        accountHolderRelationship: data.accountHolderRelationship,
        bankCodeProvided: data.bankCode,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      reapprovalRequired: wasApproved,
      actorId: admin.id,
    });

    return updatedProfile;
  }

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

    await this.cache.invalidateVictimProfileEverywhere(id);

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

  async reconcileProfileTotal(admin: CurrentUserDto, id: string, autoCorrect: boolean) {
    const profile = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const agg = await this.prisma.paymentAllocation.aggregate({
      where: {
        partyType: 'RECIPIENT',
        payment: {
          victimProfileId: id,
          type: 'SUPPORT',
          status: 'PAID',
          support: { status: { not: 'CANCELLED' } },
        },
      },
      _sum: { amount: true },
      _count: true,
    });

    const liveTotal = new Prisma.Decimal(agg._sum.amount ?? 0);
    const cachedTotal = new Prisma.Decimal(profile.totalRaised);
    const mismatch = liveTotal.sub(cachedTotal).abs().gt('0.01');

    let corrected = false;

    if (mismatch && autoCorrect) {
      await this.conditionalUpdate(
        id,
        profile.updatedAt,
        { totalRaised: liveTotal },
        { admin, action: AuditEventEnum.VICTIM_PROFILE_TOTAL_RECONCILED, profile },
      );
      corrected = true;
      await this.cache.invalidateVictimProfileEverywhere(id);
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
          previousCachedTotal: money(cachedTotal),
          liveTotal: money(liveTotal),
          corrected,
        },
        metadata: {
          difference: money(liveTotal.sub(cachedTotal)),
          paidPaymentCount: agg._count,
        },
      });
    }

    return {
      victimProfileId: id,
      cachedTotal: money(cachedTotal),
      liveTotal: money(liveTotal),
      mismatch,
      corrected,
    };
  }

  async reconcileAllTotals(admin: CurrentUserDto, autoCorrect: boolean) {
    const profiles = await this.prisma.victimProfile.findMany({ select: { id: true } });

    const results = await mapWithConcurrency(profiles, 10, (p) =>
      this.reconcileProfileTotal(admin, p.id, autoCorrect),
    );

    return results.filter((r) => r.mismatch);
  }

  // ── New shared helpers ──────────────────────────────────────────────────────

  private pageOf(q: { page?: number; limit?: number }) {
    const page = q.page && q.page > 0 ? q.page : 1;
    const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 100) : 20;
    return { page, limit, skip: (page - 1) * limit };
  }

  private metaOf(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  private async getProfileOr404(id: string): Promise<VictimProfile> {
    const profile = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!profile) throw new NotFoundException('victim_profile_not_found');
    return profile;
  }

  private async assertProfileExists(id: string): Promise<void> {
    const found = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('victim_profile_not_found');
  }

  // 404 (not 403) for somebody else's profile so ids can't be probed.
  private async getMineOr404(user: CurrentUserDto, id: string): Promise<VictimProfile> {
    const profile = await this.prisma.victimProfile.findFirst({
      where: { id, createdByUserId: user.id, deletedAt: null },
    });
    if (!profile) throw new NotFoundException('victim_profile_not_found');
    return profile;
  }

  // Success-path audit helper for the new methods (failures keep using emitProfileFailure()).
  private auditSuccess(
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
  private logAdminView(admin: CurrentUserDto, profile: ProfileAuditRef, section: string): void {
    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_ADMIN_VIEWED, profile, {
      metadata: { section },
    });
  }

  private publicWhere(): Prisma.VictimProfileWhereInput {
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

  private async assertPublishedProfile(id: string) {
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

  private findMediaField(profile: MediaBearing, key: string): MediaFieldName | null {
    return MEDIA_FIELD_NAMES.find((field) => profile[field].includes(key)) ?? null;
  }

  // G12 — shared by the new creator write path (the admin bank-details path already has its own check).
  private assertAccountHolder(involvesChild: boolean, relationship: string | undefined): void {
    if (involvesChild && relationship === 'SELF') {
      throw new BadRequestException('account_holder_cannot_be_the_child');
    }
  }

  // Same media bookkeeping update() does, extracted so the creator path can reuse it.
  private async computeMediaChange(profile: VictimProfile, data: MediaBearingDto) {
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

    return { added, removed, newTotalBytes };
  }

  // A profile is "unseen" for its creator when staff did something visible after the creator last looked.
  // Derived from the audit trail so it also works for the existing publish/reject/... methods.
  private async findUnseenProfileIds(
    creatorId: string,
    profiles: Array<Pick<VictimProfile, 'id' | 'createdAt' | 'creatorSeenAt'>>,
  ): Promise<Set<string>> {
    const unseen = new Set<string>();
    if (!profiles.length) return unseen;

    const byId = new Map(profiles.map((p) => [p.id, p]));
    for (const ids of chunk([...byId.keys()], 500)) {
      const rows = await this.prisma.auditLog.groupBy({
        by: ['entityId'],
        where: {
          entity: 'VictimProfile',
          entityId: { in: ids },
          outcome: AuditOutcome.SUCCESS,
          action: { in: CREATOR_VISIBLE_STAFF_ACTIONS },
          userId: { not: creatorId },
        },
        _max: { createdAt: true },
        orderBy: { entityId: 'asc' },
      });
      for (const row of rows) {
        const p = row.entityId ? byId.get(row.entityId) : undefined;
        const last = row._max.createdAt;
        if (p && last && last > (p.creatorSeenAt ?? p.createdAt)) unseen.add(p.id);
      }
    }
    return unseen;
  }

  private serializeMine(p: VictimProfile, unseen: boolean) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      story: p.story,
      supportType: p.supportType,
      supportGoal: p.supportGoal ? money(p.supportGoal) : null,
      photo: p.photo,
      video: p.video,
      audio: p.audio,
      pdf: p.pdf,
      document: p.document,
      other: p.other,
      involvesChild: p.involvesChild,
      status: p.status,
      isPublished: p.isPublished,
      totalRaised: money(p.totalRaised),
      donationsPaused: p.donationsPaused,
      // Creators never get the full account number back, only a masked tail.
      bank: {
        accountName: p.bankAccountName,
        bankName: p.bankName,
        accountNumberMasked: maskAccount(p.bankAccountNumber),
      },
      reviewNote: p.reviewNote,
      reviewNoteAt: p.reviewNoteAt,
      hasUnseenUpdate: unseen,
      canEdit: CREATOR_EDITABLE_STATUSES.includes(p.status),
      canWithdraw: CREATOR_WITHDRAWABLE_STATUSES.includes(p.status) && !p.isPublished,
      canResubmit: CREATOR_RESUBMITTABLE_STATUSES.includes(p.status),
      canAppeal: p.status === VictimProfileStatus.REJECTED,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  // VP-01
  async findMine(user: CurrentUserDto, query: FindAllVictimProfilesQueryDto) {
    const { page, limit, skip } = this.pageOf(query);
    const where: Prisma.VictimProfileWhereInput = {
      createdByUserId: user.id,
      deletedAt: null,
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    const unseen = await this.findUnseenProfileIds(user.id, rows);

    return {
      data: rows.map((row) => this.serializeMine(row, unseen.has(row.id))),
      meta: this.metaOf(page, limit, total),
    };
  }

  // VP-02
  async findOneMine(user: CurrentUserDto, id: string) {
    const profile = await this.getMineOr404(user, id);

    const [unseen, latestAppeal] = await Promise.all([
      this.findUnseenProfileIds(user.id, [profile]),
      this.prisma.victimProfileAppeal.findFirst({
        where: { profileId: id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          message: true,
          decisionNote: true,
          decidedAt: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      ...this.serializeMine(profile, unseen.has(id)),
      // The text of the open change request, surfaced separately so a client can render it as a to-do.
      requestedChanges:
        profile.status === VictimProfileStatus.CHANGES_REQUESTED ? profile.reviewNote : null,
      appeal: latestAppeal,
    };
  }

  // VP-03
  async getMineSummary(user: CurrentUserDto) {
    const grouped = await this.prisma.victimProfile.groupBy({
      by: ['status'],
      where: { createdByUserId: user.id, deletedAt: null },
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });

    const counts = Object.fromEntries(
      Object.values(VictimProfileStatus).map((status) => [status, 0]),
    ) as Record<VictimProfileStatus, number>;
    for (const row of grouped) counts[row.status] = row._count._all;

    const { count: unseenCount } = await this.countMineUnreadUpdates(user);

    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      byStatus: counts,
      unseenUpdates: unseenCount,
    };
  }

  // VP-04
  async updateMine(user: CurrentUserDto, id: string, data: UpdateVictimProfileDto) {
    const profile = await this.getMineOr404(user, id);

    if (!CREATOR_EDITABLE_STATUSES.includes(profile.status)) {
      this.emitProfileFailure(
        user,
        AuditEventEnum.VICTIM_PROFILE_UPDATED,
        profile,
        'victim_profile_not_editable',
        {
          outcome: AuditOutcome.DENIED,
          diff: { currentStatus: profile.status },
        },
      );
      throw new BadRequestException('victim_profile_not_editable');
    }

    // Lowering the child flag skips child-safety review and un-hides photos; that is the
    // dual-admin PATCH admin/:id/child-flag path (VP-64), never a creator edit.
    if (profile.involvesChild && data.involvesChild === false) {
      this.emitProfileFailure(
        user,
        AuditEventEnum.VICTIM_PROFILE_UPDATED,
        profile,
        'child_flag_change_requires_admin',
        {
          outcome: AuditOutcome.DENIED,
        },
      );
      throw new ForbiddenException('child_flag_change_requires_admin');
    }

    this.assertAccountHolder(
      profile.involvesChild || data.involvesChild === true,
      data.accountHolderRelationship,
    );

    let media: Awaited<ReturnType<VictimProfileService['computeMediaChange']>>;
    try {
      media = await this.computeMediaChange(profile, data);
    } catch (err) {
      this.emitProfileFailure(
        user,
        AuditEventEnum.VICTIM_PROFILE_UPDATED,
        profile,
        'media_validation_failed',
        {
          diff: { message: err instanceof Error ? err.message : String(err) },
        },
      );
      throw err;
    }

    const fieldsUpdated = UPDATABLE_FIELD_NAMES.filter((field) => data[field] !== undefined);

    // Status is left as-is (PENDING / REJECTED / CHANGES_REQUESTED); PATCH mine/:id/resubmit moves it on.
    // Every approval gate is reset exactly like the admin update() does, because the content changed.
    const updated = await this.conditionalUpdate(
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
        mediaTotalBytes: media.newTotalBytes,

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
      { admin: user, action: AuditEventEnum.VICTIM_PROFILE_UPDATED, profile },
    );

    await this.deleteMediaFiles(media.removed);
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(user, AuditEventEnum.VICTIM_PROFILE_UPDATED, updated, {
      diff: { previousStatus: profile.status, newStatus: updated.status },
      metadata: {
        actor: 'creator',
        fieldsUpdated,
        mediaAdded: media.added.length,
        mediaRemoved: media.removed.length,
        mediaTotalBytes: media.newTotalBytes,
      },
    });

    return this.serializeMine(updated, false);
  }

  // VP-05
  async withdrawMine(user: CurrentUserDto, id: string) {
    const profile = await this.getMineOr404(user, id);

    if (profile.isPublished || !CREATOR_WITHDRAWABLE_STATUSES.includes(profile.status)) {
      this.emitProfileFailure(
        user,
        AuditEventEnum.VICTIM_PROFILE_WITHDRAWN,
        profile,
        'victim_profile_not_withdrawable',
        {
          outcome: AuditOutcome.DENIED,
          diff: { currentStatus: profile.status },
        },
      );
      throw new BadRequestException('victim_profile_not_withdrawable');
    }

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        status: VictimProfileStatus.WITHDRAWN,
        isPublished: false,
        isAdminApproved: false,
        claimedByUserId: null,
        claimedAt: null,
      },
      { admin: user, action: AuditEventEnum.VICTIM_PROFILE_WITHDRAWN, profile },
    );

    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(user, AuditEventEnum.VICTIM_PROFILE_WITHDRAWN, updated, {
      diff: { previousStatus: profile.status, newStatus: VictimProfileStatus.WITHDRAWN },
      metadata: { releasedClaimOf: profile.claimedByUserId },
    });

    return this.serializeMine(updated, false);
  }

  // VP-06
  async resubmitMine(user: CurrentUserDto, id: string) {
    const profile = await this.getMineOr404(user, id);

    if (!CREATOR_RESUBMITTABLE_STATUSES.includes(profile.status)) {
      this.emitProfileFailure(
        user,
        AuditEventEnum.VICTIM_PROFILE_RESUBMITTED,
        profile,
        'victim_profile_not_resubmittable',
        {
          outcome: AuditOutcome.DENIED,
          diff: { currentStatus: profile.status },
        },
      );
      throw new BadRequestException('victim_profile_not_resubmittable');
    }

    // An open appeal and a resubmission would race each other for the same decision.
    const openAppeal = await this.prisma.victimProfileAppeal.findFirst({
      where: { profileId: id, status: VictimProfileAppealStatus.OPEN },
      select: { id: true },
    });
    if (openAppeal) {
      throw new ConflictException('appeal_open_resolve_before_resubmitting');
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

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      { status, isPublished: false, reviewNote: null, reviewNoteAt: null },
      { admin: user, action: AuditEventEnum.VICTIM_PROFILE_RESUBMITTED, profile },
    );

    // Back to every admin's unread queue.
    await this.prisma.victimProfileReadState.deleteMany({ where: { profileId: id } });
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(user, AuditEventEnum.VICTIM_PROFILE_RESUBMITTED, updated, {
      diff: { previousStatus: profile.status, newStatus: status },
      metadata: { actor: 'creator' },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_RESUBMITTED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      status,
      actorId: user.id,
    });

    return this.serializeMine(updated, false);
  }

  // VP-07
  async getMineMediaDownloadUrl(
    user: CurrentUserDto,
    id: string,
    query: { key: string },
  ): Promise<{ url: string }> {
    const profile = await this.getMineOr404(user, id);

    if (!this.collectMediaFields(profile).includes(query.key)) {
      this.emitProfileFailure(
        user,
        AuditEventEnum.VICTIM_PROFILE_MEDIA_DOWNLOADED,
        profile,
        'media_not_found_on_profile',
        {
          outcome: AuditOutcome.DENIED,
          metadata: { requestedKey: query.key },
        },
      );
      throw new NotFoundException('media_not_found_on_profile');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(query.key);

    this.auditSuccess(user, AuditEventEnum.VICTIM_PROFILE_MEDIA_DOWNLOADED, profile, {
      metadata: { key: query.key, actor: 'creator' },
    });

    return { url };
  }

  // VP-08
  async removeMineMedia(user: CurrentUserDto, id: string, key: string) {
    const profile = await this.getMineOr404(user, id);

    if (!CREATOR_EDITABLE_STATUSES.includes(profile.status)) {
      throw new BadRequestException('victim_profile_not_editable');
    }

    const field = this.findMediaField(profile, key);
    if (!field) throw new NotFoundException('media_not_found_on_profile');

    const stat = await this.minioService.statObject(key).catch(() => null);
    const size = stat?.size ?? 0;

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        [field]: profile[field].filter((k) => k !== key),
        mediaTotalBytes: Math.max(0, profile.mediaTotalBytes - size),
      } as Prisma.VictimProfileUncheckedUpdateManyInput,
      { admin: user, action: AuditEventEnum.VICTIM_PROFILE_MEDIA_REMOVED, profile },
    );

    await this.deleteMediaFiles([key]);
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(user, AuditEventEnum.VICTIM_PROFILE_MEDIA_REMOVED, updated, {
      metadata: { key, field, actor: 'creator', bytesFreed: size },
    });

    return { message: 'media_removed', id, key };
  }

  // VP-09
  async getMineTimeline(user: CurrentUserDto, id: string) {
    await this.getMineOr404(user, id);

    const rows = await this.prisma.auditLog.findMany({
      where: {
        entity: 'VictimProfile',
        entityId: id,
        outcome: AuditOutcome.SUCCESS,
        action: { in: CREATOR_TIMELINE_ACTIONS },
      },
      orderBy: { createdAt: 'asc' },
      select: { action: true, createdAt: true, userId: true, diff: true },
    });

    // No actor identity, no internal reason: only what happened, when, the resulting status and
    // (only where we wrote one for the creator) the message addressed to them.
    return rows.map((row) => {
      const diff = (row.diff ?? {}) as Record<string, unknown>;
      return {
        event: row.action,
        at: row.createdAt,
        byStaff: row.userId !== user.id,
        status: typeof diff.newStatus === 'string' ? diff.newStatus : undefined,
        message: typeof diff.creatorMessage === 'string' ? diff.creatorMessage : undefined,
      };
    });
  }

  // VP-10
  async getMineFunding(user: CurrentUserDto, id: string) {
    const profile = await this.getMineOr404(user, id);

    const [supporterCount, paidOut] = await Promise.all([
      this.prisma.support.count({
        where: {
          victimProfileId: id,
          type: 'FINANCIAL',
          status: { in: [...CONFIRMED_SUPPORT_STATUSES] },
        },
      }),
      this.prisma.disbursement.aggregate({
        where: {
          status: 'PAID_OUT',
          allocation: {
            partyType: 'RECIPIENT',
            payment: { victimProfileId: id, type: 'SUPPORT' },
          },
        },
        _sum: { amount: true },
      }),
    ]);

    const raised = new Prisma.Decimal(profile.totalRaised);
    const paid = new Prisma.Decimal(paidOut._sum.amount ?? 0);
    const awaiting = Prisma.Decimal.max(raised.sub(paid), 0);

    // Deliberately no donor names, ids or per-donation rows.
    return {
      currency: 'ETB',
      supportGoal: profile.supportGoal ? money(profile.supportGoal) : null,
      totalRaised: money(raised),
      paidOut: money(paid),
      awaitingPayout: money(awaiting),
      supporterCount,
      donationsPaused: profile.donationsPaused,
    };
  }

  // VP-11
  async createMineUpdate(user: CurrentUserDto, id: string, data: CreateProfileUpdateDto) {
    const profile = await this.getMineOr404(user, id);

    if (
      profile.takedownAt ||
      (profile.status !== VictimProfileStatus.PUBLISHED &&
        profile.status !== VictimProfileStatus.COMPLETED)
    ) {
      throw new BadRequestException('updates_require_a_published_profile');
    }

    const maxPerDay = Number(this.configService.get<string>('PROFILE_MAX_UPDATES_PER_DAY') ?? 10);
    const recent = await this.prisma.victimProfileUpdate.count({
      where: {
        profileId: id,
        isStaff: false,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (recent >= maxPerDay) {
      throw new BadRequestException('too_many_updates_today');
    }

    const update = await this.prisma.victimProfileUpdate.create({
      data: {
        profileId: id,
        authorId: user.id,
        isStaff: false,
        title: data.title,
        body: data.body,
      },
    });

    this.auditSuccess(user, AuditEventEnum.VICTIM_PROFILE_UPDATE_POSTED, profile, {
      metadata: { updateId: update.id, actor: 'creator' },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_UPDATE_POSTED, {
      victimProfileId: id,
      updateId: update.id,
      actorId: user.id,
    });

    return update;
  }

  // VP-12
  async countMineUnreadUpdates(user: CurrentUserDto): Promise<{ count: number }> {
    const profiles = await this.prisma.victimProfile.findMany({
      where: { createdByUserId: user.id, deletedAt: null },
      select: { id: true, createdAt: true, creatorSeenAt: true },
      take: 1000,
    });
    const unseen = await this.findUnseenProfileIds(user.id, profiles);
    return { count: unseen.size };
  }

  // VP-13  (raw SQL on purpose: a "seen" marker must not bump updatedAt, which conditionalUpdate() uses as its version)
  async markMineSeen(user: CurrentUserDto, id: string) {
    await this.getMineOr404(user, id);
    await this.prisma.$executeRaw`
      UPDATE "victim_profile" SET "creatorSeenAt" = NOW()
      WHERE "id" = ${id} AND "createdByUserId" = ${user.id}`;
    return { id, seen: true };
  }

  // VP-14
  async markAllMineSeen(user: CurrentUserDto) {
    const updated = await this.prisma.$executeRaw`
      UPDATE "victim_profile" SET "creatorSeenAt" = NOW()
      WHERE "createdByUserId" = ${user.id} AND "deletedAt" IS NULL`;
    return { updated };
  }

  // VP-48
  async createAppeal(user: CurrentUserDto, id: string, data: CreateAppealDto) {
    const profile = await this.getMineOr404(user, id);

    if (profile.status !== VictimProfileStatus.REJECTED) {
      throw new BadRequestException('only_rejected_profiles_can_be_appealed');
    }

    const open = await this.prisma.victimProfileAppeal.findFirst({
      where: { profileId: id, status: VictimProfileAppealStatus.OPEN },
      select: { id: true },
    });
    if (open) throw new ConflictException('appeal_already_open');

    const maxAppeals = Number(this.configService.get<string>('PROFILE_MAX_APPEALS') ?? 2);
    const previous = await this.prisma.victimProfileAppeal.count({ where: { profileId: id } });
    if (previous >= maxAppeals) throw new BadRequestException('appeal_limit_reached');

    const appeal = await this.prisma.victimProfileAppeal.create({
      data: { profileId: id, authorId: user.id, message: data.message },
    });

    this.auditSuccess(user, AuditEventEnum.VICTIM_PROFILE_APPEAL_CREATED, profile, {
      metadata: { appealId: appeal.id, appealNumber: previous + 1 },
    });

    return appeal;
  }

  // VP-15
  async findPublicUpdates(_user: CurrentUserDto, id: string, query: PagedQueryDto) {
    await this.assertPublishedProfile(id);
    const { page, limit, skip } = this.pageOf(query);
    const where: Prisma.VictimProfileUpdateWhereInput = { profileId: id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfileUpdate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { id: true, title: true, body: true, isStaff: true, createdAt: true },
      }),
      this.prisma.victimProfileUpdate.count({ where }),
    ]);

    return { data: rows, meta: this.metaOf(page, limit, total) };
  }

  // VP-16
  async findPublicSupporters(_user: CurrentUserDto, id: string, query: PagedQueryDto) {
    await this.assertPublishedProfile(id);
    const { page, limit, skip } = this.pageOf(query);
    const where: Prisma.SupportWhereInput = {
      victimProfileId: id,
      status: { in: [...CONFIRMED_SUPPORT_STATUSES] },
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.support.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          type: true,
          anonymous: true,
          message: true,
          amount: true,
          categories: true,
          createdAt: true,
          user: { select: { name: true } },
        },
      }),
      this.prisma.support.count({ where }),
    ]);

    // Anonymity is the default and wins: no name, no amount, no message for anonymous supporters.
    return {
      data: rows.map((s) => ({
        id: s.id,
        type: s.type,
        anonymous: s.anonymous,
        name: s.anonymous ? null : (s.user?.name ?? null),
        amount: !s.anonymous && s.type === 'FINANCIAL' ? money(s.amount) : null,
        categories: s.categories,
        message: s.anonymous ? null : s.message,
        createdAt: s.createdAt,
      })),
      meta: this.metaOf(page, limit, total),
    };
  }

  // VP-17
  async flagProfile(user: CurrentUserDto, id: string, data: FlagVictimProfileDto) {
    const profile = await this.assertPublishedProfile(id);

    if (profile.createdByUserId === user.id) {
      throw new BadRequestException('cannot_flag_your_own_profile');
    }

    const existing = await this.prisma.victimProfileFlag.findUnique({
      where: { profileId_reporterId: { profileId: id, reporterId: user.id } },
      select: { id: true },
    });
    if (existing) throw new ConflictException('profile_already_flagged_by_you');

    let flag;
    try {
      flag = await this.prisma.victimProfileFlag.create({
        data: { profileId: id, reporterId: user.id, reason: data.reason, details: data.details },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('profile_already_flagged_by_you');
      }
      throw err;
    }

    this.auditSuccess(
      user,
      AuditEventEnum.VICTIM_PROFILE_FLAGGED,
      { ...profile, createdByUserId: profile.createdByUserId },
      {
        severity:
          data.reason === FlagReason.IDENTIFIES_CHILD
            ? AuditSeverity.CRITICAL
            : AuditSeverity.WARNING,
        diff: { reason: data.reason },
        metadata: { flagId: flag.id },
      },
    );

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_FLAGGED, {
      victimProfileId: id,
      flagId: flag.id,
      reason: data.reason,
    });

    return { id: flag.id, status: flag.status, createdAt: flag.createdAt };
  }

  // VP-18
  async searchPublic(_user: CurrentUserDto, query: PublicSearchQueryDto) {
    const { page, limit, skip } = this.pageOf(query);
    const where: Prisma.VictimProfileWhereInput = {
      ...this.publicWhere(),
      OR: [
        { name: { contains: query.q, mode: 'insensitive' } },
        { story: { contains: query.q, mode: 'insensitive' } },
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        select: PUBLIC_PROFILE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.serializePublicProfile(row)),
      meta: this.metaOf(page, limit, total),
    };
  }

  // VP-19
  async findFeaturedPublic(_user: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.pageOf(query);
    const where: Prisma.VictimProfileWhereInput = { ...this.publicWhere(), isFeatured: true };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        select: PUBLIC_PROFILE_SELECT,
        orderBy: { featuredAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.serializePublicProfile(row)),
      meta: this.metaOf(page, limit, total),
    };
  }

  // VP-20
  async getShareInfo(_user: CurrentUserDto, id: string) {
    const profile = await this.assertPublishedProfile(id);

    const base = (
      this.configService.get<string>('app.publicUrl') ??
      this.configService.get<string>('FRONTEND_URL') ??
      ''
    ).replace(/\/+$/, '');
    const scheme = this.configService.get<string>('APP_DEEP_LINK_SCHEME') ?? 'ehte';

    // Child profiles never put a name in share text.
    const text = profile.involvesChild
      ? 'A child needs our help. Please read their story and support if you can.'
      : `Please read ${profile.name ? `${profile.name}'s` : 'this'} story and support if you can.`;

    return {
      id,
      text,
      url: `${base}/victim-profiles/${id}`,
      deepLink: `${scheme}://victim-profiles/${id}`,
    };
  }

  // VP-21
  async recordView(user: CurrentUserDto, id: string) {
    await this.assertPublishedProfile(id);

    // One view per user per profile per hour, so refreshes don't inflate the numbers.
    const recent = await this.prisma.victimProfileView.findFirst({
      where: {
        profileId: id,
        userId: user.id,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
      select: { id: true },
    });
    if (recent) return { recorded: false };

    await this.prisma.victimProfileView.create({ data: { profileId: id, userId: user.id } });
    return { recorded: true };
  }

  // VP-22  (POST toggles: there is no separate unfollow route in the controller)
  async followProfile(user: CurrentUserDto, id: string) {
    await this.assertPublishedProfile(id);

    const key = { profileId_userId: { profileId: id, userId: user.id } };
    const existing = await this.prisma.victimProfileFollow.findUnique({ where: key });

    if (existing) {
      await this.prisma.victimProfileFollow.delete({ where: key });
      return { id, following: false };
    }

    await this.prisma.victimProfileFollow.create({ data: { profileId: id, userId: user.id } });
    return { id, following: true };
  }

  // VP-23
  async getPublicGoal(_user: CurrentUserDto, id: string) {
    const profile = await this.assertPublishedProfile(id);

    const raised = new Prisma.Decimal(profile.totalRaised);
    const goal = profile.supportGoal ? new Prisma.Decimal(profile.supportGoal) : null;
    const percent =
      goal && goal.gt(0) ? Math.min(100, Math.round(raised.div(goal).mul(100).toNumber())) : null;
    const daysLeft = profile.fundingEndsAt
      ? Math.max(0, Math.ceil((profile.fundingEndsAt.getTime() - Date.now()) / 86_400_000))
      : null;

    return {
      id,
      goal: goal ? money(goal) : null,
      raised: money(raised),
      percent,
      daysLeft,
      donationsPaused: profile.donationsPaused,
    };
  }

  // VP-24
  async findMySupported(user: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.pageOf(query);
    const supportFilter = {
      userId: user.id,
      status: { in: [...CONFIRMED_SUPPORT_STATUSES] },
    } satisfies Prisma.SupportWhereInput;
    const where: Prisma.VictimProfileWhereInput = {
      ...this.publicWhere(),
      supports: { some: supportFilter },
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        select: PUBLIC_PROFILE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    const mine = await this.prisma.support.groupBy({
      by: ['victimProfileId'],
      where: { ...supportFilter, victimProfileId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
      orderBy: { victimProfileId: 'asc' },
    });
    const counts = new Map(mine.map((m) => [m.victimProfileId, m._count._all]));

    return {
      data: rows.map((row) => ({
        ...this.serializePublicProfile(row),
        mySupportCount: counts.get(row.id) ?? 0,
      })),
      meta: this.metaOf(page, limit, total),
    };
  }

  private unreadWhere(
    admin: CurrentUserDto,
    extra: Prisma.VictimProfileWhereInput = {},
  ): Prisma.VictimProfileWhereInput {
    return { deletedAt: null, readStates: { none: { adminId: admin.id } }, ...extra };
  }

  // VP-25
  async markRead(admin: CurrentUserDto, id: string) {
    await this.assertProfileExists(id);
    await this.prisma.victimProfileReadState.upsert({
      where: { profileId_adminId: { profileId: id, adminId: admin.id } },
      create: { profileId: id, adminId: admin.id },
      update: {},
    });
    return { id, isRead: true };
  }

  // VP-26
  async markUnread(admin: CurrentUserDto, id: string) {
    await this.assertProfileExists(id);
    await this.prisma.victimProfileReadState.deleteMany({
      where: { profileId: id, adminId: admin.id },
    });
    return { id, isRead: false };
  }

  // VP-27
  async bulkMarkRead(admin: CurrentUserDto, data: BulkIdsDto) {
    const ids = [...new Set(data.ids)];
    const found = await this.prisma.victimProfile.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const foundIds = found.map((f) => f.id);

    await this.prisma.victimProfileReadState.createMany({
      data: foundIds.map((profileId) => ({ profileId, adminId: admin.id })),
      skipDuplicates: true,
    });

    return {
      requested: ids.length,
      updated: foundIds.length,
      missing: ids.filter((i) => !foundIds.includes(i)),
    };
  }

  // VP-28
  async bulkMarkUnread(admin: CurrentUserDto, data: BulkIdsDto) {
    const ids = [...new Set(data.ids)];
    const result = await this.prisma.victimProfileReadState.deleteMany({
      where: { adminId: admin.id, profileId: { in: ids } },
    });
    return { requested: ids.length, updated: result.count };
  }

  // VP-29
  async markAllRead(admin: CurrentUserDto, data: ReadAllDto) {
    const unread = await this.prisma.victimProfile.findMany({
      where: this.unreadWhere(admin, data.status !== undefined ? { status: data.status } : {}),
      select: { id: true },
      take: 50_000,
    });

    let updated = 0;
    for (const ids of chunk(
      unread.map((u) => u.id),
      1000,
    )) {
      const res = await this.prisma.victimProfileReadState.createMany({
        data: ids.map((profileId) => ({ profileId, adminId: admin.id })),
        skipDuplicates: true,
      });
      updated += res.count;
    }
    return { updated };
  }

  // VP-30
  async findUnread(admin: CurrentUserDto, query: FindUnreadVictimProfilesQueryDto) {
    const { page, limit, skip } = this.pageOf(query);
    const where = this.unreadWhere(
      admin,
      query.status !== undefined ? { status: query.status } : {},
    );

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({ ...stripBank(row), isRead: false })),
      meta: this.metaOf(page, limit, total),
    };
  }

  // VP-31
  async countUnread(admin: CurrentUserDto) {
    return { unread: await this.prisma.victimProfile.count({ where: this.unreadWhere(admin) }) };
  }

  // VP-32
  async countUnreadByStatus(admin: CurrentUserDto) {
    const grouped = await this.prisma.victimProfile.groupBy({
      by: ['status'],
      where: this.unreadWhere(admin),
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });
    const counts = Object.fromEntries(
      Object.values(VictimProfileStatus).map((s) => [s, 0]),
    ) as Record<VictimProfileStatus, number>;
    for (const row of grouped) counts[row.status] = row._count._all;
    return counts;
  }

  // VP-33  ("need category" = supportType; swap the groupBy field if you later add a dedicated column)
  async countUnreadByCategory(admin: CurrentUserDto) {
    const grouped = await this.prisma.victimProfile.groupBy({
      by: ['supportType'],
      where: this.unreadWhere(admin),
      _count: { _all: true },
      orderBy: { supportType: 'asc' },
    });
    const counts: Record<string, number> = {};
    for (const t of Object.values(SupportType)) counts[t] = 0;
    for (const row of grouped) counts[row.supportType ?? 'UNSPECIFIED'] = row._count._all;
    return counts;
  }

  // VP-34
  async getReadCounts(admin: CurrentUserDto) {
    const [total, read] = await Promise.all([
      this.prisma.victimProfile.count({ where: { deletedAt: null } }),
      this.prisma.victimProfile.count({
        where: { deletedAt: null, readStates: { some: { adminId: admin.id } } },
      }),
    ]);
    return { total, read, unread: Math.max(0, total - read) };
  }

  private async creatorNames(ids: string[]): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  // VP-35
  async findCreatorsSummary(admin: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.pageOf(query);

    const groups = await this.prisma.victimProfile.groupBy({
      by: ['createdByUserId'],
      where: { createdByUserId: { not: null }, deletedAt: null },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    });
    const pageGroups = groups.slice(skip, skip + limit);
    const creatorIds = pageGroups.map((g) => g.createdByUserId as string);

    const [reads, names] = await Promise.all([
      this.prisma.victimProfileReadState.findMany({
        where: {
          adminId: admin.id,
          profile: { createdByUserId: { in: creatorIds }, deletedAt: null },
        },
        select: { profile: { select: { createdByUserId: true } } },
      }),
      this.creatorNames(creatorIds),
    ]);
    const readByCreator = new Map<string, number>();
    for (const r of reads) {
      const c = r.profile.createdByUserId;
      if (c) readByCreator.set(c, (readByCreator.get(c) ?? 0) + 1);
    }

    return {
      data: pageGroups.map((g) => {
        const creatorId = g.createdByUserId as string;
        const read = readByCreator.get(creatorId) ?? 0;
        return {
          creatorId,
          creatorName: names.get(creatorId) ?? null,
          total: g._count.id,
          read,
          unread: Math.max(0, g._count.id - read),
        };
      }),
      meta: this.metaOf(page, limit, groups.length),
    };
  }

  // VP-36
  async findByCreator(
    admin: CurrentUserDto,
    creatorId: string,
    query: FindAllVictimProfilesQueryDto,
  ) {
    const { page, limit, skip } = this.pageOf(query);
    const where: Prisma.VictimProfileWhereInput = {
      createdByUserId: creatorId,
      deletedAt: null,
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        include: { readStates: { where: { adminId: admin.id }, select: { readAt: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: rows.map(({ readStates, ...row }) => ({
        ...stripBank(row),
        isRead: readStates.length > 0,
      })),
      meta: this.metaOf(page, limit, total),
    };
  }

  // VP-37
  async getCreatorSummary(admin: CurrentUserDto, creatorId: string) {
    const where: Prisma.VictimProfileWhereInput = { createdByUserId: creatorId, deletedAt: null };

    const [grouped, read, names] = await Promise.all([
      this.prisma.victimProfile.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.victimProfile.count({
        where: { ...where, readStates: { some: { adminId: admin.id } } },
      }),
      this.creatorNames([creatorId]),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(VictimProfileStatus).map((s) => [s, 0]),
    ) as Record<VictimProfileStatus, number>;
    for (const row of grouped) byStatus[row.status] = row._count._all;
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

    return {
      creatorId,
      creatorName: names.get(creatorId) ?? null,
      total,
      read,
      unread: Math.max(0, total - read),
      byStatus,
    };
  }

  // VP-38
  async markCreatorRead(admin: CurrentUserDto, creatorId: string) {
    const profiles = await this.prisma.victimProfile.findMany({
      where: { createdByUserId: creatorId, deletedAt: null },
      select: { id: true },
    });
    const res = await this.prisma.victimProfileReadState.createMany({
      data: profiles.map((p) => ({ profileId: p.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    return { creatorId, updated: res.count };
  }

  // VP-39
  async markCreatorUnread(admin: CurrentUserDto, creatorId: string) {
    const res = await this.prisma.victimProfileReadState.deleteMany({
      where: { adminId: admin.id, profile: { createdByUserId: creatorId } },
    });
    return { creatorId, updated: res.count };
  }

  // VP-40
  async findRepeatRejectionCreators(_admin: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.pageOf(query);
    const threshold = Number(
      this.configService.get<string>('PROFILE_REPEAT_REJECTION_THRESHOLD') ?? 2,
    );

    const [rejected, fraudFlags] = await Promise.all([
      this.prisma.victimProfile.groupBy({
        by: ['createdByUserId'],
        where: {
          status: VictimProfileStatus.REJECTED,
          createdByUserId: { not: null },
          deletedAt: null,
        },
        _count: { id: true },
        having: { id: { _count: { gte: threshold } } },
        orderBy: { _count: { id: 'desc' } },
      }),
      // "Suspected fraud" = a reader flagged it as false information and staff actioned the flag.
      this.prisma.victimProfileFlag.findMany({
        where: {
          reason: FlagReason.FALSE_INFORMATION,
          status: VictimProfileFlagStatus.ACTIONED,
          profile: { createdByUserId: { not: null } },
        },
        select: { profile: { select: { createdByUserId: true } } },
      }),
    ]);

    const stats = new Map<string, { rejectedCount: number; confirmedFalseInfoFlags: number }>();
    const bump = (id: string) => {
      const cur = stats.get(id) ?? { rejectedCount: 0, confirmedFalseInfoFlags: 0 };
      stats.set(id, cur);
      return cur;
    };
    for (const r of rejected) bump(r.createdByUserId as string).rejectedCount = r._count.id;
    for (const f of fraudFlags) {
      const c = f.profile.createdByUserId;
      if (c) bump(c).confirmedFalseInfoFlags += 1;
    }

    const rows = [...stats.entries()]
      .map(([creatorId, s]) => ({ creatorId, ...s, suspectedFraud: s.confirmedFalseInfoFlags > 0 }))
      .sort(
        (a, b) =>
          b.rejectedCount +
          b.confirmedFalseInfoFlags * 2 -
          (a.rejectedCount + a.confirmedFalseInfoFlags * 2),
      );

    const pageRows = rows.slice(skip, skip + limit);
    const names = await this.creatorNames(pageRows.map((r) => r.creatorId));

    return {
      data: pageRows.map((r) => ({ ...r, creatorName: names.get(r.creatorId) ?? null })),
      meta: this.metaOf(page, limit, rows.length),
    };
  }

  // VP-41
  async findFlags(_admin: CurrentUserDto, query: FindFlagsQueryDto) {
    const { page, limit, skip } = this.pageOf(query);
    const where: Prisma.VictimProfileFlagWhereInput = {
      ...(query.status ? { status: this.toFlagStatus(query.status) } : {}),
      ...(query.reason ? { reason: query.reason } : {}),
      ...(query.profileId ? { profileId: query.profileId } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfileFlag.findMany({
        where,
        include: {
          profile: { select: { id: true, name: true, involvesChild: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfileFlag.count({ where }),
    ]);

    return {
      data: rows.map(({ profile, ...flag }) => ({
        ...flag,
        profile: { id: profile.id, label: this.profileLabel(profile), status: profile.status },
      })),
      meta: this.metaOf(page, limit, total),
    };
  }

  // The DTO's FlagStatus has RESOLVED; the table splits that into DISMISSED / ACTIONED.
  private toFlagStatus(
    status: string,
  ): VictimProfileFlagStatus | { in: VictimProfileFlagStatus[] } {
    if (status === 'RESOLVED') {
      return { in: [VictimProfileFlagStatus.DISMISSED, VictimProfileFlagStatus.ACTIONED] };
    }
    return status as VictimProfileFlagStatus;
  }

  // VP-43
  async findFlagsForProfile(admin: CurrentUserDto, id: string, query: PagedQueryDto) {
    const profile = await this.getProfileOr404(id);
    const { page, limit, skip } = this.pageOf(query);
    const where: Prisma.VictimProfileFlagWhereInput = { profileId: id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfileFlag.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfileFlag.count({ where }),
    ]);

    this.logAdminView(admin, profile, 'flags');
    return { data: rows, meta: this.metaOf(page, limit, total) };
  }

  // VP-42
  async resolveFlag(admin: CurrentUserDto, flagId: string, data: ResolveFlagDto) {
    const flag = await this.prisma.victimProfileFlag.findUnique({ where: { id: flagId } });
    if (!flag) throw new NotFoundException('victim_profile_flag_not_found');
    if (flag.status !== VictimProfileFlagStatus.OPEN) {
      throw new ConflictException('victim_profile_flag_already_resolved');
    }

    const profile = await this.getProfileOr404(flag.profileId);

    // Claim the flag first (open -> resolved) so two admins can't both act on it.
    const status =
      data.resolution === FlagResolution.DISMISS
        ? VictimProfileFlagStatus.DISMISSED
        : VictimProfileFlagStatus.ACTIONED;
    const claimed = await this.prisma.victimProfileFlag.updateMany({
      where: { id: flagId, status: VictimProfileFlagStatus.OPEN },
      data: {
        status,
        resolution: data.resolution,
        resolvedById: admin.id,
        resolvedAt: new Date(),
        note: data.reason,
      },
    });
    if (claimed.count === 0) throw new ConflictException('victim_profile_flag_already_resolved');

    try {
      if (data.resolution === FlagResolution.UNPUBLISH && profile.isPublished) {
        await this.unpublish(admin, profile.id);
      } else if (data.resolution === FlagResolution.PAUSE_DONATIONS && !profile.donationsPaused) {
        await this.pauseDonations(admin, profile.id, { reason: data.reason });
      }
    } catch (err) {
      // The action failed, so put the flag back in the queue rather than losing it.
      await this.prisma.victimProfileFlag.update({
        where: { id: flagId },
        data: {
          status: VictimProfileFlagStatus.OPEN,
          resolution: null,
          resolvedById: null,
          resolvedAt: null,
          note: null,
        },
      });
      throw err;
    }

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_FLAG_RESOLVED, profile, {
      reason: data.reason,
      diff: { flagId, resolution: data.resolution, flagReason: flag.reason },
    });

    return this.prisma.victimProfileFlag.findUniqueOrThrow({ where: { id: flagId } });
  }

  // VP-46
  async findAppeals(_admin: CurrentUserDto, query: FindAppealsQueryDto) {
    const { page, limit, skip } = this.pageOf(query);
    const where: Prisma.VictimProfileAppealWhereInput = {
      ...(query.status ? { status: query.status as VictimProfileAppealStatus } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfileAppeal.findMany({
        where,
        include: {
          profile: {
            select: { id: true, name: true, involvesChild: true, status: true, reviewNote: true },
          },
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfileAppeal.count({ where }),
    ]);

    return {
      data: rows.map(({ profile, ...appeal }) => ({
        ...appeal,
        profile: {
          id: profile.id,
          label: this.profileLabel(profile),
          status: profile.status,
          rejectionReason: profile.reviewNote,
        },
      })),
      meta: this.metaOf(page, limit, total),
    };
  }

  // VP-47
  async decideAppeal(admin: CurrentUserDto, appealId: string, data: DecideAppealDto) {
    const appeal = await this.prisma.victimProfileAppeal.findUnique({ where: { id: appealId } });
    if (!appeal) throw new NotFoundException('victim_profile_appeal_not_found');
    if (appeal.status !== VictimProfileAppealStatus.OPEN) {
      throw new ConflictException('victim_profile_appeal_already_decided');
    }

    const profile = await this.getProfileOr404(appeal.profileId);

    // Four eyes: whoever rejected it must not also decide the appeal (super admins excepted).
    if (!this.getRoles(admin).includes(RolesEnum.SUPER_ADMIN)) {
      const rejection = await this.prisma.auditLog.findFirst({
        where: {
          entity: 'VictimProfile',
          entityId: profile.id,
          action: AuditEventEnum.VICTIM_PROFILE_REJECTED,
          outcome: AuditOutcome.SUCCESS,
        },
        orderBy: { createdAt: 'desc' },
        select: { userId: true },
      });
      if (rejection?.userId === admin.id) {
        this.emitProfileFailure(
          admin,
          AuditEventEnum.VICTIM_PROFILE_APPEAL_DECIDED,
          profile,
          'appeal_requires_a_different_reviewer',
          {
            outcome: AuditOutcome.DENIED,
          },
        );
        throw new ForbiddenException('appeal_requires_a_different_reviewer');
      }
    }

    const overturn = data.decision === AppealDecision.OVERTURN_REJECTION;

    if (overturn) {
      if (profile.status !== VictimProfileStatus.REJECTED) {
        throw new BadRequestException('victim_profile_not_rejected');
      }
      // Reuses the existing admin resubmit(): re-derives the status from the gates, audited as usual.
      await this.resubmit(admin, profile.id);
    }

    const decided = await this.prisma.victimProfileAppeal.updateMany({
      where: { id: appealId, status: VictimProfileAppealStatus.OPEN },
      data: {
        status: overturn ? VictimProfileAppealStatus.OVERTURNED : VictimProfileAppealStatus.UPHELD,
        decidedById: admin.id,
        decidedAt: new Date(),
        decisionNote: data.reason,
      },
    });
    if (decided.count === 0) throw new ConflictException('victim_profile_appeal_already_decided');

    await this.cache.invalidateVictimProfileEverywhere(profile.id);

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_APPEAL_DECIDED, profile, {
      reason: data.reason,
      diff: {
        appealId,
        decision: data.decision,
        creatorMessage: data.reason,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_APPEAL_DECIDED, {
      userId: appeal.authorId,
      victimProfileId: profile.id,
      appealId,
      decision: data.decision,
    });

    return this.prisma.victimProfileAppeal.findUniqueOrThrow({ where: { id: appealId } });
  }

  // Runs `fn` per id, never aborts the batch on one failure, returns who succeeded / failed and why.
  private async runBulk(
    admin: CurrentUserDto,
    action: string,
    ids: string[],
    reason: string | null,
    fn: (id: string) => Promise<unknown>,
  ) {
    const unique = [...new Set(ids)];
    const succeeded: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];

    for (const id of unique) {
      try {
        await fn(id);
        succeeded.push(id);
      } catch (err) {
        const message =
          err instanceof Error
            ? ((err as { response?: { message?: string } }).response?.message ?? err.message)
            : String(err);
        failed.push({ id, reason: String(message) });
      }
    }

    // One summary row for the whole batch (each profile also has its own per-item audit row).
    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_BULK_ACTION,
      severity: AuditSeverity.WARNING,
      entity: 'VictimProfile',
      reason,
      diff: { result: failed.length ? 'partial' : 'success', action },
      metadata: {
        requested: unique.length,
        succeeded: succeeded.length,
        failed: failed.length,
        ids: unique,
      },
    });

    return { requested: unique.length, succeeded, failed };
  }

  // Reviewers must be active users holding an admin role.
  private async assertIsReviewer(userId: string): Promise<void> {
    const reviewer = await this.prisma.user.findFirst({
      where: {
        id: userId,
        isActive: true,
        userRoles: { some: { role: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] } } } },
      },
      select: { id: true },
    });
    if (!reviewer) throw new BadRequestException('reviewer_must_be_an_active_admin');
  }

  // VP-51
  async bulkAssign(admin: CurrentUserDto, data: BulkAssignDto) {
    await this.assertIsReviewer(data.reviewerId);
    return this.runBulk(admin, 'assign', data.ids, null, (id) =>
      this.assignReviewer(admin, id, { reviewerId: data.reviewerId }),
    );
  }

  // VP-53
  async bulkRequestChanges(admin: CurrentUserDto, data: BulkRequestChangesDto) {
    return this.runBulk(admin, 'request_changes', data.ids, data.message, (id) =>
      this.requestChanges(admin, id, { message: data.message }),
    );
  }

  // VP-54
  async bulkReject(admin: CurrentUserDto, data: BulkReasonDto) {
    return this.runBulk(admin, 'reject', data.ids, data.reason, async (id) => {
      await this.reject(admin, id);
      // Store the reason where the creator will read it (VP-02 reviewNote) and what the appeal screen shows.
      await this.prisma.victimProfile.update({
        where: { id },
        data: { reviewNote: data.reason, reviewNoteAt: new Date() },
      });
    });
  }

  // VP-55
  async bulkUnpublish(admin: CurrentUserDto, data: BulkReasonDto) {
    return this.runBulk(admin, 'unpublish', data.ids, data.reason, (id) =>
      this.unpublish(admin, id),
    );
  }

  // VP-66  (heuristics: same payout account number, or same name from the same creator)
  async findDuplicates(admin: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.pageOf(query);

    const [byAccount, byName] = await Promise.all([
      this.prisma.victimProfile.groupBy({
        by: ['bankAccountNumber'],
        where: { bankAccountNumber: { not: null }, deletedAt: null },
        _count: { id: true },
        having: { id: { _count: { gt: 1 } } },
        orderBy: { _count: { id: 'desc' } },
      }),
      this.prisma.victimProfile.groupBy({
        by: ['createdByUserId', 'name'],
        where: { name: { not: null }, createdByUserId: { not: null }, deletedAt: null },
        _count: { id: true },
        having: { id: { _count: { gt: 1 } } },
        orderBy: { _count: { id: 'desc' } },
      }),
    ]);

    type Cluster = {
      matchedOn: 'bankAccountNumber' | 'name+creator';
      key: string;
      count: number;
      where: Prisma.VictimProfileWhereInput;
    };
    const clusters: Cluster[] = [
      ...byAccount.map((g): Cluster => ({
        matchedOn: 'bankAccountNumber',
        key: maskAccount(g.bankAccountNumber) ?? '',
        count: g._count.id,
        where: { bankAccountNumber: g.bankAccountNumber, deletedAt: null },
      })),
      ...byName.map((g): Cluster => ({
        matchedOn: 'name+creator',
        key: g.name ?? '',
        count: g._count.id,
        where: { name: g.name, createdByUserId: g.createdByUserId, deletedAt: null },
      })),
    ].sort((a, b) => b.count - a.count);

    const pageClusters = clusters.slice(skip, skip + limit);
    const data = await Promise.all(
      pageClusters.map(async (c) => {
        const members = await this.prisma.victimProfile.findMany({
          where: c.where,
          select: {
            id: true,
            name: true,
            involvesChild: true,
            status: true,
            createdByUserId: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        });
        return {
          matchedOn: c.matchedOn,
          // Child names are never shown as a cluster key.
          key:
            members.some((m) => m.involvesChild) && c.matchedOn === 'name+creator'
              ? 'redacted'
              : c.key,
          count: c.count,
          profiles: members.map((m) => ({
            id: m.id,
            label: this.profileLabel(m),
            status: m.status,
            createdByUserId: m.createdByUserId,
            createdAt: m.createdAt,
          })),
        };
      }),
    );

    void admin;
    return { data, meta: this.metaOf(page, limit, clusters.length) };
  }

  // VP-69
  async findTrash(_admin: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.pageOf(query);
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
        label: this.profileLabel({ id: row.id, name, involvesChild: row.involvesChild }),
      })),
      meta: this.metaOf(page, limit, total),
    };
  }

  // Stats filters — shared by search, facets, export and every stats route.
  private parseRange(q: DateRangeQueryDto): { from?: Date; to?: Date } {
    const from = q.from ? new Date(q.from) : undefined;
    let to = q.to ? new Date(q.to) : undefined;
    if (q.to && to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
      to = new Date(to.getTime() + 86_400_000 - 1); // date-only `to` is inclusive
    }
    if (from && to && from > to) throw new BadRequestException('invalid_date_range');
    return { from, to };
  }

  private statsWhere(q: StatsQueryDto): Prisma.VictimProfileWhereInput {
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

  // VP-84
  async searchForAdmin(admin: CurrentUserDto, query: AdminSearchQueryDto) {
    const { page, limit, skip } = this.pageOf(query);
    const where: Prisma.VictimProfileWhereInput = {
      AND: [
        this.statsWhere(query),
        {
          OR: [
            { id: query.q },
            { name: { contains: query.q, mode: 'insensitive' } },
            { description: { contains: query.q, mode: 'insensitive' } },
            { story: { contains: query.q, mode: 'insensitive' } },
          ],
        },
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        include: { readStates: { where: { adminId: admin.id }, select: { readAt: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: rows.map(({ readStates, ...row }) => ({
        ...stripBank(row),
        isRead: readStates.length > 0,
      })),
      meta: this.metaOf(page, limit, total),
    };
  }

  // VP-85
  async getFacets(admin: CurrentUserDto, query: StatsQueryDto) {
    const where = this.statsWhere(query);

    const [
      byStatus,
      byCategory,
      byChild,
      byAssignee,
      unassigned,
      unclaimed,
      flagged,
      paused,
      held,
      unread,
    ] = await Promise.all([
      this.prisma.victimProfile.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.victimProfile.groupBy({
        by: ['supportType'],
        where,
        _count: { _all: true },
        orderBy: { supportType: 'asc' },
      }),
      this.prisma.victimProfile.groupBy({
        by: ['involvesChild'],
        where,
        _count: { _all: true },
        orderBy: { involvesChild: 'asc' },
      }),
      this.prisma.victimProfile.groupBy({
        by: ['assignedReviewerId'],
        where: { AND: [where, { assignedReviewerId: { not: null } }] },
        _count: { _all: true },
        orderBy: { assignedReviewerId: 'asc' },
      }),
      this.prisma.victimProfile.count({ where: { AND: [where, { assignedReviewerId: null }] } }),
      this.prisma.victimProfile.count({ where: { AND: [where, { claimedByUserId: null }] } }),
      this.prisma.victimProfile.count({
        where: { AND: [where, { flags: { some: { status: VictimProfileFlagStatus.OPEN } } }] },
      }),
      this.prisma.victimProfile.count({ where: { AND: [where, { donationsPaused: true }] } }),
      this.prisma.victimProfile.count({ where: { AND: [where, { legalHold: true }] } }),
      this.prisma.victimProfile.count({ where: { AND: [where, this.unreadWhere(admin)] } }),
    ]);

    return {
      status: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      category: Object.fromEntries(
        byCategory.map((r) => [r.supportType ?? 'UNSPECIFIED', r._count._all]),
      ),
      involvesChild: Object.fromEntries(
        byChild.map((r) => [String(r.involvesChild), r._count._all]),
      ),
      assignedReviewer: {
        unassigned,
        ...Object.fromEntries(
          byAssignee.map((r) => [r.assignedReviewerId as string, r._count._all]),
        ),
      },
      unclaimed,
      withOpenFlags: flagged,
      donationsPaused: paused,
      underLegalHold: held,
      unreadForMe: unread,
    };
  }

  // VP-86
  async getFilterOptions(_admin: CurrentUserDto) {
    const reviewers = await this.prisma.user.findMany({
      where: {
        isActive: true,
        userRoles: { some: { role: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] } } } },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    return {
      statuses: Object.values(VictimProfileStatus),
      categories: Object.values(SupportType),
      flagReasons: Object.values(FlagReason),
      flagStatuses: Object.values(VictimProfileFlagStatus),
      appealStatuses: Object.values(VictimProfileAppealStatus),
      intervals: Object.values(StatsInterval),
      reviewers,
    };
  }

  private static readonly EXPORT_COLUMNS = [
    'id',
    'label',
    'status',
    'supportType',
    'supportGoal',
    'totalRaised',
    'involvesChild',
    'isPublished',
    'donationsPaused',
    'assignedReviewerId',
    'claimedByUserId',
    'createdByUserId',
    'createdAt',
    'updatedAt',
  ] as const;

  // Never exports story, description, bank or consent data; child profiles are exported by label only.
  private async buildExportRows(
    query: StatsQueryDto,
    maxRows: number,
  ): Promise<{ lines: string[]; rowCount: number; truncated: boolean }> {
    const where = this.statsWhere(query);
    const lines: string[] = [VictimProfileService.EXPORT_COLUMNS.map(csvCell).join(',')];
    const batch = 1000;
    let rowCount = 0;
    let truncated = false;
    let cursor: string | undefined;

    while (rowCount < maxRows) {
      const rows = await this.prisma.victimProfile.findMany({
        where,
        select: {
          id: true,
          name: true,
          status: true,
          supportType: true,
          supportGoal: true,
          totalRaised: true,
          involvesChild: true,
          isPublished: true,
          donationsPaused: true,
          assignedReviewerId: true,
          claimedByUserId: true,
          createdByUserId: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { id: 'asc' },
        take: Math.min(batch, maxRows - rowCount + 1),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) break;

      for (const r of rows) {
        if (rowCount >= maxRows) {
          truncated = true;
          break;
        }
        lines.push(
          [
            r.id,
            this.profileLabel(r),
            r.status,
            r.supportType,
            r.supportGoal ? money(r.supportGoal) : '',
            money(r.totalRaised),
            r.involvesChild,
            r.isPublished,
            r.donationsPaused,
            r.assignedReviewerId,
            r.claimedByUserId,
            r.createdByUserId,
            r.createdAt,
            r.updatedAt,
          ]
            .map(csvCell)
            .join(','),
        );
        rowCount += 1;
      }
      if (truncated) break;
      cursor = rows[rows.length - 1].id;
    }

    return { lines, rowCount, truncated };
  }

  // VP-87
  async exportCsv(admin: CurrentUserDto, query: ExportQueryDto) {
    const maxRows = Number(this.configService.get<string>('PROFILE_EXPORT_MAX_ROWS') ?? 5000);
    const { lines, rowCount, truncated } = await this.buildExportRows(query, maxRows);

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_EXPORTED,
      severity: AuditSeverity.WARNING,
      entity: 'VictimProfile',
      diff: { result: 'success', mode: 'inline' },
      metadata: { filters: query as unknown as Record<string, unknown>, rowCount, truncated },
    });

    return {
      filename: `victim-profiles-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      rowCount,
      truncated,
      csv: lines.join('\n'),
    };
  }

  // VP-88
  async createExportJob(admin: CurrentUserDto, data: ExportQueryDto) {
    const job = await this.prisma.victimProfileExportJob.create({
      data: {
        requestedById: admin.id,
        filters: data as unknown as Prisma.InputJsonValue,
      },
    });

    // In-process on purpose (no queue in this codebase yet). On a multi-instance deployment move this
    // call into your job runner; runExportJob() is idempotent on QUEUED -> RUNNING.
    setImmediate(() => {
      this.runExportJob(job.id).catch(() => undefined);
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_EXPORTED,
      severity: AuditSeverity.WARNING,
      entity: 'VictimProfileExportJob',
      entityId: job.id,
      diff: { result: 'success', mode: 'job_requested' },
      metadata: { filters: data as unknown as Record<string, unknown> },
    });

    return { id: job.id, status: job.status, createdAt: job.createdAt };
  }

  private async runExportJob(jobId: string): Promise<void> {
    const started = await this.prisma.victimProfileExportJob.updateMany({
      where: { id: jobId, status: VictimProfileExportJobStatus.QUEUED },
      data: { status: VictimProfileExportJobStatus.RUNNING, startedAt: new Date() },
    });
    if (started.count === 0) return;

    const job = await this.prisma.victimProfileExportJob.findUniqueOrThrow({
      where: { id: jobId },
    });

    try {
      const maxRows = Number(
        this.configService.get<string>('PROFILE_EXPORT_JOB_MAX_ROWS') ?? 100_000,
      );
      const ttlHours = Number(this.configService.get<string>('PROFILE_EXPORT_TTL_HOURS') ?? 24);
      const filters = (job.filters ?? {}) as unknown as StatsQueryDto;

      const { lines, rowCount, truncated } = await this.buildExportRows(filters, maxRows);

      const storageKey = `exports/victim-profiles/${jobId}.csv`;
      // Adapt to your MinioService upload method (key, bytes, content type).
      await this.minioService.uploadFile(
        storageKey,
        Buffer.from(lines.join('\n'), 'utf8'),
        'text/csv',
      );

      await this.prisma.victimProfileExportJob.update({
        where: { id: jobId },
        data: {
          status: VictimProfileExportJobStatus.COMPLETED,
          storageKey,
          rowCount,
          truncated,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
        },
      });

      this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_EXPORT_READY, {
        userId: job.requestedById,
        exportJobId: jobId,
      });
    } catch (err) {
      await this.prisma.victimProfileExportJob.update({
        where: { id: jobId },
        data: {
          status: VictimProfileExportJobStatus.FAILED,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          completedAt: new Date(),
        },
      });
    }
  }

  // Only the requester (or a super admin) can see a job; everyone else gets a 404.
  private async getOwnedExportJob(admin: CurrentUserDto, id: string) {
    const job = await this.prisma.victimProfileExportJob.findUnique({ where: { id } });
    const isSuper = this.getRoles(admin).includes(RolesEnum.SUPER_ADMIN);
    if (!job || (job.requestedById !== admin.id && !isSuper)) {
      throw new NotFoundException('export_job_not_found');
    }
    return job;
  }

  // VP-89
  async getExportJob(admin: CurrentUserDto, id: string) {
    const job = await this.getOwnedExportJob(admin, id);
    const expired =
      job.status === VictimProfileExportJobStatus.COMPLETED &&
      !!job.expiresAt &&
      job.expiresAt < new Date();
    return {
      id: job.id,
      status: expired ? VictimProfileExportJobStatus.EXPIRED : job.status,
      rowCount: job.rowCount,
      truncated: job.truncated,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      expiresAt: job.expiresAt,
    };
  }

  // VP-90
  async getExportJobDownload(admin: CurrentUserDto, id: string) {
    const job = await this.getOwnedExportJob(admin, id);

    if (job.status !== VictimProfileExportJobStatus.COMPLETED || !job.storageKey) {
      throw new BadRequestException('export_job_not_ready');
    }
    if (job.expiresAt && job.expiresAt < new Date()) {
      await this.prisma.victimProfileExportJob.update({
        where: { id },
        data: { status: VictimProfileExportJobStatus.EXPIRED },
      });
      await this.minioService.deleteFile(job.storageKey).catch(() => undefined);
      throw new BadRequestException('export_job_expired');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(job.storageKey);

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_EXPORT_DOWNLOADED,
      severity: AuditSeverity.WARNING,
      entity: 'VictimProfileExportJob',
      entityId: id,
      diff: { result: 'success' },
      metadata: { rowCount: job.rowCount },
    });

    return { url, expiresAt: job.expiresAt };
  }

  // VP-49
  async assignReviewer(admin: CurrentUserDto, id: string, data: AssignReviewerDto) {
    const profile = await this.getProfileOr404(id);
    await this.assertIsReviewer(data.reviewerId);

    if (profile.assignedReviewerId === data.reviewerId) return profile;

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      { assignedReviewerId: data.reviewerId, assignedAt: new Date() },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_ASSIGNED, profile },
    );

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_ASSIGNED, profile, {
      diff: { previousReviewerId: profile.assignedReviewerId, newReviewerId: data.reviewerId },
    });
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_ASSIGNED, {
      userId: data.reviewerId,
      victimProfileId: id,
      actorId: admin.id,
    });
    return updated;
  }

  // VP-50
  async unassignReviewer(admin: CurrentUserDto, id: string) {
    const profile = await this.getProfileOr404(id);
    if (!profile.assignedReviewerId) throw new BadRequestException('victim_profile_not_assigned');

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      { assignedReviewerId: null, assignedAt: null },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_UNASSIGNED, profile },
    );
    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_UNASSIGNED, profile, {
      diff: { previousReviewerId: profile.assignedReviewerId },
    });
    return updated;
  }

  // VP-52
  async requestChanges(admin: CurrentUserDto, id: string, data: RequestChangesDto) {
    const profile = await this.getProfileOr404(id);
    this.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED,
    );

    if (profile.deletedAt) throw new BadRequestException('victim_profile_deleted');
    if (profile.isPublished || !CHANGE_REQUESTABLE_STATUSES.includes(profile.status)) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED,
        profile,
        'changes_cannot_be_requested_in_this_status',
        {
          diff: { currentStatus: profile.status },
        },
      );
      throw new BadRequestException('changes_cannot_be_requested_in_this_status');
    }

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        status: VictimProfileStatus.CHANGES_REQUESTED,
        reviewNote: data.message,
        reviewNoteAt: new Date(),
        isAdminApproved: false,
        isPublished: false,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED, profile, {
      reason: data.message,
      diff: {
        previousStatus: profile.status,
        newStatus: VictimProfileStatus.CHANGES_REQUESTED,
        creatorMessage: data.message,
      },
    });
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      message: data.message,
    });
    return updated;
  }

  // VP-44
  async takedown(admin: CurrentUserDto, id: string, data: TakedownDto) {
    const profile = await this.getProfileOr404(id);
    // Emergency action: deliberately NOT blocked by another admin's claim.
    if (profile.takedownAt) throw new ConflictException('victim_profile_already_taken_down');

    // isAdminApproved is cleared so the existing publish() gate check refuses a republish
    // until a super admin lifts the takedown and the profile is re-approved.
    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        status: VictimProfileStatus.UNPUBLISHED,
        isPublished: false,
        isAdminApproved: false,
        isFeatured: false,
        donationsPaused: true,
        donationsPausedReason: data.reason,
        donationsPausedAt: profile.donationsPausedAt ?? new Date(),
        takedownReason: data.reason,
        takedownAt: new Date(),
        takedownById: admin.id,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_TAKEDOWN, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_TAKEDOWN, profile, {
      severity: AuditSeverity.CRITICAL,
      reason: data.reason,
      diff: {
        previousStatus: profile.status,
        newStatus: VictimProfileStatus.UNPUBLISHED,
        previousIsPublished: profile.isPublished,
      },
    });
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_TAKEN_DOWN, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });
    return updated;
  }

  // VP-45
  async liftTakedown(admin: CurrentUserDto, id: string, data: LiftTakedownDto) {
    const profile = await this.getProfileOr404(id);
    if (!profile.takedownAt) throw new BadRequestException('victim_profile_not_taken_down');

    // Stays UNPUBLISHED and un-approved: it has to go back through approval and publish().
    // Donations stay paused until someone calls resume-donations on purpose.
    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      { takedownReason: null, takedownAt: null, takedownById: null },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_TAKEDOWN_LIFTED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_TAKEDOWN_LIFTED, profile, {
      severity: AuditSeverity.CRITICAL,
      reason: data.reason,
      diff: {
        previousTakedownReason: profile.takedownReason,
        previousTakedownById: profile.takedownById,
        creatorMessage: 'The takedown was lifted; your profile will be reviewed again.',
      },
    });
    return updated;
  }

  // VP-56
  async complete(admin: CurrentUserDto, id: string, data: CompleteProfileDto) {
    const profile = await this.getProfileOr404(id);
    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_COMPLETED);

    if (profile.status !== VictimProfileStatus.PUBLISHED) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_COMPLETED,
        profile,
        'only_published_profiles_can_be_completed',
        {
          diff: { currentStatus: profile.status },
        },
      );
      throw new BadRequestException('only_published_profiles_can_be_completed');
    }

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        status: VictimProfileStatus.COMPLETED,
        completedAt: new Date(),
        completionNote: data.note ?? null,
        isFeatured: false,
        donationsPaused: true,
        donationsPausedReason: 'completed',
        donationsPausedAt: new Date(),
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_COMPLETED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_COMPLETED, profile, {
      reason: data.note ?? null,
      diff: { previousStatus: profile.status, newStatus: VictimProfileStatus.COMPLETED },
      metadata: { totalRaisedAtCompletion: money(profile.totalRaised) },
    });
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_COMPLETED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });
    return updated;
  }

  // VP-57
  async reopen(admin: CurrentUserDto, id: string, data: ReasonDto) {
    const profile = await this.getProfileOr404(id);
    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_REOPENED);

    if (profile.status !== VictimProfileStatus.COMPLETED) {
      throw new BadRequestException('victim_profile_not_completed');
    }
    if (profile.takedownAt || profile.deletedAt) {
      throw new BadRequestException('victim_profile_blocked_from_reopening');
    }

    // Back to PUBLISHED only if every gate still holds; otherwise fall back to the derived pipeline status.
    const gatesHold =
      this.getMissingApprovalGates({
        involvesChild: profile.involvesChild,
        isVerified: profile.isVerified,
        isSafetyReviewed: profile.isSafetyReviewed,
        isChildSafetyReviewed: profile.isChildSafetyReviewed,
        hasConsent: profile.hasConsent,
        isPrivacyReviewed: profile.isPrivacyReviewed,
        hasBankDetails: this.hasBankDetails(profile),
      }).length === 0 && profile.isAdminApproved;

    const status = gatesHold
      ? VictimProfileStatus.PUBLISHED
      : this.deriveStatus({
          involvesChild: profile.involvesChild,
          isVerified: profile.isVerified,
          isSafetyReviewed: profile.isSafetyReviewed,
          isChildSafetyReviewed: profile.isChildSafetyReviewed,
          hasConsent: profile.hasConsent,
          isPrivacyReviewed: profile.isPrivacyReviewed,
          isAdminApproved: profile.isAdminApproved,
        });

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        status,
        isPublished: gatesHold,
        completedAt: null,
        completionNote: null,
        donationsPaused: false,
        donationsPausedReason: null,
        donationsPausedAt: null,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_REOPENED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_REOPENED, profile, {
      reason: data.reason,
      diff: { previousStatus: profile.status, newStatus: status },
    });
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_REOPENED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });
    return updated;
  }

  // VP-58
  async createAdminUpdate(admin: CurrentUserDto, id: string, data: CreateProfileUpdateDto) {
    const profile = await this.getProfileOr404(id);
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

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_UPDATE_POSTED, profile, {
      metadata: { updateId: update.id, actor: 'staff' },
    });
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_UPDATE_POSTED, {
      victimProfileId: id,
      updateId: update.id,
      actorId: admin.id,
    });
    return update;
  }

  // VP-59
  async getConsent(admin: CurrentUserDto, id: string) {
    const profile = await this.getProfileOr404(id);
    this.logAdminView(admin, profile, 'consent');

    const documents = await Promise.all(
      profile.consentDocuments.map(async (key) => ({
        key,
        url: await this.minioService.generatePresignedDownloadUrl(key),
      })),
    );

    return {
      hasConsent: profile.hasConsent,
      consentedBy: profile.consentedBy,
      consentAt: profile.consentAt,
      recordedBy: profile.consentRecordedBy,
      notes: profile.consentNotes,
      documents,
    };
  }

  // VP-60
  async recordConsent(admin: CurrentUserDto, id: string, data: RecordConsentDto) {
    const profile = await this.getProfileOr404(id);
    this.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_CONSENT_RECORDED,
    );

    if (profile.hasConsent) {
      throw new ConflictException('consent_already_recorded_revoke_first');
    }
    const documents = data.document ?? [];
    if (!documents.length) throw new BadRequestException('signed_consent_form_required');

    const consentAt = data.consentedAt ? new Date(data.consentedAt) : new Date();
    if (consentAt.getTime() > Date.now() + 60_000)
      throw new BadRequestException('consent_date_in_future');

    try {
      await this.validateMediaFilesExist(documents);
    } catch (err) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CONSENT_RECORDED,
        profile,
        'media_validation_failed',
        {
          diff: { message: err instanceof Error ? err.message : String(err) },
        },
      );
      throw err;
    }

    const status = this.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: true,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: profile.isAdminApproved,
    });

    // Only move the pipeline status while the profile is still in the pipeline.
    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        hasConsent: true,
        consentAt,
        consentRecordedBy: admin.id,
        consentedBy: data.consentedBy,
        consentNotes: data.notes ?? null,
        consentDocuments: [...profile.consentDocuments, ...documents],
        ...(PIPELINE_STATUSES.includes(profile.status) ? { status } : {}),
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_CONSENT_RECORDED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_CONSENT_RECORDED, profile, {
      diff: { previousStatus: profile.status, newStatus: updated.status },
      metadata: { consentedBy: data.consentedBy, documentCount: documents.length },
    });
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_GATES_UPDATED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      status: updated.status,
    });
    return updated;
  }

  // VP-61
  async feature(admin: CurrentUserDto, id: string) {
    const profile = await this.getProfileOr404(id);
    if (profile.status !== VictimProfileStatus.PUBLISHED || !profile.isPublished) {
      throw new BadRequestException('only_published_profiles_can_be_featured');
    }
    if (profile.isFeatured) return profile;

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      { isFeatured: true, featuredAt: new Date() },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_FEATURED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);
    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_FEATURED, profile);
    return updated;
  }

  // VP-62
  async unfeature(admin: CurrentUserDto, id: string) {
    const profile = await this.getProfileOr404(id);
    if (!profile.isFeatured) return profile;

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      { isFeatured: false, featuredAt: null },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_UNFEATURED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);
    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_UNFEATURED, profile);
    return updated;
  }

  // VP-63
  async adminEdit(admin: CurrentUserDto, id: string, data: AdminEditVictimProfileDto) {
    const profile = await this.getProfileOr404(id);
    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_ADMIN_EDITED);

    if (profile.isPublished) throw new BadRequestException('unpublish_before_editing');

    const changes: Record<string, { from: string | null; to: string }> = {};
    for (const field of ['name', 'description', 'story'] as const) {
      const next = data[field];
      if (next !== undefined && next !== profile[field]) {
        changes[field] = { from: profile[field], to: next };
      }
    }
    if (!Object.keys(changes).length) throw new BadRequestException('no_changes_to_apply');

    const updated = await this.conditionalUpdate(
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
      ? this.deriveStatus({
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

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_ADMIN_EDITED, profile, {
      reason: data.reason,
      diff: { previousStatus: profile.status, newStatus: finalProfile.status },
      metadata: { fieldsChanged: Object.keys(changes) },
    });
    return finalProfile;
  }

  // VP-64  (first admin proposes, a different admin confirms the same value within 72h)
  async updateChildFlag(admin: CurrentUserDto, id: string, data: UpdateChildFlagDto) {
    const profile = await this.getProfileOr404(id);
    this.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_UPDATED,
    );

    if (profile.involvesChild === data.involvesChild) {
      throw new BadRequestException('child_flag_unchanged');
    }

    const proposalLive =
      profile.childFlagProposedById &&
      profile.childFlagProposedAt &&
      Date.now() - profile.childFlagProposedAt.getTime() < CHILD_FLAG_PROPOSAL_TTL_MS &&
      profile.childFlagProposedValue === data.involvesChild;

    if (!proposalLive) {
      const updated = await this.conditionalUpdate(
        id,
        profile.updatedAt,
        {
          childFlagProposedValue: data.involvesChild,
          childFlagProposedById: admin.id,
          childFlagProposedAt: new Date(),
          childFlagProposedReason: data.reason,
        },
        { admin, action: AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_PROPOSED, profile },
      );
      this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_PROPOSED, profile, {
        severity: AuditSeverity.WARNING,
        reason: data.reason,
        diff: { proposedValue: data.involvesChild },
        metadata: { stage: 'first_confirmation' },
      });
      return { applied: false, awaitingSecondAdmin: true, profile: updated };
    }

    if (profile.childFlagProposedById === admin.id) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_UPDATED,
        profile,
        'child_flag_requires_second_admin',
        {
          outcome: AuditOutcome.DENIED,
        },
      );
      throw new BadRequestException('child_flag_requires_second_admin');
    }

    // Either direction forces a fresh review: raising it needs child-safety review, lowering it
    // makes photos public. Hence unpublish + clear approval + clear child-safety state.
    const status = this.deriveStatus({
      involvesChild: data.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: false,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: false,
    });

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        involvesChild: data.involvesChild,
        isChildSafetyReviewed: false,
        childSafetyFirstConfirmedByUserId: null,
        childSafetyFirstConfirmedAt: null,
        isAdminApproved: false,
        isPublished: false,
        isFeatured: false,
        status: GATE_DRIVEN_STATUSES.includes(profile.status) ? status : profile.status,
        childFlagProposedValue: null,
        childFlagProposedById: null,
        childFlagProposedAt: null,
        childFlagProposedReason: null,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_UPDATED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_UPDATED, profile, {
      severity: AuditSeverity.CRITICAL,
      reason: data.reason,
      diff: {
        previousInvolvesChild: profile.involvesChild,
        newInvolvesChild: data.involvesChild,
        previousStatus: profile.status,
        newStatus: updated.status,
        firstConfirmedBy: profile.childFlagProposedById,
        secondConfirmedBy: admin.id,
      },
      metadata: { stage: 'second_confirmation' },
    });
    return { applied: true, awaitingSecondAdmin: false, profile: updated };
  }

  // VP-65
  async getTransitions(admin: CurrentUserDto, id: string) {
    const profile = await this.getProfileOr404(id);

    const missingGates = this.getMissingApprovalGates({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      hasBankDetails: this.hasBankDetails(profile),
    });
    if (!profile.isAdminApproved) missingGates.push('isAdminApproved');

    const blockers: string[] = [];
    if (profile.deletedAt) blockers.push('deleted');
    if (profile.legalHold) blockers.push('legal_hold');
    if (profile.takedownAt) blockers.push('taken_down');

    const roles = this.getRoles(admin);
    const claimedByOther =
      !roles.includes(RolesEnum.SUPER_ADMIN) &&
      !!profile.claimedByUserId &&
      profile.claimedByUserId !== admin.id;

    return {
      current: profile.status,
      claimedByAnotherAdmin: claimedByOther,
      blockers,
      allowed: STATUS_TRANSITIONS[profile.status].map((t) => ({
        ...t,
        available:
          !claimedByOther &&
          !profile.deletedAt &&
          !(
            t.to === VictimProfileStatus.PUBLISHED &&
            (missingGates.length > 0 || !!profile.takedownAt)
          ),
        blockedBy:
          t.to === VictimProfileStatus.PUBLISHED && profile.status === VictimProfileStatus.APPROVED
            ? missingGates
            : [],
      })),
    };
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
    const profile = await this.getProfileOr404(id);
    if (profile.deletedAt) throw new ConflictException('victim_profile_already_deleted');

    if (profile.legalHold) {
      this.emitProfileFailure(
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
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_SOFT_DELETED,
        profile,
        'victim_profile_has_unsettled_payments',
      );
      throw new ConflictException('victim_profile_has_unsettled_payments');
    }

    // Also unpublished + approval cleared + donations paused: the existing public queries do not
    // look at deletedAt, so this is what actually takes it off the public site.
    const updated = await this.conditionalUpdate(
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

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_SOFT_DELETED, profile, {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      diff: { previousStatus: profile.status, previousIsPublished: profile.isPublished },
    });
    return { message: 'victim_profile_soft_deleted', id, deletedAt: updated.deletedAt };
  }

  // VP-68  (comes back UNPUBLISHED, unapproved and with donations still paused on purpose)
  async restore(admin: CurrentUserDto, id: string) {
    const profile = await this.getProfileOr404(id);
    if (!profile.deletedAt) throw new BadRequestException('victim_profile_not_deleted');
    if (profile.anonymizedAt)
      throw new BadRequestException('anonymized_profiles_cannot_be_restored');

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      { deletedAt: null, deletedById: null, deleteReason: null },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_RESTORED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_RESTORED, profile, {
      diff: { previousDeleteReason: profile.deleteReason },
    });
    return updated;
  }

  // VP-70
  async getRevisions(admin: CurrentUserDto, id: string) {
    const profile = await this.getProfileOr404(id);
    this.logAdminView(admin, profile, 'revisions');

    return this.prisma.victimProfileRevision.findMany({
      where: { profileId: id },
      orderBy: { createdAt: 'desc' },
    });
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

  // VP-72
  async resumeDonations(admin: CurrentUserDto, id: string) {
    const profile = await this.getProfileOr404(id);
    if (!profile.donationsPaused) throw new BadRequestException('donations_not_paused');
    if (profile.takedownAt) throw new BadRequestException('cannot_resume_during_takedown');
    if (profile.deletedAt) throw new BadRequestException('victim_profile_deleted');
    if (profile.status === VictimProfileStatus.COMPLETED) {
      throw new BadRequestException('victim_profile_completed_reopen_first');
    }

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      { donationsPaused: false, donationsPausedReason: null, donationsPausedAt: null },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_DONATIONS_RESUMED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);
    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_DONATIONS_RESUMED, profile, {
      diff: { previousReason: profile.donationsPausedReason },
    });
    return updated;
  }

  // VP-73
  async updateGoal(admin: CurrentUserDto, id: string, data: UpdateGoalDto) {
    const profile = await this.getProfileOr404(id);
    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_GOAL_UPDATED);

    const goal = new Prisma.Decimal(data.supportGoal);
    if (goal.gt(0) && goal.lt(profile.totalRaised)) {
      throw new BadRequestException('goal_below_total_raised');
    }

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      { supportGoal: goal },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_GOAL_UPDATED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_GOAL_UPDATED, profile, {
      severity: AuditSeverity.WARNING,
      reason: data.reason,
      diff: {
        previousGoal: profile.supportGoal ? money(profile.supportGoal) : null,
        newGoal: money(goal),
        totalRaised: money(profile.totalRaised),
      },
    });
    return updated;
  }

  // VP-74  (the audit trail never stored the numbers, so history is who/when/what-kind, plus the current masked value)
  async getBankDetailsHistory(admin: CurrentUserDto, id: string) {
    const profile = await this.getProfileOr404(id);
    this.logAdminView(admin, profile, 'bank_history');

    const [events, destination] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          entity: 'VictimProfile',
          entityId: id,
          action: {
            in: [
              AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
              AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_VERIFIED,
            ],
          },
          outcome: AuditOutcome.SUCCESS,
        },
        orderBy: { createdAt: 'desc' },
        select: { action: true, userId: true, createdAt: true, metadata: true },
      }),
      this.prisma.payoutDestination.findUnique({
        where: { victimProfileId: id },
        select: {
          rail: true,
          bankName: true,
          accountNumber: true,
          accountHolder: true,
          isVerified: true,
          updatedAt: true,
        },
      }),
    ]);

    return {
      current: destination
        ? {
            rail: destination.rail,
            bankName: destination.bankName,
            accountNumberMasked: maskAccount(destination.accountNumber),
            accountHolder: destination.accountHolder,
            isVerified: destination.isVerified,
            updatedAt: destination.updatedAt,
          }
        : {
            bankName: profile.bankName,
            accountNumberMasked: maskAccount(profile.bankAccountNumber),
            accountHolder: profile.bankAccountName,
            isVerified: false,
          },
      history: events.map((e) => {
        const meta = (e.metadata ?? {}) as Record<string, unknown>;
        return {
          event: e.action,
          by: e.userId,
          at: e.createdAt,
          accountNameChanged: meta.accountNameChanged,
          accountNumberChanged: meta.accountNumberChanged,
          bankNameChanged: meta.bankNameChanged,
          accountHolderRelationship: meta.accountHolderRelationship,
        };
      }),
    };
  }

  // VP-75  (four eyes: the admin who typed the destination cannot be the one who verifies it)
  async verifyBankDetails(admin: CurrentUserDto, id: string, data: VerifyBankDetailsDto) {
    const profile = await this.getProfileOr404(id);
    this.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_VERIFIED,
    );

    const destination = await this.prisma.payoutDestination.findUnique({
      where: { victimProfileId: id },
    });
    if (!destination) throw new BadRequestException('payout_destination_not_set');
    if (destination.isVerified) throw new ConflictException('payout_destination_already_verified');

    const lastEdit = await this.prisma.auditLog.findFirst({
      where: {
        entity: 'VictimProfile',
        entityId: id,
        action: AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
        outcome: AuditOutcome.SUCCESS,
      },
      orderBy: { createdAt: 'desc' },
      select: { userId: true },
    });
    if (lastEdit?.userId === admin.id) {
      this.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_VERIFIED,
        profile,
        'verifier_must_differ_from_editor',
        {
          outcome: AuditOutcome.DENIED,
        },
      );
      throw new ForbiddenException('verifier_must_differ_from_editor');
    }

    // Compare-and-set so a concurrent bank-details edit (which resets isVerified) can't be verified over.
    const result = await this.prisma.payoutDestination.updateMany({
      where: { id: destination.id, isVerified: false, updatedAt: destination.updatedAt },
      data: { isVerified: true },
    });
    if (result.count === 0) throw new ConflictException('victim_profile_transition_conflict');

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_VERIFIED, profile, {
      severity: AuditSeverity.WARNING,
      reason: data.notes ?? null,
      diff: { accountNumberMasked: maskAccount(destination.accountNumber) },
    });
    return { id, verified: true, accountNumberMasked: maskAccount(destination.accountNumber) };
  }

  // VP-76
  async getFundingTimeline(admin: CurrentUserDto, id: string, query: DateRangeQueryDto) {
    const profile = await this.getProfileOr404(id);
    this.logAdminView(admin, profile, 'funding_timeline');
    const { from, to } = this.parseRange(query);

    const payments = await this.prisma.payment.findMany({
      where: {
        victimProfileId: id,
        type: 'SUPPORT',
        status: 'PAID',
        support: { status: { not: 'CANCELLED' } },
        ...(from || to
          ? { paidAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      select: {
        paidAt: true,
        createdAt: true,
        allocations: { where: { partyType: 'RECIPIENT' }, select: { amount: true } },
      },
      take: 50_000,
    });

    const days = new Map<string, { count: number; total: Prisma.Decimal }>();
    for (const p of payments) {
      const day = (p.paidAt ?? p.createdAt).toISOString().slice(0, 10);
      const cur = days.get(day) ?? { count: 0, total: new Prisma.Decimal(0) };
      cur.count += 1;
      for (const a of p.allocations) cur.total = cur.total.add(a.amount);
      days.set(day, cur);
    }

    return [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, donations: v.count, recipientAmount: money(v.total) }));
  }

  // VP-77  (scan status / hash are read from object metadata; they stay "unknown" until your upload pipeline sets them)
  async getAttachments(admin: CurrentUserDto, id: string) {
    const profile = await this.getProfileOr404(id);
    this.logAdminView(admin, profile, 'attachments');

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
    const profile = await this.getProfileOr404(id);
    this.assertAdminCanAccessProfile(admin, profile, AuditEventEnum.VICTIM_PROFILE_MEDIA_REMOVED);

    const field = this.findMediaField(profile, key);
    if (!field) throw new NotFoundException('media_not_found_on_profile');

    const stat = await this.minioService.statObject(key).catch(() => null);
    const size = stat?.size ?? 0;

    const updated = await this.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        [field]: profile[field].filter((k) => k !== key),
        mediaTotalBytes: Math.max(0, profile.mediaTotalBytes - size),
      } as Prisma.VictimProfileUncheckedUpdateManyInput,
      { admin, action: AuditEventEnum.VICTIM_PROFILE_MEDIA_REMOVED, profile },
    );
    await this.deleteMediaFiles([key]);
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_MEDIA_REMOVED, profile, {
      severity: AuditSeverity.WARNING,
      reason: data.reason ?? null,
      metadata: { key, field, actor: 'staff', bytesFreed: size },
    });
    return { message: 'media_removed', id: updated.id, key };
  }

  // VP-79  (no image processing lives in this service: this validates + records the request and hands it to a worker)
  async redactMedia(admin: CurrentUserDto, id: string, key: string, data: RedactMediaDto) {
    const profile = await this.getProfileOr404(id);
    this.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_MEDIA_REDACTION_REQUESTED,
    );

    const field = this.findMediaField(profile, key);
    if (!field) throw new NotFoundException('media_not_found_on_profile');
    if (field !== 'photo' && field !== 'video') {
      throw new BadRequestException('only_photo_and_video_can_be_redacted');
    }

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_MEDIA_REDACTION_REQUESTED, profile, {
      severity: AuditSeverity.WARNING,
      reason: data.notes ?? null,
      metadata: { key, field, mode: data.mode },
    });
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
    const profile = await this.getProfileOr404(id);
    this.logAdminView(admin, profile, 'media_custody');

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
    await this.assertProfileExists(id);
    const { page, limit, skip } = this.pageOf(query);
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
    return { data: rows, meta: this.metaOf(page, limit, total) };
  }

  // VP-82
  async setLegalHold(admin: CurrentUserDto, id: string, data: LegalHoldDto) {
    const profile = await this.getProfileOr404(id);
    if (profile.legalHold === data.legalHold) {
      throw new BadRequestException(
        data.legalHold ? 'legal_hold_already_set' : 'legal_hold_not_set',
      );
    }

    const updated = await this.conditionalUpdate(
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

    this.auditSuccess(admin, AuditEventEnum.VICTIM_PROFILE_LEGAL_HOLD_CHANGED, profile, {
      severity: AuditSeverity.CRITICAL,
      reason: data.reason,
      diff: { previousLegalHold: profile.legalHold, newLegalHold: data.legalHold },
    });
    return updated;
  }

  // VP-83  (irreversible: only after closure, never under legal hold or with money still owed)
  async anonymize(admin: CurrentUserDto, id: string, data: AnonymizeDto) {
    const profile = await this.getProfileOr404(id);

    if (profile.anonymizedAt) throw new ConflictException('victim_profile_already_anonymized');
    if (profile.legalHold) {
      this.emitProfileFailure(
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

    const mediaKeys = [...this.collectMediaFields(profile), ...profile.consentDocuments];

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

    await this.deleteMediaFiles(mediaKeys);
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.auditSuccess(
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

  private static readonly STATS_ROW_CAP = 20_000;

  private bucketKey(date: Date, interval: StatsInterval): string {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    if (interval === StatsInterval.WEEK) {
      const day = (d.getUTCDay() + 6) % 7; // Monday start
      d.setUTCDate(d.getUTCDate() - day);
    } else if (interval === StatsInterval.MONTH) {
      d.setUTCDate(1);
    }
    return d.toISOString().slice(0, 10);
  }

  // Earliest audit event of the given actions per profile (first review / decision times).
  private async firstAuditTimes(
    ids: string[],
    actions: AuditEventEnum[],
  ): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    for (const part of chunk(ids, 1000)) {
      const rows = await this.prisma.auditLog.groupBy({
        by: ['entityId'],
        where: {
          entity: 'VictimProfile',
          entityId: { in: part },
          action: { in: actions },
          outcome: AuditOutcome.SUCCESS,
        },
        _min: { createdAt: true },
        orderBy: { entityId: 'asc' },
      });
      for (const r of rows)
        if (r.entityId && r._min.createdAt) out.set(r.entityId, r._min.createdAt);
    }
    return out;
  }

  // VP-91
  async getStatsTimeline(_admin: CurrentUserDto, query: StatsTimelineQueryDto) {
    const interval = query.interval ?? StatsInterval.DAY;
    const rows = await this.prisma.victimProfile.findMany({
      where: this.statsWhere(query),
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: VictimProfileService.STATS_ROW_CAP,
    });

    const buckets = new Map<string, number>();
    for (const r of rows) {
      const k = this.bucketKey(r.createdAt, interval);
      buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
    return {
      interval,
      truncated: rows.length >= VictimProfileService.STATS_ROW_CAP,
      series: [...buckets.entries()].map(([date, count]) => ({ date, count })),
    };
  }

  // VP-92
  async getStatsByStatus(_admin: CurrentUserDto, query: StatsQueryDto) {
    const grouped = await this.prisma.victimProfile.groupBy({
      by: ['status'],
      where: this.statsWhere(query),
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });
    const counts = Object.fromEntries(
      Object.values(VictimProfileStatus).map((s) => [s, 0]),
    ) as Record<VictimProfileStatus, number>;
    for (const r of grouped) counts[r.status] = r._count._all;
    return { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts };
  }

  // VP-93
  async getStatsByCategory(_admin: CurrentUserDto, query: StatsQueryDto) {
    const grouped = await this.prisma.victimProfile.groupBy({
      by: ['supportType'],
      where: this.statsWhere(query),
      _count: { _all: true },
      _sum: { totalRaised: true },
      orderBy: { supportType: 'asc' },
    });
    return grouped.map((r) => ({
      category: r.supportType ?? 'UNSPECIFIED',
      count: r._count._all,
      totalRaised: money(r._sum.totalRaised),
    }));
  }

  // VP-94  (derived from the audit trail, so it also covers decisions made by the older methods)
  async getStatsReviewTime(_admin: CurrentUserDto, query: StatsQueryDto) {
    const profiles = await this.prisma.victimProfile.findMany({
      where: this.statsWhere(query),
      select: { id: true, createdAt: true, involvesChild: true },
      orderBy: { createdAt: 'desc' },
      take: VictimProfileService.STATS_ROW_CAP,
    });
    const ids = profiles.map((p) => p.id);

    const [firstReview, decision] = await Promise.all([
      this.firstAuditTimes(ids, FIRST_REVIEW_ACTIONS),
      this.firstAuditTimes(ids, DECISION_ACTIONS),
    ]);

    const collect = (times: Map<string, Date>, child?: boolean) =>
      profiles
        .filter((p) => (child === undefined ? true : p.involvesChild === child) && times.has(p.id))
        .map((p) => hoursBetween(p.createdAt, times.get(p.id) as Date))
        .filter((h) => h >= 0);

    return {
      sampled: profiles.length,
      timeToFirstReview: summarize(collect(firstReview)),
      timeToDecision: summarize(collect(decision)),
      childInvolved: {
        timeToFirstReview: summarize(collect(firstReview, true)),
        timeToDecision: summarize(collect(decision, true)),
      },
      notYetReviewed: profiles.filter((p) => !firstReview.has(p.id)).length,
    };
  }

  // VP-95  (daily count of profiles that existed and were still undecided; default window = last 30 days)
  async getStatsBacklog(_admin: CurrentUserDto, query: StatsQueryDto) {
    const { from, to } = this.parseRange(query);
    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - 29 * 86_400_000);
    if (end.getTime() - start.getTime() > 366 * 86_400_000) {
      throw new BadRequestException('date_range_too_large');
    }

    // The window applies to the days shown, not to which profiles are counted.
    const { createdAt: _ignored, ...baseWhere } = this.statsWhere({
      ...query,
      from: undefined,
      to: undefined,
    }) as Prisma.VictimProfileWhereInput & { createdAt?: unknown };
    const profiles = await this.prisma.victimProfile.findMany({
      where: { ...baseWhere, createdAt: { lte: end } },
      select: { id: true, createdAt: true },
      take: VictimProfileService.STATS_ROW_CAP,
    });
    const decided = await this.firstAuditTimes(
      profiles.map((p) => p.id),
      [
        ...DECISION_ACTIONS,
        AuditEventEnum.VICTIM_PROFILE_DELETED,
        AuditEventEnum.VICTIM_PROFILE_WITHDRAWN,
      ],
    );

    const series: Array<{ date: string; pending: number }> = [];
    for (
      let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
      t <= end.getTime();
      t += 86_400_000
    ) {
      const endOfDay = t + 86_400_000 - 1;
      let pending = 0;
      for (const p of profiles) {
        if (p.createdAt.getTime() > endOfDay) continue;
        const d = decided.get(p.id);
        if (!d || d.getTime() > endOfDay) pending += 1;
      }
      series.push({ date: new Date(t).toISOString().slice(0, 10), pending });
    }
    return { series, truncated: profiles.length >= VictimProfileService.STATS_ROW_CAP };
  }

  // VP-96
  async getStatsAging(_admin: CurrentUserDto, query: StatsQueryDto) {
    const where: Prisma.VictimProfileWhereInput = {
      AND: [this.statsWhere(query), { status: { in: PIPELINE_STATUSES } }],
    };
    const rows = await this.prisma.victimProfile.findMany({
      where,
      select: { createdAt: true, involvesChild: true },
      take: VictimProfileService.STATS_ROW_CAP,
    });

    const edges = [
      { label: 'under_24h', max: 24 },
      { label: '1_to_3_days', max: 72 },
      { label: '3_to_7_days', max: 168 },
      { label: '7_to_14_days', max: 336 },
      { label: 'over_14_days', max: Infinity },
    ];
    const buckets = edges.map((e) => ({ bucket: e.label, count: 0, childInvolved: 0 }));
    const now = new Date();
    for (const r of rows) {
      const age = hoursBetween(r.createdAt, now);
      const i = edges.findIndex((e) => age < e.max);
      buckets[i].count += 1;
      if (r.involvesChild) buckets[i].childInvolved += 1;
    }
    return { totalPending: rows.length, buckets };
  }

  // VP-97  (basis: current status. approved = APPROVED / PUBLISHED / COMPLETED, rejected = REJECTED)
  async getStatsApprovalRate(_admin: CurrentUserDto, query: StatsQueryDto) {
    const { byStatus } = await this.getStatsByStatus(_admin, query);
    const approved = APPROVED_OUTCOME_STATUSES.reduce((n, s) => n + byStatus[s], 0);
    const rejected = byStatus[VictimProfileStatus.REJECTED];
    const decided = approved + rejected;
    return {
      basis: 'current_status',
      approved,
      rejected,
      decided,
      approvalRate: decided ? Math.round((approved / decided) * 10_000) / 100 : null,
    };
  }

  // VP-98  (monthly series of PAID support payments: gross, recipient share, platform share, provider fee, paid out)
  async getStatsFunding(_admin: CurrentUserDto, query: StatsQueryDto) {
    const { from, to } = this.parseRange(query);
    const { createdAt: _ignored, ...profileWhere } = this.statsWhere({
      ...query,
      from: undefined,
      to: undefined,
    }) as Prisma.VictimProfileWhereInput & { createdAt?: unknown };

    const payments = await this.prisma.payment.findMany({
      where: {
        type: 'SUPPORT',
        status: 'PAID',
        support: { status: { not: 'CANCELLED' } },
        victimProfile: { is: profileWhere },
        ...(from || to
          ? { paidAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      select: {
        paidAt: true,
        createdAt: true,
        amount: true,
        chapaFee: true,
        allocations: {
          select: {
            partyType: true,
            amount: true,
            disbursements: { where: { status: 'PAID_OUT' }, select: { amount: true } },
          },
        },
      },
      take: VictimProfileService.STATS_ROW_CAP,
    });

    type Row = {
      gross: Prisma.Decimal;
      recipient: Prisma.Decimal;
      platform: Prisma.Decimal;
      providerFee: Prisma.Decimal;
      paidOut: Prisma.Decimal;
      payments: number;
    };
    const zero = (): Row => ({
      gross: new Prisma.Decimal(0),
      recipient: new Prisma.Decimal(0),
      platform: new Prisma.Decimal(0),
      providerFee: new Prisma.Decimal(0),
      paidOut: new Prisma.Decimal(0),
      payments: 0,
    });
    const total = zero();
    const months = new Map<string, Row>();

    for (const p of payments) {
      const key = this.bucketKey(p.paidAt ?? p.createdAt, StatsInterval.MONTH);
      const row = months.get(key) ?? zero();
      for (const target of [row, total]) {
        target.payments += 1;
        target.gross = target.gross.add(p.amount);
        if (p.chapaFee) target.providerFee = target.providerFee.add(p.chapaFee);
        for (const a of p.allocations) {
          if (a.partyType === 'RECIPIENT') {
            target.recipient = target.recipient.add(a.amount);
            for (const d of a.disbursements) target.paidOut = target.paidOut.add(d.amount);
          } else if (a.partyType === 'PLATFORM') {
            target.platform = target.platform.add(a.amount);
          }
        }
      }
      months.set(key, row);
    }

    const fmt = (r: Row) => ({
      payments: r.payments,
      gross: money(r.gross),
      recipientShare: money(r.recipient),
      platformShare: money(r.platform),
      providerFees: money(r.providerFee),
      paidOut: money(r.paidOut),
      awaitingPayout: money(Prisma.Decimal.max(r.recipient.sub(r.paidOut), 0)),
    });

    return {
      currency: 'ETB',
      truncated: payments.length >= VictimProfileService.STATS_ROW_CAP,
      totals: fmt(total),
      series: [...months.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, r]) => ({ month, ...fmt(r) })),
    };
  }

  // VP-99
  async getStatsGoalProgress(_admin: CurrentUserDto, query: StatsQueryDto) {
    const rows = await this.prisma.victimProfile.findMany({
      where: { AND: [this.statsWhere(query), { supportGoal: { gt: 0 } }] },
      select: { supportGoal: true, totalRaised: true },
      take: VictimProfileService.STATS_ROW_CAP,
    });

    const buckets = [
      { bucket: '0_to_24', min: 0, count: 0 },
      { bucket: '25_to_49', min: 25, count: 0 },
      { bucket: '50_to_74', min: 50, count: 0 },
      { bucket: '75_to_99', min: 75, count: 0 },
      { bucket: '100_plus', min: 100, count: 0 },
    ];
    for (const r of rows) {
      const pct = new Prisma.Decimal(r.totalRaised)
        .div(r.supportGoal as Prisma.Decimal)
        .mul(100)
        .toNumber();
      for (let i = buckets.length - 1; i >= 0; i--) {
        if (pct >= buckets[i].min) {
          buckets[i].count += 1;
          break;
        }
      }
    }
    return {
      profilesWithGoal: rows.length,
      buckets: buckets.map(({ bucket, count }) => ({ bucket, count })),
    };
  }

  // VP-100
  async getStatsChildInvolved(_admin: CurrentUserDto, query: StatsQueryDto) {
    const base = this.statsWhere({ ...query, involvesChild: true });
    const [total, byStatus, awaitingFirst, awaitingSecond, reviewed, published] = await Promise.all(
      [
        this.prisma.victimProfile.count({ where: base }),
        this.prisma.victimProfile.groupBy({
          by: ['status'],
          where: base,
          _count: { _all: true },
          orderBy: { status: 'asc' },
        }),
        this.prisma.victimProfile.count({
          where: {
            AND: [
              base,
              {
                isChildSafetyReviewed: false,
                childSafetyFirstConfirmedByUserId: null,
                status: { in: PIPELINE_STATUSES },
              },
            ],
          },
        }),
        this.prisma.victimProfile.count({
          where: {
            AND: [
              base,
              { isChildSafetyReviewed: false, childSafetyFirstConfirmedByUserId: { not: null } },
            ],
          },
        }),
        this.prisma.victimProfile.count({
          where: { AND: [base, { isChildSafetyReviewed: true }] },
        }),
        this.prisma.victimProfile.count({
          where: { AND: [base, { status: VictimProfileStatus.PUBLISHED }] },
        }),
      ],
    );

    return {
      total,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      reviewPath: {
        awaitingFirstConfirmation: awaitingFirst,
        awaitingSecondConfirmation: awaitingSecond,
        childSafetyReviewed: reviewed,
        published,
      },
    };
  }

  // VP-101  (super admin) workload = what each reviewer holds now; speed = created -> decision for decisions they made in range
  async getStatsByAdmin(_admin: CurrentUserDto, query: StatsQueryDto) {
    const where = this.statsWhere({ ...query, assignedTo: undefined });
    const { from, to } = this.parseRange(query);

    const [assigned, claimed, decisions] = await Promise.all([
      this.prisma.victimProfile.groupBy({
        by: ['assignedReviewerId'],
        where: {
          AND: [where, { assignedReviewerId: { not: null }, status: { in: PIPELINE_STATUSES } }],
        },
        _count: { _all: true },
        orderBy: { assignedReviewerId: 'asc' },
      }),
      this.prisma.victimProfile.groupBy({
        by: ['claimedByUserId'],
        where: {
          AND: [where, { claimedByUserId: { not: null }, status: { in: PIPELINE_STATUSES } }],
        },
        _count: { _all: true },
        orderBy: { claimedByUserId: 'asc' },
      }),
      this.prisma.auditLog.findMany({
        where: {
          entity: 'VictimProfile',
          action: { in: [...DECISION_ACTIONS, AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED] },
          outcome: AuditOutcome.SUCCESS,
          userId: { not: null },
          ...(from || to
            ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
            : {}),
        },
        select: { userId: true, entityId: true, action: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: VictimProfileService.STATS_ROW_CAP,
      }),
    ]);

    const created = new Map<string, Date>();
    for (const part of chunk(
      [...new Set(decisions.map((d) => d.entityId).filter((x): x is string => !!x))],
      1000,
    )) {
      const ps = await this.prisma.victimProfile.findMany({
        where: { id: { in: part } },
        select: { id: true, createdAt: true },
      });
      for (const p of ps) created.set(p.id, p.createdAt);
    }

    type Row = {
      assigned: number;
      claimed: number;
      published: number;
      rejected: number;
      changesRequested: number;
      hours: number[];
    };
    const admins = new Map<string, Row>();
    const row = (id: string): Row => {
      const r = admins.get(id) ?? {
        assigned: 0,
        claimed: 0,
        published: 0,
        rejected: 0,
        changesRequested: 0,
        hours: [],
      };
      admins.set(id, r);
      return r;
    };
    for (const a of assigned) row(a.assignedReviewerId as string).assigned = a._count._all;
    for (const c of claimed) row(c.claimedByUserId as string).claimed = c._count._all;
    for (const d of decisions) {
      const r = row(d.userId as string);
      if (d.action === AuditEventEnum.VICTIM_PROFILE_PUBLISHED) r.published += 1;
      else if (d.action === AuditEventEnum.VICTIM_PROFILE_REJECTED) r.rejected += 1;
      else r.changesRequested += 1;
      const c = d.entityId ? created.get(d.entityId) : undefined;
      if (c) r.hours.push(hoursBetween(c, d.createdAt));
    }

    const names = await this.creatorNames([...admins.keys()]);
    return [...admins.entries()].map(([adminId, r]) => ({
      adminId,
      name: names.get(adminId) ?? null,
      currentlyAssigned: r.assigned,
      currentlyClaimed: r.claimed,
      decisions: {
        published: r.published,
        rejected: r.rejected,
        changesRequested: r.changesRequested,
      },
      turnaround: summarize(r.hours.filter((h) => h >= 0)),
    }));
  }

  // VP-102
  async getStatsOverview(admin: CurrentUserDto, query: StatsQueryDto) {
    const [
      byStatus,
      byCategory,
      aging,
      approval,
      funding,
      child,
      reviewTime,
      openFlags,
      openAppeals,
      paused,
    ] = await Promise.all([
      this.getStatsByStatus(admin, query),
      this.getStatsByCategory(admin, query),
      this.getStatsAging(admin, query),
      this.getStatsApprovalRate(admin, query),
      this.getStatsFunding(admin, query),
      this.getStatsChildInvolved(admin, query),
      this.getStatsReviewTime(admin, query),
      this.prisma.victimProfileFlag.count({ where: { status: VictimProfileFlagStatus.OPEN } }),
      this.prisma.victimProfileAppeal.count({ where: { status: VictimProfileAppealStatus.OPEN } }),
      this.prisma.victimProfile.count({
        where: { AND: [this.statsWhere(query), { donationsPaused: true }] },
      }),
    ]);

    return {
      totals: {
        profiles: byStatus.total,
        published: byStatus.byStatus[VictimProfileStatus.PUBLISHED],
        pending: aging.totalPending,
        donationsPaused: paused,
        totalRaised: funding.totals.recipientShare,
      },
      byStatus: byStatus.byStatus,
      byCategory,
      aging: aging.buckets,
      approvalRate: approval,
      funding: funding.totals,
      childInvolved: child,
      reviewTime: {
        timeToFirstReview: reviewTime.timeToFirstReview,
        timeToDecision: reviewTime.timeToDecision,
      },
      queues: { openFlags, openAppeals },
    };
  }
}

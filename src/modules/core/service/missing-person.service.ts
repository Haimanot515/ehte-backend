import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  AuditOutcome,
  AuditSeverity,
  MissingPerson,
  MissingPersonAppealState,
  MissingPersonExportStatus,
  MissingPersonFlagState,
  MissingPersonMessageKind,
  MissingPersonRedactionStatus,
  MissingPersonStatus,
  MissingPersonType,
  MissingPersonUpdateAuthorType,
  Prisma,
  RewardClaimStatus,
} from '@prisma/client';

import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { MinioService } from 'src/services/minio/minio.service';
import { CacheService } from 'src/services/redis/cache.service';
import { RewardService } from 'src/modules/billing/service/reward.service';

import {
  AdminCreateMissingPersonDto,
  AdminEditMissingPersonDto,
  AdminMissingPersonExportDto,
  AdminRenewMissingPersonDto,
  AdminSearchMissingPersonsQueryDto,
  AppealMissingPersonRejectionDto,
  CreateMissingPersonDto,
  CreateMissingPersonUpdateDto,
  DecideMissingPersonAppealDto,
  FlagMissingPersonDto,
  ListMissingPersonAppealsQueryDto,
  ListMissingPersonFlagsQueryDto,
  ListMissingPersonsAdminQueryDto,
  ListMissingPersonsQueryDto,
  MarkAllMissingPersonsReadDto,
  MissingPersonAppealDecision,
  MissingPersonFlagAction,
  MissingPersonFoundReportDto,
  MissingPersonStatsInterval,
  MissingPersonStatsQueryDto,
  MissingPersonStatsTimelineQueryDto,
  PaginationQueryDto,
  RecentMissingPersonsQueryDto,
  RedactMissingPersonMediaDto,
  RenewMissingPersonDto,
  ResolveMissingPersonFlagDto,
  SearchMissingPersonsQueryDto,
  UpdateMissingPersonDto,
} from '../dto/missing-person.dto';

// Media array fields shared by the DTOs and the MissingPerson model.
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

const UPDATABLE_FIELD_NAMES = [
  'personType',
  'name',
  'description',
  'dateLastSeen',
  'lastKnownArea',
  'photo',
  'video',
  'audio',
  'pdf',
  'document',
  'other',
  'rewardOffered',
  'rewardAmount',
  'rewardDetails',
] as const;

type MissingPersonAuditRef = Pick<MissingPerson, 'id' | 'name' | 'personType' | 'userId'>;

// Finished cases: never stale, and only REJECTED counts against a user.
// ASSUMPTION TO VERIFY: EXPIRED/CANCELLED were added to the MissingPersonStatus
// enum (schema change not included in this pass) with no other reference to
// either value anywhere in this file, the controller, or notifications — so
// there's nothing here to confirm the intended semantics against. Treated as
// terminal, same bucket as REJECTED/FOUND, until confirmed otherwise.
const TERMINAL_STATUSES: MissingPersonStatus[] = [
  MissingPersonStatus.REJECTED,
  MissingPersonStatus.FOUND,
  MissingPersonStatus.EXPIRED,
  MissingPersonStatus.CANCELLED,
];

// Cases still waiting on an initial decision.
const BACKLOG_STATUSES: MissingPersonStatus[] = [
  MissingPersonStatus.PENDING,
  MissingPersonStatus.UNDER_REVIEW,
  MissingPersonStatus.MORE_INFORMATION_REQUESTED,
];

type PageQuery = { page?: number; limit?: number };
type BulkResult = {
  succeeded: string[];
  failed: Array<{ id: string; reason: string }>;
};

@Injectable()
export class MissingPersonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly rewardService: RewardService,
  ) {}

  private readonly EDITABLE_STATUSES: MissingPersonStatus[] = [
    MissingPersonStatus.PENDING,
    MissingPersonStatus.MORE_INFORMATION_REQUESTED,
  ];

  // Admin status workflow. PENDING must pass through UNDER_REVIEW first.
  // ASSUMPTION TO VERIFY (see TERMINAL_STATUSES note above): EXPIRED reachable
  // from every pre-FOUND state (a case going stale before resolution);
  // CANCELLED reachable from PENDING/UNDER_REVIEW/MORE_INFORMATION_REQUESTED
  // only (an APPROVED case is close enough to resolution that closing it
  // should go through REJECTED/FOUND, which is what actually distinguishes
  // it for the maybeFlagUserForRejections()/reward-refund paths). Confirm
  // against the real product requirement before relying on this.
  private readonly ALLOWED_TRANSITIONS: Record<MissingPersonStatus, MissingPersonStatus[]> = {
    [MissingPersonStatus.PENDING]: [
      MissingPersonStatus.UNDER_REVIEW,
      MissingPersonStatus.CANCELLED,
      MissingPersonStatus.EXPIRED,
    ],
    [MissingPersonStatus.UNDER_REVIEW]: [
      MissingPersonStatus.MORE_INFORMATION_REQUESTED,
      MissingPersonStatus.APPROVED,
      MissingPersonStatus.REJECTED,
      MissingPersonStatus.CANCELLED,
      MissingPersonStatus.EXPIRED,
    ],
    [MissingPersonStatus.MORE_INFORMATION_REQUESTED]: [
      MissingPersonStatus.CANCELLED,
      MissingPersonStatus.EXPIRED,
    ],
    [MissingPersonStatus.APPROVED]: [MissingPersonStatus.FOUND, MissingPersonStatus.EXPIRED],
    [MissingPersonStatus.REJECTED]: [],
    [MissingPersonStatus.FOUND]: [],
    [MissingPersonStatus.EXPIRED]: [],
    [MissingPersonStatus.CANCELLED]: [],
  };

  // Explicit public projection so new model fields never leak by default.
  private readonly publicSelect = {
    id: true,
    personType: true,
    name: true,
    description: true,
    dateLastSeen: true,
    lastKnownArea: true,
    photo: true,
    video: true,
    audio: true,
    pdf: true,
    document: true,
    other: true,
    status: true,
    createdAt: true,
    updatedAt: true,
    rewardOffered: true,
    rewardApproved: true,
    rewardAmount: true,
    rewardDetails: true,
  } as const;

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // CHILD cases get a redacted label in audit rows.
  private caseLabel(
    missingPerson: Pick<MissingPerson, 'id' | 'name' | 'personType'>,
  ): string | undefined {
    if (missingPerson.personType === MissingPersonType.CHILD) {
      return `Child case ${missingPerson.id.slice(0, 8)}`;
    }
    return missingPerson.name ?? undefined;
  }

  private targetUserFor(
    actor: CurrentUserDto,
    missingPerson: Pick<MissingPerson, 'userId'>,
  ): { targetUserId?: string } {
    const ownerId = missingPerson.userId;
    return ownerId && ownerId !== actor.id ? { targetUserId: ownerId } : {};
  }

  private emitCaseFailure(
    actor: CurrentUserDto,
    action: AuditEventEnum,
    missingPerson: MissingPersonAuditRef,
    reason: string,
    opts: {
      outcome?: AuditOutcome;
      targetUserId?: string;
      diff?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    const outcome = opts.outcome ?? AuditOutcome.FAILURE;

    this.emitAudit({
      userId: actor.id,
      ...(opts.targetUserId ? { targetUserId: opts.targetUserId } : {}),
      actorType: resolveActorType(actor.roles ?? []),
      action,
      outcome,
      severity: AuditSeverity.WARNING,
      entity: 'MissingPerson',
      entityId: missingPerson.id,
      entityLabel: this.caseLabel(missingPerson),
      diff: {
        result: outcome === AuditOutcome.DENIED ? 'denied' : 'failure',
        reason,
        ...(opts.diff ?? {}),
      },
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
  }

  private auditEventForStatus(status: MissingPersonStatus): AuditEventEnum {
    switch (status) {
      case MissingPersonStatus.APPROVED:
        return AuditEventEnum.MISSING_PERSON_APPROVED;
      case MissingPersonStatus.REJECTED:
        return AuditEventEnum.MISSING_PERSON_REJECTED;
      case MissingPersonStatus.FOUND:
        return AuditEventEnum.MISSING_PERSON_FOUND;
      case MissingPersonStatus.MORE_INFORMATION_REQUESTED:
        return AuditEventEnum.MISSING_PERSON_MORE_INFO_REQUESTED;
      default:
        return AuditEventEnum.MISSING_PERSON_UPDATED;
    }
  }

  private collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  private collectMediaFieldsFromDto(dto: MediaBearingDto): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => dto[field] ?? []);
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

  // Checks existence, size and MIME type; returns sizes for the running total.
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
      this.configService.get<string>('MISSING_PERSON_MAX_PHOTOS') ??
        this.configService.get<string>('CONTENT_MAX_PHOTOS') ??
        5,
    );
    const maxVideos = Number(
      this.configService.get<string>('MISSING_PERSON_MAX_VIDEOS') ??
        this.configService.get<string>('CONTENT_MAX_VIDEOS') ??
        1,
    );
    const maxOther = Number(
      this.configService.get<string>('MISSING_PERSON_MAX_OTHER_FILES') ??
        this.configService.get<string>('CONTENT_MAX_OTHER_FILES') ??
        2,
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
      this.configService.get<string>('MISSING_PERSON_MAX_TOTAL_UPLOAD_BYTES') ??
        this.configService.get<string>('CONTENT_MAX_TOTAL_UPLOAD_BYTES') ??
        52_428_800,
    );
    if (totalBytes > maxTotalBytes) {
      throw new BadRequestException(`upload_total_size_exceeded:max_${maxTotalBytes}`);
    }
  }

  // Best-effort; failures never block the DB write.
  private async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  // Reward amount and details are stored only while rewardOffered is true.
  private buildRewardProposalUpdate(
    incoming: { rewardOffered?: boolean; rewardAmount?: number; rewardDetails?: string },
    existing?: {
      rewardOffered: boolean;
      rewardAmount: number | null;
      rewardDetails: string | null;
    },
  ): { rewardOffered: boolean; rewardAmount: number | null; rewardDetails: string | null } | null {
    const touched =
      incoming.rewardOffered !== undefined ||
      incoming.rewardAmount !== undefined ||
      incoming.rewardDetails !== undefined;

    if (!touched && existing) return null;

    const base = existing ?? { rewardOffered: false, rewardAmount: null, rewardDetails: null };

    const rewardOffered = incoming.rewardOffered ?? base.rewardOffered;
    const rewardAmount = rewardOffered
      ? (incoming.rewardAmount ?? base.rewardAmount ?? null)
      : null;
    const rewardDetails = rewardOffered
      ? (incoming.rewardDetails ?? base.rewardDetails ?? null)
      : null;

    return { rewardOffered, rewardAmount, rewardDetails };
  }

  // Hides reward amount and details publicly until an admin approves.
  private maskUnapprovedReward<
    T extends {
      rewardApproved: boolean;
      rewardAmount: number | null;
      rewardDetails: string | null;
    },
  >(record: T): T {
    if (record.rewardApproved) return record;
    return { ...record, rewardAmount: null, rewardDetails: null };
  }

  // Blocks status changes on a case claimed by another admin.
  private assertNotClaimedByOther(
    actor: CurrentUserDto,
    missingPerson: MissingPersonAuditRef & { claimedByUserId: string | null },
    action: AuditEventEnum,
  ): void {
    if (missingPerson.claimedByUserId && missingPerson.claimedByUserId !== actor.id) {
      this.emitCaseFailure(actor, action, missingPerson, 'claimed_by_another_admin', {
        outcome: AuditOutcome.DENIED,
        metadata: { claimedByUserId: missingPerson.claimedByUserId },
      });
      throw new ForbiddenException('missing_person_claimed_by_another_admin');
    }
  }

  async claimMissingPerson(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }
    this.assertNotClaimedByOther(admin, existing, AuditEventEnum.MISSING_PERSON_UPDATED);

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { claimedByUserId: admin.id, claimedAt: new Date() },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: id,
      entityLabel: this.caseLabel(updated),
      diff: { claimedBy: admin.id, result: 'success' },
      metadata: { operation: 'claim' },
    });

    return updated;
  }

  async unclaimMissingPerson(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }
    this.assertNotClaimedByOther(admin, existing, AuditEventEnum.MISSING_PERSON_UPDATED);

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { claimedByUserId: null, claimedAt: null },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: id,
      entityLabel: this.caseLabel(updated),
      diff: { unclaimedBy: admin.id, result: 'success' },
      metadata: { operation: 'unclaim' },
    });

    return updated;
  }

  // CHILD approval needs confirmation from two different admins.
  private async ensureChildSafetySatisfied(
    missingPerson: MissingPersonAuditRef & { childSafetyFirstConfirmedByUserId: string | null },
    admin: CurrentUserDto,
    confirmed: boolean | undefined,
  ): Promise<'not_required' | 'first_confirmation_recorded' | 'satisfied'> {
    if (missingPerson.personType !== MissingPersonType.CHILD) return 'not_required';

    if (confirmed !== true) {
      this.emitCaseFailure(
        admin,
        AuditEventEnum.MISSING_PERSON_APPROVED,
        missingPerson,
        'child_safety_confirmation_required',
      );
      throw new BadRequestException('child_safety_confirmation_required');
    }

    if (!missingPerson.childSafetyFirstConfirmedByUserId) {
      await this.prisma.missingPerson.update({
        where: { id: missingPerson.id },
        data: {
          childSafetyFirstConfirmedByUserId: admin.id,
          childSafetyFirstConfirmedAt: new Date(),
        },
      });
      return 'first_confirmation_recorded';
    }

    if (missingPerson.childSafetyFirstConfirmedByUserId === admin.id) {
      this.emitCaseFailure(
        admin,
        AuditEventEnum.MISSING_PERSON_APPROVED,
        missingPerson,
        'child_safety_requires_second_distinct_admin',
        {
          outcome: AuditOutcome.DENIED,
          metadata: { firstConfirmedBy: missingPerson.childSafetyFirstConfirmedByUserId },
        },
      );
      throw new BadRequestException('child_safety_requires_second_distinct_admin');
    }

    return 'satisfied';
  }

  // Stamps ownerSuspendedAt only; status and review queue are unchanged.
  @OnEvent('user.suspended')
  async handleUserSuspended(payload: { userId: string }): Promise<void> {
    const now = new Date();

    const { count } = await this.prisma.missingPerson.updateMany({
      where: {
        userId: payload.userId,
        status: { notIn: TERMINAL_STATUSES },
        ownerSuspendedAt: null,
      },
      data: { ownerSuspendedAt: now },
    });

    const suspendedUser = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      select: { name: true },
    });

    this.emitAudit({
      targetUserId: payload.userId,
      actorType: 'SYSTEM',
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'User',
      entityId: payload.userId,
      entityLabel: suspendedUser?.name ?? undefined,
      diff: { reason: 'owner_account_suspended', result: 'success' },
      metadata: { casesFlagged: count },
    });
  }

  // Audit flag only; never blocks or rejects anything.
  private async maybeFlagUserForRejections(userId: string): Promise<void> {
    const threshold = Number(
      this.configService.get<string>('MISSING_PERSON_AUTO_FLAG_REJECTION_COUNT') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_REJECTION_COUNT') ??
        3,
    );
    const windowDays = Number(
      this.configService.get<string>('MISSING_PERSON_AUTO_FLAG_WINDOW_DAYS') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_WINDOW_DAYS') ??
        7,
    );
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const recentRejections = await this.prisma.missingPerson.count({
      where: { userId, status: MissingPersonStatus.REJECTED, updatedAt: { gte: since } },
    });

    if (recentRejections >= threshold) {
      const flaggedUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      this.emitAudit({
        targetUserId: userId,
        actorType: 'SYSTEM',
        action: AuditEventEnum.USER_AUTO_FLAGGED,
        entity: 'User',
        entityId: userId,
        entityLabel: flaggedUser?.name ?? undefined,
        diff: {
          reason: 'repeated_missing_person_rejections',
          rejectionCount: recentRejections,
          windowDays,
          result: 'flagged_for_review',
        },
      });
    }
  }

  // G6: both reward-edit write paths (owner update() and admin updateReward())
  // need this same check — once a payer has actually funded the reward
  // (a PAID Payment of type MISSING_PERSON_REWARD exists for this case),
  // the terms shown at checkout time cannot change out from under the
  // escrowed money. Funding itself is already blocked once any PAID
  // payment exists (PaymentService.initiateRewardFunding), so this is the
  // other half: block edits, not just top-ups.
  private async isRewardFunded(missingPersonId: string): Promise<boolean> {
    const count = await this.prisma.payment.count({
      where: { missingPersonId, type: 'MISSING_PERSON_REWARD', status: 'PAID' },
    });
    return count > 0;
  }

  // PRD alignment (Sep 2026): RewardClaim is no longer one row per case, and
  // a case-level refund-due state now lives on MissingPerson.fundingStatus
  // (see reward-claim.prisma / missing-person.prisma) — not a synthetic
  // per-case RewardClaim row. Delegate to RewardService.closeWithoutPayout(),
  // which already rejects any still-open claims and marks fundingStatus
  // REFUND_DUE; it's a no-op (throws BadRequestException) when there's
  // nothing to close.
  private async syncRewardClaimOnClosure(
    adminId: string,
    missingPersonId: string,
    status: MissingPersonStatus,
  ): Promise<void> {
    if (status !== MissingPersonStatus.FOUND && status !== MissingPersonStatus.REJECTED) return;

    const funded = await this.isRewardFunded(missingPersonId);
    if (!funded) return;

    if (status === MissingPersonStatus.FOUND) {
      // A claim already approved or paid out means the reward is
      // legitimately spoken for — closeWithoutPayout() must not run here,
      // since it would flip fundingStatus to REFUND_DUE on money that's
      // already committed (or already sent) to that informant.
      const settledForPayout = await this.prisma.rewardClaim.findFirst({
        where: {
          missingPersonId,
          status: { in: [RewardClaimStatus.APPROVED_FOR_REWARD, RewardClaimStatus.PAID_OUT] },
        },
        select: { id: true },
      });
      if (settledForPayout) return;
    }

    const reason =
      status === MissingPersonStatus.REJECTED
        ? 'case_rejected_after_funding'
        : 'case_found_with_no_approved_informant';

    try {
      await this.rewardService.closeWithoutPayout(adminId, missingPersonId, reason);
    } catch (err) {
      if (!(err instanceof BadRequestException)) throw err;
    }
  }

  async getMediaDownloadUrlForOwner(
    user: CurrentUserDto,
    id: string,
    key: string,
  ): Promise<{ url: string }> {
    const missingPerson = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (missingPerson.userId !== user.id) {
      this.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED,
        missingPerson,
        'not_case_owner',
        {
          outcome: AuditOutcome.DENIED,
          targetUserId: missingPerson.userId ?? undefined,
          metadata: { requestedKey: key },
        },
      );
      throw new NotFoundException('missing_person_not_found');
    }

    const owned = this.collectMediaFields(missingPerson).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  async getMediaDownloadUrl(
    admin: CurrentUserDto,
    id: string,
    key: string,
  ): Promise<{ url: string }> {
    const missingPerson = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    const owned = this.collectMediaFields(missingPerson).includes(key);
    if (!owned) {
      this.emitCaseFailure(
        admin,
        AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED,
        missingPerson,
        'media_not_found_on_missing_person',
        {
          outcome: AuditOutcome.DENIED,
          ...this.targetUserFor(admin, missingPerson),
          metadata: { requestedKey: key },
        },
      );
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, missingPerson),
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED,
      entity: 'MissingPerson',
      entityId: id,
      entityLabel: this.caseLabel(missingPerson),
      diff: { result: 'success' },
      metadata: { key },
    });

    return { url };
  }

  async getPublicMediaDownloadUrl(id: string, key: string): Promise<{ url: string }> {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: this.publicSelect,
    });

    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }

    const owned = this.collectMediaFields(missingPerson).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  private async enforceCreateRateLimit(userId: string): Promise<void> {
    const cooldownSeconds = Number(
      this.configService.get<string>('MISSING_PERSON_CREATE_RATE_LIMIT_WINDOW_SECONDS') ??
        this.configService.get<string>('CONTENT_CREATE_RATE_LIMIT_WINDOW_SECONDS') ??
        60,
    );

    const last = await this.prisma.missingPerson.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (last && Date.now() - last.createdAt.getTime() < cooldownSeconds * 1000) {
      throw new BadRequestException('missing_person_creation_rate_limited');
    }
  }

  private async enforceMaxPending(userId: string): Promise<void> {
    const maxPending = Number(
      this.configService.get<string>('MISSING_PERSON_MAX_PENDING_PER_USER') ??
        this.configService.get<string>('CONTENT_MAX_PENDING_PER_USER') ??
        5,
    );

    const pendingCount = await this.prisma.missingPerson.count({
      where: { userId, status: MissingPersonStatus.PENDING },
    });

    if (pendingCount >= maxPending) {
      throw new BadRequestException('too_many_pending_missing_person_submissions');
    }
  }

  // Shared by create() and createByAdmin(): media limits, MinIO checks, total size.
  private async buildCreateInput(data: CreateMissingPersonDto) {
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

    return { merged, totalBytes };
  }

  async create(user: CurrentUserDto, data: CreateMissingPersonDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.missingPerson.findFirst({
        where: { userId: user.id, idempotencyKey },
      });
      if (existing) {
        return existing;
      }
    }

    await this.enforceCreateRateLimit(user.id);
    await this.enforceMaxPending(user.id);

    const { merged, totalBytes } = await this.buildCreateInput(data);

    const rewardProposal = this.buildRewardProposalUpdate(data)!;

    const missingPerson = await this.createWithIdempotencyRaceHandling(
      user,
      data,
      merged,
      totalBytes,
      rewardProposal,
      { status: MissingPersonStatus.PENDING, rewardApproved: false },
      idempotencyKey,
    );

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_CREATED,
      entity: 'MissingPerson',
      entityId: missingPerson.id,
      entityLabel: this.caseLabel(missingPerson),
      diff: {
        personType: missingPerson.personType,
        status: missingPerson.status,
        result: 'success',
      },
      metadata: {
        rewardOffered: missingPerson.rewardOffered,
        attachmentCount: this.collectMediaFields(merged).length,
        mediaTotalBytes: totalBytes,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.NEW_MISSING_PERSON_REQUEST, {
      missingPersonId: missingPerson.id,
      userId: user.id,
    });

    return missingPerson;
  }

  // ─────────────────────────────────────────────
  // ADMIN — DASHBOARD STATISTICS
  // GET /missing-persons/stats
  //
  // Same "advanced stats" shape as Report/Post: counts by status and
  // personType, reward metrics, claimed cases, pending child-safety
  // dual-control confirmations, resolution rate (FOUND / total),
  // average time PENDING->APPROVED and APPROVED->FOUND, tip volume
  // from InformationSubmission (since tips are user-submitted against
  // these cases), and a 30-day daily creation trend for charting.
  // Uses $queryRaw for the aggregates Prisma's query builder can't
  // express (date_trunc grouping, EPOCH-based duration averages) —
  // same Postgres assumption as the rest of the schema.
  //
  // NOTE: a second, simpler getStats() was introduced further down
  // this file (just before update()) by the azure/dev branch, which
  // would have collided with this one (duplicate method name). It's
  // been dropped in favor of this version, since this is the one
  // both branches already agreed on before that change landed.
  // ─────────────────────────────────────────────
  async getStats() {
    const [
      total,
      statusGrouped,
      typeGrouped,
      claimedCount,
      rewardOfferedCount,
      rewardApprovedCount,
      pendingChildSafetyConfirmation,
      totalInformationSubmissions,
      pendingToApprovedAgg,
      approvedToFoundAgg,
      dailyTrend,
    ] = await this.prisma.$transaction([
      this.prisma.missingPerson.count(),

      this.prisma.missingPerson.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),

      this.prisma.missingPerson.groupBy({
        by: ['personType'],
        _count: { personType: true },
        orderBy: { personType: 'asc' },
      }),

      this.prisma.missingPerson.count({ where: { claimedByUserId: { not: null } } }),
      this.prisma.missingPerson.count({ where: { rewardOffered: true } }),
      this.prisma.missingPerson.count({ where: { rewardApproved: true } }),

      this.prisma.missingPerson.count({
        where: {
          personType: MissingPersonType.CHILD,
          childSafetyFirstConfirmedByUserId: { not: null },
          status: MissingPersonStatus.UNDER_REVIEW,
        },
      }),

      this.prisma.informationSubmission.count(),

      this.prisma.$queryRaw<{ avg_hours: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) / 3600) AS avg_hours
        FROM "MissingPerson"
        WHERE status = 'APPROVED'
      `,

      this.prisma.$queryRaw<{ avg_hours: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) / 3600) AS avg_hours
        FROM "MissingPerson"
        WHERE status = 'FOUND'
      `,

      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "MissingPerson"
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY day
        ORDER BY day ASC
      `,
    ]);

    const byStatus = Object.fromEntries(
      Object.values(MissingPersonStatus).map((status) => [status, 0]),
    ) as Record<MissingPersonStatus, number>;

    for (const row of statusGrouped) {
      const c = row._count as { status?: number } | undefined;
      byStatus[row.status] = c?.status ?? 0;
    }

    const byPersonType = Object.fromEntries(
      Object.values(MissingPersonType).map((type) => [type, 0]),
    ) as Record<MissingPersonType, number>;

    for (const row of typeGrouped) {
      const c = row._count as { personType?: number } | undefined;
      byPersonType[row.personType] = c?.personType ?? 0;
    }

    const rejected = byStatus[MissingPersonStatus.REJECTED] ?? 0;
    const found = byStatus[MissingPersonStatus.FOUND] ?? 0;

    return {
      total,
      byStatus,
      byPersonType,

      claimedCount,
      pendingChildSafetyConfirmation,

      reward: {
        offeredCount: rewardOfferedCount,
        approvedCount: rewardApprovedCount,
      },

      rejectionRate: total > 0 ? Number((rejected / total).toFixed(4)) : 0,
      resolutionRate: total > 0 ? Number((found / total).toFixed(4)) : 0,

      avgApprovalHours:
        pendingToApprovedAgg[0]?.avg_hours != null
          ? Number(Number(pendingToApprovedAgg[0].avg_hours).toFixed(2))
          : null,
      avgTimeToFoundHours:
        approvedToFoundAgg[0]?.avg_hours != null
          ? Number(Number(approvedToFoundAgg[0].avg_hours).toFixed(2))
          : null,

      informationSubmissions: {
        total: totalInformationSubmissions,
        avgPerCase: total > 0 ? Number((totalInformationSubmissions / total).toFixed(2)) : 0,
      },

      dailyTrend: dailyTrend.map((row) => ({
        date: row.day.toISOString().slice(0, 10),
        count: Number(row.count),
      })),
    };
  }

  // Admin-created case. Owner is the admin; skips cooldown and pending cap.
  // CHILD cases start UNDER_REVIEW so the two-admin approval still applies.
  async createByAdmin(
    admin: CurrentUserDto,
    data: AdminCreateMissingPersonDto,
    idempotencyKey?: string,
  ) {
    if (idempotencyKey) {
      const existing = await this.prisma.missingPerson.findFirst({
        where: { userId: admin.id, idempotencyKey },
      });
      if (existing) return existing;
    }

    const { merged, totalBytes } = await this.buildCreateInput(data);
    const rewardProposal = this.buildRewardProposalUpdate(data)!;

    // An admin can approve a reward only if one was offered with an amount.
    const rewardApproved = data.rewardApproved === true;
    if (rewardApproved && (!rewardProposal.rewardOffered || rewardProposal.rewardAmount === null)) {
      throw new BadRequestException('cannot_approve_reward_without_offer_and_amount');
    }

    const status =
      data.personType === MissingPersonType.CHILD
        ? MissingPersonStatus.UNDER_REVIEW
        : MissingPersonStatus.APPROVED;

    const missingPerson = await this.createWithIdempotencyRaceHandling(
      admin,
      data,
      merged,
      totalBytes,
      rewardProposal,
      { status, rewardApproved },
      idempotencyKey,
    );

    // A non-CHILD admin-created case is born APPROVED — it's immediately public.
    if (status === MissingPersonStatus.APPROVED) {
      await this.cache.invalidateMissingPersonCaches();
    }

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_CREATED,
      entity: 'MissingPerson',
      entityId: missingPerson.id,
      entityLabel: this.caseLabel(missingPerson),
      diff: {
        personType: missingPerson.personType,
        status: missingPerson.status,
        result: 'success',
      },
      metadata: {
        operation: 'admin_create',
        rewardOffered: missingPerson.rewardOffered,
        rewardApproved: missingPerson.rewardApproved,
        attachmentCount: this.collectMediaFields(merged).length,
        mediaTotalBytes: totalBytes,
      },
    });

    // Only cases still needing a second admin go to the admin queue.
    if (status !== MissingPersonStatus.APPROVED) {
      this.eventEmitter.emit(NotificationEventEnum.NEW_MISSING_PERSON_REQUEST, {
        missingPersonId: missingPerson.id,
        userId: admin.id,
      });
    }

    return missingPerson;
  }

  // Returns the winning row if a concurrent retry hits the idempotency constraint.
  private async createWithIdempotencyRaceHandling(
    user: CurrentUserDto,
    data: CreateMissingPersonDto,
    merged: MediaBearing,
    totalBytes: number,
    rewardProposal: {
      rewardOffered: boolean;
      rewardAmount: number | null;
      rewardDetails: string | null;
    },
    initial: { status: MissingPersonStatus; rewardApproved: boolean },
    idempotencyKey?: string,
  ) {
    try {
      return await this.prisma.missingPerson.create({
        data: {
          userId: user.id,
          personType: data.personType,
          name: data.name,
          description: data.description,
          dateLastSeen: new Date(data.dateLastSeen),
          lastKnownArea: data.lastKnownArea,
          photo: merged.photo,
          video: merged.video,
          audio: merged.audio,
          pdf: merged.pdf,
          document: merged.document,
          other: merged.other,
          mediaTotalBytes: totalBytes,
          status: initial.status,
          rewardApproved: initial.rewardApproved,
          rewardOffered: rewardProposal.rewardOffered,
          rewardAmount: rewardProposal.rewardAmount,
          rewardDetails: rewardProposal.rewardDetails,
          idempotencyKey: idempotencyKey ?? null,
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
          const winner = await this.prisma.missingPerson.findFirst({
            where: { userId: user.id, idempotencyKey },
          });
          if (winner) {
            return winner;
          }
        }
      }
      throw err;
    }
  }

  async findOne(id: string) {
    type PublicMissingPerson = Prisma.MissingPersonGetPayload<{ select: typeof this.publicSelect }>;

    const cached = await this.cache.getMissingPerson<PublicMissingPerson>(id);
    if (cached !== null) return cached;

    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: this.publicSelect,
    });

    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }

    const masked = this.maskUnapprovedReward(missingPerson);
    await this.cache.setMissingPerson(id, masked);
    return masked;
  }

  async findAll(query: ListMissingPersonsQueryDto) {
    return this.cache.wrapMissingPersonList(query as unknown as Record<string, unknown>, () =>
      this.findAllUncached(query),
    );
  }

  private async findAllUncached(query: ListMissingPersonsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      status: MissingPersonStatus.APPROVED,
      ...(query.type !== undefined ? { personType: query.type } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        select: this.publicSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data: data.map((item) => this.maskUnapprovedReward(item)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findMine(user: CurrentUserDto, query: ListMissingPersonsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { userId: user.id };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // Informational only; nothing here changes status, ownership or claim.
  async findStalePending() {
    const staleHours = Number(
      this.configService.get<string>('MISSING_PERSON_STALE_PENDING_HOURS') ??
        this.configService.get<string>('CONTENT_STALE_PENDING_HOURS') ??
        48,
    );
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

    const items = await this.prisma.missingPerson.findMany({
      where: {
        status: { notIn: TERMINAL_STATUSES },
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
    });

    return items.map((item) => ({
      ...item,
      pendingHours: Math.floor((Date.now() - item.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
  }

  // Only PENDING / MORE_INFORMATION_REQUESTED cases are editable (EDITABLE_STATUSES),
  // and neither is ever public (findOne/findAll require APPROVED), so nothing this
  // method touches can already be in the public cache — no invalidation needed here.
  async update(user: CurrentUserDto, id: string, data: UpdateMissingPersonDto) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (existing.userId !== user.id) {
      this.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'not_authorized_to_update',
        { outcome: AuditOutcome.DENIED, targetUserId: existing.userId ?? undefined },
      );
      throw new ForbiddenException('not_authorized_to_update');
    }

    if (!this.EDITABLE_STATUSES.includes(existing.status)) {
      this.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'submission_not_editable_in_current_status',
        { diff: { currentStatus: existing.status } },
      );
      throw new ForbiddenException('submission_not_editable_in_current_status');
    }

    const hasAnyField = Object.values(data).some((value) => value !== undefined);

    if (!hasAnyField) {
      this.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'no_fields_provided',
      );
      throw new BadRequestException('no_fields_provided');
    }

    const { added, removed } = this.diffMediaFields(existing, data);

    const merged: MediaBearing = {
      photo: data.photo ?? existing.photo,
      video: data.video ?? existing.video,
      audio: data.audio ?? existing.audio,
      pdf: data.pdf ?? existing.pdf,
      document: data.document ?? existing.document,
      other: data.other ?? existing.other,
    };

    let newTotalBytes = existing.mediaTotalBytes;

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

      newTotalBytes = Math.max(0, existing.mediaTotalBytes + addedBytes - removedBytes);
      this.assertTotalBytes(newTotalBytes);
    } catch (err) {
      this.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'media_validation_failed',
        { diff: { message: err instanceof Error ? err.message : String(err) } },
      );
      throw err;
    }

    const shouldReturnToPending =
      existing.status === MissingPersonStatus.MORE_INFORMATION_REQUESTED;

    const rewardUpdate = this.buildRewardProposalUpdate(data, existing);

    // G6: rewardApproved (and therefore funding) is independent of case
    // status — see updateReward()'s own comment — so EDITABLE_STATUSES
    // above does not by itself guarantee a funded reward can't reach here.
    if (rewardUpdate !== null && (await this.isRewardFunded(id))) {
      this.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'reward_terms_locked_once_funded',
        { metadata: { operation: 'reward_edit_blocked' } },
      );
      throw new ConflictException('reward_terms_locked_once_funded');
    }

    // Changing the terms of an approved reward resets its approval.
    const rewardTermsChanged =
      rewardUpdate !== null &&
      (rewardUpdate.rewardOffered !== existing.rewardOffered ||
        rewardUpdate.rewardAmount !== existing.rewardAmount ||
        rewardUpdate.rewardDetails !== existing.rewardDetails);
    const shouldResetRewardApproval = rewardTermsChanged && existing.rewardApproved;

    const fieldsUpdated = UPDATABLE_FIELD_NAMES.filter((field) => data[field] !== undefined);

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: {
        ...(data.personType !== undefined ? { personType: data.personType } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.dateLastSeen !== undefined ? { dateLastSeen: new Date(data.dateLastSeen) } : {}),
        ...(data.lastKnownArea !== undefined ? { lastKnownArea: data.lastKnownArea } : {}),
        ...(data.photo !== undefined ? { photo: data.photo } : {}),
        ...(data.video !== undefined ? { video: data.video } : {}),
        ...(data.audio !== undefined ? { audio: data.audio } : {}),
        ...(data.pdf !== undefined ? { pdf: data.pdf } : {}),
        ...(data.document !== undefined ? { document: data.document } : {}),
        ...(data.other !== undefined ? { other: data.other } : {}),
        ...(rewardUpdate !== null
          ? {
              rewardOffered: rewardUpdate.rewardOffered,
              rewardAmount: rewardUpdate.rewardAmount,
              rewardDetails: rewardUpdate.rewardDetails,
            }
          : {}),
        ...(shouldResetRewardApproval ? { rewardApproved: false } : {}),
        ...(shouldReturnToPending ? { status: MissingPersonStatus.PENDING } : {}),
        mediaTotalBytes: newTotalBytes,
      },
    });

    // Delete removed files only after the DB write commits.
    await this.deleteMediaFiles(removed);

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: updated.id,
      entityLabel: this.caseLabel(updated),
      diff: {
        returnedToPending: shouldReturnToPending,
        previousStatus: existing.status,
        currentStatus: updated.status,
        rewardApprovalReset: shouldResetRewardApproval,
        result: 'success',
      },
      metadata: {
        fieldsUpdated,
        mediaAdded: added.length,
        mediaRemoved: removed.length,
        mediaTotalBytes: newTotalBytes,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.MISSING_PERSON_UPDATED, {
      userId: existing.userId,
      missingPersonId: updated.id,
      status: updated.status,
    });

    return updated;
  }

  // Only PENDING cases can be deleted, and PENDING is never public — no invalidation needed.
  async remove(user: CurrentUserDto, id: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (existing.userId !== user.id) {
      this.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_DELETED,
        existing,
        'not_authorized_to_delete',
        { outcome: AuditOutcome.DENIED, targetUserId: existing.userId ?? undefined },
      );
      throw new ForbiddenException('not_authorized_to_delete');
    }

    if (existing.status !== MissingPersonStatus.PENDING) {
      this.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_DELETED,
        existing,
        'only_pending_submissions_can_be_deleted',
        { diff: { currentStatus: existing.status } },
      );
      throw new ForbiddenException('only_pending_submissions_can_be_deleted');
    }

    await this.prisma.missingPerson.delete({ where: { id } });

    const mediaKeys = this.collectMediaFields(existing);
    await this.deleteMediaFiles(mediaKeys);

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_DELETED,
      entity: 'MissingPerson',
      entityId: id,
      entityLabel: this.caseLabel(existing),
      diff: {
        previousStatus: existing.status,
        result: 'success',
      },
      metadata: {
        mediaFilesDeleted: mediaKeys.length,
        mediaTotalBytes: existing.mediaTotalBytes,
        rewardOffered: existing.rewardOffered,
      },
    });

    return { message: 'missing_person_deleted' };
  }

  async findAllForAdmin(query: ListMissingPersonsAdminQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { ...(query.status !== undefined ? { status: query.status } : {}) };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOneForAdmin(id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      include: { informationSubmissions: true },
    });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    return missingPerson;
  }

  async getHistory(id: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    return this.prisma.auditLog.findMany({
      where: { entity: 'MissingPerson', entityId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateStatus(
    admin: CurrentUserDto,
    id: string,
    status: MissingPersonStatus,
    reviewNote?: string,
    childSafetyConfirmed?: boolean,
  ) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (existing.status === status) {
      return existing;
    }

    const auditEvent = this.auditEventForStatus(status);

    this.assertNotClaimedByOther(admin, existing, auditEvent);

    const allowedNext = this.ALLOWED_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(status)) {
      this.emitCaseFailure(admin, auditEvent, existing, 'invalid_status_transition', {
        diff: { attemptedStatus: status, currentStatus: existing.status },
      });
      throw new BadRequestException(`invalid_status_transition: ${existing.status} -> ${status}`);
    }

    if (
      (status === MissingPersonStatus.REJECTED ||
        status === MissingPersonStatus.MORE_INFORMATION_REQUESTED) &&
      !reviewNote?.trim()
    ) {
      this.emitCaseFailure(admin, auditEvent, existing, 'review_note_required_for_this_status', {
        diff: { attemptedStatus: status, currentStatus: existing.status },
      });
      throw new BadRequestException('review_note_required_for_this_status');
    }

    const isChildApproval =
      status === MissingPersonStatus.APPROVED && existing.personType === MissingPersonType.CHILD;

    if (isChildApproval) {
      const safety = await this.ensureChildSafetySatisfied(existing, admin, childSafetyConfirmed);
      if (safety === 'first_confirmation_recorded') {
        // Not yet APPROVED — nothing public changes, so no cache invalidation here.
        const partial = await this.prisma.missingPerson.findUniqueOrThrow({ where: { id } });
        this.emitAudit({
          userId: admin.id,
          ...this.targetUserFor(admin, existing),
          actorType: resolveActorType(admin.roles ?? []),
          action: AuditEventEnum.MISSING_PERSON_UPDATED,
          entity: 'MissingPerson',
          entityId: id,
          entityLabel: this.caseLabel(existing),
          reason: reviewNote ?? null,
          diff: {
            childSafetyFirstConfirmationBy: admin.id,
            result: 'pending_second_admin_confirmation',
          },
          metadata: { operation: 'child_safety_first_confirmation' },
        });
        return { ...partial, pendingSecondConfirmation: true };
      }
    }

    const result = await this.prisma.missingPerson.updateMany({
      where: { id, status: existing.status },
      data: {
        status,
        ...(reviewNote !== undefined ? { reviewNote } : {}),
        claimedByUserId: null,
        claimedAt: null,
      },
    });

    if (result.count === 0) {
      this.emitCaseFailure(admin, auditEvent, existing, 'missing_person_transition_conflict', {
        diff: { attemptedStatus: status, currentStatus: existing.status },
      });
      throw new BadRequestException('missing_person_transition_conflict');
    }

    const updated = await this.prisma.missingPerson.findUniqueOrThrow({ where: { id } });

    // Only transitions into or out of APPROVED change public visibility, but every
    // transition that reaches here has already passed ALLOWED_TRANSITIONS, so
    // invalidating unconditionally is simple and cheap (short TTLs, no-op if unused).
    await this.cache.invalidateMissingPersonEverywhere(id);

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, existing),
      actorType: resolveActorType(admin.roles ?? []),
      action: auditEvent,
      entity: 'MissingPerson',
      entityId: updated.id,
      entityLabel: this.caseLabel(updated),
      reason: reviewNote ?? null,
      diff: {
        previousStatus: existing.status,
        newStatus: updated.status,
        ...(isChildApproval ? { childSafetyDualControlSatisfied: true } : {}),
        result: 'success',
      },
      metadata: {
        claimReleased: existing.claimedByUserId !== null,
        ...(isChildApproval
          ? {
              childSafetyFirstConfirmedBy: existing.childSafetyFirstConfirmedByUserId,
              childSafetySecondConfirmedBy: admin.id,
            }
          : {}),
      },
    });

    let notificationEvent: NotificationEventEnum;

    switch (status) {
      case MissingPersonStatus.APPROVED:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_APPROVED;
        break;

      case MissingPersonStatus.REJECTED:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_REJECTED;
        break;

      case MissingPersonStatus.FOUND:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_FOUND;
        break;

      case MissingPersonStatus.MORE_INFORMATION_REQUESTED:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_MORE_INFORMATION_REQUESTED;
        break;

      default:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_UPDATED;
        break;
    }

    this.eventEmitter.emit(notificationEvent, {
      userId: existing.userId,
      missingPersonId: updated.id,
      previousStatus: existing.status,
      status: updated.status,
      reviewNote,
    });

    if (status === MissingPersonStatus.REJECTED && existing.userId) {
      await this.maybeFlagUserForRejections(existing.userId);
    }

    await this.syncRewardClaimOnClosure(admin.id, id, status);

    return updated;
  }

  // Independent of the status workflow and claims. Approval needs an existing offer and amount.
  async updateReward(
    admin: CurrentUserDto,
    id: string,
    rewardApproved: boolean,
    rewardAmount?: number,
    rewardDetails?: string,
  ) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    // G6: this is one of two write paths onto rewardApproved/rewardAmount
    // (the other being RewardService.approveOffer, REWARDS_APPROVE) — once
    // a PAID payment exists against this case, neither should be able to
    // move the terms the payer actually funded. autoCorrect-free: there is
    // no legitimate reason to touch this endpoint post-funding, so it's a
    // hard block rather than a partial one.
    if (await this.isRewardFunded(id)) {
      this.emitCaseFailure(
        admin,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'reward_terms_locked_once_funded',
        { metadata: { operation: 'reward_review_blocked' } },
      );
      throw new ConflictException('reward_terms_locked_once_funded');
    }

    if (rewardApproved && !existing.rewardOffered) {
      this.emitCaseFailure(
        admin,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'cannot_approve_reward_that_was_not_offered',
        { metadata: { operation: 'reward_review' } },
      );
      throw new BadRequestException('cannot_approve_reward_that_was_not_offered');
    }

    const finalAmount = rewardAmount !== undefined ? rewardAmount : existing.rewardAmount;
    const finalDetails = rewardDetails !== undefined ? rewardDetails : existing.rewardDetails;

    if (rewardApproved && (finalAmount === undefined || finalAmount === null)) {
      this.emitCaseFailure(
        admin,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'reward_amount_required_when_approved',
        { metadata: { operation: 'reward_review' } },
      );
      throw new BadRequestException('reward_amount_required_when_approved');
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: {
        rewardApproved,
        rewardAmount: finalAmount,
        rewardDetails: finalDetails,
      },
    });

    // rewardApproved/rewardAmount/rewardDetails feed maskUnapprovedReward() on the
    // public detail/list views, so any change here can change what's shown publicly.
    await this.cache.invalidateMissingPersonEverywhere(id);

    this.emitAudit({
      userId: admin.id,
      ...this.targetUserFor(admin, existing),
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: id,
      entityLabel: this.caseLabel(updated),
      diff: {
        previousRewardApproved: existing.rewardApproved,
        previousRewardAmount: existing.rewardAmount,
        previousRewardDetails: existing.rewardDetails,
        rewardApproved: updated.rewardApproved,
        rewardAmount: updated.rewardAmount,
        rewardDetails: updated.rewardDetails,
        result: 'success',
      },
      metadata: {
        operation: 'reward_review',
        amountOverriddenByAdmin:
          rewardAmount !== undefined && rewardAmount !== existing.rewardAmount,
        detailsOverriddenByAdmin:
          rewardDetails !== undefined && rewardDetails !== existing.rewardDetails,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.MISSING_PERSON_UPDATED, {
      userId: existing.userId,
      missingPersonId: updated.id,
      status: updated.status,
      rewardApproved: updated.rewardApproved,
      rewardAmount: updated.rewardAmount,
    });

    return updated;
  }

  // ═════════════════════════════════════════════════════════════════
  // NEW ENDPOINTS — everything below was added; nothing above changed
  // except the import block and the two small constants near the top.
  // ═════════════════════════════════════════════════════════════════

  // ───────────── shared helpers for the new methods ─────────────

  private pageArgs(query: PageQuery): { page: number; limit: number; skip: number } {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return { page, limit, skip: (page - 1) * limit };
  }

  private pageMeta(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  // DTO enums and Prisma enums share string values but are different TS types.
  private asEnum<T extends string>(value: string | undefined): T | undefined {
    return value as T | undefined;
  }

  // Deleted and merged cases are hidden from the admin queues below.
  private readonly adminBaseWhere: Prisma.MissingPersonWhereInput = {
    deletedAt: null,
    mergedIntoId: null,
  };

  // Audit actions that mean something to the family, used by the owner timeline and unread badge.
  private readonly familyVisibleActions: string[] = [
    AuditEventEnum.MISSING_PERSON_CREATED,
    AuditEventEnum.MISSING_PERSON_APPROVED,
    AuditEventEnum.MISSING_PERSON_REJECTED,
    AuditEventEnum.MISSING_PERSON_FOUND,
    AuditEventEnum.MISSING_PERSON_MORE_INFO_REQUESTED,
    AuditEventEnum.MISSING_PERSON_UPDATED,
  ];

  private auditOp(
    actor: CurrentUserDto,
    missingPerson: MissingPersonAuditRef,
    operation: string,
    diff: Record<string, unknown> = {},
    opts: {
      action?: AuditEventEnum;
      severity?: AuditSeverity;
      reason?: string | null;
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    this.emitAudit({
      userId: actor.id,
      ...this.targetUserFor(actor, missingPerson),
      actorType: resolveActorType(actor.roles ?? []),
      action: opts.action ?? AuditEventEnum.MISSING_PERSON_UPDATED,
      ...(opts.severity ? { severity: opts.severity } : {}),
      entity: 'MissingPerson',
      entityId: missingPerson.id,
      entityLabel: this.caseLabel(missingPerson),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      diff: { ...diff, result: 'success' },
      metadata: { operation, ...(opts.metadata ?? {}) },
    });
  }

  // Same payload shape the existing update() uses for the owner notification.
  private notifyOwner(missingPerson: Pick<MissingPerson, 'id' | 'userId' | 'status'>): void {
    if (!missingPerson.userId) return;
    this.eventEmitter.emit(NotificationEventEnum.MISSING_PERSON_UPDATED, {
      userId: missingPerson.userId,
      missingPersonId: missingPerson.id,
      status: missingPerson.status,
    });
  }

  private async loadCase(id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!missingPerson) throw new NotFoundException('missing_person_not_found');
    return missingPerson;
  }

  private async loadOwnCase(user: CurrentUserDto, id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!missingPerson || missingPerson.userId !== user.id || missingPerson.deletedAt) {
      throw new NotFoundException('missing_person_not_found');
    }
    return missingPerson;
  }

  private async loadApprovedPublic(id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: this.publicSelect,
    });
    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }
    return this.maskUnapprovedReward(missingPerson);
  }

  private async presignKeys(keys: string[]): Promise<Array<{ key: string; url: string | null }>> {
    return Promise.all(
      keys.map(async (key) => {
        try {
          return { key, url: await this.minioService.generatePresignedDownloadUrl(key) };
        } catch {
          return { key, url: null };
        }
      }),
    );
  }

  // The owner never sees internal review fields (claims, assignment, legal hold, takedown reason).
  private toOwnerView(missingPerson: MissingPerson) {
    return {
      id: missingPerson.id,
      personType: missingPerson.personType,
      name: missingPerson.name,
      description: missingPerson.description,
      dateLastSeen: missingPerson.dateLastSeen,
      lastKnownArea: missingPerson.lastKnownArea,
      photo: missingPerson.photo,
      video: missingPerson.video,
      audio: missingPerson.audio,
      pdf: missingPerson.pdf,
      document: missingPerson.document,
      other: missingPerson.other,
      status: missingPerson.status,
      reviewNote: missingPerson.reviewNote,
      createdAt: missingPerson.createdAt,
      updatedAt: missingPerson.updatedAt,
      rewardOffered: missingPerson.rewardOffered,
      rewardApproved: missingPerson.rewardApproved,
      rewardAmount: missingPerson.rewardAmount,
      rewardDetails: missingPerson.rewardDetails,
      fundingStatus: missingPerson.fundingStatus,
      expiresAt: missingPerson.expiresAt,
      renewalCount: missingPerson.renewalCount,
      foundReportedAt: missingPerson.foundReportedAt,
      foundReportResolvedAt: missingPerson.foundReportResolvedAt,
      foundReportConfirmed: missingPerson.foundReportConfirmed,
      closedAt: missingPerson.closedAt,
      closureReason: missingPerson.closureReason,
      takedownAt: missingPerson.takedownAt,
    };
  }

  // ───────────── owner: my cases ─────────────

  async findOneMine(user: CurrentUserDto, id: string) {
    const missingPerson = await this.loadOwnCase(user, id);

    const [messages, pendingAppeal] = await Promise.all([
      this.prisma.missingPersonMessage.findMany({
        where: { missingPersonId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, kind: true, message: true, createdAt: true },
      }),
      this.prisma.missingPersonAppeal.findFirst({
        where: { missingPersonId: id, status: MissingPersonAppealState.PENDING },
        select: { id: true, reason: true, createdAt: true },
      }),
    ]);

    return {
      ...this.toOwnerView(missingPerson),
      requestedChanges:
        missingPerson.status === MissingPersonStatus.MORE_INFORMATION_REQUESTED
          ? missingPerson.reviewNote
          : null,
      messages,
      pendingAppeal,
    };
  }

  async getMySummary(user: CurrentUserDto) {
    const [grouped, openAppeals, pendingFoundReports] = await Promise.all([
      this.prisma.missingPerson.groupBy({
        by: ['status'],
        where: { userId: user.id, deletedAt: null },
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.missingPersonAppeal.count({
        where: { authorId: user.id, status: MissingPersonAppealState.PENDING },
      }),
      this.prisma.missingPerson.count({
        where: { userId: user.id, foundReportedAt: { not: null }, foundReportResolvedAt: null },
      }),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(MissingPersonStatus).map((status) => [status, 0]),
    ) as Record<MissingPersonStatus, number>;
    for (const row of grouped) {
      const c = row._count as { status?: number } | undefined;
      byStatus[row.status] = c?.status ?? 0;
    }

    const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
    return { total, byStatus, openAppeals, pendingFoundReports };
  }

  // A case is unread when a status change or an admin message landed after the owner last opened it.
  async countMyUnreadUpdates(user: CurrentUserDto) {
    const actions = Prisma.join(this.familyVisibleActions);
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM missing_person mp
      WHERE mp."userId" = ${user.id}
        AND mp."deletedAt" IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM audit_log a
            WHERE a.entity = 'MissingPerson'
              AND a."entityId" = mp.id
              AND a.outcome = 'SUCCESS'
              AND a.action IN (${actions})
              AND a.diff->>'newStatus' IS NOT NULL
              AND a."userId" IS DISTINCT FROM mp."userId"
              AND a."createdAt" > COALESCE(mp."ownerLastSeenAt", mp."createdAt")
          )
          OR EXISTS (
            SELECT 1 FROM missing_person_message m
            WHERE m."missingPersonId" = mp.id
              AND m."createdAt" > COALESCE(mp."ownerLastSeenAt", mp."createdAt")
          )
        )
    `;
    return { count: rows[0]?.count ?? 0 };
  }

  async markAllMineSeen(user: CurrentUserDto) {
    const { count } = await this.prisma.missingPerson.updateMany({
      where: { userId: user.id, deletedAt: null },
      data: { ownerLastSeenAt: new Date() },
    });
    return { updated: count };
  }

  async markMineSeen(user: CurrentUserDto, id: string) {
    await this.loadOwnCase(user, id);
    await this.prisma.missingPerson.update({
      where: { id },
      data: { ownerLastSeenAt: new Date() },
    });
    return { id, seen: true };
  }

  // Family-facing timeline: status changes, admin messages, public updates, appeals and found reports.
  async getMyTimeline(user: CurrentUserDto, id: string) {
    const missingPerson = await this.loadOwnCase(user, id);

    const [auditRows, messages, updates, appeals] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          entity: 'MissingPerson',
          entityId: id,
          outcome: AuditOutcome.SUCCESS,
          action: { in: this.familyVisibleActions },
        },
        orderBy: { createdAt: 'asc' },
        select: { action: true, createdAt: true, reason: true, diff: true, userId: true },
      }),
      this.prisma.missingPersonMessage.findMany({
        where: { missingPersonId: id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.missingPersonUpdate.findMany({
        where: { missingPersonId: id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.missingPersonAppeal.findMany({
        where: { missingPersonId: id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    type TimelineEvent = { type: string; at: Date; [key: string]: unknown };
    const events: TimelineEvent[] = [];

    for (const row of auditRows) {
      const diff = (row.diff ?? {}) as Record<string, unknown>;
      if (row.action === AuditEventEnum.MISSING_PERSON_CREATED) {
        events.push({ type: 'SUBMITTED', at: row.createdAt });
        continue;
      }
      const newStatus = diff.newStatus as string | undefined;
      if (!newStatus) continue;
      // Review notes are written for the owner; takedown and delete reasons are internal.
      const showNote =
        newStatus === MissingPersonStatus.REJECTED ||
        newStatus === MissingPersonStatus.MORE_INFORMATION_REQUESTED;
      events.push({
        type: 'STATUS_CHANGED',
        at: row.createdAt,
        previousStatus: diff.previousStatus ?? null,
        status: newStatus,
        note: showNote ? row.reason : null,
      });
    }

    for (const m of messages) {
      events.push({ type: m.kind === 'WARNING' ? 'WARNING' : 'MESSAGE', at: m.createdAt, message: m.message });
    }
    for (const u of updates) {
      events.push({
        type: 'UPDATE_POSTED',
        at: u.createdAt,
        authorType: u.authorType,
        message: u.message,
      });
    }
    for (const a of appeals) {
      events.push({ type: 'APPEAL_SUBMITTED', at: a.createdAt, reason: a.reason });
      if (a.decidedAt) {
        events.push({
          type: 'APPEAL_DECIDED',
          at: a.decidedAt,
          decision: a.status,
          note: a.decisionNote,
        });
      }
    }
    if (missingPerson.foundReportedAt) {
      events.push({ type: 'FOUND_REPORTED', at: missingPerson.foundReportedAt });
    }
    if (missingPerson.foundReportResolvedAt) {
      events.push({
        type: 'FOUND_REPORT_RESOLVED',
        at: missingPerson.foundReportResolvedAt,
        confirmed: missingPerson.foundReportConfirmed,
      });
    }

    events.sort((a, b) => a.at.getTime() - b.at.getTime());
    return { missingPersonId: id, status: missingPerson.status, events };
  }

  async reportFoundByOwner(user: CurrentUserDto, id: string, data: MissingPersonFoundReportDto) {
    const existing = await this.loadOwnCase(user, id);

    if (existing.status !== MissingPersonStatus.APPROVED) {
      this.emitCaseFailure(user, AuditEventEnum.MISSING_PERSON_UPDATED, existing, 'found_report_requires_approved_case', {
        diff: { currentStatus: existing.status },
      });
      throw new BadRequestException('found_report_requires_approved_case');
    }
    if (existing.foundReportedAt && !existing.foundReportResolvedAt) {
      throw new ConflictException('found_report_already_pending');
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: {
        foundReportedAt: new Date(),
        foundReportDetails: data.details,
        foundReportDate: data.dateFound ? new Date(data.dateFound) : null,
        foundReportLocation: data.foundLocation ?? null,
        foundReportResolvedAt: null,
        foundReportConfirmed: null,
      },
    });

    this.auditOp(user, updated, 'owner_found_report', { previousStatus: existing.status });
    return this.toOwnerView(updated);
  }

  // Shared by owner and admin renewal. Extends from the later of now and the current expiry.
  private async applyRenewal(
    actor: CurrentUserDto,
    existing: MissingPerson,
    extendDays: number | undefined,
    operation: string,
    reason?: string,
  ) {
    if (existing.status !== MissingPersonStatus.APPROVED || existing.deletedAt) {
      this.emitCaseFailure(actor, AuditEventEnum.MISSING_PERSON_UPDATED, existing, 'renewal_requires_approved_case', {
        diff: { currentStatus: existing.status },
      });
      throw new BadRequestException('renewal_requires_approved_case');
    }

    const defaultDays = Number(
      this.configService.get<string>('MISSING_PERSON_RENEW_DEFAULT_DAYS') ?? 30,
    );
    const days = extendDays ?? defaultDays;
    const now = new Date();
    const base = existing.expiresAt && existing.expiresAt > now ? existing.expiresAt : now;
    const expiresAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    const updated = await this.prisma.missingPerson.update({
      where: { id: existing.id },
      data: { expiresAt, lastRenewedAt: now, renewalCount: { increment: 1 } },
    });

    this.auditOp(
      actor,
      updated,
      operation,
      {
        previousExpiresAt: existing.expiresAt,
        expiresAt,
        extendDays: days,
      },
      { reason: reason ?? null },
    );
    return updated;
  }

  async renewByOwner(user: CurrentUserDto, id: string, data: RenewMissingPersonDto) {
    const existing = await this.loadOwnCase(user, id);
    const updated = await this.applyRenewal(user, existing, data.extendDays, 'owner_renew');
    return this.toOwnerView(updated);
  }

  async renewByAdmin(admin: CurrentUserDto, id: string, data: AdminRenewMissingPersonDto) {
    const existing = await this.loadCase(id);
    return this.applyRenewal(admin, existing, data.extendDays, 'admin_renew', data.reason);
  }

  // Shared by owner and staff updates. Public immediately, so the case must be APPROVED.
  private async createCaseUpdate(
    actor: CurrentUserDto,
    existing: MissingPerson,
    data: CreateMissingPersonUpdateDto,
    authorType: MissingPersonUpdateAuthorType,
  ) {
    if (existing.status !== MissingPersonStatus.APPROVED) {
      throw new BadRequestException('updates_require_approved_case');
    }

    const photos = data.photo ?? [];
    if (photos.length) {
      this.assertAttachmentCounts({
        photo: photos,
        video: [],
        audio: [],
        pdf: [],
        document: [],
        other: [],
      });
      const validated = await this.validateMediaFilesExist(photos);
      this.assertTotalBytes(validated.reduce((sum, v) => sum + v.size, 0));
    }

    const created = await this.prisma.missingPersonUpdate.create({
      data: {
        missingPersonId: existing.id,
        authorId: actor.id,
        authorType,
        message: data.message,
        photo: photos,
      },
    });

    this.auditOp(actor, existing, 'case_update_posted', { authorType, updateId: created.id });
    return { ...created, photos: await this.presignKeys(created.photo) };
  }

  async addOwnerUpdate(user: CurrentUserDto, id: string, data: CreateMissingPersonUpdateDto) {
    const existing = await this.loadOwnCase(user, id);
    return this.createCaseUpdate(user, existing, data, MissingPersonUpdateAuthorType.OWNER);
  }

  async addStaffUpdate(admin: CurrentUserDto, id: string, data: CreateMissingPersonUpdateDto) {
    const existing = await this.loadCase(id);
    return this.createCaseUpdate(admin, existing, data, MissingPersonUpdateAuthorType.STAFF);
  }

  async listOwnerUpdates(user: CurrentUserDto, id: string, query: PaginationQueryDto) {
    await this.loadOwnCase(user, id);
    const { page, limit, skip } = this.pageArgs(query);
    const where = { missingPersonId: id, authorId: user.id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPersonUpdate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.missingPersonUpdate.count({ where }),
    ]);

    const data = await Promise.all(
      rows.map(async (row) => ({ ...row, photos: await this.presignKeys(row.photo) })),
    );
    return { data, meta: this.pageMeta(page, limit, total) };
  }

  async listPublicUpdates(id: string, query: PaginationQueryDto) {
    await this.loadApprovedPublic(id);
    const { page, limit, skip } = this.pageArgs(query);
    const where = { missingPersonId: id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPersonUpdate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { id: true, authorType: true, message: true, photo: true, createdAt: true },
      }),
      this.prisma.missingPersonUpdate.count({ where }),
    ]);

    const data = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        authorType: row.authorType,
        message: row.message,
        createdAt: row.createdAt,
        photos: await this.presignKeys(row.photo),
      })),
    );
    return { data, meta: this.pageMeta(page, limit, total) };
  }

  // Shared by owner and admin media removal. Legal hold blocks it for everyone.
  private async removeMediaKey(actor: CurrentUserDto, existing: MissingPerson, key: string, operation: string) {
    if (existing.legalHold) {
      this.emitCaseFailure(actor, AuditEventEnum.MISSING_PERSON_UPDATED, existing, 'case_under_legal_hold', {
        outcome: AuditOutcome.DENIED,
      });
      throw new ConflictException('case_under_legal_hold');
    }

    const field = MEDIA_FIELD_NAMES.find((f) => existing[f].includes(key));
    if (!field) throw new NotFoundException('media_not_found_on_missing_person');

    let removedBytes = 0;
    try {
      removedBytes = (await this.minioService.statObject(key)).size;
    } catch {
      removedBytes = 0;
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id: existing.id },
      data: {
        ...({ [field]: existing[field].filter((k) => k !== key) } as Prisma.MissingPersonUpdateInput),
        mediaTotalBytes: Math.max(0, existing.mediaTotalBytes - removedBytes),
      },
    });

    await this.deleteMediaFiles([key]);

    if (existing.status === MissingPersonStatus.APPROVED) {
      await this.cache.invalidateMissingPersonEverywhere(existing.id);
    }

    this.auditOp(actor, updated, operation, { field }, { metadata: { key, removedBytes } });
    return updated;
  }

  async removeOwnerMedia(user: CurrentUserDto, id: string, key: string) {
    const existing = await this.loadOwnCase(user, id);
    const updated = await this.removeMediaKey(user, existing, key, 'owner_remove_media');
    return this.toOwnerView(updated);
  }

  async removeMediaByAdmin(admin: CurrentUserDto, id: string, key: string) {
    const existing = await this.loadCase(id);
    this.assertNotClaimedByOther(admin, existing, AuditEventEnum.MISSING_PERSON_UPDATED);
    return this.removeMediaKey(admin, existing, key, 'admin_remove_media');
  }

  // Counts and dates only. No informant identity, no tip text.
  async getMyTipsSummary(user: CurrentUserDto, id: string) {
    await this.loadOwnCase(user, id);

    const tips = await this.prisma.informationSubmission.findMany({
      where: { missingPersonId: id },
      select: { status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const byStatus: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    for (const tip of tips) {
      byStatus[tip.status] = (byStatus[tip.status] ?? 0) + 1;
      const day = tip.createdAt.toISOString().slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + 1;
    }

    return {
      total: tips.length,
      byStatus,
      firstReceivedAt: tips[0]?.createdAt ?? null,
      lastReceivedAt: tips[tips.length - 1]?.createdAt ?? null,
      perDay: Object.entries(byDay).map(([date, count]) => ({ date, count })),
    };
  }

  async appealRejection(user: CurrentUserDto, id: string, data: AppealMissingPersonRejectionDto) {
    const existing = await this.loadOwnCase(user, id);

    if (existing.status !== MissingPersonStatus.REJECTED) {
      throw new BadRequestException('only_rejected_cases_can_be_appealed');
    }

    const blocking = await this.prisma.missingPersonAppeal.findFirst({
      where: {
        missingPersonId: id,
        status: { in: [MissingPersonAppealState.PENDING, MissingPersonAppealState.DECLINED] },
      },
      select: { status: true },
    });
    if (blocking) {
      throw new ConflictException(
        blocking.status === MissingPersonAppealState.PENDING
          ? 'appeal_already_pending'
          : 'appeal_already_declined',
      );
    }

    const appeal = await this.prisma.missingPersonAppeal.create({
      data: { missingPersonId: id, authorId: user.id, reason: data.reason },
    });

    this.auditOp(user, existing, 'appeal_submitted', { appealId: appeal.id });
    return appeal;
  }

  // There is no DRAFT status, so the copy is a normal PENDING case with the person-specific
  // fields (name, media, reward) left empty for the owner to fill in via PATCH :id.
  async duplicateAsDraft(user: CurrentUserDto, id: string, idempotencyKey?: string) {
    const source = await this.loadOwnCase(user, id);

    if (idempotencyKey) {
      const prior = await this.prisma.missingPerson.findFirst({
        where: { userId: user.id, idempotencyKey },
      });
      if (prior) return this.toOwnerView(prior);
    }

    await this.enforceCreateRateLimit(user.id);
    await this.enforceMaxPending(user.id);

    try {
      const created = await this.prisma.missingPerson.create({
        data: {
          userId: user.id,
          personType: source.personType,
          description: source.description,
          dateLastSeen: source.dateLastSeen,
          lastKnownArea: source.lastKnownArea,
          status: MissingPersonStatus.PENDING,
          copiedFromId: source.id,
          idempotencyKey: idempotencyKey ?? null,
        },
      });

      this.auditOp(
        user,
        created,
        'duplicate_as_draft',
        { copiedFromId: source.id },
        { action: AuditEventEnum.MISSING_PERSON_CREATED },
      );
      return this.toOwnerView(created);
    } catch (err) {
      if (
        idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await this.prisma.missingPerson.findFirst({
          where: { userId: user.id, idempotencyKey },
        });
        if (winner) return this.toOwnerView(winner);
      }
      throw err;
    }
  }

  // ───────────── public (logged-in readers) ─────────────

  async search(query: SearchMissingPersonsQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
    const q = query.q.trim();

    const where: Prisma.MissingPersonWhereInput = {
      status: MissingPersonStatus.APPROVED,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { lastKnownArea: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ],
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        select: this.publicSelect,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data: data.map((item) => this.maskUnapprovedReward(item)),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async getPublicStats() {
    const [active, found, activeChildren, activeWomen] = await Promise.all([
      this.prisma.missingPerson.count({ where: { status: MissingPersonStatus.APPROVED } }),
      this.prisma.missingPerson.count({ where: { status: MissingPersonStatus.FOUND } }),
      this.prisma.missingPerson.count({
        where: { status: MissingPersonStatus.APPROVED, personType: MissingPersonType.CHILD },
      }),
      this.prisma.missingPerson.count({
        where: { status: MissingPersonStatus.APPROVED, personType: MissingPersonType.WOMAN },
      }),
    ]);
    return { active, found, activeByType: { CHILD: activeChildren, WOMAN: activeWomen } };
  }

  async findRecent(query: RecentMissingPersonsQueryDto) {
    const data = await this.prisma.missingPerson.findMany({
      where: { status: MissingPersonStatus.APPROVED },
      select: this.publicSelect,
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 10,
    });
    return { data: data.map((item) => this.maskUnapprovedReward(item)) };
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private publicWebUrl(id: string): string {
    const base = (this.configService.get<string>('WEB_BASE_URL') ?? '').replace(/\/+$/, '');
    return `${base}/missing-persons/${id}`;
  }

  async getPoster(id: string) {
    const mp = await this.loadApprovedPublic(id);
    const photoUrl = mp.photo[0]
      ? ((await this.presignKeys([mp.photo[0]]))[0]?.url ?? null)
      : null;

    const contactPhone = this.configService.get<string>('MISSING_PERSON_POSTER_CONTACT') ?? null;
    const reward =
      mp.rewardApproved && mp.rewardAmount
        ? { amount: mp.rewardAmount, details: mp.rewardDetails }
        : null;
    const url = this.publicWebUrl(mp.id);

    const e = (v: string | null | undefined) => this.escapeHtml(v ?? '');
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>Missing: ${e(mp.name ?? 'Unknown')}</title></head>` +
      `<body style="font-family:sans-serif;max-width:700px;margin:24px auto;text-align:center">` +
      `<h1 style="font-size:48px;margin:0">MISSING</h1>` +
      (photoUrl ? `<img src="${e(photoUrl)}" style="max-width:100%;max-height:420px" alt="">` : '') +
      `<h2>${e(mp.name ?? 'Name not provided')}</h2>` +
      `<p>Last seen ${e(mp.dateLastSeen.toISOString().slice(0, 10))} near ${e(mp.lastKnownArea)}</p>` +
      `<p>${e(mp.description)}</p>` +
      (reward ? `<p><strong>Reward: ${reward.amount}</strong></p>` : '') +
      (contactPhone ? `<p>Call: ${e(contactPhone)}</p>` : '') +
      `<p>${e(url)}</p></body></html>`;

    return {
      id: mp.id,
      title: 'MISSING',
      name: mp.name,
      personType: mp.personType,
      description: mp.description,
      dateLastSeen: mp.dateLastSeen,
      lastKnownArea: mp.lastKnownArea,
      photoUrl,
      reward,
      contactPhone,
      url,
      html,
      generatedAt: new Date(),
    };
  }

  async getShare(id: string) {
    const mp = await this.loadApprovedPublic(id);
    const url = this.publicWebUrl(mp.id);
    const deepLinkBase =
      this.configService.get<string>('APP_DEEP_LINK_BASE') ?? 'ehte://missing-persons';

    const who = mp.name ?? 'A missing person';
    const text =
      `${who} was last seen on ${mp.dateLastSeen.toISOString().slice(0, 10)} ` +
      `near ${mp.lastKnownArea}. If you have any information, please open the link.`;

    return {
      id: mp.id,
      title: `Missing: ${mp.name ?? 'Help us find this person'}`,
      text,
      url,
      deepLink: `${deepLinkBase.replace(/\/+$/, '')}/${mp.id}`,
    };
  }

  async flag(user: CurrentUserDto, id: string, data: FlagMissingPersonDto) {
    const mp = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!mp || mp.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }
    if (mp.userId === user.id) {
      throw new BadRequestException('cannot_flag_own_case');
    }

    try {
      const flag = await this.prisma.missingPersonFlag.create({
        data: {
          missingPersonId: id,
          reporterId: user.id,
          reason: data.reason,
          details: data.details ?? null,
        },
      });
      this.auditOp(user, mp, 'reader_flag', { flagId: flag.id, reason: data.reason });
      return { id: flag.id, status: flag.status, createdAt: flag.createdAt };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('already_flagged_by_you');
      }
      throw err;
    }
  }

  // One row per user per case per day. Owner views are not counted.
  async recordView(user: CurrentUserDto, id: string) {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: { status: true, userId: true },
    });
    if (!mp || mp.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }
    if (mp.userId === user.id) return { recorded: false };

    const viewedOn = new Date(new Date().toISOString().slice(0, 10));
    const { count } = await this.prisma.missingPersonView.createMany({
      data: [{ missingPersonId: id, userId: user.id, viewedOn }],
      skipDuplicates: true,
    });
    return { recorded: count > 0 };
  }

  // ───────────── admin: read / unread tracking ─────────────

  async markRead(admin: CurrentUserDto, id: string) {
    await this.loadCase(id);
    await this.prisma.missingPersonReadState.upsert({
      where: { missingPersonId_adminId: { missingPersonId: id, adminId: admin.id } },
      create: { missingPersonId: id, adminId: admin.id },
      update: {},
    });
    return { id, isRead: true };
  }

  async markUnread(admin: CurrentUserDto, id: string) {
    await this.loadCase(id);
    await this.prisma.missingPersonReadState.deleteMany({
      where: { missingPersonId: id, adminId: admin.id },
    });
    return { id, isRead: false };
  }

  async bulkMarkRead(admin: CurrentUserDto, ids: string[]) {
    const unique = [...new Set(ids)];
    const found = await this.prisma.missingPerson.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    const { count } = await this.prisma.missingPersonReadState.createMany({
      data: found.map((c) => ({ missingPersonId: c.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    const foundIds = new Set(found.map((c) => c.id));
    return { updated: count, notFound: unique.filter((id) => !foundIds.has(id)) };
  }

  async bulkMarkUnread(admin: CurrentUserDto, ids: string[]) {
    const { count } = await this.prisma.missingPersonReadState.deleteMany({
      where: { adminId: admin.id, missingPersonId: { in: [...new Set(ids)] } },
    });
    return { updated: count };
  }

  async markAllRead(admin: CurrentUserDto, data: MarkAllMissingPersonsReadDto) {
    const where: Prisma.MissingPersonWhereInput = {
      ...this.adminBaseWhere,
      readStates: { none: { adminId: admin.id } },
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.personType !== undefined ? { personType: data.personType } : {}),
      ...(data.area ? { lastKnownArea: { contains: data.area, mode: 'insensitive' } } : {}),
    };

    const cases = await this.prisma.missingPerson.findMany({
      where,
      select: { id: true },
      take: 5000,
    });
    const { count } = await this.prisma.missingPersonReadState.createMany({
      data: cases.map((c) => ({ missingPersonId: c.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    return { updated: count };
  }

  async findUnread(admin: CurrentUserDto, query: ListMissingPersonsAdminQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
    const where: Prisma.MissingPersonWhereInput = {
      ...this.adminBaseWhere,
      readStates: { none: { adminId: admin.id } },
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data: data.map((item) => ({ ...item, isRead: false })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async countUnread(admin: CurrentUserDto) {
    const count = await this.prisma.missingPerson.count({
      where: { ...this.adminBaseWhere, readStates: { none: { adminId: admin.id } } },
    });
    return { count };
  }

  async countUnreadByStatus(admin: CurrentUserDto) {
    const rows = await this.prisma.$queryRaw<{ status: string; count: number }[]>`
      SELECT mp.status::text AS status, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE mp."deletedAt" IS NULL AND mp."mergedIntoId" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM missing_person_read_state rs
          WHERE rs."missingPersonId" = mp.id AND rs."adminId" = ${admin.id}
        )
      GROUP BY 1
    `;
    const byStatus = Object.fromEntries(
      Object.values(MissingPersonStatus).map((s) => [s, 0]),
    ) as Record<string, number>;
    for (const row of rows) byStatus[row.status] = row.count;
    return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus };
  }

  async countUnreadByArea(admin: CurrentUserDto) {
    const rows = await this.prisma.$queryRaw<{ area: string; count: number }[]>`
      SELECT mp."lastKnownArea" AS area, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE mp."deletedAt" IS NULL AND mp."mergedIntoId" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM missing_person_read_state rs
          WHERE rs."missingPersonId" = mp.id AND rs."adminId" = ${admin.id}
        )
      GROUP BY 1
      ORDER BY count DESC, area ASC
      LIMIT 100
    `;
    return { data: rows };
  }

  async getReadCounts(admin: CurrentUserDto) {
    const [total, read] = await Promise.all([
      this.prisma.missingPerson.count({ where: this.adminBaseWhere }),
      this.prisma.missingPerson.count({
        where: { ...this.adminBaseWhere, readStates: { some: { adminId: admin.id } } },
      }),
    ]);
    return { total, read, unread: total - read };
  }

  // ───────────── admin: by owner ─────────────

  async listByOwner(admin: CurrentUserDto, query: PaginationQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);

    const rows = await this.prisma.$queryRaw<
      { ownerId: string; total: number; read: number; unread: number; pending: number; owners: number }[]
    >`
      SELECT mp."userId" AS "ownerId",
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE rs."missingPersonId" IS NOT NULL)::int AS read,
             COUNT(*) FILTER (WHERE rs."missingPersonId" IS NULL)::int AS unread,
             COUNT(*) FILTER (WHERE mp.status = 'PENDING')::int AS pending,
             COUNT(*) OVER()::int AS owners
      FROM missing_person mp
      LEFT JOIN missing_person_read_state rs
        ON rs."missingPersonId" = mp.id AND rs."adminId" = ${admin.id}
      WHERE mp."deletedAt" IS NULL AND mp."mergedIntoId" IS NULL AND mp."userId" IS NOT NULL
      GROUP BY mp."userId"
      ORDER BY unread DESC, total DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.ownerId) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const total = rows[0]?.owners ?? 0;

    return {
      data: rows.map(({ owners: _owners, ...r }) => ({ ...r, ownerName: nameOf.get(r.ownerId) ?? null })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async listRepeatRejections(query: PaginationQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
    const threshold = Number(
      this.configService.get<string>('MISSING_PERSON_REPEAT_REJECTION_COUNT') ?? 2,
    );

    const rows = await this.prisma.$queryRaw<
      { ownerId: string; rejected: number; falseFlags: number; owners: number }[]
    >`
      WITH r AS (
        SELECT "userId", COUNT(*)::int AS rejected
        FROM missing_person
        WHERE status = 'REJECTED' AND "userId" IS NOT NULL
        GROUP BY "userId"
      ), f AS (
        SELECT mp."userId", COUNT(*)::int AS false_flags
        FROM missing_person_flag fl
        JOIN missing_person mp ON mp.id = fl."missingPersonId"
        WHERE fl.reason = 'FALSE_LISTING' AND mp."userId" IS NOT NULL
        GROUP BY mp."userId"
      )
      SELECT COALESCE(r."userId", f."userId") AS "ownerId",
             COALESCE(r.rejected, 0)::int AS rejected,
             COALESCE(f.false_flags, 0)::int AS "falseFlags",
             COUNT(*) OVER()::int AS owners
      FROM r FULL JOIN f ON f."userId" = r."userId"
      WHERE COALESCE(r.rejected, 0) >= ${threshold} OR COALESCE(f.false_flags, 0) >= ${threshold}
      ORDER BY rejected DESC, "falseFlags" DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.ownerId) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    return {
      data: rows.map(({ owners: _owners, ...r }) => ({ ...r, ownerName: nameOf.get(r.ownerId) ?? null })),
      meta: this.pageMeta(page, limit, rows[0]?.owners ?? 0),
    };
  }

  async findByOwner(
    admin: CurrentUserDto,
    ownerId: string,
    query: ListMissingPersonsAdminQueryDto,
  ) {
    const { page, limit, skip } = this.pageArgs(query);
    const where: Prisma.MissingPersonWhereInput = {
      ...this.adminBaseWhere,
      userId: ownerId,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.isRead === true ? { readStates: { some: { adminId: admin.id } } } : {}),
      ...(query.isRead === false ? { readStates: { none: { adminId: admin.id } } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { readStates: { where: { adminId: admin.id }, select: { adminId: true } } },
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data: rows.map(({ readStates, ...item }) => ({ ...item, isRead: readStates.length > 0 })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async getOwnerSummary(admin: CurrentUserDto, ownerId: string) {
    const base: Prisma.MissingPersonWhereInput = { ...this.adminBaseWhere, userId: ownerId };
    const [grouped, total, read] = await Promise.all([
      this.prisma.missingPerson.groupBy({
        by: ['status'],
        where: base,
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.missingPerson.count({ where: base }),
      this.prisma.missingPerson.count({
        where: { ...base, readStates: { some: { adminId: admin.id } } },
      }),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(MissingPersonStatus).map((s) => [s, 0]),
    ) as Record<MissingPersonStatus, number>;
    for (const row of grouped) {
      const c = row._count as { status?: number } | undefined;
      byStatus[row.status] = c?.status ?? 0;
    }
    return { ownerId, total, read, unread: total - read, byStatus };
  }

  async markOwnerRead(admin: CurrentUserDto, ownerId: string) {
    const cases = await this.prisma.missingPerson.findMany({
      where: { ...this.adminBaseWhere, userId: ownerId },
      select: { id: true },
    });
    const { count } = await this.prisma.missingPersonReadState.createMany({
      data: cases.map((c) => ({ missingPersonId: c.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    return { updated: count };
  }

  async markOwnerUnread(admin: CurrentUserDto, ownerId: string) {
    const { count } = await this.prisma.missingPersonReadState.deleteMany({
      where: { adminId: admin.id, missingPerson: { userId: ownerId } },
    });
    return { updated: count };
  }

  // ───────────── admin: assignment ─────────────

  private async assertAssignable(adminId: string): Promise<void> {
    const target = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        isActive: true,
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!target) throw new NotFoundException('assignee_not_found');
    if (!target.isActive) throw new BadRequestException('assignee_inactive');

    const roleNames = target.userRoles.map((ur) => ur.role.name);
    if (!roleNames.includes(RolesEnum.ADMIN) && !roleNames.includes(RolesEnum.SUPER_ADMIN)) {
      throw new BadRequestException('assignee_must_be_an_admin');
    }
  }

  async assign(admin: CurrentUserDto, id: string, assigneeId: string) {
    const existing = await this.loadCase(id);
    await this.assertAssignable(assigneeId);

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { assignedToUserId: assigneeId, assignedById: admin.id, assignedAt: new Date() },
    });

    this.auditOp(admin, updated, 'assign', {
      previousAssignee: existing.assignedToUserId,
      assignedTo: assigneeId,
    });
    return updated;
  }

  async unassign(admin: CurrentUserDto, id: string) {
    const existing = await this.loadCase(id);
    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { assignedToUserId: null, assignedById: null, assignedAt: null },
    });
    this.auditOp(admin, updated, 'unassign', { previousAssignee: existing.assignedToUserId });
    return updated;
  }

  async bulkAssign(admin: CurrentUserDto, ids: string[], assigneeId: string): Promise<BulkResult> {
    await this.assertAssignable(assigneeId);
    return this.runBulk(ids, async (id) => {
      await this.assign(admin, id, assigneeId);
    });
  }

  // ───────────── admin: bulk status actions ─────────────

  private async runBulk(ids: string[], fn: (id: string) => Promise<void>): Promise<BulkResult> {
    const result: BulkResult = { succeeded: [], failed: [] };
    for (const id of [...new Set(ids)]) {
      try {
        await fn(id);
        result.succeeded.push(id);
      } catch (err) {
        const reason =
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : 'unknown_error';
        result.failed.push({ id, reason });
      }
    }
    return result;
  }

  // PENDING has to pass through UNDER_REVIEW before any decision.
  private async moveToUnderReview(admin: CurrentUserDto, id: string, status: MissingPersonStatus) {
    if (status === MissingPersonStatus.PENDING) {
      await this.updateStatus(admin, id, MissingPersonStatus.UNDER_REVIEW);
    }
  }

  async bulkApprove(admin: CurrentUserDto, ids: string[]): Promise<BulkResult> {
    return this.runBulk(ids, async (id) => {
      const existing = await this.loadCase(id);
      if (existing.personType === MissingPersonType.CHILD) {
        throw new BadRequestException('child_cases_need_individual_dual_confirmation');
      }
      if (existing.deletedAt || existing.mergedIntoId) {
        throw new BadRequestException('case_not_available');
      }
      await this.moveToUnderReview(admin, id, existing.status);
      await this.updateStatus(admin, id, MissingPersonStatus.APPROVED);
    });
  }

  async bulkReject(admin: CurrentUserDto, ids: string[], reviewNote: string): Promise<BulkResult> {
    return this.runBulk(ids, async (id) => {
      const existing = await this.loadCase(id);
      if (existing.deletedAt || existing.mergedIntoId) {
        throw new BadRequestException('case_not_available');
      }
      await this.moveToUnderReview(admin, id, existing.status);
      await this.updateStatus(admin, id, MissingPersonStatus.REJECTED, reviewNote);
    });
  }

  async bulkExpire(admin: CurrentUserDto, ids: string[], reason: string): Promise<BulkResult> {
    return this.runBulk(ids, async (id) => {
      const existing = await this.loadCase(id);
      if (existing.legalHold) throw new ConflictException('case_under_legal_hold');
      await this.updateStatus(admin, id, MissingPersonStatus.EXPIRED, reason);
      await this.prisma.missingPerson.update({
        where: { id },
        data: { closureReason: reason, closedAt: new Date() },
      });
    });
  }

  // ───────────── reader flags ─────────────

  async listFlags(query: ListMissingPersonFlagsQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
    const where: Prisma.MissingPersonFlagWhereInput = {
      ...(query.status ? { status: this.asEnum<MissingPersonFlagState>(query.status) } : {}),
      ...(query.reason ? { reason: query.reason } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPersonFlag.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: {
          missingPerson: { select: { id: true, name: true, personType: true, status: true } },
          reporter: { select: { id: true, name: true } },
        },
      }),
      this.prisma.missingPersonFlag.count({ where }),
    ]);

    return {
      data: rows.map(({ missingPerson, ...flag }) => ({
        ...flag,
        missingPerson: {
          id: missingPerson.id,
          label: this.caseLabel(missingPerson),
          personType: missingPerson.personType,
          status: missingPerson.status,
        },
      })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async listCaseFlags(id: string) {
    await this.loadCase(id);
    const data = await this.prisma.missingPersonFlag.findMany({
      where: { missingPersonId: id },
      orderBy: { createdAt: 'desc' },
      include: { reporter: { select: { id: true, name: true } } },
    });
    return { data };
  }

  // Hides a public case. Status moves to CANCELLED, which the workflow treats as terminal, so it
  // cannot be re-approved until a super admin lifts the takedown.
  private async hideCase(
    admin: CurrentUserDto,
    existing: MissingPerson,
    reason: string,
    operation: string,
  ) {
    const now = new Date();
    const result = await this.prisma.missingPerson.updateMany({
      where: { id: existing.id, status: MissingPersonStatus.APPROVED },
      data: {
        status: MissingPersonStatus.CANCELLED,
        takedownReason: reason,
        takedownAt: now,
        takedownById: admin.id,
        takedownPreviousStatus: MissingPersonStatus.APPROVED,
        claimedByUserId: null,
        claimedAt: null,
      },
    });
    if (result.count === 0) throw new ConflictException('missing_person_transition_conflict');

    await this.cache.invalidateMissingPersonEverywhere(existing.id);
    const updated = await this.loadCase(existing.id);

    this.auditOp(
      admin,
      updated,
      operation,
      {
        previousStatus: existing.status,
        newStatus: updated.status,
      },
      { severity: AuditSeverity.CRITICAL, reason },
    );
    this.notifyOwner(updated);
    return updated;
  }

  async resolveFlag(admin: CurrentUserDto, flagId: string, data: ResolveMissingPersonFlagDto) {
    const flag = await this.prisma.missingPersonFlag.findUnique({
      where: { id: flagId },
      include: { missingPerson: true },
    });
    if (!flag) throw new NotFoundException('flag_not_found');
    if (flag.status !== MissingPersonFlagState.OPEN) {
      throw new ConflictException('flag_already_resolved');
    }

    const mp = flag.missingPerson;
    const resolvedData = {
      status: MissingPersonFlagState.RESOLVED,
      resolvedAction: data.action,
      resolvedById: admin.id,
      resolvedAt: new Date(),
      resolutionNote: data.reason,
    };

    if (data.action === MissingPersonFlagAction.HIDE_CASE) {
      if (mp.status === MissingPersonStatus.APPROVED) {
        await this.hideCase(admin, mp, data.reason, 'flag_hide_case');
      }
      // Every open flag on a hidden case is settled by the same decision.
      await this.prisma.missingPersonFlag.updateMany({
        where: { missingPersonId: mp.id, status: MissingPersonFlagState.OPEN },
        data: resolvedData,
      });
    } else {
      await this.prisma.missingPersonFlag.update({ where: { id: flagId }, data: resolvedData });

      if (data.action === MissingPersonFlagAction.WARN_OWNER) {
        await this.prisma.missingPersonMessage.create({
          data: {
            missingPersonId: mp.id,
            authorId: admin.id,
            kind: MissingPersonMessageKind.WARNING,
            message: data.reason,
          },
        });
        this.notifyOwner(mp);
      }
    }

    this.auditOp(admin, mp, 'flag_resolved', { flagId, action: data.action }, { reason: data.reason });
    return this.prisma.missingPersonFlag.findUniqueOrThrow({ where: { id: flagId } });
  }

  // ───────────── takedown, delete, legal hold ─────────────

  async takedown(admin: CurrentUserDto, id: string, reason: string) {
    const existing = await this.loadCase(id);
    if (existing.status !== MissingPersonStatus.APPROVED) {
      throw new BadRequestException('only_approved_cases_can_be_taken_down');
    }
    return this.hideCase(admin, existing, reason, 'takedown');
  }

  async liftTakedown(admin: CurrentUserDto, id: string, reason: string) {
    const existing = await this.loadCase(id);
    if (!existing.takedownAt || existing.deletedAt) {
      throw new BadRequestException('case_is_not_taken_down');
    }

    const restoreTo = existing.takedownPreviousStatus ?? MissingPersonStatus.APPROVED;
    const result = await this.prisma.missingPerson.updateMany({
      where: { id, status: MissingPersonStatus.CANCELLED, takedownAt: { not: null } },
      data: {
        status: restoreTo,
        takedownReason: null,
        takedownAt: null,
        takedownById: null,
        takedownPreviousStatus: null,
      },
    });
    if (result.count === 0) throw new ConflictException('missing_person_transition_conflict');

    await this.cache.invalidateMissingPersonEverywhere(id);
    const updated = await this.loadCase(id);

    this.auditOp(
      admin,
      updated,
      'lift_takedown',
      { previousStatus: existing.status, newStatus: updated.status },
      { severity: AuditSeverity.CRITICAL, reason },
    );
    this.notifyOwner(updated);
    return updated;
  }

  // Soft delete. Non-terminal cases move to CANCELLED so every existing status-based query hides them.
  async removeByAdmin(admin: CurrentUserDto, id: string, reason: string) {
    const existing = await this.loadCase(id);

    if (existing.deletedAt) throw new ConflictException('case_already_deleted');
    if (existing.legalHold) {
      this.emitCaseFailure(admin, AuditEventEnum.MISSING_PERSON_DELETED, existing, 'case_under_legal_hold', {
        outcome: AuditOutcome.DENIED,
      });
      throw new ConflictException('case_under_legal_hold');
    }
    if (Number(existing.fundedAmount) > 0 || (await this.isRewardFunded(id))) {
      throw new ConflictException('reward_funded_cannot_delete');
    }

    const wasTerminal = TERMINAL_STATUSES.includes(existing.status);
    const result = await this.prisma.missingPerson.updateMany({
      where: { id, deletedAt: null },
      data: {
        deletedAt: new Date(),
        deletedById: admin.id,
        deleteReason: reason,
        deletedPreviousStatus: existing.status,
        claimedByUserId: null,
        claimedAt: null,
        ...(wasTerminal ? {} : { status: MissingPersonStatus.CANCELLED }),
      },
    });
    if (result.count === 0) throw new ConflictException('case_already_deleted');

    await this.cache.invalidateMissingPersonEverywhere(id);

    this.auditOp(
      admin,
      existing,
      'admin_soft_delete',
      { previousStatus: existing.status, newStatus: wasTerminal ? existing.status : MissingPersonStatus.CANCELLED },
      { action: AuditEventEnum.MISSING_PERSON_DELETED, severity: AuditSeverity.CRITICAL, reason },
    );
    return { message: 'missing_person_deleted', id };
  }

  async restore(admin: CurrentUserDto, id: string, reason?: string) {
    const existing = await this.loadCase(id);
    if (!existing.deletedAt) throw new BadRequestException('case_is_not_deleted');

    const previous = existing.deletedPreviousStatus;
    const canRestoreStatus =
      existing.status === MissingPersonStatus.CANCELLED &&
      !existing.takedownAt &&
      previous !== null &&
      !TERMINAL_STATUSES.includes(previous);

    await this.prisma.missingPerson.update({
      where: { id },
      data: {
        deletedAt: null,
        deletedById: null,
        deleteReason: null,
        deletedPreviousStatus: null,
        ...(canRestoreStatus && previous ? { status: previous } : {}),
      },
    });

    await this.cache.invalidateMissingPersonEverywhere(id);
    const updated = await this.loadCase(id);

    this.auditOp(
      admin,
      updated,
      'admin_restore',
      { previousStatus: existing.status, newStatus: updated.status },
      { severity: AuditSeverity.WARNING, reason: reason ?? null },
    );
    this.notifyOwner(updated);
    return updated;
  }

  async listTrash(query: PaginationQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
    const where: Prisma.MissingPersonWhereInput = { deletedAt: { not: null } };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { deletedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);
    return { data, meta: this.pageMeta(page, limit, total) };
  }

  async setLegalHold(admin: CurrentUserDto, id: string, legalHold: boolean, reason: string) {
    const existing = await this.loadCase(id);
    if (existing.legalHold === legalHold) {
      throw new ConflictException(legalHold ? 'legal_hold_already_set' : 'no_legal_hold_to_release');
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: legalHold
        ? { legalHold: true, legalHoldReason: reason, legalHoldAt: new Date(), legalHoldById: admin.id }
        : { legalHold: false, legalHoldReason: null, legalHoldAt: null, legalHoldById: null },
    });

    this.auditOp(
      admin,
      updated,
      legalHold ? 'legal_hold_placed' : 'legal_hold_released',
      { legalHold },
      { severity: AuditSeverity.CRITICAL, reason },
    );
    return updated;
  }

  // ───────────── found reports, appeals, reopen ─────────────

  async listFoundClaims(query: PaginationQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
    const where: Prisma.MissingPersonWhereInput = {
      ...this.adminBaseWhere,
      status: MissingPersonStatus.APPROVED,
      foundReportedAt: { not: null },
      foundReportResolvedAt: null,
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { foundReportedAt: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          personType: true,
          lastKnownArea: true,
          foundReportedAt: true,
          foundReportDetails: true,
          foundReportDate: true,
          foundReportLocation: true,
          userId: true,
          claimedByUserId: true,
          assignedToUserId: true,
        },
      }),
      this.prisma.missingPerson.count({ where }),
    ]);
    return { data, meta: this.pageMeta(page, limit, total) };
  }

  async verifyFound(admin: CurrentUserDto, id: string, confirmed: boolean, reviewNote?: string) {
    const existing = await this.loadCase(id);
    if (!existing.foundReportedAt || existing.foundReportResolvedAt) {
      throw new BadRequestException('no_pending_found_report');
    }

    if (confirmed) {
      // Reuses the normal APPROVED -> FOUND path so claims, notifications and reward closure all run.
      await this.updateStatus(admin, id, MissingPersonStatus.FOUND, reviewNote);
      const updated = await this.prisma.missingPerson.update({
        where: { id },
        data: {
          foundReportResolvedAt: new Date(),
          foundReportConfirmed: true,
          closedAt: new Date(),
          closureReason: 'found_verified',
        },
      });
      this.auditOp(admin, updated, 'found_report_confirmed', {}, { reason: reviewNote ?? null });
      return updated;
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { foundReportResolvedAt: new Date(), foundReportConfirmed: false },
    });
    await this.prisma.missingPersonMessage.create({
      data: {
        missingPersonId: id,
        authorId: admin.id,
        message: reviewNote?.trim() || 'Your found report could not be confirmed.',
      },
    });
    this.auditOp(admin, updated, 'found_report_declined', {}, { reason: reviewNote ?? null });
    this.notifyOwner(updated);
    return updated;
  }

  async listAppeals(query: ListMissingPersonAppealsQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
    const where: Prisma.MissingPersonAppealWhereInput = {
      ...(query.status ? { status: this.asEnum<MissingPersonAppealState>(query.status) } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPersonAppeal.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: {
          missingPerson: {
            select: { id: true, name: true, personType: true, status: true, reviewNote: true },
          },
          author: { select: { id: true, name: true } },
        },
      }),
      this.prisma.missingPersonAppeal.count({ where }),
    ]);

    return {
      data: rows.map(({ missingPerson, ...appeal }) => ({
        ...appeal,
        missingPerson: {
          id: missingPerson.id,
          label: this.caseLabel(missingPerson),
          personType: missingPerson.personType,
          status: missingPerson.status,
          rejectionNote: missingPerson.reviewNote,
        },
      })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async decideAppeal(admin: CurrentUserDto, appealId: string, data: DecideMissingPersonAppealDto) {
    const appeal = await this.prisma.missingPersonAppeal.findUnique({
      where: { id: appealId },
      include: { missingPerson: true },
    });
    if (!appeal) throw new NotFoundException('appeal_not_found');

    const accepted = data.decision === MissingPersonAppealDecision.ACCEPTED;
    const decided = await this.prisma.missingPersonAppeal.updateMany({
      where: { id: appealId, status: MissingPersonAppealState.PENDING },
      data: {
        status: accepted ? MissingPersonAppealState.ACCEPTED : MissingPersonAppealState.DECLINED,
        decidedById: admin.id,
        decidedAt: new Date(),
        decisionNote: data.reason,
      },
    });
    if (decided.count === 0) throw new ConflictException('appeal_already_decided');

    const mp = appeal.missingPerson;
    if (accepted) {
      // A rejected case goes back into review. This is a deliberate exception to the status workflow.
      await this.prisma.missingPerson.updateMany({
        where: { id: mp.id, status: MissingPersonStatus.REJECTED },
        data: { status: MissingPersonStatus.UNDER_REVIEW },
      });
      await this.cache.invalidateMissingPersonEverywhere(mp.id);
    }

    await this.prisma.missingPersonMessage.create({
      data: { missingPersonId: mp.id, authorId: admin.id, message: data.reason },
    });

    const updated = await this.loadCase(mp.id);
    this.auditOp(
      admin,
      updated,
      'appeal_decided',
      {
        appealId,
        decision: data.decision,
        previousStatus: mp.status,
        newStatus: updated.status,
      },
      { reason: data.reason },
    );
    this.notifyOwner(updated);
    return this.prisma.missingPersonAppeal.findUniqueOrThrow({ where: { id: appealId } });
  }

  // FOUND and EXPIRED return to APPROVED, a cancelled case returns to review.
  async reopen(admin: CurrentUserDto, id: string, reason: string) {
    const existing = await this.loadCase(id);
    const reopenable: MissingPersonStatus[] = [
      MissingPersonStatus.EXPIRED,
      MissingPersonStatus.CANCELLED,
      MissingPersonStatus.FOUND,
    ];

    if (existing.deletedAt) throw new BadRequestException('deleted_case_must_be_restored_first');
    if (existing.mergedIntoId) throw new BadRequestException('merged_case_cannot_be_reopened');
    if (existing.takedownAt) throw new BadRequestException('use_lift_takedown_for_taken_down_cases');
    if (!reopenable.includes(existing.status)) {
      throw new BadRequestException('only_expired_cancelled_or_found_cases_can_be_reopened');
    }
    if (existing.fundingStatus === 'REFUND_DUE' || existing.fundingStatus === 'REFUNDED') {
      throw new ConflictException('reward_refund_in_progress_cannot_reopen');
    }

    const target =
      existing.status === MissingPersonStatus.CANCELLED
        ? MissingPersonStatus.UNDER_REVIEW
        : MissingPersonStatus.APPROVED;

    const defaultDays = Number(
      this.configService.get<string>('MISSING_PERSON_RENEW_DEFAULT_DAYS') ?? 30,
    );

    const result = await this.prisma.missingPerson.updateMany({
      where: { id, status: existing.status },
      data: {
        status: target,
        closedAt: null,
        closureReason: null,
        foundReportedAt: null,
        foundReportDetails: null,
        foundReportDate: null,
        foundReportLocation: null,
        foundReportResolvedAt: null,
        foundReportConfirmed: null,
        ...(existing.status === MissingPersonStatus.EXPIRED
          ? { expiresAt: new Date(Date.now() + defaultDays * 24 * 60 * 60 * 1000) }
          : {}),
      },
    });
    if (result.count === 0) throw new ConflictException('missing_person_transition_conflict');

    await this.cache.invalidateMissingPersonEverywhere(id);
    const updated = await this.loadCase(id);

    this.auditOp(
      admin,
      updated,
      'reopen',
      { previousStatus: existing.status, newStatus: updated.status },
      { severity: AuditSeverity.WARNING, reason },
    );
    this.notifyOwner(updated);
    return updated;
  }

  // ───────────── editing, messaging, child flag ─────────────

  async getTransitions(id: string) {
    const existing = await this.loadCase(id);
    return {
      id,
      currentStatus: existing.status,
      allowedNext: this.ALLOWED_TRANSITIONS[existing.status] ?? [],
      reviewNoteRequiredFor: [
        MissingPersonStatus.REJECTED,
        MissingPersonStatus.MORE_INFORMATION_REQUESTED,
      ],
      requiresChildSafetyDualConfirmation: existing.personType === MissingPersonType.CHILD,
      childSafetyFirstConfirmedByUserId: existing.childSafetyFirstConfirmedByUserId,
      claimedByUserId: existing.claimedByUserId,
    };
  }

  async editByAdmin(admin: CurrentUserDto, id: string, data: AdminEditMissingPersonDto) {
    const existing = await this.loadCase(id);
    this.assertNotClaimedByOther(admin, existing, AuditEventEnum.MISSING_PERSON_UPDATED);

    const editable: MissingPersonStatus[] = [
      MissingPersonStatus.PENDING,
      MissingPersonStatus.UNDER_REVIEW,
      MissingPersonStatus.MORE_INFORMATION_REQUESTED,
    ];
    if (!editable.includes(existing.status) || existing.deletedAt) {
      throw new ForbiddenException('case_not_editable_by_admin_in_current_status');
    }

    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
    const patch: Prisma.MissingPersonUpdateInput = {};

    if (data.name !== undefined && data.name !== existing.name) {
      changes.push({ field: 'name', oldValue: existing.name, newValue: data.name });
      patch.name = data.name;
    }
    if (data.description !== undefined && data.description !== existing.description) {
      changes.push({ field: 'description', oldValue: existing.description, newValue: data.description });
      patch.description = data.description;
    }
    if (data.lastKnownArea !== undefined && data.lastKnownArea !== existing.lastKnownArea) {
      changes.push({ field: 'lastKnownArea', oldValue: existing.lastKnownArea, newValue: data.lastKnownArea });
      patch.lastKnownArea = data.lastKnownArea;
    }
    if (data.dateLastSeen !== undefined) {
      const next = new Date(data.dateLastSeen);
      if (next.getTime() !== existing.dateLastSeen.getTime()) {
        changes.push({
          field: 'dateLastSeen',
          oldValue: existing.dateLastSeen.toISOString(),
          newValue: next.toISOString(),
        });
        patch.dateLastSeen = next;
      }
    }

    if (changes.length === 0) throw new BadRequestException('no_changes_provided');

    const [updated] = await this.prisma.$transaction([
      this.prisma.missingPerson.update({ where: { id }, data: patch }),
      this.prisma.missingPersonRevision.createMany({
        data: changes.map((c) => ({
          missingPersonId: id,
          field: c.field,
          oldValue: (c.oldValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          newValue: (c.newValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          changedById: admin.id,
          reason: data.reason,
        })),
      }),
    ]);

    this.auditOp(
      admin,
      updated,
      'admin_edit',
      { fieldsChanged: changes.map((c) => c.field) },
      { reason: data.reason },
    );
    return updated;
  }

  async getRevisions(id: string, query: PaginationQueryDto) {
    await this.loadCase(id);
    const { page, limit, skip } = this.pageArgs(query);
    const where = { missingPersonId: id };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPersonRevision.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { changedBy: { select: { id: true, name: true } } },
      }),
      this.prisma.missingPersonRevision.count({ where }),
    ]);
    return { data, meta: this.pageMeta(page, limit, total) };
  }

  async messageOwner(admin: CurrentUserDto, id: string, message: string) {
    const existing = await this.loadCase(id);
    const created = await this.prisma.missingPersonMessage.create({
      data: { missingPersonId: id, authorId: admin.id, message },
    });
    this.auditOp(admin, existing, 'message_owner', { messageId: created.id });
    this.notifyOwner(existing);
    return created;
  }

  // The child flag is personType: CHILD turns on the two-admin approval rules. A change needs two
  // distinct admins to propose the same value, the second call applies it.
  async correctChildFlag(admin: CurrentUserDto, id: string, involvesChild: boolean, reason: string) {
    const existing = await this.loadCase(id);
    const target = involvesChild ? MissingPersonType.CHILD : MissingPersonType.WOMAN;

    if (existing.personType === target) throw new BadRequestException('child_flag_already_set');

    const sameProposal = existing.childFlagProposedValue === involvesChild;
    if (sameProposal && existing.childFlagProposedById === admin.id) {
      throw new BadRequestException('child_flag_requires_second_distinct_admin');
    }

    if (sameProposal && existing.childFlagProposedById) {
      const updated = await this.prisma.missingPerson.update({
        where: { id },
        data: {
          personType: target,
          childFlagProposedValue: null,
          childFlagProposedById: null,
          childFlagProposedAt: null,
          childFlagProposedReason: null,
          childSafetyFirstConfirmedByUserId: null,
          childSafetyFirstConfirmedAt: null,
        },
      });
      if (existing.status === MissingPersonStatus.APPROVED) {
        await this.cache.invalidateMissingPersonEverywhere(id);
      }
      this.auditOp(
        admin,
        updated,
        'child_flag_corrected',
        {
          previousPersonType: existing.personType,
          personType: updated.personType,
          firstProposedBy: existing.childFlagProposedById,
        },
        { severity: AuditSeverity.WARNING, reason },
      );
      return updated;
    }

    const proposed = await this.prisma.missingPerson.update({
      where: { id },
      data: {
        childFlagProposedValue: involvesChild,
        childFlagProposedById: admin.id,
        childFlagProposedAt: new Date(),
        childFlagProposedReason: reason,
      },
    });
    this.auditOp(
      admin,
      proposed,
      'child_flag_first_confirmation',
      { proposedValue: involvesChild, result: 'pending_second_admin_confirmation' },
      { reason },
    );
    return { ...proposed, pendingSecondConfirmation: true };
  }

  // ───────────── duplicates and merge ─────────────

  async listDuplicates(query: PaginationQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);

    const rows = await this.prisma.$queryRaw<
      {
        caseId: string;
        duplicateId: string;
        personType: string;
        name: string | null;
        areaA: string;
        areaB: string;
        createdAtA: Date;
        createdAtB: Date;
        total: number;
      }[]
    >`
      SELECT a.id AS "caseId", b.id AS "duplicateId", a."personType"::text AS "personType",
             a.name AS name, a."lastKnownArea" AS "areaA", b."lastKnownArea" AS "areaB",
             a."createdAt" AS "createdAtA", b."createdAt" AS "createdAtB",
             COUNT(*) OVER()::int AS total
      FROM missing_person a
      JOIN missing_person b
        ON a.id < b.id
       AND a."personType" = b."personType"
       AND a.name IS NOT NULL
       AND LOWER(TRIM(a.name)) = LOWER(TRIM(b.name))
      WHERE a."deletedAt" IS NULL AND b."deletedAt" IS NULL
        AND a."mergedIntoId" IS NULL AND b."mergedIntoId" IS NULL
        AND a.status NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED', 'FOUND')
        AND b.status NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED', 'FOUND')
      ORDER BY a."createdAt" DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    return {
      data: rows.map(({ total: _total, name, ...row }) => ({
        ...row,
        label: row.personType === MissingPersonType.CHILD ? `Child case ${row.caseId.slice(0, 8)}` : name,
      })),
      meta: this.pageMeta(page, limit, rows[0]?.total ?? 0),
    };
  }

  async findPossibleDuplicates(id: string) {
    const existing = await this.loadCase(id);
    const window = 3 * 24 * 60 * 60 * 1000;

    const or: Prisma.MissingPersonWhereInput[] = [
      {
        lastKnownArea: { equals: existing.lastKnownArea, mode: 'insensitive' },
        dateLastSeen: {
          gte: new Date(existing.dateLastSeen.getTime() - window),
          lte: new Date(existing.dateLastSeen.getTime() + window),
        },
      },
    ];
    if (existing.name?.trim()) {
      or.push({ name: { equals: existing.name.trim(), mode: 'insensitive' } });
    }

    const candidates = await this.prisma.missingPerson.findMany({
      where: {
        ...this.adminBaseWhere,
        id: { not: id },
        personType: existing.personType,
        OR: or,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        name: true,
        personType: true,
        status: true,
        lastKnownArea: true,
        dateLastSeen: true,
        createdAt: true,
        userId: true,
      },
    });

    return {
      data: candidates.map((c) => {
        const matchedOn: string[] = [];
        if (existing.name && c.name && existing.name.trim().toLowerCase() === c.name.trim().toLowerCase()) {
          matchedOn.push('name');
        }
        if (
          c.lastKnownArea.toLowerCase() === existing.lastKnownArea.toLowerCase() &&
          Math.abs(c.dateLastSeen.getTime() - existing.dateLastSeen.getTime()) <= window
        ) {
          matchedOn.push('area_and_date');
        }
        return { ...c, label: this.caseLabel(c), matchedOn };
      }),
    };
  }

  // Moves tips, claims and updates onto this case and retires the duplicate.
  async merge(admin: CurrentUserDto, id: string, duplicateId: string, reason?: string) {
    if (id === duplicateId) throw new BadRequestException('cannot_merge_a_case_into_itself');

    const [primary, duplicate] = await Promise.all([this.loadCase(id), this.loadCase(duplicateId)]);

    if (primary.deletedAt || primary.mergedIntoId) throw new BadRequestException('target_case_not_available');
    if (duplicate.deletedAt || duplicate.mergedIntoId) throw new BadRequestException('duplicate_case_not_available');
    if (duplicate.legalHold) throw new ConflictException('duplicate_under_legal_hold');
    if (
      Number(duplicate.fundedAmount) > 0 ||
      duplicate.fundingStatus !== 'UNFUNDED' ||
      (await this.isRewardFunded(duplicateId))
    ) {
      throw new ConflictException('duplicate_has_funded_reward');
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.informationSubmission.updateMany({
        where: { missingPersonId: duplicateId },
        data: { missingPersonId: id },
      }),
      this.prisma.rewardClaim.updateMany({
        where: { missingPersonId: duplicateId },
        data: { missingPersonId: id },
      }),
      this.prisma.missingPersonUpdate.updateMany({
        where: { missingPersonId: duplicateId },
        data: { missingPersonId: id },
      }),
      this.prisma.missingPerson.update({
        where: { id: duplicateId },
        data: {
          mergedIntoId: id,
          mergedAt: now,
          mergedById: admin.id,
          status: MissingPersonStatus.CANCELLED,
          closureReason: `merged_into:${id}`,
          closedAt: now,
          claimedByUserId: null,
          claimedAt: null,
        },
      }),
    ]);

    await Promise.all([
      this.cache.invalidateMissingPersonEverywhere(id),
      this.cache.invalidateMissingPersonEverywhere(duplicateId),
    ]);

    this.auditOp(
      admin,
      primary,
      'merge',
      { mergedDuplicateId: duplicateId, duplicatePreviousStatus: duplicate.status },
      { reason: reason ?? null },
    );
    this.auditOp(
      admin,
      duplicate,
      'merged_into',
      { mergedIntoId: id, previousStatus: duplicate.status, newStatus: MissingPersonStatus.CANCELLED },
      { reason: reason ?? null },
    );

    return this.loadCase(id);
  }

  // ───────────── admin: search, facets, filters ─────────────

  async searchForAdmin(admin: CurrentUserDto, query: AdminSearchMissingPersonsQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
    const q = query.q.trim();

    const where: Prisma.MissingPersonWhereInput = {
      ...this.adminBaseWhere,
      ...(query.status !== undefined ? { status: query.status } : {}),
      OR: [
        { id: q },
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { lastKnownArea: { contains: q, mode: 'insensitive' } },
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { readStates: { where: { adminId: admin.id }, select: { adminId: true } } },
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data: rows.map(({ readStates, ...item }) => ({ ...item, isRead: readStates.length > 0 })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  // Column names here are fixed internal constants, never user input.
  private async facet(column: string, limit = 50): Promise<Array<{ value: string; count: number }>> {
    const col = Prisma.raw(`mp."${column}"::text`);
    return this.prisma.$queryRaw<Array<{ value: string; count: number }>>`
      SELECT ${col} AS value, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE mp."deletedAt" IS NULL AND mp."mergedIntoId" IS NULL AND ${col} IS NOT NULL
      GROUP BY 1
      ORDER BY count DESC, value ASC
      LIMIT ${limit}
    `;
  }

  async getFacets() {
    const [status, personType, gender, ageGroup, area, assignedTo] = await Promise.all([
      this.facet('status'),
      this.facet('personType'),
      this.facet('gender'),
      this.facet('ageGroup'),
      this.facet('lastKnownArea', 25),
      this.facet('assignedToUserId'),
    ]);
    return { status, personType, gender, ageGroup, area, assignedTo };
  }

  async getFilterOptions() {
    const [areas, genders, ageGroups, assignees] = await Promise.all([
      this.facet('lastKnownArea', 200),
      this.facet('gender'),
      this.facet('ageGroup'),
      this.prisma.user.findMany({
        where: { assignedMissingPersons: { some: {} } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      statuses: Object.values(MissingPersonStatus),
      personTypes: Object.values(MissingPersonType),
      areas: areas.map((a) => a.value),
      genders: genders.map((g) => g.value),
      ageGroups: ageGroups.map((a) => a.value),
      assignees,
    };
  }

  // ───────────── admin: attachments, redaction, custody, access log ─────────────

  async listAttachments(id: string) {
    const existing = await this.loadCase(id);

    const redactions = await this.prisma.missingPersonRedaction.findMany({
      where: { missingPersonId: id },
      orderBy: { createdAt: 'desc' },
      select: { mediaKey: true, status: true, mode: true, createdAt: true },
    });
    const latestRedaction = new Map<string, (typeof redactions)[number]>();
    for (const r of redactions) if (!latestRedaction.has(r.mediaKey)) latestRedaction.set(r.mediaKey, r);

    const entries = MEDIA_FIELD_NAMES.flatMap((field) =>
      existing[field].map((key) => ({ field, key })),
    );

    const data = await Promise.all(
      entries.map(async ({ field, key }) => {
        let size: number | null = null;
        let contentType: string | null = null;
        let hash: string | null = null;
        try {
          const stat = await this.minioService.statObject(key);
          size = stat.size;
          contentType = stat.contentType;
          hash = (stat as unknown as { etag?: string }).etag ?? null;
        } catch {
          // The object is missing in storage, report it with empty metadata.
        }
        const redaction = latestRedaction.get(key);
        return {
          field,
          key,
          size,
          contentType,
          hash,
          missingInStorage: size === null,
          redactionStatus: redaction?.status ?? null,
          redactionMode: redaction?.mode ?? null,
        };
      }),
    );

    return { missingPersonId: id, mediaTotalBytes: existing.mediaTotalBytes, data };
  }

  // Records the request. Pixel processing needs image tooling, so a worker completes PENDING rows.
  async redactMedia(admin: CurrentUserDto, id: string, key: string, data: RedactMissingPersonMediaDto) {
    const existing = await this.loadCase(id);
    if (existing.legalHold) throw new ConflictException('case_under_legal_hold');
    if (!this.collectMediaFields(existing).includes(key)) {
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const redaction = await this.prisma.missingPersonRedaction.create({
      data: {
        missingPersonId: id,
        mediaKey: key,
        mode: data.mode,
        reason: data.reason ?? null,
        status: MissingPersonRedactionStatus.PENDING,
        requestedById: admin.id,
      },
    });

    this.auditOp(
      admin,
      existing,
      'redact_media_requested',
      { mode: data.mode },
      { severity: AuditSeverity.WARNING, reason: data.reason ?? null, metadata: { key } },
    );
    return redaction;
  }

  async getMediaCustody(id: string, key: string) {
    const existing = await this.loadCase(id);
    if (!this.collectMediaFields(existing).includes(key)) {
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const [events, redactions] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          entity: 'MissingPerson',
          entityId: id,
          action: AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED,
          metadata: { path: ['key'], equals: key },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, userId: true, actorType: true, outcome: true, createdAt: true },
      }),
      this.prisma.missingPersonRedaction.findMany({
        where: { missingPersonId: id, mediaKey: key },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const userIds = [...new Set(events.map((e) => e.userId).filter((v): v is string => !!v))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    return {
      key,
      events: events.map((e) => ({
        id: e.id,
        at: e.createdAt,
        outcome: e.outcome,
        actorType: e.actorType,
        userId: e.userId,
        userName: e.userId ? (nameOf.get(e.userId) ?? null) : null,
      })),
      redactions,
    };
  }

  // Everything admins did on this case, plus who has it marked read.
  async getAccessLog(id: string, query: PaginationQueryDto) {
    await this.loadCase(id);
    const { page, limit, skip } = this.pageArgs(query);
    const where: Prisma.AuditLogWhereInput = {
      entity: 'MissingPerson',
      entityId: id,
      userId: { not: null },
      actorType: { in: ['ADMIN', 'SUPER_ADMIN'] },
    };

    const [events, total, readers] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { id: true, userId: true, actorName: true, action: true, outcome: true, createdAt: true, ipAddress: true },
      }),
      this.prisma.auditLog.count({ where }),
      this.prisma.missingPersonReadState.findMany({
        where: { missingPersonId: id },
        include: { admin: { select: { id: true, name: true } } },
        orderBy: { readAt: 'desc' },
      }),
    ]);

    return {
      readers: readers.map((r) => ({ adminId: r.adminId, adminName: r.admin.name, readAt: r.readAt })),
      data: events,
      meta: this.pageMeta(page, limit, total),
    };
  }

  // ───────────── admin: export ─────────────

  private exportWhere(query: AdminMissingPersonExportDto): Prisma.MissingPersonWhereInput {
    return {
      ...this.adminBaseWhere,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.personType !== undefined ? { personType: query.personType } : {}),
      ...(query.area ? { lastKnownArea: { contains: query.area, mode: 'insensitive' } } : {}),
      ...(query.assignedTo ? { assignedToUserId: query.assignedTo } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
  }

  // Cells starting with = + - @ are prefixed so spreadsheets never run them as formulas.
  private csvCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    let text = value instanceof Date ? value.toISOString() : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  // CHILD names are replaced with the same redacted label the audit log uses.
  private async buildExportCsv(query: AdminMissingPersonExportDto) {
    const maxRows = Number(this.configService.get<string>('MISSING_PERSON_EXPORT_MAX_ROWS') ?? 5000);

    const rows = await this.prisma.missingPerson.findMany({
      where: this.exportWhere(query),
      orderBy: { createdAt: 'desc' },
      take: maxRows + 1,
    });
    const truncated = rows.length > maxRows;
    const slice = truncated ? rows.slice(0, maxRows) : rows;

    const header = [
      'id',
      'status',
      'personType',
      'name',
      'lastKnownArea',
      'dateLastSeen',
      'createdAt',
      'updatedAt',
      'assignedToUserId',
      'claimedByUserId',
      'gender',
      'ageGroup',
      'rewardOffered',
      'rewardApproved',
      'rewardAmount',
      'fundingStatus',
    ];

    const lines = [header.join(',')];
    for (const r of slice) {
      lines.push(
        [
          r.id,
          r.status,
          r.personType,
          this.caseLabel(r) ?? '',
          r.lastKnownArea,
          r.dateLastSeen,
          r.createdAt,
          r.updatedAt,
          r.assignedToUserId,
          r.claimedByUserId,
          r.gender,
          r.ageGroup,
          r.rewardOffered,
          r.rewardApproved,
          r.rewardAmount,
          r.fundingStatus,
        ]
          .map((v) => this.csvCell(v))
          .join(','),
      );
    }

    return { csv: lines.join('\n'), rowCount: slice.length, truncated };
  }

  async exportCsv(admin: CurrentUserDto, query: AdminMissingPersonExportDto) {
    const built = await this.buildExportCsv(query);

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      severity: AuditSeverity.WARNING,
      entity: 'MissingPersonExport',
      entityId: `csv-${Date.now()}`,
      diff: { result: 'success', rowCount: built.rowCount, truncated: built.truncated },
      metadata: { operation: 'export_csv', filter: { ...query } },
    });

    return {
      filename: `missing-persons-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv',
      rowCount: built.rowCount,
      truncated: built.truncated,
      csv: built.csv,
    };
  }

  async startExportJob(admin: CurrentUserDto, data: AdminMissingPersonExportDto) {
    const ttlHours = Number(this.configService.get<string>('MISSING_PERSON_EXPORT_TTL_HOURS') ?? 24);
    const job = await this.prisma.missingPersonExportJob.create({
      data: {
        requestedById: admin.id,
        filter: { ...data } as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
      },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      severity: AuditSeverity.WARNING,
      entity: 'MissingPersonExportJob',
      entityId: job.id,
      diff: { result: 'success', jobId: job.id },
      metadata: { operation: 'export_job_started', filter: { ...data } },
    });

    // Runs after the response is sent, so the request returns immediately.
    setImmediate(() => {
      void this.runExportJob(job.id, data);
    });

    return { id: job.id, status: job.status, expiresAt: job.expiresAt };
  }

  private async runExportJob(jobId: string, filter: AdminMissingPersonExportDto): Promise<void> {
    try {
      await this.prisma.missingPersonExportJob.update({
        where: { id: jobId },
        data: { status: MissingPersonExportStatus.RUNNING },
      });
      const built = await this.buildExportCsv(filter);
      await this.prisma.missingPersonExportJob.update({
        where: { id: jobId },
        data: {
          status: MissingPersonExportStatus.COMPLETED,
          content: built.csv,
          rowCount: built.rowCount,
          truncated: built.truncated,
          completedAt: new Date(),
        },
      });
    } catch (err) {
      await this.prisma.missingPersonExportJob
        .update({
          where: { id: jobId },
          data: {
            status: MissingPersonExportStatus.FAILED,
            error: err instanceof Error ? err.message.slice(0, 500) : 'export_failed',
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
    }
  }

  private async loadExportJob(admin: CurrentUserDto, id: string) {
    const job = await this.prisma.missingPersonExportJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('export_job_not_found');

    const roles = (admin.roles ?? []) as unknown as string[];
    const isSuper = roles.includes(String(RolesEnum.SUPER_ADMIN));
    if (job.requestedById !== admin.id && !isSuper) throw new NotFoundException('export_job_not_found');

    if (job.expiresAt < new Date()) {
      if (job.content) {
        await this.prisma.missingPersonExportJob.update({ where: { id }, data: { content: null } });
      }
      throw new NotFoundException('export_job_expired');
    }
    return job;
  }

  async getExportJob(admin: CurrentUserDto, id: string) {
    const job = await this.loadExportJob(admin, id);
    return {
      id: job.id,
      status: job.status,
      rowCount: job.rowCount,
      truncated: job.truncated,
      error: job.error,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      expiresAt: job.expiresAt,
    };
  }

  // The CSV lives in the job row, so the download is returned inline rather than as a storage link.
  async getExportJobDownloadUrl(admin: CurrentUserDto, id: string) {
    const job = await this.loadExportJob(admin, id);
    if (job.status !== MissingPersonExportStatus.COMPLETED || !job.content) {
      throw new BadRequestException('export_job_not_ready');
    }

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED,
      severity: AuditSeverity.WARNING,
      entity: 'MissingPersonExportJob',
      entityId: id,
      diff: { result: 'success', jobId: id, rowCount: job.rowCount },
      metadata: { operation: 'export_job_download' },
    });

    return {
      filename: `missing-persons-${job.createdAt.toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv',
      rowCount: job.rowCount,
      truncated: job.truncated,
      csv: job.content,
    };
  }

  // ───────────── admin: statistics ─────────────

  // Builds the shared WHERE for the stats queries. Table is aliased mp, enum params are cast.
  private statsWhereSql(query: MissingPersonStatsQueryDto, opts: { skipDates?: boolean } = {}): Prisma.Sql {
    const c: Prisma.Sql[] = [
      Prisma.sql`mp."deletedAt" IS NULL`,
      Prisma.sql`mp."mergedIntoId" IS NULL`,
    ];
    if (!opts.skipDates && query.from) c.push(Prisma.sql`mp."createdAt" >= ${new Date(query.from)}`);
    if (!opts.skipDates && query.to) c.push(Prisma.sql`mp."createdAt" <= ${new Date(query.to)}`);
    if (query.status) c.push(Prisma.sql`mp.status = ${query.status}::"MissingPersonStatus"`);
    if (query.area) c.push(Prisma.sql`mp."lastKnownArea" ILIKE ${`%${query.area}%`}`);
    if (query.gender) c.push(Prisma.sql`UPPER(mp.gender) = ${query.gender.toUpperCase()}`);
    if (query.ageGroup) c.push(Prisma.sql`mp."ageGroup" = ${query.ageGroup}`);
    if (query.involvesChild === true) c.push(Prisma.sql`mp."personType" = 'CHILD'::"MissingPersonType"`);
    if (query.involvesChild === false) c.push(Prisma.sql`mp."personType" <> 'CHILD'::"MissingPersonType"`);
    if (query.assignedTo) c.push(Prisma.sql`mp."assignedToUserId" = ${query.assignedTo}`);
    return Prisma.join(c, ' AND ');
  }

  // Expects an inner query that returns one float8 column named h (hours).
  private async hoursSummary(inner: Prisma.Sql) {
    const rows = await this.prisma.$queryRaw<
      {
        count: number;
        avg: number | null;
        median: number | null;
        p90: number | null;
        min: number | null;
        max: number | null;
      }[]
    >`
      SELECT COUNT(h)::int AS count,
             ROUND(AVG(h)::numeric, 2)::float8 AS avg,
             ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY h))::numeric, 2)::float8 AS median,
             ROUND((percentile_cont(0.9) WITHIN GROUP (ORDER BY h))::numeric, 2)::float8 AS p90,
             ROUND(MIN(h)::numeric, 2)::float8 AS min,
             ROUND(MAX(h)::numeric, 2)::float8 AS max
      FROM (${inner}) t
    `;
    const r = rows[0];
    return {
      count: r?.count ?? 0,
      avgHours: r?.avg ?? null,
      medianHours: r?.median ?? null,
      p90Hours: r?.p90 ?? null,
      minHours: r?.min ?? null,
      maxHours: r?.max ?? null,
    };
  }

  private unitSql(interval: MissingPersonStatsInterval | undefined): Prisma.Sql {
    switch (interval) {
      case MissingPersonStatsInterval.WEEK:
        return Prisma.raw(`'week'`);
      case MissingPersonStatsInterval.MONTH:
        return Prisma.raw(`'month'`);
      default:
        return Prisma.raw(`'day'`);
    }
  }

  async getStatsTimeline(query: MissingPersonStatsTimelineQueryDto) {
    const w = this.statsWhereSql(query);
    const unit = this.unitSql(query.interval);
    const rows = await this.prisma.$queryRaw<{ bucket: Date; count: number }[]>`
      SELECT date_trunc(${unit}, mp."createdAt") AS bucket, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE ${w}
      GROUP BY 1
      ORDER BY 1
    `;
    return {
      interval: query.interval ?? MissingPersonStatsInterval.DAY,
      data: rows.map((r) => ({ period: r.bucket.toISOString().slice(0, 10), count: r.count })),
    };
  }

  async getStatsByStatus(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const rows = await this.prisma.$queryRaw<{ status: string; count: number }[]>`
      SELECT mp.status::text AS status, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE ${w}
      GROUP BY 1
    `;
    const byStatus = Object.fromEntries(
      Object.values(MissingPersonStatus).map((s) => [s, 0]),
    ) as Record<string, number>;
    for (const row of rows) byStatus[row.status] = row.count;
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

    return {
      total,
      data: Object.entries(byStatus).map(([status, count]) => ({
        status,
        count,
        share: total > 0 ? Number((count / total).toFixed(4)) : 0,
      })),
    };
  }

  // Area text is "Area, Region", so the last comma-separated part is treated as the region.
  async getStatsByArea(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const rows = await this.prisma.$queryRaw<{ area: string; count: number }[]>`
      SELECT mp."lastKnownArea" AS area, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE ${w}
      GROUP BY 1
      ORDER BY count DESC
    `;

    const regions = new Map<string, { total: number; areas: Array<{ area: string; count: number }> }>();
    for (const row of rows) {
      const parts = row.area.split(',').map((p) => p.trim()).filter(Boolean);
      const region = parts.length > 1 ? parts[parts.length - 1] : 'Unspecified';
      const area = parts.length > 1 ? parts.slice(0, -1).join(', ') : row.area;
      const entry = regions.get(region) ?? { total: 0, areas: [] };
      entry.total += row.count;
      entry.areas.push({ area, count: row.count });
      regions.set(region, entry);
    }

    return {
      total: rows.reduce((sum, r) => sum + r.count, 0),
      regions: [...regions.entries()]
        .map(([region, v]) => ({ region, ...v }))
        .sort((a, b) => b.total - a.total),
    };
  }

  // Gender and age group are optional columns, cases without them show as UNSPECIFIED.
  async getStatsByDemographics(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const rows = await this.prisma.$queryRaw<
      { personType: string; gender: string; ageGroup: string; count: number }[]
    >`
      SELECT mp."personType"::text AS "personType",
             COALESCE(mp.gender, 'UNSPECIFIED') AS gender,
             COALESCE(mp."ageGroup", 'UNSPECIFIED') AS "ageGroup",
             COUNT(*)::int AS count
      FROM missing_person mp
      WHERE ${w}
      GROUP BY 1, 2, 3
      ORDER BY count DESC
    `;

    const tally = (key: 'personType' | 'gender' | 'ageGroup') => {
      const map: Record<string, number> = {};
      for (const r of rows) map[r[key]] = (map[r[key]] ?? 0) + r.count;
      return map;
    };

    return {
      total: rows.reduce((sum, r) => sum + r.count, 0),
      byPersonType: tally('personType'),
      byGender: tally('gender'),
      byAgeGroup: tally('ageGroup'),
      breakdown: rows,
    };
  }

  // Listing to found, using the FOUND audit event when there is one.
  async getStatsResolutionTime(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    return this.hoursSummary(Prisma.sql`
      SELECT (EXTRACT(EPOCH FROM (
               COALESCE(
                 (SELECT MIN(a."createdAt") FROM audit_log a
                   WHERE a.entity = 'MissingPerson' AND a."entityId" = mp.id
                     AND a.action = ${AuditEventEnum.MISSING_PERSON_FOUND} AND a.outcome = 'SUCCESS'),
                 mp."updatedAt"
               ) - mp."createdAt")) / 3600)::float8 AS h
      FROM missing_person mp
      WHERE ${w} AND mp.status = 'FOUND'
    `);
  }

  // Cases grouped by the month they were created, with how many of them ended up found.
  async getStatsFoundRate(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const rows = await this.prisma.$queryRaw<{ bucket: Date; created: number; found: number; open: number }[]>`
      SELECT date_trunc('month', mp."createdAt") AS bucket,
             COUNT(*)::int AS created,
             COUNT(*) FILTER (WHERE mp.status = 'FOUND')::int AS found,
             COUNT(*) FILTER (WHERE mp.status = 'APPROVED')::int AS open
      FROM missing_person mp
      WHERE ${w}
      GROUP BY 1
      ORDER BY 1
    `;
    return {
      data: rows.map((r) => ({
        period: r.bucket.toISOString().slice(0, 7),
        created: r.created,
        found: r.found,
        stillMissing: r.open,
        foundRate: r.created > 0 ? Number((r.found / r.created).toFixed(4)) : 0,
      })),
    };
  }

  // First review is the first admin audit event after creation, decision is approve or reject.
  async getStatsReviewTime(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const decisionActions = Prisma.join([
      AuditEventEnum.MISSING_PERSON_APPROVED,
      AuditEventEnum.MISSING_PERSON_REJECTED,
    ]);

    const [firstReview, decision] = await Promise.all([
      this.hoursSummary(Prisma.sql`
        SELECT (EXTRACT(EPOCH FROM (x.first_at - x."createdAt")) / 3600)::float8 AS h
        FROM (
          SELECT mp."createdAt",
                 (SELECT MIN(a."createdAt") FROM audit_log a
                   WHERE a.entity = 'MissingPerson' AND a."entityId" = mp.id
                     AND a.outcome = 'SUCCESS'
                     AND a."actorType" IN ('ADMIN', 'SUPER_ADMIN')
                     AND a.action <> ${AuditEventEnum.MISSING_PERSON_CREATED}) AS first_at
          FROM missing_person mp
          WHERE ${w}
        ) x
        WHERE x.first_at IS NOT NULL
      `),
      this.hoursSummary(Prisma.sql`
        SELECT (EXTRACT(EPOCH FROM (x.decided_at - x."createdAt")) / 3600)::float8 AS h
        FROM (
          SELECT mp."createdAt",
                 (SELECT MIN(a."createdAt") FROM audit_log a
                   WHERE a.entity = 'MissingPerson' AND a."entityId" = mp.id
                     AND a.outcome = 'SUCCESS'
                     AND a.action IN (${decisionActions})) AS decided_at
          FROM missing_person mp
          WHERE ${w}
        ) x
        WHERE x.decided_at IS NOT NULL
      `),
    ]);

    return { timeToFirstReview: firstReview, timeToDecision: decision };
  }

  // Daily count of cases still waiting on a first decision. Range defaults to the last 30 days.
  async getStatsBacklog(query: MissingPersonStatsQueryDto) {
    const to = query.to ? new Date(query.to) : new Date();
    const fromDefault = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    let from = query.from ? new Date(query.from) : fromDefault;
    const maxDays = 366;
    if (to.getTime() - from.getTime() > maxDays * 24 * 60 * 60 * 1000) {
      from = new Date(to.getTime() - maxDays * 24 * 60 * 60 * 1000);
    }

    const w = this.statsWhereSql(query, { skipDates: true });
    const decisionActions = Prisma.join([
      AuditEventEnum.MISSING_PERSON_APPROVED,
      AuditEventEnum.MISSING_PERSON_REJECTED,
    ]);

    const rows = await this.prisma.$queryRaw<{ day: Date; count: number }[]>`
      WITH c AS (
        SELECT mp."createdAt",
               COALESCE(
                 (SELECT MIN(a."createdAt") FROM audit_log a
                   WHERE a.entity = 'MissingPerson' AND a."entityId" = mp.id
                     AND a.outcome = 'SUCCESS' AND a.action IN (${decisionActions})),
                 CASE WHEN mp.status NOT IN ('PENDING', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUESTED')
                      THEN mp."updatedAt" END
               ) AS decided_at
        FROM missing_person mp
        WHERE ${w}
      )
      SELECT d::date AS day, COUNT(c."createdAt")::int AS count
      FROM generate_series(
             date_trunc('day', ${from}::timestamp),
             date_trunc('day', ${to}::timestamp),
             interval '1 day'
           ) AS d
      LEFT JOIN c
        ON c."createdAt" < d + interval '1 day'
       AND (c.decided_at IS NULL OR c.decided_at >= d + interval '1 day')
      GROUP BY d
      ORDER BY d
    `;

    return { data: rows.map((r) => ({ date: r.day.toISOString().slice(0, 10), pending: r.count })) };
  }

  async getStatsAging(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const rows = await this.prisma.$queryRaw<{ createdAt: Date }[]>`
      SELECT mp."createdAt" AS "createdAt"
      FROM missing_person mp
      WHERE ${w} AND mp.status IN ('PENDING', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUESTED')
    `;

    const buckets = [
      { label: '0-24h', maxHours: 24, count: 0 },
      { label: '1-3d', maxHours: 72, count: 0 },
      { label: '3-7d', maxHours: 168, count: 0 },
      { label: '7-14d', maxHours: 336, count: 0 },
      { label: '14d+', maxHours: Infinity, count: 0 },
    ];
    const now = Date.now();
    for (const row of rows) {
      const hours = (now - row.createdAt.getTime()) / (60 * 60 * 1000);
      const bucket = buckets.find((b) => hours < b.maxHours);
      if (bucket) bucket.count += 1;
    }

    return {
      total: rows.length,
      data: buckets.map(({ label, count }) => ({ bucket: label, count })),
    };
  }

  async getStatsTips(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);

    const [totals, firstTip] = await Promise.all([
      this.prisma.$queryRaw<{ cases: number; casesWithTips: number; tips: number }[]>`
        SELECT COUNT(DISTINCT mp.id)::int AS cases,
               COUNT(DISTINCT mp.id) FILTER (WHERE i.id IS NOT NULL)::int AS "casesWithTips",
               COUNT(i.id)::int AS tips
        FROM missing_person mp
        LEFT JOIN information_submission i ON i."missingPersonId" = mp.id
        WHERE ${w}
      `,
      this.hoursSummary(Prisma.sql`
        SELECT (EXTRACT(EPOCH FROM (MIN(i."createdAt") - mp."createdAt")) / 3600)::float8 AS h
        FROM missing_person mp
        JOIN information_submission i ON i."missingPersonId" = mp.id
        WHERE ${w}
        GROUP BY mp.id, mp."createdAt"
      `),
    ]);

    const t = totals[0] ?? { cases: 0, casesWithTips: 0, tips: 0 };
    return {
      cases: t.cases,
      casesWithTips: t.casesWithTips,
      totalTips: t.tips,
      avgTipsPerCase: t.cases > 0 ? Number((t.tips / t.cases).toFixed(2)) : 0,
      timeToFirstTip: firstTip,
    };
  }

  // Decisions come from audit rows. Open workload counts cases assigned and still in the backlog.
  async getStatsByAdmin(query: MissingPersonStatsQueryDto) {
    const w = this.statsWhereSql(query);
    const decisionActions = Prisma.join([
      AuditEventEnum.MISSING_PERSON_APPROVED,
      AuditEventEnum.MISSING_PERSON_REJECTED,
      AuditEventEnum.MISSING_PERSON_MORE_INFO_REQUESTED,
      AuditEventEnum.MISSING_PERSON_FOUND,
    ]);

    const [decisions, workload] = await Promise.all([
      this.prisma.$queryRaw<
        { adminId: string; decisions: number; approved: number; rejected: number; avgHours: number | null }[]
      >`
        SELECT a."userId" AS "adminId",
               COUNT(*)::int AS decisions,
               COUNT(*) FILTER (WHERE a.action = ${AuditEventEnum.MISSING_PERSON_APPROVED})::int AS approved,
               COUNT(*) FILTER (WHERE a.action = ${AuditEventEnum.MISSING_PERSON_REJECTED})::int AS rejected,
               ROUND(AVG(EXTRACT(EPOCH FROM (a."createdAt" - mp."createdAt")) / 3600)::numeric, 2)::float8 AS "avgHours"
        FROM audit_log a
        JOIN missing_person mp ON mp.id = a."entityId"
        WHERE a.entity = 'MissingPerson' AND a.outcome = 'SUCCESS' AND a."userId" IS NOT NULL
          AND a.action IN (${decisionActions}) AND ${w}
        GROUP BY a."userId"
        ORDER BY decisions DESC
      `,
      this.prisma.$queryRaw<{ adminId: string; open: number }[]>`
        SELECT mp."assignedToUserId" AS "adminId", COUNT(*)::int AS open
        FROM missing_person mp
        WHERE ${w} AND mp."assignedToUserId" IS NOT NULL
          AND mp.status IN ('PENDING', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUESTED')
        GROUP BY 1
      `,
    ]);

    const ids = [...new Set([...decisions.map((d) => d.adminId), ...workload.map((x) => x.adminId)])];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const openOf = new Map(workload.map((x) => [x.adminId, x.open]));
    const decisionOf = new Map(decisions.map((d) => [d.adminId, d]));

    return {
      data: ids
        .map((adminId) => {
          const d = decisionOf.get(adminId);
          return {
            adminId,
            adminName: nameOf.get(adminId) ?? null,
            openAssigned: openOf.get(adminId) ?? 0,
            decisions: d?.decisions ?? 0,
            approved: d?.approved ?? 0,
            rejected: d?.rejected ?? 0,
            avgHoursToDecision: d?.avgHours ?? null,
          };
        })
        .sort((a, b) => b.decisions - a.decisions),
    };
  }

  // Everything the dashboard home needs in one round trip.
  async getStatsOverview(query: MissingPersonStatsQueryDto) {
    const [
      byStatus,
      aging,
      reviewTime,
      resolutionTime,
      tips,
      openFlags,
      pendingAppeals,
      pendingFoundClaims,
      legalHolds,
      timeline,
    ] = await Promise.all([
      this.getStatsByStatus(query),
      this.getStatsAging(query),
      this.getStatsReviewTime(query),
      this.getStatsResolutionTime(query),
      this.getStatsTips(query),
      this.prisma.missingPersonFlag.count({ where: { status: MissingPersonFlagState.OPEN } }),
      this.prisma.missingPersonAppeal.count({ where: { status: MissingPersonAppealState.PENDING } }),
      this.prisma.missingPerson.count({
        where: {
          ...this.adminBaseWhere,
          status: MissingPersonStatus.APPROVED,
          foundReportedAt: { not: null },
          foundReportResolvedAt: null,
        },
      }),
      this.prisma.missingPerson.count({ where: { legalHold: true } }),
      this.getStatsTimeline({ ...query, interval: MissingPersonStatsInterval.DAY }),
    ]);

    const count = (s: MissingPersonStatus) =>
      byStatus.data.find((r) => r.status === s)?.count ?? 0;

    return {
      total: byStatus.total,
      active: count(MissingPersonStatus.APPROVED),
      found: count(MissingPersonStatus.FOUND),
      backlog: aging.total,
      byStatus: byStatus.data,
      aging: aging.data,
      reviewTime,
      resolutionTime,
      tips,
      queues: { openFlags, pendingAppeals, pendingFoundClaims, legalHolds },
      timeline: timeline.data,
    };
  }
}
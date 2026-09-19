import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  AuditOutcome,
  AuditSeverity,
  MissingPerson,
  MissingPersonStatus,
  MissingPersonType,
  Prisma,
} from '@prisma/client';

import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { MinioService } from 'src/services/minio/minio.service';

import {
  AdminCreateMissingPersonDto,
  CreateMissingPersonDto,
  ListMissingPersonsAdminQueryDto,
  ListMissingPersonsQueryDto,
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
const TERMINAL_STATUSES: MissingPersonStatus[] = [
  MissingPersonStatus.REJECTED,
  MissingPersonStatus.FOUND,
];

@Injectable()
export class MissingPersonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  private readonly EDITABLE_STATUSES: MissingPersonStatus[] = [
    MissingPersonStatus.PENDING,
    MissingPersonStatus.MORE_INFORMATION_REQUESTED,
  ];

  // Admin status workflow. PENDING must pass through UNDER_REVIEW first.
  private readonly ALLOWED_TRANSITIONS: Record<MissingPersonStatus, MissingPersonStatus[]> = {
    [MissingPersonStatus.PENDING]: [MissingPersonStatus.UNDER_REVIEW],
    [MissingPersonStatus.UNDER_REVIEW]: [
      MissingPersonStatus.MORE_INFORMATION_REQUESTED,
      MissingPersonStatus.APPROVED,
      MissingPersonStatus.REJECTED,
    ],
    [MissingPersonStatus.MORE_INFORMATION_REQUESTED]: [],
    [MissingPersonStatus.APPROVED]: [MissingPersonStatus.FOUND],
    [MissingPersonStatus.REJECTED]: [],
    [MissingPersonStatus.FOUND]: [],
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
      } as AuditEventPayload['diff'],
      ...(opts.metadata ? { metadata: opts.metadata as AuditEventPayload['metadata'] } : {}),
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
    existing?: { rewardOffered: boolean; rewardAmount: number | null; rewardDetails: string | null },
  ): { rewardOffered: boolean; rewardAmount: number | null; rewardDetails: string | null } | null {
    const touched =
      incoming.rewardOffered !== undefined ||
      incoming.rewardAmount !== undefined ||
      incoming.rewardDetails !== undefined;

    if (!touched && existing) return null;

    const base = existing ?? { rewardOffered: false, rewardAmount: null, rewardDetails: null };

    const rewardOffered = incoming.rewardOffered ?? base.rewardOffered;
    const rewardAmount = rewardOffered ? incoming.rewardAmount ?? base.rewardAmount ?? null : null;
    const rewardDetails = rewardOffered ? incoming.rewardDetails ?? base.rewardDetails ?? null : null;

    return { rewardOffered, rewardAmount, rewardDetails };
  }

  // Hides reward amount and details publicly until an admin approves.
  private maskUnapprovedReward<
    T extends { rewardApproved: boolean; rewardAmount: number | null; rewardDetails: string | null },
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
      actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
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
        actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
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
          targetUserId: missingPerson.userId,
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
    });

    return missingPerson;
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
    rewardProposal: { rewardOffered: boolean; rewardAmount: number | null; rewardDetails: string | null },
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
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: this.publicSelect,
    });

    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }

    return this.maskUnapprovedReward(missingPerson);
  }

  async findAll(query: ListMissingPersonsQueryDto) {
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
        { outcome: AuditOutcome.DENIED, targetUserId: existing.userId },
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
        { outcome: AuditOutcome.DENIED, targetUserId: existing.userId },
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

    if (status === MissingPersonStatus.REJECTED) {
      await this.maybeFlagUserForRejections(existing.userId);
    }

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
        amountOverriddenByAdmin: rewardAmount !== undefined && rewardAmount !== existing.rewardAmount,
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
}
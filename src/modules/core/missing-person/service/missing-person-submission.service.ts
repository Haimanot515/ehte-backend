import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditOutcome, MissingPersonStatus, MissingPersonType, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  AdminCreateMissingPersonDto,
  CreateMissingPersonDto,
  UpdateMissingPersonDto,
} from '../dto/missing-person.dto';
import {
  MEDIA_FIELD_NAMES,
  MediaBearing,
  MediaBearingDto,
  UPDATABLE_FIELD_NAMES,
  EDITABLE_STATUSES,
} from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

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
    this.missingPersonCommonService.assertAttachmentCounts(merged);

    const validated = await this.missingPersonCommonService.validateMediaFilesExist(
      this.missingPersonCommonService.collectMediaFields(merged),
    );
    const totalBytes = validated.reduce((sum, v) => sum + v.size, 0);
    this.missingPersonCommonService.assertTotalBytes(totalBytes);

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

    this.missingPersonCommonService.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_CREATED,
      entity: 'MissingPerson',
      entityId: missingPerson.id,
      entityLabel: this.missingPersonCommonService.caseLabel(missingPerson),
      diff: {
        personType: missingPerson.personType,
        status: missingPerson.status,
        result: 'success',
      },
      metadata: {
        rewardOffered: missingPerson.rewardOffered,
        attachmentCount: this.missingPersonCommonService.collectMediaFields(merged).length,
        mediaTotalBytes: totalBytes,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.NEW_MISSING_PERSON_REQUEST, {
      missingPersonId: missingPerson.id,
      userId: user.id,
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

    // A non-CHILD admin-created case is born APPROVED — it's immediately public.
    if (status === MissingPersonStatus.APPROVED) {
      await this.cache.invalidateMissingPersonCaches();
    }

    this.missingPersonCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_CREATED,
      entity: 'MissingPerson',
      entityId: missingPerson.id,
      entityLabel: this.missingPersonCommonService.caseLabel(missingPerson),
      diff: {
        personType: missingPerson.personType,
        status: missingPerson.status,
        result: 'success',
      },
      metadata: {
        operation: 'admin_create',
        rewardOffered: missingPerson.rewardOffered,
        rewardApproved: missingPerson.rewardApproved,
        attachmentCount: this.missingPersonCommonService.collectMediaFields(merged).length,
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

  async update(user: CurrentUserDto, id: string, data: UpdateMissingPersonDto) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (existing.userId !== user.id) {
      this.missingPersonCommonService.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'not_authorized_to_update',
        { outcome: AuditOutcome.DENIED, targetUserId: existing.userId ?? undefined },
      );
      throw new ForbiddenException('not_authorized_to_update');
    }

    if (!EDITABLE_STATUSES.includes(existing.status)) {
      this.missingPersonCommonService.emitCaseFailure(
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
      this.missingPersonCommonService.emitCaseFailure(
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
      this.missingPersonCommonService.assertAttachmentCounts(merged);

      const validatedAdded = await this.missingPersonCommonService.validateMediaFilesExist(added);
      const addedBytes = validatedAdded.reduce((sum, v) => sum + v.size, 0);

      const removedStats = await Promise.allSettled(
        removed.map((fp) => this.minioService.statObject(fp)),
      );
      const removedBytes = removedStats.reduce(
        (sum, r) => sum + (r.status === 'fulfilled' ? r.value.size : 0),
        0,
      );

      newTotalBytes = Math.max(0, existing.mediaTotalBytes + addedBytes - removedBytes);
      this.missingPersonCommonService.assertTotalBytes(newTotalBytes);
    } catch (err) {
      this.missingPersonCommonService.emitCaseFailure(
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

    if (rewardUpdate !== null && (await this.missingPersonCommonService.isRewardFunded(id))) {
      this.missingPersonCommonService.emitCaseFailure(
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
    await this.missingPersonCommonService.deleteMediaFiles(removed);

    this.missingPersonCommonService.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: updated.id,
      entityLabel: this.missingPersonCommonService.caseLabel(updated),
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
      this.missingPersonCommonService.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_DELETED,
        existing,
        'not_authorized_to_delete',
        { outcome: AuditOutcome.DENIED, targetUserId: existing.userId ?? undefined },
      );
      throw new ForbiddenException('not_authorized_to_delete');
    }

    if (existing.status !== MissingPersonStatus.PENDING) {
      this.missingPersonCommonService.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_DELETED,
        existing,
        'only_pending_submissions_can_be_deleted',
        { diff: { currentStatus: existing.status } },
      );
      throw new ForbiddenException('only_pending_submissions_can_be_deleted');
    }

    await this.prisma.missingPerson.delete({ where: { id } });

    const mediaKeys = this.missingPersonCommonService.collectMediaFields(existing);
    await this.missingPersonCommonService.deleteMediaFiles(mediaKeys);

    this.missingPersonCommonService.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_DELETED,
      entity: 'MissingPerson',
      entityId: id,
      entityLabel: this.missingPersonCommonService.caseLabel(existing),
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

  // There is no DRAFT status, so the copy is a normal PENDING case with the person-specific
  // fields (name, media, reward) left empty for the owner to fill in via PATCH :id.
  async duplicateAsDraft(user: CurrentUserDto, id: string, idempotencyKey?: string) {
    const source = await this.missingPersonCommonService.loadOwnCase(user, id);

    if (idempotencyKey) {
      const prior = await this.prisma.missingPerson.findFirst({
        where: { userId: user.id, idempotencyKey },
      });
      if (prior) return this.missingPersonCommonService.toOwnerView(prior);
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

      this.missingPersonCommonService.auditOp(
        user,
        created,
        'duplicate_as_draft',
        { copiedFromId: source.id },
        { action: AuditEventEnum.MISSING_PERSON_CREATED },
      );
      return this.missingPersonCommonService.toOwnerView(created);
    } catch (err) {
      if (
        idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await this.prisma.missingPerson.findFirst({
          where: { userId: user.id, idempotencyKey },
        });
        if (winner) return this.missingPersonCommonService.toOwnerView(winner);
      }
      throw err;
    }
  }
}

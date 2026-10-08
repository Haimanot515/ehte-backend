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
  Prisma,
  VictimProfile,
  VictimProfileAppealStatus,
  VictimProfileStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  CreateProfileUpdateDto,
  FindAllVictimProfilesQueryDto,
  PagedQueryDto,
  UpdateVictimProfileDto,
} from '../dto/victim-profile.dto';
import {
  MediaBearing,
  MediaBearingDto,
  UPDATABLE_FIELD_NAMES,
  money,
  CONFIRMED_SUPPORT_STATUSES,
  CREATOR_EDITABLE_STATUSES,
  CREATOR_WITHDRAWABLE_STATUSES,
  CREATOR_RESUBMITTABLE_STATUSES,
  CREATOR_VISIBLE_STAFF_ACTIONS,
  CREATOR_TIMELINE_ACTIONS,
  PUBLIC_PROFILE_SELECT,
  maskAccount,
  chunk,
} from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileMineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  // Same media bookkeeping update() does, extracted so the creator path can reuse it.
  private async computeMediaChange(profile: VictimProfile, data: MediaBearingDto) {
    const { added, removed } = this.victimProfileCommonService.diffMediaFields(profile, data);

    const merged: MediaBearing = {
      photo: data.photo ?? profile.photo,
      video: data.video ?? profile.video,
      audio: data.audio ?? profile.audio,
      pdf: data.pdf ?? profile.pdf,
      document: data.document ?? profile.document,
      other: data.other ?? profile.other,
    };
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

    const newTotalBytes = Math.max(0, profile.mediaTotalBytes + addedBytes - removedBytes);
    this.victimProfileCommonService.assertTotalBytes(newTotalBytes);

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

  private serializeMine(
    p: VictimProfile,
    unseen: boolean,
    dest?: { accountHolder: string; bankName: string | null; accountNumber: string | null; isVerified: boolean } | null,
  ) {
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
        accountName: dest?.accountHolder ?? null,
        bankName: dest?.bankName ?? null,
        accountNumberMasked: maskAccount(dest?.accountNumber),
        isVerified: dest?.isVerified ?? false,
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
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
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
    const dests = await this.prisma.payoutDestination.findMany({
      where: { victimProfileId: { in: rows.map((r) => r.id) } },
      select: {
        victimProfileId: true,
        accountHolder: true,
        bankName: true,
        accountNumber: true,
        isVerified: true,
      },
    });
    const destByProfile = new Map(dests.map((d) => [d.victimProfileId, d]));

    return {
      data: rows.map((row) => this.serializeMine(row, unseen.has(row.id), destByProfile.get(row.id))),
      meta: this.victimProfileCommonService.metaOf(page, limit, total),
    };
  }

  // VP-02
  async findOneMine(user: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getMineOr404(user, id);

    const [unseen, dest, latestAppeal] = await Promise.all([
      this.findUnseenProfileIds(user.id, [profile]),
      this.prisma.payoutDestination.findUnique({
        where: { victimProfileId: id },
        select: { accountHolder: true, bankName: true, accountNumber: true, isVerified: true },
      }),
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
      ...this.serializeMine(profile, unseen.has(id), dest),
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
    const profile = await this.victimProfileCommonService.getMineOr404(user, id);

    if (!CREATOR_EDITABLE_STATUSES.includes(profile.status)) {
      this.victimProfileCommonService.emitProfileFailure(
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
      this.victimProfileCommonService.emitProfileFailure(
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

    let media: Awaited<ReturnType<typeof this.computeMediaChange>>;
    try {
      media = await this.computeMediaChange(profile, data);
    } catch (err) {
      this.victimProfileCommonService.emitProfileFailure(
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
    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        name: data.name,
        description: data.description,
        story: data.story,
        supportType: data.supportType,
        supportGoal: data.supportGoal,
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

    await this.victimProfileCommonService.deleteMediaFiles(media.removed);
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      user,
      AuditEventEnum.VICTIM_PROFILE_UPDATED,
      updated,
      {
        diff: { previousStatus: profile.status, newStatus: updated.status },
        metadata: {
          actor: 'creator',
          fieldsUpdated,
          mediaAdded: media.added.length,
          mediaRemoved: media.removed.length,
          mediaTotalBytes: media.newTotalBytes,
        },
      },
    );

    return this.serializeMine(updated, false);
  }

  // VP-05
  async withdrawMine(user: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getMineOr404(user, id);

    if (profile.isPublished || !CREATOR_WITHDRAWABLE_STATUSES.includes(profile.status)) {
      this.victimProfileCommonService.emitProfileFailure(
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

    const updated = await this.victimProfileCommonService.conditionalUpdate(
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

    this.victimProfileCommonService.auditSuccess(
      user,
      AuditEventEnum.VICTIM_PROFILE_WITHDRAWN,
      updated,
      {
        diff: { previousStatus: profile.status, newStatus: VictimProfileStatus.WITHDRAWN },
        metadata: { releasedClaimOf: profile.claimedByUserId },
      },
    );

    return this.serializeMine(updated, false);
  }

  // VP-06
  async resubmitMine(user: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getMineOr404(user, id);

    if (!CREATOR_RESUBMITTABLE_STATUSES.includes(profile.status)) {
      this.victimProfileCommonService.emitProfileFailure(
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

    const status = this.victimProfileCommonService.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: profile.isAdminApproved,
    });

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      { status, isPublished: false, reviewNote: null, reviewNoteAt: null },
      { admin: user, action: AuditEventEnum.VICTIM_PROFILE_RESUBMITTED, profile },
    );

    // Back to every admin's unread queue.
    await this.prisma.victimProfileReadState.deleteMany({ where: { profileId: id } });
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      user,
      AuditEventEnum.VICTIM_PROFILE_RESUBMITTED,
      updated,
      {
        diff: { previousStatus: profile.status, newStatus: status },
        metadata: { actor: 'creator' },
      },
    );

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
    const profile = await this.victimProfileCommonService.getMineOr404(user, id);

    if (!this.victimProfileCommonService.collectMediaFields(profile).includes(query.key)) {
      this.victimProfileCommonService.emitProfileFailure(
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

    this.victimProfileCommonService.auditSuccess(
      user,
      AuditEventEnum.VICTIM_PROFILE_MEDIA_DOWNLOADED,
      profile,
      {
        metadata: { key: query.key, actor: 'creator' },
      },
    );

    return { url };
  }

  // VP-08
  async removeMineMedia(user: CurrentUserDto, id: string, key: string) {
    const profile = await this.victimProfileCommonService.getMineOr404(user, id);

    if (!CREATOR_EDITABLE_STATUSES.includes(profile.status)) {
      throw new BadRequestException('victim_profile_not_editable');
    }

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
      { admin: user, action: AuditEventEnum.VICTIM_PROFILE_MEDIA_REMOVED, profile },
    );

    await this.victimProfileCommonService.deleteMediaFiles([key]);
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      user,
      AuditEventEnum.VICTIM_PROFILE_MEDIA_REMOVED,
      updated,
      {
        metadata: { key, field, actor: 'creator', bytesFreed: size },
      },
    );

    return { message: 'media_removed', id, key };
  }

  // VP-09
  async getMineTimeline(user: CurrentUserDto, id: string) {
    await this.victimProfileCommonService.getMineOr404(user, id);

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
    const profile = await this.victimProfileCommonService.getMineOr404(user, id);

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
    const profile = await this.victimProfileCommonService.getMineOr404(user, id);

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

    this.victimProfileCommonService.auditSuccess(
      user,
      AuditEventEnum.VICTIM_PROFILE_UPDATE_POSTED,
      profile,
      {
        metadata: { updateId: update.id, actor: 'creator' },
      },
    );

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
    await this.victimProfileCommonService.getMineOr404(user, id);
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

  // VP-24
  async findMySupported(user: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const supportFilter = {
      userId: user.id,
      status: { in: [...CONFIRMED_SUPPORT_STATUSES] },
    } satisfies Prisma.SupportWhereInput;
    const where: Prisma.VictimProfileWhereInput = {
      ...this.victimProfileCommonService.publicWhere(),
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
        ...this.victimProfileCommonService.serializePublicProfile(row),
        mySupportCount: counts.get(row.id) ?? 0,
      })),
      meta: this.victimProfileCommonService.metaOf(page, limit, total),
    };
  }
}

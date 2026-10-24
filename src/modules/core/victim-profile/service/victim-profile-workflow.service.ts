import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditSeverity, Prisma, VictimProfileStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  AssignReviewerDto,
  BulkAssignDto,
  BulkReasonDto,
  BulkRequestChangesDto,
  CompleteProfileDto,
  LiftTakedownDto,
  PagedQueryDto,
  ReasonDto,
  RequestChangesDto,
  TakedownDto,
} from '../dto/victim-profile.dto';
import { money, CHANGE_REQUESTABLE_STATUSES, maskAccount } from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: CacheService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

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
    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
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
      await this.victimProfileCommonService.reject(admin, id);
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
      this.victimProfileCommonService.unpublish(admin, id),
    );
  }

  // VP-66  (heuristics: same payout account number, or same name from the same creator)
  async findDuplicates(admin: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);

    const [byAccount, byName] = await Promise.all([
      // Same payout account number across different profiles (PayoutDestination is 1:1 with a profile).
      this.prisma.payoutDestination.groupBy({
        by: ['accountNumber'],
        where: {
          victimProfile: { is: { deletedAt: null } },
        },
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
        key: maskAccount(g.accountNumber) ?? '',
        count: g._count.id,
        where: { payoutDestination: { is: { accountNumber: g.accountNumber } }, deletedAt: null },
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
            label: this.victimProfileCommonService.profileLabel(m),
            status: m.status,
            createdByUserId: m.createdByUserId,
            createdAt: m.createdAt,
          })),
        };
      }),
    );

    void admin;
    return { data, meta: this.victimProfileCommonService.metaOf(page, limit, clusters.length) };
  }

  // VP-49
  async assignReviewer(admin: CurrentUserDto, id: string, data: AssignReviewerDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    await this.assertIsReviewer(data.reviewerId);

    if (profile.assignedReviewerId === data.reviewerId) return profile;

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      { assignedReviewerId: data.reviewerId, assignedAt: new Date() },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_ASSIGNED, profile },
    );

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_ASSIGNED,
      profile,
      {
        diff: { previousReviewerId: profile.assignedReviewerId, newReviewerId: data.reviewerId },
      },
    );
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_ASSIGNED, {
      userId: data.reviewerId,
      victimProfileId: id,
      actorId: admin.id,
    });
    return updated;
  }

  // VP-50
  async unassignReviewer(admin: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    if (!profile.assignedReviewerId) throw new BadRequestException('victim_profile_not_assigned');

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      { assignedReviewerId: null, assignedAt: null },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_UNASSIGNED, profile },
    );
    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_UNASSIGNED,
      profile,
      {
        diff: { previousReviewerId: profile.assignedReviewerId },
      },
    );
    return updated;
  }

  // VP-52
  async requestChanges(admin: CurrentUserDto, id: string, data: RequestChangesDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED,
    );

    if (profile.deletedAt) throw new BadRequestException('victim_profile_deleted');
    if (profile.isPublished || !CHANGE_REQUESTABLE_STATUSES.includes(profile.status)) {
      this.victimProfileCommonService.emitProfileFailure(
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

    const updated = await this.victimProfileCommonService.conditionalUpdate(
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

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED,
      profile,
      {
        reason: data.message,
        diff: {
          previousStatus: profile.status,
          newStatus: VictimProfileStatus.CHANGES_REQUESTED,
          creatorMessage: data.message,
        },
      },
    );
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      message: data.message,
    });
    return updated;
  }

  // VP-44
  async takedown(admin: CurrentUserDto, id: string, data: TakedownDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    // Emergency action: deliberately NOT blocked by another admin's claim.
    if (profile.takedownAt) throw new ConflictException('victim_profile_already_taken_down');

    // isAdminApproved is cleared so the existing publish() gate check refuses a republish
    // until a super admin lifts the takedown and the profile is re-approved.
    const updated = await this.victimProfileCommonService.conditionalUpdate(
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

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_TAKEDOWN,
      profile,
      {
        severity: AuditSeverity.CRITICAL,
        reason: data.reason,
        diff: {
          previousStatus: profile.status,
          newStatus: VictimProfileStatus.UNPUBLISHED,
          previousIsPublished: profile.isPublished,
        },
      },
    );
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_TAKEN_DOWN, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });
    return updated;
  }

  // VP-45
  async liftTakedown(admin: CurrentUserDto, id: string, data: LiftTakedownDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    if (!profile.takedownAt) throw new BadRequestException('victim_profile_not_taken_down');

    // Stays UNPUBLISHED and un-approved: it has to go back through approval and publish().
    // Donations stay paused until someone calls resume-donations on purpose.
    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      { takedownReason: null, takedownAt: null, takedownById: null },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_TAKEDOWN_LIFTED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_TAKEDOWN_LIFTED,
      profile,
      {
        severity: AuditSeverity.CRITICAL,
        reason: data.reason,
        diff: {
          previousTakedownReason: profile.takedownReason,
          previousTakedownById: profile.takedownById,
          creatorMessage: 'The takedown was lifted; your profile will be reviewed again.',
        },
      },
    );
    return updated;
  }

  // VP-56
  async complete(admin: CurrentUserDto, id: string, data: CompleteProfileDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_COMPLETED,
    );

    if (profile.status !== VictimProfileStatus.PUBLISHED) {
      this.victimProfileCommonService.emitProfileFailure(
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

    const updated = await this.victimProfileCommonService.conditionalUpdate(
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

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_COMPLETED,
      profile,
      {
        reason: data.note ?? null,
        diff: { previousStatus: profile.status, newStatus: VictimProfileStatus.COMPLETED },
        metadata: { totalRaisedAtCompletion: money(profile.totalRaised) },
      },
    );
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_COMPLETED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });
    return updated;
  }

  // VP-57
  async reopen(admin: CurrentUserDto, id: string, data: ReasonDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_REOPENED,
    );

    if (profile.status !== VictimProfileStatus.COMPLETED) {
      throw new BadRequestException('victim_profile_not_completed');
    }
    if (profile.takedownAt || profile.deletedAt) {
      throw new BadRequestException('victim_profile_blocked_from_reopening');
    }

    // Back to PUBLISHED only if every gate still holds; otherwise fall back to the derived pipeline status.
    const hasBankDetails = await this.victimProfileCommonService.hasBankDetails(id);
    const gatesHold =
      this.victimProfileCommonService.getMissingApprovalGates({
        involvesChild: profile.involvesChild,
        isVerified: profile.isVerified,
        isSafetyReviewed: profile.isSafetyReviewed,
        isChildSafetyReviewed: profile.isChildSafetyReviewed,
        hasConsent: profile.hasConsent,
        isPrivacyReviewed: profile.isPrivacyReviewed,
        hasBankDetails,
      }).length === 0 && profile.isAdminApproved;

    const status = gatesHold
      ? VictimProfileStatus.PUBLISHED
      : this.victimProfileCommonService.deriveStatus({
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

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_REOPENED,
      profile,
      {
        reason: data.reason,
        diff: { previousStatus: profile.status, newStatus: status },
      },
    );
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_REOPENED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });
    return updated;
  }
}

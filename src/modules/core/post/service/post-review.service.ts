import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditOutcome, AuditSeverity, PostStatus, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import {
  PostApprovedEvent,
  PostRejectedEvent,
} from 'src/modules/misc/notification/events/notification.events';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { RequestPostChangesDto, ApprovePostDto, RejectPostDto } from '../dto/post.dto';
import { PostCommonService } from './post-common.service';
import { PostAuditRef, STATUSES_THAT_CHANGE_PUBLIC_VISIBILITY } from './post.constants';

@Injectable()
export class PostReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly postCommonService: PostCommonService,
  ) {}

  private emitChildSafetyFirstConfirmation(user: CurrentUserDto, post: PostAuditRef): void {
    this.postCommonService.emitAudit({
      userId: user.id,
      targetUserId: this.postCommonService.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: post.id,
      entityLabel: this.postCommonService.postLabel(post),
      diff: {
        childSafetyFirstConfirmationBy: user.id,
        result: 'pending_second_admin_confirmation',
      },
    });
  }

  private assertNotClaimedByOther(
    user: CurrentUserDto,
    post: PostAuditRef & { claimedByUserId: string | null },
    action: AuditEventEnum,
    metadata?: Prisma.InputJsonObject,
  ): void {
    if (post.claimedByUserId && post.claimedByUserId !== user.id) {
      this.postCommonService.emitBlockedAttempt({
        outcome: AuditOutcome.DENIED,
        user,
        post,
        action,
        reason: 'claimed_by_another_admin',
        metadata: { ...(metadata ?? {}), claimedByUserId: post.claimedByUserId },
      });
      throw new BadRequestException('post_claimed_by_another_admin');
    }
  }

  async claimPost(user: CurrentUserDto, postId: string) {
    const post = await this.postCommonService.findOne(postId);
    this.assertNotClaimedByOther(user, post, AuditEventEnum.POST_UPDATED);

    const updated = await this.prisma.post.update({
      where: { id: postId },
      data: { claimedByUserId: user.id, claimedAt: new Date() },
    });

    this.postCommonService.emitAudit({
      userId: user.id,
      targetUserId: this.postCommonService.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      diff: { claimedBy: user.id, result: 'success' },
    });

    return updated;
  }

  async unclaimPost(user: CurrentUserDto, postId: string) {
    const post = await this.postCommonService.findOne(postId);
    this.assertNotClaimedByOther(user, post, AuditEventEnum.POST_UPDATED);

    const updated = await this.prisma.post.update({
      where: { id: postId },
      data: { claimedByUserId: null, claimedAt: null },
    });

    this.postCommonService.emitAudit({
      userId: user.id,
      targetUserId: this.postCommonService.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      diff: { unclaimedBy: user.id, result: 'success' },
    });

    return updated;
  }

  private async ensureChildSafetySatisfied(
    post: PostAuditRef & {
      involvesChild: boolean;
      childSafetyFirstConfirmedByUserId: string | null;
    },
    user: CurrentUserDto,
    confirmed: boolean | undefined,
    action: AuditEventEnum,
    metadata?: Prisma.InputJsonObject,
  ): Promise<'not_required' | 'first_confirmation_recorded' | 'satisfied'> {
    if (!post.involvesChild) return 'not_required';

    if (confirmed !== true) {
      this.postCommonService.emitBlockedAttempt({
        outcome: AuditOutcome.FAILURE,
        user,
        post,
        action,
        reason: 'child_safety_confirmation_required',
        metadata,
      });
      throw new BadRequestException('child_safety_confirmation_required');
    }

    if (!post.childSafetyFirstConfirmedByUserId) {
      await this.prisma.post.update({
        where: { id: post.id },
        data: {
          childSafetyFirstConfirmedByUserId: user.id,
          childSafetyFirstConfirmedAt: new Date(),
        },
      });
      return 'first_confirmation_recorded';
    }

    if (post.childSafetyFirstConfirmedByUserId === user.id) {
      this.postCommonService.emitBlockedAttempt({
        outcome: AuditOutcome.DENIED,
        user,
        post,
        action,
        reason: 'child_safety_requires_second_distinct_admin',
        metadata: {
          ...(metadata ?? {}),
          firstConfirmedByUserId: post.childSafetyFirstConfirmedByUserId,
        },
      });
      throw new BadRequestException('child_safety_requires_second_distinct_admin');
    }

    return 'satisfied';
  }

  // Flag != reject; only writes an audit entry, never changes a post's status.
  private async maybeFlagUserForRejections(userId: string): Promise<void> {
    const threshold = Number(
      this.configService.get<string>('POST_AUTO_FLAG_REJECTION_COUNT') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_REJECTION_COUNT') ??
        3,
    );
    const windowDays = Number(
      this.configService.get<string>('POST_AUTO_FLAG_WINDOW_DAYS') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_WINDOW_DAYS') ??
        7,
    );
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const recentRejections = await this.prisma.post.count({
      where: { userId, status: PostStatus.REJECTED, updatedAt: { gte: since } },
    });

    if (recentRejections >= threshold) {
      this.postCommonService.emitAudit({
        targetUserId: userId,
        actorType: 'SYSTEM',
        action: AuditEventEnum.USER_AUTO_FLAGGED,
        entity: 'User',
        entityId: userId,
        reason: 'repeated_post_rejections',
        diff: {
          rejectionCount: recentRejections,
          windowDays,
          result: 'flagged_for_review',
        },
        metadata: { threshold },
      });
    }
  }

  async bulkApprove(user: CurrentUserDto, ids: string[]) {
    const results: Array<{ id: string; success: boolean; error?: string }> = [];

    for (const id of ids) {
      try {
        const post = await this.postCommonService.findOne(id);
        if (post.involvesChild) {
          this.postCommonService.emitBlockedAttempt({
            outcome: AuditOutcome.DENIED,
            severity: AuditSeverity.INFO,
            user,
            post,
            action: AuditEventEnum.POST_APPROVED,
            reason: 'requires_individual_child_safety_review',
            metadata: { bulk: true },
          });
          results.push({
            id,
            success: false,
            error: 'requires_individual_child_safety_review',
          });
          continue;
        }
        await this.approve(user, id, {}, { bulk: true });
        results.push({ id, success: true });
      } catch (err) {
        results.push({ id, success: false, error: (err as Error).message });
      }
    }

    return results;
  }

  async bulkReject(user: CurrentUserDto, ids: string[], reason: string) {
    const results: Array<{ id: string; success: boolean; error?: string }> = [];

    for (const id of ids) {
      try {
        const post = await this.postCommonService.findOne(id);
        if (post.involvesChild) {
          this.postCommonService.emitBlockedAttempt({
            outcome: AuditOutcome.DENIED,
            severity: AuditSeverity.INFO,
            user,
            post,
            action: AuditEventEnum.POST_REJECTED,
            reason: 'requires_individual_review',
            metadata: { bulk: true },
          });
          results.push({
            id,
            success: false,
            error: 'requires_individual_review',
          });
          continue;
        }
        await this.reject(user, id, { reason }, { bulk: true });
        results.push({ id, success: true });
      } catch (err) {
        results.push({ id, success: false, error: (err as Error).message });
      }
    }

    return results;
  }

  async updateStatus(
    user: CurrentUserDto,
    postId: string,
    status: PostStatus,
    childSafetyConfirmed?: boolean,
  ) {
    const existing = await this.postCommonService.findOne(postId);

    this.postCommonService.assertTransitionAllowed(
      user,
      existing,
      status,
      AuditEventEnum.POST_UPDATED,
    );
    this.assertNotClaimedByOther(user, existing, AuditEventEnum.POST_UPDATED);

    const movesToLiveReview = status === PostStatus.APPROVED || status === PostStatus.PUBLISHED;

    if (existing.involvesChild && movesToLiveReview) {
      const safety = await this.ensureChildSafetySatisfied(
        existing,
        user,
        childSafetyConfirmed,
        AuditEventEnum.POST_UPDATED,
      );
      if (safety === 'first_confirmation_recorded') {
        const partial = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });
        this.emitChildSafetyFirstConfirmation(user, existing);
        return { ...partial, pendingSecondConfirmation: true };
      }
    }

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: existing.status },
      data: { status },
    });

    if (result.count === 0) {
      this.postCommonService.emitBlockedAttempt({
        outcome: AuditOutcome.FAILURE,
        user,
        post: existing,
        action: AuditEventEnum.POST_UPDATED,
        reason: 'post_transition_conflict',
        diff: { attemptedStatus: status, currentStatus: existing.status },
      });
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    if (STATUSES_THAT_CHANGE_PUBLIC_VISIBILITY.includes(status)) {
      await this.cache.invalidatePostEverywhere(postId);
    }

    this.postCommonService.emitAudit({
      userId: user.id,
      targetUserId: this.postCommonService.auditTarget(existing, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(updated),
      diff: {
        previousStatus: existing.status,
        newStatus: status,
        childSafetyDualControlSatisfied:
          existing.involvesChild && movesToLiveReview ? true : undefined,
        result: 'success',
      },
      metadata: { postType: existing.type, involvesChild: existing.involvesChild },
    });

    return updated;
  }

  async approve(
    user: CurrentUserDto,
    postId: string,
    data: ApprovePostDto,
    options: { bulk?: boolean } = {},
  ) {
    const post = await this.postCommonService.findOne(postId);
    const bulkMeta: Prisma.InputJsonObject = { bulk: options.bulk === true };

    this.postCommonService.assertTransitionAllowed(
      user,
      post,
      PostStatus.APPROVED,
      AuditEventEnum.POST_APPROVED,
      bulkMeta,
    );
    this.assertNotClaimedByOther(user, post, AuditEventEnum.POST_APPROVED, bulkMeta);

    const safety = await this.ensureChildSafetySatisfied(
      post,
      user,
      data.childSafetyConfirmed,
      AuditEventEnum.POST_APPROVED,
      bulkMeta,
    );
    if (safety === 'first_confirmation_recorded') {
      const partial = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });
      this.emitChildSafetyFirstConfirmation(user, post);
      return { ...partial, pendingSecondConfirmation: true };
    }

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: { status: PostStatus.APPROVED, claimedByUserId: null, claimedAt: null },
    });

    if (result.count === 0) {
      this.postCommonService.emitBlockedAttempt({
        outcome: AuditOutcome.FAILURE,
        user,
        post,
        action: AuditEventEnum.POST_APPROVED,
        reason: 'post_transition_conflict',
        diff: { attemptedStatus: PostStatus.APPROVED, currentStatus: post.status },
        metadata: bulkMeta,
      });
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    this.postCommonService.emitAudit({
      userId: user.id,
      targetUserId: this.postCommonService.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_APPROVED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      diff: {
        previousStatus: post.status,
        newStatus: PostStatus.APPROVED,
        involvesChild: post.involvesChild,
        childSafetyDualControlSatisfied: post.involvesChild ? true : undefined,
        result: 'success',
      },
      metadata: { postType: post.type, ...bulkMeta },
    });

    const postApprovedEvent: PostApprovedEvent = {
      postId,
      userId: post.userId,
      title: post.title ?? undefined,
    };
    this.eventEmitter.emit(NotificationEventEnum.POST_APPROVED, postApprovedEvent);

    return updated;
  }

  async requestChanges(user: CurrentUserDto, postId: string, data: RequestPostChangesDto) {
    const post = await this.postCommonService.findOne(postId);

    this.postCommonService.assertTransitionAllowed(
      user,
      post,
      PostStatus.CHANGES_REQUESTED,
      AuditEventEnum.POST_UPDATED,
    );
    this.assertNotClaimedByOther(user, post, AuditEventEnum.POST_UPDATED);

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: {
        status: PostStatus.CHANGES_REQUESTED,
        reviewNote: data.message,
        claimedByUserId: null,
        claimedAt: null,
      },
    });

    if (result.count === 0) {
      this.postCommonService.emitBlockedAttempt({
        outcome: AuditOutcome.FAILURE,
        user,
        post,
        action: AuditEventEnum.POST_UPDATED,
        reason: 'post_transition_conflict',
        diff: { attemptedStatus: PostStatus.CHANGES_REQUESTED, currentStatus: post.status },
      });
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    this.postCommonService.emitAudit({
      userId: user.id,
      targetUserId: this.postCommonService.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      reason: data.message,
      diff: {
        previousStatus: post.status,
        newStatus: PostStatus.CHANGES_REQUESTED,
        result: 'success',
      },
      metadata: { postType: post.type, involvesChild: post.involvesChild },
    });

    this.eventEmitter.emit(NotificationEventEnum.POST_CHANGES_REQUESTED, {
      postId,
      userId: post.userId,
      message: data.message,
    });

    return updated;
  }

  async publish(user: CurrentUserDto, postId: string) {
    const post = await this.postCommonService.findOne(postId);

    this.postCommonService.assertTransitionAllowed(
      user,
      post,
      PostStatus.PUBLISHED,
      AuditEventEnum.POST_PUBLISHED,
    );

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: { status: PostStatus.PUBLISHED },
    });

    if (result.count === 0) {
      this.postCommonService.emitBlockedAttempt({
        outcome: AuditOutcome.FAILURE,
        user,
        post,
        action: AuditEventEnum.POST_PUBLISHED,
        reason: 'post_transition_conflict',
        diff: { attemptedStatus: PostStatus.PUBLISHED, currentStatus: post.status },
      });
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    await this.cache.invalidatePostEverywhere(postId);

    this.postCommonService.emitAudit({
      userId: user.id,
      targetUserId: this.postCommonService.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_PUBLISHED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      diff: {
        previousStatus: post.status,
        newStatus: PostStatus.PUBLISHED,
        result: 'success',
      },
      metadata: { postType: post.type, involvesChild: post.involvesChild },
    });

    return updated;
  }

  async reject(
    user: CurrentUserDto,
    postId: string,
    data: RejectPostDto,
    options: { bulk?: boolean } = {},
  ) {
    const post = await this.postCommonService.findOne(postId);
    const bulkMeta: Prisma.InputJsonObject = { bulk: options.bulk === true };

    this.postCommonService.assertTransitionAllowed(
      user,
      post,
      PostStatus.REJECTED,
      AuditEventEnum.POST_REJECTED,
      bulkMeta,
    );
    this.assertNotClaimedByOther(user, post, AuditEventEnum.POST_REJECTED, bulkMeta);

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: {
        status: PostStatus.REJECTED,
        reviewNote: data.reason,
        claimedByUserId: null,
        claimedAt: null,
      },
    });

    if (result.count === 0) {
      this.postCommonService.emitBlockedAttempt({
        outcome: AuditOutcome.FAILURE,
        user,
        post,
        action: AuditEventEnum.POST_REJECTED,
        reason: 'post_transition_conflict',
        diff: { attemptedStatus: PostStatus.REJECTED, currentStatus: post.status },
        metadata: bulkMeta,
      });
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    this.postCommonService.emitAudit({
      userId: user.id,
      targetUserId: this.postCommonService.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_REJECTED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      reason: data.reason,
      diff: {
        previousStatus: post.status,
        newStatus: PostStatus.REJECTED,
        result: 'success',
      },
      metadata: { postType: post.type, involvesChild: post.involvesChild, ...bulkMeta },
    });

    await this.maybeFlagUserForRejections(post.userId);

    const postRejectedEvent: PostRejectedEvent = {
      postId,
      userId: post.userId,
      title: post.title ?? undefined,
    };
    this.eventEmitter.emit(NotificationEventEnum.POST_REJECTED, postRejectedEvent);

    return updated;
  }

  async unpublish(user: CurrentUserDto, postId: string) {
    const post = await this.postCommonService.findOne(postId);

    this.postCommonService.assertTransitionAllowed(
      user,
      post,
      PostStatus.UNPUBLISHED,
      AuditEventEnum.POST_UNPUBLISHED,
    );

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: { status: PostStatus.UNPUBLISHED },
    });

    if (result.count === 0) {
      this.postCommonService.emitBlockedAttempt({
        outcome: AuditOutcome.FAILURE,
        user,
        post,
        action: AuditEventEnum.POST_UNPUBLISHED,
        reason: 'post_transition_conflict',
        diff: { attemptedStatus: PostStatus.UNPUBLISHED, currentStatus: post.status },
      });
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    await this.cache.invalidatePostEverywhere(postId);

    this.postCommonService.emitAudit({
      userId: user.id,
      targetUserId: this.postCommonService.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UNPUBLISHED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      diff: {
        previousStatus: post.status,
        newStatus: PostStatus.UNPUBLISHED,
        result: 'success',
      },
      metadata: { postType: post.type, involvesChild: post.involvesChild },
    });

    this.eventEmitter.emit(NotificationEventEnum.POST_UNPUBLISHED, {
      postId,
      userId: post.userId,
    });

    return updated;
  }
}

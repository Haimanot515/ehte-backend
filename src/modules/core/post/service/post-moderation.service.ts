import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditOutcome, AuditSeverity, PostAppealTarget, PostStatus, Prisma } from '@prisma/client';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  DecidePostAppealDto,
  FlagPostDto,
  ResolvePostFlagsDto,
  TakedownPostDto,
  FlaggedPostsQueryDto,
  PostAppealsQueryDto,
} from '../dto/post.dto';
import { PostCommonService } from './post-common.service';
import { FLAG_OPEN, APPEAL_OPEN } from './post.constants';

@Injectable()
export class PostModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: CacheService,
    private readonly postCommonService: PostCommonService,
  ) {}

  @OnEvent('user.suspended')
  async handleUserSuspended(payload: { userId: string }): Promise<void> {
    const now = new Date();

    const withdrawn = await this.prisma.post.updateMany({
      where: { userId: payload.userId, status: PostStatus.PENDING },
      data: { status: PostStatus.DRAFT, ownerSuspendedAt: now },
    });

    const stamped = await this.prisma.post.updateMany({
      where: {
        userId: payload.userId,
        status: { in: [PostStatus.DRAFT, PostStatus.CHANGES_REQUESTED] },
        ownerSuspendedAt: null,
      },
      data: { ownerSuspendedAt: now },
    });

    this.postCommonService.emitAudit({
      targetUserId: payload.userId,
      actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
      action: AuditEventEnum.POST_UPDATED,
      entity: 'User',
      entityId: payload.userId,
      reason: 'owner_account_suspended',
      diff: { result: 'success' },
      metadata: {
        pendingPostsWithdrawn: withdrawn.count,
        otherPostsTimestamped: stamped.count,
      },
    });
  }

  // ── Flags ─────────────────────────────────────

  // POST /posts/:id/flag
  async flagPost(user: CurrentUserDto, postId: string, data: FlagPostDto) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, status: PostStatus.PUBLISHED },
    });
    if (!post) {
      throw new NotFoundException('post_not_found');
    }
    if (post.userId === user.id) {
      throw new BadRequestException('cannot_flag_own_post');
    }

    const already = await this.prisma.postFlag.findFirst({
      where: { postId, reporterId: user.id },
      select: { id: true },
    });
    if (already) {
      throw new BadRequestException('post_already_flagged');
    }

    let flag;
    try {
      flag = await this.prisma.postFlag.create({
        data: {
          postId,
          reporterId: user.id,
          reason: data.reason,
          details: data.details ?? null,
        },
      });
    } catch (err) {
      // A parallel request won the unique (postId, reporterId) race.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException('post_already_flagged');
      }
      throw err;
    }

    this.postCommonService.emitAudit({
      userId: user.id,
      targetUserId: this.postCommonService.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_FLAGGED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      reason: 'post_flagged',
      diff: { flagId: flag.id, flagReason: data.reason, result: 'flag_open' },
      metadata: { postType: post.type, involvesChild: post.involvesChild },
    });

    return { id: flag.id, postId, status: flag.status };
  }

  // GET /posts/flags
  async findFlaggedPosts(query: FlaggedPostsQueryDto) {
    const { page, limit, skip } = this.postCommonService.pageArgs(query);
    const flagStatus = query.flagStatus ?? FLAG_OPEN;

    const groups = await this.prisma.postFlag.groupBy({
      by: ['postId'],
      where: { status: flagStatus },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
    });

    const pageGroups = groups.slice(skip, skip + limit);
    const posts = await this.prisma.post.findMany({
      where: { id: { in: pageGroups.map((g) => g.postId) } },
    });
    const byId = new Map(posts.map((p) => [p.id, p]));

    const items = pageGroups.flatMap((g) => {
      const post = byId.get(g.postId);
      if (!post) return [];
      return [
        {
          post,
          flagCount: (g._count as { _all?: number } | undefined)?._all ?? 0,
          lastFlaggedAt: g._max?.createdAt ?? null,
        },
      ];
    });

    return { items, ...this.postCommonService.pageMeta(groups.length, page, limit) };
  }

  // GET /posts/:id/flags
  async findPostFlags(postId: string) {
    await this.postCommonService.findOne(postId);

    return this.prisma.postFlag.findMany({
      where: { postId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // PATCH /posts/:id/flags/resolve
  async resolveFlags(admin: CurrentUserDto, postId: string, data: ResolvePostFlagsDto) {
    const post = await this.postCommonService.findOne(postId);

    const result = await this.prisma.postFlag.updateMany({
      where: { postId, status: FLAG_OPEN },
      data: {
        status: data.outcome,
        note: data.note ?? null,
        resolvedById: admin.id,
        resolvedAt: new Date(),
      },
    });

    if (result.count === 0) {
      throw new BadRequestException('no_open_flags_on_post');
    }

    this.postCommonService.emitAudit({
      userId: admin.id,
      targetUserId: this.postCommonService.auditTarget(post, admin.id),
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.POST_FLAGS_RESOLVED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      reason: data.note ?? 'post_flags_resolved',
      diff: { flagOutcome: data.outcome, flagsResolved: result.count, result: 'success' },
      metadata: { postType: post.type },
    });

    return { postId, outcome: data.outcome, resolved: result.count };
  }

  // ── Takedown and appeals ──────────────────────

  // PATCH /posts/:id/takedown
  async takedown(admin: CurrentUserDto, postId: string, data: TakedownPostDto) {
    const post = await this.postCommonService.findOne(postId);

    this.postCommonService.assertTransitionAllowed(
      admin,
      post,
      PostStatus.UNPUBLISHED,
      AuditEventEnum.POST_TAKEN_DOWN,
    );
    if (post.status !== PostStatus.PUBLISHED) {
      throw new BadRequestException('only_published_posts_can_be_taken_down');
    }

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: PostStatus.PUBLISHED },
      data: {
        status: PostStatus.UNPUBLISHED,
        takedownReason: data.reason,
        takedownAt: new Date(),
        takedownById: admin.id,
      },
    });

    if (result.count === 0) {
      this.postCommonService.emitBlockedAttempt({
        outcome: AuditOutcome.FAILURE,
        user: admin,
        post,
        action: AuditEventEnum.POST_TAKEN_DOWN,
        reason: 'post_transition_conflict',
        diff: { attemptedStatus: PostStatus.UNPUBLISHED, currentStatus: post.status },
      });
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    await this.cache.invalidatePostEverywhere(postId);

    this.postCommonService.emitAudit({
      userId: admin.id,
      targetUserId: this.postCommonService.auditTarget(post, admin.id),
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.POST_TAKEN_DOWN,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      reason: data.reason,
      severity: AuditSeverity.WARNING,
      diff: {
        previousStatus: post.status,
        newStatus: PostStatus.UNPUBLISHED,
        takedown: true,
        result: 'success',
      },
      metadata: { postType: post.type, involvesChild: post.involvesChild },
    });

    if (data.notifyAuthor !== false) {
      this.eventEmitter.emit(NotificationEventEnum.POST_UNPUBLISHED, {
        postId,
        userId: post.userId,
        reason: data.reason,
        canAppeal: true,
      });
    }

    return updated;
  }

  // GET /posts/appeals
  async findAppeals(query: PostAppealsQueryDto) {
    const { page, limit, skip, take } = this.postCommonService.pageArgs(query);
    const where: Prisma.PostAppealWhereInput = { status: query.appealStatus ?? APPEAL_OPEN };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.postAppeal.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take,
        include: {
          post: {
            select: {
              id: true,
              title: true,
              type: true,
              status: true,
              userId: true,
              reviewNote: true,
              takedownReason: true,
              takedownAt: true,
            },
          },
        },
      }),
      this.prisma.postAppeal.count({ where }),
    ]);

    return { items, ...this.postCommonService.pageMeta(total, page, limit) };
  }

  // PATCH /posts/:id/appeals/:appealId/decide
  async decideAppeal(
    admin: CurrentUserDto,
    postId: string,
    appealId: string,
    data: DecidePostAppealDto,
  ) {
    const post = await this.postCommonService.findOne(postId);

    const appeal = await this.prisma.postAppeal.findFirst({ where: { id: appealId, postId } });
    if (!appeal) {
      throw new NotFoundException('appeal_not_found');
    }
    if (appeal.status !== APPEAL_OPEN) {
      throw new BadRequestException('appeal_already_decided');
    }

    const restoredPublic = await this.prisma.$transaction(async (tx) => {
      const decided = await tx.postAppeal.updateMany({
        where: { id: appealId, status: APPEAL_OPEN },
        data: {
          status: data.decision,
          decisionNote: data.note,
          decidedById: admin.id,
          decidedAt: new Date(),
        },
      });
      if (decided.count === 0) {
        throw new BadRequestException('appeal_already_decided');
      }
      if (data.decision !== 'OVERTURNED') return false;

      // Overturned rejection goes back to the review queue (system action, skips the transition map).
      if (appeal.target === PostAppealTarget.REJECTION) {
        await tx.post.updateMany({
          where: { id: postId, status: PostStatus.REJECTED },
          data: { status: PostStatus.PENDING, reviewNote: null },
        });
        return false;
      }

      // Overturned takedown restores the post and clears the takedown fields.
      if (appeal.target === PostAppealTarget.TAKEDOWN) {
        const restored = await tx.post.updateMany({
          where: { id: postId, status: PostStatus.UNPUBLISHED },
          data: {
            status: PostStatus.PUBLISHED,
            takedownReason: null,
            takedownAt: null,
            takedownById: null,
          },
        });
        return restored.count > 0;
      }
      return false;
    });

    if (restoredPublic) {
      await this.cache.invalidatePostEverywhere(postId);
    }

    this.postCommonService.emitAudit({
      userId: admin.id,
      targetUserId: this.postCommonService.auditTarget(post, admin.id),
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.POST_APPEAL_DECIDED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      reason: data.note,
      severity: AuditSeverity.WARNING,
      diff: { appealId, appealDecision: data.decision, result: 'success' },
      metadata: { postType: post.type, restoredPublic, appealTarget: appeal.target },
    });

    // No listener yet for this event; wire it to a notification when ready.
    this.eventEmitter.emit(NotificationEventEnum.POST_APPEAL_DECIDED, {
      postId,
      userId: post.userId,
      appealId,
      decision: data.decision,
      note: data.note,
    });

    return this.prisma.postAppeal.findUniqueOrThrow({ where: { id: appealId } });
  }
}

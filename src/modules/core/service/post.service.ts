import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PostStatus, PostType, Prisma } from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';

import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import {
  PostApprovedEvent,
  PostRejectedEvent,
  NewPostEvent,
} from 'src/modules/misc/events/notification.events';

import {
  CreatePostDto,
  UpdatePostDto,
  RequestPostChangesDto,
  ApprovePostDto,
  RejectPostDto,
  AdminCreatePostDto,
  AdminPostQueryDto,
  PublishedPostsQueryDto,
} from '../dto/post.dto';

// Statuses the owner is allowed to edit or submit from.
// PENDING is deliberately excluded: once submitted, the post is
// frozen for the owner until an admin approves it or sends it
// back via CHANGES_REQUESTED.
const OWNER_EDITABLE_STATUSES: PostStatus[] = [PostStatus.DRAFT, PostStatus.CHANGES_REQUESTED];

// ─────────────────────────────────────────────
// FIX (#7/#8/#9) — Single source of truth for what
// status can move to what. Previously each method
// (approve/reject/requestChanges/publish/unpublish)
// had its own ad hoc, mutually inconsistent guard —
// e.g. approve() didn't block approving a DRAFT that
// was never submitted, requestChanges() didn't block
// a DRAFT either, and reject() allowed rejecting a
// PUBLISHED post directly instead of requiring
// unpublish() first. This map is now the single
// place that encodes the real workflow.
// ─────────────────────────────────────────────
const ALLOWED_STATUS_TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  [PostStatus.DRAFT]: [PostStatus.PENDING],
  [PostStatus.PENDING]: [PostStatus.APPROVED, PostStatus.REJECTED, PostStatus.CHANGES_REQUESTED, PostStatus.DRAFT],
  [PostStatus.CHANGES_REQUESTED]: [PostStatus.PENDING],
  [PostStatus.APPROVED]: [PostStatus.PUBLISHED, PostStatus.REJECTED],
  [PostStatus.PUBLISHED]: [PostStatus.UNPUBLISHED],
  [PostStatus.UNPUBLISHED]: [PostStatus.PUBLISHED],
  [PostStatus.REJECTED]: [],
};

function assertTransitionAllowed(from: PostStatus, to: PostStatus): void {
  if (!ALLOWED_STATUS_TRANSITIONS[from]?.includes(to)) {
    throw new BadRequestException(`post_transition_not_allowed:${from}->${to}`);
  }
}

@Injectable()
export class PostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // ─────────────────────────────────────────────
  // CREATE POST
  // ─────────────────────────────────────────────

  async create(userId: string, data: CreatePostDto) {
    const postType: PostType = data.type;

    const post = await this.prisma.post.create({
      data: {
        userId,
        title: data.title ?? null,
        content: data.content,
        type: postType,
        involvesChild: data.involvesChild ?? false,
        status: PostStatus.DRAFT,
        photo: data.photo ?? [],
        video: data.video ?? [],
        audio: data.audio ?? [],
        pdf: data.pdf ?? [],
        document: data.document ?? [],
        other: data.other ?? [],
      },
    });

    this.emitAudit({
      userId,
      actorType: 'USER',
      action: AuditEventEnum.POST_CREATED,
      entity: 'Post',
      entityId: post.id,
      diff: {
        status: PostStatus.DRAFT,
        result: 'success',
      },
    });

    return post;
  }

  // ─────────────────────────────────────────────
  // ADMIN — CREATE OFFICIAL POST
  //
  // FIX (#2/#3) — previously an involvesChild=true
  // post could be created straight into APPROVED via
  // this endpoint with NO childSafetyConfirmed field
  // existing anywhere on the request. Now, when
  // publishImmediately is true (the straight-to-
  // APPROVED path) and involvesChild is true, the
  // caller must explicitly pass childSafetyConfirmed:
  // true, exactly like approve() requires. The
  // PENDING path (publishImmediately=false) does not
  // require it here, because that path still goes
  // through approve()'s own gate later.
  // ─────────────────────────────────────────────

  async createOfficial(actor: CurrentUserDto, data: AdminCreatePostDto) {
    const publishImmediately = data.publishImmediately ?? true;
    const involvesChild = data.involvesChild ?? false;

    if (publishImmediately && involvesChild && data.childSafetyConfirmed !== true) {
      throw new BadRequestException('child_safety_confirmation_required');
    }

    const status = publishImmediately ? PostStatus.APPROVED : PostStatus.PENDING;

    const postType: PostType = data.type;

    const post = await this.prisma.post.create({
      data: {
        userId: actor.id,
        title: data.title ?? null,
        content: data.content,
        type: postType,
        involvesChild,
        status,
        photo: data.photo ?? [],
        video: data.video ?? [],
        audio: data.audio ?? [],
        pdf: data.pdf ?? [],
        document: data.document ?? [],
        other: data.other ?? [],
      },
    });

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action: AuditEventEnum.POST_CREATED,
      entity: 'Post',
      entityId: post.id,
      diff: {
        official: true,
        status,
        involvesChild,
        childSafetyConfirmed: publishImmediately && involvesChild ? true : undefined,
        result: 'success',
      },
    });

    if (!publishImmediately) {
      const newPostEvent: NewPostEvent = {
        postId: post.id,
        userId: actor.id,
      };
      this.eventEmitter.emit(NotificationEventEnum.NEW_POST, newPostEvent);
    }

    return post;
  }

  // ─────────────────────────────────────────────
  // GET MY POSTS
  // ─────────────────────────────────────────────

  async findMyPosts(userId: string) {
    return this.prisma.post.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // GET MY POST
  // ─────────────────────────────────────────────

  async findMyPost(userId: string, postId: string) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, userId },
    });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    return post;
  }

  // ─────────────────────────────────────────────
  // UPDATE MY POST
  // Allowed only while DRAFT or CHANGES_REQUESTED.
  // ─────────────────────────────────────────────

  async updateMyPost(userId: string, postId: string, data: UpdatePostDto) {
    const existing = await this.prisma.post.findFirst({
      where: { id: postId, userId },
    });

    if (!existing) {
      throw new NotFoundException('post_not_found');
    }

    if (!OWNER_EDITABLE_STATUSES.includes(existing.status)) {
      throw new BadRequestException('post_cannot_be_edited_in_current_status');
    }

    const updatedFields = Object.keys(data).filter(
      (key) => data[key as keyof UpdatePostDto] !== undefined,
    );

    const post = await this.prisma.post.update({
      where: { id: postId },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.content !== undefined ? { content: data.content } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.involvesChild !== undefined ? { involvesChild: data.involvesChild } : {}),
        ...(data.photo !== undefined ? { photo: data.photo } : {}),
        ...(data.video !== undefined ? { video: data.video } : {}),
        ...(data.audio !== undefined ? { audio: data.audio } : {}),
        ...(data.pdf !== undefined ? { pdf: data.pdf } : {}),
        ...(data.document !== undefined ? { document: data.document } : {}),
        ...(data.other !== undefined ? { other: data.other } : {}),
      },
    });

    this.emitAudit({
      userId,
      actorType: 'USER',
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: post.id,
      diff: {
        updatedFields,
        result: 'success',
      },
    });

    return post;
  }

  // ─────────────────────────────────────────────
  // SUBMIT MY POST
  // Moves DRAFT or CHANGES_REQUESTED → PENDING.
  // ─────────────────────────────────────────────

  async submitMyPost(userId: string, postId: string) {
    const existing = await this.prisma.post.findFirst({
      where: { id: postId, userId },
    });

    if (!existing) {
      throw new NotFoundException('post_not_found');
    }

    if (!OWNER_EDITABLE_STATUSES.includes(existing.status)) {
      throw new BadRequestException('post_cannot_be_submitted_in_current_status');
    }

    // FIX (#11 partial) — conditional update guards against a
    // concurrent transition landing between findFirst and update.
    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: existing.status },
      data: { status: PostStatus.PENDING },
    });

    if (result.count === 0) {
      throw new BadRequestException('post_cannot_be_submitted_in_current_status');
    }

    const post = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    this.emitAudit({
      userId,
      actorType: 'USER',
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: post.id,
      diff: {
        previousStatus: existing.status,
        newStatus: PostStatus.PENDING,
        result: 'success',
      },
    });

    const newPostEvent: NewPostEvent = {
      postId: post.id,
      userId,
    };
    this.eventEmitter.emit(NotificationEventEnum.NEW_POST, newPostEvent);

    return post;
  }

  // ─────────────────────────────────────────────
  // FIX (#4) — CANCEL / WITHDRAW MY POST
  // PENDING → DRAFT. Previously an owner had no way
  // to pull a submitted post back; the only exit from
  // PENDING was an admin acting on it. Withdrawing
  // returns it to DRAFT so the owner can edit it again
  // via updateMyPost and resubmit via submitMyPost.
  // ─────────────────────────────────────────────

  async cancelMyPost(userId: string, postId: string) {
    const existing = await this.prisma.post.findFirst({
      where: { id: postId, userId },
    });

    if (!existing) {
      throw new NotFoundException('post_not_found');
    }

    if (existing.status !== PostStatus.PENDING) {
      throw new BadRequestException('only_pending_posts_can_be_withdrawn');
    }

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: PostStatus.PENDING },
      data: { status: PostStatus.DRAFT },
    });

    if (result.count === 0) {
      throw new BadRequestException('only_pending_posts_can_be_withdrawn');
    }

    const post = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    this.emitAudit({
      userId,
      actorType: 'USER',
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: post.id,
      diff: {
        previousStatus: PostStatus.PENDING,
        newStatus: PostStatus.DRAFT,
        reason: 'withdrawn_by_owner',
        result: 'success',
      },
    });

    return post;
  }

  // ─────────────────────────────────────────────
  // FIX (#5) — DELETE MY POST
  // Scoped to DRAFT only, mirroring
  // OWNER_EDITABLE_STATUSES's spirit but deliberately
  // narrower than "edit" — a post that has ever been
  // submitted (PENDING/CHANGES_REQUESTED/etc.) keeps
  // its record rather than disappearing from the
  // audit trail; owners can still discard a draft
  // they never intend to submit.
  // ─────────────────────────────────────────────

  async deleteMyPost(userId: string, postId: string) {
    const existing = await this.prisma.post.findFirst({
      where: { id: postId, userId },
    });

    if (!existing) {
      throw new NotFoundException('post_not_found');
    }

    if (existing.status !== PostStatus.DRAFT) {
      throw new BadRequestException('only_draft_posts_can_be_deleted');
    }

    await this.prisma.post.delete({ where: { id: postId } });

    this.emitAudit({
      userId,
      actorType: 'USER',
      action: AuditEventEnum.POST_DELETED,
      entity: 'Post',
      entityId: postId,
      diff: {
        previousStatus: PostStatus.DRAFT,
        result: 'success',
      },
    });

    return { id: postId, deleted: true };
  }

  // ─────────────────────────────────────────────
  // PUBLIC — GET PUBLISHED POSTS
  // ─────────────────────────────────────────────

  async findPublishedPosts(query: PublishedPostsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const postType: PostType | undefined = query.type;

    const where: Prisma.PostWhereInput = {
      status: PostStatus.PUBLISHED,
      ...(postType ? { type: postType } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.post.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ─────────────────────────────────────────────
  // PUBLIC — GET ONE PUBLISHED POST
  // ─────────────────────────────────────────────

  async findPublishedPost(postId: string) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, status: PostStatus.PUBLISHED },
    });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    return post;
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ALL POSTS
  //
  // FIX (#6) — added authorId filter (equivalent of
  // assignedTo on the Report query).
  // ─────────────────────────────────────────────

  async findAll(query: AdminPostQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const postType: PostType | undefined = query.type;

    const where: Prisma.PostWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(postType ? { type: postType } : {}),
      ...(query.involvesChild !== undefined ? { involvesChild: query.involvesChild } : {}),
      ...(query.authorId ? { userId: query.authorId } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.post.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ONE POST
  // ─────────────────────────────────────────────

  async findOne(postId: string) {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    return post;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  //
  // FIX (#1/#7/#12/#13) — this generic endpoint
  // previously accepted any PostStatus with zero
  // transition validation and zero child-safety
  // check, making it a total bypass of approve()'s
  // gate (e.g. flipping a DRAFT, involvesChild=true
  // post straight to PUBLISHED in one call). It now:
  //   - validates the transition via the shared map
  //   - requires childSafetyConfirmed when moving an
  //     involvesChild post to APPROVED or PUBLISHED
  //   - uses a conditional update to avoid racing
  //     another concurrent transition
  // The `status` value itself is now DTO-validated
  // with @IsEnum at the controller layer (see
  // UpdatePostStatusDto) instead of being read raw
  // off the body.
  // ─────────────────────────────────────────────

  async updateStatus(
    user: CurrentUserDto,
    postId: string,
    status: PostStatus,
    childSafetyConfirmed?: boolean,
  ) {
    const existing = await this.findOne(postId);

    assertTransitionAllowed(existing.status, status);

    const movesToLiveReview = status === PostStatus.APPROVED || status === PostStatus.PUBLISHED;
    if (existing.involvesChild && movesToLiveReview && childSafetyConfirmed !== true) {
      throw new BadRequestException('child_safety_confirmation_required');
    }

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: existing.status },
      data: { status },
    });

    if (result.count === 0) {
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: postId,
      diff: {
        previousStatus: existing.status,
        newStatus: status,
        childSafetyConfirmed: existing.involvesChild && movesToLiveReview ? true : undefined,
        result: 'success',
      },
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — APPROVE POST
  //
  // FIX (#8) — now uses assertTransitionAllowed, so
  // approving a DRAFT post that was never submitted
  // is blocked (previously only APPROVED/REJECTED
  // were excluded).
  // ─────────────────────────────────────────────

  async approve(user: CurrentUserDto, postId: string, data: ApprovePostDto) {
    const post = await this.findOne(postId);

    assertTransitionAllowed(post.status, PostStatus.APPROVED);

    if (post.involvesChild && data.childSafetyConfirmed !== true) {
      throw new BadRequestException('child_safety_confirmation_required');
    }

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: { status: PostStatus.APPROVED },
    });

    if (result.count === 0) {
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_APPROVED,
      entity: 'Post',
      entityId: postId,
      diff: {
        previousStatus: post.status,
        newStatus: PostStatus.APPROVED,
        involvesChild: post.involvesChild,
        childSafetyConfirmed: post.involvesChild ? data.childSafetyConfirmed === true : undefined,
        result: 'success',
      },
    });

    const postApprovedEvent: PostApprovedEvent = {
      postId,
      userId: post.userId,
    };
    this.eventEmitter.emit(NotificationEventEnum.POST_APPROVED, postApprovedEvent);

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REQUEST CHANGES
  //
  // FIX (#9) — now uses assertTransitionAllowed, so
  // requesting changes on a DRAFT (never submitted)
  // is blocked, not just PUBLISHED/REJECTED.
  //
  // FIX (#11) — the message is now also persisted on
  // the Post row (reviewNote), not just the audit log
  // and notification payload, so GET /posts/me/:id
  // shows the owner *why* without relying on them
  // having caught the notification.
  //
  // NOTE: this requires a `reviewNote String?` column
  // on the Post model — add a Prisma migration for it
  // if it isn't already there.
  // ─────────────────────────────────────────────

  async requestChanges(user: CurrentUserDto, postId: string, data: RequestPostChangesDto) {
    const post = await this.findOne(postId);

    assertTransitionAllowed(post.status, PostStatus.CHANGES_REQUESTED);

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: {
        status: PostStatus.CHANGES_REQUESTED,
        reviewNote: data.message,
      },
    });

    if (result.count === 0) {
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: postId,
      diff: {
        previousStatus: post.status,
        newStatus: PostStatus.CHANGES_REQUESTED,
        message: data.message,
        result: 'success',
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.POST_CHANGES_REQUESTED, {
      postId,
      userId: post.userId,
      message: data.message,
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — PUBLISH POST
  // ─────────────────────────────────────────────

  async publish(user: CurrentUserDto, postId: string) {
    const post = await this.findOne(postId);

    assertTransitionAllowed(post.status, PostStatus.PUBLISHED);

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: { status: PostStatus.PUBLISHED },
    });

    if (result.count === 0) {
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_PUBLISHED,
      entity: 'Post',
      entityId: postId,
      diff: {
        previousStatus: post.status,
        newStatus: PostStatus.PUBLISHED,
        result: 'success',
      },
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REJECT POST
  //
  // FIX (#10) — now uses assertTransitionAllowed, so
  // a PUBLISHED post can no longer be rejected
  // directly; it must go through unpublish() first,
  // matching the real-world workflow (you take
  // something down before you formally reject it).
  //
  // FIX (#11) — reason is now also persisted on the
  // Post row (reviewNote). See migration note above.
  // ─────────────────────────────────────────────

  async reject(user: CurrentUserDto, postId: string, data: RejectPostDto) {
    const post = await this.findOne(postId);

    assertTransitionAllowed(post.status, PostStatus.REJECTED);

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: {
        status: PostStatus.REJECTED,
        reviewNote: data.reason,
      },
    });

    if (result.count === 0) {
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_REJECTED,
      entity: 'Post',
      entityId: postId,
      diff: {
        previousStatus: post.status,
        newStatus: PostStatus.REJECTED,
        reason: data.reason,
        result: 'success',
      },
    });

    const postRejectedEvent: PostRejectedEvent = {
      postId,
      userId: post.userId,
      title: post.title ?? undefined,
    };
    this.eventEmitter.emit(NotificationEventEnum.POST_REJECTED, postRejectedEvent);

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UNPUBLISH POST
  //
  // FIX (#14) — now notifies the post owner, matching
  // approve/reject/requestChanges. Previously a
  // user's published post could vanish from the
  // public feed with zero notice to them.
  // ─────────────────────────────────────────────

  async unpublish(user: CurrentUserDto, postId: string) {
    const post = await this.findOne(postId);

    assertTransitionAllowed(post.status, PostStatus.UNPUBLISHED);

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: { status: PostStatus.UNPUBLISHED },
    });

    if (result.count === 0) {
      throw new BadRequestException('post_transition_conflict');
    }

    const updated = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UNPUBLISHED,
      entity: 'Post',
      entityId: postId,
      diff: {
        previousStatus: post.status,
        newStatus: PostStatus.UNPUBLISHED,
        result: 'success',
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.POST_UNPUBLISHED, {
      postId,
      userId: post.userId,
    });

    return updated;
  }
}
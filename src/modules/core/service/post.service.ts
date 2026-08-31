import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  PostStatus,
  PostType,
  Prisma,
} from '@prisma/client';

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
  AdminPostQueryDto,
} from '../dto/post.dto';

// Added — statuses the owner is allowed to edit or submit from.
// PENDING is deliberately excluded: once submitted, the post is
// frozen for the owner until an admin approves it or sends it
// back via CHANGES_REQUESTED.
const OWNER_EDITABLE_STATUSES: PostStatus[] = [
  PostStatus.DRAFT,
  PostStatus.CHANGES_REQUESTED,
];

@Injectable()
export class PostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // CREATE POST
  //
  // Modified — status now starts at DRAFT instead
  // of PENDING, matching PRD §14's status list and
  // §12's CREATE POST → SUBMIT → PENDING flow. The
  // NEW_POST notification therefore no longer fires
  // here; it fires from submitMyPost() below, since
  // admins shouldn't be notified about a draft
  // nobody submitted yet.
  // ─────────────────────────────────────────────

  async create(
    userId: string,
    data: CreatePostDto,
  ) {
    const post =
      await this.prisma.post.create({
        data: {
          userId,

          title:
            data.title ?? null,

          content:
            data.content,

          type:
            data.type,

          involvesChild:
            data.involvesChild ?? false,

          status:
            PostStatus.DRAFT,

          photo:
            data.photo ?? [],

          video:
            data.video ?? [],

          audio:
            data.audio ?? [],

          pdf:
            data.pdf ?? [],

          document:
            data.document ?? [],

          other:
            data.other ?? [],
        },
      });

    /*
     * User-created content.
     *
     * The post has already been successfully created,
     * therefore emit the audit event AFTER persistence.
     *
     * Do not include post content, media URLs, password,
     * tokens, or other sensitive data in the audit payload.
     */
    this.eventEmitter.emit(
      AuditEventEnum.POST_CREATED,
      {
        userId,
        actorType: 'USER',
        action:
          AuditEventEnum.POST_CREATED,
        entity: 'Post',
        entityId: post.id,
        diff: {
          status: PostStatus.DRAFT,
          result: 'success',
        },
      } as AuditEventPayload,
    );

    return post;
  }

  // ─────────────────────────────────────────────
  // GET MY POSTS
  // ─────────────────────────────────────────────

  async findMyPosts(
    userId: string,
  ) {
    return this.prisma.post.findMany({
      where: {
        userId,
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // GET MY POST
  // ─────────────────────────────────────────────

  async findMyPost(
    userId: string,
    postId: string,
  ) {
    const post =
      await this.prisma.post.findFirst({
        where: {
          id: postId,
          userId,
        },
      });

    if (!post) {
      throw new NotFoundException(
        'post_not_found',
      );
    }

    return post;
  }

  // ─────────────────────────────────────────────
  // Added — UPDATE MY POST
  //
  // Allowed only while DRAFT or CHANGES_REQUESTED.
  // Does not itself resubmit the post — the owner
  // must call submitMyPost() explicitly, so "save
  // my edits" and "send this back to review" stay
  // two distinct actions.
  // ─────────────────────────────────────────────

  async updateMyPost(
    userId: string,
    postId: string,
    data: UpdatePostDto,
  ) {
    const existing =
      await this.prisma.post.findFirst({
        where: {
          id: postId,
          userId,
        },
      });

    if (!existing) {
      throw new NotFoundException(
        'post_not_found',
      );
    }

    if (
      !OWNER_EDITABLE_STATUSES.includes(
        existing.status,
      )
    ) {
      throw new BadRequestException(
        'post_cannot_be_edited_in_current_status',
      );
    }

    const post =
      await this.prisma.post.update({
        where: {
          id: postId,
        },

        data: {
          ...(data.title !== undefined
            ? { title: data.title }
            : {}),

          ...(data.content !== undefined
            ? { content: data.content }
            : {}),

          ...(data.type !== undefined
            ? { type: data.type }
            : {}),

          ...(data.involvesChild !== undefined
            ? { involvesChild: data.involvesChild }
            : {}),

          ...(data.photo !== undefined
            ? { photo: data.photo }
            : {}),

          ...(data.video !== undefined
            ? { video: data.video }
            : {}),

          ...(data.audio !== undefined
            ? { audio: data.audio }
            : {}),

          ...(data.pdf !== undefined
            ? { pdf: data.pdf }
            : {}),

          ...(data.document !== undefined
            ? { document: data.document }
            : {}),

          ...(data.other !== undefined
            ? { other: data.other }
            : {}),
        },
      });

    this.eventEmitter.emit(
      AuditEventEnum.POST_UPDATED,
      {
        userId,
        actorType: 'USER',
        action: AuditEventEnum.POST_UPDATED,
        entity: 'Post',
        entityId: post.id,
        diff: {
          previousStatus: existing.status,
          newStatus: post.status,
          result: 'success',
        },
      } as AuditEventPayload,
    );

    return post;
  }

  // ─────────────────────────────────────────────
  // Added — SUBMIT MY POST
  //
  // Moves DRAFT or CHANGES_REQUESTED → PENDING.
  // This is the step that puts the post in front of
  // admins (PRD §12 diagram), so NEW_POST fires here.
  // ─────────────────────────────────────────────

  async submitMyPost(
    userId: string,
    postId: string,
  ) {
    const existing =
      await this.prisma.post.findFirst({
        where: {
          id: postId,
          userId,
        },
      });

    if (!existing) {
      throw new NotFoundException(
        'post_not_found',
      );
    }

    if (
      !OWNER_EDITABLE_STATUSES.includes(
        existing.status,
      )
    ) {
      throw new BadRequestException(
        'post_cannot_be_submitted_in_current_status',
      );
    }

    const post =
      await this.prisma.post.update({
        where: {
          id: postId,
        },

        data: {
          status: PostStatus.PENDING,
        },
      });

    this.eventEmitter.emit(
      AuditEventEnum.POST_UPDATED,
      {
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
      } as AuditEventPayload,
    );

    /*
     * Notify the appropriate notification listener.
     *
     * The notification listener decides who should receive
     * the notification (for example administrators).
     */
    this.eventEmitter.emit(
      NotificationEventEnum.NEW_POST,
      {
        postId: post.id,
        userId,
      } as NewPostEvent,
    );

    return post;
  }

  // ─────────────────────────────────────────────
  // PUBLIC — GET PUBLISHED POSTS
  //
  // Modified — optional `type` filter separates
  // Incident Posts (PRD §12) from Awareness Posts
  // (§13) on the public feed.
  // ─────────────────────────────────────────────

  async findPublishedPosts(
    type?: PostType,
  ) {
    return this.prisma.post.findMany({
      where: {
        status:
          PostStatus.PUBLISHED,
        ...(type ? { type } : {}),
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // PUBLIC — GET ONE PUBLISHED POST
  // ─────────────────────────────────────────────

  async findPublishedPost(
    postId: string,
  ) {
    const post =
      await this.prisma.post.findFirst({
        where: {
          id: postId,

          status:
            PostStatus.PUBLISHED,
        },
      });

    if (!post) {
      throw new NotFoundException(
        'post_not_found',
      );
    }

    return post;
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ALL POSTS
  //
  // Modified — now filters by status/type/
  // involvesChild and paginates, matching
  // ReportService.findAllForAdmin's pattern
  // instead of returning every post unfiltered.
  // ─────────────────────────────────────────────

  async findAll(
    query: AdminPostQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.PostWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.involvesChild !== undefined
        ? { involvesChild: query.involvesChild }
        : {}),
    };

    const [items, total] =
      await this.prisma.$transaction([
        this.prisma.post.findMany({
          where,
          orderBy: {
            createdAt: 'desc',
          },
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

  async findOne(
    postId: string,
  ) {
    const post =
      await this.prisma.post.findUnique({
        where: {
          id: postId,
        },
      });

    if (!post) {
      throw new NotFoundException(
        'post_not_found',
      );
    }

    return post;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  //
  // Unchanged, kept exactly as it was.
  // ─────────────────────────────────────────────

  async updateStatus(
    user: CurrentUserDto,
    postId: string,
    status: PostStatus,
  ) {
    const existing =
      await this.findOne(postId);

    const updated =
      await this.prisma.post.update({
        where: {
          id: postId,
        },

        data: {
          status,
        },
      });

    /*
     * Generic status change.
     */
    this.eventEmitter.emit(
      AuditEventEnum.POST_UPDATED,
      {
        userId: user.id,
        actorType: resolveActorType(
          user.roles ?? [],
        ),
        action:
          AuditEventEnum.POST_UPDATED,
        entity: 'Post',
        entityId: postId,
        diff: {
          previousStatus:
            existing.status,
          newStatus:
            status,
          result: 'success',
        },
      } as AuditEventPayload,
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — APPROVE POST
  //
  // Modified — now takes ApprovePostDto and blocks
  // approval unless childSafetyConfirmed is true
  // whenever the post has involvesChild = true
  // (PRD §32).
  // ─────────────────────────────────────────────

  async approve(
    user: CurrentUserDto,
    postId: string,
    data: ApprovePostDto,
  ) {
    const post =
      await this.findOne(postId);

    if (
      post.status ===
      PostStatus.APPROVED
    ) {
      throw new BadRequestException(
        'post_already_approved',
      );
    }

    if (
      post.status ===
      PostStatus.REJECTED
    ) {
      throw new BadRequestException(
        'rejected_post_cannot_be_approved',
      );
    }

    if (
      post.involvesChild &&
      data.childSafetyConfirmed !== true
    ) {
      throw new BadRequestException(
        'child_safety_confirmation_required',
      );
    }

    const updated =
      await this.prisma.post.update({
        where: {
          id: postId,
        },

        data: {
          status:
            PostStatus.APPROVED,
        },
      });

    /*
     * Audit.
     */
    this.eventEmitter.emit(
      AuditEventEnum.POST_APPROVED,
      {
        userId: user.id,
        actorType: resolveActorType(
          user.roles ?? [],
        ),
        action:
          AuditEventEnum.POST_APPROVED,
        entity: 'Post',
        entityId: postId,
        diff: {
          previousStatus:
            post.status,
          newStatus:
            PostStatus.APPROVED,
          involvesChild:
            post.involvesChild,
          childSafetyConfirmed:
            post.involvesChild
              ? data.childSafetyConfirmed === true
              : undefined,
          result: 'success',
        },
      } as AuditEventPayload,
    );

    /*
     * Notify post owner.
     */
    this.eventEmitter.emit(
      NotificationEventEnum.POST_APPROVED,
      {
        postId,
        userId: post.userId,
      } as PostApprovedEvent,
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // Added — ADMIN — REQUEST CHANGES
  //
  // PRD §24: "Request changes" (Posts). Distinct
  // from reject — sends the post back to the owner
  // (editable via updateMyPost, resubmittable via
  // submitMyPost) instead of closing it out.
  // ─────────────────────────────────────────────

  async requestChanges(
    user: CurrentUserDto,
    postId: string,
    data: RequestPostChangesDto,
  ) {
    const post =
      await this.findOne(postId);

    if (
      post.status === PostStatus.PUBLISHED ||
      post.status === PostStatus.REJECTED
    ) {
      throw new BadRequestException(
        'post_cannot_have_changes_requested_in_current_status',
      );
    }

    const updated =
      await this.prisma.post.update({
        where: {
          id: postId,
        },

        data: {
          status: PostStatus.CHANGES_REQUESTED,
        },
      });

    this.eventEmitter.emit(
      AuditEventEnum.POST_UPDATED,
      {
        userId: user.id,
        actorType: resolveActorType(
          user.roles ?? [],
        ),
        action: AuditEventEnum.POST_UPDATED,
        entity: 'Post',
        entityId: postId,
        diff: {
          previousStatus: post.status,
          newStatus: PostStatus.CHANGES_REQUESTED,
          message: data.message,
          result: 'success',
        },
      } as AuditEventPayload,
    );

    this.eventEmitter.emit(
      NotificationEventEnum.POST_CHANGES_REQUESTED,
      {
        postId,
        userId: post.userId,
        message: data.message,
      },
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — PUBLISH POST
  // ─────────────────────────────────────────────

  async publish(
    user: CurrentUserDto,
    postId: string,
  ) {
    const post =
      await this.findOne(postId);

    if (
      post.status !==
        PostStatus.APPROVED &&
      post.status !==
        PostStatus.UNPUBLISHED
    ) {
      throw new BadRequestException(
        'post_must_be_approved_before_publishing',
      );
    }

    const updated =
      await this.prisma.post.update({
        where: {
          id: postId,
        },

        data: {
          status:
            PostStatus.PUBLISHED,
        },
      });

    /*
     * Audit.
     */
    this.eventEmitter.emit(
      AuditEventEnum.POST_PUBLISHED,
      {
        userId: user.id,
        actorType: resolveActorType(
          user.roles ?? [],
        ),
        action:
          AuditEventEnum.POST_PUBLISHED,
        entity: 'Post',
        entityId: postId,
        diff: {
          previousStatus:
            post.status,
          newStatus:
            PostStatus.PUBLISHED,
          result: 'success',
        },
      } as AuditEventPayload,
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REJECT POST
  // ─────────────────────────────────────────────

  async reject(
    user: CurrentUserDto,
    postId: string,
  ) {
    const post =
      await this.findOne(postId);

    if (
      post.status ===
      PostStatus.REJECTED
    ) {
      throw new BadRequestException(
        'post_already_rejected',
      );
    }

    const updated =
      await this.prisma.post.update({
        where: {
          id: postId,
        },

        data: {
          status:
            PostStatus.REJECTED,
        },
      });

    /*
     * Audit.
     */
    this.eventEmitter.emit(
      AuditEventEnum.POST_REJECTED,
      {
        userId: user.id,
        actorType: resolveActorType(
          user.roles ?? [],
        ),
        action:
          AuditEventEnum.POST_REJECTED,
        entity: 'Post',
        entityId: postId,
        diff: {
          previousStatus:
            post.status,
          newStatus:
            PostStatus.REJECTED,
          result: 'success',
        },
      } as AuditEventPayload,
    );

    /*
     * Notify post owner.
     */
    this.eventEmitter.emit(
      NotificationEventEnum.POST_REJECTED,
      {
        postId,
        userId: post.userId,
      } as PostRejectedEvent,
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UNPUBLISH POST
  // ─────────────────────────────────────────────

  async unpublish(
    user: CurrentUserDto,
    postId: string,
  ) {
    const post =
      await this.findOne(postId);

    if (
      post.status !==
      PostStatus.PUBLISHED
    ) {
      throw new BadRequestException(
        'post_is_not_published',
      );
    }

    const updated =
      await this.prisma.post.update({
        where: {
          id: postId,
        },

        data: {
          status:
            PostStatus.UNPUBLISHED,
        },
      });

    /*
     * Audit.
     */
    this.eventEmitter.emit(
      AuditEventEnum.POST_UNPUBLISHED,
      {
        userId: user.id,
        actorType: resolveActorType(
          user.roles ?? [],
        ),
        action:
          AuditEventEnum.POST_UNPUBLISHED,
        entity: 'Post',
        entityId: postId,
        diff: {
          previousStatus:
            post.status,
          newStatus:
            PostStatus.UNPUBLISHED,
          result: 'success',
        },
      } as AuditEventPayload,
    );

    return updated;
  }
}
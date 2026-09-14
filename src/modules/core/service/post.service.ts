import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PostStatus, PostType, Prisma } from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

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

import { MinioService } from 'src/services/minio/minio.service';

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

// The six media-array fields shared by CreatePostDto/UpdatePostDto
// and the Post model itself. Kept as a single tuple so every place
// that needs to loop over "all media fields" stays in sync if a
// new media kind is ever added.
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

// Single source of truth for what status can move to what. Every
// approve/reject/requestChanges/publish/unpublish/updateStatus call
// goes through this one map instead of its own ad hoc guard, so the
// workflow can't be bypassed by hitting a different endpoint.
const ALLOWED_STATUS_TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  [PostStatus.DRAFT]: [PostStatus.PENDING],
  [PostStatus.PENDING]: [
    PostStatus.APPROVED,
    PostStatus.REJECTED,
    PostStatus.CHANGES_REQUESTED,
    PostStatus.DRAFT,
  ],
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
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // ─────────────────────────────────────────────
  // MEDIA HELPERS
  //
  // Post stores media as plain filepath strings in
  // typed arrays (photo/video/audio/pdf/document/other)
  // rather than a relational Media table. These helpers
  // keep every read/write of that shape in one place.
  // ─────────────────────────────────────────────

  private collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  private collectMediaFieldsFromDto(dto: MediaBearingDto): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => dto[field] ?? []);
  }

  // Diffs each media field individually (not the flattened whole),
  // so a client resending the same photo array doesn't get treated
  // as "remove and re-add." Only fields present in the incoming DTO
  // are considered — an omitted field means "leave this one alone."
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

  // Confirms every filepath the client is attaching actually exists
  // in the media bucket, so a post can't reference an object that
  // was never uploaded (typo'd path, upload abandoned mid-flow,
  // filepath copied from an unrelated response, etc.). Only called
  // on filepaths that are new to the entity — already-attached
  // filepaths were validated when they were first added.
  //
  // FIX: MinioService.objectExists() is now bucket-less — the
  // service holds a single configured bucket internally, so callers
  // just pass the key. getMediaBucket()/bucket param removed here
  // to match the new signature.
  private async validateMediaFilesExist(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;

    const checks = await Promise.all(
      filepaths.map(async (filepath) => ({
        filepath,
        exists: await this.minioService.objectExists(filepath),
      })),
    );

    const missing = checks.filter((c) => !c.exists).map((c) => c.filepath);
    if (missing.length) {
      throw new BadRequestException(`media_files_not_found:${missing.join(',')}`);
    }
  }

  // Best-effort delete against MinIO. A file that's already gone
  // (or MinIO briefly unreachable) must never block the DB write
  // that triggered the cleanup — failures are swallowed per-file
  // via allSettled rather than surfaced to the caller.
  //
  // FIX: same bucket-less signature change as validateMediaFilesExist().
  private async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  // The only media fields ever exposed on a public post are the
  // media arrays themselves — but never when the post involves a
  // child. Mirrors VictimProfileService.getPubliclyVisibleMediaKeys
  // so the two stay in sync.
  private getPubliclyVisibleMediaKeys(
    post: Pick<MediaBearing, MediaFieldName> & { involvesChild: boolean },
  ): string[] {
    return post.involvesChild ? [] : this.collectMediaFields(post);
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET MEDIA DOWNLOAD URL
  // GET /posts/:id/media?key=...
  //
  // Admins can request a download URL for any media key actually
  // attached to the post, regardless of status — matches findOne()'s
  // admin-only, no-visibility-filtering access.
  // ─────────────────────────────────────────────

  async getMediaDownloadUrl(postId: string, key: string): Promise<{ url: string }> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    const owned = this.collectMediaFields(post).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_post');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  // ─────────────────────────────────────────────
  // PUBLIC — GET MEDIA DOWNLOAD URL
  // GET /posts/published/:id/media?key=...
  //
  // Same visibility gate as findPublishedPost() (status must be
  // PUBLISHED), PLUS the key must be one of the keys
  // getPubliclyVisibleMediaKeys() would actually expose — so a
  // child-involving post's media stays unreachable here, even
  // though the key technically still exists in the DB row.
  // ─────────────────────────────────────────────

  async getPublicMediaDownloadUrl(postId: string, key: string): Promise<{ url: string }> {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, status: PostStatus.PUBLISHED },

      select: {
        photo: true,
        video: true,
        audio: true,
        pdf: true,
        document: true,
        other: true,
        involvesChild: true,
      },
    });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    const allowedKeys = this.getPubliclyVisibleMediaKeys(post);
    if (!allowedKeys.includes(key)) {
      throw new NotFoundException('media_not_found_on_post');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  // ─────────────────────────────────────────────
  // CREATE POST
  // ─────────────────────────────────────────────

  async create(userId: string, data: CreatePostDto) {
    await this.validateMediaFilesExist(this.collectMediaFieldsFromDto(data));

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
  // An involvesChild=true post can only reach APPROVED
  // via this endpoint if the caller explicitly passes
  // childSafetyConfirmed: true, exactly like approve()
  // requires. The PENDING path (publishImmediately=false)
  // doesn't require it here, since that path still goes
  // through approve()'s own gate later.
  // ─────────────────────────────────────────────

  async createOfficial(actor: CurrentUserDto, data: AdminCreatePostDto) {
    const publishImmediately = data.publishImmediately ?? true;
    const involvesChild = data.involvesChild ?? false;

    if (publishImmediately && involvesChild && data.childSafetyConfirmed !== true) {
      throw new BadRequestException('child_safety_confirmation_required');
    }

    await this.validateMediaFilesExist(this.collectMediaFieldsFromDto(data));

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
  //
  // Media handling: for each media field present in the
  // request, diffs against what's currently on the row.
  // Newly-added filepaths are validated against MinIO
  // before the write; filepaths dropped from the new
  // array are deleted from MinIO after the write commits.
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

    const { added, removed } = this.diffMediaFields(existing, data);
    await this.validateMediaFilesExist(added);

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

    // Only after the DB write commits — deleting first and having
    // the write fail would strand the post pointing at nothing.
    await this.deleteMediaFiles(removed);

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

    // Conditional update guards against a concurrent transition
    // landing between findFirst and update.
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
  // CANCEL / WITHDRAW MY POST
  // PENDING → DRAFT.
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
  // DELETE MY POST
  // Scoped to DRAFT only. Deletes the DB row, then
  // removes every attached media object from MinIO —
  // once the row referencing them is gone, an orphaned
  // object in the bucket serves no purpose.
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

    await this.deleteMediaFiles(this.collectMediaFields(existing));

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
  // Validates the transition via the shared map,
  // requires childSafetyConfirmed when moving an
  // involvesChild post to APPROVED or PUBLISHED, and
  // uses a conditional update to avoid racing another
  // concurrent transition.
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
  // The message is persisted on the Post row
  // (reviewNote), not just the audit log and
  // notification payload, so GET /posts/me/:id shows
  // the owner why without relying on the notification.
  //
  // NOTE: requires a `reviewNote String?` column on
  // the Post model. See the migration note in schema.
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
  // A PUBLISHED post can't be rejected directly; it
  // must go through unpublish() first, matching the
  // real-world workflow (take something down before
  // formally rejecting it). Reason is persisted on
  // the Post row (reviewNote).
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
  // Notifies the post owner, matching
  // approve/reject/request-changes.
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

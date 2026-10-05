import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import {
  AuditOutcome,
  AuditSeverity,
  PostAppealStatus,
  PostAppealTarget,
  PostFlagStatus,
  PostStatus,
  PostType,
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

import {
  PostApprovedEvent,
  PostRejectedEvent,
  NewPostEvent,
} from 'src/modules/misc/events/notification.events';

import { MinioService } from 'src/services/minio/minio.service';
import { CacheService } from 'src/services/redis/cache.service';

import {
  CreatePostDto,
  UpdatePostDto,
  RequestPostChangesDto,
  ApprovePostDto,
  RejectPostDto,
  AdminCreatePostDto,
  AdminPostQueryDto,
  PublishedPostsQueryDto,
  AppealPostDto,
  DecidePostAppealDto,
  FlagPostDto,
  ResolvePostFlagsDto,
  TakedownPostDto,
  UnreadPostsQueryDto,
  PostAuthorRollupQueryDto,
  PostsByAuthorQueryDto,
  FlaggedPostsQueryDto,
  PostAppealsQueryDto,
  PostTimelineQueryDto,
} from '../dto/post.dto';

// Statuses the owner may edit/submit from; PENDING is frozen until admin action.
const OWNER_EDITABLE_STATUSES: PostStatus[] = [PostStatus.DRAFT, PostStatus.CHANGES_REQUESTED];

// The six media-array fields shared by CreatePostDto/UpdatePostDto and the Post model.
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

type PostAuditRef = {
  id: string;
  userId: string;
  title: string | null;
  type: PostType;
};

// Titles are free text, so the audit label is capped to keep it list-friendly.
const ENTITY_LABEL_MAX_LENGTH = 120;

// Single source of truth for what status can move to what.
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

const STATUSES_THAT_CHANGE_PUBLIC_VISIBILITY: PostStatus[] = [
  PostStatus.PUBLISHED,
  PostStatus.UNPUBLISHED,
];

const PUBLIC_POST_OMIT_FIELDS = [
  'userId',
  'reviewNote',
  'idempotencyKey',
  'claimedByUserId',
  'claimedAt',
  'childSafetyFirstConfirmedByUserId',
  'childSafetyFirstConfirmedAt',
  'ownerSuspendedAt',
  'takedownReason',
  'takedownAt',
  'takedownById',
] as const;

type PublicPost = ReturnType<PostService['toPublicPost']>;

// Open-state shortcuts for flags and appeals.
const FLAG_OPEN = PostFlagStatus.OPEN;
const APPEAL_OPEN = PostAppealStatus.OPEN;

// Statuses of the author-facing summary, in the order the response lists them.
const SUMMARY_STATUSES: PostStatus[] = Object.values(PostStatus);

// Only these transitions are shown to the author in their review timeline.
const AUTHOR_VISIBLE_REASON_STATUSES: string[] = [
  PostStatus.REJECTED,
  PostStatus.CHANGES_REQUESTED,
];

@Injectable()
export class PostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // Falls back to the post type when there's no title, so the row is never blank.
  private postLabel(post: Pick<PostAuditRef, 'title' | 'type'>): string {
    const raw = post.title?.trim() || `Untitled ${post.type} post`;
    return raw.length > ENTITY_LABEL_MAX_LENGTH
      ? `${raw.slice(0, ENTITY_LABEL_MAX_LENGTH - 3)}...`
      : raw;
  }

  private auditTarget(post: Pick<PostAuditRef, 'userId'>, actorUserId: string): string | undefined {
    return post.userId !== actorUserId ? post.userId : undefined;
  }

  // Writes the audit row for a blocked attempt before the caller throws.
  private emitBlockedAttempt(args: {
    outcome: AuditOutcome;
    severity?: AuditSeverity;
    user: CurrentUserDto;
    post: PostAuditRef;
    action: AuditEventEnum;
    reason: string;
    diff?: Prisma.InputJsonObject;
    metadata?: Prisma.InputJsonObject;
  }): void {
    this.emitAudit({
      userId: args.user.id,
      targetUserId: this.auditTarget(args.post, args.user.id),
      actorType: resolveActorType(args.user.roles ?? []),
      action: args.action,
      outcome: args.outcome,
      severity: args.severity ?? AuditSeverity.WARNING,
      entity: 'Post',
      entityId: args.post.id,
      entityLabel: this.postLabel(args.post),
      reason: args.reason,
      diff: {
        result: args.outcome === AuditOutcome.DENIED ? 'denied' : 'failure',
        ...(args.diff ?? {}),
      },
      metadata: args.metadata,
    });
  }

  private emitChildSafetyFirstConfirmation(user: CurrentUserDto, post: PostAuditRef): void {
    this.emitAudit({
      userId: user.id,
      targetUserId: this.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: post.id,
      entityLabel: this.postLabel(post),
      diff: {
        childSafetyFirstConfirmationBy: user.id,
        result: 'pending_second_admin_confirmation',
      },
    });
  }

  // Writes a FAILURE audit row on an invalid transition before throwing.
  private assertTransitionAllowed(
    user: CurrentUserDto,
    post: PostAuditRef & { status: PostStatus },
    to: PostStatus,
    action: AuditEventEnum,
    metadata?: Prisma.InputJsonObject,
  ): void {
    if (ALLOWED_STATUS_TRANSITIONS[post.status]?.includes(to)) return;

    this.emitBlockedAttempt({
      outcome: AuditOutcome.FAILURE,
      user,
      post,
      action,
      reason: 'post_transition_not_allowed',
      diff: { attemptedStatus: to, currentStatus: post.status },
      metadata,
    });
    throw new BadRequestException(`post_transition_not_allowed:${post.status}->${to}`);
  }

  private collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  private collectMediaFieldsFromDto(dto: MediaBearingDto): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => dto[field] ?? []);
  }

  // Diffs each media field individually so resending the same array isn't a remove+re-add.
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

  // Confirms every new filepath exists in the media bucket and is within size/type limits.
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

  // Per-field attachment caps, checked before any MinIO round trips.
  private assertAttachmentCounts(media: MediaBearing): void {
    const maxPhotos = Number(
      this.configService.get<string>('POST_MAX_PHOTOS') ??
        this.configService.get<string>('CONTENT_MAX_PHOTOS') ??
        5,
    );
    const maxVideos = Number(
      this.configService.get<string>('POST_MAX_VIDEOS') ??
        this.configService.get<string>('CONTENT_MAX_VIDEOS') ??
        1,
    );
    const maxOther = Number(
      this.configService.get<string>('POST_MAX_OTHER_FILES') ??
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

  // Total attached-media size cap per post.
  private assertTotalBytes(totalBytes: number): void {
    const maxTotalBytes = Number(
      this.configService.get<string>('POST_MAX_TOTAL_UPLOAD_BYTES') ??
        this.configService.get<string>('CONTENT_MAX_TOTAL_UPLOAD_BYTES') ??
        52_428_800,
    );
    if (totalBytes > maxTotalBytes) {
      throw new BadRequestException(`upload_total_size_exceeded:max_${maxTotalBytes}`);
    }
  }

  // Best-effort delete; a failure here must never block the DB write that triggered it.
  private async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  private getPubliclyVisibleMediaKeys(
    post: Pick<MediaBearing, MediaFieldName> & { involvesChild: boolean },
  ): string[] {
    return post.involvesChild ? [] : this.collectMediaFields(post);
  }

  // Strips fields a public reader has no business seeing, most importantly userId.
  private toPublicPost<T extends Record<string, unknown>>(
    post: T,
  ): Omit<T, (typeof PUBLIC_POST_OMIT_FIELDS)[number]> {
    const copy: Record<string, unknown> = { ...post };
    for (const field of PUBLIC_POST_OMIT_FIELDS) {
      delete copy[field];
    }
    return copy as Omit<T, (typeof PUBLIC_POST_OMIT_FIELDS)[number]>;
  }

  private assertNotClaimedByOther(
    user: CurrentUserDto,
    post: PostAuditRef & { claimedByUserId: string | null },
    action: AuditEventEnum,
    metadata?: Prisma.InputJsonObject,
  ): void {
    if (post.claimedByUserId && post.claimedByUserId !== user.id) {
      this.emitBlockedAttempt({
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
    const post = await this.findOne(postId);
    this.assertNotClaimedByOther(user, post, AuditEventEnum.POST_UPDATED);

    const updated = await this.prisma.post.update({
      where: { id: postId },
      data: { claimedByUserId: user.id, claimedAt: new Date() },
    });

    this.emitAudit({
      userId: user.id,
      targetUserId: this.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
      diff: { claimedBy: user.id, result: 'success' },
    });

    return updated;
  }

  async unclaimPost(user: CurrentUserDto, postId: string) {
    const post = await this.findOne(postId);
    this.assertNotClaimedByOther(user, post, AuditEventEnum.POST_UPDATED);

    const updated = await this.prisma.post.update({
      where: { id: postId },
      data: { claimedByUserId: null, claimedAt: null },
    });

    this.emitAudit({
      userId: user.id,
      targetUserId: this.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
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
      this.emitBlockedAttempt({
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
      this.emitBlockedAttempt({
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

    this.emitAudit({
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
      this.emitAudit({
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

  private async enforceCreateRateLimit(userId: string): Promise<void> {
    const cooldownSeconds = Number(
      this.configService.get<string>('POST_CREATE_RATE_LIMIT_WINDOW_SECONDS') ??
        this.configService.get<string>('CONTENT_CREATE_RATE_LIMIT_WINDOW_SECONDS') ??
        60,
    );

    const lastPost = await this.prisma.post.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (lastPost && Date.now() - lastPost.createdAt.getTime() < cooldownSeconds * 1000) {
      throw new BadRequestException('post_creation_rate_limited');
    }
  }

  async create(userId: string, data: CreatePostDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.post.findFirst({
        where: { userId, idempotencyKey },
      });
      if (existing) {
        return existing;
      }
    }

    await this.enforceCreateRateLimit(userId);

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

    const postType: PostType = data.type;

    const post = await this.prisma.post.create({
      data: {
        userId,
        title: data.title ?? null,
        content: data.content,
        type: postType,
        involvesChild: data.involvesChild ?? false,
        status: PostStatus.DRAFT,
        photo: merged.photo,
        video: merged.video,
        audio: merged.audio,
        pdf: merged.pdf,
        document: merged.document,
        other: merged.other,
        mediaTotalBytes: totalBytes,
        idempotencyKey: idempotencyKey ?? null,
      },
    });

    this.emitAudit({
      userId,
      actorType: 'USER',
      action: AuditEventEnum.POST_CREATED,
      entity: 'Post',
      entityId: post.id,
      entityLabel: this.postLabel(post),
      diff: {
        status: PostStatus.DRAFT,
        result: 'success',
      },
      metadata: {
        postType,
        involvesChild: post.involvesChild,
        mediaCount: this.collectMediaFields(merged).length,
        mediaTotalBytes: totalBytes,
        idempotencyKeyProvided: idempotencyKey !== undefined,
      },
    });

    return post;
  }

  async createOfficial(actor: CurrentUserDto, data: AdminCreatePostDto) {
    const publishImmediately = data.publishImmediately ?? true;
    const involvesChild = data.involvesChild ?? false;

    if (publishImmediately && involvesChild && data.childSafetyConfirmed !== true) {
      throw new BadRequestException('child_safety_confirmation_required');
    }

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
        photo: merged.photo,
        video: merged.video,
        audio: merged.audio,
        pdf: merged.pdf,
        document: merged.document,
        other: merged.other,
        mediaTotalBytes: totalBytes,
      },
    });

    this.emitAudit({
      userId: actor.id,
      actorType: resolveActorType(actor.roles ?? []),
      action: AuditEventEnum.POST_CREATED,
      entity: 'Post',
      entityId: post.id,
      entityLabel: this.postLabel(post),
      diff: {
        official: true,
        status,
        involvesChild,
        childSafetyConfirmed: publishImmediately && involvesChild ? true : undefined,
        result: 'success',
      },
      metadata: {
        postType,
        publishImmediately,
        mediaCount: this.collectMediaFields(merged).length,
        mediaTotalBytes: totalBytes,
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

  async findMyPosts(userId: string) {
    return this.prisma.post.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findMyPost(userId: string, postId: string) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, userId },
    });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    return post;
  }

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

    const merged: MediaBearing = {
      photo: data.photo ?? existing.photo,
      video: data.video ?? existing.video,
      audio: data.audio ?? existing.audio,
      pdf: data.pdf ?? existing.pdf,
      document: data.document ?? existing.document,
      other: data.other ?? existing.other,
    };
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

    const newTotalBytes = Math.max(0, existing.mediaTotalBytes + addedBytes - removedBytes);
    this.assertTotalBytes(newTotalBytes);

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
        mediaTotalBytes: newTotalBytes,
      },
    });

    await this.deleteMediaFiles(removed);

    this.emitAudit({
      userId,
      actorType: 'USER',
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: post.id,
      entityLabel: this.postLabel(post),
      diff: {
        updatedFields,
        result: 'success',
      },
      metadata: {
        mediaAdded: added.length,
        mediaRemoved: removed.length,
        mediaTotalBytes: newTotalBytes,
      },
    });

    return post;
  }

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

    const maxPending = Number(
      this.configService.get<string>('POST_MAX_PENDING_PER_USER') ??
        this.configService.get<string>('CONTENT_MAX_PENDING_PER_USER') ??
        5,
    );
    const pendingCount = await this.prisma.post.count({
      where: { userId, status: PostStatus.PENDING },
    });
    if (pendingCount >= maxPending) {
      throw new BadRequestException('too_many_pending_posts');
    }

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
      entityLabel: this.postLabel(post),
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
      entityLabel: this.postLabel(post),
      reason: 'withdrawn_by_owner',
      diff: {
        previousStatus: PostStatus.PENDING,
        newStatus: PostStatus.DRAFT,
        result: 'success',
      },
    });

    return post;
  }

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

    const mediaToPurge = this.collectMediaFields(existing);

    await this.prisma.post.delete({ where: { id: postId } });

    await this.deleteMediaFiles(mediaToPurge);

    this.emitAudit({
      userId,
      actorType: 'USER',
      action: AuditEventEnum.POST_DELETED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(existing),
      diff: {
        previousStatus: PostStatus.DRAFT,
        result: 'success',
      },
      metadata: {
        postType: existing.type,
        mediaFilesPurged: mediaToPurge.length,
      },
    });

    return { id: postId, deleted: true };
  }

  async findPublishedPosts(query: PublishedPostsQueryDto) {
    return this.cache.wrapPostList(query as unknown as Record<string, unknown>, () =>
      this.findPublishedPostsUncached(query),
    );
  }

  private async findPublishedPostsUncached(query: PublishedPostsQueryDto) {
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
      items: items.map((item) => this.toPublicPost(item)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findPublishedPost(postId: string) {
    const cached = await this.cache.getPost<PublicPost>(postId);
    if (cached !== null) return cached;

    const post = await this.prisma.post.findFirst({
      where: { id: postId, status: PostStatus.PUBLISHED },
    });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    const publicPost = this.toPublicPost(post);
    await this.cache.setPost(postId, publicPost);
    return publicPost;
  }

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

  async getStats() {
    const [total, byStatus, byType] = await this.prisma.$transaction([
      this.prisma.post.count(),
      this.prisma.post.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.post.groupBy({
        by: ['type'],
        _count: { type: true },
        orderBy: { type: 'asc' },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(PostStatus).map((status) => [status, 0]),
    ) as Record<PostStatus, number>;

    for (const row of byStatus) {
      const rowCount = row._count as { status?: number } | undefined;
      statusCounts[row.status] = rowCount?.status ?? 0;
    }

    const typeCounts = Object.fromEntries(
      Object.values(PostType).map((type) => [type, 0]),
    ) as Record<PostType, number>;

    for (const row of byType) {
      const rowCount = row._count as { type?: number } | undefined;
      typeCounts[row.type] = rowCount?.type ?? 0;
    }

    return {
      total,
      draft: statusCounts[PostStatus.DRAFT] ?? 0,
      pending: statusCounts[PostStatus.PENDING] ?? 0,
      changesRequested: statusCounts[PostStatus.CHANGES_REQUESTED] ?? 0,
      approved: statusCounts[PostStatus.APPROVED] ?? 0,
      published: statusCounts[PostStatus.PUBLISHED] ?? 0,
      unpublished: statusCounts[PostStatus.UNPUBLISHED] ?? 0,
      rejected: statusCounts[PostStatus.REJECTED] ?? 0,
      byType: typeCounts,
    };
  }

  async findStalePending() {
    const staleHours = Number(
      this.configService.get<string>('POST_STALE_PENDING_HOURS') ??
        this.configService.get<string>('CONTENT_STALE_PENDING_HOURS') ??
        48,
    );
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

    const posts = await this.prisma.post.findMany({
      where: { status: PostStatus.PENDING, createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
    });

    return posts.map((post) => ({
      ...post,
      pendingHours: Math.floor((Date.now() - post.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
  }

  async bulkApprove(user: CurrentUserDto, ids: string[]) {
    const results: Array<{ id: string; success: boolean; error?: string }> = [];

    for (const id of ids) {
      try {
        const post = await this.findOne(id);
        if (post.involvesChild) {
          this.emitBlockedAttempt({
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
        const post = await this.findOne(id);
        if (post.involvesChild) {
          this.emitBlockedAttempt({
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

  async findOne(postId: string) {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    return post;
  }

  async getHistory(postId: string) {
    await this.findOne(postId);

    return this.prisma.auditLog.findMany({
      where: { entity: 'Post', entityId: postId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateStatus(
    user: CurrentUserDto,
    postId: string,
    status: PostStatus,
    childSafetyConfirmed?: boolean,
  ) {
    const existing = await this.findOne(postId);

    this.assertTransitionAllowed(user, existing, status, AuditEventEnum.POST_UPDATED);
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
      this.emitBlockedAttempt({
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

    this.emitAudit({
      userId: user.id,
      targetUserId: this.auditTarget(existing, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(updated),
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
    const post = await this.findOne(postId);
    const bulkMeta: Prisma.InputJsonObject = { bulk: options.bulk === true };

    this.assertTransitionAllowed(
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
      this.emitBlockedAttempt({
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

    this.emitAudit({
      userId: user.id,
      targetUserId: this.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_APPROVED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
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
    const post = await this.findOne(postId);

    this.assertTransitionAllowed(
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
      this.emitBlockedAttempt({
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

    this.emitAudit({
      userId: user.id,
      targetUserId: this.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UPDATED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
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
    const post = await this.findOne(postId);

    this.assertTransitionAllowed(user, post, PostStatus.PUBLISHED, AuditEventEnum.POST_PUBLISHED);

    const result = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: { status: PostStatus.PUBLISHED },
    });

    if (result.count === 0) {
      this.emitBlockedAttempt({
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

    this.emitAudit({
      userId: user.id,
      targetUserId: this.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_PUBLISHED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
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
    const post = await this.findOne(postId);
    const bulkMeta: Prisma.InputJsonObject = { bulk: options.bulk === true };

    this.assertTransitionAllowed(
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
      this.emitBlockedAttempt({
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

    this.emitAudit({
      userId: user.id,
      targetUserId: this.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_REJECTED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
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
    const post = await this.findOne(postId);

    this.assertTransitionAllowed(
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
      this.emitBlockedAttempt({
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

    this.emitAudit({
      userId: user.id,
      targetUserId: this.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_UNPUBLISHED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
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

  private pageArgs(query: { page?: number; limit?: number }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return { page, limit, skip: (page - 1) * limit, take: limit };
  }

  private pageMeta(total: number, page: number, limit: number) {
    return { total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ── Owner routes ──────────────────────────────

  // GET /posts/me/summary
  async getMyPostSummary(userId: string) {
    const rows = await this.prisma.post.groupBy({
      by: ['status'],
      where: { userId },
      _count: { status: true },
      orderBy: { status: 'asc' },
    });

    const counts = Object.fromEntries(SUMMARY_STATUSES.map((s) => [s, 0])) as Record<
      PostStatus,
      number
    >;
    for (const row of rows) {
      const rowCount = row._count as { status?: number } | undefined;
      counts[row.status] = rowCount?.status ?? 0;
    }

    return {
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      draft: counts[PostStatus.DRAFT],
      pending: counts[PostStatus.PENDING],
      changesRequested: counts[PostStatus.CHANGES_REQUESTED],
      approved: counts[PostStatus.APPROVED],
      published: counts[PostStatus.PUBLISHED],
      unpublished: counts[PostStatus.UNPUBLISHED],
      rejected: counts[PostStatus.REJECTED],
    };
  }

  // GET /posts/me/:id/history (status changes only, no admin identities or internal notes)
  async getMyPostHistory(userId: string, postId: string) {
    await this.findMyPost(userId, postId);

    const rows = await this.prisma.auditLog.findMany({
      where: { entity: 'Post', entityId: postId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.flatMap((row) => {
      const diff = row.diff as Prisma.JsonObject | null;
      const to = typeof diff?.newStatus === 'string' ? diff.newStatus : null;
      if (!to || diff?.result !== 'success') return [];

      const showReason = diff?.takedown === true || AUTHOR_VISIBLE_REASON_STATUSES.includes(to);
      return [
        {
          at: row.createdAt,
          from: typeof diff?.previousStatus === 'string' ? diff.previousStatus : null,
          to,
          reason: showReason ? (row.reason ?? null) : null,
        },
      ];
    });
  }

  // POST /posts/me/:id/appeal
  async appealMyPost(userId: string, postId: string, data: AppealPostDto) {
    const post = await this.findMyPost(userId, postId);

    const wasTakenDown = post.status === PostStatus.UNPUBLISHED && post.takedownAt !== null;
    if (post.status !== PostStatus.REJECTED && !wasTakenDown) {
      throw new BadRequestException('post_not_appealable');
    }

    const open = await this.prisma.postAppeal.findFirst({
      where: { postId, status: APPEAL_OPEN },
      select: { id: true },
    });
    if (open) {
      throw new BadRequestException('appeal_already_open');
    }

    const target = wasTakenDown ? PostAppealTarget.TAKEDOWN : PostAppealTarget.REJECTION;

    const appeal = await this.prisma.postAppeal.create({
      data: { postId, authorId: userId, target, message: data.message },
    });

    this.emitAudit({
      userId,
      actorType: 'USER',
      action: AuditEventEnum.POST_APPEAL_SUBMITTED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
      reason: 'post_appeal_submitted',
      diff: { appealId: appeal.id, result: 'appeal_open' },
      metadata: { postType: post.type, appealTarget: target },
    });

    return appeal;
  }

  // GET /posts/me/:id/appeals
  async findMyPostAppeals(userId: string, postId: string) {
    await this.findMyPost(userId, postId);

    return this.prisma.postAppeal.findMany({
      where: { postId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        target: true,
        message: true,
        status: true,
        decisionNote: true,
        decidedAt: true,
        createdAt: true,
      },
    });
  }

  // ── Admin read state ──────────────────────────

  // PATCH /posts/:id/read
  async markRead(admin: CurrentUserDto, postId: string) {
    await this.findOne(postId);

    await this.prisma.postReadState.upsert({
      where: { postId_adminId: { postId, adminId: admin.id } },
      create: { postId, adminId: admin.id },
      update: {},
    });

    return { postId, read: true };
  }

  // PATCH /posts/:id/unread
  async markUnread(admin: CurrentUserDto, postId: string) {
    await this.findOne(postId);

    await this.prisma.postReadState.deleteMany({ where: { postId, adminId: admin.id } });

    return { postId, read: false };
  }

  // PATCH /posts/bulk/read
  async bulkMarkRead(admin: CurrentUserDto, ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    const existing = await this.prisma.post.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true },
    });
    const existingIds = existing.map((p) => p.id);

    await this.prisma.postReadState.createMany({
      data: existingIds.map((postId) => ({ postId, adminId: admin.id })),
      skipDuplicates: true,
    });

    const found = new Set(existingIds);
    return { marked: existingIds.length, notFound: uniqueIds.filter((id) => !found.has(id)) };
  }

  // PATCH /posts/read-all
  async markAllRead(admin: CurrentUserDto) {
    const unread = await this.prisma.post.findMany({
      where: { readStates: { none: { adminId: admin.id } } },
      select: { id: true },
    });

    await this.prisma.postReadState.createMany({
      data: unread.map((p) => ({ postId: p.id, adminId: admin.id })),
      skipDuplicates: true,
    });

    return { marked: unread.length };
  }

  // GET /posts/unread-count
  async getUnreadCount(admin: CurrentUserDto) {
    const [total, read] = await this.prisma.$transaction([
      this.prisma.post.count(),
      this.prisma.postReadState.count({ where: { adminId: admin.id } }),
    ]);

    return { total, read, unread: Math.max(0, total - read) };
  }

  // GET /posts/unread
  async findUnread(admin: CurrentUserDto, query: UnreadPostsQueryDto) {
    const { page, limit, skip, take } = this.pageArgs(query);

    const where: Prisma.PostWhereInput = {
      readStates: { none: { adminId: admin.id } },
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.post.count({ where }),
    ]);

    return { items, ...this.pageMeta(total, page, limit) };
  }

  // ── Admin per-author views ────────────────────

  // GET /posts/by-author
  async findAuthorRollup(query: PostAuthorRollupQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);

    const rows = await this.prisma.post.groupBy({
      by: ['userId', 'status'],
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: [{ userId: 'asc' }, { status: 'asc' }],
    });

    const authors = new Map<
      string,
      {
        userId: string;
        totalPosts: number;
        pending: number;
        lastPostAt: Date | null;
        byStatus: Record<string, number>;
      }
    >();

    for (const row of rows) {
      const count = (row._count as { _all?: number } | undefined)?._all ?? 0;
      const last = row._max?.createdAt ?? null;
      const entry = authors.get(row.userId) ?? {
        userId: row.userId,
        totalPosts: 0,
        pending: 0,
        lastPostAt: null,
        byStatus: {},
      };
      entry.totalPosts += count;
      entry.byStatus[row.status] = count;
      if (row.status === PostStatus.PENDING) entry.pending = count;
      if (last && (!entry.lastPostAt || last > entry.lastPostAt)) entry.lastPostAt = last;
      authors.set(row.userId, entry);
    }

    const sortBy = query.sortBy ?? 'lastPostAt';
    const dir = (query.order ?? 'desc') === 'asc' ? 1 : -1;
    const sortValue = (a: { totalPosts: number; pending: number; lastPostAt: Date | null }) =>
      sortBy === 'lastPostAt' ? (a.lastPostAt?.getTime() ?? 0) : a[sortBy];

    const sorted = [...authors.values()].sort((a, b) => (sortValue(a) - sortValue(b)) * dir);

    return {
      items: sorted.slice(skip, skip + limit),
      ...this.pageMeta(sorted.length, page, limit),
    };
  }

  // GET /posts/by-author/:authorId
  async findPostsByAuthor(authorId: string, query: PostsByAuthorQueryDto) {
    const { page, limit, skip, take } = this.pageArgs(query);

    const where: Prisma.PostWhereInput = {
      userId: authorId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.post.count({ where }),
    ]);

    return { items, ...this.pageMeta(total, page, limit) };
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

    this.emitAudit({
      userId: user.id,
      targetUserId: this.auditTarget(post, user.id),
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.POST_FLAGGED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
      reason: 'post_flagged',
      diff: { flagId: flag.id, flagReason: data.reason, result: 'flag_open' },
      metadata: { postType: post.type, involvesChild: post.involvesChild },
    });

    return { id: flag.id, postId, status: flag.status };
  }

  // GET /posts/flags
  async findFlaggedPosts(query: FlaggedPostsQueryDto) {
    const { page, limit, skip } = this.pageArgs(query);
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

    return { items, ...this.pageMeta(groups.length, page, limit) };
  }

  // GET /posts/:id/flags
  async findPostFlags(postId: string) {
    await this.findOne(postId);

    return this.prisma.postFlag.findMany({
      where: { postId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // PATCH /posts/:id/flags/resolve
  async resolveFlags(admin: CurrentUserDto, postId: string, data: ResolvePostFlagsDto) {
    const post = await this.findOne(postId);

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

    this.emitAudit({
      userId: admin.id,
      targetUserId: this.auditTarget(post, admin.id),
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.POST_FLAGS_RESOLVED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
      reason: data.note ?? 'post_flags_resolved',
      diff: { flagOutcome: data.outcome, flagsResolved: result.count, result: 'success' },
      metadata: { postType: post.type },
    });

    return { postId, outcome: data.outcome, resolved: result.count };
  }

  // ── Takedown and appeals ──────────────────────

  // PATCH /posts/:id/takedown
  async takedown(admin: CurrentUserDto, postId: string, data: TakedownPostDto) {
    const post = await this.findOne(postId);

    this.assertTransitionAllowed(
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
      this.emitBlockedAttempt({
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

    this.emitAudit({
      userId: admin.id,
      targetUserId: this.auditTarget(post, admin.id),
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.POST_TAKEN_DOWN,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
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
    const { page, limit, skip, take } = this.pageArgs(query);
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

    return { items, ...this.pageMeta(total, page, limit) };
  }

  // PATCH /posts/:id/appeals/:appealId/decide
  async decideAppeal(
    admin: CurrentUserDto,
    postId: string,
    appealId: string,
    data: DecidePostAppealDto,
  ) {
    const post = await this.findOne(postId);

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

    this.emitAudit({
      userId: admin.id,
      targetUserId: this.auditTarget(post, admin.id),
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.POST_APPEAL_DECIDED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postLabel(post),
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

  // ── Statistics ────────────────────────────────

  // Start of the day, ISO week (Monday) or month in UTC, as a stable bucket key.
  private bucketKey(date: Date, bucket: 'day' | 'week' | 'month'): string {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    if (bucket === 'month') d.setUTCDate(1);
    if (bucket === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }

  // GET /posts/stats/timeline
  async getStatsTimeline(query: PostTimelineQueryDto) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (from >= to) {
      throw new BadRequestException('timeline_from_must_be_before_to');
    }
    const bucket = query.bucket ?? 'day';

    const posts = await this.prisma.post.findMany({
      where: {
        createdAt: { gte: from, lt: to },
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.authorId ? { userId: query.authorId } : {}),
      },
      select: { createdAt: true },
    });

    const counts = new Map<string, number>();
    for (const post of posts) {
      const key = this.bucketKey(post.createdAt, bucket);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const points = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    return { from: query.from, to: query.to, bucket, total: posts.length, points };
  }

  // GET /posts/stats/moderation
  async getModerationStats() {
    const [openFlags, flaggedPosts, openAppeals, upheld, overturned, takedowns, decided] =
      await this.prisma.$transaction([
        this.prisma.postFlag.count({ where: { status: FLAG_OPEN } }),
        this.prisma.postFlag.groupBy({
          by: ['postId'],
          where: { status: FLAG_OPEN },
          orderBy: { postId: 'asc' },
        }),
        this.prisma.postAppeal.count({ where: { status: APPEAL_OPEN } }),
        this.prisma.postAppeal.count({ where: { status: 'UPHELD' } }),
        this.prisma.postAppeal.count({ where: { status: 'OVERTURNED' } }),
        this.prisma.post.count({ where: { takedownAt: { not: null } } }),
        this.prisma.postAppeal.findMany({
          where: { decidedAt: { not: null } },
          orderBy: { decidedAt: 'desc' },
          take: 500,
          select: { createdAt: true, decidedAt: true },
        }),
      ]);

    const totalHours = decided.reduce(
      (sum, a) => sum + ((a.decidedAt?.getTime() ?? a.createdAt.getTime()) - a.createdAt.getTime()),
      0,
    );
    const avgAppealTurnaroundHours = decided.length
      ? Math.round((totalHours / decided.length / 3_600_000) * 10) / 10
      : null;

    return {
      openFlags,
      flaggedPostsWithOpenFlags: flaggedPosts.length,
      openAppeals,
      appealsUpheld: upheld,
      appealsOverturned: overturned,
      takedowns,
      avgAppealTurnaroundHours,
    };
  }
}

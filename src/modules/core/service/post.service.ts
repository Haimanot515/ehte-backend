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

// Only these two transitions actually flip a post's public
// visibility (PostStatus.PUBLISHED is the only status
// findPublishedPost/findPublishedPosts ever serve). Every other
// transition (DRAFT<->PENDING, PENDING->APPROVED/REJECTED/
// CHANGES_REQUESTED, etc.) never touches a cached public row, so
// approve()/reject()/requestChanges() intentionally do NOT
// invalidate the cache — mirrors the reasoning in
// MissingPersonService, just split across Post's separate
// publish()/unpublish()/updateStatus() methods instead of one
// funnel method.
const STATUSES_THAT_CHANGE_PUBLIC_VISIBILITY: PostStatus[] = [
  PostStatus.PUBLISHED,
  PostStatus.UNPUBLISHED,
];

// Fields that must never leave the process on a PUBLIC route.
// userId would deanonymize the poster (item #7); reviewNote,
// claim and dual-confirmation fields are internal review
// metadata that means nothing to the public and shouldn't leak
// admin identities either.
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

  // ─────────────────────────────────────────────
  // BANNED / SUSPENDED OWNER HANDLING (item #6)
  //
  // ASSUMPTION: the user module emits 'user.suspended' /
  // 'user.deleted' events with a { userId } payload — adjust
  // the event names/payload shape to whatever your UserService
  // actually emits. Hard deletes are already handled for you by
  // the `onDelete: Cascade` on Post.user, so the deleted-user
  // handler here is a no-op safety net in case cascade behavior
  // ever changes; the real work is for suspension, where the
  // user row (and their posts) still exist.
  //
  // On suspension: any PENDING post is withdrawn back to DRAFT
  // (bypassing the normal transition map on purpose — this is a
  // system safety action, not a user or admin one) so it drops out
  // of the admin review queue, and every non-terminal post owned
  // by the user is timestamped via ownerSuspendedAt so admin
  // tooling can filter/flag them.
  //
  // No cache touch needed: PENDING/DRAFT/CHANGES_REQUESTED are
  // never public statuses, so nothing this handler moves a post
  // into or out of can be sitting in the published-post cache.
  //
  // FIX (audit coverage): this is a bulk system action about the
  // user, not about one specific post. userId (the actor) is no
  // longer set to the suspended user, since there is no human
  // actor here; the affected user is now targetUserId. entity is
  // 'User' with the user's id as entityId, instead of a synthetic
  // 'user:<id>' Post entityId. The cause moved out of diff into
  // the top-level reason column, and the number of posts touched
  // is recorded in metadata.
  // ─────────────────────────────────────────────
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
      // ASSUMPTION: resolveActorType only knows about role-bearing
      // actors; cast until AuditEventPayload's actorType union is
      // extended with a SYSTEM variant.
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

  // ─────────────────────────────────────────────
  // PUBLIC — GET MEDIA DOWNLOAD URL
  // GET /posts/published/:id/media?key=...
  //
  // Same visibility gate as findPublishedPost() (status must be
  // PUBLISHED), PLUS the key must be one of the keys
  // getPubliclyVisibleMediaKeys() would actually expose — so a
  // child-involving post's media stays unreachable here, even
  // though the key technically still exists in the DB row.
  //
  // Deliberately NOT read through the Post cache: it's a narrow,
  // per-key lookup rather than the whole public row, and MinIO
  // presigned URLs are already short-lived and cheap to mint, so
  // there's nothing worth caching here.
  //
  // NOTE: this module's dashboard-statistics getStats() was a
  // duplicate of the one further down this file (the branch that
  // added it here never got wired to a surviving route — see
  // getStats() below, which is what the /posts/stats route
  // actually documents) and has been dropped to avoid a duplicate
  // method name.
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
  //
  // FIX (item #1): a per-user cooldown between post creations
  // (CONTENT_CREATE_RATE_LIMIT_WINDOW_SECONDS — shared across
  // Reports, Posts, Missing Person requests, etc., since a
  // double-tap or scripted flood is the same risk everywhere;
  // set POST_CREATE_RATE_LIMIT_WINDOW_SECONDS to override just
  // this module if it ever needs a different value) blocks
  // rapid-fire spam creation. The complementary "max N posts
  // waiting for review" limit lives in submitMyPost(), since
  // that's the step that actually puts a post in front of admins.
  //
  // FIX (item #5): an optional Idempotency-Key (sent as a header
  // by the controller) lets a client safely retry a create call
  // after a dropped response — a repeat with the same key returns
  // the original post instead of creating a duplicate.
  //
  // FIX (item #13): attachment counts are checked BEFORE any
  // MinIO round trips; the total attached size is computed from
  // validateMediaFilesExist()'s returned sizes and persisted as
  // mediaTotalBytes so future updates don't need to re-stat
  // already-attached files just to know the running total.
  //
  // A freshly created post is always DRAFT, a non-public status,
  // so there's nothing to invalidate in the Post cache here.
  //
  // FIX (audit coverage): the success row now carries entityLabel
  // and metadata (post type, attachment count and size, whether the
  // request was sent with an idempotency key).
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — CREATE OFFICIAL POST
  //
  // An involvesChild=true post can only reach APPROVED
  // via this endpoint if the caller explicitly passes
  // childSafetyConfirmed: true, exactly like approve()
  // requires. The PENDING path (publishImmediately=false)
  // doesn't require it here, since that path still goes
  // through approve()'s own gate later.
  //
  // NOTE: the dual-control rule (#16) intentionally does
  // NOT apply here — see the comment on AdminCreatePostDto.
  //
  // This endpoint only ever lands a post on DRAFT-equivalent
  // PENDING or on APPROVED — never PUBLISHED (an admin still has
  // to call publish() separately) — so, same as create(), there's
  // no public row to invalidate here.
  //
  // FIX (item #13): same attachment-count/total-size guard
  // as create(), for consistency — official posts shouldn't
  // be exempt just because they're admin-authored.
  //
  // FIX (audit coverage): the success row now carries entityLabel
  // and metadata (post type, publishImmediately, attachment count
  // and size).
  //
  // NOTE (audit coverage): the child_safety_confirmation_required
  // guard below throws before any Post row exists, so there is no
  // entityId to attach a DENIED/FAILURE row to. Left un-audited on
  // purpose; if AuditEventPayload allows a null entityId, an audit
  // row could be added there.
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // UPDATE MY POST
  // Allowed only while DRAFT or CHANGES_REQUESTED.
  //
  // Media handling: for each media field present in the
  // request, diffs against what's currently on the row.
  // Newly-added filepaths are validated against MinIO
  // before the write; filepaths dropped from the new
  // array are deleted from MinIO after the write commits.
  //
  // OWNER_EDITABLE_STATUSES is DRAFT/CHANGES_REQUESTED only —
  // neither is ever public (findPublishedPost/findPublishedPosts
  // require PUBLISHED), so nothing this method touches can
  // already be sitting in the Post cache — no invalidation
  // needed here, same reasoning as MissingPersonService.update().
  //
  // FIX (item #13): attachment counts are checked against the
  // fully-merged post-update media shape (existing fields not
  // present in the request are carried over unchanged) before
  // any MinIO calls, and mediaTotalBytes is recomputed from the
  // previous total plus/minus the added/removed files' sizes.
  //
  // FIX (audit coverage): the success row now carries entityLabel
  // (the post's current title) and metadata (how many media files
  // were added/removed and the new running total).
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

  // ─────────────────────────────────────────────
  // SUBMIT MY POST
  // Moves DRAFT or CHANGES_REQUESTED → PENDING. Not a public
  // status either direction, so no cache touch needed.
  //
  // FIX (item #1): enforces a max-pending-per-user cap —
  // a user can only have so many posts sitting in the
  // admin review queue at once. This is where the limit
  // is checked, since submit is the step that actually
  // adds a post to that queue. Uses the shared
  // CONTENT_MAX_PENDING_PER_USER default (same rule applies
  // to Reports, Missing Person requests, etc.); set
  // POST_MAX_PENDING_PER_USER to give Posts its own limit.
  //
  // FIX (audit coverage): the success row now carries entityLabel.
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

  // ─────────────────────────────────────────────
  // CANCEL / WITHDRAW MY POST
  // PENDING → DRAFT. Neither status is ever public, so no
  // cache touch needed.
  //
  // FIX (audit coverage): 'withdrawn_by_owner' moved out of diff
  // into the top-level reason column, and the row now carries
  // entityLabel.
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

  // ─────────────────────────────────────────────
  // DELETE MY POST
  // Scoped to DRAFT only — never a public status, so no cache
  // touch needed here either. Deletes the DB row, then removes
  // every attached media object from MinIO — once the row
  // referencing them is gone, an orphaned object in the bucket
  // serves no purpose.
  //
  // FIX (audit coverage): the row is gone after this call, so the
  // audit entry is the only place a reader can still see WHICH post
  // was deleted. entityLabel (the title as it was) and metadata
  // (post type, number of media files purged) preserve that.
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

  // ─────────────────────────────────────────────
  // PUBLIC — GET PUBLISHED POSTS
  //
  // Read-through cache, same shape as
  // MissingPersonService.findAll()/findAllUncached(): the cache
  // key is derived from the query params, and the DB path only
  // runs on a miss.
  //
  // FIX (item #7): responses are now mapped through
  // toPublicPost() so userId (and other internal-only
  // fields) never reach an anonymous caller.
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // PUBLIC — GET ONE PUBLISHED POST
  //
  // Read-through cache, same shape as
  // MissingPersonService.findOne(): serve the cached public row
  // on a hit; on a miss, re-derive it from Prisma, cache it, and
  // return it. Cached under the already-public shape (toPublicPost
  // output), so a cache hit never risks re-leaking an internal
  // field — there's nothing internal left in the cached value to
  // leak.
  //
  // FIX (item #7): same public-field stripping as
  // findPublishedPosts().
  // ─────────────────────────────────────────────
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

  // Admin dashboard stats: totals by status and by post type.
  // (This is the version the surviving GET /posts/stats route
  // documents — a second, richer getStats() had been added
  // earlier in this file by mistake, duplicating this method
  // name; it's been removed rather than this one, since this is
  // the one the controller's ApiOperation summary and the actual
  // wired-up route both already agreed on.)
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

  // ─────────────────────────────────────────────
  // ADMIN — BULK APPROVE / REJECT
  // PATCH /posts/bulk/approve, PATCH /posts/bulk/reject
  // (item #20)
  //
  // Any post with involvesChild = true is deliberately
  // excluded from bulk handling — it always requires
  // individual review through the normal approve()/
  // reject() endpoints and their dual-control gate (#16).
  // Each id's outcome is reported independently so a
  // failure on one post never blocks the rest.
  //
  // Neither approve() nor reject() ever reaches PUBLISHED
  // (see STATUSES_THAT_CHANGE_PUBLIC_VISIBILITY above), so
  // bulk-approving/rejecting never needs a cache invalidation
  // either — same as the single-post calls they wrap.
  //
  // FIX (audit coverage): skipping a child-involving post is a
  // blocked attempt, so it now writes a DENIED row (severity INFO,
  // since it is an expected, by-design skip rather than a
  // suspicious one) instead of leaving no trace. Every audit row
  // produced through the bulk path is tagged metadata.bulk = true
  // so a reader can tell a bulk action from an individual one.
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  //
  // Validates the transition via the shared map,
  // requires childSafetyConfirmed when moving an
  // involvesChild post to APPROVED or PUBLISHED
  // (now via the two-distinct-admins dual-control
  // gate, item #16), enforces the claim guard (#17),
  // and uses a conditional update to avoid racing
  // another concurrent transition.
  //
  // This is a generic transition endpoint, so — unlike
  // approve()/reject()/requestChanges(), which only ever move a
  // post between non-public statuses — it CAN be the thing that
  // takes a post into or out of PUBLISHED (APPROVED->PUBLISHED,
  // PUBLISHED->UNPUBLISHED, UNPUBLISHED->PUBLISHED are all legal
  // here per ALLOWED_STATUS_TRANSITIONS). Invalidate whenever the
  // destination status is one that changes public visibility.
  //
  // FIX (audit coverage): invalid transitions, claim denials,
  // child-safety gate rejections and lost-race conflicts now each
  // write a FAILURE/DENIED row (severity WARNING) before throwing.
  // The success and pending-confirmation rows now carry
  // targetUserId (the post owner, when different from the acting
  // admin), entityLabel, and metadata (post type, whether the post
  // involves a child).
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — APPROVE POST
  //
  // FIX (item #16): childSafetyConfirmed from a single
  // admin now only records that admin's own confirmation
  // the first time; the status only actually flips to
  // APPROVED once a second, different admin also confirms.
  // FIX (item #17): blocked if claimed by a different admin.
  //
  // APPROVED is not a public status (only PUBLISHED is), so
  // this never touches the Post cache — the post still needs an
  // explicit publish() before it's visible on GET /posts/published.
  //
  // FIX (notifications): POST_APPROVED now includes title,
  // matching PostRejectedEvent's shape below — previously
  // omitted here, so an approved post's notification always
  // fell back to the generic "Your post has been approved."
  // even when the post had a title, unlike reject().
  //
  // FIX (audit coverage): every blocked path (invalid transition,
  // claim denial, child-safety gate, lost race) now writes an
  // audit row before throwing. Success row carries targetUserId,
  // entityLabel and metadata. The optional `options.bulk` flag
  // (set only by bulkApprove) is recorded as metadata.bulk on
  // every row this call produces.
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — REQUEST CHANGES
  //
  // The message is persisted on the Post row
  // (reviewNote), not just the audit log and
  // notification payload, so GET /posts/me/:id shows
  // the owner why without relying on the notification.
  //
  // CHANGES_REQUESTED is not a public status, so no cache
  // invalidation is needed here.
  //
  // FIX (item #17): blocked if claimed by a different
  // admin; claim is released once changes are requested
  // since the case is handed back to the owner.
  //
  // NOTE: requires a `reviewNote String?` column on
  // the Post model. See the schema file.
  //
  // FIX (audit coverage): the admin's message moved out of diff
  // into the top-level reason column. Blocked paths (invalid
  // transition, claim denial, lost race) now write a
  // FAILURE/DENIED row before throwing. Success row carries
  // targetUserId and entityLabel.
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — PUBLISH POST
  //
  // The one place (besides updateStatus()) that puts a post INTO
  // PUBLISHED — invalidate on success so a stale cached miss
  // (or, if pre-warmed some other way, a stale cached absence)
  // never outlives the row actually going public.
  //
  // FIX (audit coverage): an invalid transition or a lost race
  // now writes a FAILURE row before throwing. Success row carries
  // targetUserId, entityLabel and metadata. (No claim check here
  // by design, see CLAIM HELPERS above.)
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — REJECT POST
  //
  // A PUBLISHED post can't be rejected directly; it
  // must go through unpublish() first, matching the
  // real-world workflow (take something down before
  // formally rejecting it). Reason is persisted on
  // the Post row (reviewNote).
  //
  // Because of that ordering, reject() only ever runs against a
  // PENDING or APPROVED post and only ever lands on REJECTED —
  // never PUBLISHED — so it never needs to touch the cache.
  //
  // FIX (item #17): blocked if claimed by a different
  // admin; claim is released once the post is rejected.
  //
  // FIX (item #21): after a successful rejection, checks
  // whether the owner has crossed the auto-flag threshold
  // for repeated rejections and, if so, writes a
  // USER_AUTO_FLAGGED audit entry for admin review.
  //
  // FIX (audit coverage): the rejection reason moved out of diff
  // into the top-level reason column. Blocked paths (invalid
  // transition, claim denial, lost race) now write a
  // FAILURE/DENIED row before throwing. Success row carries
  // targetUserId, entityLabel and metadata. The optional
  // `options.bulk` flag (set only by bulkReject) is recorded as
  // metadata.bulk on every row this call produces.
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — UNPUBLISH POST
  // Notifies the post owner, matching
  // approve/reject/request-changes.
  //
  // The one place (besides updateStatus()) that takes a post OUT
  // of PUBLISHED — invalidate on success so a cached public row
  // doesn't keep serving after it's been pulled.
  //
  // FIX (audit coverage): an invalid transition or a lost race
  // now writes a FAILURE row before throwing. Success row carries
  // targetUserId, entityLabel and metadata.
  // ─────────────────────────────────────────────
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

  // ═════════════════════════════════════════════
  // NEW — everything below backs the new controller routes.
  // Assumes Prisma models PostReadState, PostFlag, PostAppeal and Post.takedown* fields.
  // ═════════════════════════════════════════════

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

    return { items: sorted.slice(skip, skip + limit), ...this.pageMeta(sorted.length, page, limit) };
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

    this.assertTransitionAllowed(admin, post, PostStatus.UNPUBLISHED, AuditEventEnum.POST_TAKEN_DOWN);
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
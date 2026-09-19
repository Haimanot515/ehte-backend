import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditOutcome, AuditSeverity, PostStatus, PostType, Prisma } from '@prisma/client';

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

// Minimal shape every audit call site needs from a post row to
// build entityId / entityLabel / targetUserId. A full Prisma Post
// row satisfies this.
type PostAuditRef = {
  id: string;
  userId: string;
  title: string | null;
  type: PostType;
};

// Posts can be untitled and titles are free text, so the label
// written to the audit row is capped to keep it list-friendly.
const ENTITY_LABEL_MAX_LENGTH = 120;

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
] as const;

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

  // -----------------------------------------------------------
  // AUDIT HELPERS
  //
  // FIX (audit coverage): shared building blocks so every call
  // site labels the entity the same way, attributes moderation
  // actions to the affected user, and records blocked attempts
  // (denied / failed) instead of only the success path.
  //
  // ASSUMPTION: AuditEventPayload.metadata accepts a plain JSON
  // object, and AuditSeverity has an INFO member (it is the
  // schema default). Adjust the Prisma.InputJsonObject typing
  // below if metadata is typed differently.
  // -----------------------------------------------------------

  // Human-readable label for the audit row. Falls back to the post
  // type when the post has no title, so the row is never blank.
  private postLabel(post: Pick<PostAuditRef, 'title' | 'type'>): string {
    const raw = post.title?.trim() || `Untitled ${post.type} post`;
    return raw.length > ENTITY_LABEL_MAX_LENGTH
      ? `${raw.slice(0, ENTITY_LABEL_MAX_LENGTH - 3)}...`
      : raw;
  }

  // The user an action is ABOUT, when that is someone other than
  // the actor. Undefined when an admin acts on their own post
  // (official posts), since actor and target would be identical.
  private auditTarget(post: Pick<PostAuditRef, 'userId'>, actorUserId: string): string | undefined {
    return post.userId !== actorUserId ? post.userId : undefined;
  }

  // Writes the audit row for an attempt that was blocked, before the
  // caller throws. DENIED = not allowed to do this (permission or
  // workflow control); FAILURE = allowed in principle but the request
  // could not be completed (invalid transition, lost race).
  // The machine-readable cause goes in the top-level reason column.
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

  // Shared by updateStatus() and approve(): the first admin's child
  // safety confirmation was recorded but the status did not move.
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

  // FIX (audit coverage): moved from a module-level function into
  // the class so an invalid transition can write an audit row
  // (outcome: FAILURE, severity: WARNING) before throwing. Still
  // reads the single ALLOWED_STATUS_TRANSITIONS map above.
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

  // -----------------------------------------------------------
  // MEDIA HELPERS
  //
  // Post stores media as plain filepath strings in
  // typed arrays (photo/video/audio/pdf/document/other)
  // rather than a relational Media table. These helpers
  // keep every read/write of that shape in one place.
  // -----------------------------------------------------------

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
  // FIX (item #3, partial): also rejects files that are too large or
  // of a disallowed content-type.
  //
  // FIX (item #13): now returns each validated file's size, so
  // callers can maintain a running mediaTotalBytes without
  // re-statting objects that were just statted a moment ago.
  //
  // NOTE (item #3, virus scanning): out of scope here — scanning
  // needs to happen once, at upload time, in the media-upload
  // module (e.g. pipe the buffer through ClamAV/clamscan before
  // MinioService ever stores it). Re-scanning on every post
  // create/update would be redundant and slow.
  //
  // NOTE (item #4, EXIF/GPS stripping): deliberately out of scope
  // per product decision — also belongs in the media-upload module
  // if it's ever added, applied to image bytes before they're
  // written to MinIO. Post only ever sees filepaths of objects that
  // already exist, so it has no image bytes left to strip.
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

  // FIX (item #13): per-field attachment counts. photo/video get
  // their own configurable caps; audio+pdf+document+other share one
  // combined cap since none of them individually needs its own
  // limit yet. Checked BEFORE any MinIO calls so a request with too
  // many attachments fails fast without wasting stat() round trips.
  //
  // Reads the shared CONTENT_* default (same pattern as
  // enforceCreateRateLimit/findStalePending above) since these
  // limits apply the same way to Reports, Missing Person requests,
  // Victim Profiles, etc. — not just Posts. An optional POST_*
  // override lets Posts diverge later without touching this file
  // or any other module's copy of the same logic.
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

  // FIX (item #13): total attached-media size cap per post, checked
  // against the running mediaTotalBytes column rather than re-summing
  // every attached file on every write. Shared CONTENT_* default,
  // same reasoning as assertAttachmentCounts above.
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

  // Best-effort delete against MinIO. A file that's already gone
  // (or MinIO briefly unreachable) must never block the DB write
  // that triggered the cleanup — failures are swallowed per-file
  // via allSettled rather than surfaced to the caller.
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

  // FIX (item #7): strips every field a public reader has no
  // business seeing — most importantly userId, which the raw
  // Prisma row otherwise leaks straight through on both
  // GET /posts/published and GET /posts/published/:id, completely
  // defeating anonymous posting.
  private toPublicPost<T extends Record<string, unknown>>(
    post: T,
  ): Omit<T, (typeof PUBLIC_POST_OMIT_FIELDS)[number]> {
    const copy: Record<string, unknown> = { ...post };
    for (const field of PUBLIC_POST_OMIT_FIELDS) {
      delete copy[field];
    }
    return copy as Omit<T, (typeof PUBLIC_POST_OMIT_FIELDS)[number]>;
  }

  // ─────────────────────────────────────────────
  // CLAIM HELPERS (item #17)
  //
  // Lets one admin "claim" a case so a second admin
  // doesn't start reviewing it in parallel. Enforced
  // on every review-decision write; NOT enforced on
  // read endpoints or on publish/unpublish, which are
  // routine operational actions rather than case review.
  //
  // FIX (audit coverage): a denied claim check now writes an
  // audit row (outcome: DENIED, severity: WARNING) before
  // throwing, recording which admin currently holds the claim.
  // Callers pass the specific action being attempted so the
  // DENIED row records what was actually blocked.
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // CHILD-SAFETY DUAL CONTROL (item #16)
  //
  // A single admin ticking childSafetyConfirmed is no
  // longer enough to move an involvesChild post to
  // APPROVED/PUBLISHED. The first admin to confirm only
  // has their confirmation recorded; a second, DIFFERENT
  // admin must confirm again before the transition
  // actually goes through.
  //
  // FIX (audit coverage): both rejection paths now write an
  // audit row before throwing. A missing confirmation is a
  // FAILURE; the same admin trying to be their own second
  // confirmer is a DENIED (dual-control violation). Both are
  // severity WARNING. The method now takes the acting user
  // (not just their id) and the action being attempted so the
  // rows can be attributed correctly.
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // AUTOMATIC FLAGS (item #21)
  //
  // Flag ≠ reject. This only writes an audit-log entry an admin
  // can see against the user; it never blocks or auto-rejects
  // anything, and it never changes any Post's status.
  //
  // ASSUMPTION: AuditEventEnum needs a new USER_AUTO_FLAGGED
  // member — add it alongside POST_CREATED/POST_UPDATED/etc. in
  // src/common/enums/shared/audit-events.enum.ts.
  //
  // FIX (audit coverage): userId -> targetUserId (this row is about
  // the flagged user; there is no human actor). The cause moved out
  // of diff into the top-level reason column, and the configured
  // threshold is recorded in metadata so a reader can tell what
  // rule fired without looking up config.
  // ─────────────────────────────────────────────

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
        actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
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
  // FIX (audit coverage): the success row now carries entityLabel
  // and metadata (post type, attachment count and size, whether the
  // request was sent with an idempotency key).
  // ─────────────────────────────────────────────

  private async enforceCreateRateLimit(userId: string): Promise<void> {
    // Module-specific override, falling back to the shared
    // CONTENT_* default used by every submission type.
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
        // Safe replay of a duplicate submission (double-tap, retried
        // request after a flaky connection) — return the original
        // instead of creating a second post.
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

    // Stat removed files before they're deleted, purely to back out
    // their bytes from the running total — a stat failure here
    // (already gone, MinIO hiccup) just means we can't credit that
    // byte count back, so treat it as 0 rather than blocking the
    // update.
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

    // Only after the DB write commits — deleting first and having
    // the write fail would strand the post pointing at nothing.
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
  // Moves DRAFT or CHANGES_REQUESTED → PENDING.
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
  // PENDING → DRAFT.
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
  // Scoped to DRAFT only. Deletes the DB row, then
  // removes every attached media object from MinIO —
  // once the row referencing them is gone, an orphaned
  // object in the bucket serves no purpose.
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
  // FIX (item #7): responses are now mapped through
  // toPublicPost() so userId (and other internal-only
  // fields) never reach an anonymous caller.
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
  // FIX (item #7): same public-field stripping as
  // findPublishedPosts().
  // ─────────────────────────────────────────────

  async findPublishedPost(postId: string) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, status: PostStatus.PUBLISHED },
    });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    return this.toPublicPost(post);
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
  // ADMIN — STALE / UNREVIEWED-TOO-LONG POSTS
  // GET /posts/stale
  // (item #15)
  //
  // Flags PENDING posts older than the shared
  // CONTENT_STALE_PENDING_HOURS default (falls back from an
  // optional POST_STALE_PENDING_HOURS override) so admins can
  // prioritize "forgotten" cases. Purely informational —
  // nothing here changes status or ownership.
  //
  // NOTE: Reports and Missing Person requests are far more
  // time-sensitive than a Post — if that turns out to matter in
  // practice, just set e.g. MISSING_PERSON_STALE_PENDING_HOURS
  // to a smaller number in that module without touching this one.
  // ─────────────────────────────────────────────

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
  // ADMIN — PER-POST HISTORY / TIMELINE
  // GET /posts/:id/history
  // (item #18)
  //
  // ASSUMPTION: assumes an `auditLog` Prisma model
  // populated by a listener subscribed to the same
  // events emitAudit()/AuditEventPayload already fire
  // throughout this service (entity/entityId/action/
  // userId/actorType/diff/createdAt). MiscModule already
  // owns "Audit Logs" + "Audit Event Listeners", so this
  // is likely already in place — adjust the model and
  // field names below if your schema differs.
  // ─────────────────────────────────────────────

  async getHistory(postId: string) {
    await this.findOne(postId); // 404s if the post doesn't exist

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
}
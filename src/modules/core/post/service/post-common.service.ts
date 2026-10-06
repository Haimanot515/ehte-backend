import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditOutcome, AuditSeverity, PostStatus, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';
import {
  MEDIA_FIELD_NAMES,
  MediaBearing,
  MediaBearingDto,
  PostAuditRef,
  ENTITY_LABEL_MAX_LENGTH,
  ALLOWED_STATUS_TRANSITIONS,
} from './post.constants';

@Injectable()
export class PostCommonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // Falls back to the post type when there's no title, so the row is never blank.
  postLabel(post: Pick<PostAuditRef, 'title' | 'type'>): string {
    const raw = post.title?.trim() || `Untitled ${post.type} post`;
    return raw.length > ENTITY_LABEL_MAX_LENGTH
      ? `${raw.slice(0, ENTITY_LABEL_MAX_LENGTH - 3)}...`
      : raw;
  }

  auditTarget(post: Pick<PostAuditRef, 'userId'>, actorUserId: string): string | undefined {
    return post.userId !== actorUserId ? post.userId : undefined;
  }

  // Writes the audit row for a blocked attempt before the caller throws.
  emitBlockedAttempt(args: {
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

  // Writes a FAILURE audit row on an invalid transition before throwing.
  assertTransitionAllowed(
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

  collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  collectMediaFieldsFromDto(dto: MediaBearingDto): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => dto[field] ?? []);
  }

  async findOne(postId: string) {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    return post;
  }

  pageArgs(query: { page?: number; limit?: number }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return { page, limit, skip: (page - 1) * limit, take: limit };
  }

  pageMeta(total: number, page: number, limit: number) {
    return { total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}

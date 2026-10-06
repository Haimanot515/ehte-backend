import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditOutcome,
  AuditSeverity,
  MissingPerson,
  MissingPersonStatus,
  MissingPersonType,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import {
  MEDIA_FIELD_NAMES,
  MediaBearing,
  MediaBearingDto,
  MissingPersonAuditRef,
  PageQuery,
  PUBLIC_SELECT,
} from './missing-person.constants';

@Injectable()
export class MissingPersonCommonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // CHILD cases get a redacted label in audit rows.
  caseLabel(missingPerson: Pick<MissingPerson, 'id' | 'name' | 'personType'>): string | undefined {
    if (missingPerson.personType === MissingPersonType.CHILD) {
      return `Child case ${missingPerson.id.slice(0, 8)}`;
    }
    return missingPerson.name ?? undefined;
  }

  targetUserFor(
    actor: CurrentUserDto,
    missingPerson: Pick<MissingPerson, 'userId'>,
  ): { targetUserId?: string } {
    const ownerId = missingPerson.userId;
    return ownerId && ownerId !== actor.id ? { targetUserId: ownerId } : {};
  }

  emitCaseFailure(
    actor: CurrentUserDto,
    action: AuditEventEnum,
    missingPerson: MissingPersonAuditRef,
    reason: string,
    opts: {
      outcome?: AuditOutcome;
      targetUserId?: string;
      diff?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    const outcome = opts.outcome ?? AuditOutcome.FAILURE;

    this.emitAudit({
      userId: actor.id,
      ...(opts.targetUserId ? { targetUserId: opts.targetUserId } : {}),
      actorType: resolveActorType(actor.roles ?? []),
      action,
      outcome,
      severity: AuditSeverity.WARNING,
      entity: 'MissingPerson',
      entityId: missingPerson.id,
      entityLabel: this.caseLabel(missingPerson),
      diff: {
        result: outcome === AuditOutcome.DENIED ? 'denied' : 'failure',
        reason,
        ...(opts.diff ?? {}),
      },
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
  }

  collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  collectMediaFieldsFromDto(dto: MediaBearingDto): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => dto[field] ?? []);
  }

  // Checks existence, size and MIME type; returns sizes for the running total.
  async validateMediaFilesExist(
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

  assertAttachmentCounts(media: MediaBearing): void {
    const maxPhotos = Number(
      this.configService.get<string>('MISSING_PERSON_MAX_PHOTOS') ??
        this.configService.get<string>('CONTENT_MAX_PHOTOS') ??
        5,
    );
    const maxVideos = Number(
      this.configService.get<string>('MISSING_PERSON_MAX_VIDEOS') ??
        this.configService.get<string>('CONTENT_MAX_VIDEOS') ??
        1,
    );
    const maxOther = Number(
      this.configService.get<string>('MISSING_PERSON_MAX_OTHER_FILES') ??
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

  assertTotalBytes(totalBytes: number): void {
    const maxTotalBytes = Number(
      this.configService.get<string>('MISSING_PERSON_MAX_TOTAL_UPLOAD_BYTES') ??
        this.configService.get<string>('CONTENT_MAX_TOTAL_UPLOAD_BYTES') ??
        52_428_800,
    );
    if (totalBytes > maxTotalBytes) {
      throw new BadRequestException(`upload_total_size_exceeded:max_${maxTotalBytes}`);
    }
  }

  // Best-effort; failures never block the DB write.
  async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  // Hides reward amount and details publicly until an admin approves.
  maskUnapprovedReward<
    T extends {
      rewardApproved: boolean;
      rewardAmount: number | null;
      rewardDetails: string | null;
    },
  >(record: T): T {
    if (record.rewardApproved) return record;
    return { ...record, rewardAmount: null, rewardDetails: null };
  }

  // Blocks status changes on a case claimed by another admin.
  assertNotClaimedByOther(
    actor: CurrentUserDto,
    missingPerson: MissingPersonAuditRef & { claimedByUserId: string | null },
    action: AuditEventEnum,
  ): void {
    if (missingPerson.claimedByUserId && missingPerson.claimedByUserId !== actor.id) {
      this.emitCaseFailure(actor, action, missingPerson, 'claimed_by_another_admin', {
        outcome: AuditOutcome.DENIED,
        metadata: { claimedByUserId: missingPerson.claimedByUserId },
      });
      throw new ForbiddenException('missing_person_claimed_by_another_admin');
    }
  }

  async isRewardFunded(missingPersonId: string): Promise<boolean> {
    const count = await this.prisma.payment.count({
      where: { missingPersonId, type: 'MISSING_PERSON_REWARD', status: 'PAID' },
    });
    return count > 0;
  }

  pageArgs(query: PageQuery): { page: number; limit: number; skip: number } {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return { page, limit, skip: (page - 1) * limit };
  }

  pageMeta(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  auditOp(
    actor: CurrentUserDto,
    missingPerson: MissingPersonAuditRef,
    operation: string,
    diff: Record<string, unknown> = {},
    opts: {
      action?: AuditEventEnum;
      severity?: AuditSeverity;
      reason?: string | null;
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    this.emitAudit({
      userId: actor.id,
      ...this.targetUserFor(actor, missingPerson),
      actorType: resolveActorType(actor.roles ?? []),
      action: opts.action ?? AuditEventEnum.MISSING_PERSON_UPDATED,
      ...(opts.severity ? { severity: opts.severity } : {}),
      entity: 'MissingPerson',
      entityId: missingPerson.id,
      entityLabel: this.caseLabel(missingPerson),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      diff: { ...diff, result: 'success' },
      metadata: { operation, ...(opts.metadata ?? {}) },
    });
  }

  // Same payload shape the existing update() uses for the owner notification.
  notifyOwner(missingPerson: Pick<MissingPerson, 'id' | 'userId' | 'status'>): void {
    if (!missingPerson.userId) return;
    this.eventEmitter.emit(NotificationEventEnum.MISSING_PERSON_UPDATED, {
      userId: missingPerson.userId,
      missingPersonId: missingPerson.id,
      status: missingPerson.status,
    });
  }

  async loadCase(id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!missingPerson) throw new NotFoundException('missing_person_not_found');
    return missingPerson;
  }

  async loadOwnCase(user: CurrentUserDto, id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!missingPerson || missingPerson.userId !== user.id || missingPerson.deletedAt) {
      throw new NotFoundException('missing_person_not_found');
    }
    return missingPerson;
  }

  async loadApprovedPublic(id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: PUBLIC_SELECT,
    });
    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }
    return this.maskUnapprovedReward(missingPerson);
  }

  async presignKeys(keys: string[]): Promise<Array<{ key: string; url: string | null }>> {
    return Promise.all(
      keys.map(async (key) => {
        try {
          return { key, url: await this.minioService.generatePresignedDownloadUrl(key) };
        } catch {
          return { key, url: null };
        }
      }),
    );
  }

  // The owner never sees internal review fields (claims, assignment, legal hold, takedown reason).
  toOwnerView(missingPerson: MissingPerson) {
    return {
      id: missingPerson.id,
      personType: missingPerson.personType,
      name: missingPerson.name,
      description: missingPerson.description,
      dateLastSeen: missingPerson.dateLastSeen,
      lastKnownArea: missingPerson.lastKnownArea,
      photo: missingPerson.photo,
      video: missingPerson.video,
      audio: missingPerson.audio,
      pdf: missingPerson.pdf,
      document: missingPerson.document,
      other: missingPerson.other,
      status: missingPerson.status,
      reviewNote: missingPerson.reviewNote,
      createdAt: missingPerson.createdAt,
      updatedAt: missingPerson.updatedAt,
      rewardOffered: missingPerson.rewardOffered,
      rewardApproved: missingPerson.rewardApproved,
      rewardAmount: missingPerson.rewardAmount,
      rewardDetails: missingPerson.rewardDetails,
      fundingStatus: missingPerson.fundingStatus,
      expiresAt: missingPerson.expiresAt,
      renewalCount: missingPerson.renewalCount,
      foundReportedAt: missingPerson.foundReportedAt,
      foundReportResolvedAt: missingPerson.foundReportResolvedAt,
      foundReportConfirmed: missingPerson.foundReportConfirmed,
      closedAt: missingPerson.closedAt,
      closureReason: missingPerson.closureReason,
      takedownAt: missingPerson.takedownAt,
    };
  }
}

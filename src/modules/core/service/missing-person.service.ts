import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { MissingPersonStatus } from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { MinioService } from 'src/common/minio/minio.service';

import {
  CreateMissingPersonDto,
  ListMissingPersonsAdminQueryDto,
  ListMissingPersonsQueryDto,
  UpdateMissingPersonDto,
} from '../dto/missing-person.dto';

// The six media-array fields shared by CreateMissingPersonDto/
// UpdateMissingPersonDto and the MissingPerson model itself.
// Mirrors PostService's MEDIA_FIELD_NAMES so every module stays in
// sync if a new media kind is ever added.
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

@Injectable()
export class MissingPersonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // A case is only user-editable while it's PENDING or while an
  // admin has asked for more information. Any other status is
  // effectively read-only for the submitter.
  // ─────────────────────────────────────────────

  private readonly EDITABLE_STATUSES: MissingPersonStatus[] = [
    MissingPersonStatus.PENDING,
    MissingPersonStatus.MORE_INFORMATION_REQUESTED,
  ];

  // ─────────────────────────────────────────────
  // Admin status workflow.
  //
  //   PENDING → UNDER_REVIEW
  //   UNDER_REVIEW → MORE_INFORMATION_REQUESTED | APPROVED | REJECTED
  //   MORE_INFORMATION_REQUESTED → (user edit moves it back to PENDING)
  //   APPROVED → FOUND
  //   REJECTED → (final)
  //   FOUND → (final)
  //
  // PENDING can only reach APPROVED/REJECTED by first passing
  // through UNDER_REVIEW.
  // ─────────────────────────────────────────────

  private readonly ALLOWED_TRANSITIONS: Record<MissingPersonStatus, MissingPersonStatus[]> = {
    [MissingPersonStatus.PENDING]: [MissingPersonStatus.UNDER_REVIEW],
    [MissingPersonStatus.UNDER_REVIEW]: [
      MissingPersonStatus.MORE_INFORMATION_REQUESTED,
      MissingPersonStatus.APPROVED,
      MissingPersonStatus.REJECTED,
    ],
    [MissingPersonStatus.MORE_INFORMATION_REQUESTED]: [],
    [MissingPersonStatus.APPROVED]: [MissingPersonStatus.FOUND],
    [MissingPersonStatus.REJECTED]: [],
    [MissingPersonStatus.FOUND]: [],
  };

  // ─────────────────────────────────────────────
  // Explicit public projection — nothing added to the Prisma
  // model (userId, reviewNote, reward review fields, etc.) can
  // leak through the public endpoints without a deliberate change
  // here.
  // ─────────────────────────────────────────────

  private readonly publicSelect = {
    id: true,
    personType: true,
    name: true,
    description: true,
    dateLastSeen: true,
    lastKnownArea: true,
    photo: true,
    video: true,
    audio: true,
    pdf: true,
    document: true,
    other: true,
    status: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  // AUDIT EMIT (typed helper): routes every audit emit through AuditEventPayload so a
  // missing field (actorType, entity, etc.) is caught at compile time, not silently dropped

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // ─────────────────────────────────────────────
  // MEDIA HELPERS
  //
  // Mirrors PostService's media helpers. MissingPerson stores media
  // as plain filepath strings in typed arrays (photo/video/audio/
  // pdf/document/other), same as Post, Report, and VictimProfile —
  // kept in one place so every read/write of that shape stays
  // consistent.
  // ─────────────────────────────────────────────

  private getMediaBucket(): string {
    return this.configService.get<string>('minio.bucketName') ?? 'ehte-media';
  }

  private collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  private collectMediaFieldsFromDto(dto: MediaBearingDto): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => dto[field] ?? []);
  }

  // Diffs each media field individually (not the flattened whole),
  // so a client resending the same array doesn't get treated as
  // "remove and re-add." Only fields present in the incoming DTO
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
  // in the media bucket, so a case can't reference an object that
  // was never uploaded (typo'd path, upload abandoned mid-flow,
  // filepath copied from an unrelated response, etc.). Only called
  // on filepaths that are new to the entity — already-attached
  // filepaths were validated when they were first added.
  private async validateMediaFilesExist(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;

    const bucket = this.getMediaBucket();
    const checks = await Promise.all(
      filepaths.map(async (filepath) => ({
        filepath,
        exists: await this.minioService.objectExists(bucket, filepath),
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
  private async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    const bucket = this.getMediaBucket();
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(bucket, fp)));
  }

  // ─────────────────────────────────────────────
  // CREATE
  //
  // Media filepaths are validated against MinIO before the case
  // is created, same as PostService.create.
  // ─────────────────────────────────────────────

  async create(user: CurrentUserDto, data: CreateMissingPersonDto) {
    await this.validateMediaFilesExist(this.collectMediaFieldsFromDto(data));

    const missingPerson = await this.prisma.missingPerson.create({
      data: {
        userId: user.id,

        personType: data.personType,

        name: data.name,
        description: data.description,

        dateLastSeen: new Date(data.dateLastSeen),

        lastKnownArea: data.lastKnownArea,

        photo: data.photo ?? [],
        video: data.video ?? [],
        audio: data.audio ?? [],
        pdf: data.pdf ?? [],
        document: data.document ?? [],
        other: data.other ?? [],

        status: MissingPersonStatus.PENDING,
      },
    });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_CREATED,
      entity: 'MissingPerson',
      entityId: missingPerson.id,
      diff: {
        personType: missingPerson.personType,
        status: missingPerson.status,
        result: 'success',
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.NEW_MISSING_PERSON_REQUEST, {
      userId: user.id,
      missingPersonId: missingPerson.id,
    });

    return missingPerson;
  }

  // ─────────────────────────────────────────────
  // FIND ONE (public — approved only, explicit select)
  // ─────────────────────────────────────────────

  async findOne(id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: this.publicSelect,
    });

    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }

    return missingPerson;
  }

  // ─────────────────────────────────────────────
  // FIND ALL PUBLIC (paginated, explicit select)
  // ─────────────────────────────────────────────

  async findAll(query: ListMissingPersonsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      status: MissingPersonStatus.APPROVED,
      ...(query.type !== undefined ? { personType: query.type } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        select: this.publicSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─────────────────────────────────────────────
  // FIND MINE (paginated)
  // ─────────────────────────────────────────────

  async findMine(user: CurrentUserDto, query: ListMissingPersonsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { userId: user.id };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─────────────────────────────────────────────
  // UPDATE
  // Only PENDING or MORE_INFORMATION_REQUESTED submissions may be
  // edited by their owner. Editing a MORE_INFORMATION_REQUESTED
  // case moves it back to PENDING so it re-enters the review queue.
  // Empty patches are rejected.
  //
  // Media handling: diffs each media field present in the request
  // against what's currently on the row. Newly-added filepaths are
  // validated against MinIO before the write; filepaths dropped
  // from the new array are deleted from MinIO after the write
  // commits — same ordering discipline as PostService.updateMyPost.
  // ─────────────────────────────────────────────

  async update(user: CurrentUserDto, id: string, data: UpdateMissingPersonDto) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (existing.userId !== user.id) {
      throw new ForbiddenException('not_authorized_to_update');
    }

    if (!this.EDITABLE_STATUSES.includes(existing.status)) {
      throw new ForbiddenException('submission_not_editable_in_current_status');
    }

    const hasAnyField = Object.values(data).some((value) => value !== undefined);

    if (!hasAnyField) {
      throw new BadRequestException('no_fields_provided');
    }

    const { added, removed } = this.diffMediaFields(existing, data);
    await this.validateMediaFilesExist(added);

    const shouldReturnToPending = existing.status === MissingPersonStatus.MORE_INFORMATION_REQUESTED;

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: {
        ...(data.personType !== undefined ? { personType: data.personType } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.dateLastSeen !== undefined ? { dateLastSeen: new Date(data.dateLastSeen) } : {}),
        ...(data.lastKnownArea !== undefined ? { lastKnownArea: data.lastKnownArea } : {}),
        ...(data.photo !== undefined ? { photo: data.photo } : {}),
        ...(data.video !== undefined ? { video: data.video } : {}),
        ...(data.audio !== undefined ? { audio: data.audio } : {}),
        ...(data.pdf !== undefined ? { pdf: data.pdf } : {}),
        ...(data.document !== undefined ? { document: data.document } : {}),
        ...(data.other !== undefined ? { other: data.other } : {}),
        ...(shouldReturnToPending ? { status: MissingPersonStatus.PENDING } : {}),
      },
    });

    // Only after the DB write commits — deleting first and having
    // the write fail would strand the case pointing at nothing.
    await this.deleteMediaFiles(removed);

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: updated.id,
      diff: {
        returnedToPending: shouldReturnToPending,
        result: 'success',
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.MISSING_PERSON_UPDATED, {
      userId: existing.userId,
      missingPersonId: updated.id,
      status: updated.status,
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // DELETE
  // Only PENDING submissions may be deleted by their owner.
  // Deletes the DB row, then removes every attached media object
  // from MinIO — once the row referencing them is gone, an
  // orphaned object in the bucket serves no purpose. Same ordering
  // as PostService.deleteMyPost.
  // ─────────────────────────────────────────────

  async remove(user: CurrentUserDto, id: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (existing.userId !== user.id) {
      throw new ForbiddenException('not_authorized_to_delete');
    }

    if (existing.status !== MissingPersonStatus.PENDING) {
      throw new ForbiddenException('only_pending_submissions_can_be_deleted');
    }

    await this.prisma.missingPerson.delete({ where: { id } });

    await this.deleteMediaFiles(this.collectMediaFields(existing));

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(user.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_DELETED,
      entity: 'MissingPerson',
      entityId: id,
      diff: {
        previousStatus: existing.status,
        result: 'success',
      },
    });

    return { message: 'missing_person_deleted' };
  }

  // ─────────────────────────────────────────────
  // ADMIN — FIND ALL (paginated, lightweight — no submissions)
  // ─────────────────────────────────────────────

  async findAllForAdmin(query: ListMissingPersonsAdminQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { ...(query.status !== undefined ? { status: query.status } : {}) };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — FIND ONE (full detail, includes submissions)
  // ─────────────────────────────────────────────

  async findOneForAdmin(id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      include: { informationSubmissions: true },
    });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    return missingPerson;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  // Enforces ALLOWED_TRANSITIONS and requires a reviewNote when
  // rejecting or requesting more information.
  // ─────────────────────────────────────────────

  async updateStatus(admin: CurrentUserDto, id: string, status: MissingPersonStatus, reviewNote?: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (existing.status === status) {
      return existing;
    }

    const allowedNext = this.ALLOWED_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(status)) {
      throw new BadRequestException(`invalid_status_transition: ${existing.status} -> ${status}`);
    }

    if (
      (status === MissingPersonStatus.REJECTED || status === MissingPersonStatus.MORE_INFORMATION_REQUESTED) &&
      !reviewNote?.trim()
    ) {
      throw new BadRequestException('review_note_required_for_this_status');
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: {
        status,
        ...(reviewNote !== undefined ? { reviewNote } : {}),
      },
    });

    let auditEvent: AuditEventEnum;

    switch (status) {
      case MissingPersonStatus.APPROVED:
        auditEvent = AuditEventEnum.MISSING_PERSON_APPROVED;
        break;

      case MissingPersonStatus.REJECTED:
        auditEvent = AuditEventEnum.MISSING_PERSON_REJECTED;
        break;

      case MissingPersonStatus.FOUND:
        auditEvent = AuditEventEnum.MISSING_PERSON_FOUND;
        break;

      case MissingPersonStatus.MORE_INFORMATION_REQUESTED:
        auditEvent = AuditEventEnum.MISSING_PERSON_MORE_INFO_REQUESTED;
        break;

      default:
        auditEvent = AuditEventEnum.MISSING_PERSON_UPDATED;
        break;
    }

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: auditEvent,
      entity: 'MissingPerson',
      entityId: updated.id,
      diff: {
        previousStatus: existing.status,
        newStatus: updated.status,
        result: 'success',
      },
    });

    let notificationEvent: NotificationEventEnum;

    switch (status) {
      case MissingPersonStatus.APPROVED:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_APPROVED;
        break;

      case MissingPersonStatus.REJECTED:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_REJECTED;
        break;

      case MissingPersonStatus.FOUND:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_FOUND;
        break;

      case MissingPersonStatus.MORE_INFORMATION_REQUESTED:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_MORE_INFORMATION_REQUESTED;
        break;

      default:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_UPDATED;
        break;
    }

    this.eventEmitter.emit(notificationEvent, {
      userId: existing.userId,
      missingPersonId: updated.id,
      previousStatus: existing.status,
      status: updated.status,
      reviewNote,
    });

    return updated;
  }
}
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { MissingPersonStatus, MissingPersonType, Prisma } from '@prisma/client';

import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { MinioService } from 'src/services/minio/minio.service';

import {
  CreateMissingPersonDto,
  ListMissingPersonsAdminQueryDto,
  ListMissingPersonsQueryDto,
  UpdateMissingPersonDto,
} from '../dto/missing-person.dto';

// The six media-array fields shared by CreateMissingPersonDto/
// UpdateMissingPersonDto and the MissingPerson model itself.
// Mirrors PostService's/ReportService's MEDIA_FIELD_NAMES so every
// module stays in sync if a new media kind is ever added.
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

// A case here is done, one way or another. Used by findStalePending()
// (a terminal case can't be "stale") and maybeFlagUserForRejections()
// (only REJECTED counts against the user, not FOUND).
const TERMINAL_STATUSES: MissingPersonStatus[] = [
  MissingPersonStatus.REJECTED,
  MissingPersonStatus.FOUND,
];

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
  // model (userId, reviewNote, reward review fields, claim
  // fields, etc.) can leak through the public endpoints without
  // a deliberate change here.
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
    // NEW (reward): rewardOffered/rewardApproved are safe to expose
    // as-is — they're just booleans indicating whether a reward
    // exists and whether it's been reviewed. rewardAmount/
    // rewardDetails are selected here too, but findOne()/findAll()
    // run every row through maskUnapprovedReward() before
    // returning, so an unapproved amount/details never actually
    // reaches a public caller even though it's in this select.
    rewardOffered: true,
    rewardApproved: true,
    rewardAmount: true,
    rewardDetails: true,
  } as const;

  // AUDIT EMIT (typed helper): routes every audit emit through AuditEventPayload so a
  // missing field (actorType, entity, etc.) is caught at compile time, not silently dropped

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // ─────────────────────────────────────────────
  // MEDIA HELPERS
  //
  // Mirrors PostService's/ReportService's media helpers.
  // MissingPerson stores media as plain filepath strings in typed
  // arrays (photo/video/audio/pdf/document/other), same as Post,
  // Report, and VictimProfile — kept in one place so every
  // read/write of that shape stays consistent.
  // ─────────────────────────────────────────────

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

  // FIX (item #3): confirms every filepath the client is attaching
  // actually exists in the media bucket, AND now also enforces
  // size/MIME-type limits — previously this only checked existence,
  // unlike Report/PostService.validateMediaFilesExist which already
  // did all three. Brought to parity so a missing-person submission
  // can't reference an object that's oversized or of a disallowed
  // type any more than a report or post can.
  //
  // FIX (item #13, partial): returns each validated file's size so
  // callers can maintain a running mediaTotalBytes without
  // re-statting already-attached files.
  //
  // NOTE (item #3, virus scanning) / NOTE (item #4, EXIF/GPS
  // stripping): deliberately out of scope here — belongs in the
  // media-upload module at upload time, same as every other module.
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

  // FIX (item #13): per-field attachment counts, mirroring
  // Report/PostService.assertAttachmentCounts exactly, but reading
  // MISSING_PERSON_*-prefixed overrides first. Checked BEFORE any
  // MinIO calls so an over-attached request fails fast.
  private assertAttachmentCounts(media: MediaBearing): void {
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

  // FIX (item #13): total attached-media size cap per case,
  // mirroring Report/PostService.assertTotalBytes.
  private assertTotalBytes(totalBytes: number): void {
    const maxTotalBytes = Number(
      this.configService.get<string>('MISSING_PERSON_MAX_TOTAL_UPLOAD_BYTES') ??
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

  // ─────────────────────────────────────────────
  // REWARD HELPERS
  //
  // buildRewardProposalUpdate: the submitter-facing half. Applies
  // to create() and update(). rewardAmount/rewardDetails are only
  // ever persisted when rewardOffered is (or becomes) true — if
  // rewardOffered is false, both are forced to null regardless of
  // what the client sent, so a stale amount can't linger from a
  // reward the submitter has since retracted. In update(), returns
  // null when the DTO touches none of the three fields, so the
  // caller knows to leave the existing row alone entirely.
  //
  // maskUnapprovedReward: the public-read half. rewardAmount/
  // rewardDetails are stripped from any row returned to a public
  // caller unless rewardApproved is true — an unreviewed reward
  // proposal should never be visible on the public listing/detail
  // endpoints, only after an admin has approved it via
  // updateReward().
  // ─────────────────────────────────────────────

  private buildRewardProposalUpdate(
    incoming: { rewardOffered?: boolean; rewardAmount?: number; rewardDetails?: string },
    existing?: { rewardOffered: boolean; rewardAmount: number | null; rewardDetails: string | null },
  ): { rewardOffered: boolean; rewardAmount: number | null; rewardDetails: string | null } | null {
    const touched =
      incoming.rewardOffered !== undefined ||
      incoming.rewardAmount !== undefined ||
      incoming.rewardDetails !== undefined;

    // On create() there's no `existing` row yet and every call is
    // "touched" by definition (there's nothing to leave alone).
    if (!touched && existing) return null;

    const base = existing ?? { rewardOffered: false, rewardAmount: null, rewardDetails: null };

    const rewardOffered = incoming.rewardOffered ?? base.rewardOffered;
    const rewardAmount = rewardOffered ? incoming.rewardAmount ?? base.rewardAmount ?? null : null;
    const rewardDetails = rewardOffered ? incoming.rewardDetails ?? base.rewardDetails ?? null : null;

    return { rewardOffered, rewardAmount, rewardDetails };
  }

  private maskUnapprovedReward<
    T extends { rewardApproved: boolean; rewardAmount: number | null; rewardDetails: string | null },
  >(record: T): T {
    if (record.rewardApproved) return record;
    return { ...record, rewardAmount: null, rewardDetails: null };
  }

  // ─────────────────────────────────────────────
  // CLAIM HELPERS (item #17)
  //
  // Missing Person had no assignment/claim concept at all before
  // this. Follows Post's self-serve claimPost()/unclaimPost() model
  // (rather than Report's SUPER_ADMIN-mediated assign()/unassign())
  // since there is no dedicated "assignee" relation on this model to
  // add — any ADMIN/SUPER_ADMIN may claim an unclaimed case, and
  // only the claimant (or an explicit unclaim) can release it.
  // Enforced on the review-decision write (updateStatus), not on
  // reads.
  // ─────────────────────────────────────────────

  private assertNotClaimedByOther(
    missingPerson: { claimedByUserId: string | null },
    actorUserId: string,
  ): void {
    if (missingPerson.claimedByUserId && missingPerson.claimedByUserId !== actorUserId) {
      throw new ForbiddenException('missing_person_claimed_by_another_admin');
    }
  }

  async claimMissingPerson(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }
    this.assertNotClaimedByOther(existing, admin.id);

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { claimedByUserId: admin.id, claimedAt: new Date() },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: id,
      diff: { claimedBy: admin.id, result: 'success' },
    });

    return updated;
  }

  async unclaimMissingPerson(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }
    this.assertNotClaimedByOther(existing, admin.id);

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { claimedByUserId: null, claimedAt: null },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: id,
      diff: { unclaimedBy: admin.id, result: 'success' },
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // CHILD-SAFETY DUAL CONTROL (item #16)
  //
  // Only relevant when personType = CHILD. A single admin's status
  // call is no longer enough to move a CHILD case to APPROVED — the
  // first admin's confirmation is only recorded; a second, DIFFERENT
  // admin must confirm again before the transition actually goes
  // through. Mirrors PostService.ensureChildSafetySatisfied exactly,
  // adapted to MissingPerson's field names.
  // ─────────────────────────────────────────────

  private async ensureChildSafetySatisfied(
    missingPerson: {
      id: string;
      personType: MissingPersonType;
      childSafetyFirstConfirmedByUserId: string | null;
    },
    actorUserId: string,
    confirmed: boolean | undefined,
  ): Promise<'not_required' | 'first_confirmation_recorded' | 'satisfied'> {
    if (missingPerson.personType !== MissingPersonType.CHILD) return 'not_required';

    if (confirmed !== true) {
      throw new BadRequestException('child_safety_confirmation_required');
    }

    if (!missingPerson.childSafetyFirstConfirmedByUserId) {
      await this.prisma.missingPerson.update({
        where: { id: missingPerson.id },
        data: {
          childSafetyFirstConfirmedByUserId: actorUserId,
          childSafetyFirstConfirmedAt: new Date(),
        },
      });
      return 'first_confirmation_recorded';
    }

    if (missingPerson.childSafetyFirstConfirmedByUserId === actorUserId) {
      throw new BadRequestException('child_safety_requires_second_distinct_admin');
    }

    return 'satisfied';
  }

  // ─────────────────────────────────────────────
  // BANNED / SUSPENDED OWNER HANDLING (item #6)
  //
  // ASSUMPTION: same event contract as Report/PostService — the
  // user module emits 'user.suspended' with a { userId } payload.
  //
  // Same reasoning as ReportService: a missing-person case has no
  // safe intermediate "hidden" state, and is if anything MORE
  // safety-critical than a report — so this only stamps
  // ownerSuspendedAt for admin filtering and deliberately does NOT
  // change status or pull anything out of the review queue.
  // ─────────────────────────────────────────────

  @OnEvent('user.suspended')
  async handleUserSuspended(payload: { userId: string }): Promise<void> {
    const now = new Date();

    await this.prisma.missingPerson.updateMany({
      where: {
        userId: payload.userId,
        status: { notIn: TERMINAL_STATUSES },
        ownerSuspendedAt: null,
      },
      data: { ownerSuspendedAt: now },
    });

    this.emitAudit({
      userId: payload.userId,
      // ASSUMPTION: resolveActorType only knows about role-bearing
      // actors; cast until AuditEventPayload's actorType union is
      // extended with a SYSTEM variant. Same cast Report/PostService use.
      actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: `user:${payload.userId}`,
      diff: { reason: 'owner_account_suspended', result: 'success' },
    });
  }

  // ─────────────────────────────────────────────
  // AUTOMATIC FLAGS (item #21)
  //
  // Flag ≠ reject. Writes an audit-log entry an admin can see
  // against the user; never blocks or auto-rejects anything, and
  // never changes any MissingPerson's status. Mirrors
  // Report/PostService.maybeFlagUserForRejections, reading
  // MISSING_PERSON_* overrides first. Only called from
  // updateStatus() on a transition TO REJECTED.
  // ─────────────────────────────────────────────

  private async maybeFlagUserForRejections(userId: string): Promise<void> {
    const threshold = Number(
      this.configService.get<string>('MISSING_PERSON_AUTO_FLAG_REJECTION_COUNT') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_REJECTION_COUNT') ??
        3,
    );
    const windowDays = Number(
      this.configService.get<string>('MISSING_PERSON_AUTO_FLAG_WINDOW_DAYS') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_WINDOW_DAYS') ??
        7,
    );
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const recentRejections = await this.prisma.missingPerson.count({
      where: { userId, status: MissingPersonStatus.REJECTED, updatedAt: { gte: since } },
    });

    if (recentRejections >= threshold) {
      this.emitAudit({
        userId,
        actorType: 'SYSTEM' as unknown as ReturnType<typeof resolveActorType>,
        action: AuditEventEnum.USER_AUTO_FLAGGED,
        entity: 'User',
        entityId: userId,
        diff: {
          reason: 'repeated_missing_person_rejections',
          rejectionCount: recentRejections,
          windowDays,
          result: 'flagged_for_review',
        },
      });
    }
  }

  // ─────────────────────────────────────────────
  // OWNER — GET MEDIA DOWNLOAD URL
  // GET /missing-persons/mine/:id/media?key=...
  //
  // The submitter can request a download URL for a key attached to
  // their own submission, in any status — mirrors
  // ReportService.getMediaDownloadUrl's reporter-owned scoping.
  // findMine() returns raw filepaths with no way to turn them into
  // an actual URL; this closes that gap without waiting on
  // approval, since the submitter should be able to confirm their
  // own uploads regardless of review state.
  // ─────────────────────────────────────────────

  async getMediaDownloadUrlForOwner(
    user: CurrentUserDto,
    id: string,
    key: string,
  ): Promise<{ url: string }> {
    const missingPerson = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!missingPerson || missingPerson.userId !== user.id) {
      throw new NotFoundException('missing_person_not_found');
    }

    const owned = this.collectMediaFields(missingPerson).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET MEDIA DOWNLOAD URL
  // GET /missing-persons/admin/:id/media?key=...
  //
  // Admins can request a download URL for any media key actually
  // attached to the submission, regardless of status — matches
  // findOneForAdmin()'s admin-only, no-visibility-filtering access.
  // Now also audit-logged, matching
  // ReportService.getMediaDownloadUrlForAdmin.
  // ─────────────────────────────────────────────

  async getMediaDownloadUrl(
    admin: CurrentUserDto,
    id: string,
    key: string,
  ): Promise<{ url: string }> {
    const missingPerson = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    const owned = this.collectMediaFields(missingPerson).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED,
      entity: 'MissingPerson',
      entityId: id,
      diff: { result: 'success', key },
    });

    return { url };
  }

  // ─────────────────────────────────────────────
  // PUBLIC — GET MEDIA DOWNLOAD URL
  // GET /missing-persons/:id/media?key=...
  //
  // Same visibility gate as findOne(): the record must be
  // APPROVED. Unlike VictimProfile/Post there's no child-safety
  // suppression concept on MissingPerson's media, so every media
  // field attached to an approved case is fair game here — matches
  // publicSelect already exposing all six media arrays as-is.
  // ─────────────────────────────────────────────

  async getPublicMediaDownloadUrl(id: string, key: string): Promise<{ url: string }> {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: this.publicSelect,
    });

    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }

    const owned = this.collectMediaFields(missingPerson).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  // ─────────────────────────────────────────────
  // CREATE
  //
  // FIX (item #1): a per-user cooldown
  // (MISSING_PERSON_CREATE_RATE_LIMIT_WINDOW_SECONDS, falling back
  // to the shared CONTENT_* default) blocks rapid-fire spam, and a
  // max-pending-per-user cap
  // (MISSING_PERSON_MAX_PENDING_PER_USER / CONTENT_MAX_PENDING_PER_USER)
  // is enforced here — a missing-person case is PENDING the moment
  // it's created, same as Report.
  //
  // FIX (item #5): optional Idempotency-Key (sent as a header by the
  // controller) lets a client safely retry after a dropped response.
  // A repeat with the same key returns the original record.
  //
  // FIX (item #13): attachment counts/total size are checked before
  // any MinIO round trips, and the validated sizes are persisted as
  // mediaTotalBytes.
  // ─────────────────────────────────────────────

  private async enforceCreateRateLimit(userId: string): Promise<void> {
    const cooldownSeconds = Number(
      this.configService.get<string>('MISSING_PERSON_CREATE_RATE_LIMIT_WINDOW_SECONDS') ??
        this.configService.get<string>('CONTENT_CREATE_RATE_LIMIT_WINDOW_SECONDS') ??
        60,
    );

    const last = await this.prisma.missingPerson.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (last && Date.now() - last.createdAt.getTime() < cooldownSeconds * 1000) {
      throw new BadRequestException('missing_person_creation_rate_limited');
    }
  }

  private async enforceMaxPending(userId: string): Promise<void> {
    const maxPending = Number(
      this.configService.get<string>('MISSING_PERSON_MAX_PENDING_PER_USER') ??
        this.configService.get<string>('CONTENT_MAX_PENDING_PER_USER') ??
        5,
    );

    const pendingCount = await this.prisma.missingPerson.count({
      where: { userId, status: MissingPersonStatus.PENDING },
    });

    if (pendingCount >= maxPending) {
      throw new BadRequestException('too_many_pending_missing_person_submissions');
    }
  }

  async create(user: CurrentUserDto, data: CreateMissingPersonDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.missingPerson.findFirst({
        where: { userId: user.id, idempotencyKey },
      });
      if (existing) {
        // Safe replay of a duplicate submission — return the
        // original instead of creating a second record.
        return existing;
      }
    }

    await this.enforceCreateRateLimit(user.id);
    await this.enforceMaxPending(user.id);

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

    // NEW (reward): rewardApproved is never set here — it always
    // starts false (the Prisma default) regardless of what's
    // proposed, since CreateMissingPersonDto has no rewardApproved
    // field for a submitter to even send.
    const rewardProposal = this.buildRewardProposalUpdate(data)!;

    const missingPerson = await this.createWithIdempotencyRaceHandling(
      user,
      data,
      merged,
      totalBytes,
      rewardProposal,
      idempotencyKey,
    );

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

  // FIX (item #5/#26): handles a race on the (userId, idempotencyKey)
  // unique constraint — the fast-path findFirst in create() is
  // inherently racy under concurrent identical retries: two
  // near-simultaneous retries with the same key can both pass the
  // findFirst and race to insert. Mirrors ReportService's equivalent
  // helper, minus the caseReference retry loop (MissingPerson has no
  // analogous unique-generated field to retry).
  private async createWithIdempotencyRaceHandling(
    user: CurrentUserDto,
    data: CreateMissingPersonDto,
    merged: MediaBearing,
    totalBytes: number,
    rewardProposal: { rewardOffered: boolean; rewardAmount: number | null; rewardDetails: string | null },
    idempotencyKey?: string,
  ) {
    try {
      return await this.prisma.missingPerson.create({
        data: {
          userId: user.id,
          personType: data.personType,
          name: data.name,
          description: data.description,
          dateLastSeen: new Date(data.dateLastSeen),
          lastKnownArea: data.lastKnownArea,
          photo: merged.photo,
          video: merged.video,
          audio: merged.audio,
          pdf: merged.pdf,
          document: merged.document,
          other: merged.other,
          mediaTotalBytes: totalBytes,
          status: MissingPersonStatus.PENDING,
          rewardOffered: rewardProposal.rewardOffered,
          rewardAmount: rewardProposal.rewardAmount,
          rewardDetails: rewardProposal.rewardDetails,
          idempotencyKey: idempotencyKey ?? null,
        },
      });
    } catch (err) {
      if (
        idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = err.meta?.target as string[] | undefined;
        if (target?.some((t) => t.includes('idempotencyKey'))) {
          // Lost a race against a concurrent identical retry — the
          // other request's insert won; return that row instead of
          // creating (or failing to create) a duplicate.
          const winner = await this.prisma.missingPerson.findFirst({
            where: { userId: user.id, idempotencyKey },
          });
          if (winner) {
            return winner;
          }
        }
      }
      throw err;
    }
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

    return this.maskUnapprovedReward(missingPerson);
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
      data: data.map((item) => this.maskUnapprovedReward(item)),
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
  // ADMIN — STALE / UNREVIEWED-TOO-LONG CASES
  // GET /missing-persons/admin/stale
  // (item #15)
  //
  // Flags non-terminal cases older than the configured threshold so
  // admins can prioritize "forgotten" cases. No assignment/claim
  // gate the way ReportService.findStalePending has (assignedToId),
  // since a claim here doesn't remove urgency the way an active
  // assignment does elsewhere — a claimed-but-still-old case is
  // arguably still worth surfacing. Purely informational — nothing
  // here changes status, ownership, or claim.
  // ─────────────────────────────────────────────

  async findStalePending() {
    const staleHours = Number(
      this.configService.get<string>('MISSING_PERSON_STALE_PENDING_HOURS') ??
        this.configService.get<string>('CONTENT_STALE_PENDING_HOURS') ??
        48,
    );
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

    const items = await this.prisma.missingPerson.findMany({
      where: {
        status: { notIn: TERMINAL_STATUSES },
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
    });

    return items.map((item) => ({
      ...item,
      pendingHours: Math.floor((Date.now() - item.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
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
  //
  // FIX (item #13): attachment counts are checked against the
  // fully-merged post-update media shape before any MinIO calls,
  // and mediaTotalBytes is recomputed from the previous total
  // plus/minus the added/removed files' sizes — same approach as
  // Report/PostService.
  //
  // NOTE (reward): the submitter may also revise their reward
  // proposal here (rewardOffered/rewardAmount/rewardDetails) via
  // buildRewardProposalUpdate(). rewardApproved itself is never
  // touched by this method except to auto-reset it to false when
  // the submitter changes an already-approved reward's terms — see
  // shouldResetRewardApproval below. Approving a proposal can only
  // happen via updateReward().
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

    const shouldReturnToPending =
      existing.status === MissingPersonStatus.MORE_INFORMATION_REQUESTED;

    // NEW (reward): null when the DTO doesn't touch any of the
    // three reward fields — leave the existing row's reward
    // proposal untouched in that case.
    const rewardUpdate = this.buildRewardProposalUpdate(data, existing);

    // If the submitter changes the actual terms of an
    // already-approved reward, the approval no longer covers what's
    // being displayed — un-approve so it goes back through review
    // rather than silently keeping a stale sign-off on new terms.
    // A no-op resend of identical values does NOT reset approval.
    const rewardTermsChanged =
      rewardUpdate !== null &&
      (rewardUpdate.rewardOffered !== existing.rewardOffered ||
        rewardUpdate.rewardAmount !== existing.rewardAmount ||
        rewardUpdate.rewardDetails !== existing.rewardDetails);
    const shouldResetRewardApproval = rewardTermsChanged && existing.rewardApproved;

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
        ...(rewardUpdate !== null
          ? {
              rewardOffered: rewardUpdate.rewardOffered,
              rewardAmount: rewardUpdate.rewardAmount,
              rewardDetails: rewardUpdate.rewardDetails,
            }
          : {}),
        ...(shouldResetRewardApproval ? { rewardApproved: false } : {}),
        ...(shouldReturnToPending ? { status: MissingPersonStatus.PENDING } : {}),
        mediaTotalBytes: newTotalBytes,
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
  // ADMIN — PER-CASE HISTORY / TIMELINE
  // GET /missing-persons/admin/:id/history
  // (item #18)
  //
  // ASSUMPTION: same as Report/PostService.getHistory — an
  // `auditLog` Prisma model populated by a listener subscribed to
  // the events emitAudit() already fires throughout this service.
  // ─────────────────────────────────────────────

  async getHistory(id: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    return this.prisma.auditLog.findMany({
      where: { entity: 'MissingPerson', entityId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  // Enforces ALLOWED_TRANSITIONS and requires a reviewNote when
  // rejecting or requesting more information.
  //
  // FIX (item #16): a personType=CHILD case moving to APPROVED now
  // requires two distinct admins via ensureChildSafetySatisfied,
  // same dual-control gate as Post's approve()/updateStatus().
  //
  // FIX (item #17): blocked if claimed by a different admin; claim
  // is released once the transition actually goes through.
  //
  // FIX (item #22/#26): the read-then-write is now a conditional
  // update guarded on the status read a moment earlier, same
  // pattern as Report/PostService, so two admins racing to
  // transition the same case can't silently clobber each other —
  // the loser gets missing_person_transition_conflict instead of an
  // unvalidated write going through.
  //
  // FIX (item #21): on a transition TO REJECTED, checks whether the
  // submitter has crossed the auto-flag threshold for repeated
  // rejections.
  // ─────────────────────────────────────────────

  async updateStatus(
    admin: CurrentUserDto,
    id: string,
    status: MissingPersonStatus,
    reviewNote?: string,
    childSafetyConfirmed?: boolean,
  ) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (existing.status === status) {
      return existing;
    }

    this.assertNotClaimedByOther(existing, admin.id);

    const allowedNext = this.ALLOWED_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(status)) {
      throw new BadRequestException(`invalid_status_transition: ${existing.status} -> ${status}`);
    }

    if (
      (status === MissingPersonStatus.REJECTED ||
        status === MissingPersonStatus.MORE_INFORMATION_REQUESTED) &&
      !reviewNote?.trim()
    ) {
      throw new BadRequestException('review_note_required_for_this_status');
    }

    if (status === MissingPersonStatus.APPROVED && existing.personType === MissingPersonType.CHILD) {
      const safety = await this.ensureChildSafetySatisfied(existing, admin.id, childSafetyConfirmed);
      if (safety === 'first_confirmation_recorded') {
        const partial = await this.prisma.missingPerson.findUniqueOrThrow({ where: { id } });
        this.emitAudit({
          userId: admin.id,
          actorType: resolveActorType(admin.roles ?? []),
          action: AuditEventEnum.MISSING_PERSON_UPDATED,
          entity: 'MissingPerson',
          entityId: id,
          diff: {
            childSafetyFirstConfirmationBy: admin.id,
            result: 'pending_second_admin_confirmation',
          },
        });
        return { ...partial, pendingSecondConfirmation: true };
      }
    }

    const result = await this.prisma.missingPerson.updateMany({
      where: { id, status: existing.status },
      data: {
        status,
        ...(reviewNote !== undefined ? { reviewNote } : {}),
        claimedByUserId: null,
        claimedAt: null,
      },
    });

    if (result.count === 0) {
      throw new BadRequestException('missing_person_transition_conflict');
    }

    const updated = await this.prisma.missingPerson.findUniqueOrThrow({ where: { id } });

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
        childSafetyDualControlSatisfied:
          status === MissingPersonStatus.APPROVED && existing.personType === MissingPersonType.CHILD
            ? true
            : undefined,
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

    if (status === MissingPersonStatus.REJECTED) {
      await this.maybeFlagUserForRejections(existing.userId);
    }

    return updated;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE REWARD
  // PATCH /missing-persons/admin/:id/reward
  //
  // Deliberately separate from updateStatus(): reward approval is
  // its own decision, independent of where the case sits in the
  // review workflow. No ALLOWED_TRANSITIONS gate and no claim check
  // — an unclaimed or already-claimed-by-someone-else case can
  // still have its reward set, since reward decisions don't carry
  // the same "only one admin actively reviewing" concern that
  // status transitions do. Reconsider this if that assumption turns
  // out to be wrong for your workflow.
  //
  // Approval requires the case to actually have a reward proposal:
  // rewardApproved: true is rejected outright if the submitter's
  // rewardOffered is false — an admin approves what was offered,
  // never invents an offer. rewardAmount/rewardDetails passed here
  // are OPTIONAL overrides on top of whatever the submitter last
  // proposed; omitting them keeps the existing value. A final
  // amount (existing or overridden) is required whenever
  // rewardApproved is true.
  //
  // Unlike the first draft of this method, rewardApproved: false
  // no longer nulls rewardAmount/rewardDetails in the DB — the
  // submitter's proposal is preserved so a later re-review doesn't
  // start from scratch. Public-facing reads mask
  // rewardAmount/rewardDetails via maskUnapprovedReward() whenever
  // rewardApproved is false, which is what actually keeps an
  // unreviewed or rejected figure off the public endpoints.
  // ─────────────────────────────────────────────

  async updateReward(
    admin: CurrentUserDto,
    id: string,
    rewardApproved: boolean,
    rewardAmount?: number,
    rewardDetails?: string,
  ) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (rewardApproved && !existing.rewardOffered) {
      throw new BadRequestException('cannot_approve_reward_that_was_not_offered');
    }

    const finalAmount = rewardAmount !== undefined ? rewardAmount : existing.rewardAmount;
    const finalDetails = rewardDetails !== undefined ? rewardDetails : existing.rewardDetails;

    if (rewardApproved && (finalAmount === undefined || finalAmount === null)) {
      throw new BadRequestException('reward_amount_required_when_approved');
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: {
        rewardApproved,
        rewardAmount: finalAmount,
        rewardDetails: finalDetails,
      },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: id,
      diff: {
        previousRewardApproved: existing.rewardApproved,
        previousRewardAmount: existing.rewardAmount,
        previousRewardDetails: existing.rewardDetails,
        rewardApproved: updated.rewardApproved,
        rewardAmount: updated.rewardAmount,
        rewardDetails: updated.rewardDetails,
        result: 'success',
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.MISSING_PERSON_UPDATED, {
      userId: existing.userId,
      missingPersonId: updated.id,
      status: updated.status,
      rewardApproved: updated.rewardApproved,
      rewardAmount: updated.rewardAmount,
    });

    return updated;
  }
}
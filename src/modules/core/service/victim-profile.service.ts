import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { Prisma, VictimProfile, VictimProfileStatus } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { MinioService } from 'src/services/minio/minio.service';

import {
  CreateVictimProfileDto,
  FindAllVictimProfilesQueryDto,
  FindPublicVictimProfilesQueryDto,
  RevokeConsentDto,
  UpdateBankDetailsDto,
  UpdateChildSafetyReviewDto,
  UpdateVictimGateDto,
  UpdateVictimProfileDto,
} from '../dto/victim-profile.dto';

// The six media-array fields shared by CreateVictimProfileDto/
// UpdateVictimProfileDto and the VictimProfile model itself.
// Mirrors PostService's MEDIA_FIELD_NAMES so every module stays in
// sync if a new media kind is ever added.
const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
type MediaBearing = Record<MediaFieldName, string[]>;
type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

@Injectable()
export class VictimProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // MEDIA HELPERS
  //
  // Mirrors PostService's media helpers. VictimProfile stores media
  // as plain filepath strings in typed arrays (photo/video/audio/
  // pdf/document/other), same as Post and Report — kept in one
  // place so every read/write of that shape stays consistent.
  //
  // FIX: MinioService.objectExists()/deleteFile() are now
  // bucket-less — the service holds a single configured bucket
  // internally, so callers just pass the key. getMediaBucket() is
  // no longer used by validateMediaFilesExist()/deleteMediaFiles()
  // to match the new signatures; left in place in case other code
  // in this file still needs the bucket name for something else.
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
  // in the media bucket, so a profile can't reference an object
  // that was never uploaded (typo'd path, upload abandoned
  // mid-flow, filepath copied from an unrelated response, etc.).
  // Only called on filepaths that are new to the entity —
  // already-attached filepaths were validated when first added.
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
  private async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  // ─────────────────────────────────────────────
  // CREATE
  //
  // Media filepaths are validated against MinIO before the
  // profile is created, same as PostService.create.
  // ─────────────────────────────────────────────

  async create(currentUser: CurrentUserDto, data: CreateVictimProfileDto) {
    await this.validateMediaFilesExist(this.collectMediaFieldsFromDto(data));

    const profile = await this.prisma.victimProfile.create({
      data: {
        name: data.name,
        description: data.description,
        story: data.story,

        supportType: data.supportType,
        supportGoal: data.supportGoal,

        bankAccountName: data.bankAccountName,
        bankAccountNumber: data.bankAccountNumber,
        bankName: data.bankName,

        photo: data.photo ?? [],
        video: data.video ?? [],
        audio: data.audio ?? [],
        pdf: data.pdf ?? [],
        document: data.document ?? [],
        other: data.other ?? [],

        involvesChild: data.involvesChild ?? false,

        status: VictimProfileStatus.PENDING,

        isVerified: false,
        isSafetyReviewed: false,
        isChildSafetyReviewed: false,
        hasConsent: false,
        consentAt: null,
        consentRecordedBy: null,
        isPrivacyReviewed: false,
        isAdminApproved: false,
        isPublished: false,
      },
    });

    this.eventEmitter.emit('victim_profile.created', {
      actorId: currentUser.id,
      victimProfileId: profile.id,
      action: 'CREATE',
      entity: 'VictimProfile',
    });

    this.eventEmitter.emit('notification.victim_profile.created', {
      actorId: currentUser.id,
      victimProfileId: profile.id,
    });

    return profile;
  }

  // ─────────────────────────────────────────────
  // GET ONE (admin)
  // ─────────────────────────────────────────────

  async findOne(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },

      include: {
        supports: {
          where: { status: 'CONFIRMED' },

          select: {
            id: true,
            type: true,
            status: true,
            agreementType: true,
            amount: true,
            recipientAmount: true,
            organizationAmount: true,
            platformAmount: true,
            message: true,
            createdAt: true,
          },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    return profile;
  }

  // ─────────────────────────────────────────────
  // GET ONE — SUPPORT/DONATION SUMMARY
  //
  // ASSUMPTION: the Support model has a `victimProfileId` foreign
  // key and a `recipientAmount` field representing the portion
  // actually credited to the victim (falling back to `amount` if
  // `recipientAmount` isn't set on a given row). Adjust field names
  // to match your real Prisma schema if they differ.
  // ─────────────────────────────────────────────

  async getSupportsSummary(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const supports = await this.prisma.support.findMany({
      where: {
        victimProfileId: id,
        status: 'CONFIRMED',
      },
      orderBy: { createdAt: 'desc' },
    });

    // recipientAmount / amount are Prisma Decimal fields, not plain
    // numbers — coerce before summing. Switch to decimal.js (.plus())
    // instead of Number(...) if this ever needs to preserve precision
    // beyond what floating point can represent.
    const totalReceived = supports.reduce(
      (sum, support) => sum + Number(support.recipientAmount ?? support.amount ?? 0),
      0,
    );

    return {
      totalReceived,
      supportCount: supports.length,
      supports,
    };
  }

  // ─────────────────────────────────────────────
  // PUBLIC PROFILES — LIST
  // ─────────────────────────────────────────────

  async findPublic(query: FindPublicVictimProfilesQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;

    const where = {
      status: VictimProfileStatus.PUBLISHED,

      isPublished: true,

      isVerified: true,
      isSafetyReviewed: true,
      hasConsent: true,
      isPrivacyReviewed: true,
      isAdminApproved: true,

      ...(query.supportType ? { supportType: query.supportType } : {}),

      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { story: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,

        select: {
          id: true,
          name: true,
          story: true,

          supportType: true,
          supportGoal: true,

          bankAccountName: true,
          bankAccountNumber: true,
          bankName: true,

          photo: true,
          involvesChild: true,

          createdAt: true,
        },

        orderBy: { createdAt: 'desc' },

        skip: (page - 1) * limit,
        take: limit,
      }),

      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: profiles.map((profile) => this.serializePublicProfile(profile)),

      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─────────────────────────────────────────────
  // PUBLIC PROFILES — SINGLE
  //
  // Same visibility rules as the list, applied at the WHERE
  // clause rather than after the fetch: a profile that exists but
  // isn't published should 404, not leak its existence via a
  // different error shape.
  // ─────────────────────────────────────────────

  async findOnePublic(id: string) {
    const profile = await this.prisma.victimProfile.findFirst({
      where: {
        id,

        status: VictimProfileStatus.PUBLISHED,
        isPublished: true,

        isVerified: true,
        isSafetyReviewed: true,
        hasConsent: true,
        isPrivacyReviewed: true,
        isAdminApproved: true,
      },

      select: {
        id: true,
        name: true,
        story: true,

        supportType: true,
        supportGoal: true,

        bankAccountName: true,
        bankAccountNumber: true,
        bankName: true,

        photo: true,
        involvesChild: true,

        createdAt: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    return this.serializePublicProfile(profile);
  }

  private serializePublicProfile(profile: {
    id: string;
    name: string | null;
    story: string | null;
    supportType: unknown;
    supportGoal: Prisma.Decimal | null;
    bankAccountName: string | null;
    bankAccountNumber: string | null;
    bankName: string | null;
    photo: string[];
    involvesChild: boolean;
    createdAt: Date;
  }) {
    return {
      id: profile.id,
      name: profile.name,
      story: profile.story ?? '',
      supportType: profile.supportType,
      // Decimal isn't safe to send over JSON as-is in every setup;
      // convert to a plain number for the public-facing payload.
      supportGoal: profile.supportGoal ? Number(profile.supportGoal) : null,

      bankAccountName: profile.bankAccountName,
      bankAccountNumber: profile.bankAccountNumber,
      bankName: profile.bankName,

      // Child profiles never expose photos publicly.
      photo: profile.involvesChild ? [] : profile.photo,

      createdAt: profile.createdAt,
    };
  }

  // ─────────────────────────────────────────────
  // UPDATE PROFILE
  //
  // Media handling: diffs each media field present in the request
  // against what's currently on the row. Newly-added filepaths are
  // validated against MinIO before the write; filepaths dropped
  // from the new array are deleted from MinIO after the write
  // commits — same ordering discipline as PostService.updateMyPost.
  // ─────────────────────────────────────────────

  async update(currentUser: CurrentUserDto, id: string, data: UpdateVictimProfileDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const { added, removed } = this.diffMediaFields(profile, data);
    await this.validateMediaFilesExist(added);

    const updatedProfile = await this.prisma.victimProfile.update({
      where: { id },

      data: {
        name: data.name,
        description: data.description,
        story: data.story,

        supportType: data.supportType,
        supportGoal: data.supportGoal,

        bankAccountName: data.bankAccountName,
        bankAccountNumber: data.bankAccountNumber,
        bankName: data.bankName,

        photo: data.photo,
        video: data.video,
        audio: data.audio,
        pdf: data.pdf,
        document: data.document,
        other: data.other,

        involvesChild: data.involvesChild,

        // Reset approval pipeline after editing.
        status: VictimProfileStatus.PENDING,

        isVerified: false,
        isSafetyReviewed: false,
        isChildSafetyReviewed: false,
        hasConsent: false,

        consentAt: null,
        consentRecordedBy: null,

        isPrivacyReviewed: false,
        isAdminApproved: false,
        isPublished: false,
      },
    });

    // Only after the DB write commits — deleting first and having
    // the write fail would strand the profile pointing at nothing.
    await this.deleteMediaFiles(removed);

    this.eventEmitter.emit('victim_profile.updated', {
      actorId: currentUser.id,
      victimProfileId: id,
      action: 'UPDATE',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: VictimProfileStatus.PENDING,
    });

    this.eventEmitter.emit('notification.victim_profile.updated', {
      actorId: currentUser.id,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // DELETE
  //
  // Deletes the DB row, then removes every attached media object
  // from MinIO — once the row referencing them is gone, an
  // orphaned object in the bucket serves no purpose. Same ordering
  // as PostService.deleteMyPost.
  // ─────────────────────────────────────────────

  async remove(currentUser: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    await this.prisma.victimProfile.delete({ where: { id } });

    await this.deleteMediaFiles(this.collectMediaFields(profile));

    this.eventEmitter.emit('victim_profile.deleted', {
      actorId: currentUser.id,
      victimProfileId: id,
      action: 'DELETE',
      entity: 'VictimProfile',

      previousStatus: profile.status,
    });

    this.eventEmitter.emit('notification.victim_profile.deleted', {
      actorId: currentUser.id,
      victimProfileId: id,
    });

    return { message: 'victim_profile_deleted', id };
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ALL
  // ─────────────────────────────────────────────

  async findAllForAdmin(query: FindAllVictimProfilesQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;

    const where = query.status !== undefined ? { status: query.status } : {};

    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,

        include: {
          supports: {
            orderBy: { createdAt: 'desc' },
          },
        },

        orderBy: { createdAt: 'desc' },

        skip: (page - 1) * limit,
        take: limit,
      }),

      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: profiles,

      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — DASHBOARD STATISTICS
  //
  // One grouped count query instead of the dashboard paging
  // through every profile client-side to tally statuses.
  // ─────────────────────────────────────────────

  async getStats() {
    const [total, grouped] = await this.prisma.$transaction([
      this.prisma.victimProfile.count(),

      this.prisma.victimProfile.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
    ]);

    const counts = Object.fromEntries(
      Object.values(VictimProfileStatus).map((status) => [status, 0]),
    ) as Record<VictimProfileStatus, number>;

    for (const row of grouped) {
      const rowCount = row._count as { status?: number } | undefined;
      counts[row.status] = rowCount?.status ?? 0;
    }

    return {
      total,
      pending: counts[VictimProfileStatus.PENDING] ?? 0,
      underReview: counts[VictimProfileStatus.UNDER_REVIEW] ?? 0,
      consentPending: counts[VictimProfileStatus.CONSENT_PENDING] ?? 0,
      verified: counts[VictimProfileStatus.VERIFIED] ?? 0,
      approved: counts[VictimProfileStatus.APPROVED] ?? 0,
      published: counts[VictimProfileStatus.PUBLISHED] ?? 0,
      unpublished: counts[VictimProfileStatus.UNPUBLISHED] ?? 0,
      rejected: counts[VictimProfileStatus.REJECTED] ?? 0,
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — AUDIT HISTORY
  //
  // ASSUMPTION: a generic `auditLog` table exists (entity,
  // entityId, action, actorId, previousData, newData, createdAt),
  // fed by the same events this service already emits elsewhere
  // (e.g. an AuditLogListener). Swap this query if your actual
  // audit persistence differs.
  // ─────────────────────────────────────────────

  async getHistory(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const history = await this.prisma.auditLog.findMany({
      where: {
        entity: 'VictimProfile',
        entityId: id,
      },
      orderBy: { createdAt: 'desc' },
    });

    return history;
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET APPROVAL/GATE STATUS
  //
  // Lets the dashboard render a checklist without inspecting the
  // full profile payload (which also includes story text, media
  // arrays, bank details, etc.).
  // ─────────────────────────────────────────────

  async getGates(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: {
        isVerified: true,
        isSafetyReviewed: true,
        isChildSafetyReviewed: true,
        hasConsent: true,
        consentAt: true,
        consentRecordedBy: true,
        isPrivacyReviewed: true,
        isAdminApproved: true,
        involvesChild: true,
        status: true,
        bankAccountName: true,
        bankAccountNumber: true,
        bankName: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    return {
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: profile.hasConsent,
      consentAt: profile.consentAt,
      consentRecordedBy: profile.consentRecordedBy,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: profile.isAdminApproved,

      // Convenience flags so the dashboard doesn't have to
      // re-derive these from raw fields.
      involvesChild: profile.involvesChild,
      childSafetySatisfied: !profile.involvesChild || profile.isChildSafetyReviewed,
      hasBankDetails: this.hasBankDetails(profile),

      status: profile.status,
    };
  }

  // ─────────────────────────────────────────────
  // Shared gate → status derivation, used by updateGates,
  // updateChildSafetyReview, revokeConsent, and resubmit so the
  // waterfall logic lives in exactly one place.
  // ─────────────────────────────────────────────

  private deriveStatus(gates: {
    involvesChild: boolean;
    isVerified: boolean;
    isSafetyReviewed: boolean;
    isChildSafetyReviewed: boolean;
    hasConsent: boolean;
    isPrivacyReviewed: boolean;
    isAdminApproved: boolean;
  }): VictimProfileStatus {
    const childSafetySatisfied = !gates.involvesChild || gates.isChildSafetyReviewed;

    if (!gates.isVerified) {
      return VictimProfileStatus.PENDING;
    }
    if (!gates.isSafetyReviewed || !childSafetySatisfied) {
      return VictimProfileStatus.UNDER_REVIEW;
    }
    if (!gates.hasConsent) {
      return VictimProfileStatus.CONSENT_PENDING;
    }
    if (!gates.isPrivacyReviewed) {
      return VictimProfileStatus.UNDER_REVIEW;
    }
    if (!gates.isAdminApproved) {
      return VictimProfileStatus.VERIFIED;
    }
    return VictimProfileStatus.APPROVED;
  }

  private hasBankDetails(
    profile: Pick<VictimProfile, 'bankAccountName' | 'bankAccountNumber' | 'bankName'>,
  ) {
    return !!profile.bankAccountName && !!profile.bankAccountNumber && !!profile.bankName;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE APPROVAL GATES
  //
  // Gates:
  // 1. Verification
  // 2. Safety review
  // 3. Child-safety review (only enforced when involvesChild)
  // 4. Consent
  // 5. Privacy review
  // 6. Admin approval
  //
  // Admin approval additionally requires the bank transfer
  // destination to be populated — otherwise a published profile
  // would have no way for supporters to actually send money.
  // ─────────────────────────────────────────────

  async updateGates(id: string, data: UpdateVictimGateDto, adminId: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const isVerified = data.isVerified ?? profile.isVerified;
    const isSafetyReviewed = data.isSafetyReviewed ?? profile.isSafetyReviewed;
    const isChildSafetyReviewed = profile.isChildSafetyReviewed;
    const hasConsent = data.hasConsent ?? profile.hasConsent;
    const isPrivacyReviewed = data.isPrivacyReviewed ?? profile.isPrivacyReviewed;
    const isAdminApproved = data.isAdminApproved ?? profile.isAdminApproved;

    const childSafetySatisfied = !profile.involvesChild || isChildSafetyReviewed;
    const hasBankDetails = this.hasBankDetails(profile);

    if (
      isAdminApproved &&
      (!isVerified ||
        !isSafetyReviewed ||
        !childSafetySatisfied ||
        !hasConsent ||
        !isPrivacyReviewed ||
        !hasBankDetails)
    ) {
      throw new BadRequestException('all_approval_gates_required');
    }

    const status = this.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified,
      isSafetyReviewed,
      isChildSafetyReviewed,
      hasConsent,
      isPrivacyReviewed,
      isAdminApproved,
    });

    const updateData = {
      isVerified,
      isSafetyReviewed,
      hasConsent,
      isPrivacyReviewed,
      isAdminApproved,
      status,

      isPublished: false,

      ...(data.hasConsent === true && !profile.hasConsent
        ? { consentAt: new Date(), consentRecordedBy: adminId }
        : {}),
    };

    const updatedProfile = await this.prisma.victimProfile.update({
      where: { id },
      data: updateData,
    });

    this.eventEmitter.emit('victim_profile.gates_updated', {
      actorId: adminId,
      victimProfileId: id,
      action: 'UPDATE_APPROVAL_GATES',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: status,

      previousGates: {
        isVerified: profile.isVerified,
        isSafetyReviewed: profile.isSafetyReviewed,
        hasConsent: profile.hasConsent,
        isPrivacyReviewed: profile.isPrivacyReviewed,
        isAdminApproved: profile.isAdminApproved,
      },

      newGates: {
        isVerified,
        isSafetyReviewed,
        hasConsent,
        isPrivacyReviewed,
        isAdminApproved,
      },
    });

    this.eventEmitter.emit('notification.victim_profile.gates_updated', {
      actorId: adminId,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — CHILD SAFETY REVIEW (§32)
  //
  // Split out from updateGates so this specific, higher-stakes
  // review always gets its own audit event and reviewer notes,
  // rather than riding along inside a generic gates patch.
  // ─────────────────────────────────────────────

  async updateChildSafetyReview(id: string, data: UpdateChildSafetyReviewDto, adminId: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (!profile.involvesChild) {
      throw new BadRequestException('child_safety_review_not_applicable');
    }

    const status = this.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: data.isChildSafetyReviewed,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: profile.isAdminApproved,
    });

    // A profile that was previously admin-approved can no longer
    // hold that approval if its child-safety review is reversed.
    const isAdminApproved = data.isChildSafetyReviewed ? profile.isAdminApproved : false;

    const updatedProfile = await this.prisma.victimProfile.update({
      where: { id },
      data: {
        isChildSafetyReviewed: data.isChildSafetyReviewed,
        isAdminApproved,
        status,
        isPublished: isAdminApproved ? profile.isPublished : false,
      },
    });

    this.eventEmitter.emit('victim_profile.child_safety_reviewed', {
      actorId: adminId,
      victimProfileId: id,
      action: 'UPDATE_CHILD_SAFETY_REVIEW',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: status,

      isChildSafetyReviewed: data.isChildSafetyReviewed,
      reviewNotes: data.reviewNotes,
    });

    this.eventEmitter.emit('notification.victim_profile.child_safety_reviewed', {
      actorId: adminId,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVOKE CONSENT
  //
  // Consent could previously only move false → true via
  // updateGates. This lets a recorded consent be withdrawn later
  // (e.g. the survivor changes their mind), dropping the profile
  // out of the approved/published state until consent is re-recorded.
  // ─────────────────────────────────────────────

  async revokeConsent(id: string, data: RevokeConsentDto, adminId: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (!profile.hasConsent) {
      throw new BadRequestException('consent_not_currently_recorded');
    }

    const status = this.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: false,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: false,
    });

    const updatedProfile = await this.prisma.victimProfile.update({
      where: { id },
      data: {
        hasConsent: false,
        consentAt: null,
        consentRecordedBy: null,

        isAdminApproved: false,
        isPublished: false,
        status,
      },
    });

    this.eventEmitter.emit('victim_profile.consent_revoked', {
      actorId: adminId,
      victimProfileId: id,
      action: 'REVOKE_CONSENT',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: status,

      previousConsentAt: profile.consentAt,
      previousConsentRecordedBy: profile.consentRecordedBy,

      reason: data.reason,
    });

    this.eventEmitter.emit('notification.victim_profile.consent_revoked', {
      actorId: adminId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE BANK DETAILS
  //
  // Lets the transfer destination be corrected without resetting
  // the whole approval pipeline via the generic update(). If the
  // profile was already admin-approved / published, that approval
  // is revoked so a human re-confirms the *new* destination before
  // supporters can send money to it.
  // ─────────────────────────────────────────────

  async updateBankDetails(id: string, data: UpdateBankDetailsDto, adminId: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const wasApproved = profile.isAdminApproved;

    const isAdminApproved = wasApproved ? false : profile.isAdminApproved;

    const status = this.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved,
    });

    const updatedProfile = await this.prisma.victimProfile.update({
      where: { id },
      data: {
        bankAccountName: data.bankAccountName,
        bankAccountNumber: data.bankAccountNumber,
        bankName: data.bankName,

        isAdminApproved,
        isPublished: wasApproved ? false : profile.isPublished,
        status,
      },
    });

    this.eventEmitter.emit('victim_profile.bank_details_updated', {
      actorId: adminId,
      victimProfileId: id,
      action: 'UPDATE_BANK_DETAILS',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: status,

      reapprovalRequired: wasApproved,
    });

    this.eventEmitter.emit('notification.victim_profile.bank_details_updated', {
      actorId: adminId,
      victimProfileId: id,
      reapprovalRequired: wasApproved,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — PUBLISH
  // ─────────────────────────────────────────────

  async publish(id: string, adminId: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const hasBankDetails = this.hasBankDetails(profile);

    const childSafetySatisfied = !profile.involvesChild || profile.isChildSafetyReviewed;

    const allGatesSatisfied =
      profile.isVerified &&
      profile.isSafetyReviewed &&
      childSafetySatisfied &&
      profile.hasConsent &&
      profile.isPrivacyReviewed &&
      profile.isAdminApproved &&
      hasBankDetails;

    if (!allGatesSatisfied) {
      throw new BadRequestException('all_approval_gates_required');
    }

    const updatedProfile = await this.prisma.victimProfile.update({
      where: { id },

      data: {
        status: VictimProfileStatus.PUBLISHED,
        isPublished: true,
      },
    });

    this.eventEmitter.emit('victim_profile.published', {
      actorId: adminId,
      victimProfileId: id,
      action: 'PUBLISH',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: VictimProfileStatus.PUBLISHED,
    });

    this.eventEmitter.emit('notification.victim_profile.published', {
      actorId: adminId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UNPUBLISH
  // ─────────────────────────────────────────────

  async unpublish(id: string, adminId: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (!profile.isPublished) {
      throw new BadRequestException('victim_profile_not_published');
    }

    const updatedProfile = await this.prisma.victimProfile.update({
      where: { id },

      data: {
        status: VictimProfileStatus.UNPUBLISHED,
        isPublished: false,
      },
    });

    this.eventEmitter.emit('victim_profile.unpublished', {
      actorId: adminId,
      victimProfileId: id,
      action: 'UNPUBLISH',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: VictimProfileStatus.UNPUBLISHED,
    });

    this.eventEmitter.emit('notification.victim_profile.unpublished', {
      actorId: adminId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REJECT
  // ─────────────────────────────────────────────

  async reject(id: string, adminId: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (profile.isPublished) {
      throw new BadRequestException('published_profile_cannot_be_rejected');
    }

    const updatedProfile = await this.prisma.victimProfile.update({
      where: { id },

      data: {
        status: VictimProfileStatus.REJECTED,
        isPublished: false,
      },
    });

    this.eventEmitter.emit('victim_profile.rejected', {
      actorId: adminId,
      victimProfileId: id,
      action: 'REJECT',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: VictimProfileStatus.REJECTED,
    });

    this.eventEmitter.emit('notification.victim_profile.rejected', {
      actorId: adminId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — RESUBMIT AFTER REJECTION
  //
  // Reject() is a dead end today — nothing moves a REJECTED
  // profile back into the pipeline short of a full update() that
  // also wipes unrelated content. This recomputes status from the
  // gates as they currently stand (gates are left untouched by
  // reject(), so whatever was true/false before rejection still
  // applies) rather than blindly resetting to PENDING.
  // ─────────────────────────────────────────────

  async resubmit(id: string, adminId: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (profile.status !== VictimProfileStatus.REJECTED) {
      throw new BadRequestException('victim_profile_not_rejected');
    }

    const status = this.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: profile.isAdminApproved,
    });

    const updatedProfile = await this.prisma.victimProfile.update({
      where: { id },
      data: {
        status,
        isPublished: false,
      },
    });

    this.eventEmitter.emit('victim_profile.resubmitted', {
      actorId: adminId,
      victimProfileId: id,
      action: 'RESUBMIT',
      entity: 'VictimProfile',

      previousStatus: profile.status,
      newStatus: status,
    });

    this.eventEmitter.emit('notification.victim_profile.resubmitted', {
      actorId: adminId,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }
}

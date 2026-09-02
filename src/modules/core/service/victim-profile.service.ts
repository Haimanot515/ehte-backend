import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { VictimProfileStatus } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import {
  CreateVictimProfileDto,
  FindAllVictimProfilesQueryDto,
  UpdateVictimGateDto,
  UpdateVictimProfileDto,
} from '../dto/victim-profile.dto';

@Injectable()
export class VictimProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // CREATE
  // ─────────────────────────────────────────────

  async create(currentUser: CurrentUserDto, data: CreateVictimProfileDto) {
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
  // GET ONE
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
  // PUBLIC PROFILES
  // ─────────────────────────────────────────────

  async findPublic() {
    const profiles = await this.prisma.victimProfile.findMany({
      where: {
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

      orderBy: { createdAt: 'desc' },
    });

    return profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      story: profile.story,
      supportType: profile.supportType,
      supportGoal: profile.supportGoal,

      bankAccountName: profile.bankAccountName,
      bankAccountNumber: profile.bankAccountNumber,
      bankName: profile.bankName,

      // Child profiles never expose photos publicly.
      photo: profile.involvesChild ? [] : profile.photo,
    }));
  }

  // ─────────────────────────────────────────────
  // UPDATE PROFILE
  // ─────────────────────────────────────────────

  async update(currentUser: CurrentUserDto, id: string, data: UpdateVictimProfileDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

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
        hasConsent: false,

        consentAt: null,
        consentRecordedBy: null,

        isPrivacyReviewed: false,
        isAdminApproved: false,
        isPublished: false,
      },
    });

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
  // ─────────────────────────────────────────────

  async remove(currentUser: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    await this.prisma.victimProfile.delete({ where: { id } });

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
  // ADMIN — UPDATE APPROVAL GATES
  //
  // Five gates:
  // 1. Verification
  // 2. Safety review
  // 3. Consent
  // 4. Privacy review
  // 5. Admin approval
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
    const hasConsent = data.hasConsent ?? profile.hasConsent;
    const isPrivacyReviewed = data.isPrivacyReviewed ?? profile.isPrivacyReviewed;
    const isAdminApproved = data.isAdminApproved ?? profile.isAdminApproved;

    const childSafetySatisfied = !profile.involvesChild || isSafetyReviewed;

    const hasBankDetails =
      !!profile.bankAccountName && !!profile.bankAccountNumber && !!profile.bankName;

    if (
      isAdminApproved &&
      (!isVerified ||
        !isSafetyReviewed ||
        !hasConsent ||
        !isPrivacyReviewed ||
        !childSafetySatisfied ||
        !hasBankDetails)
    ) {
      throw new BadRequestException('all_approval_gates_required');
    }

    let status: VictimProfileStatus = VictimProfileStatus.UNDER_REVIEW;

    if (!isVerified) {
      status = VictimProfileStatus.PENDING;
    } else if (!isSafetyReviewed) {
      status = VictimProfileStatus.UNDER_REVIEW;
    } else if (!hasConsent) {
      status = VictimProfileStatus.CONSENT_PENDING;
    } else if (!isPrivacyReviewed) {
      status = VictimProfileStatus.UNDER_REVIEW;
    } else if (!isAdminApproved) {
      status = VictimProfileStatus.VERIFIED;
    } else {
      status = VictimProfileStatus.APPROVED;
    }

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
  // ADMIN — PUBLISH
  // ─────────────────────────────────────────────

  async publish(id: string, adminId: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const hasBankDetails =
      !!profile.bankAccountName && !!profile.bankAccountNumber && !!profile.bankName;

    const allGatesSatisfied =
      profile.isVerified &&
      profile.isSafetyReviewed &&
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
}

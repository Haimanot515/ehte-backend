import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  VictimProfileStatus,
} from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import {
  CreateVictimProfileDto,
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

  async create(
    currentUser: CurrentUserDto,
    data: CreateVictimProfileDto,
  ) {
    const profile =
      await this.prisma.victimProfile.create({
        data: {
          name: data.name,
          description: data.description,
          story: data.story,

          supportType:
            data.supportType,

          supportGoal:
            data.supportGoal,

          photo:
            data.photo ?? [],

          video:
            data.video ?? [],

          audio:
            data.audio ?? [],

          pdf:
            data.pdf ?? [],

          document:
            data.document ?? [],

          other:
            data.other ?? [],

          involvesChild:
            data.involvesChild ?? false,

          status:
            VictimProfileStatus.PENDING,

          isVerified: false,
          isSafetyReviewed: false,
          hasConsent: false,
          isPrivacyReviewed: false,
          isAdminApproved: false,
          isPublished: false,
        },
      });

    // ─────────────────────────────────────────────
    // AUDIT LOG EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'victim_profile.created',
      {
        actorId: currentUser.id,
        victimProfileId: profile.id,
        action: 'CREATE',
        entity: 'VictimProfile',
      },
    );

    // ─────────────────────────────────────────────
    // NOTIFICATION EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'notification.victim_profile.created',
      {
        actorId: currentUser.id,
        victimProfileId: profile.id,
      },
    );

    return profile;
  }

  // ─────────────────────────────────────────────
  // GET ONE
  // ─────────────────────────────────────────────

  async findOne(
    id: string,
  ) {
    const profile =
      await this.prisma.victimProfile.findUnique({
        where: {
          id,
        },

        include: {
          supports: {
            where: {
              status: 'CONFIRMED',
            },

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
      throw new NotFoundException(
        'victim_profile_not_found',
      );
    }

    return profile;
  }

  // ─────────────────────────────────────────────
  // PUBLIC PROFILES
  // ─────────────────────────────────────────────

  async findPublic() {
    return this.prisma.victimProfile.findMany({
      where: {
        status:
          VictimProfileStatus.PUBLISHED,

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
        description: true,
        story: true,

        supportType: true,
        supportGoal: true,

        photo: true,
        video: true,
        audio: true,
        pdf: true,
        document: true,
        other: true,

        involvesChild: true,

        status: true,
        isPublished: true,

        createdAt: true,
        updatedAt: true,
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // UPDATE PROFILE
  // ─────────────────────────────────────────────

  async update(
    currentUser: CurrentUserDto,
    id: string,
    data: UpdateVictimProfileDto,
  ) {
    const profile =
      await this.prisma.victimProfile.findUnique({
        where: {
          id,
        },
      });

    if (!profile) {
      throw new NotFoundException(
        'victim_profile_not_found',
      );
    }

    const updatedProfile =
      await this.prisma.victimProfile.update({
        where: {
          id,
        },

        data: {
          name:
            data.name,

          description:
            data.description,

          story:
            data.story,

          supportType:
            data.supportType,

          supportGoal:
            data.supportGoal,

          photo:
            data.photo,

          video:
            data.video,

          audio:
            data.audio,

          pdf:
            data.pdf,

          document:
            data.document,

          other:
            data.other,

          involvesChild:
            data.involvesChild,

          // Reset approval pipeline
          status:
            VictimProfileStatus.PENDING,

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

    // ─────────────────────────────────────────────
    // AUDIT LOG EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'victim_profile.updated',
      {
        actorId: currentUser.id,
        victimProfileId: id,
        action: 'UPDATE',
        entity: 'VictimProfile',
        previousStatus: profile.status,
        newStatus: VictimProfileStatus.PENDING,
      },
    );

    // ─────────────────────────────────────────────
    // NOTIFICATION EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'notification.victim_profile.updated',
      {
        actorId: currentUser.id,
        victimProfileId: id,
      },
    );

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────

  async remove(
    currentUser: CurrentUserDto,
    id: string,
  ) {
    const profile =
      await this.prisma.victimProfile.findUnique({
        where: {
          id,
        },
      });

    if (!profile) {
      throw new NotFoundException(
        'victim_profile_not_found',
      );
    }

    await this.prisma.victimProfile.delete({
      where: {
        id,
      },
    });

    // ─────────────────────────────────────────────
    // AUDIT LOG EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'victim_profile.deleted',
      {
        actorId: currentUser.id,
        victimProfileId: id,
        action: 'DELETE',
        entity: 'VictimProfile',
      },
    );

    // ─────────────────────────────────────────────
    // NOTIFICATION EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'notification.victim_profile.deleted',
      {
        actorId: currentUser.id,
        victimProfileId: id,
      },
    );

    return {
      message:
        'victim_profile_deleted',
    };
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ALL
  // ─────────────────────────────────────────────

  async findAllForAdmin(
    status?: VictimProfileStatus,
  ) {
    return this.prisma.victimProfile.findMany({
      where: {
        ...(status !== undefined
          ? {
              status,
            }
          : {}),
      },

      include: {
        supports: {
          orderBy: {
            createdAt: 'desc',
          },
        },
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE APPROVAL GATES
  // ─────────────────────────────────────────────

  async updateGates(
    id: string,
    data: UpdateVictimGateDto,
    adminId: string,
  ) {
    const profile =
      await this.prisma.victimProfile.findUnique({
        where: {
          id,
        },
      });

    if (!profile) {
      throw new NotFoundException(
        'victim_profile_not_found',
      );
    }

    const isVerified =
      data.isVerified ??
      profile.isVerified;

    const isSafetyReviewed =
      data.isSafetyReviewed ??
      profile.isSafetyReviewed;

    const hasConsent =
      data.hasConsent ??
      profile.hasConsent;

    const isPrivacyReviewed =
      data.isPrivacyReviewed ??
      profile.isPrivacyReviewed;

    const isAdminApproved =
      data.isAdminApproved ??
      profile.isAdminApproved;

    // ─────────────────────────────────────────────
    // ADMIN APPROVAL REQUIRES ALL GATES
    // ─────────────────────────────────────────────

    if (
      isAdminApproved &&
      (
        !isVerified ||
        !isSafetyReviewed ||
        !hasConsent ||
        !isPrivacyReviewed
      )
    ) {
      throw new BadRequestException(
        'all_approval_gates_required',
      );
    }

    // ─────────────────────────────────────────────
    // DETERMINE STATUS
    // ─────────────────────────────────────────────

    let status: VictimProfileStatus =
      VictimProfileStatus.UNDER_REVIEW;

    if (!isVerified) {
      status =
        VictimProfileStatus.PENDING;
    } else if (!isSafetyReviewed) {
      status =
        VictimProfileStatus.UNDER_REVIEW;
    } else if (!hasConsent) {
      status =
        VictimProfileStatus.CONSENT_PENDING;
    } else if (!isPrivacyReviewed) {
      status =
        VictimProfileStatus.UNDER_REVIEW;
    } else if (!isAdminApproved) {
      status =
        VictimProfileStatus.VERIFIED;
    } else {
      status =
        VictimProfileStatus.APPROVED;
    }

    // ─────────────────────────────────────────────
    // UPDATE DATA
    // ─────────────────────────────────────────────

    const updateData: {
      isVerified: boolean;
      isSafetyReviewed: boolean;
      hasConsent: boolean;
      isPrivacyReviewed: boolean;
      isAdminApproved: boolean;
      status: VictimProfileStatus;
      consentAt?: Date | null;
      consentRecordedBy?: string | null;
      isPublished?: boolean;
    } = {
      isVerified,

      isSafetyReviewed,

      hasConsent,

      isPrivacyReviewed,

      isAdminApproved,

      status,
    };

    // ─────────────────────────────────────────────
    // RECORD CONSENT
    // ─────────────────────────────────────────────

    if (
      data.hasConsent === true &&
      !profile.hasConsent
    ) {
      updateData.consentAt =
        new Date();

      updateData.consentRecordedBy =
        adminId;
    }

    // ─────────────────────────────────────────────
    // REVOKING GATE STOPS PUBLICATION
    // ─────────────────────────────────────────────

    if (
      !isVerified ||
      !isSafetyReviewed ||
      !hasConsent ||
      !isPrivacyReviewed ||
      !isAdminApproved
    ) {
      updateData.isPublished =
        false;
    }

    // ─────────────────────────────────────────────
    // SAVE
    // ─────────────────────────────────────────────

    const updatedProfile =
      await this.prisma.victimProfile.update({
        where: {
          id,
        },

        data: updateData,
      });

    // ─────────────────────────────────────────────
    // AUDIT LOG EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'victim_profile.gates_updated',
      {
        actorId: adminId,
        victimProfileId: id,
        action: 'UPDATE_APPROVAL_GATES',
        entity: 'VictimProfile',

        previousStatus:
          profile.status,

        newStatus:
          status,

        previousGates: {
          isVerified:
            profile.isVerified,

          isSafetyReviewed:
            profile.isSafetyReviewed,

          hasConsent:
            profile.hasConsent,

          isPrivacyReviewed:
            profile.isPrivacyReviewed,

          isAdminApproved:
            profile.isAdminApproved,
        },

        newGates: {
          isVerified,

          isSafetyReviewed,

          hasConsent,

          isPrivacyReviewed,

          isAdminApproved,
        },
      },
    );

    // ─────────────────────────────────────────────
    // NOTIFICATION EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'notification.victim_profile.gates_updated',
      {
        actorId: adminId,
        victimProfileId: id,
        status,
      },
    );

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — PUBLISH
  // ─────────────────────────────────────────────

  async publish(
    id: string,
    adminId: string,
  ) {
    const profile =
      await this.prisma.victimProfile.findUnique({
        where: {
          id,
        },
      });

    if (!profile) {
      throw new NotFoundException(
        'victim_profile_not_found',
      );
    }

    // ─────────────────────────────────────────────
    // ALL GATES MUST PASS
    // ─────────────────────────────────────────────

    if (
      !profile.isVerified ||
      !profile.isSafetyReviewed ||
      !profile.hasConsent ||
      !profile.isPrivacyReviewed ||
      !profile.isAdminApproved
    ) {
      throw new BadRequestException(
        'all_approval_gates_required',
      );
    }

    const updatedProfile =
      await this.prisma.victimProfile.update({
        where: {
          id,
        },

        data: {
          status:
            VictimProfileStatus.PUBLISHED,

          isPublished: true,
        },
      });

    // ─────────────────────────────────────────────
    // AUDIT LOG EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'victim_profile.published',
      {
        actorId: adminId,
        victimProfileId: id,
        action: 'PUBLISH',
        entity: 'VictimProfile',

        previousStatus:
          profile.status,

        newStatus:
          VictimProfileStatus.PUBLISHED,
      },
    );

    // ─────────────────────────────────────────────
    // NOTIFICATION EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'notification.victim_profile.published',
      {
        actorId: adminId,
        victimProfileId: id,
      },
    );

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — UNPUBLISH
  // ─────────────────────────────────────────────

  async unpublish(
    id: string,
    adminId: string,
  ) {
    const profile =
      await this.prisma.victimProfile.findUnique({
        where: {
          id,
        },
      });

    if (!profile) {
      throw new NotFoundException(
        'victim_profile_not_found',
      );
    }

    const updatedProfile =
      await this.prisma.victimProfile.update({
        where: {
          id,
        },

        data: {
          isPublished: false,

          status:
            VictimProfileStatus.UNPUBLISHED,
        },
      });

    // ─────────────────────────────────────────────
    // AUDIT LOG EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'victim_profile.unpublished',
      {
        actorId: adminId,
        victimProfileId: id,
        action: 'UNPUBLISH',
        entity: 'VictimProfile',

        previousStatus:
          profile.status,

        newStatus:
          VictimProfileStatus.UNPUBLISHED,
      },
    );

    // ─────────────────────────────────────────────
    // NOTIFICATION EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'notification.victim_profile.unpublished',
      {
        actorId: adminId,
        victimProfileId: id,
      },
    );

    return updatedProfile;
  }

  // ─────────────────────────────────────────────
  // ADMIN — REJECT
  // ─────────────────────────────────────────────

  async reject(
    id: string,
    adminId: string,
  ) {
    const profile =
      await this.prisma.victimProfile.findUnique({
        where: {
          id,
        },
      });

    if (!profile) {
      throw new NotFoundException(
        'victim_profile_not_found',
      );
    }

    const updatedProfile =
      await this.prisma.victimProfile.update({
        where: {
          id,
        },

        data: {
          status:
            VictimProfileStatus.REJECTED,

          isPublished: false,

          isAdminApproved: false,
        },
      });

    // ─────────────────────────────────────────────
    // AUDIT LOG EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'victim_profile.rejected',
      {
        actorId: adminId,
        victimProfileId: id,
        action: 'REJECT',
        entity: 'VictimProfile',

        previousStatus:
          profile.status,

        newStatus:
          VictimProfileStatus.REJECTED,
      },
    );

    // ─────────────────────────────────────────────
    // NOTIFICATION EVENT
    // ─────────────────────────────────────────────

    this.eventEmitter.emit(
      'notification.victim_profile.rejected',
      {
        actorId: adminId,
        victimProfileId: id,
      },
    );

    return updatedProfile;
  }
}
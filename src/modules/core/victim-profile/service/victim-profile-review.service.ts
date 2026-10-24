import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { AuditOutcome, VictimProfileStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { FindAllVictimProfilesQueryDto, UpdateVictimGateDto } from '../dto/victim-profile.dto';
import { STALE_ELIGIBLE_EXCLUDED_STATUSES, STATUS_TRANSITIONS } from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  async claim(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (existing.claimedByUserId === admin.id) {
      return existing;
    }
    if (existing.claimedByUserId) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CLAIMED,
        existing,
        'victim_profile_already_claimed',
        {
          outcome: AuditOutcome.DENIED,
          metadata: { claimedByUserId: existing.claimedByUserId },
        },
      );
      throw new ForbiddenException('victim_profile_already_claimed');
    }

    const result = await this.prisma.victimProfile.updateMany({
      where: { id, claimedByUserId: null },
      data: { claimedByUserId: admin.id, claimedAt: new Date() },
    });

    if (result.count === 0) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CLAIMED,
        existing,
        'victim_profile_already_claimed',
        {
          outcome: AuditOutcome.DENIED,
          metadata: { lostRace: true },
        },
      );
      throw new ForbiddenException('victim_profile_already_claimed');
    }

    const profile = await this.prisma.victimProfile.findUniqueOrThrow({ where: { id } });

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_CLAIMED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.victimProfileCommonService.profileLabel(profile),
      diff: {
        result: 'success',
      },
    });

    return profile;
  }

  async unclaim(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (!existing.claimedByUserId) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_UNCLAIMED,
        existing,
        'victim_profile_not_claimed',
      );
      throw new BadRequestException('victim_profile_not_claimed');
    }

    const roles = this.victimProfileCommonService.getRoles(admin);
    const isSuperAdmin = roles.includes(RolesEnum.SUPER_ADMIN);

    if (!isSuperAdmin && existing.claimedByUserId !== admin.id) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_UNCLAIMED,
        existing,
        'claimed_by_another_admin',
        {
          outcome: AuditOutcome.DENIED,
          metadata: { claimedByUserId: existing.claimedByUserId },
        },
      );
      throw new ForbiddenException('victim_profile_claimed_by_another_admin');
    }

    const result = await this.prisma.victimProfile.updateMany({
      where: { id, claimedByUserId: existing.claimedByUserId },
      data: { claimedByUserId: null, claimedAt: null },
    });

    if (result.count === 0) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_UNCLAIMED,
        existing,
        'victim_profile_transition_conflict',
      );
      throw new BadRequestException('victim_profile_transition_conflict');
    }

    const profile = await this.prisma.victimProfile.findUniqueOrThrow({ where: { id } });

    const overrodeAnotherAdmin = existing.claimedByUserId !== admin.id;

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      ...(overrodeAnotherAdmin ? { targetUserId: existing.claimedByUserId } : {}),
      actorType: resolveActorType(roles),
      action: AuditEventEnum.VICTIM_PROFILE_UNCLAIMED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.victimProfileCommonService.profileLabel(profile),
      diff: {
        previousClaimedByUserId: existing.claimedByUserId,
        result: 'success',
      },
      metadata: { overrodeAnotherAdmin },
    });

    return profile;
  }

  async findAllForAdmin(query: FindAllVictimProfilesQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;

    const where = query.status !== undefined ? { status: query.status } : {};

    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
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

  async findStalePending() {
    const staleHours = Number(
      this.configService.get<string>('PROFILE_STALE_PENDING_HOURS') ??
        this.configService.get<string>('CONTENT_STALE_PENDING_HOURS') ??
        48,
    );
    const staleChildHours = Number(
      this.configService.get<string>('PROFILE_STALE_CHILD_HOURS') ?? 12,
    );

    const now = Date.now();
    const standardCutoff = new Date(now - staleHours * 60 * 60 * 1000);
    const childCutoff = new Date(now - staleChildHours * 60 * 60 * 1000);

    const profiles = await this.prisma.victimProfile.findMany({
      where: {
        status: { notIn: STALE_ELIGIBLE_EXCLUDED_STATUSES },
        claimedByUserId: null,
        OR: [
          { involvesChild: true, createdAt: { lt: childCutoff } },
          { involvesChild: false, createdAt: { lt: standardCutoff } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    return profiles.map((profile) => ({
      ...profile,
      pendingHours: Math.floor((now - profile.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
  }

  async getHistory(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    return this.prisma.auditLog.findMany({
      where: {
        entity: 'VictimProfile',
        entityId: id,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getGates(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: {
        isVerified: true,
        isSafetyReviewed: true,
        isChildSafetyReviewed: true,
        childSafetyFirstConfirmedByUserId: true,
        childSafetyFirstConfirmedAt: true,
        hasConsent: true,
        consentAt: true,
        consentRecordedBy: true,
        isPrivacyReviewed: true,
        isAdminApproved: true,
        involvesChild: true,
        status: true,
        claimedByUserId: true,
        claimedAt: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    return {
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      childSafetyFirstConfirmedByUserId: profile.childSafetyFirstConfirmedByUserId,
      childSafetyFirstConfirmedAt: profile.childSafetyFirstConfirmedAt,
      hasConsent: profile.hasConsent,
      consentAt: profile.consentAt,
      consentRecordedBy: profile.consentRecordedBy,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: profile.isAdminApproved,

      involvesChild: profile.involvesChild,
      childSafetySatisfied: !profile.involvesChild || profile.isChildSafetyReviewed,
      hasBankDetails: await this.victimProfileCommonService.hasBankDetails(id),

      claimedByUserId: profile.claimedByUserId,
      claimedAt: profile.claimedAt,

      status: profile.status,
    };
  }

  async updateGates(admin: CurrentUserDto, id: string, data: UpdateVictimGateDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_GATES_UPDATED,
    );

    const isVerified = data.isVerified ?? profile.isVerified;
    const isSafetyReviewed = data.isSafetyReviewed ?? profile.isSafetyReviewed;
    const isChildSafetyReviewed = profile.isChildSafetyReviewed;
    const hasConsent = data.hasConsent ?? profile.hasConsent;
    const isPrivacyReviewed = data.isPrivacyReviewed ?? profile.isPrivacyReviewed;
    const isAdminApproved = data.isAdminApproved ?? profile.isAdminApproved;

    const childSafetySatisfied = !profile.involvesChild || isChildSafetyReviewed;
    const hasBankDetails = await this.victimProfileCommonService.hasBankDetails(id);

    if (
      isAdminApproved &&
      (!isVerified ||
        !isSafetyReviewed ||
        !childSafetySatisfied ||
        !hasConsent ||
        !isPrivacyReviewed ||
        !hasBankDetails)
    ) {
      const missingGates = this.victimProfileCommonService.getMissingApprovalGates({
        involvesChild: profile.involvesChild,
        isVerified,
        isSafetyReviewed,
        isChildSafetyReviewed,
        hasConsent,
        isPrivacyReviewed,
        hasBankDetails,
      });

      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_GATES_UPDATED,
        profile,
        'all_approval_gates_required',
        { metadata: { missingGates } },
      );
      throw new BadRequestException({
        message: 'all_approval_gates_required',
        missingGates,
      });
    }

    const status = this.victimProfileCommonService.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified,
      isSafetyReviewed,
      isChildSafetyReviewed,
      hasConsent,
      isPrivacyReviewed,
      isAdminApproved,
    });

    const consentNewlyRecorded = data.hasConsent === true && !profile.hasConsent;

    const updatedProfile = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        isVerified,
        isSafetyReviewed,
        hasConsent,
        isPrivacyReviewed,
        isAdminApproved,
        status,
        isPublished: false,
        ...(consentNewlyRecorded ? { consentAt: new Date(), consentRecordedBy: admin.id } : {}),
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_GATES_UPDATED, profile },
    );

    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      ...this.victimProfileCommonService.targetUserFor(admin, profile),
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_GATES_UPDATED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.victimProfileCommonService.profileLabel(profile),
      diff: {
        result: 'success',
        previousStatus: profile.status,
        newStatus: status,
        previousIsPublished: profile.isPublished,
        newIsPublished: false,

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
      },
      metadata: { consentNewlyRecorded },
    });

    // Each approval gate that was just switched on also gets its own audit action.
    const gatesSwitchedOn: Array<[boolean, AuditEventEnum]> = [
      [!profile.isVerified && isVerified, AuditEventEnum.VICTIM_PROFILE_VERIFIED],
      [
        !profile.isPrivacyReviewed && isPrivacyReviewed,
        AuditEventEnum.VICTIM_PROFILE_PRIVACY_REVIEWED,
      ],
      [!profile.isAdminApproved && isAdminApproved, AuditEventEnum.VICTIM_PROFILE_APPROVED],
    ];
    for (const [switchedOn, gateAction] of gatesSwitchedOn) {
      if (!switchedOn) continue;
      this.victimProfileCommonService.emitAudit({
        userId: admin.id,
        ...this.victimProfileCommonService.targetUserFor(admin, profile),
        actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
        action: gateAction,
        entity: 'VictimProfile',
        entityId: id,
        entityLabel: this.victimProfileCommonService.profileLabel(profile),
        diff: { result: 'success', previousStatus: profile.status, newStatus: status },
      });
    }

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_GATES_UPDATED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }

  async publish(admin: CurrentUserDto, id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
    );

    const hasBankDetails = await this.victimProfileCommonService.hasBankDetails(id);
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
      const missingGates = this.victimProfileCommonService.getMissingApprovalGates({
        involvesChild: profile.involvesChild,
        isVerified: profile.isVerified,
        isSafetyReviewed: profile.isSafetyReviewed,
        isChildSafetyReviewed: profile.isChildSafetyReviewed,
        hasConsent: profile.hasConsent,
        isPrivacyReviewed: profile.isPrivacyReviewed,
        hasBankDetails,
      });
      if (!profile.isAdminApproved) missingGates.push('isAdminApproved');

      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
        profile,
        'all_approval_gates_required',
        { diff: { currentStatus: profile.status }, metadata: { missingGates } },
      );
      throw new BadRequestException({
        message: 'all_approval_gates_required',
        missingGates,
      });
    }

    const updatedProfile = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        status: VictimProfileStatus.PUBLISHED,
        isPublished: true,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_PUBLISHED, profile },
    );

    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      ...this.victimProfileCommonService.targetUserFor(admin, profile),
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.victimProfileCommonService.profileLabel(profile),
      diff: {
        result: 'success',
        previousStatus: profile.status,
        newStatus: VictimProfileStatus.PUBLISHED,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_PUBLISHED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
    });

    return updatedProfile;
  }

  // VP-65
  async getTransitions(admin: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);

    const missingGates = this.victimProfileCommonService.getMissingApprovalGates({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      hasBankDetails: await this.victimProfileCommonService.hasBankDetails(id),
    });
    if (!profile.isAdminApproved) missingGates.push('isAdminApproved');

    const blockers: string[] = [];
    if (profile.deletedAt) blockers.push('deleted');
    if (profile.legalHold) blockers.push('legal_hold');
    if (profile.takedownAt) blockers.push('taken_down');

    const roles = this.victimProfileCommonService.getRoles(admin);
    const claimedByOther =
      !roles.includes(RolesEnum.SUPER_ADMIN) &&
      !!profile.claimedByUserId &&
      profile.claimedByUserId !== admin.id;

    return {
      current: profile.status,
      claimedByAnotherAdmin: claimedByOther,
      blockers,
      allowed: STATUS_TRANSITIONS[profile.status].map((t) => ({
        ...t,
        available:
          !claimedByOther &&
          !profile.deletedAt &&
          !(
            t.to === VictimProfileStatus.PUBLISHED &&
            (missingGates.length > 0 || !!profile.takedownAt)
          ),
        blockedBy:
          t.to === VictimProfileStatus.PUBLISHED && profile.status === VictimProfileStatus.APPROVED
            ? missingGates
            : [],
      })),
    };
  }
}
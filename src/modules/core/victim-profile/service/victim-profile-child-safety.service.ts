import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditOutcome, AuditSeverity } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  RecordConsentDto,
  RevokeConsentDto,
  UpdateChildFlagDto,
  UpdateChildSafetyReviewDto,
} from '../dto/victim-profile.dto';
import {
  PIPELINE_STATUSES,
  GATE_DRIVEN_STATUSES,
  CHILD_FLAG_PROPOSAL_TTL_MS,
} from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileChildSafetyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly cache: CacheService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  async updateChildSafetyReview(
    admin: CurrentUserDto,
    id: string,
    data: UpdateChildSafetyReviewDto,
  ) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
    );

    if (!profile.involvesChild) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
        profile,
        'child_safety_review_not_applicable',
      );
      throw new BadRequestException('child_safety_review_not_applicable');
    }

    if (data.isChildSafetyReviewed) {
      if (!profile.childSafetyFirstConfirmedByUserId) {
        const updated = await this.victimProfileCommonService.conditionalUpdate(
          id,
          profile.updatedAt,
          {
            childSafetyFirstConfirmedByUserId: admin.id,
            childSafetyFirstConfirmedAt: new Date(),
          },
          {
            admin,
            action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_FIRST_CONFIRMED,
            profile,
          },
        );

        this.victimProfileCommonService.emitAudit({
          userId: admin.id,
          ...this.victimProfileCommonService.targetUserFor(admin, profile),
          actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
          action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_FIRST_CONFIRMED,
          entity: 'VictimProfile',
          entityId: id,
          entityLabel: this.victimProfileCommonService.profileLabel(profile),
          reason: data.reviewNotes ?? null,
          diff: { result: 'success' },
          metadata: { stage: 'first_confirmation' },
        });

        return updated;
      }

      if (profile.childSafetyFirstConfirmedByUserId === admin.id) {
        this.victimProfileCommonService.emitProfileFailure(
          admin,
          AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
          profile,
          'child_safety_review_requires_second_admin',
          {
            outcome: AuditOutcome.DENIED,
            metadata: { firstConfirmedBy: profile.childSafetyFirstConfirmedByUserId },
          },
        );
        throw new BadRequestException('child_safety_review_requires_second_admin');
      }

      const status = this.victimProfileCommonService.deriveStatus({
        involvesChild: profile.involvesChild,
        isVerified: profile.isVerified,
        isSafetyReviewed: profile.isSafetyReviewed,
        isChildSafetyReviewed: true,
        hasConsent: profile.hasConsent,
        isPrivacyReviewed: profile.isPrivacyReviewed,
        isAdminApproved: profile.isAdminApproved,
      });

      const updatedProfile = await this.victimProfileCommonService.conditionalUpdate(
        id,
        profile.updatedAt,
        {
          isChildSafetyReviewed: true,
          status,
        },
        { admin, action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED, profile },
      );

      await this.cache.invalidateVictimProfileEverywhere(id);

      this.victimProfileCommonService.emitAudit({
        userId: admin.id,
        ...this.victimProfileCommonService.targetUserFor(admin, profile),
        actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
        action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
        entity: 'VictimProfile',
        entityId: id,
        entityLabel: this.victimProfileCommonService.profileLabel(profile),
        reason: data.reviewNotes ?? null,
        diff: {
          result: 'success',
          previousStatus: profile.status,
          newStatus: status,

          firstConfirmedBy: profile.childSafetyFirstConfirmedByUserId,
          secondConfirmedBy: admin.id,
        },
        metadata: { stage: 'second_confirmation' },
      });

      this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED, {
        userId: profile.createdByUserId,
        victimProfileId: id,
        status,
      });

      return updatedProfile;
    }

    const status = this.victimProfileCommonService.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: false,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: false,
    });

    const updatedProfile = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        isChildSafetyReviewed: false,
        childSafetyFirstConfirmedByUserId: null,
        childSafetyFirstConfirmedAt: null,
        isAdminApproved: false,
        isPublished: false,
        status,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEW_REVERSED, profile },
    );

    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      ...this.victimProfileCommonService.targetUserFor(admin, profile),
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEW_REVERSED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.victimProfileCommonService.profileLabel(profile),
      reason: data.reviewNotes ?? null,
      diff: {
        result: 'success',
        previousStatus: profile.status,
        newStatus: status,
        previousIsAdminApproved: profile.isAdminApproved,
        previousIsPublished: profile.isPublished,
      },
      metadata: { stage: 'reversal' },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      status,
    });

    return updatedProfile;
  }

  async revokeConsent(admin: CurrentUserDto, id: string, data: RevokeConsentDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_CONSENT_REVOKED,
    );

    if (!profile.hasConsent) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CONSENT_REVOKED,
        profile,
        'consent_not_currently_recorded',
      );
      throw new BadRequestException('consent_not_currently_recorded');
    }

    const status = this.victimProfileCommonService.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: false,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: false,
    });

    const updatedProfile = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        hasConsent: false,
        consentAt: null,
        consentRecordedBy: null,
        isAdminApproved: false,
        isPublished: false,
        status,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_CONSENT_REVOKED, profile },
    );

    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      ...this.victimProfileCommonService.targetUserFor(admin, profile),
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_CONSENT_REVOKED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.victimProfileCommonService.profileLabel(profile),
      reason: data.reason ?? null,
      diff: {
        result: 'success',
        previousStatus: profile.status,
        newStatus: status,
        previousIsAdminApproved: profile.isAdminApproved,
        previousIsPublished: profile.isPublished,

        previousConsentAt: profile.consentAt,
        previousConsentRecordedBy: profile.consentRecordedBy,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_CONSENT_REVOKED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      actorId: admin.id,
    });

    return updatedProfile;
  }

  // VP-59
  async getConsent(admin: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.logAdminView(admin, profile, 'consent');

    const documents = await Promise.all(
      profile.consentDocuments.map(async (key) => ({
        key,
        url: await this.minioService.generatePresignedDownloadUrl(key),
      })),
    );

    return {
      hasConsent: profile.hasConsent,
      consentedBy: profile.consentedBy,
      consentAt: profile.consentAt,
      recordedBy: profile.consentRecordedBy,
      notes: profile.consentNotes,
      documents,
    };
  }

  // VP-60
  async recordConsent(admin: CurrentUserDto, id: string, data: RecordConsentDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_CONSENT_RECORDED,
    );

    if (profile.hasConsent) {
      throw new ConflictException('consent_already_recorded_revoke_first');
    }
    const documents = data.document ?? [];
    if (!documents.length) throw new BadRequestException('signed_consent_form_required');

    const consentAt = data.consentedAt ? new Date(data.consentedAt) : new Date();
    if (consentAt.getTime() > Date.now() + 60_000)
      throw new BadRequestException('consent_date_in_future');

    try {
      await this.victimProfileCommonService.validateMediaFilesExist(documents);
    } catch (err) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CONSENT_RECORDED,
        profile,
        'media_validation_failed',
        {
          diff: { message: err instanceof Error ? err.message : String(err) },
        },
      );
      throw err;
    }

    const status = this.victimProfileCommonService.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: true,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: profile.isAdminApproved,
    });

    // Only move the pipeline status while the profile is still in the pipeline.
    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        hasConsent: true,
        consentAt,
        consentRecordedBy: admin.id,
        consentedBy: data.consentedBy,
        consentNotes: data.notes ?? null,
        consentDocuments: [...profile.consentDocuments, ...documents],
        ...(PIPELINE_STATUSES.includes(profile.status) ? { status } : {}),
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_CONSENT_RECORDED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_CONSENT_RECORDED,
      profile,
      {
        diff: { previousStatus: profile.status, newStatus: updated.status },
        metadata: { consentedBy: data.consentedBy, documentCount: documents.length },
      },
    );
    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_GATES_UPDATED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      status: updated.status,
    });
    return updated;
  }

  // VP-64  (first admin proposes, a different admin confirms the same value within 72h)
  async updateChildFlag(admin: CurrentUserDto, id: string, data: UpdateChildFlagDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_UPDATED,
    );

    if (profile.involvesChild === data.involvesChild) {
      throw new BadRequestException('child_flag_unchanged');
    }

    const proposalLive =
      profile.childFlagProposedById &&
      profile.childFlagProposedAt &&
      Date.now() - profile.childFlagProposedAt.getTime() < CHILD_FLAG_PROPOSAL_TTL_MS &&
      profile.childFlagProposedValue === data.involvesChild;

    if (!proposalLive) {
      const updated = await this.victimProfileCommonService.conditionalUpdate(
        id,
        profile.updatedAt,
        {
          childFlagProposedValue: data.involvesChild,
          childFlagProposedById: admin.id,
          childFlagProposedAt: new Date(),
          childFlagProposedReason: data.reason,
        },
        { admin, action: AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_PROPOSED, profile },
      );
      this.victimProfileCommonService.auditSuccess(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_PROPOSED,
        profile,
        {
          severity: AuditSeverity.WARNING,
          reason: data.reason,
          diff: { proposedValue: data.involvesChild },
          metadata: { stage: 'first_confirmation' },
        },
      );
      return { applied: false, awaitingSecondAdmin: true, profile: updated };
    }

    if (profile.childFlagProposedById === admin.id) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_UPDATED,
        profile,
        'child_flag_requires_second_admin',
        {
          outcome: AuditOutcome.DENIED,
        },
      );
      throw new BadRequestException('child_flag_requires_second_admin');
    }

    // Either direction forces a fresh review: raising it needs child-safety review, lowering it
    // makes photos public. Hence unpublish + clear approval + clear child-safety state.
    const status = this.victimProfileCommonService.deriveStatus({
      involvesChild: data.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: false,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved: false,
    });

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        involvesChild: data.involvesChild,
        isChildSafetyReviewed: false,
        childSafetyFirstConfirmedByUserId: null,
        childSafetyFirstConfirmedAt: null,
        isAdminApproved: false,
        isPublished: false,
        isFeatured: false,
        status: GATE_DRIVEN_STATUSES.includes(profile.status) ? status : profile.status,
        childFlagProposedValue: null,
        childFlagProposedById: null,
        childFlagProposedAt: null,
        childFlagProposedReason: null,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_UPDATED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_CHILD_FLAG_UPDATED,
      profile,
      {
        severity: AuditSeverity.CRITICAL,
        reason: data.reason,
        diff: {
          previousInvolvesChild: profile.involvesChild,
          newInvolvesChild: data.involvesChild,
          previousStatus: profile.status,
          newStatus: updated.status,
          firstConfirmedBy: profile.childFlagProposedById,
          secondConfirmedBy: admin.id,
        },
        metadata: { stage: 'second_confirmation' },
      },
    );
    return { applied: true, awaitingSecondAdmin: false, profile: updated };
  }
}

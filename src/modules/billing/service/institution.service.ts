// src/modules/billing/service/institution.service.ts
//
// GAP 8 — Institution KYC / beneficial ownership (Section 13 of the standard).
//
// Deliberately does NOT duplicate or replace AgreementService.createInstitution()
// / markSigned() — those own the bare "name + signed status" lifecycle an
// institution needs to appear in an agreement, and nothing here changes that.
// This service owns everything Section 13 adds on top: legal identity,
// authorized representative, beneficial ownership, and the KYC
// submit -> review -> approve/reject workflow with a risk rating.
//
// Owns the Institution.kycStatus/riskRating/legalName/registrationNumber/
// taxId/authorizedRep/beneficialOwners columns added in
// prisma/schema/migrations/20260927120000_gap7_fx_and_gap8_institution_kyc/
// (see prisma/schema/institution.prisma). Written the same way
// SupportService (GAP 33) and this codebase's other NEW-file gaps are.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditOutcome, AuditSeverity, KycStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
// ASSUMPTION TO VERIFY: AuditEventEnum.INSTITUTION_KYC_UPDATED,
// .INSTITUTION_KYC_SUBMITTED, .INSTITUTION_KYC_APPROVED and
// .INSTITUTION_KYC_REJECTED are new enum members that need adding — this is
// a plain TS string enum (AuditLog.action is just String in the schema, no
// migration involved), but BillingEventsService still types `action` as
// AuditEventEnum specifically so a missing member fails to compile here
// rather than silently dropping the audit row (see billing-events.service.ts).
import { AuditEventEnum } from '../../../common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from '../../../common/enums/shared/notification-events.enum';
import {
  InstitutionKycSubmittedEvent,
  InstitutionKycReviewedEvent,
} from '../../misc/events/notification.events';
import { BillingEventsService } from './billing-events.service';
import {
  BeneficialOwnerDto,
  InstitutionResponseDto,
  ReviewInstitutionKycDto,
  UpdateInstitutionKycDto,
} from '../dto/institution.dto';

@Injectable()
export class InstitutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: BillingEventsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * CONDITIONAL per the standard — whether beneficial ownership is required
   * at all is a legal/policy question, not a technical one, so it's a
   * config flag rather than a hard-coded assumption about your jurisdiction.
   * Defaults to false (not required) until Legal/Compliance sets it: failing
   * open on a policy question nobody has actually decided is safer than
   * silently blocking every institution's KYC submission.
   */
  private beneficialOwnershipRequired(): boolean {
    return this.config.get<boolean>('compliance.requireBeneficialOwnership', false);
  }

  async findOne(id: string): Promise<InstitutionResponseDto> {
    const institution = await this.prisma.institution.findUnique({ where: { id } });
    if (!institution) throw new NotFoundException('Institution not found');
    return this.toResponseDto(institution);
  }

  async list(kycStatus?: KycStatus): Promise<InstitutionResponseDto[]> {
    const institutions = await this.prisma.institution.findMany({
      where: kycStatus ? { kycStatus } : undefined,
      orderBy: { name: 'asc' },
    });
    return institutions.map((i) => this.toResponseDto(i));
  }

  /**
   * Create/edit the KYC profile. Allowed at NOT_STARTED or REJECTED only —
   * once SUBMITTED or APPROVED, edits must go through a fresh
   * submit/re-review cycle rather than mutating a record that's already
   * mid-review or already trusted (mirrors the "one write path" lesson from
   * GAP 6: reward terms don't get changed through two different routes, and
   * neither should an institution's identity once it's APPROVED).
   */
  async updateKycProfile(
    actorId: string,
    institutionId: string,
    dto: UpdateInstitutionKycDto,
  ): Promise<InstitutionResponseDto> {
    const existing = await this.prisma.institution.findUnique({ where: { id: institutionId } });
    if (!existing) throw new NotFoundException('Institution not found');
    if (existing.kycStatus === KycStatus.SUBMITTED || existing.kycStatus === KycStatus.APPROVED) {
      throw new BadRequestException(
        `Cannot edit KYC profile while status is ${existing.kycStatus}. Reject or start a new review cycle first.`,
      );
    }

    const updated = await this.prisma.institution.update({
      where: { id: institutionId },
      data: {
        legalName: dto.legalName,
        registrationNumber: dto.registrationNumber,
        taxId: dto.taxId,
        authorizedRep: dto.authorizedRepresentative as unknown as Prisma.InputJsonValue,
        beneficialOwners: dto.beneficialOwners
          ? (dto.beneficialOwners as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });

    await this.events.log({
      actorId,
      action: AuditEventEnum.INSTITUTION_KYC_UPDATED,
      entityType: 'Institution',
      entityId: institutionId,
    });

    return this.toResponseDto(updated);
  }

  /**
   * Flips NOT_STARTED/REJECTED -> SUBMITTED. Hard-fails (doesn't silently
   * skip) if the profile is incomplete or if beneficial ownership is
   * policy-required and missing — same "hard-fail rather than guess/skip"
   * posture as GAP 7's FX handling.
   */
  async submitForReview(actorId: string, institutionId: string): Promise<InstitutionResponseDto> {
    const institution = await this.prisma.institution.findUnique({ where: { id: institutionId } });
    if (!institution) throw new NotFoundException('Institution not found');
    if (institution.kycStatus === KycStatus.SUBMITTED || institution.kycStatus === KycStatus.APPROVED) {
      throw new BadRequestException(`KYC is already ${institution.kycStatus}`);
    }
    if (!institution.legalName || !institution.registrationNumber || !institution.taxId || !institution.authorizedRep) {
      throw new BadRequestException('Complete the KYC profile (updateKycProfile) before submitting');
    }
    if (this.beneficialOwnershipRequired()) {
      const owners = institution.beneficialOwners as unknown as BeneficialOwnerDto[] | null;
      if (!owners || owners.length === 0) {
        throw new BadRequestException('Beneficial ownership is required by policy for this institution');
      }
    }

    const updated = await this.prisma.institution.update({
      where: { id: institutionId },
      data: {
        kycStatus: KycStatus.SUBMITTED,
        kycSubmittedAt: new Date(),
        kycRejectionReason: null, // clear any prior rejection on resubmit
      },
    });

    await this.events.log({
      actorId,
      action: AuditEventEnum.INSTITUTION_KYC_SUBMITTED,
      entityType: 'Institution',
      entityId: institutionId,
    });
    this.events.notify<InstitutionKycSubmittedEvent>(NotificationEventEnum.INSTITUTION_KYC_SUBMITTED, {
      institutionId,
      actorId,
    });

    return this.toResponseDto(updated);
  }

  /**
   * Approve or reject a SUBMITTED profile. Rejection requires a reason
   * (enforced here, not just at the DTO layer, since the DTO can't know
   * `decision` yet when it validates `reason`'s presence).
   */
  async reviewKyc(
    reviewerId: string,
    institutionId: string,
    dto: ReviewInstitutionKycDto,
  ): Promise<InstitutionResponseDto> {
    const institution = await this.prisma.institution.findUnique({ where: { id: institutionId } });
    if (!institution) throw new NotFoundException('Institution not found');
    if (institution.kycStatus !== KycStatus.SUBMITTED) {
      throw new BadRequestException('Only a SUBMITTED profile can be reviewed');
    }
    if (dto.decision === KycStatus.REJECTED && !dto.reason?.trim()) {
      throw new BadRequestException('reason is required when rejecting');
    }

    const updated = await this.prisma.institution.update({
      where: { id: institutionId },
      data: {
        kycStatus: dto.decision,
        riskRating: dto.riskRating,
        kycReviewedAt: new Date(),
        kycReviewedById: reviewerId,
        kycRejectionReason: dto.decision === KycStatus.REJECTED ? dto.reason : null,
      },
    });

    await this.events.log({
      actorId: reviewerId,
      action:
        dto.decision === KycStatus.APPROVED
          ? AuditEventEnum.INSTITUTION_KYC_APPROVED
          : AuditEventEnum.INSTITUTION_KYC_REJECTED,
      entityType: 'Institution',
      entityId: institutionId,
      reason: dto.decision === KycStatus.REJECTED ? dto.reason : undefined,
      // Same convention DisbursementService/ReportService use for a
      // negative-outcome audit row: distinguishable from a plain success at
      // read time, not indistinguishable the way every billing row used to
      // be before BillingAuditInput grew outcome/severity (see
      // billing-events.service.ts).
      outcome: dto.decision === KycStatus.REJECTED ? AuditOutcome.DENIED : undefined,
      severity: dto.decision === KycStatus.REJECTED ? AuditSeverity.WARNING : undefined,
    });
    this.events.notify<InstitutionKycReviewedEvent>(NotificationEventEnum.INSTITUTION_KYC_REVIEWED, {
      institutionId,
      actorId: reviewerId,
      decision: dto.decision,
    });

    return this.toResponseDto(updated);
  }

  private toResponseDto(institution: {
    id: string;
    name: string;
    status: string;
    legalName: string | null;
    registrationNumber: string | null;
    taxId: string | null;
    authorizedRep: unknown;
    beneficialOwners: unknown;
    kycStatus: string;
    riskRating: string | null;
    kycSubmittedAt: Date | null;
    kycReviewedAt: Date | null;
    kycReviewedById: string | null;
    kycRejectionReason: string | null;
  }): InstitutionResponseDto {
    return {
      id: institution.id,
      name: institution.name,
      status: institution.status,
      legalName: institution.legalName,
      registrationNumber: institution.registrationNumber,
      taxId: institution.taxId,
      authorizedRepresentative: institution.authorizedRep as InstitutionResponseDto['authorizedRepresentative'],
      beneficialOwners: institution.beneficialOwners as InstitutionResponseDto['beneficialOwners'],
      kycStatus: institution.kycStatus as KycStatus,
      riskRating: institution.riskRating as InstitutionResponseDto['riskRating'],
      kycSubmittedAt: institution.kycSubmittedAt,
      kycReviewedAt: institution.kycReviewedAt,
      kycReviewedById: institution.kycReviewedById,
      kycRejectionReason: institution.kycRejectionReason,
    };
  }
}
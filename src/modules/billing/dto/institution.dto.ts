// src/modules/billing/dto/institution.dto.ts
//
// GAP 8 — Institution KYC / beneficial ownership (Section 13 of the standard).
// AgreementService.createInstitution() / markSigned() (see agreement.dto.ts's
// CreateInstitutionDto) already cover the bare minimum an Institution needs
// to be usable in an agreement — a name and a signed/prospect status. This
// file adds the identity, authorized-representative, beneficial-ownership
// and compliance fields the standard actually requires, without touching
// that existing create/sign flow.
//
// Mandatory / Conditional / Optional, per the standard:
//   - legalName, registrationNumber, taxId: MANDATORY
//   - authorized representative: MANDATORY — an institution must have
//     someone on record who can bind it
//   - beneficial ownership: CONDITIONAL — required ONLY where your
//     jurisdiction/risk policy says so. That's a legal question, not a
//     technical one (see IS_BENEFICIAL_OWNERSHIP_REQUIRED in
//     institution.service.ts), so this DTO accepts the array but does not
//     force it non-empty; the service enforces the policy at
//     submitForReview(), where the answer is actually known.
//   - kycStatus / riskRating: OPTIONAL/not submitter-settable — written only
//     by InstitutionService.reviewKyc(), never accepted from the submitter's
//     own request body.

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { KycStatus, RiskRating } from '@prisma/client';

// Deliberately permissive — registration-number and tax-ID formats vary a
// lot by jurisdiction. Tightens the obvious junk (empty, whitespace-only)
// without hard-coding one country's format.
const REGISTRATION_ID = /^[A-Za-z0-9-]{3,32}$/;

export class AuthorizedRepresentativeDto {
  @IsString() @MaxLength(200) name!: string;

  /** National ID / passport number — whatever your onboarding flow collects. */
  @IsString() @MaxLength(64) idNumber!: string;

  /** Media key/URL for the scanned authorization document — see MediaService. */
  @IsString() @MaxLength(2048) authorizationDocumentUrl!: string;

  @Type(() => Date) @IsDate() authorizationDocumentExpiry!: Date;
}

/**
 * One row per beneficial owner. Only collected/required where
 * IS_BENEFICIAL_OWNERSHIP_REQUIRED (institution.service.ts) says so for this
 * institution's jurisdiction/risk tier — see the CONDITIONAL note above.
 */
export class BeneficialOwnerDto {
  @IsString() @MaxLength(200) name!: string;

  @IsString() @MaxLength(64) idNumber!: string;

  @IsString() @MaxLength(100) nationality!: string;

  /** Whole percent, 1-100. Sum across owners is a soft policy check, not enforced here. */
  @IsInt() @Min(1) @Max(100) ownershipPercentage!: number;

  @IsOptional() @Type(() => Date) @IsDate() idExpiry?: Date;
}

export class UpdateInstitutionKycDto {
  @IsString() @MaxLength(300) legalName!: string;

  @Matches(REGISTRATION_ID) registrationNumber!: string;

  @Matches(REGISTRATION_ID) taxId!: string;

  @ValidateNested()
  @Type(() => AuthorizedRepresentativeDto)
  authorizedRepresentative!: AuthorizedRepresentativeDto;

  // Conditional (see file header) — accepted here, enforced in the service.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => BeneficialOwnerDto)
  beneficialOwners?: BeneficialOwnerDto[];
}

export class ReviewInstitutionKycDto {
  @IsIn([KycStatus.APPROVED, KycStatus.REJECTED])
  decision!: Extract<KycStatus, 'APPROVED' | 'REJECTED'>;

  @IsEnum(RiskRating)
  riskRating!: RiskRating;

  /** Required by InstitutionService when decision is REJECTED; optional otherwise. */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** Read-only. No create/update DTO needed beyond UpdateInstitutionKycDto above. */
export class InstitutionResponseDto {
  id!: string;
  name!: string;
  status!: string; // existing PROSPECT / AGREEMENT_SIGNED lifecycle — unchanged by this file
  legalName!: string | null;
  registrationNumber!: string | null;
  taxId!: string | null;
  authorizedRepresentative!: AuthorizedRepresentativeDto | null;
  beneficialOwners!: BeneficialOwnerDto[] | null;
  kycStatus!: KycStatus;
  riskRating!: RiskRating | null;
  kycSubmittedAt!: Date | null;
  kycReviewedAt!: Date | null;
  kycReviewedById!: string | null;
  kycRejectionReason!: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// SCHEMA NOTE — applied. See prisma/schema/institution.prisma (KycStatus,
// RiskRating enums + the new columns below) and the migration at
// prisma/schema/migrations/20260927120000_gap7_fx_and_gap8_institution_kyc/.
//
// Institution (name, status, signedAt unchanged) gained:
//   legalName             String?
//   registrationNumber    String?
//   taxId                 String?
//   authorizedRep         Json?        // AuthorizedRepresentativeDto shape
//   beneficialOwners      Json?        // BeneficialOwnerDto[] shape — a plain
//                                      // Json array for now, not a dedicated
//                                      // relation table; revisit if you need
//                                      // to query/report on owners directly
//   kycStatus             KycStatus    @default(NOT_STARTED)
//   riskRating            RiskRating?
//   kycSubmittedAt        DateTime?
//   kycReviewedAt         DateTime?
//   kycReviewedById       String?
//   kycRejectionReason    String?
//
// All nullable/defaulted so existing Institution rows (created today via
// AgreementService.createInstitution) didn't need backfilling — they simply
// start at kycStatus: NOT_STARTED.
// ─────────────────────────────────────────────────────────────────────────
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

import { SupportType, VictimProfileStatus } from '@prisma/client';

// G12: bank details had no field for who actually holds the account —
// relevant whenever the profile involves a child (involvesChild) and the
// payout destination is necessarily a parent, guardian or other adult, not
// the survivor themselves. Not yet a Prisma enum (VictimProfile.bank* are
// legacy columns per the section-9 schema review, G40); kept as a
// TS/class-validator enum here until PayoutDestination.accountHolder takes
// over and this can move into the schema.
export enum AccountHolderRelationship {
  SELF = 'SELF',
  PARENT = 'PARENT',
  GUARDIAN = 'GUARDIAN',
  OTHER = 'OTHER',
}

export class CreateVictimProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  description?: string;

  @IsString()
  @MinLength(10)
  story: string;

  @IsEnum(SupportType)
  supportType: SupportType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  supportGoal?: number;

  // Off-platform transfer destination. Optional here; enforced at the gate stage.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankAccountName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  bankAccountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankName?: string;

  // G4: the bank code Chapa expects for account-name verification/transfer,
  // distinct from the free-text bankName above. Optional at creation (the
  // gate stage can still require it before publish); validated against
  // Chapa's banks list in disbursement.service.ts, not here.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  bankCode?: string;

  // G12: who actually holds this account. Required whenever a bank account
  // number is supplied so a payout destination is never created without
  // knowing who it belongs to.
  @ValidateIf((o) => !!o.bankAccountNumber)
  @IsString()
  @MaxLength(200)
  accountHolderName?: string;

  // G12: required by the service when involvesChild is true — a minor
  // cannot be the account holder, so this must resolve to an adult
  // relationship. Left optional at the DTO level because validity depends
  // on involvesChild, which the service checks against the persisted/
  // incoming profile rather than duplicating that logic in the DTO.
  @IsOptional()
  @IsEnum(AccountHolderRelationship)
  accountHolderRelationship?: AccountHolderRelationship;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];

  @IsOptional()
  @IsBoolean()
  involvesChild?: boolean;
}

export class UpdateVictimProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  story?: string;

  @IsOptional()
  @IsEnum(SupportType)
  supportType?: SupportType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  supportGoal?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankAccountName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  bankAccountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  bankCode?: string;

  @ValidateIf((o) => !!o.bankAccountNumber)
  @IsString()
  @MaxLength(200)
  accountHolderName?: string;

  @IsOptional()
  @IsEnum(AccountHolderRelationship)
  accountHolderRelationship?: AccountHolderRelationship;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];

  @IsOptional()
  @IsBoolean()
  involvesChild?: boolean;
}

export class UpdateVictimGateDto {
  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;

  @IsOptional()
  @IsBoolean()
  isSafetyReviewed?: boolean;

  @IsOptional()
  @IsBoolean()
  hasConsent?: boolean;

  @IsOptional()
  @IsBoolean()
  isPrivacyReviewed?: boolean;

  @IsOptional()
  @IsBoolean()
  isAdminApproved?: boolean;
}

// §32 — dedicated child-safety gate, kept as its own DTO so it always leaves its own audit trail.
export class UpdateChildSafetyReviewDto {
  @IsBoolean()
  isChildSafetyReviewed: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNotes?: string;
}

export class RevokeConsentDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class UpdateBankDetailsDto {
  @IsString()
  @MaxLength(200)
  bankAccountName: string;

  @IsString()
  @MaxLength(64)
  bankAccountNumber: string;

  @IsString()
  @MaxLength(200)
  bankName: string;

  // G4: required here (unlike the general profile DTOs above) — this is
  // the dedicated bank-details write path, gated by SUPPORT_PAYMENT_MANAGE
  // + reauth, so there is no reason to accept a payout destination without
  // the code disbursement.service.ts needs to verify it against Chapa's
  // banks list.
  @IsString()
  @MaxLength(20)
  bankCode: string;

  // G12: required here for the same reason — the admin filling this form
  // is explicitly setting up a payout destination and must record who
  // holds the account, especially for child cases where it cannot be the
  // survivor.
  @IsString()
  @MaxLength(200)
  accountHolderName: string;

  @IsEnum(AccountHolderRelationship)
  accountHolderRelationship: AccountHolderRelationship;
}

export class FindAllVictimProfilesQueryDto {
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;

  @IsOptional()
  @IsEnum(VictimProfileStatus)
  status?: VictimProfileStatus;
}

// Public listing filters — pagination only, implicitly PUBLISHED-only.
export class FindPublicVictimProfilesQueryDto {
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;

  @IsOptional()
  @IsEnum(SupportType)
  supportType?: SupportType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
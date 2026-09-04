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
} from 'class-validator';
import { Type } from 'class-transformer';

import { SupportType, VictimProfileStatus } from '@prisma/client';

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

  // ─── Off-platform transfer destination ───
  // Not required at creation (draft profiles may not have these yet),
  // but enforced at the gate stage — see UpdateVictimGateDto handling.
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

// ─────────────────────────────────────────────
// §32 — dedicated gate, only meaningful/enforced when
// the profile has involvesChild = true. Kept as its own
// endpoint/DTO rather than folded into UpdateVictimGateDto
// so the sensitive review always leaves its own audit trail
// and can't be silently flipped alongside unrelated gates.
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// Public listing filters — mirrors the admin list's
// pagination but only exposes fields safe/relevant for
// the public-facing app (no status filter; public list is
// implicitly PUBLISHED-only).
// ─────────────────────────────────────────────
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
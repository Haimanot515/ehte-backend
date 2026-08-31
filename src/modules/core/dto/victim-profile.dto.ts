import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { SupportType } from '@prisma/client';

export class CreateVictimProfileDto {
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
  supportGoal?: number;

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
  supportGoal?: number;

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
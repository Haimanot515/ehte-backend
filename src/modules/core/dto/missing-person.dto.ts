import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

import { MissingPersonType, MissingPersonStatus } from '@prisma/client';

export class CreateMissingPersonDto {
  @ApiProperty({ enum: MissingPersonType })
  @IsEnum(MissingPersonType)
  personType: MissingPersonType;

  @ApiPropertyOptional({ example: 'Metania Shiferaw' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiProperty({
    example: 'Metania was last seen wearing a blue jacket and black trousers...',
  })
  @IsString()
  @MaxLength(5000)
  description: string;

  @ApiProperty({ example: '2026-09-10T00:00:00.000Z' })
  @IsDateString()
  dateLastSeen: string;

  @ApiProperty({ example: 'Bole, Addis Ababa' })
  @IsString()
  @MaxLength(500)
  lastKnownArea: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['photo/550e8400-e29b-41d4-a716-446655440000.jpg'],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];

  @ApiPropertyOptional({
    description:
      'Whether the submitter is offering a reward for information - "I will pay this amount if the missing person is found."',
  })
  @IsOptional()
  @IsBoolean()
  rewardOffered?: boolean;

  @ApiPropertyOptional({
    description:
      'Reward amount to pay if the missing person is found (platform base currency unit). Required when rewardOffered is true.',
    example: 20000,
  })
  @ValidateIf((o: CreateMissingPersonDto) => o.rewardOffered === true)
  @IsInt()
  @Min(1)
  rewardAmount?: number;

  @ApiPropertyOptional({
    description:
      'Free-text reward details (e.g. conditions, how to claim). Only meaningful when rewardOffered is true; ignored otherwise.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rewardDetails?: string;

  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;
}

// Admin create: same as a user submission, minus the re-auth credential, plus rewardApproved.
export class AdminCreateMissingPersonDto extends OmitType(CreateMissingPersonDto, [
  'credential',
] as const) {
  @ApiPropertyOptional({
    description: 'Approve the proposed reward at creation. Requires rewardOffered and rewardAmount.',
  })
  @IsOptional()
  @IsBoolean()
  rewardApproved?: boolean;
}

export class UpdateMissingPersonDto {
  @ApiPropertyOptional({ enum: MissingPersonType })
  @IsOptional()
  @IsEnum(MissingPersonType)
  personType?: MissingPersonType;

  @ApiPropertyOptional({ example: 'Metania Shiferaw' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'Updated description with more detail.' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ example: '2026-09-10T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  dateLastSeen?: string;

  @ApiPropertyOptional({ example: 'Bole, Addis Ababa' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  lastKnownArea?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];

  @ApiPropertyOptional({
    description:
      'Whether the submitter is offering a reward for information - "I will pay this amount if the missing person is found."',
  })
  @IsOptional()
  @IsBoolean()
  rewardOffered?: boolean;

  @ApiPropertyOptional({
    description:
      'Reward amount to pay if the missing person is found (platform base currency unit). Required when this request sets rewardOffered to true.',
    example: 20000,
  })
  @ValidateIf((o: UpdateMissingPersonDto) => o.rewardOffered === true)
  @IsInt()
  @Min(1)
  rewardAmount?: number;

  @ApiPropertyOptional({
    description:
      'Free-text reward details (e.g. conditions, how to claim). Only meaningful when rewardOffered is true; ignored otherwise.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rewardDetails?: string;

  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;
}

// reviewNote is required by the service for REJECTED and MORE_INFORMATION_REQUESTED.
export class UpdateMissingPersonStatusDto {
  @ApiProperty({ enum: MissingPersonStatus })
  @IsEnum(MissingPersonStatus)
  status: MissingPersonStatus;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;

  @ApiPropertyOptional({
    description:
      'Required (true) when approving a case where personType is CHILD. Ignored otherwise.',
  })
  @IsOptional()
  @IsBoolean()
  childSafetyConfirmed?: boolean;
}

export class UpdateMissingPersonRewardDto {
  @ApiProperty({
    description:
      "Whether the case's proposed reward is approved for public display. Requires the case to have rewardOffered = true and a final reward amount (existing or provided here).",
  })
  @IsBoolean()
  rewardApproved: boolean;

  @ApiPropertyOptional({
    description:
      "Override the reward amount (platform base currency unit). Omit to keep the submitter's proposed amount.",
    example: 50000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  rewardAmount?: number;

  @ApiPropertyOptional({
    description: "Override the reward details text. Omit to keep the submitter's proposed details.",
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rewardDetails?: string;
}

export class ListMissingPersonsQueryDto {
  @ApiPropertyOptional({ enum: MissingPersonType })
  @IsOptional()
  @IsEnum(MissingPersonType)
  type?: MissingPersonType;

  @ApiPropertyOptional({ default: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class ListMissingPersonsAdminQueryDto {
  @ApiPropertyOptional({ enum: MissingPersonStatus })
  @IsOptional()
  @IsEnum(MissingPersonStatus)
  status?: MissingPersonStatus;

  @ApiPropertyOptional({ default: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportCategory, SupportStatus, SupportType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

// Non-financial offers only. Money never comes through here: financial support is created
// by the server after Chapa confirms a payment. With forbidNonWhitelisted on the global
// ValidationPipe, sending amount, split, agreementType or transferReference is rejected.
export class CreateSupportDto {
  @ApiProperty()
  @IsUUID()
  victimProfileId: string;

  @ApiProperty({ enum: SupportCategory, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(Object.values(SupportCategory).length)
  @IsEnum(SupportCategory, { each: true })
  categories: SupportCategory[];

  // Required when OTHER is ticked.
  @ApiPropertyOptional({ description: 'Short note. Required when OTHER is ticked.' })
  @ValidateIf((o: CreateSupportDto) => o.message !== undefined || o.categories?.includes(SupportCategory.OTHER))
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message?: string;

  @ApiPropertyOptional({ default: true, description: 'Hide my name from the victim and public lists.' })
  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;

  @ApiPropertyOptional({ default: false, description: 'The team may share my contact with this person.' })
  @IsOptional()
  @IsBoolean()
  contactMayBeShared?: boolean;
}

// Completing a support needs a note for the audit trail.
export class CompleteSupportDto {
  @ApiProperty({ description: 'What was delivered or handled. Stored in the audit trail.' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}

export class CancelSupportDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// Admin queue of supports, so pending non-financial offers can be found and followed up.
export class ListSupportQueryDto {
  @ApiPropertyOptional({ enum: SupportStatus })
  @IsOptional()
  @IsEnum(SupportStatus)
  status?: SupportStatus;

  @ApiPropertyOptional({ enum: SupportType })
  @IsOptional()
  @IsEnum(SupportType)
  type?: SupportType;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

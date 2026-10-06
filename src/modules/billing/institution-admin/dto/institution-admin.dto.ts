import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InstitutionStatus, PayoutRail } from '@prisma/client';
import { PagingDto, DateRangeDto } from 'src/modules/billing/shared/dto/billing-common.dto';

// ── Institutions, agreements, payout destinations ────────────────────

export class InstitutionsQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: InstitutionStatus })
  @IsOptional()
  @IsEnum(InstitutionStatus)
  status?: InstitutionStatus;

  @ApiPropertyOptional({ description: 'Name contains.' })
  @IsOptional()
  @IsString()
  q?: string;
}

export class UpdateInstitutionDto {
  @ApiProperty({ minLength: 2, maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;
}

export class StatementQueryDto extends DateRangeDto {}

export class ExpiringAgreementsQueryDto {
  @ApiPropertyOptional({
    default: 30,
    minimum: 1,
    maximum: 365,
    description: 'Days ahead to look.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number = 30;
}

export class UpdateDraftAgreementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  effectiveFrom?: Date;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Date)
  effectiveTo?: Date;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  refundPolicy?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  cancellationPolicy?: string;
}

export class PayoutDestinationsQueryDto extends PagingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @ApiPropertyOptional({ description: 'Only verified (true) or unverified (false).' })
  @IsOptional()
  @Type(() => String)
  @IsIn(['true', 'false'])
  verified?: 'true' | 'false';
}

export class CreatePayoutDestinationDto {
  @ApiProperty({ enum: PayoutRail })
  @IsEnum(PayoutRail)
  rail!: PayoutRail;

  @ApiPropertyOptional({ description: 'Required for BANK.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankName?: string;

  @ApiPropertyOptional({ description: 'Required for BANK.' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  accountNumber?: string;

  @ApiPropertyOptional({ description: 'Required for TELEBIRR.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telebirrPhone?: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  accountHolder!: string;
}

export class UpdatePayoutDestinationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  accountNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telebirrPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  accountHolder?: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

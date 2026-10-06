import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PagingDto } from 'src/modules/billing/shared/dto/billing-common.dto';

// ── Disbursements ────────────────────────────────────────────────────

export class FailedDisbursementsQueryDto extends PagingDto {
  @ApiPropertyOptional({ description: 'ISO date, only failures on or after this date.' })
  @IsOptional()
  @IsDateString()
  from?: string;
}

export class MarkDisbursementPaidDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 200,
    description: 'Bank slip or transfer reference proving the money left.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  externalReference!: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class BulkDisbursementIdsDto {
  @ApiProperty({ type: [String], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class BulkExecuteItemDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  accountName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  accountNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bankCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  externalReference?: string;
}

export class BulkExecuteDisbursementsDto {
  @ApiProperty({ type: [BulkExecuteItemDto], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BulkExecuteItemDto)
  items!: BulkExecuteItemDto[];
}

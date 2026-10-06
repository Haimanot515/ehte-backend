import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Payer ────────────────────────────────────────────────────────────

export class OpenPaymentDisputeDto {
  @ApiProperty({
    minLength: 5,
    maxLength: 1000,
    example: 'I was charged twice for the same support.',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;
}

export class AnnualStatementQueryDto {
  @ApiPropertyOptional({
    example: 2026,
    description: 'Calendar year. Defaults to the current year.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2024)
  @Max(2100)
  year?: number;
}

export class CreateRewardAppealDto {
  @ApiProperty({ minLength: 10, maxLength: 2000 })
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  message!: string;
}

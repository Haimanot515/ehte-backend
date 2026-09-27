import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { SupportType, SupportAgreementType } from '@prisma/client';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  Min,
} from 'class-validator';

export class CreateSupportDto {
  @ApiProperty()
  @IsString()
  victimProfileId: string;

  @ApiPropertyOptional({ enum: SupportType })
  @IsOptional()
  @IsEnum(SupportType)
  type?: SupportType;

  @ApiPropertyOptional({ enum: SupportAgreementType })
  @IsOptional()
  @IsEnum(SupportAgreementType)
  agreementType?: SupportAgreementType;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  recipientAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  organizationAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  platformAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  transferReference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  message?: string;
}
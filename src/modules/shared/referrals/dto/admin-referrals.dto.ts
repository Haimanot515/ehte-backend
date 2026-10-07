import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
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
  ValidateIf,
} from 'class-validator';
import { ReferralStatus } from '@prisma/client';
import { SharedRecordEntity } from 'src/common/enums/shared/shared-record-entity.enum';
import { PagedQueryDto } from '../../common/paged-query.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

// Statuses staff may move a referral to (SENT is only the starting state)
export const REFERRAL_TARGET_STATUSES = [
  ReferralStatus.ACKNOWLEDGED,
  ReferralStatus.IN_PROGRESS,
  ReferralStatus.CLOSED,
];

export class CreateReferralDto {
  @IsUUID()
  institutionId: string;

  @IsEnum(SharedRecordEntity)
  entity: SharedRecordEntity;

  @IsUUID()
  entityId: string;

  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  reason: string;

  // True when survivor or informant details may be shared with the institution
  @IsOptional()
  @Transform(toBool)
  includesSensitive?: boolean;

  // Hours the institution has to acknowledge before the referral counts as overdue
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  ackDueHours?: number;
}

export class ReferralListQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsEnum(ReferralStatus)
  status?: ReferralStatus;

  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @IsOptional()
  @IsEnum(SharedRecordEntity)
  entity?: SharedRecordEntity;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class ReferralStatsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  institutionId?: string;
}

export class UpdateReferralStatusDto {
  @IsIn(REFERRAL_TARGET_STATUSES)
  status: ReferralStatus;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;

  // Required when closing: what the institution did with the referral
  @ValidateIf((o: UpdateReferralStatusDto) => o.status === ReferralStatus.CLOSED || o.outcome !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  outcome?: string;
}

export class AttachReferralDocumentDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  mediaKey: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  fileName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  mimeType?: string;
}

export class RevealReferralDetailsDto {
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

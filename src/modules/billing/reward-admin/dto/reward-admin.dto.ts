import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RewardClaimAppealStatus, RewardClaimStatus } from '@prisma/client';
import { PagingDto } from 'src/modules/billing/shared/dto/billing-common.dto';

// ── Reward claims ────────────────────────────────────────────────────

export class RewardClaimsQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: RewardClaimStatus })
  @IsOptional()
  @IsEnum(RewardClaimStatus)
  status?: RewardClaimStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  missingPersonId?: string;
}

export class RewardAppealsQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: RewardClaimAppealStatus, default: RewardClaimAppealStatus.OPEN })
  @IsOptional()
  @IsEnum(RewardClaimAppealStatus)
  status?: RewardClaimAppealStatus;
}

export class DecideRewardAppealDto {
  @ApiProperty({ enum: ['UPHOLD', 'DECLINE'], description: 'UPHOLD reopens the claim for review.' })
  @IsIn(['UPHOLD', 'DECLINE'])
  decision!: 'UPHOLD' | 'DECLINE';

  @ApiProperty({ minLength: 3, maxLength: 1000 })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}

export class RewardOffersQueryDto extends PagingDto {
  @ApiPropertyOptional({ description: 'Only offers approved (true) or not yet approved (false).' })
  @IsOptional()
  @IsIn(['true', 'false'])
  approved?: 'true' | 'false';
}

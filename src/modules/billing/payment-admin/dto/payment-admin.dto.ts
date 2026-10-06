import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentDisputeStatus, PaymentType } from '@prisma/client';
import { PagingDto } from 'src/modules/billing/shared/dto/billing-common.dto';

const MONEY = /^\d+(\.\d{1,2})?$/;

// ── Payments admin ───────────────────────────────────────────────────

export class WebhookEventsQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: ['RECEIVED', 'RECONCILED', 'IGNORED', 'ERROR'] })
  @IsOptional()
  @IsIn(['RECEIVED', 'RECONCILED', 'IGNORED', 'ERROR'])
  result?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  txRef?: string;
}

export class PaymentSearchQueryDto extends PagingDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 100,
    description: 'txRef, chapa reference, payment id, payer id or profile id.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  q!: string;
}

export class ReviewQueueQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: PaymentType })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;
}

export class PaymentDisputesQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: PaymentDisputeStatus, default: PaymentDisputeStatus.OPEN })
  @IsOptional()
  @IsEnum(PaymentDisputeStatus)
  status?: PaymentDisputeStatus;
}

export class ResolvePaymentDisputeDto {
  @ApiProperty({ enum: ['UPHELD', 'DISMISSED'] })
  @IsIn(['UPHELD', 'DISMISSED'])
  outcome!: 'UPHELD' | 'DISMISSED';

  @ApiProperty({ minLength: 3, maxLength: 1000 })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}

// ── Refunds ──────────────────────────────────────────────────────────

export class RequestRefundDto {
  @ApiPropertyOptional({ example: '50.00', description: 'Omit for a full refund.' })
  @IsOptional()
  @Matches(MONEY)
  amount?: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class RefundListQueryDto extends PagingDto {
  @ApiPropertyOptional({
    enum: ['REQUESTED', 'REJECTED', 'REFUNDED', 'FAILED'],
    default: 'REQUESTED',
  })
  @IsOptional()
  @IsIn(['REQUESTED', 'REJECTED', 'REFUNDED', 'FAILED'])
  status?: string;

  @ApiPropertyOptional({ enum: PaymentType })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;
}

export class ExecuteRefundDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 200,
    description: 'Bank slip or transfer reference of the manual refund.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reference!: string;
}

export class BulkRefundItemDto {
  @ApiProperty()
  @IsUUID()
  paymentId!: string;

  @ApiProperty({ minLength: 3, maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reference!: string;
}

export class BulkExecuteRefundsDto {
  @ApiProperty({ type: [BulkRefundItemDto], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BulkRefundItemDto)
  items!: BulkRefundItemDto[];
}

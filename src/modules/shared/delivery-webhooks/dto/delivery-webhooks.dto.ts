import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PagedQueryDto } from '../../common/paged-query.dto';

// Mirrors the comments on the ProviderEvent model
export const PROVIDER_EVENT_KINDS = ['SMS_DELIVERY', 'EMAIL_EVENT'] as const;
export const PROVIDER_EVENT_RESULTS = [
  'RECEIVED',
  'APPLIED',
  'IGNORED',
  'DUPLICATE',
  'REJECTED',
  'ERROR',
] as const;

export type ProviderEventKind = (typeof PROVIDER_EVENT_KINDS)[number];
export type ProviderEventResult = (typeof PROVIDER_EVENT_RESULTS)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

// SH-87
export class ReceivedWebhooksQueryDto extends PagedQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  provider?: string;

  @IsOptional()
  @IsIn(PROVIDER_EVENT_KINDS as unknown as string[])
  kind?: ProviderEventKind;

  @IsOptional()
  @IsIn(PROVIDER_EVENT_RESULTS as unknown as string[])
  result?: ProviderEventResult;

  // delivered, failed, bounced, complaint
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  eventType?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  providerMessageId?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  signatureValid?: boolean;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

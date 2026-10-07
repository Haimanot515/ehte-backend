import { OmitType, PartialType } from '@nestjs/swagger';
import { ApiClientStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { isIP } from 'net';
import { PagedQueryDto } from '../../common/paged-query.dto';

// e.g. "missing-persons:read", "reports:write", "reports:*"
export const SCOPE_PATTERN = /^[a-z][a-z0-9_-]{1,40}(:[a-z0-9_*-]{1,40}){1,2}$/;
export const MAX_SCOPES = 50;
export const MAX_ALLOWLIST_ENTRIES = 50;
export const MAX_RATE_LIMIT_PER_MINUTE = 10_000;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// Accepts a plain IPv4 or IPv6 address, or a CIDR range such as 10.0.0.0/24
export function isIpOrCidr(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const [address, prefix, ...rest] = value.trim().split('/');
  if (rest.length > 0) return false;

  const version = isIP(address);
  if (!version) return false;
  if (prefix === undefined) return true;

  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

@ValidatorConstraint({ name: 'ipAllowlist', async: false })
class IpAllowlistConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return Array.isArray(value) && value.every(isIpOrCidr);
  }

  defaultMessage() {
    return 'ipAllowlist must contain IPv4 or IPv6 addresses or CIDR ranges';
  }
}

// SH-88
export class CreateApiClientDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_SCOPES)
  @Matches(SCOPE_PATTERN, { each: true, message: 'each scope must look like resource:action' })
  scopes: string[];

  // Empty or missing means any address may call
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_ALLOWLIST_ENTRIES)
  @Validate(IpAllowlistConstraint)
  ipAllowlist?: string[];

  // null or missing means no per-client limit beyond the global one
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RATE_LIMIT_PER_MINUTE)
  rateLimitPerMinute?: number | null;

  @IsOptional()
  @IsUUID()
  institutionId?: string;
}

// SH-91. The owning institution is fixed at creation, the rest can change.
export class UpdateApiClientDto extends PartialType(OmitType(CreateApiClientDto, ['institutionId'] as const)) {}

// SH-89
export class ApiClientsQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsEnum(ApiClientStatus)
  status?: ApiClientStatus;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsUUID()
  institutionId?: string;

  // Clients that have not called the API for this many days (or never), to find ones to retire
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  unusedForDays?: number;
}

// SH-94
export class ApiClientUsageQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsIn(['hour', 'day'])
  interval?: 'hour' | 'day' = 'day';
}

// SH-95
export class ApiClientAuditQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  method?: string;

  // Substring match on the route
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  route?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(599)
  statusCode?: number;

  // Only calls that failed (status 400 and above)
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  failedOnly?: boolean;
}

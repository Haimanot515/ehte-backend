import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// RECONSTRUCTED — original file wasn't shared; merge with your real fields.
export class CreateRoleDto {
  @ApiProperty({ example: 'CONTENT_MODERATOR', description: 'Unique role name' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[A-Z][A-Z0-9_]*$/, {
    message: 'name must be UPPER_SNAKE_CASE (A-Z, 0-9, underscore; starts with a letter)',
  })
  name: string;

  @ApiPropertyOptional({
    example: 'Reviews and moderates user-submitted posts.',
    description: 'What this role is for — shown in the admin UI.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateRoleDto extends PartialType(CreateRoleDto) {}

// New DTOs for the endpoints added to RoleController (AR-29 … AR-46, AR-56).
// Re-authentication `password` is read and stripped by the guard, so it is not a field here.

const ROLE_NAME_RULES = /^[A-Z][A-Z0-9_]*$/;

// Every assignment change needs a reason for the audit event.
const REASON_DOC = 'Why this change is being made (kept in the audit event)';

// AR-29
export class AssignRoleToUserDto {
  @ApiProperty({ description: 'ID of the verified staff user to receive the role' })
  @IsUUID()
  userId: string;

  @ApiProperty({ description: REASON_DOC, minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

// AR-30 — sent in the body; if your proxy strips DELETE bodies, move to POST.
export class RemoveRoleFromUserDto {
  @ApiProperty({ description: REASON_DOC, minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

// AR-31
export enum BulkRoleActionEnum {
  ASSIGN = 'ASSIGN',
  REMOVE = 'REMOVE',
}

export class BulkRoleAssignmentDto {
  @ApiProperty({ enum: BulkRoleActionEnum })
  @IsEnum(BulkRoleActionEnum)
  action: BulkRoleActionEnum;

  @ApiProperty({ type: [String], description: 'User IDs (1 to 100)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  userIds: string[];

  @ApiProperty({ description: REASON_DOC, minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

// AR-34 — starts two-person approval
export class RequestRoleAssignmentDto {
  @ApiProperty({ description: REASON_DOC, minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

// AR-36 — a different Super Admin approves or rejects
export enum AssignmentDecisionEnum {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class ReviewRoleAssignmentRequestDto {
  @ApiProperty({ enum: AssignmentDecisionEnum })
  @IsEnum(AssignmentDecisionEnum)
  decision: AssignmentDecisionEnum;

  @ApiPropertyOptional({ description: 'Required when rejecting', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// AR-39
export class CloneRoleDto {
  @ApiProperty({ example: 'FINANCE_OFFICER_COPY', description: 'Name of the new role' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(ROLE_NAME_RULES, {
    message: 'name must be UPPER_SNAKE_CASE (A-Z, 0-9, underscore; starts with a letter)',
  })
  name: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

// AR-42 / AR-43
export class ArchiveRoleDto {
  @ApiPropertyOptional({ description: REASON_DOC, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// AR-40 — GET /roles/compare?a=&b=
export class CompareRolesQueryDto {
  @ApiProperty({ description: 'First role ID' })
  @IsString()
  @IsNotEmpty()
  a: string;

  @ApiProperty({ description: 'Second role ID' })
  @IsString()
  @IsNotEmpty()
  b: string;
}

// AR-46
export class ApplyRoleTemplateDto {
  @ApiPropertyOptional({
    example: 'SUPPORT_AGENT_NIGHT',
    description: 'Override the template name. Defaults to the template name.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(ROLE_NAME_RULES, {
    message: 'name must be UPPER_SNAKE_CASE (A-Z, 0-9, underscore; starts with a letter)',
  })
  name?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

// AR-56
export class TemporaryRoleAssignmentDto {
  @ApiProperty({
    example: '2026-12-31T23:59:59.000Z',
    description: 'When the role is removed automatically. Must be in the future.',
  })
  @IsDateString()
  expiresAt: string;

  @ApiProperty({ description: REASON_DOC, minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

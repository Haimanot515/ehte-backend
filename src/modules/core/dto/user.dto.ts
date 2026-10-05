import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { RolesEnum } from 'src/common/enums/roles.enum';

// PATCH /users/me. Deliberately excludes bio/social-link vanity fields —
// nationalIdNumber needs its own access-controlled table, not a plain column.
export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Haimanot', description: 'Updated display name' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'Addis Ababa', description: 'Region' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @ApiPropertyOptional({ description: 'Zone (skip for city administrations)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  zone?: string;

  @ApiPropertyOptional({ example: 'Addis Ababa', description: 'City' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ example: 'Bole', description: 'Sub-city' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  subCity?: string;

  @ApiPropertyOptional({ example: 'Woreda 03', description: 'Woreda' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  woreda?: string;

  @ApiPropertyOptional({ example: 'Kebele 07', description: 'Kebele' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  kebele?: string;

  @ApiPropertyOptional({ example: 'am', description: 'ISO language code for SMS/notifications' })
  @IsOptional()
  @IsString()
  @IsIn(['am', 'en'])
  preferredLanguage?: string;

  @ApiPropertyOptional({ example: '1995-03-14' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'female' })
  @IsOptional()
  @IsString()
  @IsIn(['male', 'female', 'other', 'prefer_not_to_say'])
  gender?: string;

  @ApiPropertyOptional({ description: 'Backup contact number, distinct from login phone' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  alternatePhone?: string;

  @ApiPropertyOptional({ example: 'Teacher' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  occupation?: string;
}

// PATCH /users/:id (admin). Same safe fields as a self-edit and nothing more.
// Role, email, phone and active status are deliberately NOT editable here;
// they have their own guarded routes (promote flow, change-phone, deactivate).
export class AdminUpdateUserDto extends UpdateUserDto {
  @ApiPropertyOptional({ description: 'Admin justification, stored in the audit log' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// PATCH /users/me/discreet-mode. passcode required only when enabling.
// body.password is stripped by ReauthGuard before this DTO is built.
export class UpdateDiscreetModeDto {
  @ApiProperty({ example: true, description: 'Enable or disable Discreet Mode' })
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({
    example: '482913',
    description: 'Discreet Mode passcode. Required when enabling Discreet Mode.',
  })
  @ValidateIf((o) => o.enabled === true)
  @IsString()
  @MinLength(4)
  @MaxLength(12)
  passcode?: string;
}

// PATCH /users/:id/discreet-mode (admin). Admin sets the passcode directly —
// there's no existing passcode to rotate blind on someone else's behalf.
export class AdminUpdateDiscreetModeDto extends UpdateDiscreetModeDto {
  @ApiPropertyOptional({ description: 'Admin justification, stored in the audit log' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// Shared optional reason for admin routes with no other body
// (deactivate/reactivate/unlock/force-logout).
export class AdminActionReasonDto {
  @ApiPropertyOptional({ description: 'Admin justification, stored in the audit log' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// PATCH /users/:id/role  — SUPER_ADMIN escalation ONLY.
// ADMIN is never granted here: the only way to become ADMIN is the
// email-verified flow (POST /admin/auth/promote -> user clicks the link ->
// POST /admin/auth/promote/verify). This route exists because that flow
// cannot produce a SUPER_ADMIN (see the KNOWN LIMITATION in PromoteUserDto).
export class AssignUserRoleDto {
  @ApiProperty({
    example: RolesEnum.SUPER_ADMIN,
    description:
      'Only SUPER_ADMIN can be granted here, and only to a user who is already a verified ADMIN. To make someone ADMIN use POST /admin/auth/promote.',
    enum: [RolesEnum.SUPER_ADMIN],
  })
  @IsString()
  @IsIn([RolesEnum.SUPER_ADMIN], {
    message: 'role must be super_admin; use POST /admin/auth/promote to create an admin',
  })
  role: RolesEnum.SUPER_ADMIN;

  @ApiProperty({ description: 'Why this user is being made SUPER_ADMIN, stored in the audit log' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

// GET /users (admin list query). Address fields deliberately not
// filterable here — see UserService.listUsers().
export class ListUsersQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;

  @ApiPropertyOptional({ example: 'haim', description: 'Matches against name or phone' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter to users holding this role id' })
  @IsOptional()
  @IsUUID('4')
  roleId?: string;

  @ApiPropertyOptional({ description: 'Filter by active status' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Filter by Discreet Mode status' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  discreetModeEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Filter admin registrations by completion status',
    enum: ['pending', 'completed'],
  })
  @IsOptional()
  @IsIn(['pending', 'completed'])
  registrationStatus?: 'pending' | 'completed';
}

// Self-service phone change, OTP-gated — mirrors AdminAuthService's
// email-change flow, adapted to SMS.
export class ChangePhoneInitiateDto {
  @ApiProperty({ example: '+251911223344', description: 'New phone number to move the account to' })
  @IsString()
  @Matches(/^\+?[0-9]{6,15}$/, { message: 'invalid_phone_number_format' })
  newPhone: string;
}

export class ChangePhoneVerifyDto {
  @ApiProperty({ description: 'Verification id returned by change-phone/initiate' })
  @IsUUID('4')
  verificationId: string;

  @ApiProperty({ example: '482913', description: 'OTP sent to the new phone number' })
  @IsString()
  @MinLength(4)
  @MaxLength(8)
  otp: string;
}

// Client uploads to MinIO via a presigned URL first, then passes the
// resulting object key here for validation + persistence.
export class UpdateProfilePictureDto {
  @ApiProperty({ description: 'MinIO object key of the already-uploaded image' })
  @IsString()
  @MaxLength(500)
  filepath: string;
}

// ── New DTOs for the /users endpoints (US-01 .. US-70) ──

export enum RestrictionAbility {
  POST_CONTENT = 'POST_CONTENT',
  LIST_CASE = 'LIST_CASE',
  OFFER_SUPPORT = 'OFFER_SUPPORT',
  TIP = 'TIP',
}

export enum DeletionRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  DELAYED = 'DELAYED',
  DECLINED = 'DECLINED',
  CANCELLED = 'CANCELLED',
}

export enum DeletionDecision {
  APPROVE = 'APPROVE',
  DELAY = 'DELAY',
  DECLINE = 'DECLINE',
}

export enum StatsInterval {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

// Shared pagination for new list routes.
export class UsersPagedQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// Required reason for admin routes that must leave a justification.
export class AdminRequiredReasonDto {
  @ApiProperty({ description: 'Admin justification, stored in the audit log' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

/* ── Self-service ── */

export class UpdateLanguageDto {
  @ApiProperty({ example: 'am', enum: ['am', 'en'] })
  @IsString()
  @IsIn(['am', 'en'])
  preferredLanguage: string;
}

// POST /users/me/delete-request. Re-auth is enforced by the route.
export class RequestAccountDeletionDto {
  @ApiPropertyOptional({ description: 'Why the user wants the account deleted' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ResendPhoneOtpDto {
  @ApiProperty({ description: 'Verification id returned by change-phone/initiate' })
  @IsUUID('4')
  verificationId: string;
}

/* ── Restrictions and warnings ── */

export class CreateRestrictionDto {
  @ApiProperty({ enum: RestrictionAbility })
  @IsEnum(RestrictionAbility)
  ability: RestrictionAbility;

  @ApiProperty({ description: 'Why the restriction is applied' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({ description: 'When the restriction ends. Omit for open-ended.' })
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}

export class CreateWarningDto {
  @ApiProperty({ description: 'Warning text sent to the user' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message: string;

  @ApiPropertyOptional({ description: 'Internal justification, stored in the audit log' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/* ── Bulk actions ── */

export class BulkUserIdsDto {
  @ApiProperty({ type: [String], description: 'Up to 100 user ids' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  userIds: string[];

  @ApiPropertyOptional({ description: 'Admin justification, stored in the audit log' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class BulkUserReasonDto {
  @ApiProperty({ type: [String], description: 'Up to 100 user ids' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  userIds: string[];

  @ApiProperty({ description: 'Admin justification, stored in the audit log' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class BulkWarningDto {
  @ApiProperty({ type: [String], description: 'Up to 100 user ids' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  userIds: string[];

  @ApiProperty({ description: 'Warning text sent to every user' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message: string;
}

export class BulkRestrictionDto extends CreateRestrictionDto {
  @ApiProperty({ type: [String], description: 'Up to 100 user ids' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  userIds: string[];
}

/* ── Deletion, erasure, retention ── */

export class ListDeleteRequestsQueryDto extends UsersPagedQueryDto {
  @ApiPropertyOptional({ enum: DeletionRequestStatus })
  @IsOptional()
  @IsEnum(DeletionRequestStatus)
  status?: DeletionRequestStatus;
}

export class DecideDeletionRequestDto {
  @ApiProperty({ enum: DeletionDecision })
  @IsEnum(DeletionDecision)
  decision: DeletionDecision;

  @ApiProperty({ description: 'Reason for the decision, stored in the audit log' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({ description: 'New earliest deletion date. Used when delaying.' })
  @ValidateIf((o) => o.decision === DeletionDecision.DELAY)
  @IsDateString()
  delayUntil?: string;
}

export class LegalHoldDto {
  @ApiProperty({ description: 'true places the hold, false lifts it' })
  @IsBoolean()
  legalHold: boolean;

  @ApiProperty({ description: 'Reason, stored in the audit log' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class InactiveUsersQueryDto extends UsersPagedQueryDto {
  @ApiPropertyOptional({ example: 90, description: 'Days since last sign-in' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  days?: number = 90;
}

/* ── Merge and verification ── */

export class MergeUserDto {
  @ApiProperty({ description: 'Id of the duplicate account to merge into this one' })
  @IsUUID('4')
  duplicateUserId: string;

  @ApiProperty({ description: 'Reason, stored in the audit log' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

// PATCH /users/:id/phone (admin, on a support request). A code is sent to newPhone.
export class AdminChangePhoneDto {
  @ApiProperty({ example: '+251911223344' })
  @IsString()
  @Matches(/^\+?[0-9]{6,15}$/, { message: 'invalid_phone_number_format' })
  newPhone: string;

  @ApiProperty({ description: 'Support request reference or reason, stored in the audit log' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

/* ── Search, export, statistics ── */

export class UserStatsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Role name' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  role?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @ApiPropertyOptional({ description: 'Account status, for example active or inactive' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;
}

export class UserStatsTimelineQueryDto extends UserStatsQueryDto {
  @ApiPropertyOptional({ enum: StatsInterval })
  @IsOptional()
  @IsEnum(StatsInterval)
  interval?: StatsInterval = StatsInterval.DAY;
}

export class UserSearchQueryDto extends UserStatsQueryDto {
  @ApiProperty({ example: 'haim', description: 'Reference, name or phone' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// GET /users/export query and POST /users/export-jobs body.
export class UserExportQueryDto extends UserStatsQueryDto {
  @ApiPropertyOptional({ description: 'Matches against name or phone' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
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

// PATCH /users/:id/role
export class AssignUserRoleDto {
  @ApiProperty({
    example: RolesEnum.ADMIN,
    description: 'Role to grant the user',
    enum: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN],
  })
  @IsString()
  @IsIn([RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN])
  role: RolesEnum.ADMIN | RolesEnum.SUPER_ADMIN;

  @ApiPropertyOptional({ description: 'Admin justification, stored in the audit log' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
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
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { RolesEnum } from 'src/common/enums/roles.enum';
import { IsStrongPassword } from 'src/common/decorators/strong-password.decorator';

export { ResetPasswordDto } from './auth.dto';

export class AdminLoginEmailDto {
  @ApiProperty({
    description: 'Registered admin email address',
    example: 'admin@ehte.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'Admin account password',
    example: 'EhteSuper1234!',
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}

export class AdminRegisterDto {
  @ApiProperty({
    description: 'Email address of the admin being registered',
    example: 'new.admin@ehte.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'Full name of the admin being registered',
    example: 'Haimanot Beka',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description:
      'Names of existing roles to grant the new admin (ADMIN, SUPER_ADMIN, or any custom role ' +
      'created via POST /roles). USER and SYSTEM are rejected. Each name must exist in the role table.',
    example: [RolesEnum.ADMIN],
    isArray: true,
    type: String,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  roles: string[];
}

export class AdminRegisterResendDto {
  @ApiProperty({
    description: 'Email address of the pending admin registration to resend',
    example: 'new.admin@ehte.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class AdminCompleteRegistrationDto {
  @ApiProperty({
    description: 'Raw registration token from the emailed registration link',
  })
  @IsString()
  @IsNotEmpty()
  registrationToken: string;

  @ApiProperty({
    description: 'Password the new admin is choosing for their own account',
    example: 'EhteSuper1234!',
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @IsStrongPassword()
  @MaxLength(128)
  password: string;
}

export class AdminForgotPasswordDto {
  @ApiProperty({
    description: 'Registered admin email address to receive the password reset OTP',
    example: 'admin@ehte.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class AdminChangePasswordInitiateDto {
  @ApiProperty({
    description: "The authenticated admin's current password",
  })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;
}

export class PromoteUserDto {
  @ApiProperty({
    description: 'Phone number of the existing user to promote',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: "Email address to attach to the user's account",
    example: 'promoted.user@ehte.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class PromoteUserResendDto {
  @ApiProperty({
    description: 'Phone number of the user whose pending promotion email should be resent',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;
}

export class PromoteVerifyDto {
  @ApiProperty({
    description: 'Secure promotion token received through the email link',
    example: 'a1b2c3d4e5f6...',
  })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({
    description:
      'New password the promoted user sets for admin sign-in (admin length rules apply, 12+ by default)',
    example: 'EhteSuper1234!',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @IsStrongPassword()
  @MaxLength(128)
  password: string;
}

export class AdminCancelRegistrationDto {
  @ApiProperty({
    description: 'Email address of the pending admin registration to cancel',
    example: 'new.admin@ehte.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class AdminChangeEmailDto {
  @ApiProperty({
    description: 'New email address to use for admin login',
    example: 'new-address@ehte.com',
  })
  @IsEmail()
  @IsNotEmpty()
  newEmail: string;
}

export class AdminChangeEmailVerifyDto {
  @ApiProperty({
    description: 'Secure email-change token received through the verification link',
    example: 'a1b2c3d4e5f6...',
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}

// New DTOs for the endpoints added to AdminAuthController (AR-13 … AR-28, AR-78, AR-79).

// ADMIN — CANCEL PENDING PROMOTION (AR-13). Same lookup key as promote/resend.
export class PromoteCancelDto {
  @ApiProperty({
    description: 'Phone number of the user whose pending promotion should be cancelled',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;
}

// ADMIN — RESEND EMAIL CHANGE VERIFICATION (AR-17). The pending change belongs to the caller,
// so nothing is needed; kept as a class so the route can grow without a breaking change.
export class AdminChangeEmailResendDto {
  @ApiPropertyOptional({ description: 'New email the pending change was requested for' })
  @IsOptional()
  @IsEmail()
  newEmail?: string;
}

// ADMIN — DEMOTE (AR-22). Re-auth `password` is read and stripped by the guard.
export class DemoteAdminDto {
  @ApiProperty({ description: 'ID of the admin to demote' })
  @IsUUID()
  userId: string;

  @ApiProperty({
    description: 'Why the ADMIN role is being removed (kept in the audit event)',
    minLength: 5,
    maxLength: 500,
  })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

// ADMIN — LOGIN HISTORY (AR-28)
export class AdminLoginHistoryQueryDto {
  @ApiPropertyOptional({ description: 'Only this admin' })
  @IsOptional()
  @IsUUID()
  adminId?: string;

  @ApiPropertyOptional({ enum: ['SUCCESS', 'FAILED', 'LOCKED'] })
  @IsOptional()
  @IsString()
  result?: 'SUCCESS' | 'FAILED' | 'LOCKED';

  @ApiPropertyOptional({ description: 'ISO date, inclusive' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ADMIN — STATS (AR-78)
export class AdminStatsQueryDto {
  @ApiPropertyOptional({ description: 'ISO date, inclusive' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: ['day', 'week', 'month'], default: 'day' })
  @IsOptional()
  @IsString()
  interval?: 'day' | 'week' | 'month';
}
import { Type } from 'class-transformer';
import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

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

// Reused as-is: channel-agnostic (verificationId + otp), so the admin
// reset-password endpoint takes the same shape as the user one. Also reused
// (unchanged) as the payload for step 2 of adminChangePassword — see
// AdminChangePasswordInitiateDto below for step 1.
export { ResetPasswordDto } from '../../auth/dto/auth.dto';

// ─────────────────────────────────────────────
// ADMIN — LOGIN BY EMAIL  (Doc §1, §7: Admin/Super Admin login is
// specified as Email + Password. This is the only admin credential
// path — phone-based admin login has been removed. Used by
// AdminAuthService.adminLoginByEmail().
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// ADMIN — REGISTER  (Doc §2, Step 1-2)
//
// Super Admin supplies email + full name + the roles to grant.
// Account is created with no password and inactive/unverified — the
// "REGISTERING" state — and a registration link (containing a raw, single-use
// token) is emailed to the new admin. Used by
// AdminAuthService.adminRegister().
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// ADMIN — RESEND REGISTRATION  (Phase 1 #6)
// ─────────────────────────────────────────────

export class AdminRegisterResendDto {
  @ApiProperty({
    description: 'Email address of the pending admin registration to resend',
    example: 'new.admin@ehte.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

// ─────────────────────────────────────────────
// ADMIN — COMPLETE REGISTRATION  (Doc §2, Step 3)
// ─────────────────────────────────────────────

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
  @MinLength(8)
  @MaxLength(128)
  password: string;
}

// ─────────────────────────────────────────────
// ADMIN — FORGOT PASSWORD  (email-only; no phone)
//
// Already email-OTP-based end to end: adminForgotPassword() issues the OTP via
// OtpChannelEnum.email, and adminResetPassword() (POST /admin/auth/reset-password)
// consumes it. This is already a separate endpoint pair from the USER
// /auth/forgot-password + /auth/reset-password flow, which is phone/SMS-based.
// No change needed here — noted for clarity alongside the new change-password flow.
// ─────────────────────────────────────────────

export class AdminForgotPasswordDto {
  @ApiProperty({
    description: 'Registered admin email address to receive the password reset OTP',
    example: 'admin@ehte.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

// ─────────────────────────────────────────────
// ADMIN — CHANGE PASSWORD (STEP 1): authenticated self-service password change.
//
// Deliberately a dedicated admin-only endpoint (POST /admin/auth/change-password/initiate)
// rather than the shared USER /auth/change-password endpoint — AuthService.changePassword()
// now rejects any account holding an admin role and points it here instead. Verification
// is two-factor: this DTO's currentPassword proves the admin still knows their password,
// then an OTP is emailed to their own address (step 2 uses the existing ResetPasswordDto
// shape: verificationId + otp + newPassword) before the change is committed.
// ─────────────────────────────────────────────

export class AdminChangePasswordInitiateDto {
  @ApiProperty({
    description: "The authenticated admin's current password",
  })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;
}

// ─────────────────────────────────────────────
// ADMIN — PROMOTE EXISTING USER  (Doc §3, Step 1-2)
//
// KNOWN LIMITATION: this flow always grants ADMIN, never SUPER_ADMIN.
// Adding a `role` field here wouldn't be enough on its own — UserOtp
// has nowhere to persist that choice between promoteUserInitiate()
// and promoteUserVerify(), so it would need a schema change (e.g. a
// nullable `metadata` column on UserOtp) to round-trip safely.
// Promoting to SUPER_ADMIN currently requires a direct DB action.
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// ADMIN — RESEND PROMOTION  (Phase 1 #6)
// ─────────────────────────────────────────────

export class PromoteUserResendDto {
  @ApiProperty({
    description: 'Phone number of the user whose pending promotion email should be resent',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;
}

// ─────────────────────────────────────────────
// ADMIN — PROMOTE: VERIFY EMAIL LINK
// ─────────────────────────────────────────────

export class PromoteVerifyDto {
  @ApiProperty({
    description: 'Secure promotion token received through the email link',
    example: 'a1b2c3d4e5f6...',
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}

// ─────────────────────────────────────────────
// ADMIN — CANCEL PENDING REGISTRATION
// ─────────────────────────────────────────────

export class AdminCancelRegistrationDto {
  @ApiProperty({
    description: 'Email address of the pending admin registration to cancel',
    example: 'new.admin@ehte.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

// ─────────────────────────────────────────────
// ADMIN — CHANGE OWN EMAIL  (self-service)
//
// Gated by @RequireReauthentication() at the controller, which reads and
// strips a `password` field from the raw request body before this DTO is
// built — that's why there's no password field here.
// ─────────────────────────────────────────────

export class AdminChangeEmailDto {
  @ApiProperty({
    description: 'New email address to use for admin login',
    example: 'new-address@ehte.com',
  })
  @IsEmail()
  @IsNotEmpty()
  newEmail: string;
}

// ─────────────────────────────────────────────
// ADMIN — CHANGE OWN EMAIL: VERIFY LINK
// ─────────────────────────────────────────────

export class AdminChangeEmailVerifyDto {
  @ApiProperty({
    description: 'Secure email-change token received through the verification link',
    example: 'a1b2c3d4e5f6...',
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}

// ═════════════════════════════════════════════
// NEW ENDPOINTS (AR-xx) — added to the existing DTOs
// ═════════════════════════════════════════════

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
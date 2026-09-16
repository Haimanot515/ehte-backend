import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

// ─────────────────────────────────────────────
// SIGN UP
// ─────────────────────────────────────────────

export class SignupDto {
  @ApiPropertyOptional({
    description: 'Name of the user',
    example: 'Abebe Kebede',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({
    description: 'Phone number of the user',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: 'Password for the new account',
    example: 'StrongPassword123',
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
// SIGN UP — VERIFY OTP
// ─────────────────────────────────────────────

export class SignupVerifyDto {
  @ApiProperty({
    description: 'Verification ID returned from signup',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty()
  verificationId: string;

  @ApiProperty({
    description: 'Phone number used during signup',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: 'OTP sent to the user by SMS',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  otp: string;
}

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────

export class LoginDto {
  @ApiProperty({
    description: 'Registered phone number',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: 'Account password',
    example: 'StrongPassword123',
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}

// ─────────────────────────────────────────────
// REFRESH TOKEN
// ─────────────────────────────────────────────

export class RefreshTokenDto {
  @ApiProperty({
    description: 'Refresh token issued after successful authentication',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

// ─────────────────────────────────────────────
// FORGOT PASSWORD
// ─────────────────────────────────────────────

export class ForgotPasswordDto {
  @ApiProperty({
    description: 'Registered phone number to receive the password reset OTP',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;
}

// ─────────────────────────────────────────────
// RESET PASSWORD
//
// Shared shape: also used by AdminAuthController's /admin/auth/reset-password and
// /admin/auth/change-password/verify (imported there from this file — see
// admin-auth/dto/admin-auth.dto.ts), AND by AuthController's own
// /auth/change-password/verify below. It's channel-agnostic (verificationId + otp
// only, no phone/email), so one class covers every OTP-verify call site without
// needing a channel-specific variant.
// ─────────────────────────────────────────────

export class ResetPasswordDto {
  @ApiProperty({
    description: 'Verification ID returned from forgot-password',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty()
  verificationId: string;

  @ApiProperty({
    description: 'OTP sent to the user',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  otp: string;

  @ApiProperty({
    description: 'New password',
    example: 'NewStrongPassword123',
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}

// ─────────────────────────────────────────────
// CHANGE PASSWORD (STEP 1) — authenticated USER proves their current password;
// an OTP is then sent by SMS to their own registered phone number. Step 2 reuses
// ResetPasswordDto above (verificationId + otp + newPassword).
//
// Mirrors AdminChangePasswordInitiateDto in admin-auth.dto.ts, but that flow emails
// its OTP instead of texting it — USER accounts are phone-first (no guaranteed
// email), ADMIN accounts are email-first (no guaranteed phone), so each flow uses
// whichever contact channel that account type is required to have.
// ─────────────────────────────────────────────

export class ChangePasswordInitiateDto {
  @ApiProperty({
    description: 'Current password of the authenticated user',
  })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;
}

// Retained for any existing callers still on the single-step shape; no longer used
// by AuthController, which now requires the OTP step below via ChangePasswordInitiateDto
// + ResetPasswordDto instead of accepting currentPassword + newPassword in one call.
export class ChangePasswordDto {
  @ApiProperty({
    description: 'Current password of the authenticated user',
  })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({
    description: 'New password',
    example: 'NewStrongPassword123',
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}

// ─────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────

export class LogoutDto {
  @ApiPropertyOptional({
    description: 'Refresh token to revoke. If omitted, all sessions are revoked.',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
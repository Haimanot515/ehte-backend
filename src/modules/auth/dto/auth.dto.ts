import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import {
  IsEnum,
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
// SOCIAL SIGNUP / LOGIN — GOOGLE
//
// One endpoint handles both signup and login: the client gets an ID token from
// Google's own SDK, we verify it server-side, and find-or-create the account.
// ─────────────────────────────────────────────

export class GoogleAuthDto {
  @ApiProperty({
    description: "ID token returned by Google Sign-In on the client (NOT an access token)",
  })
  @IsString()
  @IsNotEmpty()
  idToken: string;
}

// ─────────────────────────────────────────────
// SOCIAL SIGNUP / LOGIN — FACEBOOK
// ─────────────────────────────────────────────

export class FacebookAuthDto {
  @ApiProperty({
    description: 'Access token returned by the Facebook SDK on the client',
  })
  @IsString()
  @IsNotEmpty()
  accessToken: string;
}

// ─────────────────────────────────────────────
// SOCIAL SIGNUP / LOGIN — APPLE
//
// `name` is optional and only meaningful on a user's very first-ever
// "Sign in with Apple" — Apple sends it to the client just that once, never
// inside the token itself, so the client forwards it to us if present.
// ─────────────────────────────────────────────

export class AppleAuthDto {
  @ApiProperty({
    description: 'Identity token returned by Sign in with Apple',
  })
  @IsString()
  @IsNotEmpty()
  idToken: string;

  @ApiPropertyOptional({
    description: "User's full name — only ever sent by Apple on the first authorization",
  })
  @IsOptional()
  @IsString()
  name?: string;
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

// ═════════════════════════════════════════════
// NEW ENDPOINTS (AR-xx) — added to the existing DTOs
// ═════════════════════════════════════════════

// New DTOs for the endpoints added to AuthController (AR-01 … AR-12, AR-61 … AR-69).
// Re-authentication routes read and strip `password` in the guard, so it is not a field here
// unless the spec says the password is part of the request itself (2FA disable).

export enum SocialProviderEnum {
  GOOGLE = 'google',
  FACEBOOK = 'facebook',
  APPLE = 'apple',
}

export enum TwoFactorMethodEnum {
  TOTP = 'TOTP',
  SMS = 'SMS',
}

// ─────────────────────────────────────────────
// FORGOT PASSWORD — VERIFY OTP (AR-02)
// ─────────────────────────────────────────────

export class VerifyResetOtpDto {
  @ApiProperty({ description: 'Verification ID returned from forgot-password' })
  @IsString()
  @IsNotEmpty()
  verificationId: string;

  @ApiProperty({ description: 'OTP sent to the user', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  otp: string;
}

// ─────────────────────────────────────────────
// REACTIVATION (AR-04, AR-05)
// ─────────────────────────────────────────────

export class ReactivateInitiateDto {
  @ApiProperty({ description: 'Phone number of the deactivated account', example: '+251943257078' })
  @IsString()
  @IsNotEmpty()
  phone: string;
}

export class ReactivateVerifyDto {
  @ApiProperty({ description: 'Verification ID returned from reactivate/initiate' })
  @IsString()
  @IsNotEmpty()
  verificationId: string;

  @ApiProperty({ description: 'OTP sent to the user', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  otp: string;
}

// ─────────────────────────────────────────────
// SOCIAL LINK (AR-06). Provider comes from the path; the token proves control of the
// social account, same as the social login routes.
// ─────────────────────────────────────────────

export class LinkSocialDto {
  @ApiProperty({
    description: 'ID token (Google, Apple) or access token (Facebook) for the account to link',
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}

// ─────────────────────────────────────────────
// SET PASSWORD for a social-only account (AR-08)
// ─────────────────────────────────────────────

export class SetPasswordDto {
  @ApiProperty({
    description: 'Password to add to the account',
    example: 'StrongPassword123',
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
// SIGNUP STATUS (AR-11)
// ─────────────────────────────────────────────

export class SignupStatusDto {
  @ApiProperty({ description: 'Verification ID returned from signup' })
  @IsString()
  @IsNotEmpty()
  verificationId: string;
}

// ─────────────────────────────────────────────
// REVOKE REFRESH TOKEN (AR-12)
// ─────────────────────────────────────────────

export class RevokeRefreshTokenDto {
  @ApiProperty({ description: 'Refresh token to revoke' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

// ─────────────────────────────────────────────
// TWO-FACTOR — SETUP (AR-62)
// ─────────────────────────────────────────────

export class TwoFactorSetupDto {
  @ApiPropertyOptional({
    enum: TwoFactorMethodEnum,
    default: TwoFactorMethodEnum.TOTP,
    description: 'Method to enrol. Defaults to an authenticator app (TOTP).',
  })
  @IsOptional()
  @IsEnum(TwoFactorMethodEnum)
  method?: TwoFactorMethodEnum;
}

// ─────────────────────────────────────────────
// TWO-FACTOR — CONFIRM SETUP (AR-63)
// ─────────────────────────────────────────────

export class TwoFactorVerifyDto {
  @ApiProperty({ description: '6-digit code from the authenticator app', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  code: string;
}

// ─────────────────────────────────────────────
// TWO-FACTOR — DISABLE (AR-64). Needs the password AND a current code, so `password`
// is a real field here (the re-auth guard strips it first; keep it for the service check).
// ─────────────────────────────────────────────

export class TwoFactorDisableDto {
  @ApiPropertyOptional({ description: 'Current password (also read by the re-auth guard)' })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiProperty({ description: 'Current 6-digit 2FA code', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  code: string;
}

// ─────────────────────────────────────────────
// TWO-FACTOR — REGENERATE RECOVERY CODES (AR-65)
// ─────────────────────────────────────────────

export class TwoFactorRegenerateDto {
  @ApiProperty({ description: 'Current 6-digit 2FA code', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  code: string;
}

// ─────────────────────────────────────────────
// TWO-FACTOR — LOGIN (AR-66, AR-67, AR-68)
// ─────────────────────────────────────────────

export class TwoFactorLoginVerifyDto {
  @ApiProperty({ description: 'challengeId returned by login when requires2fa is true' })
  @IsString()
  @IsNotEmpty()
  challengeId: string;

  @ApiProperty({ description: '6-digit code', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  code: string;
}

export class TwoFactorLoginRecoveryDto {
  @ApiProperty({ description: 'challengeId returned by login when requires2fa is true' })
  @IsString()
  @IsNotEmpty()
  challengeId: string;

  @ApiProperty({ description: 'Single-use recovery code', example: 'ABCD-EFGH-IJKL' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  recoveryCode: string;
}

export class TwoFactorLoginResendDto {
  @ApiProperty({ description: 'challengeId returned by login when requires2fa is true' })
  @IsString()
  @IsNotEmpty()
  challengeId: string;
}

// ─────────────────────────────────────────────
// TWO-FACTOR — STEP-UP (AR-69)
// ─────────────────────────────────────────────

export class TwoFactorStepUpDto {
  @ApiProperty({ description: '6-digit code', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  code: string;

  @ApiPropertyOptional({ description: 'Action the fresh code is for, kept in the audit event' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;
}
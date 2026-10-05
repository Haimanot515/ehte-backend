import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

export class GoogleAuthDto {
  @ApiProperty({
    description: 'ID token returned by Google Sign-In on the client (NOT an access token)',
  })
  @IsString()
  @IsNotEmpty()
  idToken: string;
}

export class FacebookAuthDto {
  @ApiProperty({
    description: 'Access token returned by the Facebook SDK on the client',
  })
  @IsString()
  @IsNotEmpty()
  accessToken: string;
}

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

export class RefreshTokenDto {
  @ApiProperty({
    description: 'Refresh token issued after successful authentication',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class ForgotPasswordDto {
  @ApiProperty({
    description: 'Registered phone number to receive the password reset OTP',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;
}

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

export class ChangePasswordInitiateDto {
  @ApiProperty({
    description: 'Current password of the authenticated user',
  })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;
}

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

export class LogoutDto {
  @ApiPropertyOptional({
    description: 'Refresh token to revoke. If omitted, all sessions are revoked.',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export enum SocialProviderEnum {
  GOOGLE = 'google',
  FACEBOOK = 'facebook',
  APPLE = 'apple',
}

export enum TwoFactorMethodEnum {
  TOTP = 'TOTP',
  SMS = 'SMS',
}

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

export class LinkSocialDto {
  @ApiProperty({
    description: 'ID token (Google, Apple) or access token (Facebook) for the account to link',
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}

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

export class SignupStatusDto {
  @ApiProperty({ description: 'Verification ID returned from signup' })
  @IsString()
  @IsNotEmpty()
  verificationId: string;
}

export class RevokeRefreshTokenDto {
  @ApiProperty({ description: 'Refresh token to revoke' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

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

export class TwoFactorVerifyDto {
  @ApiProperty({ description: '6-digit code from the authenticator app', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  code: string;
}

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

export class TwoFactorRegenerateDto {
  @ApiProperty({ description: 'Current 6-digit 2FA code', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @IsNumberString()
  @Length(6, 6)
  code: string;
}

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

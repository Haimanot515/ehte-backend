
import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
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
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
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
    description:
      'Refresh token issued after successful authentication',
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
    description:
      'Registered phone number to receive the password reset OTP',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;
}

// ─────────────────────────────────────────────
// RESET PASSWORD
// ─────────────────────────────────────────────

export class ResetPasswordDto {
  @ApiProperty({
    description:
      'Verification ID returned from forgot-password',
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
  @Length(6, 6)
  otp: string;

  @ApiProperty({
    description: 'New password',
    example: 'NewStrongPassword123',
    minLength: 8,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  newPassword: string;
}

// ─────────────────────────────────────────────
// CHANGE PASSWORD
// ─────────────────────────────────────────────

export class ChangePasswordDto {
  @ApiProperty({
    description:
      'Current password of the authenticated user',
  })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({
    description: 'New password',
    example: 'NewStrongPassword123',
    minLength: 8,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  newPassword: string;
}

// ─────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────

export class LogoutDto {
  @ApiPropertyOptional({
    description:
      'Refresh token to revoke. If omitted, all sessions are revoked.',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

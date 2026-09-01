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

// ─────────────────────────────────────────────
// ADMIN — REGISTER
//
// Used by AdminAuthController.register() /
// AuthService.adminRegister(). The creating admin
// supplies the new admin's name, phone, and initial
// password; the new admin is created PENDING
// (isPhoneVerified: false, isActive: false) and must
// be verified via AdminVerifyDto before they can log in.
// ─────────────────────────────────────────────

export class AdminRegisterDto {
  @ApiPropertyOptional({
    description: 'Name of the new admin',
    example: 'Selam Tesfaye',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({
    description: 'Phone number of the new admin',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: 'Initial password for the new admin account',
    example: 'StrongPassword123',
    minLength: 8,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;
}

// ─────────────────────────────────────────────
// ADMIN — VERIFY REGISTRATION
//
// Used by AdminAuthController.verify() /
// AuthService.adminVerify(). verificationId pins
// this to the exact OTP issued by adminRegister()
// for the pending admin identified by :id — the OTP
// itself is never looked up by "latest unused" alone.
// ─────────────────────────────────────────────

export class AdminVerifyDto {
  @ApiProperty({
    description:
      'Verification ID returned from admin registration',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty()
  verificationId: string;

  @ApiProperty({
    description: 'OTP sent to the new admin by SMS',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  otp: string;
}

// ─────────────────────────────────────────────
// ADMIN — LOGIN
// ─────────────────────────────────────────────

export class AdminLoginDto {
  @ApiProperty({
    description: 'Registered admin phone number',
    example: '+251943257078',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: 'Admin account password',
    example: 'StrongPassword123',
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}
import { ApiProperty } from '@nestjs/swagger';

import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { RolesEnum } from 'src/common/enums/roles.enum';

// Reused as-is: channel-agnostic (verificationId + otp), so the admin
// reset-password endpoint takes the same shape as the user one.
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
    description: 'Roles to grant the new admin — must be ADMIN or SUPER_ADMIN. Any other value ' +
      'would create an account with no phone and no admin role, which could never log in anywhere.',
    example: [RolesEnum.ADMIN],
    enum: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN],
    isArray: true,
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn([RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN], { each: true })
  roles: RolesEnum[];
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
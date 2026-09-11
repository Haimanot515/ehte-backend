import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

import { RolesEnum } from 'src/common/enums/roles.enum';

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
  // FIX (Phase 2 #11): cap password length. Unbounded input to bcrypt.hash()
  // is both a minor DoS surface (bcrypt cost scales with input up to its own
  // 72-byte truncation point) and pointless past a reasonable max.
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
  // FIX (Phase 2 #10): @Length(6, 6) alone lets "abcdef" pass DTO validation
  // and only fail later against the hash compare. Require digits explicitly.
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
  // FIX (Phase 2 #10): reject non-digit OTPs at the DTO layer.
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
  // FIX (Phase 2 #11)
  @MaxLength(128)
  newPassword: string;
}

// ─────────────────────────────────────────────
// CHANGE PASSWORD
// ─────────────────────────────────────────────

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
  // FIX (Phase 2 #11)
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

// ─────────────────────────────────────────────
// ADMIN — LOGIN BY EMAIL  (Doc §1, §7: Admin/Super Admin login is
// specified as Email + Password. This is the only admin credential
// path — phone-based admin login has been removed. Used by
// AuthService.adminLoginByEmail().
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
// AuthService.adminRegister().
// ─────────────────────────────────────────────

export class AdminRegisterDto {
  @ApiProperty({
    description: "Email address of the admin being registered",
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
//
// Super Admin re-sends a registration email with a freshly generated token
// for an account still sitting in the "REGISTERING" state (no password
// set, never activated). Used by AuthService.adminRegisterResend().
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
//
// The registering admin calls this anonymously using the raw token from
// their registration link to set their own password. Possessing the token
// proves control of the registering inbox, so this also activates the
// account and returns tokens directly. Used by
// AuthService.adminCompleteRegistration().
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
  // FIX (Phase 2 #11)
  @MaxLength(128)
  password: string;
}

// ─────────────────────────────────────────────
// ADMIN — FORGOT PASSWORD  (email-only; no phone)
//
// Admin/Super Admin supplies their email; if it belongs to an active
// admin account, a password_reset OTP is emailed. Existence is
// masked the same way ForgotPasswordDto masks phone existence — an
// empty verificationId means "check your email if this account
// exists", not a confirmed miss. Used by AuthService.adminForgotPassword().
// The OTP is then submitted via the existing /reset-password
// endpoint (ResetPasswordDto), which is already channel-agnostic —
// it only needs verificationId + otp, never a phone number.
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
// Super Admin selects an existing USER by phone and supplies the
// email address to attach to their account. The user's existing
// password is untouched — only their email is added and an OTP is
// sent to verify it before the ADMIN role is actually granted. Used
// by AuthService.promoteUserInitiate().
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
//
// Super Admin re-sends the promotion verification email with a
// freshly generated token, for a user whose promotion is still
// pending (email attached, not yet verified). Used by
// AuthService.promoteUserResend().
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
//
// The user being promoted clicks the link in the email from
// promoteUserInitiate() and the frontend submits the token it
// received in the URL. Possessing the token IS the proof of email
// ownership — no separate OTP, verificationId, phone, password, or
// userId is needed. Used by AuthService.promoteUserVerify().
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
//
// Super Admin revokes a registration that was sent to the wrong
// address, is no longer wanted, or should be cleaned up before
// completion. Only valid while the account is still "REGISTERING"
// (no password set, never activated) — AuthService.adminCancelRegistration()
// rejects this once the invited admin has already completed
// registration; use UserController's deactivate/revoke-role
// endpoints for a completed admin instead.
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
// Any authenticated account holding an admin role may change its
// OWN login email — not a SUPER_ADMIN-on-someone-else action.
// Gated by @RequireReauthentication() at the controller (same
// pattern as UserController.updateDiscreetMode()), which reads and
// strips a `password` field from the raw request body before this
// DTO is built — that's why there's no password field here, same
// reasoning as UpdateDiscreetModeDto's note in user.dto.ts.
// Used by AuthService.adminChangeEmailInitiate().
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
//
// The admin clicks the link sent to their NEW address and the
// frontend submits the token from the URL. Possessing the token IS
// the proof of inbox ownership — same trust model as
// PromoteVerifyDto. Used by AuthService.adminChangeEmailVerify().
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
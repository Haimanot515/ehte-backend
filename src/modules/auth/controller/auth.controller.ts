import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Throttle } from '@nestjs/throttler';

import { AuthService } from '../service/auth.service';

import {
  SignupDto,
  SignupVerifyDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  RefreshTokenDto,
  AdminInviteDto,
  AdminInviteResendDto,
  AdminSetPasswordDto,
  AdminLoginEmailDto,
  AdminForgotPasswordDto,
  PromoteUserDto,
  PromoteUserResendDto,
  PromoteVerifyDto,
} from '../dto/auth.dto';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // SIGN UP — REQUEST OTP
  // FIX: tighter throttle — account creation + SMS cost per request

  @AllowAnonymous()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('signup')
  @ApiOperation({
    summary: 'Create signup request and send OTP to phone',
  })
  async signup(@Body() data: SignupDto) {
    return this.authService.signup(data);
  }

  // SIGN UP — VERIFY OTP
  // FIX: tighter throttle — OTP brute-force surface

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('signup/verify')
  @ApiOperation({
    summary: 'Verify signup OTP and activate the user account',
  })
  async verifySignupOtp(@Body() data: SignupVerifyDto) {
    return this.authService.verifySignupOtp(data);
  }

  // SIGN UP — RESEND OTP
  // FIX: tightest throttle — direct SMS-bombing vector

  @AllowAnonymous()
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('signup/resend-otp/:verificationId')
  @ApiOperation({
    summary: 'Resend signup OTP',
  })
  async resendSignupOtp(
    @Param('verificationId')
    verificationId: string,
  ) {
    return this.authService.resendSignupOtp(verificationId);
  }

  // LOGIN
  // FIX: tighter throttle — credential-guessing surface
  // NOTE: USER accounts only — an ADMIN/SUPER_ADMIN account is rejected by
  // AuthService.login() even if it still has a phone + password. Use
  // AdminAuthController.login() (email + password) for admin accounts.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @ApiOperation({
    summary: 'Login with phone number and password (USER accounts only)',
  })
  async login(@Body() data: LoginDto) {
    return this.authService.login(data);
  }

  // REFRESH TOKEN
  // Left at global default — requires a valid signed token, not a guessable credential

  @AllowAnonymous()
  @Post('refresh')
  @ApiOperation({
    summary: 'Refresh access token',
  })
  async refresh(@Body() data: RefreshTokenDto) {
    return this.authService.refresh(data);
  }

  // FORGOT PASSWORD
  // FIX: tighter throttle — SMS-bombing vector
  // NOTE: USER accounts only — an ADMIN/SUPER_ADMIN phone is masked the same
  // way a nonexistent phone is. Admin password recovery is email-based via
  // AdminAuthController.forgotPassword().

  @AllowAnonymous()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('forgot-password')
  @ApiOperation({
    summary: 'Request password reset OTP (USER accounts only)',
  })
  async forgotPassword(@Body() data: ForgotPasswordDto) {
    return this.authService.forgotPassword(data);
  }

  // RESET PASSWORD
  // FIX: tighter throttle — OTP brute-force surface

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('reset-password')
  @ApiOperation({
    summary: 'Reset password using OTP',
  })
  async resetPassword(@Body() data: ResetPasswordDto) {
    return this.authService.resetPassword(data);
  }

  // CURRENT USER: 'access-token' must match the scheme name registered in main.ts's addBearerAuth, or Swagger UI has nothing to attach the token to

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get currently authenticated user',
  })
  async me(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.authService.me(user);
  }

  // CHANGE PASSWORD

  @Post('change-password')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Change password for authenticated user',
  })
  async changePassword(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: ChangePasswordDto,
  ) {
    return this.authService.changePassword(user, data);
  }

  // LOGOUT

  @Post('logout')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logout and invalidate current session',
  })
  async logout(
    @CurrentUser()
    user: CurrentUserDto,

    @Req()
    req: any,
  ) {
    return this.authService.logout(user, req);
  }
}

// ADMIN AUTHENTICATION: separate controller for /admin/auth routing and role separation, but shares the 'Authentication' Swagger tag

@ApiTags('Authentication')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly authService: AuthService) {}

  // ── Admin onboarding — email + roles + full name, invite-link flow (Doc §2) ──

  // ADMIN — INVITE (POST /admin/auth/invite, SUPER_ADMIN): Super Admin supplies
  // email + full name + roles only; no password set by creator
  // FIX: throttled — account-creation + email-send cost per request

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('invite')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Invite a new admin by email + name + roles (invite-link flow, no creator-set password)',
  })
  async invite(@CurrentUser() user: CurrentUserDto, @Body() data: AdminInviteDto) {
    return this.authService.adminInvite(user, data);
  }

  // ADMIN — RESEND INVITE (POST /admin/auth/invite/resend, SUPER_ADMIN):
  // re-sends the invite email with a fresh token if the original never
  // arrived (e.g. sendEmail() failed) or the link expired before use.
  // FIX: throttled — email-send cost per request

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('invite/resend')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Resend a pending admin invite email with a freshly generated token',
  })
  async resendInvite(@CurrentUser() user: CurrentUserDto, @Body() data: AdminInviteResendDto) {
    return this.authService.adminInviteResend(user, data);
  }

  // ADMIN — SET PASSWORD FROM INVITE (POST /admin/auth/invite/set-password, ANONYMOUS):
  // invited admin uses their raw invite token to set their own password. Possessing
  // the token proves control of the invited inbox, so this also activates the
  // account and returns tokens — no separate post-password OTP step.
  // FIX: throttled — token-guessing surface

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('invite/set-password')
  @ApiOperation({
    summary: 'Invited admin sets their own password using their invite token; activates the account and returns tokens',
  })
  async setPasswordFromInvite(@Body() data: AdminSetPasswordDto) {
    return this.authService.adminSetPasswordFromInvite(data);
  }

  // ── Existing user → admin promotion (Doc §3) ──

  // ADMIN — PROMOTE USER (POST /admin/auth/promote, SUPER_ADMIN): attaches
  // an email to an existing USER and sends an email OTP; role is granted
  // only after promoteUserVerify() succeeds. Requires the target USER to be
  // active and phone-verified (see AuthService.promoteUserInitiate()).
  // FIX: throttled — email-send cost per request

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('promote')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Promote an existing (active, phone-verified) user to admin: attach + send OTP to their new email',
  })
  async promote(@CurrentUser() user: CurrentUserDto, @Body() data: PromoteUserDto) {
    return this.authService.promoteUserInitiate(user, data);
  }

  // ADMIN — RESEND PROMOTION (POST /admin/auth/promote/resend, SUPER_ADMIN):
  // re-sends the promotion verification email with a fresh token if the
  // original never arrived or expired before the user clicked it.
  // FIX: throttled — email-send cost per request

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('promote/resend')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Resend a pending promotion verification email with a freshly generated token',
  })
  async resendPromotion(@CurrentUser() user: CurrentUserDto, @Body() data: PromoteUserResendDto) {
    return this.authService.promoteUserResend(user, data);
  }

  // ADMIN — PROMOTE: VERIFY (POST /admin/auth/promote/verify, ANONYMOUS): the
  // user being promoted verifies the OTP sent to their new email themselves
  // FIX: throttled — OTP brute-force surface

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('promote/verify')
  @ApiOperation({
    summary: 'User being promoted verifies their email OTP; grants the ADMIN role',
  })
  async promoteVerify(@Body() data: PromoteVerifyDto) {
    return this.authService.promoteUserVerify(data);
  }

  // ADMIN — LOGIN (POST /admin/auth/login, ANONYMOUS): the only admin credential
  // path. Phone-based admin login has been removed — admins and super admins
  // always authenticate with email + password (Doc §1, §7). Required for admins
  // created via the invite flow, who may have no phone at all. Also now requires
  // isEmailVerified (see AuthService.adminLoginByEmail()).
  // FIX: throttled — credential-guessing surface, high-privilege target

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @ApiOperation({
    summary: 'Admin login with email and password',
  })
  async login(@Body() data: AdminLoginEmailDto) {
    return this.authService.adminLoginByEmail(data);
  }

  // ── Admin password recovery — email-only, no phone ──

  // ADMIN — FORGOT PASSWORD (POST /admin/auth/forgot-password, ANONYMOUS):
  // admin supplies their email; a password_reset OTP is emailed if the
  // account exists, is an admin, and is active. Existence is masked.
  // FIX: throttled — email-bombing vector

  @AllowAnonymous()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('forgot-password')
  @ApiOperation({
    summary: 'Request password reset OTP via admin email',
  })
  async forgotPassword(@Body() data: AdminForgotPasswordDto) {
    return this.authService.adminForgotPassword(data);
  }

  // ADMIN — RESET PASSWORD (POST /admin/auth/reset-password, ANONYMOUS):
  // submits the emailed OTP + new password.
  //
  // FIX (Phase 1 #3): now calls AuthService.adminResetPassword() instead of
  // resetPassword() directly. adminResetPassword() re-verifies the OTP's
  // owner actually holds an ADMIN/SUPER_ADMIN role before delegating to the
  // shared resetPassword() — calling resetPassword() directly here bypassed
  // that check entirely, silently accepting any valid password_reset OTP
  // (including one issued by the USER-facing /auth/forgot-password flow) on
  // the admin-scoped route.
  // FIX: throttled — OTP brute-force surface

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('reset-password')
  @ApiOperation({
    summary: 'Reset admin password using the emailed OTP (admin-scoped)',
  })
  async resetPassword(@Body() data: ResetPasswordDto) {
    return this.authService.adminResetPassword(data);
  }
}
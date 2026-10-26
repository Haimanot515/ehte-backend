import { Body, Controller, Delete, Get, Param, ParseEnumPipe, Post, Req } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { Throttle } from '@nestjs/throttler';

import { AuthService } from '../service/auth.service';

import {
  SignupDto,
  SignupVerifyDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordInitiateDto,
  RefreshTokenDto,
  GoogleAuthDto,
  FacebookAuthDto,
  AppleAuthDto,
  SocialProviderEnum,
  VerifyResetOtpDto,
  ReactivateInitiateDto,
  ReactivateVerifyDto,
  LinkSocialDto,
  SetPasswordDto,
  SignupStatusDto,
  RevokeRefreshTokenDto,
  TwoFactorSetupDto,
  TwoFactorVerifyDto,
  TwoFactorDisableDto,
  TwoFactorRegenerateDto,
  TwoFactorLoginVerifyDto,
  TwoFactorLoginRecoveryDto,
  TwoFactorLoginResendDto,
  TwoFactorStepUpDto,
} from '../dto/auth.dto';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { RequireCaptcha } from 'src/common/decorators/require-captcha.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // SIGN UP — REQUEST OTP. Tight throttle: account creation + SMS cost per request.

  @AllowAnonymous()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @RequireCaptcha()
  @Post('signup')
  @ApiOperation({
    summary: 'Create signup request and send OTP to phone',
  })
  async signup(@Body() data: SignupDto) {
    return this.authService.signup(data);
  }

  // SIGN UP — VERIFY OTP. Tight throttle: OTP brute-force surface.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequireCaptcha()
  @Post('signup/verify')
  @ApiOperation({
    summary: 'Verify signup OTP and activate the user account',
  })
  async verifySignupOtp(@Body() data: SignupVerifyDto) {
    return this.authService.verifySignupOtp(data);
  }

  // SIGN UP — RESEND OTP. Tightest throttle: direct SMS-bombing vector.

  @AllowAnonymous()
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @RequireCaptcha()
  @Post('signup/resend-otp/:verificationId')
  @ApiOperation({
    summary: 'Resend signup OTP',
  })
  @AuditEvent({ action: AuditEventEnum.OTP_RESENT, entity: 'Otp', metadata: { purpose: 'signup' } })
  async resendSignupOtp(
    @Param('verificationId')
    verificationId: string,
  ) {
    return this.authService.resendSignupOtp(verificationId);
  }

  // LOGIN — USER accounts only; admin accounts use AdminAuthController.login() instead.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequireCaptcha()
  @Post('login')
  @ApiOperation({
    summary: 'Login with phone number and password (USER accounts only)',
  })
  async login(@Body() data: LoginDto) {
    return this.authService.login(data);
  }

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequireCaptcha()
  @Post('social/google')
  @ApiOperation({
    summary: 'Sign up or log in with a Google ID token (USER accounts only)',
  })
  async loginWithGoogle(@Body() data: GoogleAuthDto) {
    return this.authService.loginWithGoogle(data);
  }

  // SOCIAL LOGIN — FACEBOOK.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequireCaptcha()
  @Post('social/facebook')
  @ApiOperation({
    summary: 'Sign up or log in with a Facebook access token (USER accounts only)',
  })
  async loginWithFacebook(@Body() data: FacebookAuthDto) {
    return this.authService.loginWithFacebook(data);
  }

  // SOCIAL LOGIN — APPLE. Required alongside Google/Facebook on iOS per App Store
  // review guideline 4.8.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequireCaptcha()
  @Post('social/apple')
  @ApiOperation({
    summary: 'Sign up or log in with Sign in with Apple (USER accounts only)',
  })
  async loginWithApple(@Body() data: AppleAuthDto) {
    return this.authService.loginWithApple(data);
  }

  // REFRESH TOKEN. Global default throttle — requires a valid signed token, not a guessable credential.

  @AllowAnonymous()
  @Post('refresh')
  @ApiOperation({
    summary: 'Refresh access token',
  })
  async refresh(@Body() data: RefreshTokenDto) {
    return this.authService.refresh(data);
  }

  // FORGOT PASSWORD — USER accounts only; admin recovery is email-based via AdminAuthController.

  @AllowAnonymous()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @RequireCaptcha()
  @Post('forgot-password')
  @ApiOperation({
    summary: 'Request password reset OTP (USER accounts only)',
  })
  async forgotPassword(@Body() data: ForgotPasswordDto) {
    return this.authService.forgotPassword(data);
  }

  // RESET PASSWORD — "forgot it entirely" flow: no bearer token, OTP is the only proof.
  // Tight throttle: OTP brute-force surface.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequireCaptcha()
  @Post('reset-password')
  @ApiOperation({
    summary: 'Reset password using OTP (USER accounts only, forgot-password flow)',
  })
  async resetPassword(@Body() data: ResetPasswordDto) {
    return this.authService.resetPassword(data);
  }

  // CURRENT USER. 'access-token' must match the scheme name registered in main.ts.

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

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('change-password/initiate')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      "Step 1 of self-service password change: verify the user's current password and SMS them an OTP",
  })
  async changePasswordInitiate(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: ChangePasswordInitiateDto,
  ) {
    return this.authService.changePasswordInitiate(user, data);
  }

  // CHANGE PASSWORD (STEP 2) — possessing the texted OTP proves phone control; reuses
  // the same verificationId + otp + newPassword shape as reset-password.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('change-password/verify')
  @ApiOperation({
    summary:
      'Step 2 of self-service password change: verify the texted OTP and set the new password',
  })
  async changePasswordVerify(@Body() data: ResetPasswordDto) {
    return this.authService.changePasswordVerify(data);
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

  // ───────────────────────────── NEW ENDPOINTS ─────────────────────────────

  // AR-01 — FORGOT PASSWORD: RESEND OTP. Tightest throttle: SMS-bombing vector.

  @AllowAnonymous()
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @RequireCaptcha()
  @Post('forgot-password/resend-otp/:verificationId')
  @ApiOperation({ summary: 'Resend the password reset OTP' })
  @AuditEvent({ action: AuditEventEnum.OTP_RESENT, entity: 'Otp', metadata: { purpose: 'forgot_password' } })
  async resendForgotPasswordOtp(@Param('verificationId') verificationId: string) {
    return this.authService.resendForgotPasswordOtp(verificationId);
  }

  // AR-02 — VERIFY RESET OTP before the new password is typed. OTP brute-force surface.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequireCaptcha()
  @Post('verify-reset-otp')
  @ApiOperation({ summary: 'Check the password reset OTP without resetting the password yet' })
  async verifyResetOtp(@Body() data: VerifyResetOtpDto) {
    return this.authService.verifyResetOtp(data);
  }

  // AR-03 — LOGOUT EVERYWHERE, including this device.

  @Post('logout-all')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Sign out of every session, including this device' })
  async logoutAll(@CurrentUser() user: CurrentUserDto, @Req() req: any) {
    return this.authService.logoutAll(user, req);
  }

  // AR-04 / AR-05 — SELF REACTIVATION of a deactivated account (policy choice).

  @AllowAnonymous()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @RequireCaptcha()
  @Post('reactivate/initiate')
  @ApiOperation({ summary: 'Start self-reactivation of a deactivated account (sends a code)' })
  async reactivateInitiate(@Body() data: ReactivateInitiateDto) {
    return this.authService.reactivateInitiate(data);
  }

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequireCaptcha()
  @Post('reactivate/verify')
  @ApiOperation({ summary: 'Complete self-reactivation with the code' })
  async reactivateVerify(@Body() data: ReactivateVerifyDto) {
    return this.authService.reactivateVerify(data);
  }

  // AR-06 / AR-07 — LINK / UNLINK a social provider.

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('social/link/:provider')
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'provider', enum: SocialProviderEnum })
  @ApiOperation({ summary: 'Link Google, Facebook or Apple to the signed-in account' })
  async linkSocial(
    @CurrentUser() user: CurrentUserDto,
    @Param('provider', new ParseEnumPipe(SocialProviderEnum)) provider: SocialProviderEnum,
    @Body() data: LinkSocialDto,
  ) {
    return this.authService.linkSocial(user, provider, data);
  }

  @Delete('social/link/:provider')
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'provider', enum: SocialProviderEnum })
  @ApiOperation({ summary: 'Unlink a social provider (only if another way to sign in remains)' })
  async unlinkSocial(
    @CurrentUser() user: CurrentUserDto,
    @Param('provider', new ParseEnumPipe(SocialProviderEnum)) provider: SocialProviderEnum,
  ) {
    return this.authService.unlinkSocial(user, provider);
  }

  // AR-08 — SET PASSWORD for a social-only account.

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('set-password')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Add a password to a social-only account' })
  async setPassword(@CurrentUser() user: CurrentUserDto, @Body() data: SetPasswordDto) {
    return this.authService.setPassword(user, data);
  }

  // AR-09 — MY ROLES AND EFFECTIVE PERMISSIONS.

  @Get('me/permissions')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'My roles and effective permissions' })
  async myPermissions(@CurrentUser() user: CurrentUserDto) {
    return this.authService.myPermissions(user);
  }

  // AR-10 — PASSWORD POLICY, shown before submit.

  @AllowAnonymous()
  @Get('password-policy')
  @ApiOperation({ summary: 'The password rules' })
  async passwordPolicy() {
    return this.authService.passwordPolicy();
  }

  // AR-11 — SIGNUP STATUS, to resume an interrupted flow.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequireCaptcha()
  @Post('signup/status')
  @ApiOperation({ summary: 'Check whether a pending signup is still valid' })
  async signupStatus(@Body() data: SignupStatusDto) {
    return this.authService.signupStatus(data);
  }

  // AR-12 — EXPLICIT REFRESH TOKEN REVOCATION.

  @Post('refresh/revoke')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Revoke a refresh token explicitly' })
  async revokeRefresh(@CurrentUser() user: CurrentUserDto, @Body() data: RevokeRefreshTokenDto) {
    return this.authService.revokeRefreshToken(user, data);
  }

  // ───────────────── TWO-FACTOR (needs the login change, flag TWO_FACTOR_ENABLED off by default) ─────────────────

  // AR-61
  @Get('2fa/status')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: '2FA state: on or off, methods, recovery codes remaining' })
  async twoFactorStatus(@CurrentUser() user: CurrentUserDto) {
    return this.authService.twoFactorStatus(user);
  }

  // AR-62
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('2fa/setup')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Create a pending 2FA secret; returns QR data and a manual key' })
  async twoFactorSetup(@CurrentUser() user: CurrentUserDto, @Body() data: TwoFactorSetupDto) {
    return this.authService.twoFactorSetup(user, data);
  }

  // AR-63
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('2fa/verify')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Confirm the setup code, turn 2FA on, return recovery codes once' })
  async twoFactorVerify(@CurrentUser() user: CurrentUserDto, @Body() data: TwoFactorVerifyDto) {
    return this.authService.twoFactorVerify(user, data);
  }

  // AR-64 — needs the password and a current code.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('2fa/disable')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Turn 2FA off (password and a current code required)' })
  async twoFactorDisable(@CurrentUser() user: CurrentUserDto, @Body() data: TwoFactorDisableDto) {
    return this.authService.twoFactorDisable(user, data);
  }

  // AR-65
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('2fa/recovery-codes/regenerate')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Issue new recovery codes and invalidate the old ones' })
  async twoFactorRegenerateRecoveryCodes(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: TwoFactorRegenerateDto,
  ) {
    return this.authService.twoFactorRegenerateRecoveryCodes(user, data);
  }

  // AR-66 — pre-login; needs its own throttle and a per-account lock in the service.
  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('2fa/login/verify')
  @ApiOperation({ summary: 'Finish sign-in with a 2FA code and challengeId' })
  async twoFactorLoginVerify(@Body() data: TwoFactorLoginVerifyDto) {
    return this.authService.twoFactorLoginVerify(data);
  }

  // AR-67
  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('2fa/login/recovery')
  @ApiOperation({ summary: 'Finish sign-in with a single-use recovery code' })
  async twoFactorLoginRecovery(@Body() data: TwoFactorLoginRecoveryDto) {
    return this.authService.twoFactorLoginRecovery(data);
  }

  // AR-68 — only if an SMS option is offered. Tightest throttle: SMS cost.
  @AllowAnonymous()
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('2fa/login/resend')
  @ApiOperation({ summary: 'Send the 2FA code by SMS (only if SMS is offered)' })
  @AuditEvent({ action: AuditEventEnum.TWO_FACTOR_CHALLENGE_RESENT, entity: 'TwoFactorChallenge' })
  async twoFactorLoginResend(@Body() data: TwoFactorLoginResendDto) {
    return this.authService.twoFactorLoginResend(data);
  }

  // AR-69
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('2fa/step-up')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Ask for a fresh 2FA code before a sensitive action' })
  async twoFactorStepUp(@CurrentUser() user: CurrentUserDto, @Body() data: TwoFactorStepUpDto) {
    return this.authService.twoFactorStepUp(user, data);
  }
}

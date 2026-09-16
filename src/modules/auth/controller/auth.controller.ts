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
  ChangePasswordInitiateDto,
  RefreshTokenDto,
} from '../dto/auth.dto';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // SIGN UP — REQUEST OTP. Tight throttle: account creation + SMS cost per request.

  @AllowAnonymous()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
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

  // LOGIN — USER accounts only; admin accounts use AdminAuthController.login() instead.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @ApiOperation({
    summary: 'Login with phone number and password (USER accounts only)',
  })
  async login(@Body() data: LoginDto) {
    return this.authService.login(data);
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

  // CHANGE PASSWORD (STEP 1) — "know it, want to change it" flow: authenticated USER
  // verifies their current password; an OTP is then texted to their own registered
  // phone number. USER accounts only — admin accounts use AdminAuthController's
  // email-OTP equivalent (POST /admin/auth/change-password/initiate) instead.

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
    summary: 'Step 2 of self-service password change: verify the texted OTP and set the new password',
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
}
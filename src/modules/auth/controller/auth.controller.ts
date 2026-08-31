import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';

import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AuthService } from '../service/auth.service';

import {
  SignupDto,
  SignupVerifyDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  RefreshTokenDto,
} from '../dto/auth.dto';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
  ) {}

  // ─────────────────────────────────────────────
  // SIGN UP — REQUEST OTP
  // ─────────────────────────────────────────────

  @AllowAnonymous()
  @Post('signup')
  @ApiOperation({
    summary:
      'Create signup request and send OTP to phone',
  })
  async signup(
    @Body() data: SignupDto,
  ) {
    return this.authService.signup(data);
  }

  // ─────────────────────────────────────────────
  // SIGN UP — VERIFY OTP
  // ─────────────────────────────────────────────

  @AllowAnonymous()
  @Post('signup/verify')
  @ApiOperation({
    summary:
      'Verify signup OTP and activate the user account',
  })
  async verifySignupOtp(
    @Body() data: SignupVerifyDto,
  ) {
    return this.authService.verifySignupOtp(data);
  }

  // ─────────────────────────────────────────────
  // SIGN UP — RESEND OTP
  // ─────────────────────────────────────────────

  @AllowAnonymous()
  @Post(
    'signup/resend-otp/:verificationId',
  )
  @ApiOperation({
    summary: 'Resend signup OTP',
  })
  async resendSignupOtp(
    @Param('verificationId')
    verificationId: string,
  ) {
    return this.authService.resendSignupOtp(
      verificationId,
    );
  }

  // ─────────────────────────────────────────────
  // LOGIN
  // ─────────────────────────────────────────────

  @AllowAnonymous()
  @Post('login')
  @ApiOperation({
    summary:
      'Login with phone number and password',
  })
  async login(
    @Body() data: LoginDto,
  ) {
    return this.authService.login(data);
  }

  // ─────────────────────────────────────────────
  // REFRESH TOKEN
  // ─────────────────────────────────────────────

  @AllowAnonymous()
  @Post('refresh')
  @ApiOperation({
    summary: 'Refresh access token',
  })
  async refresh(
    @Body() data: RefreshTokenDto,
  ) {
    return this.authService.refresh(data);
  }

  // ─────────────────────────────────────────────
  // FORGOT PASSWORD
  // ─────────────────────────────────────────────

  @AllowAnonymous()
  @Post('forgot-password')
  @ApiOperation({
    summary:
      'Request password reset OTP',
  })
  async forgotPassword(
    @Body() data: ForgotPasswordDto,
  ) {
    return this.authService.forgotPassword(
      data,
    );
  }

  // ─────────────────────────────────────────────
  // RESET PASSWORD
  // ─────────────────────────────────────────────

  @AllowAnonymous()
  @Post('reset-password')
  @ApiOperation({
    summary:
      'Reset password using OTP',
  })
  async resetPassword(
    @Body() data: ResetPasswordDto,
  ) {
    return this.authService.resetPassword(
      data,
    );
  }

  // ─────────────────────────────────────────────
  // CURRENT USER
  //
  // 'access-token' must match the scheme name
  // registered in main.ts's
  // DocumentBuilder().addBearerAuth({...}, 'access-token').
  // Without this argument, @ApiBearerAuth('access-token') defaults to
  // a scheme named 'bearer', which doesn't exist in this
  // app's Swagger document — so Swagger UI's Authorize
  // dialog has nothing to attach the token to, and the
  // header silently never gets sent.
  // ─────────────────────────────────────────────

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Get currently authenticated user',
  })
  async me(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.authService.me(user);
  }

  // ─────────────────────────────────────────────
  // CHANGE PASSWORD
  // ─────────────────────────────────────────────

  @Post('change-password')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Change password for authenticated user',
  })
  async changePassword(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      user,
      data,
    );
  }

  // ─────────────────────────────────────────────
  // LOGOUT
  // ─────────────────────────────────────────────

  @Post('logout')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Logout and invalidate current session',
  })
  async logout(
    @CurrentUser()
    user: CurrentUserDto,

    @Req()
    req: any,
  ) {
    return this.authService.logout(
      user,
      req,
    );
  }
}
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
  AdminRegisterDto,
  AdminVerifyDto,
  AdminLoginDto,
} from '../dto/auth.dto';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';

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

// ─────────────────────────────────────────────
// ADMIN AUTHENTICATION
//
// Kept as a separate controller/class for routing
// (/admin/auth/...) and role separation, but grouped
// under the same 'Authentication' Swagger tag as
// AuthController rather than its own tag — there is
// only one Authentication category in the docs.
// ─────────────────────────────────────────────

@ApiTags('Authentication')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly authService: AuthService,
  ) {}

  // ─────────────────────────────────────────────
  // ADMIN — REGISTER
  // POST /admin/auth/register
  //
  // ADMIN / SUPER_ADMIN
  //
  // An authorized admin creates a new admin.
  // OTP is sent to the new admin's phone.
  // ─────────────────────────────────────────────

  @Post('register')
  @ApiBearerAuth('access-token')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({
    summary:
      'Register a new admin and send OTP to their phone',
  })
  async register(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: AdminRegisterDto,
  ) {
    return this.authService.adminRegister(
      user,
      data,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — VERIFY REGISTRATION
  // POST /admin/auth/verify/:id
  //
  // ADMIN / SUPER_ADMIN
  //
  // The new admin receives the OTP on their phone
  // and tells the OTP to the admin who created them.
  //
  // The creating admin enters the OTP.
  //
  // The system verifies:
  // - Admin ID
  // - Phone number
  // - OTP
  // - OTP expiration
  // - OTP purpose
  //
  // Successful verification activates the new admin.
  // ─────────────────────────────────────────────

  @Post('verify/:id')
  @ApiBearerAuth('access-token')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({
    summary:
      'Verify OTP for newly registered admin',
  })
  async verify(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') adminId: string,
    @Body() data: AdminVerifyDto,
  ) {
    return this.authService.adminVerify(
      user,
      adminId,
      data,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — LOGIN
  // POST /admin/auth/login
  //
  // ANONYMOUS
  //
  // Admin logs in using:
  // - Phone number
  // - Password
  // ─────────────────────────────────────────────

  @AllowAnonymous()
  @Post('login')
  @ApiOperation({
    summary:
      'Admin login with phone number and password',
  })
  async login(
    @Body() data: AdminLoginDto,
  ) {
    return this.authService.adminLogin(data);
  }
}
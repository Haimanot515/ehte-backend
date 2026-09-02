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
  AdminRegisterDto,
  AdminVerifyDto,
  AdminLoginDto,
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

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @ApiOperation({
    summary: 'Login with phone number and password',
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

  @AllowAnonymous()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('forgot-password')
  @ApiOperation({
    summary: 'Request password reset OTP',
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

  // ADMIN — REGISTER (POST /admin/auth/register, ADMIN/SUPER_ADMIN): creates a new admin and sends OTP to their phone
  // FIX: throttle added

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Register a new admin and send OTP to their phone',
  })
  async register(@CurrentUser() user: CurrentUserDto, @Body() data: AdminRegisterDto) {
    return this.authService.adminRegister(user, data);
  }

  // ADMIN — VERIFY REGISTRATION (POST /admin/auth/verify/:id, ADMIN/SUPER_ADMIN): creating admin submits the new admin's OTP; success activates the new admin
  // FIX: throttle added

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('verify/:id')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Verify OTP for newly registered admin',
  })
  async verify(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') adminId: string,
    @Body() data: AdminVerifyDto,
  ) {
    return this.authService.adminVerify(user, adminId, data);
  }

  // ADMIN — LOGIN (POST /admin/auth/login, ANONYMOUS): admin logs in with phone number and password
  // FIX: throttle added — credential-guessing surface, high-privilege target

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @ApiOperation({
    summary: 'Admin login with phone number and password',
  })
  async login(@Body() data: AdminLoginDto) {
    return this.authService.adminLogin(data);
  }
}

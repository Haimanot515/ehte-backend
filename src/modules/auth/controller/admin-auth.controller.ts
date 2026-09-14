import { Body, Controller, Post } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Throttle } from '@nestjs/throttler';

import { AdminAuthService } from '../service/admin-auth.service';

import {
  ResetPasswordDto,
  AdminRegisterDto,
  AdminRegisterResendDto,
  AdminCompleteRegistrationDto,
  AdminLoginEmailDto,
  AdminForgotPasswordDto,
  AdminCancelRegistrationDto,
  AdminChangeEmailDto,
  AdminChangeEmailVerifyDto,
  PromoteUserDto,
  PromoteUserResendDto,
  PromoteVerifyDto,
} from '../dto/admin-auth.dto';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';

@ApiTags('Authentication')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  // ADMIN — REGISTER: Super Admin supplies email + name + roles only, no password.

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Register a new admin by email + name + roles (registration-link flow, no creator-set password)',
  })
  async register(@CurrentUser() user: CurrentUserDto, @Body() data: AdminRegisterDto) {
    return this.adminAuthService.adminRegister(user, data);
  }

  // ADMIN — RESEND REGISTRATION: fresh token if the original email failed or expired.

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('register/resend')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Resend a pending admin registration email with a freshly generated token',
  })
  async resendRegistration(@CurrentUser() user: CurrentUserDto, @Body() data: AdminRegisterResendDto) {
    return this.adminAuthService.adminRegisterResend(user, data);
  }

  // ADMIN — COMPLETE REGISTRATION: token proves inbox control, sets password + activates.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register/complete')
  @ApiOperation({
    summary: 'Registering admin sets their own password using their registration token; activates the account and returns tokens',
  })
  async completeRegistration(@Body() data: AdminCompleteRegistrationDto) {
    return this.adminAuthService.adminCompleteRegistration(data);
  }

  // ADMIN — CANCEL PENDING REGISTRATION: only valid pre-activation; deletes the row.

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register/cancel')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Cancel a pending admin registration before it is completed',
  })
  async cancelRegistration(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: AdminCancelRegistrationDto,
  ) {
    return this.adminAuthService.adminCancelRegistration(user, data);
  }

  // ADMIN — CHANGE EMAIL: self-service, gated by re-authentication (see ReauthGuard).

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('change-email')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({
    summary: "Request to change the authenticated admin's own login email (requires re-authentication)",
  })
  async changeEmail(@CurrentUser() user: CurrentUserDto, @Body() data: AdminChangeEmailDto) {
    return this.adminAuthService.adminChangeEmailInitiate(user, data);
  }

  // ADMIN — CHANGE EMAIL: VERIFY. Possessing the emailed token proves inbox ownership.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('change-email/verify')
  @ApiOperation({
    summary: "Verify the admin's new email via the emailed token",
  })
  async changeEmailVerify(@Body() data: AdminChangeEmailVerifyDto) {
    return this.adminAuthService.adminChangeEmailVerify(data);
  }

  // ADMIN — PROMOTE USER: attaches email + sends OTP; role granted only after verify.

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('promote')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Promote an existing (active, phone-verified) user to admin: attach + send OTP to their new email',
  })
  async promote(@CurrentUser() user: CurrentUserDto, @Body() data: PromoteUserDto) {
    return this.adminAuthService.promoteUserInitiate(user, data);
  }

  // ADMIN — RESEND PROMOTION: fresh token if the original email failed or expired.

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('promote/resend')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Resend a pending promotion verification email with a freshly generated token',
  })
  async resendPromotion(@CurrentUser() user: CurrentUserDto, @Body() data: PromoteUserResendDto) {
    return this.adminAuthService.promoteUserResend(user, data);
  }

  // ADMIN — PROMOTE: VERIFY. The user being promoted verifies their own OTP.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('promote/verify')
  @ApiOperation({
    summary: 'User being promoted verifies their email OTP; grants the ADMIN role',
  })
  async promoteVerify(@Body() data: PromoteVerifyDto) {
    return this.adminAuthService.promoteUserVerify(data);
  }

  // ADMIN — LOGIN: email + password only; phone-based admin login has been removed.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @ApiOperation({
    summary: 'Admin login with email and password',
  })
  async login(@Body() data: AdminLoginEmailDto) {
    return this.adminAuthService.adminLoginByEmail(data);
  }

  // ADMIN — FORGOT PASSWORD: email-only OTP; account existence is masked.

  @AllowAnonymous()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('forgot-password')
  @ApiOperation({
    summary: 'Request password reset OTP via admin email',
  })
  async forgotPassword(@Body() data: AdminForgotPasswordDto) {
    return this.adminAuthService.adminForgotPassword(data);
  }

  // ADMIN — RESET PASSWORD: routes through adminResetPassword() to enforce admin-role check.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('reset-password')
  @ApiOperation({
    summary: 'Reset admin password using the emailed OTP (admin-scoped)',
  })
  async resetPassword(@Body() data: ResetPasswordDto) {
    return this.adminAuthService.adminResetPassword(data);
  }
}
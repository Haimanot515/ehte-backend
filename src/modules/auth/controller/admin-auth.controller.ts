import { Body, Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

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
  AdminChangePasswordInitiateDto,
  PromoteUserDto,
  PromoteUserResendDto,
  PromoteVerifyDto,
  PromoteCancelDto,
  AdminChangeEmailResendDto,
  DemoteAdminDto,
  AdminStatsQueryDto,
  AdminLoginHistoryQueryDto,
} from '../dto/admin-auth.dto';

import { RefreshTokenDto } from '../dto/auth.dto';

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
    summary:
      'Register a new admin by email + name + roles (registration-link flow, no creator-set password)',
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
  async resendRegistration(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: AdminRegisterResendDto,
  ) {
    return this.adminAuthService.adminRegisterResend(user, data);
  }

  // ADMIN — COMPLETE REGISTRATION: token proves inbox control, sets password + activates.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register/complete')
  @ApiOperation({
    summary:
      'Registering admin sets their own password using their registration token; activates the account and returns tokens',
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
    summary:
      "Request to change the authenticated admin's own login email (requires re-authentication)",
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

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('change-password/initiate')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      "Step 1 of admin self-service password change: verify the admin's current password and email them an OTP",
  })
  async changePasswordInitiate(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: AdminChangePasswordInitiateDto,
  ) {
    return this.adminAuthService.adminChangePasswordInitiate(user, data);
  }

  // ADMIN — CHANGE PASSWORD (STEP 2): possessing the emailed OTP proves inbox control;
  // reuses the same verificationId + otp + newPassword shape as reset-password.

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('change-password/verify')
  @ApiOperation({
    summary:
      'Step 2 of admin self-service password change: verify the emailed OTP and set the new password',
  })
  async changePasswordVerify(@Body() data: ResetPasswordDto) {
    return this.adminAuthService.adminChangePasswordVerify(data);
  }

  // ADMIN — PROMOTE USER: attaches email + sends OTP; role granted only after verify.

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('promote')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Promote an existing (active, phone-verified) user to admin: attach + send OTP to their new email',
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

  // ADMIN — FORGOT PASSWORD: email-only OTP; account existence is masked. Already
  // separate from, and email-based unlike, the USER /auth/forgot-password (phone/SMS).

  @AllowAnonymous()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('forgot-password')
  @ApiOperation({
    summary: 'Request password reset OTP via admin email (for an admin who forgot their password)',
  })
  async forgotPassword(@Body() data: AdminForgotPasswordDto) {
    return this.adminAuthService.adminForgotPassword(data);
  }

  // ADMIN — RESET PASSWORD: routes through adminResetPassword() to enforce admin-role check.
  // This completes the forgot-password flow above (admin does not know their current password).

  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('reset-password')
  @ApiOperation({
    summary: 'Reset admin password using the emailed OTP (admin-scoped, forgot-password flow)',
  })
  async resetPassword(@Body() data: ResetPasswordDto) {
    return this.adminAuthService.adminResetPassword(data);
  }

  // ───────────────────────────── NEW ENDPOINTS ─────────────────────────────
  // "Admin" access = SUPER_ADMIN or ADMIN. Adjust @Roles if your guard is not any-of.

  // AR-13 — CANCEL PENDING PROMOTION (registration has cancel; promotion did not).

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('promote/cancel')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Cancel a pending admin promotion' })
  async cancelPromotion(@CurrentUser() user: CurrentUserDto, @Body() data: PromoteCancelDto) {
    return this.adminAuthService.promoteUserCancel(user, data);
  }

  // AR-14

  @Get('promote/pending')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'List pending promotions with their expiry' })
  async listPendingPromotions(@CurrentUser() user: CurrentUserDto) {
    return this.adminAuthService.listPendingPromotions(user);
  }

  // AR-15

  @Get('register/pending')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'List pending admin registrations with their expiry' })
  async listPendingRegistrations(@CurrentUser() user: CurrentUserDto) {
    return this.adminAuthService.listPendingRegistrations(user);
  }

  // AR-16 — RESEND ADMIN RESET CODE. Tightest throttle: email-bombing vector.

  @AllowAnonymous()
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('forgot-password/resend-otp/:verificationId')
  @ApiOperation({ summary: 'Resend the admin password reset code' })
  async resendForgotPasswordOtp(@Param('verificationId') verificationId: string) {
    return this.adminAuthService.adminResendForgotPasswordOtp(verificationId);
  }

  // AR-17

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('change-email/resend')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN, RolesEnum.ADMIN)
  @ApiOperation({ summary: 'Resend a pending email change verification' })
  async changeEmailResend(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: AdminChangeEmailResendDto,
  ) {
    return this.adminAuthService.adminChangeEmailResend(user, data);
  }

  // AR-18 — check first: /auth/logout may already work for admins.

  @Post('logout')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN, RolesEnum.ADMIN)
  @ApiOperation({ summary: 'Sign an admin out' })
  async logout(@CurrentUser() user: CurrentUserDto, @Req() req: any) {
    return this.adminAuthService.adminLogout(user, req);
  }

  // AR-19 — check first: /auth/refresh may already work for admins.

  @AllowAnonymous()
  @Post('refresh')
  @ApiOperation({ summary: 'Refresh an admin access token' })
  async refresh(@Body() data: RefreshTokenDto) {
    return this.adminAuthService.adminRefresh(data);
  }

  // AR-20

  @Post('logout-all')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN, RolesEnum.ADMIN)
  @ApiOperation({ summary: 'Sign an admin out everywhere' })
  async logoutAll(@CurrentUser() user: CurrentUserDto, @Req() req: any) {
    return this.adminAuthService.adminLogoutAll(user, req);
  }

  // AR-21

  @Get('me')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN, RolesEnum.ADMIN)
  @ApiOperation({ summary: "The signed-in admin's profile, roles and last sign-in" })
  async me(@CurrentUser() user: CurrentUserDto) {
    return this.adminAuthService.adminMe(user);
  }

  // AR-22 — DEMOTE. Reason + re-auth; the last Super Admin can never be demoted.

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('demote')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Remove the ADMIN role from a user (reason and re-auth required)' })
  async demote(@CurrentUser() user: CurrentUserDto, @Body() data: DemoteAdminDto) {
    return this.adminAuthService.demoteAdmin(user, data);
  }

  // AR-24

  @Get('sessions')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN, RolesEnum.ADMIN)
  @ApiOperation({ summary: "An admin's own sessions with device and time" })
  async mySessions(@CurrentUser() user: CurrentUserDto) {
    return this.adminAuthService.listMySessions(user);
  }

  // AR-25

  @Delete('sessions/:sessionId')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN, RolesEnum.ADMIN)
  @ApiParam({ name: 'sessionId', type: 'string' })
  @ApiOperation({ summary: 'Revoke one of my admin sessions' })
  async revokeMySession(
    @CurrentUser() user: CurrentUserDto,
    @Param('sessionId') sessionId: string,
  ) {
    return this.adminAuthService.revokeMySession(user, sessionId);
  }

  // AR-28

  @Get('login-history')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Recent admin sign-ins with device, place and result' })
  async loginHistory(
    @CurrentUser() user: CurrentUserDto,
    @Query() query: AdminLoginHistoryQueryDto,
  ) {
    return this.adminAuthService.loginHistory(user, query);
  }

  // AR-78

  @Get('stats/logins')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Sign-ins, failures and lockouts over time' })
  async statsLogins(@CurrentUser() user: CurrentUserDto, @Query() query: AdminStatsQueryDto) {
    return this.adminAuthService.statsLogins(user, query);
  }

  // AR-79

  @Get('stats/2fa-adoption')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Share of accounts with 2FA, by role' })
  async stats2faAdoption(@CurrentUser() user: CurrentUserDto) {
    return this.adminAuthService.stats2faAdoption(user);
  }
}

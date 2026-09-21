import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import {
  AdminActionReasonDto,
  AdminUpdateDiscreetModeDto,
  AssignUserRoleDto,
  ChangePhoneInitiateDto,
  ChangePhoneVerifyDto,
  ListUsersQueryDto,
  UpdateDiscreetModeDto,
  UpdateProfilePictureDto,
  UpdateUserDto,
} from '../dto/user.dto';
import { UserService } from '../service/user.service';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  // ── SELF-SERVICE ── literal 'me/...' routes, before any ':id' route.

  @Get('me')
  @ApiOperation({ summary: 'Get current authenticated user' })
  async getMe(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getMe(user);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update my profile' })
  async updateMe(@CurrentUser() user: CurrentUserDto, @Body() data: UpdateUserDto) {
    return this.userService.updateMe(user, data);
  }

  // Re-auth required: password when disabling, password or current
  // passcode when enabling — see UserService.updateDiscreetMode.
  @Patch('me/discreet-mode')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Enable, disable, or change the passcode for Discreet Mode' })
  async updateDiscreetMode(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: UpdateDiscreetModeDto,
  ) {
    return this.userService.updateDiscreetMode(user, data);
  }

  @Delete('me')
  @ApiOperation({ summary: 'Deactivate my account' })
  async deactivateMe(@CurrentUser() user: CurrentUserDto) {
    return this.userService.deactivateMe(user);
  }

  @Get('me/audit-log')
  @ApiOperation({ summary: 'My own audit history (logins, profile changes, etc.)' })
  async getMyAuditLog(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getHistory(user.id);
  }

  @Get('me/sessions')
  @ApiOperation({ summary: 'List my active sessions/devices' })
  async getMySessions(@CurrentUser() user: CurrentUserDto) {
    return this.userService.listSessions(user.id);
  }

  @Delete('me/sessions/:sessionId')
  @ApiOperation({ summary: 'Revoke one of my sessions (e.g. log out an old device)' })
  @ApiParam({ name: 'sessionId', description: 'Id of the session to revoke' })
  async revokeMySession(
    @CurrentUser() user: CurrentUserDto,
    @Param('sessionId') sessionId: string,
  ) {
    return this.userService.revokeSession(user, user.id, sessionId);
  }

  // OTP-gated phone change — mirrors AdminAuthService's email-change flow.
  @Post('me/change-phone/initiate')
  @ApiOperation({ summary: 'Step 1: request an OTP to move my account to a new phone number' })
  async changePhoneInitiate(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: ChangePhoneInitiateDto,
  ) {
    return this.userService.changePhoneInitiate(user, data);
  }

  @Post('me/change-phone/verify')
  @ApiOperation({ summary: 'Step 2: verify the OTP and complete the phone number change' })
  async changePhoneVerify(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: ChangePhoneVerifyDto,
  ) {
    return this.userService.changePhoneVerify(user, data);
  }

  // Upload to MinIO via presigned URL first, then call these with the key.
  @Get('me/profile-picture')
  @ApiOperation({ summary: 'Get a presigned download URL for my profile picture' })
  async getMyProfilePicture(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getProfilePictureUrl(user);
  }

  @Patch('me/profile-picture')
  @ApiOperation({ summary: 'Set/replace my profile picture (after uploading to MinIO)' })
  async updateMyProfilePicture(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: UpdateProfilePictureDto,
  ) {
    return this.userService.updateProfilePicture(user, data);
  }

  @Delete('me/profile-picture')
  @ApiOperation({ summary: 'Remove my profile picture' })
  async removeMyProfilePicture(@CurrentUser() user: CurrentUserDto) {
    return this.userService.removeProfilePicture(user);
  }

  // ── ADMIN ── literal routes ('stats') registered before ':id' routes.

  @Get()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'List all users (admin)' })
  async listUsers(@Query() query: ListUsersQueryDto) {
    return this.userService.listUsers(query);
  }

  @Get('stats')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User-related dashboard stats' })
  async getDashboardStats() {
    return this.userService.getDashboardStats();
  }

  @Get(':id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'Get a single user by id (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user to fetch' })
  async getUserById(@Param('id') id: string) {
    return this.userService.getUserById(id);
  }

  @Get(':id/audit-log')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: "A user's full audit history (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user whose history is being read' })
  async getUserAuditLog(@Param('id') id: string) {
    return this.userService.getHistory(id);
  }

  @Get(':id/sessions')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: "List a user's active sessions/devices (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user whose sessions are being listed' })
  async getUserSessions(@Param('id') id: string) {
    return this.userService.listSessions(id);
  }

  @Delete(':id/sessions/:sessionId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_FORCE_LOGOUT)
  @ApiOperation({ summary: "Revoke one specific session of a user's (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user who owns the session' })
  @ApiParam({ name: 'sessionId', description: 'Id of the session to revoke' })
  async revokeUserSession(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.userService.revokeSession(actor, id, sessionId);
  }

  @Patch(':id/role')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_UPDATE)
  @ApiOperation({ summary: "Grant an admin or super_admin role to a user's account" })
  @ApiParam({ name: 'id', description: 'Id of the user being granted the role' })
  async assignRole(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AssignUserRoleDto,
  ) {
    return this.userService.assignRole(actor, id, data, data.reason);
  }

  @Delete(':id/role/:role')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_UPDATE)
  @ApiOperation({ summary: "Revoke an admin or super_admin role from a user's account" })
  @ApiParam({ name: 'id', description: 'Id of the user being revoked the role' })
  @ApiParam({ name: 'role', enum: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] })
  async revokeRole(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Param('role') role: RolesEnum.ADMIN | RolesEnum.SUPER_ADMIN,
    @Body() body?: AdminActionReasonDto,
  ) {
    return this.userService.revokeRole(actor, id, role, body?.reason);
  }

  @Patch(':id/deactivate')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_SUSPEND)
  @ApiOperation({ summary: "Deactivate a user's account (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user being deactivated' })
  async deactivateUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() body?: AdminActionReasonDto,
  ) {
    return this.userService.deactivateUser(actor, id, body?.reason);
  }

  @Patch(':id/reactivate')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_RESTORE)
  @ApiOperation({ summary: "Reactivate a user's account (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user being reactivated' })
  async reactivateUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() body?: AdminActionReasonDto,
  ) {
    return this.userService.reactivateUser(actor, id, body?.reason);
  }

  @Patch(':id/unlock')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_UNLOCK)
  @ApiOperation({ summary: "Clear a user's login lockout (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user being unlocked' })
  async unlockUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() body?: AdminActionReasonDto,
  ) {
    return this.userService.unlockUser(actor, id, body?.reason);
  }

  @Post(':id/force-logout')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_FORCE_LOGOUT)
  @ApiOperation({ summary: "Revoke all of a user's active sessions (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user whose sessions are being revoked' })
  async forceLogout(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() body?: AdminActionReasonDto,
  ) {
    return this.userService.forceLogout(actor, id, body?.reason);
  }

  // Re-auth confirms the ADMIN's own password, not the target's passcode.
  @Patch(':id/discreet-mode')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_UPDATE)
  @RequireReauthentication()
  @ApiOperation({ summary: "Enable, disable, or change a user's Discreet Mode passcode (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user whose Discreet Mode is being configured' })
  async adminUpdateDiscreetMode(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminUpdateDiscreetModeDto,
  ) {
    return this.userService.adminUpdateDiscreetMode(actor, id, data, data.reason);
  }
}
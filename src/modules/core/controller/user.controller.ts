import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
// NOTE: adjust these two import paths to match your actual file locations —
// same convention as Roles / RolesEnum above.
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import {
  AssignUserRoleDto,
  ListUsersQueryDto,
  UpdateDiscreetModeDto,
  UpdateUserDto,
} from '../dto/user.dto';
import { UserService } from '../service/user.service';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  // ─────────────────────────────────────────────
  // GET CURRENT USER
  // GET /users/me
  // Authenticated USER
  // Global AuthGuard applies
  // ─────────────────────────────────────────────
  @Get('me')
  @ApiOperation({
    summary: 'Get current authenticated user',
  })
  async getMe(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.userService.getMe(user);
  }

  // ─────────────────────────────────────────────
  // UPDATE PROFILE
  // PATCH /users/me
  // Authenticated USER
  // Global AuthGuard applies
  // ─────────────────────────────────────────────
  @Patch('me')
  @ApiOperation({
    summary: 'Update my profile',
  })
  async updateMe(
    @CurrentUser()
    user: CurrentUserDto,
    @Body()
    data: UpdateUserDto,
  ) {
    return this.userService.updateMe(user, data);
  }

  // ─────────────────────────────────────────────
  // DISCREET MODE
  // PATCH /users/me/discreet-mode
  // Authenticated USER
  // Global AuthGuard applies
  //
  // Enabling requires a new passcode (data.passcode) — this covers
  // both first-time setup and rotating an existing passcode.
  // Disabling clears the existing passcode hash.
  //
  // FIX: @RequireReauthentication() added. This route configures
  // Discreet Mode but never itself checked a credential — the
  // actual gate lives in ReauthGuard, which only activates when a
  // route carries this decorator. Without it, any valid access
  // token could enable/rotate/disable Discreet Mode with no
  // password or passcode at all, contradicting the documented
  // design in UserService.updateDiscreetMode() and ReauthService.
  //
  // ReauthGuard reads the credential from body.password (or the
  // X-Reauth-Password header for GET-style calls), verifies it via
  // ReauthService.verifyPassword() — account password always
  // accepted; Discreet Mode passcode accepted only when Discreet
  // Mode is currently enabled — then strips body.password before
  // this handler / UpdateDiscreetModeDto ever sees it. That's why
  // UpdateDiscreetModeDto has no password field of its own.
  // ─────────────────────────────────────────────
  @Patch('me/discreet-mode')
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Enable, disable, or change the passcode for Discreet Mode',
  })
  async updateDiscreetMode(
    @CurrentUser()
    user: CurrentUserDto,
    @Body()
    data: UpdateDiscreetModeDto,
  ) {
    return this.userService.updateDiscreetMode(user, data);
  }

  // ─────────────────────────────────────────────
  // DEACTIVATE ACCOUNT
  // DELETE /users/me
  // Authenticated USER
  // Global AuthGuard applies
  // ─────────────────────────────────────────────
  @Delete('me')
  @ApiOperation({
    summary: 'Deactivate my account',
  })
  async deactivateMe(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.userService.deactivateMe(user);
  }

  // ─────────────────────────────────────────────
  // ADMIN — LIST USERS
  // GET /users
  // Restricted to SUPER_ADMIN
  // PRD 23: Admin Portal > Users
  //
  // Registered before ':id'-shaped routes are ever added at this
  // level so a literal path is never swallowed by a param route.
  // ─────────────────────────────────────────────
  @Get()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({
    summary: 'List all users (admin)',
  })
  async listUsers(
    @Query()
    query: ListUsersQueryDto,
  ) {
    return this.userService.listUsers(query);
  }

  // ─────────────────────────────────────────────
  // ADMIN — DASHBOARD STATS
  // GET /users/stats
  // Restricted to SUPER_ADMIN
  // PRD 23: Admin Portal > Dashboard (user-related figures)
  //
  // Registered before ':id' so this literal route is never
  // swallowed by the param route below.
  // ─────────────────────────────────────────────
  @Get('stats')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({
    summary: 'User-related dashboard stats (totals, active/inactive, by role, growth)',
  })
  async getDashboardStats() {
    return this.userService.getDashboardStats();
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET USER BY ID
  // GET /users/:id
  // Restricted to SUPER_ADMIN
  // PRD 23: Admin Portal > Users
  //
  // Registered after 'stats' so the literal route above is never
  // swallowed by this param route.
  // ─────────────────────────────────────────────
  @Get(':id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({
    summary: 'Get a single user by id (admin)',
  })
  @ApiParam({
    name: 'id',
    description: 'Id of the user to fetch',
  })
  async getUserById(
    @Param('id')
    id: string,
  ) {
    return this.userService.getUserById(id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — ASSIGN ROLE
  // PATCH /users/:id/role
  // Restricted to SUPER_ADMIN
  // PRD 23/24: Admin Portal > Users / Roles and Permissions
  // ─────────────────────────────────────────────
  @Patch(':id/role')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_UPDATE)
  @ApiOperation({
    summary: "Grant an admin or super_admin role to a user's account",
  })
  @ApiParam({
    name: 'id',
    description: 'Id of the user being granted the role',
  })
  async assignRole(
    @CurrentUser()
    actor: CurrentUserDto,
    @Param('id')
    id: string,
    @Body()
    data: AssignUserRoleDto,
  ) {
    return this.userService.assignRole(actor, id, data);
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVOKE ROLE
  // DELETE /users/:id/role/:role
  // Restricted to SUPER_ADMIN
  // Blocked at the service level if it would remove the
  // last active super admin.
  // ─────────────────────────────────────────────
  @Delete(':id/role/:role')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_UPDATE)
  @ApiOperation({
    summary: "Revoke an admin or super_admin role from a user's account",
  })
  @ApiParam({
    name: 'id',
    description: 'Id of the user being revoked the role',
  })
  @ApiParam({
    name: 'role',
    enum: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN],
  })
  async revokeRole(
    @CurrentUser()
    actor: CurrentUserDto,
    @Param('id')
    id: string,
    @Param('role')
    role: RolesEnum.ADMIN | RolesEnum.SUPER_ADMIN,
  ) {
    return this.userService.revokeRole(actor, id, role);
  }

  // ─────────────────────────────────────────────
  // ADMIN — DEACTIVATE USER
  // PATCH /users/:id/deactivate
  // Restricted to SUPER_ADMIN
  // PRD 24: Admin Responsibilities > Users
  // Blocked at the service level if it would deactivate the
  // last active super admin.
  // ─────────────────────────────────────────────
  @Patch(':id/deactivate')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_SUSPEND)
  @ApiOperation({
    summary: "Deactivate a user's account (admin)",
  })
  @ApiParam({
    name: 'id',
    description: 'Id of the user being deactivated',
  })
  async deactivateUser(
    @CurrentUser()
    actor: CurrentUserDto,
    @Param('id')
    id: string,
  ) {
    return this.userService.deactivateUser(actor, id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — REACTIVATE USER
  // PATCH /users/:id/reactivate
  // Restricted to SUPER_ADMIN
  // PRD 24: Admin Responsibilities > Users
  // ─────────────────────────────────────────────
  @Patch(':id/reactivate')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_RESTORE)
  @ApiOperation({
    summary: "Reactivate a user's account (admin)",
  })
  @ApiParam({
    name: 'id',
    description: 'Id of the user being reactivated',
  })
  async reactivateUser(
    @CurrentUser()
    actor: CurrentUserDto,
    @Param('id')
    id: string,
  ) {
    return this.userService.reactivateUser(actor, id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — UNLOCK USER
  // PATCH /users/:id/unlock
  // Restricted to SUPER_ADMIN
  //
  // Manual override for the lockout AuthService applies after too
  // many failed login attempts (recordFailedLogin()/assertNotLocked()
  // — see AuthController). That lock only clears itself after
  // LOCKOUT_DURATION_MINUTES or a correct password; this lets a
  // Super Admin restore access immediately instead of making a
  // legitimate admin wait it out. Distinct from reactivate/deactivate
  // above — this only touches the lockout fields, not isActive.
  //
  // NOTE: PermissionsEnum.USER_UNLOCK is assumed here, matching the
  // naming pattern of USER_SUSPEND/USER_RESTORE next to it — confirm
  // it exists in the real enum (or add it) before relying on this.
  // ─────────────────────────────────────────────
  @Patch(':id/unlock')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_UNLOCK)
  @ApiOperation({
    summary: "Clear a user's login lockout (admin)",
  })
  @ApiParam({
    name: 'id',
    description: 'Id of the user being unlocked',
  })
  async unlockUser(
    @CurrentUser()
    actor: CurrentUserDto,
    @Param('id')
    id: string,
  ) {
    return this.userService.unlockUser(actor, id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — FORCE LOGOUT
  // POST /users/:id/force-logout
  // Restricted to SUPER_ADMIN
  // PRD 31/34: Security Requirements / Incident Response
  // Revokes all active sessions without deactivating the account.
  // ─────────────────────────────────────────────
  @Post(':id/force-logout')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_FORCE_LOGOUT)
  @ApiOperation({
    summary: "Revoke all of a user's active sessions (admin)",
  })
  @ApiParam({
    name: 'id',
    description: 'Id of the user whose sessions are being revoked',
  })
  async forceLogout(
    @CurrentUser()
    actor: CurrentUserDto,
    @Param('id')
    id: string,
  ) {
    return this.userService.forceLogout(actor, id);
  }
}
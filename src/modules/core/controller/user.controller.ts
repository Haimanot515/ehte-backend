import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';

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
  constructor(
    private readonly userService: UserService,
  ) {}

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
    return this.userService.getMe(
      user,
    );
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
    return this.userService.updateMe(
      user,
      data,
    );
  }

  // ─────────────────────────────────────────────
  // DISCREET MODE
  // PATCH /users/me/discreet-mode
  // Authenticated USER
  // Global AuthGuard applies
  // ─────────────────────────────────────────────
  @Patch('me/discreet-mode')
  @ApiOperation({
    summary:
      'Enable or disable discreet mode',
  })
  async updateDiscreetMode(
    @CurrentUser()
    user: CurrentUserDto,
    @Body()
    data: UpdateDiscreetModeDto,
  ) {
    return this.userService.updateDiscreetMode(
      user,
      data,
    );
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
    return this.userService.deactivateMe(
      user,
    );
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
  @ApiOperation({
    summary: 'List all users (admin)',
  })
  async listUsers(
    @Query()
    query: ListUsersQueryDto,
  ) {
    return this.userService.listUsers(
      query,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — DASHBOARD STATS
  // GET /users/stats
  // Restricted to SUPER_ADMIN
  // PRD 23: Admin Portal > Dashboard (user-related figures)
  // ─────────────────────────────────────────────
  @Get('stats')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'User-related dashboard stats (totals, active/inactive, by role, growth)',
  })
  async getDashboardStats() {
    return this.userService.getDashboardStats();
  }

  // ─────────────────────────────────────────────
  // ADMIN — ASSIGN ROLE
  // PATCH /users/:id/role
  // Restricted to SUPER_ADMIN
  // PRD 23/24: Admin Portal > Users / Roles and Permissions
  // ─────────────────────────────────────────────
  @Patch(':id/role')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary:
      "Grant an admin or super_admin role to a user's account",
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
    return this.userService.assignRole(
      actor,
      id,
      data,
    );
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
  @ApiOperation({
    summary:
      "Revoke an admin or super_admin role from a user's account",
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
    return this.userService.revokeRole(
      actor,
      id,
      role,
    );
  }
}
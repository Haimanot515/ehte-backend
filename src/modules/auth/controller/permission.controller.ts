import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { PermissionService } from '../service/permission.service';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import {
  AssignPermissionsDto,
  RevokePermissionsDto,
  SetPermissionsDto,
  SimulatePermissionDto,
  PermissionDiffQueryDto,
} from '../dto/permission.dto';

@Controller('permissions')
@ApiTags('Permissions')
@ApiBearerAuth('access-token')
export class PermissionController {
  constructor(private readonly service: PermissionService) {}

  @Get()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'List all permission definitions' })
  async findAll() {
    return this.service.findAll();
  }

  // AR-47
  @Get('groups')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'Permissions grouped by area, for a role editor' })
  async groups() {
    return this.service.groups();
  }

  // AR-49
  @Get('matrix')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'Role by permission grid, for review and export' })
  async matrix() {
    return this.service.matrix();
  }

  // AR-50
  @Get('unused')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'Permissions no role holds, or no route uses' })
  async unused() {
    return this.service.unused();
  }

  // AR-53
  @Get('sensitive')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'Permissions flagged high risk (refunds, purge, identity reveal)' })
  async sensitive() {
    return this.service.sensitive();
  }

  // AR-54
  @Get('conflicts')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'Role combinations that break separation of duties' })
  async conflicts() {
    return this.service.conflicts();
  }

  // AR-81
  @Get('stats/usage')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'Which permissions are actually used, by routes and by users' })
  async statsUsage() {
    return this.service.statsUsage();
  }

  // AR-51 — re-runs the seeder so new enum values reach the database.
  @Post('sync')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_MANAGE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Re-run the permission seeder so new enum values reach the database' })
  async sync(@CurrentUser() actor: CurrentUserDto) {
    return this.service.sync(actor);
  }

  // AR-52 — read-only dry run; changes nothing.
  @Post('simulate')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'Would these roles be allowed to do X? Returns allow or deny' })
  async simulate(@Body() data: SimulatePermissionDto) {
    return this.service.simulate(data);
  }

  // AR-55
  @Get('users/:userId/diff')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: "What changed in a user's effective permissions over a period" })
  @ApiParam({ name: 'userId', type: 'string' })
  async diffForUser(@Param('userId') userId: string, @Query() query: PermissionDiffQueryDto) {
    return this.service.diffForUser(userId, query);
  }

  // AR-48 — single-segment catch, so it stays after every static GET above.
  @Get(':name')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'One permission with its description and the roles that hold it' })
  @ApiParam({ name: 'name', enum: PermissionsEnum })
  async findOne(@Param('name', new ParseEnumPipe(PermissionsEnum)) name: PermissionsEnum) {
    return this.service.findOneWithRoles(name);
  }

  // Reverse lookup: which roles have a given permission.
  @Get(':permissionName/roles')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'List all roles that currently have a given permission' })
  @ApiParam({ name: 'permissionName', enum: PermissionsEnum })
  async findRolesForPermission(
    @Param('permissionName', new ParseEnumPipe(PermissionsEnum)) permissionName: PermissionsEnum,
  ) {
    return this.service.findRolesForPermission(permissionName);
  }

  @Get('users/:userId/effective')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({
    summary: "List a user's effective permissions, aggregated across all their roles",
  })
  @ApiParam({ name: 'userId', type: 'string' })
  async getEffectivePermissionsForUser(@Param('userId') userId: string) {
    return this.service.getEffectivePermissionsForUser(userId);
  }

  @Get('roles/:roleId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'List permissions currently assigned to a role' })
  @ApiParam({ name: 'roleId', type: 'string' })
  async findForRole(@Param('roleId') roleId: string) {
    return this.service.findForRole(roleId);
  }

  @Post('roles/:roleId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_ASSIGN)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Assign one or more permissions to a role' })
  @ApiParam({ name: 'roleId', type: 'string' })
  async assignToRole(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Body() data: AssignPermissionsDto,
  ) {
    return this.service.assignToRole(actor, roleId, data);
  }

  // POST, not DELETE-with-body — some clients/proxies strip DELETE bodies.
  @Post('roles/:roleId/revoke-many')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_REVOKE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Revoke multiple permissions from a role in one call' })
  @ApiParam({ name: 'roleId', type: 'string' })
  async revokeManyFromRole(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Body() data: RevokePermissionsDto,
  ) {
    return this.service.revokeManyFromRole(actor, roleId, data);
  }

  // Gated by PERMISSION_MANAGE — stronger than ASSIGN/REVOKE since it can do both at once.
  @Put('roles/:roleId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_MANAGE)
  @RequireReauthentication()
  @ApiOperation({ summary: "Replace a role's entire permission list in one call" })
  @ApiParam({ name: 'roleId', type: 'string' })
  async setForRole(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Body() data: SetPermissionsDto,
  ) {
    return this.service.setForRole(actor, roleId, data);
  }

  @Delete('roles/:roleId/:permissionName')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_REVOKE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Revoke a permission from a role' })
  @ApiParam({ name: 'roleId', type: 'string' })
  @ApiParam({ name: 'permissionName', enum: PermissionsEnum })
  async revokeFromRole(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Param('permissionName', new ParseEnumPipe(PermissionsEnum)) permissionName: PermissionsEnum,
  ) {
    return this.service.revokeFromRole(actor, roleId, permissionName);
  }
}

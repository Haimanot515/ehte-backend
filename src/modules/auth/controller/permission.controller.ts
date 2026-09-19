import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { PermissionService } from '../service/permission.service';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import { AssignPermissionsDto, RevokePermissionsDto, SetPermissionsDto } from '../dto/permission.dto';

// Every route here is admin-only by design — no self-service "/my-permissions" route exists.

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

  // Reverse lookup: which roles have a given permission.
  @Get(':permissionName/roles')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: 'List all roles that currently have a given permission' })
  @ApiParam({ name: 'permissionName', enum: PermissionsEnum })
  async findRolesForPermission(@Param('permissionName') permissionName: PermissionsEnum) {
    return this.service.findRolesForPermission(permissionName);
  }

  @Get('users/:userId/effective')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({ summary: "List a user's effective permissions, aggregated across all their roles" })
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
  @ApiOperation({ summary: 'Revoke a permission from a role' })
  @ApiParam({ name: 'roleId', type: 'string' })
  @ApiParam({ name: 'permissionName', enum: PermissionsEnum })
  async revokeFromRole(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Param('permissionName') permissionName: PermissionsEnum,
  ) {
    return this.service.revokeFromRole(actor, roleId, permissionName);
  }
}
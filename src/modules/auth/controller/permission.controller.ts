import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { PermissionService } from '../service/permission.service';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import { AssignPermissionsDto } from '../dto/permission.dto';

// ─────────────────────────────────────────────
// Every route here is admin-only by design (there is no
// user-facing concept of "my permissions" the way there is "my
// reports" or "my posts"), so unlike other controllers there are
// no unrestricted/self-service routes to leave undecorated.
// ─────────────────────────────────────────────

@Controller('permissions')
@ApiTags('Permissions')
@ApiBearerAuth('access-token')
export class PermissionController {
  constructor(private readonly service: PermissionService) {}

  // ─────────────────────────────────────────────
  // GET ALL PERMISSION DEFINITIONS
  // GET /permissions
  // Restricted to SUPER_ADMIN
  // PRD 23/24/36: Admin Portal > Roles and Permissions
  // ─────────────────────────────────────────────

  @Get()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({
    summary: 'List all permission definitions',
  })
  async findAll() {
    return this.service.findAll();
  }

  // ─────────────────────────────────────────────
  // GET PERMISSIONS FOR A ROLE
  // GET /permissions/roles/:roleId
  // Restricted to SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get('roles/:roleId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_READ)
  @ApiOperation({
    summary: 'List permissions currently assigned to a role',
  })
  @ApiParam({
    name: 'roleId',
    type: 'string',
  })
  async findForRole(@Param('roleId') roleId: string) {
    return this.service.findForRole(roleId);
  }

  // ─────────────────────────────────────────────
  // ASSIGN PERMISSIONS TO A ROLE
  // POST /permissions/roles/:roleId
  // Restricted to SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Post('roles/:roleId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_ASSIGN)
  @ApiOperation({
    summary: 'Assign one or more permissions to a role',
  })
  @ApiParam({
    name: 'roleId',
    type: 'string',
  })
  async assignToRole(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Body() data: AssignPermissionsDto,
  ) {
    return this.service.assignToRole(actor, roleId, data);
  }

  // ─────────────────────────────────────────────
  // REVOKE A PERMISSION FROM A ROLE
  // DELETE /permissions/roles/:roleId/:permissionName
  // Restricted to SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Delete('roles/:roleId/:permissionName')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PERMISSION_REVOKE)
  @ApiOperation({
    summary: 'Revoke a permission from a role',
  })
  @ApiParam({
    name: 'roleId',
    type: 'string',
  })
  @ApiParam({
    name: 'permissionName',
    enum: PermissionsEnum,
  })
  async revokeFromRole(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Param('permissionName') permissionName: PermissionsEnum,
  ) {
    return this.service.revokeFromRole(actor, roleId, permissionName);
  }
}
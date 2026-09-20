import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { RoleService } from '../service/role.service';

import { FetchQueryParam } from 'src/common/decorators/fetch-query.decorator';
import { FetchQuery } from 'src/common/fetch-query/crud.types';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import { CreateRoleDto, UpdateRoleDto } from '../dto/role.dto';

@Controller('roles')
@ApiTags('Roles')
@ApiBearerAuth('access-token')
export class RoleController {
  constructor(public readonly service: RoleService) {}

  // Was open to any authenticated user before; now guarded like every other route.
  @Get()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: 'Get all roles' })
  @ApiQuery({ name: 'query', required: false, type: 'string' })
  async findAll(@FetchQueryParam() query: FetchQuery) {
    return await this.service.findAll(query);
  }

  @Get(':id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: 'Get role by ID' })
  @ApiParam({ name: 'id', type: 'string' })
  async findOne(@Param('id') id: string) {
    return await this.service.findOne(id);
  }

  @Get(':id/users')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: 'List users currently holding this role' })
  @ApiParam({ name: 'id', type: 'string' })
  async findUsersWithRole(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return await this.service.findUsersWithRole(actor, id);
  }

  @Post()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_CREATE)
  @ApiOperation({ summary: 'Create a new role' })
  async create(@CurrentUser() actor: CurrentUserDto, @Body() data: CreateRoleDto) {
    return await this.service.create(actor, data);
  }

  // Assigning an existing role to a user uses PermissionsEnum.USER_ROLE_ASSIGN instead, in UserController.
  @Patch(':id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_UPDATE)
  @ApiOperation({ summary: 'Rename or re-describe a role' })
  @ApiParam({ name: 'id', type: 'string' })
  async update(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: UpdateRoleDto,
  ) {
    return await this.service.update(actor, id, data);
  }

  @Delete(':id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_DELETE)
  @ApiOperation({ summary: 'Delete a role (must be unused and unprotected)' })
  @ApiParam({ name: 'id', type: 'string' })
  async remove(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return await this.service.remove(actor, id);
  }
}
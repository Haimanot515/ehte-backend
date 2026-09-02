import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { RoleService } from '../service/role.service';

import { FetchQueryParam } from 'src/common/decorators/fetch-query.decorator';
import { FetchQuery } from 'src/common/fetch-query/crud.types';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { CreateRoleDto, UpdateRoleDto } from '../dto/role.dto';

@Controller('roles')
@ApiTags('Roles')
@ApiBearerAuth('access-token')
export class RoleController {
  constructor(public readonly service: RoleService) {}

  // ─────────────────────────────────────────────
  // GET ALL ROLES
  // Left open to any authenticated admin-side user — unrestricted
  // beyond the global AuthGuard. If you want listing itself locked
  // to SUPER_ADMIN too, add @Roles(RolesEnum.SUPER_ADMIN) here.
  // ─────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Get all roles',
  })
  @ApiQuery({
    name: 'query',
    required: false,
    type: 'string',
  })
  async findAll(@FetchQueryParam() query: FetchQuery) {
    return await this.service.findAll(query);
  }

  // ─────────────────────────────────────────────
  // GET ROLE BY ID
  // ─────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({
    summary: 'Get role by ID',
  })
  @ApiParam({
    name: 'id',
    type: 'string',
  })
  async findOne(@Param('id') id: string) {
    return await this.service.findOne(id);
  }

  // ─────────────────────────────────────────────
  // GET USERS HOLDING THIS ROLE
  // GET /roles/:id/users
  // Restricted to SUPER_ADMIN
  // PRD 23/24: Admin Portal > Roles and Permissions
  //
  // Useful before renaming or deleting a role, to see who is
  // actually affected — remove() only ever exposed a count.
  // ─────────────────────────────────────────────

  @Get(':id/users')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'List users currently holding this role',
  })
  @ApiParam({
    name: 'id',
    type: 'string',
  })
  async findUsersWithRole(@Param('id') id: string) {
    return await this.service.findUsersWithRole(id);
  }

  // ─────────────────────────────────────────────
  // CREATE ROLE
  // Restricted to SUPER_ADMIN
  // PRD 23/24/36: Admin Portal > Roles and Permissions
  // ─────────────────────────────────────────────

  @Post()
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Create a new role',
  })
  async create(@CurrentUser() actor: CurrentUserDto, @Body() data: CreateRoleDto) {
    return await this.service.create(actor, data);
  }

  // ─────────────────────────────────────────────
  // UPDATE ROLE
  // Restricted to SUPER_ADMIN
  // Protected seeded roles (SUPER_ADMIN, ADMIN) cannot be renamed.
  // ─────────────────────────────────────────────

  @Patch(':id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Rename a role',
  })
  @ApiParam({
    name: 'id',
    type: 'string',
  })
  async update(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: UpdateRoleDto,
  ) {
    return await this.service.update(actor, id, data);
  }

  // ─────────────────────────────────────────────
  // DELETE ROLE
  // Restricted to SUPER_ADMIN
  // Blocked for protected seeded roles and roles still in use.
  // ─────────────────────────────────────────────

  @Delete(':id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Delete a role (must be unused and unprotected)',
  })
  @ApiParam({
    name: 'id',
    type: 'string',
  })
  async remove(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return await this.service.remove(actor, id);
  }
}

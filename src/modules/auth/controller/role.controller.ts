import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { RoleService } from '../service/role.service';

import { FetchQueryParam } from 'src/common/decorators/fetch-query.decorator';
import { FetchQuery } from 'src/common/fetch-query/crud.types';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

// ASSUMPTION — same as flagged before: not yet provided:
// src/common/guards/roles.guard.ts and its matching decorator.
// Guessed to live alongside public.decorator.ts /
// current-user.decorator.ts as
// src/common/decorators/roles.decorator.ts, exporting
// Roles(...roles: string[]), read by the globally-registered
// RolesGuard in AppModule.
import { Roles } from 'src/common/decorators/roles.decorator';

import { CreateRoleDto, UpdateRoleDto } from '../dto/role.dto';

@Controller('roles')
@ApiTags('Roles')
@ApiBearerAuth('access-token')
export class RoleController {
  constructor(
    public readonly service: RoleService,
  ) {}

  // ─────────────────────────────────────────────
  // GET ALL ROLES
  // Left open to any authenticated admin-side user — unrestricted
  // beyond the global AuthGuard, same as before. If you want listing
  // itself locked to super_admin too, add @Roles('super_admin') here.
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
  async findAll(
    @FetchQueryParam() query: FetchQuery,
  ) {
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
  async findOne(
    @Param('id') id: string,
  ) {
    return await this.service.findOne(id);
  }

  // ─────────────────────────────────────────────
  // CREATE ROLE
  // Restricted to super_admin
  // PRD 23/24/36: Admin Portal > Roles and Permissions
  // ─────────────────────────────────────────────

  @Post()
  @Roles('super_admin')
  @ApiOperation({
    summary: 'Create a new role',
  })
  async create(
    @CurrentUser() actor: CurrentUserDto,
    @Body() data: CreateRoleDto,
  ) {
    return await this.service.create(actor, data);
  }

  // ─────────────────────────────────────────────
  // UPDATE ROLE
  // Restricted to super_admin
  // Protected seeded roles (super_admin, admin) cannot be renamed.
  // ─────────────────────────────────────────────

  @Patch(':id')
  @Roles('super_admin')
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
  // Restricted to super_admin
  // Blocked for protected seeded roles and roles still in use.
  // ─────────────────────────────────────────────

  @Delete(':id')
  @Roles('super_admin')
  @ApiOperation({
    summary: 'Delete a role (must be unused and unprotected)',
  })
  @ApiParam({
    name: 'id',
    type: 'string',
  })
  async remove(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
  ) {
    return await this.service.remove(actor, id);
  }
}
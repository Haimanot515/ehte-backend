import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { RoleService } from '../service/role.service';

import { FetchQueryParam } from 'src/common/decorators/fetch-query.decorator';
import { FetchQuery } from 'src/common/fetch-query/crud.types';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import {
  CreateRoleDto,
  UpdateRoleDto,
  AssignRoleToUserDto,
  RemoveRoleFromUserDto,
  BulkRoleAssignmentDto,
  RequestRoleAssignmentDto,
  ReviewRoleAssignmentRequestDto,
  CloneRoleDto,
  ArchiveRoleDto,
  CompareRolesQueryDto,
  ApplyRoleTemplateDto,
  TemporaryRoleAssignmentDto,
} from '../dto/role.dto';

// Mutating routes (POST/PATCH/DELETE) require re-authentication: send the admin's current
// `password` in the JSON body; the guard strips it before the DTO is built.
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

  // ───────────────────────────── NEW ENDPOINTS ─────────────────────────────
  // Static paths are declared above ':id' on purpose, so they are not read as an id.

  // AR-37
  @Get('summary')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: 'Each role with user and permission counts' })
  async summary() {
    return await this.service.summary();
  }

  // AR-40
  @Get('compare')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: 'Permission differences between two roles' })
  @ApiQuery({ name: 'a', required: true, type: 'string' })
  @ApiQuery({ name: 'b', required: true, type: 'string' })
  async compare(@Query() query: CompareRolesQueryDto) {
    return await this.service.compare(query);
  }

  // AR-45
  @Get('templates')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: 'Starter roles for common jobs (reviewer, finance officer, support agent)' })
  async templates() {
    return await this.service.listTemplates();
  }

  // AR-46
  @Post('templates/:templateId/apply')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_CREATE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Create a role from a template' })
  @ApiParam({ name: 'templateId', type: 'string' })
  async applyTemplate(
    @CurrentUser() actor: CurrentUserDto,
    @Param('templateId') templateId: string,
    @Body() data: ApplyRoleTemplateDto,
  ) {
    return await this.service.applyTemplate(actor, templateId, data);
  }

  // AR-57
  @Get('temporary')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: 'Active temporary assignments and their end dates' })
  async listTemporary() {
    return await this.service.listTemporaryAssignments();
  }

  // AR-35
  @Get('assignment-requests')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_ROLE_ASSIGN)
  @ApiOperation({ summary: 'Pending role assignment requests' })
  async listAssignmentRequests() {
    return await this.service.listAssignmentRequests();
  }

  // AR-36 — a different Super Admin approves or rejects; the requester cannot approve.
  @Patch('assignment-requests/:requestId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_ROLE_ASSIGN)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Approve or reject a role assignment request' })
  @ApiParam({ name: 'requestId', type: 'string' })
  async reviewAssignmentRequest(
    @CurrentUser() actor: CurrentUserDto,
    @Param('requestId') requestId: string,
    @Body() data: ReviewRoleAssignmentRequestDto,
  ) {
    return await this.service.reviewAssignmentRequest(actor, requestId, data);
  }

  // AR-80
  @Get('stats/overview')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: 'Roles, assignments, temporary grants and pending requests in one call' })
  async statsOverview() {
    return await this.service.statsOverview();
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
  @RequireReauthentication()
  @ApiOperation({ summary: 'Create a new role' })
  async create(@CurrentUser() actor: CurrentUserDto, @Body() data: CreateRoleDto) {
    return await this.service.create(actor, data);
  }

  // Assigning an existing role to a user uses PermissionsEnum.USER_ROLE_ASSIGN instead, in UserController.
  @Patch(':id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_UPDATE)
  @RequireReauthentication()
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
  @RequireReauthentication()
  @ApiOperation({ summary: 'Delete a role (must be unused and unprotected)' })
  @ApiParam({ name: 'id', type: 'string' })
  async remove(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return await this.service.remove(actor, id);
  }

  // AR-38
  @Get(':id/permissions')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: "A role's permissions as a list" })
  @ApiParam({ name: 'id', type: 'string' })
  async findPermissions(@Param('id') id: string) {
    return await this.service.findPermissions(id);
  }

  // AR-33
  @Get(':id/assignments')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: 'Who granted this role to whom and when' })
  @ApiParam({ name: 'id', type: 'string' })
  async findAssignments(@Param('id') id: string) {
    return await this.service.findAssignments(id);
  }

  // AR-41
  @Get(':id/history')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: 'Changes to a role, from the audit events' })
  @ApiParam({ name: 'id', type: 'string' })
  async history(@Param('id') id: string) {
    return await this.service.history(id);
  }

  // AR-44 — also called by DELETE /roles/:id (inside RoleService.remove) to refuse a role in use.
  @Get(':id/delete-impact')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_READ)
  @ApiOperation({ summary: 'Who would lose access if this role were deleted' })
  @ApiParam({ name: 'id', type: 'string' })
  async deleteImpact(@Param('id') id: string) {
    return await this.service.deleteImpact(id);
  }

  // AR-39
  @Post(':id/clone')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_CREATE)
  @RequireReauthentication()
  @ApiOperation({ summary: "Create a role copying another role's permissions" })
  @ApiParam({ name: 'id', type: 'string' })
  async clone(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: CloneRoleDto,
  ) {
    return await this.service.clone(actor, id, data);
  }

  // AR-42
  @Patch(':id/archive')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_UPDATE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Retire a role without deleting history' })
  @ApiParam({ name: 'id', type: 'string' })
  async archive(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: ArchiveRoleDto,
  ) {
    return await this.service.archive(actor, id, data);
  }

  // AR-43
  @Patch(':id/unarchive')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_UPDATE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Bring an archived role back' })
  @ApiParam({ name: 'id', type: 'string' })
  async unarchive(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: ArchiveRoleDto,
  ) {
    return await this.service.unarchive(actor, id, data);
  }

  // ── Role assignment ──
  // Mutating routes need re-auth, a reason and an audit event. DELETE bodies are stripped by
  // some proxies (see the note on PermissionController); the same tradeoff applies to AR-30.

  // AR-29
  @Post(':roleId/users')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_ROLE_ASSIGN)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Assign a custom role to a verified staff user' })
  @ApiParam({ name: 'roleId', type: 'string' })
  async assignToUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Body() data: AssignRoleToUserDto,
  ) {
    return await this.service.assignToUser(actor, roleId, data);
  }

  // AR-31 — declared before the ':userId' routes so 'bulk' is never read as a user id.
  @Post(':roleId/users/bulk')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_ROLE_ASSIGN)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Assign or remove a role for several users' })
  @ApiParam({ name: 'roleId', type: 'string' })
  async bulkAssign(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Body() data: BulkRoleAssignmentDto,
  ) {
    return await this.service.bulkAssign(actor, roleId, data);
  }

  // AR-30 — refuses to remove a user's last role.
  @Delete(':roleId/users/:userId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_ROLE_ASSIGN)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Remove a custom role from a user' })
  @ApiParam({ name: 'roleId', type: 'string' })
  @ApiParam({ name: 'userId', type: 'string' })
  async removeFromUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Param('userId') userId: string,
    @Body() data: RemoveRoleFromUserDto,
  ) {
    return await this.service.removeFromUser(actor, roleId, userId, data);
  }

  // AR-34 — starts two-person approval for a sensitive role.
  @Post(':roleId/users/:userId/request')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_ROLE_ASSIGN)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Request a sensitive role for a user (two-person approval)' })
  @ApiParam({ name: 'roleId', type: 'string' })
  @ApiParam({ name: 'userId', type: 'string' })
  async requestAssignment(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Param('userId') userId: string,
    @Body() data: RequestRoleAssignmentDto,
  ) {
    return await this.service.requestAssignment(actor, roleId, userId, data);
  }

  // AR-56 — removed automatically at the end date.
  @Post(':roleId/users/:userId/temporary')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_ROLE_ASSIGN)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Grant a role until a set date' })
  @ApiParam({ name: 'roleId', type: 'string' })
  @ApiParam({ name: 'userId', type: 'string' })
  async assignTemporarily(
    @CurrentUser() actor: CurrentUserDto,
    @Param('roleId') roleId: string,
    @Param('userId') userId: string,
    @Body() data: TemporaryRoleAssignmentDto,
  ) {
    return await this.service.assignTemporarily(actor, roleId, userId, data);
  }
}
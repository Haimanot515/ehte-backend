import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { PermissionsEnum as P } from 'src/common/enums/permissions.enum';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { ApiClientsService } from '../service/api-clients.service';
import {
  ApiClientAuditQueryDto,
  ApiClientsQueryDto,
  ApiClientUsageQueryDto,
  CreateApiClientDto,
  UpdateApiClientDto,
} from '../dto/api-clients.dto';

/**
 * PARTNER API ACCESS (SH-88 to SH-95) — only needed if institutions will call your API.
 * The secret is returned once (create, rotate) and stored hashed; it is never logged or audited.
 * Create, rotate and revoke require re-auth (credential-issuing actions); this is an addition to
 * the doc, remove @RequireReauthentication() if you do not want it.
 * No literal-vs-':id' clashes: every sub-route has a second segment after ':id'.
 */
@ApiTags('Admin: partner API clients')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@RequirePermissions(P.API_CLIENT_MANAGE)
@Controller('admin/api-clients')
export class ApiClientsController {
  constructor(private readonly clients: ApiClientsService) {}

  // SH-88
  @Post()
  @RequireReauthentication()
  @AuditEvent({ action: AuditEventEnum.API_CLIENT_CREATED, entity: 'ApiClient' })
  @ApiOperation({ summary: 'Admin: create a client with scopes and an optional IP allowlist (secret shown once)' })
  create(@CurrentUser() admin: CurrentUserDto, @Body() body: CreateApiClientDto) {
    return this.clients.create(admin, body);
  }

  // SH-89
  @Get()
  @ApiOperation({ summary: 'Admin: clients with last use' })
  list(@Query() q: ApiClientsQueryDto) {
    return this.clients.list(q);
  }

  // SH-90
  @Get(':id')
  @ApiOperation({ summary: 'Admin: one client with scopes and recent calls' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.clients.getOne(id);
  }

  // SH-91
  @Patch(':id')
  @AuditEvent({ action: AuditEventEnum.API_CLIENT_UPDATED, entity: 'ApiClient', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: change scopes, allowlist or rate limit' })
  update(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateApiClientDto) {
    return this.clients.update(admin, id, body);
  }

  // SH-92
  @Post(':id/rotate-secret')
  @RequireReauthentication()
  @AuditEvent({ action: AuditEventEnum.API_CLIENT_SECRET_ROTATED, entity: 'ApiClient', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: issue a new secret and retire the old one after a grace period' })
  rotateSecret(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.clients.rotateSecret(admin, id);
  }

  // SH-93
  @Delete(':id')
  @RequireReauthentication()
  @AuditEvent({ action: AuditEventEnum.API_CLIENT_REVOKED, entity: 'ApiClient', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: revoke a client' })
  revoke(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.clients.revoke(admin, id);
  }

  // SH-94
  @Get(':id/usage')
  @ApiOperation({ summary: 'Admin: calls over time and by route' })
  usage(@Param('id', ParseUUIDPipe) id: string, @Query() q: ApiClientUsageQueryDto) {
    return this.clients.usage(id, q);
  }

  // SH-95
  @Get(':id/audit')
  @AuditEvent({ action: AuditEventEnum.API_CLIENT_AUDIT_VIEWED, entity: 'ApiClient', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: everything the client did' })
  audit(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Query() q: ApiClientAuditQueryDto) {
    return this.clients.audit(admin, id, q);
  }
}

import {
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';

import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { AuditLogService } from '../service/audit-log.service';
import { GetAuditLogsDto } from '../dto/audit-log.dto';
import { Roles } from 'src/common/decorators/roles.decorator';

@Controller('audit-logs')
@ApiTags('Audit Logs')
@ApiBearerAuth('access-token')
@Roles('ADMIN', 'SUPER_ADMIN')
export class AuditLogController {
  constructor(
    private readonly auditLogService: AuditLogService,
  ) {}

  // ─────────────────────────────────────────────
  // LIST
  // GET /audit-logs
  //
  // Modified — now supports entityId and
  // startDate/endDate filters in addition to the
  // existing action/entity/actorType/userId/page/limit.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Get audit logs',
    description:
      'Returns audit logs for authorized administrators.',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'entity', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'actorType', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  async getAuditLogs(
    @Query() dto: GetAuditLogsDto,
  ) {
    return this.auditLogService.findAll(dto);
  }

  // ─────────────────────────────────────────────
  // STATS
  // GET /audit-logs/stats
  //
  // Registered before ':id' — NestJS matches routes
  // in declaration order, and ':id' would otherwise
  // swallow this path (id = 'stats').
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get('stats')
  @ApiOperation({
    summary: 'Get audit log statistics',
  })
  async getStats() {
    return this.auditLogService.getStats();
  }

  // ─────────────────────────────────────────────
  // Added — BY ENTITY
  // GET /audit-logs/entity/:entity/:entityId
  //
  // Full audit history for one specific record,
  // e.g. every event tied to a single MissingPerson.
  // Registered before ':id' for the same route-
  // ordering reason as 'stats'.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get('entity/:entity/:entityId')
  @ApiOperation({
    summary: 'Get audit logs for a specific entity record',
  })
  @ApiParam({ name: 'entity', example: 'MissingPerson' })
  @ApiParam({ name: 'entityId', description: 'Entity record ID' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getAuditLogsForEntity(
    @Param('entity') entity: string,
    @Param('entityId') entityId: string,
    @Query() dto: GetAuditLogsDto,
  ) {
    return this.auditLogService.findByEntity(entity, entityId, dto);
  }

  // ─────────────────────────────────────────────
  // Added — BY USER
  // GET /audit-logs/user/:userId
  //
  // Full audit trail for one specific user/actor.
  // Registered before ':id' for the same route-
  // ordering reason as above.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get('user/:userId')
  @ApiOperation({
    summary: 'Get audit logs for a specific user',
  })
  @ApiParam({ name: 'userId', description: 'User ID' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getAuditLogsForUser(
    @Param('userId') userId: string,
    @Query() dto: GetAuditLogsDto,
  ) {
    return this.auditLogService.findByUser(userId, dto);
  }

  // ─────────────────────────────────────────────
  // Added — GET ONE
  // GET /audit-logs/:id
  //
  // Declared last: ':id' is a single dynamic
  // segment and would otherwise shadow 'stats',
  // 'entity/:entity/:entityId', and 'user/:userId'
  // if declared earlier.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({
    summary: 'Get one audit log entry',
  })
  @ApiParam({ name: 'id', description: 'Audit log ID' })
  async getAuditLogById(
    @Param('id') id: string,
  ) {
    return this.auditLogService.findOne(id);
  }
}
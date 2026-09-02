import { Controller, Delete, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { AuditLogService } from '../service/audit-log.service';
import { GetAuditLogsDto } from '../dto/audit-log.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';

@Controller('audit-logs')
@ApiTags('Audit Logs')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  // ─────────────────────────────────────────────
  // LIST
  // GET /audit-logs
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Get audit logs',
    description: 'Returns audit logs for authorized administrators.',
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
  async getAuditLogs(@Query() dto: GetAuditLogsDto) {
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
  // DISTINCT ACTIONS
  // GET /audit-logs/actions
  //
  // Distinct action values in use, for populating
  // filter dropdowns in the admin portal. Registered
  // before ':id' for the same route-ordering reason
  // as 'stats'.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get('actions')
  @ApiOperation({
    summary: 'Get distinct audit log action values',
  })
  async getDistinctActions() {
    return this.auditLogService.findDistinctActions();
  }

  // ─────────────────────────────────────────────
  // DISTINCT ENTITIES
  // GET /audit-logs/entities
  //
  // Distinct entity values in use, for populating
  // filter dropdowns in the admin portal. Registered
  // before ':id' for the same route-ordering reason
  // as above.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get('entities')
  @ApiOperation({
    summary: 'Get distinct audit log entity values',
  })
  async getDistinctEntities() {
    return this.auditLogService.findDistinctEntities();
  }

  // ─────────────────────────────────────────────
  // EXPORT CSV
  // GET /audit-logs/export
  //
  // Same filters as the list endpoint, minus
  // page/limit — streams up to MAX_EXPORT_ROWS
  // matching rows as a CSV download. Registered
  // before ':id' for the same route-ordering
  // reason as the other literal paths above.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get('export')
  @ApiOperation({
    summary: 'Export audit logs as CSV',
  })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'entity', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'actorType', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  async exportAuditLogs(@Query() dto: GetAuditLogsDto, @Res() res: Response) {
    const csv = await this.auditLogService.exportCsv(dto);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.csv"`);
    res.send(csv);
  }

  // ─────────────────────────────────────────────
  // BY ENTITY
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
  // BY USER
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
  async getAuditLogsForUser(@Param('userId') userId: string, @Query() dto: GetAuditLogsDto) {
    return this.auditLogService.findByUser(userId, dto);
  }

  // ─────────────────────────────────────────────
  // PURGE OLD LOGS
  // DELETE /audit-logs/purge?olderThan=2024-01-01
  //
  // Retention cleanup. Deliberately overrides the
  // class-level @Roles() — deleting audit history is
  // more sensitive than reading it, so this is locked
  // to SUPER_ADMIN only, not ADMIN.
  //
  // Registered before ':id' for the same route-
  // ordering reason as above.
  //
  // SUPER_ADMIN ONLY
  // ─────────────────────────────────────────────

  @Delete('purge')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Super admin: purge audit logs older than a given date',
  })
  @ApiQuery({
    name: 'olderThan',
    required: true,
    description: 'ISO date — logs created before this are deleted',
  })
  async purgeOldLogs(@Query('olderThan') olderThan: string) {
    return this.auditLogService.purgeOlderThan(olderThan);
  }

  // ─────────────────────────────────────────────
  // GET ONE
  // GET /audit-logs/:id
  //
  // Declared last: ':id' is a single dynamic
  // segment and would otherwise shadow 'stats',
  // 'actions', 'entities', 'export',
  // 'entity/:entity/:entityId', 'user/:userId', and
  // 'purge' if declared earlier.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({
    summary: 'Get one audit log entry',
  })
  @ApiParam({ name: 'id', description: 'Audit log ID' })
  async getAuditLogById(@Param('id') id: string) {
    return this.auditLogService.findOne(id);
  }
}

import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { AuditLogService } from '../service/audit-log.service';
import {
  AuditPagingDto,
  AuditStatsQueryDto,
  AuditUserScopeQueryDto,
  CreateAuditAlertDto,
  CreateSavedFilterDto,
  GetAuditLogsDto,
  IntegrityVerifyQueryDto,
  PurgeAuditLogsDto,
  PurgePreviewQueryDto,
  TimelineQueryDto,
  UpdateAuditAlertDto,
} from '../dto/audit-log.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

/**
 * ─────────────────────────────────────────────
 * AUDIT LOGS — company-level controller
 * ─────────────────────────────────────────────
 *
 * Class-level @Roles(ADMIN, SUPER_ADMIN). Routes that are more sensitive
 * override it with @Roles(SUPER_ADMIN).
 *
 * VIEWER-AWARE READS: every read passes the calling user to the service.
 * The service returns the FULL row to SUPER_ADMIN and a REDACTED row to
 * ADMIN (no ipAddress, userAgent, metadata; no phone for anyone).
 *
 * AUDIT THE AUDIT: exports, single-entry views, purge previews and purges
 * are themselves recorded by the service (AUDIT_LOG_EXPORTED,
 * AUDIT_LOG_VIEWED, AUDIT_LOG_PURGE_PREVIEWED, AUDIT_LOG_PURGED, ...).
 * That is why the calling user is passed to methods that used to be
 * anonymous.
 *
 * ROUTE ORDER MATTERS. Literal paths first, then multi-segment, then
 * ':id' last so it can never shadow them.
 *
 * NOT INCLUDED: 'GET /audit-logs/me' (a user's own account activity).
 * This controller is admin-only by class-level @Roles; a user-facing
 * endpoint belongs in an account/profile controller.
 *
 * RATE LIMITING: apply your throttler to export, purge and anonymize.
 */
@Controller('audit-logs')
@ApiTags('Audit Logs')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  // ═════════════════════════════════════════════
  // LIST + FILTER OPTIONS
  // ═════════════════════════════════════════════

  @Get()
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'Get audit logs',
    description:
      'Filtering + cursor/offset pagination. Full rows for SUPER_ADMIN, redacted for ADMIN.',
  })
  @ApiQuery({ name: 'cursor', required: false, description: 'Cursor pagination (preferred)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'q', required: false, description: 'Free text: entityLabel, reason, actorName' })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'entity', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'actorType', required: false })
  @ApiQuery({ name: 'actorRole', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'targetUserId', required: false })
  @ApiQuery({ name: 'outcome', required: false })
  @ApiQuery({ name: 'severity', required: false })
  @ApiQuery({ name: 'source', required: false })
  @ApiQuery({ name: 'method', required: false })
  @ApiQuery({ name: 'path', required: false })
  @ApiQuery({ name: 'country', required: false })
  @ApiQuery({ name: 'city', required: false })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'requestId', required: false })
  @ApiQuery({ name: 'ipAddress', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  async getAuditLogs(@Query() dto: GetAuditLogsDto, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.findAll(dto, viewer);
  }

  @Get('actions')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Get distinct audit log action values (filter dropdown)' })
  async getDistinctActions() {
    return this.auditLogService.findDistinctActions();
  }

  @Get('entities')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Get distinct audit log entity values (filter dropdown)' })
  async getDistinctEntities() {
    return this.auditLogService.findDistinctEntities();
  }

  // ═════════════════════════════════════════════
  // STATS
  // ═════════════════════════════════════════════

  @Get('stats')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'Get audit log statistics',
    description:
      'Totals, today/week, and breakdowns by action, entity, actorType, severity, ' +
      'outcome and source.',
  })
  async getStats() {
    return this.auditLogService.getStats();
  }

  @Get('stats/timeline')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Events per day for the last N days (dashboard chart)' })
  @ApiQuery({ name: 'days', required: false, description: 'Default 30' })
  async getTimeline(@Query() query: TimelineQueryDto) {
    return this.auditLogService.getTimeline(query);
  }

  @Get('stats/top-actors')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Most active actors, plus most denied/failed actors' })
  @ApiQuery({ name: 'days', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getTopActors(@Query() query: AuditStatsQueryDto) {
    return this.auditLogService.getTopActors(query);
  }

  // ═════════════════════════════════════════════
  // SECURITY VIEW + SYSTEM HEALTH
  // ═════════════════════════════════════════════

  @Get('security')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'Security events',
    description:
      'DENIED and FAILURE outcomes at WARNING severity or above, plus failed logins ' +
      'and security alerts. Same filters and pagination as the list.',
  })
  async getSecurityEvents(@Query() dto: GetAuditLogsDto, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.findSecurityEvents(dto, viewer);
  }

  @Get('health')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'Super admin: audit pipeline health',
    description: 'Last write time, write failures, table size, oldest row, legal-hold count.',
  })
  async getHealth() {
    return this.auditLogService.getHealth();
  }

  // ═════════════════════════════════════════════
  // EXPORT (+ history)
  // ═════════════════════════════════════════════

  @Get('exports')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'History of audit exports (who, when, which filter, how many rows)' })
  async getExportHistory(@Query() dto: AuditPagingDto) {
    return this.auditLogService.findExportHistory(dto);
  }

  @Get('export')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'Export audit logs as CSV',
    description:
      'Same filters as the list, minus paging. Recorded in the export history and audited. ' +
      'Response headers: X-Row-Count and X-Truncated (true when the row cap was hit).',
  })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'entity', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'actorType', required: false })
  @ApiQuery({ name: 'actorRole', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'targetUserId', required: false })
  @ApiQuery({ name: 'outcome', required: false })
  @ApiQuery({ name: 'severity', required: false })
  @ApiQuery({ name: 'source', required: false })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'requestId', required: false })
  @ApiQuery({ name: 'ipAddress', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  async exportAuditLogs(
    @Query() dto: GetAuditLogsDto,
    @CurrentUser() viewer: CurrentUserDto,
    @Res() res: Response,
  ) {
    const { csv, rowCount, truncated } = await this.auditLogService.exportCsv(dto, viewer);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.csv"`);
    res.setHeader('X-Row-Count', String(rowCount));
    res.setHeader('X-Truncated', String(truncated));
    res.setHeader('Access-Control-Expose-Headers', 'X-Row-Count, X-Truncated');
    res.send(csv);
  }

  // ═════════════════════════════════════════════
  // SAVED FILTERS (per admin)
  // ═════════════════════════════════════════════

  @Get('saved-filters')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'My saved audit-log searches' })
  async getSavedFilters(@CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.findSavedFilters(viewer);
  }

  @Post('saved-filters')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Save an audit-log search' })
  async createSavedFilter(
    @Body() dto: CreateSavedFilterDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.createSavedFilter(dto, viewer);
  }

  @Delete('saved-filters/:id')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Delete one of my saved searches' })
  @ApiParam({ name: 'id', description: 'Saved filter ID' })
  async deleteSavedFilter(@Param('id') id: string, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.deleteSavedFilter(id, viewer);
  }

  // ═════════════════════════════════════════════
  // ALERT RULES (SUPER_ADMIN)
  // e.g. "notify SUPER_ADMINs on 5 DENIED in 10 minutes"
  // ═════════════════════════════════════════════

  @Get('alerts')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Super admin: list alert rules' })
  async getAlerts() {
    return this.auditLogService.findAlerts();
  }

  @Post('alerts')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Super admin: create an alert rule' })
  async createAlert(@Body() dto: CreateAuditAlertDto, @CurrentUser() actor: CurrentUserDto) {
    return this.auditLogService.createAlert(dto, actor);
  }

  @Patch('alerts/:id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Super admin: update or enable/disable an alert rule' })
  @ApiParam({ name: 'id', description: 'Alert rule ID' })
  async updateAlert(
    @Param('id') id: string,
    @Body() dto: UpdateAuditAlertDto,
    @CurrentUser() actor: CurrentUserDto,
  ) {
    return this.auditLogService.updateAlert(id, dto, actor);
  }

  @Delete('alerts/:id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Super admin: delete an alert rule' })
  @ApiParam({ name: 'id', description: 'Alert rule ID' })
  async deleteAlert(@Param('id') id: string, @CurrentUser() actor: CurrentUserDto) {
    return this.auditLogService.deleteAlert(id, actor);
  }

  // ═════════════════════════════════════════════
  // INTEGRITY (hash chain)
  // ═════════════════════════════════════════════

  @Get('integrity/verify')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'Super admin: verify the audit hash chain',
    description:
      'Recomputes hash/prevHash over a date range. Returns ok, rows checked, and the ' +
      'first broken link (if any). A break means a row was edited or removed.',
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  async verifyIntegrity(
    @Query() query: IntegrityVerifyQueryDto,
    @CurrentUser() actor: CurrentUserDto,
  ) {
    return this.auditLogService.verifyIntegrity(query, actor);
  }

  // ═════════════════════════════════════════════
  // RETENTION: PREVIEW → PURGE
  // ═════════════════════════════════════════════

  @Get('purge/preview')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Super admin: dry-run of a purge',
    description:
      'Returns how many rows would be deleted, how many are under legal hold (never ' +
      'deleted), and a short-lived confirmToken required by DELETE /audit-logs/purge.',
  })
  @ApiQuery({ name: 'olderThan', required: true, description: 'ISO date' })
  async previewPurge(
    @Query() query: PurgePreviewQueryDto,
    @CurrentUser() actor: CurrentUserDto,
  ) {
    return this.auditLogService.previewPurge(query.olderThan, actor);
  }

  /**
   * DELETE /audit-logs/purge?olderThan=...&reason=...&confirmToken=...
   *
   * SUPER_ADMIN only (overrides class-level @Roles). Deleting audit history is
   * more sensitive than reading it. The service must:
   *   1. validate the confirmToken issued by the preview,
   *   2. require a written reason,
   *   3. archive matching rows to cold storage BEFORE deleting,
   *   4. skip rows under legal hold,
   *   5. write AUDIT_LOG_PURGED AFTER the delete so the cutoff can't remove it.
   */
  @Delete('purge')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Super admin: archive then purge audit logs older than a date',
  })
  @ApiQuery({ name: 'olderThan', required: true, description: 'ISO date' })
  @ApiQuery({ name: 'reason', required: true })
  @ApiQuery({ name: 'confirmToken', required: true, description: 'From GET purge/preview' })
  async purgeOldLogs(@Query() dto: PurgeAuditLogsDto, @CurrentUser() actor: CurrentUserDto) {
    return this.auditLogService.purgeOlderThan(dto, actor);
  }

  // ═════════════════════════════════════════════
  // DATA-SUBJECT: anonymize one user in audit rows
  // Keeps the events, removes the person (name/role/ip/user agent).
  // ═════════════════════════════════════════════

  @Post('anonymize/:userId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Super admin: anonymize one user across audit rows',
    description: 'Events are kept; personal fields are blanked. The action is itself audited.',
  })
  @ApiParam({ name: 'userId', description: 'User ID' })
  async anonymizeUser(@Param('userId') userId: string, @CurrentUser() actor: CurrentUserDto) {
    return this.auditLogService.anonymizeUser(userId, actor);
  }

  // ═════════════════════════════════════════════
  // SCOPED VIEWS
  // ═════════════════════════════════════════════

  @Get('entity/:entity/:entityId')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Audit history for one specific record' })
  @ApiParam({ name: 'entity', example: 'MissingPerson' })
  @ApiParam({ name: 'entityId', description: 'Entity record ID' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getAuditLogsForEntity(
    @Param('entity') entity: string,
    @Param('entityId') entityId: string,
    @Query() dto: AuditPagingDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.findByEntity(entity, entityId, dto, viewer);
  }

  @Get('user/:userId')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'Audit trail for one user',
    description:
      "as=actor (default): things the user did. as=target: things done TO the user. " +
      'as=both: either.',
  })
  @ApiParam({ name: 'userId', description: 'User ID' })
  @ApiQuery({ name: 'as', required: false, enum: ['actor', 'target', 'both'] })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getAuditLogsForUser(
    @Param('userId') userId: string,
    @Query() dto: AuditUserScopeQueryDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.findByUser(userId, dto, viewer);
  }

  @Get('target/:targetUserId')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Everything done TO one user (shortcut for user/:id?as=target)' })
  @ApiParam({ name: 'targetUserId', description: 'User ID' })
  async getAuditLogsForTarget(
    @Param('targetUserId') targetUserId: string,
    @Query() dto: AuditPagingDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.findByUser(targetUserId, { ...dto, as: 'target' }, viewer);
  }

  @Get('session/:sessionId')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Everything that happened in one login session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  async getAuditLogsForSession(
    @Param('sessionId') sessionId: string,
    @Query() dto: AuditPagingDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.findBySession(sessionId, dto, viewer);
  }

  @Get('request/:requestId')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Everything recorded for one request id (trace a single call)' })
  @ApiParam({ name: 'requestId', description: 'Request ID' })
  async getAuditLogsForRequest(
    @Param('requestId') requestId: string,
    @Query() dto: AuditPagingDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.findByRequest(requestId, dto, viewer);
  }

  // ═════════════════════════════════════════════
  // GET ONE — declared last (':id' would shadow every literal above)
  // ═════════════════════════════════════════════

  @Get(':id')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'Get one audit log entry',
    description:
      'Full row incl. actor, target user, diff and metadata for SUPER_ADMIN; redacted ' +
      'for ADMIN. Viewing is itself audited.',
  })
  @ApiParam({ name: 'id', description: 'Audit log ID' })
  async getAuditLogById(@Param('id') id: string, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.findOne(id, viewer);
  }
}
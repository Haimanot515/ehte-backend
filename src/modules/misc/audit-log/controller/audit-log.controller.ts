import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { AuditLogService } from '../service/audit-log.service';
import {
  AcknowledgeTriggerDto,
  AlertTriggersQueryDto,
  ApplyAlertTemplateDto,
  AuditBucketStatsQueryDto,
  AuditStatsFilterDto,
  AuditSummaryQueryDto,
  CancelPurgeScheduleDto,
  CreateAuditExportJobDto,
  CreateLegalHoldDto,
  DeniedStatsQueryDto,
  HealthHistoryQueryDto,
  IntegrityRunsQueryDto,
  IntegrityScheduleDto,
  LegalHoldsQueryDto,
  PreviewLegalHoldDto,
  PurgeRunsQueryDto,
  PurgeScheduleQueryDto,
  ReleaseLegalHoldDto,
  SchedulePurgeDto,
  SetRowLegalHoldDto,
  ShareSavedFilterDto,
  TestAlertDto,
  UnshareSavedFilterDto,
  UpdateRetentionDto,
  UpdateSavedFilterDto,
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
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';

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
 * 'GET /audit-logs/me' and 'me/security' (a user's own account activity) are NOT here.
 * This controller is admin-only by class-level @Roles, so they live in
 * MyAuditController, which is registered BEFORE this controller in the module.
 *
 * RATE LIMITING: apply your throttler to export, purge and anonymize.
 */
@Controller('audit-logs')
@ApiTags('Audit Logs')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

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
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Free text: entityLabel, reason, actorName',
  })
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
  @ApiQuery({ name: 'region', required: false })
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

  @Get('saved-filters')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'My saved audit-log searches' })
  async getSavedFilters(@CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.findSavedFilters(viewer);
  }

  @Post('saved-filters')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Save an audit-log search' })
  @AuditEvent({ action: AuditEventEnum.AUDIT_SAVED_FILTER_CREATED, entity: 'AuditSavedFilter', entityId: { response: ['id'] } })
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
  @AuditEvent({ action: AuditEventEnum.AUDIT_SAVED_FILTER_DELETED, entity: 'AuditSavedFilter', entityId: { param: 'id' } })
  async deleteSavedFilter(@Param('id') id: string, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.deleteSavedFilter(id, viewer);
  }

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

  @Get('purge/preview')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Super admin: dry-run of a purge',
    description:
      'Returns how many rows would be deleted, how many are under legal hold (never ' +
      'deleted), and a short-lived confirmToken required by DELETE /audit-logs/purge.',
  })
  @ApiQuery({ name: 'olderThan', required: true, description: 'ISO date' })
  async previewPurge(@Query() query: PurgePreviewQueryDto, @CurrentUser() actor: CurrentUserDto) {
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

  // ── 1. Legal hold ────────────────────────────

  @Post('legal-hold')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_LEGAL_HOLD)
  @ApiOperation({
    summary: 'Apply a legal hold by filter (entity, user, date range) for a case',
    description: 'Covers the rows that exist now. Held rows are never purged or anonymized.',
  })
  async createLegalHold(@Body() dto: CreateLegalHoldDto, @CurrentUser() actor: CurrentUserDto) {
    return this.auditLogService.createLegalHold(dto, actor);
  }

  @Post('legal-holds/preview')
  @HttpCode(200)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_LEGAL_HOLD)
  @ApiOperation({ summary: 'How many rows a hold filter would cover, before applying it' })
  @AuditEvent({ action: AuditEventEnum.AUDIT_LEGAL_HOLD_PREVIEWED, entity: 'AuditLegalHold' })
  async previewLegalHold(@Body() dto: PreviewLegalHoldDto) {
    return this.auditLogService.previewLegalHold(dto);
  }

  @Get('legal-holds')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'List legal holds with case reference, reason, who set them and row count',
  })
  async listLegalHolds(@Query() query: LegalHoldsQueryDto) {
    return this.auditLogService.listLegalHolds(query);
  }

  @Get('legal-holds/:holdId/history')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Who created, changed and released a hold' })
  @ApiParam({ name: 'holdId', description: 'Legal hold ID' })
  async getLegalHoldHistory(
    @Param('holdId', ParseUUIDPipe) holdId: string,
    @Query() dto: AuditPagingDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.getLegalHoldHistory(holdId, dto, viewer);
  }

  @Get('legal-holds/:holdId')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'One hold with its filter and the rows it covers' })
  @ApiParam({ name: 'holdId', description: 'Legal hold ID' })
  async getLegalHold(
    @Param('holdId', ParseUUIDPipe) holdId: string,
    @Query() dto: AuditPagingDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.getLegalHold(holdId, dto, viewer);
  }

  @Delete('legal-holds/:holdId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_LEGAL_HOLD)
  @ApiOperation({
    summary: 'Super admin: release a hold (reason and a second Super Admin required)',
    description:
      'The first request is recorded. A different Super Admin must send the same request to approve it.',
  })
  @ApiParam({ name: 'holdId', description: 'Legal hold ID' })
  async releaseLegalHold(
    @Param('holdId', ParseUUIDPipe) holdId: string,
    @Body() dto: ReleaseLegalHoldDto,
    @CurrentUser() actor: CurrentUserDto,
  ) {
    return this.auditLogService.releaseLegalHold(holdId, dto, actor);
  }

  // ── 2. Purge and retention ───────────────────

  @Get('purge/runs')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_PURGE)
  @ApiOperation({ summary: 'Super admin: purge history (cutoff, reason, status, counts, errors)' })
  async listPurgeRuns(@Query() query: PurgeRunsQueryDto) {
    return this.auditLogService.listPurgeRuns(query);
  }

  @Get('purge/runs/:id/archive')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_PURGE)
  @ApiOperation({
    summary:
      'Super admin: retrieve archived rows from cold storage (unredacted, audited, second approver)',
    description: 'Returns short-lived download links once a second Super Admin has approved.',
  })
  @ApiParam({ name: 'id', description: 'Purge run ID' })
  async retrievePurgeArchive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: CurrentUserDto,
  ) {
    return this.auditLogService.retrievePurgeArchive(id, actor);
  }

  @Get('purge/runs/:id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_PURGE)
  @ApiOperation({ summary: 'Super admin: one purge run with archive key and failure details' })
  @ApiParam({ name: 'id', description: 'Purge run ID' })
  async getPurgeRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.auditLogService.getPurgeRun(id);
  }

  @Post('purge/schedule')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_PURGE)
  @ApiOperation({
    summary: 'Super admin: schedule a purge for a future date so others can object',
    description:
      'Needs minimum notice (default 72 hours). Archives first and skips held rows, like a manual purge.',
  })
  async schedulePurge(@Body() dto: SchedulePurgeDto, @CurrentUser() actor: CurrentUserDto) {
    return this.auditLogService.schedulePurge(dto, actor);
  }

  @Get('purge/schedule')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_PURGE)
  @ApiOperation({ summary: 'Super admin: scheduled purges' })
  async listPurgeSchedule(@Query() query: PurgeScheduleQueryDto) {
    return this.auditLogService.listPurgeSchedule(query);
  }

  @Delete('purge/schedule/:id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_PURGE)
  @ApiOperation({ summary: 'Super admin: cancel a scheduled purge (reason required)' })
  @ApiParam({ name: 'id', description: 'Scheduled purge ID' })
  async cancelPurgeSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPurgeScheduleDto,
    @CurrentUser() actor: CurrentUserDto,
  ) {
    return this.auditLogService.cancelPurgeSchedule(id, dto, actor);
  }

  @Get('retention')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Retention period per entity or severity' })
  async getRetention() {
    return this.auditLogService.getRetention();
  }

  @Patch('retention')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_PURGE)
  @ApiOperation({
    summary: 'Super admin: change retention (audited, second Super Admin must approve)',
    description: 'Re-authentication, if you require it, belongs in a guard on this route.',
  })
  async updateRetention(@Body() dto: UpdateRetentionDto, @CurrentUser() actor: CurrentUserDto) {
    return this.auditLogService.updateRetention(dto, actor);
  }

  @Get('anonymizations')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_ANONYMIZE)
  @ApiOperation({
    summary: 'Super admin: history of anonymize runs (who, whom, when, rows touched)',
  })
  async listAnonymizations(@Query() dto: AuditPagingDto, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.listAnonymizations(dto, viewer);
  }

  // ── 3. Integrity ─────────────────────────────

  @Get('integrity/runs')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_VERIFY_INTEGRITY)
  @ApiOperation({ summary: 'Super admin: history of integrity checks and their result' })
  async listIntegrityRuns(@Query() query: IntegrityRunsQueryDto) {
    return this.auditLogService.listIntegrityRuns(query);
  }

  @Post('integrity/schedule')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_VERIFY_INTEGRITY)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Super admin: run the hash-chain check on a schedule and alert on a break',
  })
  async setIntegritySchedule(
    @Body() dto: IntegrityScheduleDto,
    @CurrentUser() actor: CurrentUserDto,
  ) {
    return this.auditLogService.setIntegritySchedule(dto, actor);
  }

  @Get('integrity/breaks')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_VERIFY_INTEGRITY)
  @ApiOperation({ summary: 'Super admin: breaks found, with the first affected row' })
  async listIntegrityBreaks(@Query() dto: AuditPagingDto) {
    return this.auditLogService.listIntegrityBreaks(dto);
  }

  @Get('health/history')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Super admin: pipeline health over time (lag, failures, table size)' })
  async getHealthHistory(@Query() query: HealthHistoryQueryDto) {
    return this.auditLogService.getHealthHistory(query);
  }

  // ── 4. Alert rules (literals first, then ':id') ──

  @Get('alerts/triggers')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_ALERT_MANAGE)
  @ApiOperation({ summary: 'Super admin: queue of unacknowledged alert triggers' })
  async listTriggerQueue(@Query() query: AlertTriggersQueryDto) {
    return this.auditLogService.listTriggerQueue(query);
  }

  @Post('alerts/triggers/:triggerId/acknowledge')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_ALERT_MANAGE)
  @HttpCode(200)
  @ApiOperation({ summary: 'Super admin: mark a fired alert as seen, with a note' })
  @ApiParam({ name: 'triggerId', description: 'Alert trigger ID' })
  async acknowledgeTrigger(
    @Param('triggerId', ParseUUIDPipe) triggerId: string,
    @Body() dto: AcknowledgeTriggerDto,
    @CurrentUser() actor: CurrentUserDto,
  ) {
    return this.auditLogService.acknowledgeTrigger(triggerId, dto, actor);
  }

  @Get('alerts/templates')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_ALERT_MANAGE)
  @ApiOperation({
    summary: 'Super admin: ready-made alert rules (mass export, repeated denied access, ...)',
  })
  listAlertTemplates() {
    return this.auditLogService.listAlertTemplates();
  }

  @Post('alerts/templates/:templateId/apply')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_ALERT_MANAGE)
  @ApiOperation({ summary: 'Super admin: create an alert rule from a template' })
  @ApiParam({ name: 'templateId', example: 'mass-export' })
  async applyAlertTemplate(
    @Param('templateId') templateId: string,
    @Body() dto: ApplyAlertTemplateDto,
    @CurrentUser() actor: CurrentUserDto,
  ) {
    return this.auditLogService.applyAlertTemplate(templateId, dto, actor);
  }

  @Get('alerts/:id/triggers')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_ALERT_MANAGE)
  @ApiOperation({ summary: 'Super admin: history of when a rule fired' })
  @ApiParam({ name: 'id', description: 'Alert rule ID' })
  async listAlertTriggers(@Param('id', ParseUUIDPipe) id: string, @Query() dto: AuditPagingDto) {
    return this.auditLogService.listAlertTriggers(id, dto);
  }

  @Post('alerts/:id/test')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_ALERT_MANAGE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Super admin: dry-run a rule against recent data (nothing is recorded or sent)',
  })
  @ApiParam({ name: 'id', description: 'Alert rule ID' })
  async testAlert(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TestAlertDto,
    @CurrentUser() actor: CurrentUserDto,
  ) {
    return this.auditLogService.testAlert(id, dto, actor);
  }

  @Patch('alerts/:id/enable')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_ALERT_MANAGE)
  @ApiOperation({ summary: 'Super admin: turn a rule on' })
  @ApiParam({ name: 'id', description: 'Alert rule ID' })
  async enableAlert(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: CurrentUserDto) {
    return this.auditLogService.setAlertEnabled(id, true, actor);
  }

  @Patch('alerts/:id/disable')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_ALERT_MANAGE)
  @ApiOperation({ summary: 'Super admin: turn a rule off without deleting it' })
  @ApiParam({ name: 'id', description: 'Alert rule ID' })
  async disableAlert(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: CurrentUserDto) {
    return this.auditLogService.setAlertEnabled(id, false, actor);
  }

  @Get('alerts/:id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_ALERT_MANAGE)
  @ApiOperation({ summary: 'Super admin: one alert rule' })
  @ApiParam({ name: 'id', description: 'Alert rule ID' })
  async getAlert(@Param('id', ParseUUIDPipe) id: string) {
    return this.auditLogService.getAlert(id);
  }

  // ── 5. Saved filters (after the existing saved-filters routes) ──

  @Get('saved-filters/:id')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'One saved filter (mine, or shared with me)' })
  @ApiParam({ name: 'id', description: 'Saved filter ID' })
  async getSavedFilter(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.getSavedFilter(id, viewer);
  }

  @Patch('saved-filters/:id')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Rename or edit one of my saved filters' })
  @ApiParam({ name: 'id', description: 'Saved filter ID' })
  @AuditEvent({ action: AuditEventEnum.AUDIT_SAVED_FILTER_UPDATED, entity: 'AuditSavedFilter', entityId: { param: 'id' } })
  async updateSavedFilter(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSavedFilterDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.updateSavedFilter(id, dto, viewer);
  }

  @Post('saved-filters/:id/share')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Share one of my filters with other admins (omit userIds for all admins)',
  })
  @ApiParam({ name: 'id', description: 'Saved filter ID' })
  async shareSavedFilter(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShareSavedFilterDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.shareSavedFilter(id, dto, viewer);
  }

  @Delete('saved-filters/:id/share')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Stop sharing one of my filters (omit userIds to stop for everyone)' })
  @ApiParam({ name: 'id', description: 'Saved filter ID' })
  async unshareSavedFilter(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnshareSavedFilterDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.unshareSavedFilter(id, dto, viewer);
  }

  @Post('saved-filters/:id/run')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run a saved filter and return the results',
    description:
      'Paging goes in the query string (cursor, page, limit). Redaction follows your own role.',
  })
  @ApiParam({ name: 'id', description: 'Saved filter ID' })
  @AuditEvent({ action: AuditEventEnum.AUDIT_SAVED_FILTER_RUN, entity: 'AuditSavedFilter', entityId: { param: 'id' }, capture: ['query'] })
  async runSavedFilter(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: AuditPagingDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.runSavedFilter(id, dto, viewer);
  }

  // ── 6. Exports ───────────────────────────────

  @Get('exports/all')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Super admin: every export by every admin, with per-admin totals' })
  async listAllExports(@Query() dto: AuditPagingDto, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.listAllExports(dto, viewer);
  }

  @Get('exports/:id')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_EXPORT)
  @ApiOperation({ summary: 'One export record: filter, row count, whether it was truncated' })
  @ApiParam({ name: 'id', description: 'Export record ID' })
  async getExportRecord(@Param('id', ParseUUIDPipe) id: string) {
    return this.auditLogService.getExportRecord(id);
  }

  @Post('export-jobs')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_EXPORT)
  @HttpCode(202)
  @ApiOperation({
    summary: 'Start a background export beyond the CSV cap',
    description:
      'Same filters as the list (in the body, no paging). Same redaction as the CSV export.',
  })
  async startExportJob(
    @Body() dto: CreateAuditExportJobDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.startExportJob(dto, viewer);
  }

  @Get('export-jobs')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_EXPORT)
  @ApiOperation({ summary: 'My export jobs' })
  async listExportJobs(@Query() dto: AuditPagingDto, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.listExportJobs(viewer, dto);
  }

  @Get('export-jobs/:id/download')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_EXPORT)
  @ApiOperation({
    summary: 'Short-lived download links for a finished export (audited)',
    description: 'Links work for 5 minutes. Ask again for fresh ones.',
  })
  @ApiParam({ name: 'id', description: 'Export job ID' })
  async downloadExportJob(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.downloadExportJob(id, viewer);
  }

  @Get('export-jobs/:id')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_EXPORT)
  @ApiOperation({ summary: 'Export job progress' })
  @ApiParam({ name: 'id', description: 'Export job ID' })
  async getExportJob(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.getExportJob(id, viewer);
  }

  // ── 7. Views for cases ───────────────────────

  @Get('sensitive-access')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ_SENSITIVE)
  @ApiOperation({
    summary: 'Who viewed sensitive data: informant identity, child cases, bank details',
  })
  async getSensitiveAccess(@Query() dto: GetAuditLogsDto, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.findSensitiveAccess(dto, viewer);
  }

  @Get('privileged-actions')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Role, permission and security-setting changes' })
  @AuditEvent({ action: AuditEventEnum.AUDIT_PRIVILEGED_ACTIONS_VIEWED, entity: 'AuditLog', capture: ['query'] })
  async getPrivilegedActions(@Query() dto: GetAuditLogsDto, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.findPrivilegedActions(dto, viewer);
  }

  @Get('money-actions')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Refunds, payout verification, disbursements and manual payments' })
  @AuditEvent({ action: AuditEventEnum.AUDIT_MONEY_ACTIONS_VIEWED, entity: 'AuditLog', capture: ['query'] })
  async getMoneyActions(@Query() dto: GetAuditLogsDto, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.findMoneyActions(dto, viewer);
  }

  @Get('denied')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Denied and failed events, to spot probing' })
  @AuditEvent({ action: AuditEventEnum.AUDIT_DENIED_VIEWED, entity: 'AuditLog', capture: ['query'] })
  async getDenied(@Query() dto: GetAuditLogsDto, @CurrentUser() viewer: CurrentUserDto) {
    return this.auditLogService.findDenied(dto, viewer);
  }

  // ── 8. Statistics ────────────────────────────

  @Get('stats/overview')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Dashboard in one call' })
  async statsOverview(@Query() f: AuditStatsFilterDto) {
    return this.auditLogService.statsOverview(f);
  }

  @Get('stats/by-severity')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Severity breakdown for dashboard widgets' })
  async statsBySeverity(@Query() f: AuditStatsFilterDto) {
    return this.auditLogService.statsBySeverity(f);
  }

  @Get('stats/by-outcome')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Success, denied and failed' })
  async statsByOutcome(@Query() f: AuditStatsFilterDto) {
    return this.auditLogService.statsByOutcome(f);
  }

  @Get('stats/denied')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Denied and failed events over time, by path or action' })
  async statsDenied(@Query() f: DeniedStatsQueryDto) {
    return this.auditLogService.statsDenied(f);
  }

  @Get('stats/export-activity')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_EXPORT)
  @ApiOperation({ summary: 'Exports per admin over time, to spot unusual bulk exports' })
  async statsExportActivity(@Query() f: AuditBucketStatsQueryDto) {
    return this.auditLogService.statsExportActivity(f);
  }

  @Get('stats/by-entity')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Events per entity type' })
  async statsByEntity(@Query() f: AuditStatsFilterDto) {
    return this.auditLogService.statsByEntity(f);
  }

  @Get('stats/hourly')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'Events by hour of day and weekday (UTC), to spot out-of-hours activity',
  })
  async statsHourly(@Query() f: AuditStatsFilterDto) {
    return this.auditLogService.statsHourly(f);
  }

  @Get('stats/sensitive-access')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ_SENSITIVE)
  @ApiOperation({ summary: 'Sensitive reads per admin over time' })
  async statsSensitiveAccess(@Query() f: AuditBucketStatsQueryDto) {
    return this.auditLogService.statsSensitiveAccess(f);
  }

  // ── Row-level hold and per-record / per-user summaries ──

  @Get('entity/:entity/:entityId/summary')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Counts of actions on one record by type and actor' })
  @ApiParam({ name: 'entity', example: 'MissingPerson' })
  @ApiParam({ name: 'entityId' })
  async summarizeEntity(
    @Param('entity') entity: string,
    @Param('entityId') entityId: string,
    @Query() q: AuditSummaryQueryDto,
  ) {
    return this.auditLogService.summarizeEntity(entity, entityId, q);
  }

  @Get('user/:userId/summary')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'What one user did over a period, grouped by area' })
  @ApiParam({ name: 'userId', description: 'User ID' })
  async summarizeUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() q: AuditSummaryQueryDto,
  ) {
    return this.auditLogService.summarizeUser(userId, q);
  }

  @Patch(':id/legal-hold')
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_LEGAL_HOLD)
  @ApiOperation({
    summary: 'Set or clear the hold on one row, with a required reason',
    description:
      'Setting a hold needs only the permission. Clearing a hold needs a Super Admin, and a ' +
      'different Super Admin must repeat the request to approve it.',
  })
  @ApiParam({ name: 'id', description: 'Audit log ID' })
  async setRowLegalHold(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRowLegalHoldDto,
    @CurrentUser() actor: CurrentUserDto,
  ) {
    return this.auditLogService.setRowLegalHold(id, dto, actor);
  }

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
      'as=actor (default): things the user did. as=target: things done TO the user. ' +
      'as=both: either.',
  })
  @ApiParam({ name: 'userId', description: 'User ID' })
  @ApiQuery({ name: 'as', required: false, enum: ['actor', 'target', 'both'] })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @AuditEvent({ action: AuditEventEnum.AUDIT_USER_TRAIL_VIEWED, entity: 'User', entityId: { param: 'userId' }, targetUserParam: 'userId', capture: ['query'] })
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
  @AuditEvent({ action: AuditEventEnum.AUDIT_TARGET_TRAIL_VIEWED, entity: 'User', entityId: { param: 'targetUserId' }, targetUserParam: 'targetUserId', capture: ['query'] })
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
  @AuditEvent({ action: AuditEventEnum.AUDIT_SESSION_TRAIL_VIEWED, entity: 'Session', entityId: { param: 'sessionId' }, capture: ['query'] })
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
  @AuditEvent({ action: AuditEventEnum.AUDIT_REQUEST_TRAIL_VIEWED, entity: 'Request', entityId: { param: 'requestId' }, capture: ['query'] })
  async getAuditLogsForRequest(
    @Param('requestId') requestId: string,
    @Query() dto: AuditPagingDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.auditLogService.findByRequest(requestId, dto, viewer);
  }

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
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  MessageEvent,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  Sse,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { ActorType, NotificationType } from '@prisma/client';

import { NotificationService } from '../service/notification.service';

import {
  AllNotificationsQueryDto,
  BroadcastNotificationDto,
  BroadcastQueryDto,
  CreateNotificationDto,
  CreateNotificationTemplateDto,
  EventCategoriesQueryDto,
  EventsFeedQueryDto,
  FailedDeliveriesQueryDto,
  MarkBulkReadDto,
  NotificationQueryDto,
  NotificationSummaryQueryDto,
  UserNotificationEventsQueryDto,
  RegisterDeviceDto,
  RetryDeliveriesDto,
  SentNotificationsQueryDto,
  UpdateNotificationPreferencesDto,
  UpdateNotificationTemplateDto,
  // new endpoints
  AdminReasonDto,
  AllTimelineQueryDto,
  BouncesQueryDto,
  BroadcastRecipientsQueryDto,
  BulkNotificationIdsDto,
  ByRecipientQueryDto,
  ClearBounceDto,
  DeliveriesQueryDto,
  DeliveryTimelineQueryDto,
  MarkReadByTypeDto,
  NotificationExportJobDto,
  NotificationPagingDto,
  PreviewTemplateDto,
  QueuePauseDto,
  QueueResumeDto,
  RejectBroadcastDto,
  RetryAllFailedDeliveriesDto,
  SearchNotificationsQueryDto,
  SendTestNotificationDto,
  SnoozeDto,
  StatsRangeQueryDto,
  UpdateBroadcastDto,
  UpdateRetentionDto,
  UpdateTypePreferenceDto,
  UserDeliveriesQueryDto,
} from '../dto/notification.dto';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

// Notifications: literal routes (user, then admin) must stay above parameterised ':id' routes.
// Broadcast send/export/erase have own permissions; cancel stays on NOTIFICATION_MANAGE.
@Controller('notifications')
@ApiTags('Notifications')
@ApiBearerAuth('access-token')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  // ═════════════════════════════════════════════
  // 1. USER LITERAL ROUTES (any authenticated user, own rows only)
  // ═════════════════════════════════════════════

  @Get()
  @ApiOperation({ summary: 'Get my notifications' })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'entity', required: false })
  @ApiQuery({ name: 'isRead', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Cursor pagination (preferred)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getMyNotifications(
    @CurrentUser() user: CurrentUserDto,
    @Query() query: NotificationQueryDto,
  ) {
    return this.notificationService.getMyNotifications(user, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get my unread notification count' })
  async getMyUnreadCount(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyUnreadCount(user);
  }

  @Get('unread-count/by-type')
  @ApiOperation({ summary: 'Get my unread counts grouped by notification type (tab badges)' })
  async getMyUnreadCountByType(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyUnreadCountByType(user);
  }

  @Get('preferences')
  @ApiOperation({
    summary: 'Get my notification preferences',
    description:
      'Per-type channel settings and quiet hours. Security types (SECURITY_ALERT, ' +
      'PASSWORD_CHANGED, PASSWORD_RESET) are always on and reported as locked.',
  })
  async getMyPreferences(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyPreferences(user);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Update my notification preferences' })
  async updateMyPreferences(
    @Body() dto: UpdateNotificationPreferencesDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.updateMyPreferences(user, dto);
  }

  @Post('devices')
  @ApiOperation({ summary: 'Register or refresh a push device token' })
  async registerDevice(@Body() dto: RegisterDeviceDto, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.registerDevice(user, dto);
  }

  @Delete('devices/:token')
  @ApiOperation({ summary: 'Unregister a push device token (e.g. on logout)' })
  @ApiParam({ name: 'token', description: 'Push device token' })
  async unregisterDevice(@Param('token') token: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.unregisterDevice(user, token);
  }

  @Sse('stream')
  @ApiOperation({
    summary: 'Live notification stream (Server-Sent Events)',
    description: 'Emits new notifications and unread-count changes for the caller only.',
  })
  stream(@CurrentUser() user: CurrentUserDto): Observable<MessageEvent> {
    return this.notificationService.streamForUser(user);
  }

  @Get('entity/:entity/:entityId')
  @ApiOperation({ summary: 'Get my notifications about one record (e.g. Report + id)' })
  @ApiParam({ name: 'entity', example: 'Report' })
  @ApiParam({ name: 'entityId', description: 'Entity record ID' })
  async getMyNotificationsForEntity(
    @Param('entity') entity: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: CurrentUserDto,
    @Query() query: NotificationQueryDto,
  ) {
    return this.notificationService.getMyNotificationsForEntity(user, entity, entityId, query);
  }

  @Patch('bulk/read')
  @ApiOperation({ summary: 'Mark multiple of my notifications as read' })
  async markBulkAsRead(@Body() dto: MarkBulkReadDto, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markBulkAsRead(dto.ids, user);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all my notifications as read' })
  async markAllAsRead(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markAllAsRead(user);
  }

  // Must be declared before 'DELETE :id' or 'read' is treated as an id.
  @Delete('read')
  @ApiOperation({ summary: 'Delete all my already-read notifications' })
  async deleteAllRead(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.deleteAllMyRead(user);
  }

  // ─────────────────────────────────────────────
  // 1b. NEW USER ROUTES (NF-01 to NF-22), own notifications only.
  // All literal paths: they must stay above 'GET :id', 'DELETE :id' and 'PATCH :id/...'.
  // ─────────────────────────────────────────────

  @Get('types')
  @ApiOperation({
    summary: 'List notification types for a preferences screen',
    description: 'Each type with a locked flag (security types) and its default channels.',
  })
  getNotificationTypes() {
    return this.notificationService.getNotificationTypes();
  }

  @Patch('preferences/:type')
  @ApiOperation({ summary: 'Update the channels for one notification type' })
  @ApiParam({ name: 'type', enum: NotificationType })
  async updateMyTypePreference(
    @Param('type', new ParseEnumPipe(NotificationType)) type: NotificationType,
    @Body() dto: UpdateTypePreferenceDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.updateMyTypePreference(user, type, dto);
  }

  @Delete('preferences/:type')
  @ApiOperation({ summary: 'Reset one notification type to its defaults' })
  @ApiParam({ name: 'type', enum: NotificationType })
  async resetMyTypePreference(
    @Param('type', new ParseEnumPipe(NotificationType)) type: NotificationType,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.resetMyTypePreference(user, type);
  }

  @Delete('preferences')
  @ApiOperation({ summary: 'Reset all my preferences and quiet hours' })
  async resetAllMyPreferences(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.resetAllMyPreferences(user);
  }

  @Get('devices')
  @ApiOperation({ summary: 'List my push devices (tokens are masked)' })
  async listMyDevices(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.listMyDevices(user);
  }

  @Delete('devices')
  @ApiOperation({ summary: 'Unregister all my push devices' })
  async unregisterAllMyDevices(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.unregisterAllMyDevices(user);
  }

  @Get('snooze')
  @ApiOperation({ summary: 'Show my current snooze' })
  async getMySnooze(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMySnooze(user);
  }

  @Post('snooze')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mute non-security notifications for 1 hour to 7 days',
    description: 'Inbox copies are still created. Security notifications are never muted.',
  })
  async setMySnooze(@Body() dto: SnoozeDto, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.setMySnooze(user, dto);
  }

  @Delete('snooze')
  @ApiOperation({ summary: 'Cancel my snooze' })
  async cancelMySnooze(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.cancelMySnooze(user);
  }

  @Get('export')
  @ApiOperation({ summary: 'Download my own notifications as CSV (max 50,000 rows)' })
  async exportMyNotifications(
    @CurrentUser() user: CurrentUserDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { csv, truncated, rowCount } = await this.notificationService.exportMyNotificationsCsv(user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="my-notifications.csv"');
    res.setHeader('X-Export-Truncated', String(truncated));
    res.setHeader('X-Export-Row-Count', String(rowCount));
    return csv;
  }

  @Patch('bulk/unread')
  @ApiOperation({ summary: 'Mark multiple of my notifications as unread' })
  async markBulkAsUnread(@Body() dto: BulkNotificationIdsDto, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markBulkAsUnread(dto.ids, user);
  }

  @Delete('bulk')
  @ApiOperation({ summary: 'Delete multiple of my notifications by id' })
  async deleteMyBulk(@Body() dto: BulkNotificationIdsDto, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.deleteMyBulk(dto.ids, user);
  }

  @Patch('read-by-type')
  @ApiOperation({ summary: 'Mark all my notifications of one type as read' })
  async markAllOfTypeAsRead(@Body() dto: MarkReadByTypeDto, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markAllOfTypeAsRead(dto.type, user);
  }

  @Get('unread-count/by-priority')
  @ApiOperation({ summary: 'My unread count split by priority' })
  async getMyUnreadCountByPriority(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyUnreadCountByPriority(user);
  }

  @Get('counts')
  @ApiOperation({ summary: 'My total, read and unread counts in one call' })
  async getMyCounts(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyCounts(user);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search my notifications' })
  @ApiQuery({ name: 'q', required: true })
  async searchMyNotifications(
    @Query() query: SearchNotificationsQueryDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.searchMyNotifications(user, query);
  }

  @Get('muted')
  @ApiOperation({ summary: 'List the records I have muted' })
  async listMyMutedRecords(
    @Query() query: NotificationPagingDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.listMyMutedRecords(user, query);
  }

  @Get('entity/:entity/:entityId/unread-count')
  @ApiOperation({ summary: 'My unread count about one record' })
  @ApiParam({ name: 'entity', example: 'Report' })
  @ApiParam({ name: 'entityId' })
  async getMyUnreadCountForEntity(
    @Param('entity') entity: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.getMyUnreadCountForEntity(user, entity, entityId);
  }

  @Patch('entity/:entity/:entityId/read')
  @ApiOperation({ summary: 'Mark everything about one record as read (e.g. when a report is opened)' })
  @ApiParam({ name: 'entity', example: 'Report' })
  @ApiParam({ name: 'entityId' })
  async markEntityAsRead(
    @Param('entity') entity: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.markEntityAsRead(user, entity, entityId);
  }

  @Patch('entity/:entity/:entityId/mute')
  @ApiOperation({
    summary: 'Mute updates about one record',
    description: 'One mute system for every record type. Security notifications are never muted.',
  })
  @ApiParam({ name: 'entity', example: 'Report' })
  @ApiParam({ name: 'entityId' })
  async muteEntity(
    @Param('entity') entity: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.muteEntity(user, entity, entityId);
  }

  @Patch('entity/:entity/:entityId/unmute')
  @ApiOperation({ summary: 'Unmute updates about one record' })
  @ApiParam({ name: 'entity', example: 'Report' })
  @ApiParam({ name: 'entityId' })
  async unmuteEntity(
    @Param('entity') entity: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.unmuteEntity(user, entity, entityId);
  }

  // ═════════════════════════════════════════════
  // 2. ADMIN LITERAL ROUTES (ADMIN / SUPER_ADMIN)
  // ═════════════════════════════════════════════

  /**
   * POST /notifications/admin
   * Send to ONE user (userId) or to admins (audience: ADMINS).
   * Exactly one of the two. Each recipient gets their own notification row.
   *
   * ALL_USERS is NOT accepted here — use POST /notifications/admin/broadcast,
   * which needs NOTIFICATION_BROADCAST_SEND. The service must reject it.
   *
   * Idempotency-Key: a retry with the same key returns the original result
   * instead of sending twice.
   */
  @Post('admin')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: send a notification to one user or to admins' })
  async createNotification(
    @Body() dto: CreateNotificationDto,
    @CurrentUser() user: CurrentUserDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.notificationService.createFromAdmin(dto, user, idempotencyKey);
  }

  /**
   * POST /notifications/admin/broadcast
   * Audience sends (ALL_USERS / ADMINS), optional template, optional
   * scheduledAt, and dryRun (returns the audience size without sending).
   * Creates a broadcast record; recipients are processed by the queue.
   */
  @Post('admin/broadcast')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_BROADCAST_SEND)
  @ApiOperation({
    summary: 'Admin: broadcast to an audience (supports scheduling and dry-run)',
  })
  async broadcast(
    @Body() dto: BroadcastNotificationDto,
    @CurrentUser() user: CurrentUserDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.notificationService.broadcast(dto, user, idempotencyKey);
  }

  @Get('admin/list')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Admin: my notifications (same data as GET /notifications)' })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'entity', required: false })
  @ApiQuery({ name: 'isRead', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getAdminNotifications(
    @CurrentUser() user: CurrentUserDto,
    @Query() query: NotificationQueryDto,
  ) {
    return this.notificationService.getMyNotifications(user, query);
  }

  @Get('admin/unread-count')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Admin: my unread count (same as GET /notifications/unread-count)' })
  async getAdminUnreadCount(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyUnreadCount(user);
  }

  @Get('admin/sent')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({
    summary: 'Admin: notifications I sent',
    description: 'Filtered by actorId = caller. SUPER_ADMIN may pass actorId to see anyone.',
  })
  async getSent(@CurrentUser() user: CurrentUserDto, @Query() query: SentNotificationsQueryDto) {
    return this.notificationService.getSentByAdmin(user, query);
  }

  @Get('admin/all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Admin: every notification emitted by the system',
    description:
      'Not limited to the caller. Filter by recipientId, actorId, type, priority, entity, ' +
      'entityId, isRead and a from/to date range. Newest first.',
  })
  async getAllNotifications(@Query() query: AllNotificationsQueryDto) {
    return this.notificationService.getAllNotifications(query);
  }

  @Get('admin/unread-count/by-type')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Admin: my unread counts grouped by type (dashboard tab badges)' })
  async getAdminUnreadCountByType(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyUnreadCountByType(user);
  }

  @Sse('admin/stream')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Admin: live feed of new notifications across the company (Server-Sent Events)',
    description:
      'Emits a small event whenever notifications are created. Re-query GET /notifications/admin/all ' +
      'to load them. Per process: with several instances this needs Redis pub/sub.',
  })
  adminStream(): Observable<MessageEvent> {
    return this.notificationService.streamAllEvents();
  }

  @Get('admin/all/summary')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Admin: company-wide notification overview',
    description:
      'Totals, read and unread, system versus user caused, counts by type, priority and ' +
      'entity, and the ten most active actors. Default window is 30 days, maximum 90.',
  })
  async getAllNotificationsSummary(@Query() query: NotificationSummaryQueryDto) {
    return this.notificationService.getNotificationSummary(query);
  }

  @Get('admin/all/export')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_USER_DATA_EXPORT)
  @ApiOperation({
    summary: 'Super admin: export every notification matching the filters as CSV',
    description:
      'Same filters as GET /notifications/admin/all. Audited. Capped at 50,000 rows; ' +
      'the X-Export-Truncated header says whether the cap was hit.',
  })
  async exportAllNotifications(
    @Query() query: AllNotificationsQueryDto,
    @CurrentUser() admin: CurrentUserDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { csv, truncated, rowCount } = await this.notificationService.exportAllNotificationsCsv(
      query,
      admin,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="notifications.csv"');
    res.setHeader('X-Export-Truncated', String(truncated));
    res.setHeader('X-Export-Row-Count', String(rowCount));
    return csv;
  }

  @Get('admin/stats')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({
    summary: 'Admin: delivery health',
    description:
      'Delivery success rate per channel, queue depth, failed sends and scheduled broadcasts.',
  })
  async getAdminStats() {
    return this.notificationService.getDeliveryStats();
  }

  @Get('admin/broadcasts')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Admin: list broadcasts (mine; SUPER_ADMIN sees all)' })
  async listBroadcasts(@CurrentUser() user: CurrentUserDto, @Query() query: BroadcastQueryDto) {
    return this.notificationService.listBroadcasts(user, query);
  }

  @Get('admin/failed-deliveries')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: notifications that failed to deliver on a channel' })
  async getFailedDeliveries(@Query() query: FailedDeliveriesQueryDto) {
    return this.notificationService.getFailedDeliveries(query);
  }

  @Post('admin/failed-deliveries/retry')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: retry failed deliveries (by delivery ids)' })
  async retryFailedDeliveries(
    @Body() dto: RetryDeliveriesDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.retryDeliveries(dto.ids, user);
  }

  @Get('admin/templates')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Admin: list notification templates (per type and language)' })
  async listTemplates() {
    return this.notificationService.listTemplates();
  }

  @Post('admin/templates')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: create a notification template' })
  async createTemplate(
    @Body() dto: CreateNotificationTemplateDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.createTemplate(dto, user);
  }

  @Patch('admin/templates/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: update a notification template' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateNotificationTemplateDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.updateTemplate(id, dto, user);
  }

  @Get('admin/broadcasts/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({
    summary: 'Admin: one broadcast with delivery stats',
    description: 'Recipients reached, delivered, failed, read and unread counts.',
  })
  @ApiParam({ name: 'id', description: 'Broadcast ID' })
  async getBroadcast(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getBroadcast(id, user);
  }

  /**
   * DELETE /notifications/admin/broadcasts/:id
   * Cancelling only reduces blast radius, so it stays under
   * NOTIFICATION_MANAGE rather than NOTIFICATION_BROADCAST_SEND. The service
   * must still enforce ownership (SUPER_ADMIN may cancel any broadcast).
   */
  @Delete('admin/broadcasts/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Admin: cancel a scheduled broadcast',
    description: 'Only broadcasts that have not started sending can be cancelled.',
  })
  @ApiParam({ name: 'id', description: 'Broadcast ID' })
  async cancelBroadcast(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.cancelBroadcast(id, user);
  }

  // ─────────────────────────────────────────────
  // NEW company-wide routes (NF-50 to NF-57). Above 'admin/all/:id' so these words are not read as ids.
  // ─────────────────────────────────────────────

  @Get('admin/all/by-recipient')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Admin: one row per user (total, read, unread, failed deliveries, last notification)',
  })
  async getAllByRecipient(@Query() query: ByRecipientQueryDto) {
    return this.notificationService.getAllByRecipient(query);
  }

  @Get('admin/all/timeline')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: notifications emitted per day, week or month' })
  async getAllTimeline(@Query() query: AllTimelineQueryDto) {
    return this.notificationService.getAllTimeline(query);
  }

  @Get('admin/all/read-rate')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: read rate and median time to read, by type' })
  async getAllReadRate(@Query() query: StatsRangeQueryDto) {
    return this.notificationService.getAllReadRate(query);
  }

  @Get('admin/all/search')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: search across all notifications (same filters as admin/all)' })
  @ApiQuery({ name: 'q', required: true })
  async searchAllNotifications(@Query() query: AllNotificationsQueryDto) {
    return this.notificationService.searchAllNotifications(query);
  }

  @Post('admin/all/export-jobs')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_USER_DATA_EXPORT)
  @HttpCode(202)
  @ApiOperation({
    summary: 'Super admin: start a background export beyond the 50,000-row CSV cap',
    description: 'Same filters as GET /notifications/admin/all (pass them in the body). Audited.',
  })
  async startAllExportJob(@Body() dto: NotificationExportJobDto, @CurrentUser() admin: CurrentUserDto) {
    return this.notificationService.startAllExportJob(dto, admin);
  }

  @Get('admin/all/export-jobs')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Super admin: my export jobs' })
  async listAllExportJobs(@Query() query: NotificationPagingDto, @CurrentUser() admin: CurrentUserDto) {
    return this.notificationService.listAllExportJobs(admin, query);
  }

  @Get('admin/all/export-jobs/:id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Super admin: export job progress' })
  @ApiParam({ name: 'id', description: 'Export job ID' })
  async getAllExportJob(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: CurrentUserDto) {
    return this.notificationService.getAllExportJob(id, admin);
  }

  @Get('admin/all/export-jobs/:id/download')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Super admin: short-lived download links for a finished export (audited)',
    description: 'Links work for 5 minutes. Ask again for fresh ones.',
  })
  @ApiParam({ name: 'id', description: 'Export job ID' })
  async downloadAllExportJob(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: CurrentUserDto) {
    return this.notificationService.getAllExportJobDownload(id, admin);
  }

  @Get('admin/all/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Admin: any notification by id, with delivery results per channel',
    description: 'Not limited to the caller. Use it to answer "did this user get it".',
  })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async getAnyNotification(@Param('id') id: string) {
    return this.notificationService.getAnyNotificationById(id);
  }

  @Get('admin/events/categories')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'Admin: event counts by who caused them (user, admin, super admin, system)',
    description: 'Audit events and notifications per category. Default 30 days, maximum 90.',
  })
  async getEventCategories(@Query() query: EventCategoriesQueryDto) {
    return this.notificationService.getEventCategories(query);
  }

  @Get('admin/events/users')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({
    summary: 'Admin: events performed by regular users',
    description: 'Audit-log feed. Supports every audit filter (action, entity, userId, dates, q).',
  })
  async getUserEventsFeed(@Query() query: EventsFeedQueryDto, @CurrentUser() viewer: CurrentUserDto) {
    return this.notificationService.getEventsByActorType(ActorType.USER, query, viewer);
  }

  @Get('admin/events/admins')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Admin: events performed by admins' })
  async getAdminEventsFeed(
    @Query() query: EventsFeedQueryDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.notificationService.getEventsByActorType(ActorType.ADMIN, query, viewer);
  }

  @Get('admin/events/super-admins')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Super admin: events performed by super admins' })
  async getSuperAdminEventsFeed(
    @Query() query: EventsFeedQueryDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.notificationService.getEventsByActorType(ActorType.SUPER_ADMIN, query, viewer);
  }

  @Get('admin/events/system')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Admin: events performed by the system (jobs, automation)' })
  async getSystemEventsFeed(
    @Query() query: EventsFeedQueryDto,
    @CurrentUser() viewer: CurrentUserDto,
  ) {
    return this.notificationService.getEventsByActorType(ActorType.SYSTEM, query, viewer);
  }

  @Get('admin/user/:userId/settings')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Admin: one user notification preferences, devices and unread count',
    description: 'For delivery support. Device tokens are shortened to their last 6 characters.',
  })
  @ApiParam({ name: 'userId', description: 'User ID' })
  async getUserSettings(@Param('userId') userId: string) {
    return this.notificationService.getUserNotificationSettings(userId);
  }

  @Get('admin/user/:userId/events')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Admin: events one user caused and notifications sent to them',
    description:
      'direction = caused | received | both (default). Same filters, search and sorting as ' +
      'GET /notifications/admin/all. For every action the user took, including ones that raise no ' +
      'notification, use GET /audit-logs/user/:userId.',
  })
  @ApiParam({ name: 'userId', description: 'User ID' })
  async getUserEvents(
    @Param('userId') userId: string,
    @Query() query: UserNotificationEventsQueryDto,
  ) {
    return this.notificationService.getUserNotificationEvents(userId, query);
  }

  // Data-subject requests (SUPER_ADMIN only): export or erase one user's
  // notifications. Both are audited by the service and each has its own
  // dedicated permission.

  @Get('admin/user/:userId/export')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_USER_DATA_EXPORT)
  @ApiOperation({ summary: 'Super admin: export all notifications of one user' })
  @ApiParam({ name: 'userId', description: 'User ID' })
  async exportUserNotifications(
    @Param('userId') userId: string,
    @CurrentUser() admin: CurrentUserDto,
  ) {
    return this.notificationService.exportForUser(userId, admin);
  }

  @Delete('admin/user/:userId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_USER_DATA_ERASE)
  @ApiOperation({ summary: 'Super admin: erase all notifications of one user' })
  @ApiParam({ name: 'userId', description: 'User ID' })
  async eraseUserNotifications(
    @Param('userId') userId: string,
    @CurrentUser() admin: CurrentUserDto,
  ) {
    return this.notificationService.eraseForUser(userId, admin);
  }

  @Patch('admin/bulk/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: mark multiple of my notifications as read' })
  async markBulkAdminNotificationsAsRead(
    @Body() dto: MarkBulkReadDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.markBulkAsRead(dto.ids, user);
  }

  @Patch('admin/read-all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: mark all my notifications as read' })
  async markAllAdminNotificationsAsRead(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markAllAsRead(user);
  }

  // ─────────────────────────────────────────────
  // NEW ADMIN ROUTES (NF-23 to NF-49, NF-58 to NF-63).
  // All literal paths: they sit above the admin ':id' routes below on purpose.
  // ─────────────────────────────────────────────

  // ── Templates and broadcasts ─────────────────

  @Get('admin/types')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Admin: which types have a template in each language' })
  getTemplateCoverage() {
    return this.notificationService.getTemplateCoverage();
  }

  @Post('admin/templates/preview')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @HttpCode(200)
  @ApiOperation({ summary: 'Admin: render a template (or loose text) with sample variables. Sends nothing.' })
  async previewTemplate(@Body() dto: PreviewTemplateDto) {
    return this.notificationService.previewTemplate(dto);
  }

  @Get('admin/templates/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Admin: one template' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  async getTemplate(@Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.getTemplate(id);
  }

  @Delete('admin/templates/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: retire a template (soft: nothing is deleted)' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  async retireTemplate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.retireTemplate(id, user);
  }

  @Patch('admin/templates/:id/activate')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: bring a retired template back' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  async activateTemplate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.activateTemplate(id, user);
  }

  @Post('admin/broadcasts/:id/retry')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_BROADCAST_SEND)
  @HttpCode(200)
  @ApiOperation({ summary: 'Admin: requeue a failed or partly failed broadcast' })
  @ApiParam({ name: 'id', description: 'Broadcast ID' })
  async retryBroadcast(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.retryBroadcast(id, user);
  }

  @Patch('admin/broadcasts/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_BROADCAST_SEND)
  @ApiOperation({
    summary: 'Admin: edit a broadcast before it starts',
    description: 'Changing the content of an approved broadcast sends it back for approval.',
  })
  @ApiParam({ name: 'id', description: 'Broadcast ID' })
  async updateBroadcast(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBroadcastDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.updateBroadcast(id, dto, user);
  }

  @Get('admin/broadcasts/:id/recipients')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Admin: broadcast recipients with delivery and read state' })
  @ApiParam({ name: 'id', description: 'Broadcast ID' })
  async getBroadcastRecipients(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: BroadcastRecipientsQueryDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.getBroadcastRecipients(id, user, query);
  }

  @Post('admin/broadcasts/:id/approve')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_BROADCAST_APPROVE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Admin: a second person approves a large broadcast',
    description: 'The person who created the broadcast cannot approve it.',
  })
  @ApiParam({ name: 'id', description: 'Broadcast ID' })
  async approveBroadcast(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.approveBroadcast(id, user);
  }

  @Post('admin/broadcasts/:id/reject')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_BROADCAST_APPROVE)
  @HttpCode(200)
  @ApiOperation({ summary: 'Admin: reject a broadcast that is awaiting approval (reason required)' })
  @ApiParam({ name: 'id', description: 'Broadcast ID' })
  async rejectBroadcast(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectBroadcastDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.rejectBroadcast(id, dto, user);
  }

  @Post('admin/broadcasts/:id/stop')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Admin: halt a broadcast that is already sending',
    description: 'Cancel only works before a broadcast starts. Inbox copies already created are kept.',
  })
  @ApiParam({ name: 'id', description: 'Broadcast ID' })
  async stopBroadcast(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.stopBroadcast(id, user);
  }

  @Post('admin/test')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @HttpCode(200)
  @ApiOperation({ summary: 'Admin: send myself a test on a chosen channel' })
  async sendTest(@Body() dto: SendTestNotificationDto, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.sendTestToSelf(dto, user);
  }

  // ── Delivery and bounces ─────────────────────

  @Post('admin/failed-deliveries/retry-all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @HttpCode(200)
  @ApiOperation({ summary: 'Admin: retry every failed delivery that matches a filter' })
  async retryAllFailedDeliveries(
    @Body() dto: RetryAllFailedDeliveriesDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.retryAllFailedDeliveries(dto, user);
  }

  @Get('admin/deliveries')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: all deliveries, filtered by channel, status and date' })
  async listDeliveries(@Query() query: DeliveriesQueryDto) {
    return this.notificationService.listDeliveries(query);
  }

  @Get('admin/deliveries/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: one delivery with the provider response' })
  @ApiParam({ name: 'id', description: 'Delivery ID' })
  async getDelivery(@Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.getDelivery(id);
  }

  @Get('admin/stats/timeline')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Admin: delivery successes and failures over time' })
  async getDeliveryTimeline(@Query() query: DeliveryTimelineQueryDto) {
    return this.notificationService.getDeliveryTimeline(query);
  }

  @Get('admin/stats/by-type')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Admin: sent, delivered and read per type' })
  async getStatsByType(@Query() query: StatsRangeQueryDto) {
    return this.notificationService.getStatsByType(query);
  }

  @Get('admin/bounces')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: bounced or blocked addresses and numbers (masked), with reason' })
  async listBounces(@Query() query: BouncesQueryDto) {
    return this.notificationService.listBounces(query);
  }

  @Post('admin/bounces/:id/clear')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @HttpCode(200)
  @ApiOperation({ summary: 'Admin: clear a bounce after the user fixed their contact details' })
  @ApiParam({ name: 'id', description: 'Bounce ID' })
  async clearBounce(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClearBounceDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.clearBounce(id, dto, user);
  }

  // ── Per-user support ─────────────────────────

  @Delete('admin/user/:userId/devices')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_DEVICE_REVOKE)
  @ApiOperation({ summary: "Super admin: revoke a compromised user's push tokens" })
  @ApiParam({ name: 'userId', description: 'User ID' })
  async revokeUserDevices(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdminReasonDto,
    @CurrentUser() admin: CurrentUserDto,
  ) {
    return this.notificationService.revokeUserDevices(userId, dto, admin);
  }

  @Patch('admin/user/:userId/preferences/reset')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: "Admin: reset a user's preferences on a support request" })
  @ApiParam({ name: 'userId', description: 'User ID' })
  async resetUserPreferences(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdminReasonDto,
    @CurrentUser() admin: CurrentUserDto,
  ) {
    return this.notificationService.resetUserPreferences(userId, dto, admin);
  }

  @Get('admin/user/:userId/deliveries')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: delivery log for one user across all notifications' })
  @ApiParam({ name: 'userId', description: 'User ID' })
  async getUserDeliveries(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: UserDeliveriesQueryDto,
  ) {
    return this.notificationService.getUserDeliveries(userId, query);
  }

  // ── Admin inbox (mirrors NF-12 to NF-16; role check only) ──

  @Patch('admin/bulk/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: mark multiple of my notifications as unread' })
  async markBulkAdminAsUnread(@Body() dto: BulkNotificationIdsDto, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markBulkAsUnread(dto.ids, user);
  }

  @Get('admin/counts')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: my total, read and unread counts' })
  async getAdminCounts(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyCounts(user);
  }

  @Patch('admin/read-by-type')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: mark all of one type as read' })
  async markAdminAllOfTypeAsRead(@Body() dto: MarkReadByTypeDto, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markAllOfTypeAsRead(dto.type, user);
  }

  @Delete('admin/bulk')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: delete multiple of my notifications' })
  async deleteAdminBulk(@Body() dto: BulkNotificationIdsDto, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.deleteMyBulk(dto.ids, user);
  }

  @Delete('admin/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: delete all my read notifications' })
  async deleteAdminAllRead(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.deleteAllMyRead(user);
  }

  // ── Governance and queue (super admin) ───────

  @Post('admin/maintenance/purge-expired')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MAINTAIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Super admin: run the expired-notification cleanup now' })
  async purgeExpiredNow(@Body() dto: AdminReasonDto, @CurrentUser() admin: CurrentUserDto) {
    return this.notificationService.purgeExpiredNow(dto, admin);
  }

  @Get('admin/retention')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Super admin: how long notifications are kept' })
  async getRetention() {
    return this.notificationService.getRetention();
  }

  @Patch('admin/retention')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MAINTAIN)
  @ApiOperation({ summary: 'Super admin: change retention (audited)' })
  async updateRetention(@Body() dto: UpdateRetentionDto, @CurrentUser() admin: CurrentUserDto) {
    return this.notificationService.updateRetention(dto, admin);
  }

  @Get('admin/queue')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Super admin: queue depth, rate and paused state per channel' })
  async getQueueState() {
    return this.notificationService.getQueueState();
  }

  @Post('admin/queue/pause')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MAINTAIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Super admin: pause a channel during a provider outage (reason required)' })
  async pauseQueueChannel(@Body() dto: QueuePauseDto, @CurrentUser() admin: CurrentUserDto) {
    return this.notificationService.pauseQueueChannel(dto, admin);
  }

  @Post('admin/queue/resume')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MAINTAIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Super admin: resume a paused channel' })
  async resumeQueueChannel(@Body() dto: QueueResumeDto, @CurrentUser() admin: CurrentUserDto) {
    return this.notificationService.resumeQueueChannel(dto, admin);
  }

  // ═════════════════════════════════════════════
  // 3. ADMIN PARAMETERISED ROUTES
  // ═════════════════════════════════════════════

  @Get('admin/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Admin: get one of my notifications (full event detail)' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async getAdminNotificationById(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyNotificationById(id, user);
  }

  @Patch('admin/:id/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: mark one of my notifications as read' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async markAdminNotificationAsRead(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markOneAsRead(id, user);
  }

  @Patch('admin/:id/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: mark one of my notifications as unread' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async markAdminNotificationAsUnread(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.notificationService.markOneAsUnread(id, user);
  }

  @Delete('admin/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Admin: delete one of my notifications' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async deleteAdminNotification(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.deleteMyNotification(id, user);
  }

  // ═════════════════════════════════════════════
  // 4. USER PARAMETERISED ROUTES (declared last on purpose)
  // ═════════════════════════════════════════════

  @Get(':id')
  @ApiOperation({
    summary: 'Get one of my notifications (full event detail)',
    description:
      'Returns the notification plus who caused it (actor name and role, or ' +
      'isSystemGenerated), what it is about, and when it happened.',
  })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async getMyNotificationById(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyNotificationById(id, user);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one of my notifications as read' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async markOneAsRead(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markOneAsRead(id, user);
  }

  @Patch(':id/unread')
  @ApiOperation({ summary: 'Mark one of my notifications as unread again' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async markOneAsUnread(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markOneAsUnread(id, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete one of my notifications' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async deleteMyNotification(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.deleteMyNotification(id, user);
  }

  @Get(':id/deliveries')
  @ApiOperation({
    summary: 'Which channels reached me for one notification',
    description: 'Shows sent, pending or not sent per channel. Internal errors are never shown.',
  })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async getMyNotificationDeliveries(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyNotificationDeliveries(id, user);
  }
}

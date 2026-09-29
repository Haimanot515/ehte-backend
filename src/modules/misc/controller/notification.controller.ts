import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  MessageEvent,
  Param,
  Patch,
  Post,
  Query,
  Res,
  Sse,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { ActorType } from '@prisma/client';

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
}
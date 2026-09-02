import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { NotificationService } from '../service/notification.service';

import {
  CreateNotificationDto,
  MarkBulkReadDto,
  NotificationQueryDto,
} from '../dto/notification.dto';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';

import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';

import { RolesEnum } from 'src/common/enums/roles.enum';

@Controller('notifications')
@ApiTags('Notifications')
@ApiBearerAuth('access-token')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  // ─────────────────────────────────────────────
  // USER — LIST
  // GET /notifications
  // AUTHENTICATED USER
  // ─────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Get my notifications',
  })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'isRead', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getMyNotifications(
    @CurrentUser() user: CurrentUserDto,
    @Query() query: NotificationQueryDto,
  ) {
    return this.notificationService.getMyNotifications(user, query);
  }

  // ─────────────────────────────────────────────
  // USER — UNREAD COUNT
  // GET /notifications/unread-count
  // AUTHENTICATED USER
  // ─────────────────────────────────────────────

  @Get('unread-count')
  @ApiOperation({
    summary: 'Get my unread notification count',
  })
  async getMyUnreadCount(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyUnreadCount(user);
  }

  // ─────────────────────────────────────────────
  // USER — MARK BULK AS READ
  // PATCH /notifications/bulk/read
  //
  // Registered before ':id/read' — NestJS matches
  // routes in declaration order, and ':id/read'
  // would otherwise swallow this path (id = 'bulk').
  //
  // AUTHENTICATED USER
  // ─────────────────────────────────────────────

  @Patch('bulk/read')
  @ApiOperation({
    summary: 'Mark multiple notifications as read',
  })
  async markBulkAsRead(@Body() dto: MarkBulkReadDto, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markBulkAsRead(dto.ids, user);
  }

  // ─────────────────────────────────────────────
  // USER — MARK ALL AS READ
  // PATCH /notifications/read-all
  //
  // Registered before ':id/read' for the same
  // route-ordering reason as above.
  //
  // AUTHENTICATED USER
  // ─────────────────────────────────────────────

  @Patch('read-all')
  @ApiOperation({
    summary: 'Mark all my notifications as read',
  })
  async markAllAsRead(@CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markAllAsRead(user);
  }

  // ─────────────────────────────────────────────
  // ADMIN — CREATE
  // POST /notifications/admin
  //
  // Omit userId to broadcast to everyone, or set it
  // to target a single user.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Post('admin')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin: create a notification (targeted or broadcast)',
  })
  async createNotification(@Body() dto: CreateNotificationDto) {
    return this.notificationService.create(dto);
  }

  // ─────────────────────────────────────────────
  // ADMIN — LIST
  // GET /notifications/admin/list
  //
  // NOTE: returns broadcast notifications (userId =
  // null) — the same rows a regular user would see
  // via GET /notifications. There is no schema-level
  // separation between "admin" and "everyone"
  // notifications; access here is restricted only at
  // the route level via @Roles().
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get('admin/list')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin: get broadcast notifications',
  })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'isRead', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getAdminNotifications(@Query() query: NotificationQueryDto) {
    return this.notificationService.getAdminNotifications(query);
  }

  // ─────────────────────────────────────────────
  // ADMIN — UNREAD COUNT
  // GET /notifications/admin/unread-count
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get('admin/unread-count')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin: get unread broadcast notification count',
  })
  async getAdminUnreadCount() {
    return this.notificationService.getAdminUnreadCount();
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ONE
  // GET /notifications/admin/:id
  //
  // Registered before 'admin/:id/read' so this literal
  // shape isn't ambiguous — NestJS distinguishes these
  // fine since they have different segment counts, but
  // kept here in admin-list order for readability.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get('admin/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin: get one broadcast notification',
  })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async getAdminNotificationById(@Param('id') id: string) {
    return this.notificationService.getAdminNotificationById(id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — MARK ONE AS READ
  // PATCH /notifications/admin/:id/read
  //
  // NOTE: marks the shared broadcast row as read —
  // this affects what every other viewer (including
  // regular users) sees for this notification, since
  // there is no per-user read table in the current
  // schema.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Patch('admin/:id/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin: mark broadcast notification as read',
  })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async markAdminNotificationAsRead(@Param('id') id: string) {
    return this.notificationService.markAdminNotificationAsRead(id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — MARK BULK AS READ
  // PATCH /notifications/admin/bulk/read
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Patch('admin/bulk/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin: mark multiple broadcast notifications as read',
  })
  async markBulkAdminNotificationsAsRead(@Body() dto: MarkBulkReadDto) {
    return this.notificationService.markBulkAdminNotificationsAsRead(dto.ids);
  }

  // ─────────────────────────────────────────────
  // ADMIN — MARK ALL AS READ
  // PATCH /notifications/admin/read-all
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Patch('admin/read-all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin: mark all broadcast notifications as read',
  })
  async markAllAdminNotificationsAsRead() {
    return this.notificationService.markAllAdminNotificationsAsRead();
  }

  // ─────────────────────────────────────────────
  // ADMIN — DELETE
  // DELETE /notifications/admin/:id
  //
  // NOTE: deletes the shared broadcast row entirely
  // for all users, since there is no per-user
  // dismissal table in the current schema.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Delete('admin/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin: delete a broadcast notification',
  })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async deleteAdminNotification(@Param('id') id: string) {
    return this.notificationService.deleteAdminNotification(id);
  }

  // ─────────────────────────────────────────────
  // USER — GET ONE
  // GET /notifications/:id
  //
  // Declared last: ':id' is a single dynamic
  // segment. All routes above use more than one
  // path segment (e.g. admin/list), so there's no
  // actual collision, but this is kept last to be
  // explicit and safe.
  //
  // AUTHENTICATED USER
  // ─────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({
    summary: 'Get one of my notifications',
  })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async getMyNotificationById(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.getMyNotificationById(id, user);
  }

  // ─────────────────────────────────────────────
  // USER — MARK ONE AS READ
  // PATCH /notifications/:id/read
  //
  // Declared last for the same reason as above.
  //
  // AUTHENTICATED USER
  // ─────────────────────────────────────────────

  @Patch(':id/read')
  @ApiOperation({
    summary: 'Mark notification as read',
  })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async markOneAsRead(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.markOneAsRead(id, user);
  }

  // ─────────────────────────────────────────────
  // USER — DELETE / DISMISS
  // DELETE /notifications/:id
  //
  // Declared last for the same reason as above.
  //
  // AUTHENTICATED USER
  // ─────────────────────────────────────────────

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete/dismiss one of my notifications',
  })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  async deleteMyNotification(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.notificationService.deleteMyNotification(id, user);
  }
}

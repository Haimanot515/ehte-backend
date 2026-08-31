import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';

import {
  CreateNotificationDto,
  NotificationQueryDto,
} from '../dto/notification.dto';

import {
  CurrentUserDto,
} from 'src/common/dtos/current-user.dto';

@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Create a notification.
   *
   * userId = null means broadcast notification.
   */
  async create(
    dto: CreateNotificationDto,
  ) {
    return this.prisma.notification.create({
      data: {
        userId: dto.userId ?? null,
        type: dto.type,
        title: dto.title,
        body: dto.body,
      },
    });
  }

  /**
   * Get personal notifications + broadcasts, with
   * optional filtering and pagination.
   */
  async getMyNotifications(
    user: CurrentUserDto,
    query: NotificationQueryDto = {},
  ) {
    const { type, isRead, page = 1, limit = 20 } = query;

    const where = {
      OR: [
        { userId: user.id },
        { userId: null },
      ],
      ...(type && { type }),
      ...(isRead !== undefined && { isRead }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { data, meta: { total, page, limit } };
  }

  /**
   * Get a single notification (personal or broadcast).
   */
  async getMyNotificationById(
    id: string,
    user: CurrentUserDto,
  ) {
    const notification = await this.prisma.notification.findFirst({
      where: {
        id,
        OR: [
          { userId: user.id },
          { userId: null },
        ],
      },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    return notification;
  }

  /**
   * Count unread personal + broadcast notifications.
   *
   * NOTE: isRead lives directly on the Notification row.
   * For broadcasts (userId = null) this means read-state
   * is shared across every user who receives that
   * broadcast — one user marking it read marks it read
   * for everyone. This is a known limitation of the
   * current schema (no per-user read table); flagging it
   * here rather than fixing it since that requires a
   * schema change.
   */
  async getMyUnreadCount(
    user: CurrentUserDto,
  ) {
    const count = await this.prisma.notification.count({
      where: {
        OR: [
          { userId: user.id },
          { userId: null },
        ],
        isRead: false,
      },
    });

    return { count };
  }

  /**
   * Mark one notification as read.
   *
   * A user can only mark their own notification
   * or a broadcast notification as read.
   */
  async markOneAsRead(
    id: string,
    user: CurrentUserDto,
  ) {
    const result = await this.prisma.notification.updateMany({
      where: {
        id,

        OR: [
          {
            userId: user.id,
          },
          {
            userId: null,
          },
        ],
      },

      data: {
        isRead: true,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Notification not found');
    }

    return result;
  }

  /**
   * Mark multiple notifications as read.
   */
  async markBulkAsRead(
    ids: string[],
    user: CurrentUserDto,
  ) {
    return this.prisma.notification.updateMany({
      where: {
        id: {
          in: ids,
        },

        OR: [
          {
            userId: user.id,
          },
          {
            userId: null,
          },
        ],
      },

      data: {
        isRead: true,
      },
    });
  }

  /**
   * Mark ALL of my notifications (personal + broadcast)
   * as read, without needing the client to list IDs.
   */
  async markAllAsRead(
    user: CurrentUserDto,
  ) {
    return this.prisma.notification.updateMany({
      where: {
        OR: [
          { userId: user.id },
          { userId: null },
        ],
        isRead: false,
      },
      data: { isRead: true },
    });
  }

  /**
   * Delete/dismiss a notification.
   *
   * NOTE: for broadcasts (userId = null), this deletes
   * the row for ALL users, since there's no per-user
   * dismissal table in the current schema. Flagging this
   * as a limitation rather than a bug — fixing it would
   * require a schema change.
   */
  async deleteMyNotification(
    id: string,
    user: CurrentUserDto,
  ) {
    const notification = await this.prisma.notification.findFirst({
      where: {
        id,
        OR: [
          { userId: user.id },
          { userId: null },
        ],
      },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    await this.prisma.notification.delete({ where: { id } });
    return { id, deleted: true };
  }

  // ─────────────────────────────────────────────
  // ADMIN-FACING
  //
  // NOTE: the current schema has no recipient/role
  // concept — there's only userId (personal) and
  // userId = null (broadcast to everyone). So there
  // is no way, at the data level, to distinguish an
  // "admin" notification from a broadcast any regular
  // user would also see via getMyNotifications.
  //
  // These methods return ALL broadcast notifications,
  // filterable by type/isRead like the user endpoint.
  // Access is restricted to admins at the route level
  // via @Roles(), but the underlying rows are not
  // isolated from regular users — a regular user
  // hitting GET /notifications would see the exact
  // same rows mixed into their own feed.
  //
  // Marking one as read here also affects the shared
  // row, same as any other broadcast (one admin's
  // "read" affects what every other viewer sees).
  //
  // A real fix requires adding a recipient/role field
  // to the schema (see Option B, which you declined
  // for now).
  // ─────────────────────────────────────────────

  async getAdminNotifications(
    query: NotificationQueryDto = {},
  ) {
    const { type, isRead, page = 1, limit = 20 } = query;

    const where = {
      userId: null,
      ...(type && { type }),
      ...(isRead !== undefined && { isRead }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { data, meta: { total, page, limit } };
  }

  async getAdminUnreadCount() {
    const count = await this.prisma.notification.count({
      where: { userId: null, isRead: false },
    });
    return { count };
  }

  async markAdminNotificationAsRead(
    id: string,
  ) {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId: null },
      data: { isRead: true },
    });

    if (result.count === 0) {
      throw new NotFoundException('Notification not found');
    }

    return result;
  }

  async markBulkAdminNotificationsAsRead(
    ids: string[],
  ) {
    return this.prisma.notification.updateMany({
      where: { id: { in: ids }, userId: null },
      data: { isRead: true },
    });
  }

  async markAllAdminNotificationsAsRead() {
    return this.prisma.notification.updateMany({
      where: { userId: null, isRead: false },
      data: { isRead: true },
    });
  }

  async deleteAdminNotification(
    id: string,
  ) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId: null },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    await this.prisma.notification.delete({ where: { id } });
    return { id, deleted: true };
  }
}
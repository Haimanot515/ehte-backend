import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, AuditLog } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';

import {
  AuditEventPayload,
} from '../events/audit.events';

import {
  GetAuditLogsDto,
} from '../dto/audit-log.dto';

export type AuditLogStats = {
  totalEvents: number;
  eventsToday: number;
  eventsThisWeek: number;
  eventsByAction: Record<string, number>;
  eventsByEntity: Record<string, number>;
  eventsByActorType: Record<string, number>;
};

@Injectable()
export class AuditLogService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Record an audit event.
   *
   * This method is called by AuditLogListener
   * whenever an audit event is emitted.
   */
  async record(
    payload: AuditEventPayload,
  ): Promise<AuditLog> {
    return this.prisma.auditLog.create({
      data: {
        userId: payload.userId ?? null,
        actorType: payload.actorType,
        action: payload.action,
        entity: payload.entity,
        entityId: payload.entityId ?? null,
        diff: payload.diff
          ? (payload.diff as Prisma.InputJsonValue)
          : undefined,
      },
    });
  }

  /**
   * Get audit logs, with filtering + pagination.
   */
  async findAll(dto: GetAuditLogsDto) {
    const {
      page = 1,
      limit = 20,
      action,
      entity,
      entityId,
      actorType,
      userId,
      startDate,
      endDate,
    } = dto;

    const skip = (page - 1) * limit;

    const where: Prisma.AuditLogWhereInput = {
      ...(action && {
        action,
      }),

      ...(entity && {
        entity,
      }),

      ...(entityId && {
        entityId,
      }),

      ...(actorType && {
        actorType,
      }),

      ...(userId && {
        userId,
      }),

      ...((startDate || endDate) && {
        createdAt: {
          ...(startDate && { gte: new Date(startDate) }),
          ...(endDate && { lte: new Date(endDate) }),
        },
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              phone: true,
            },
          },
        },
      }),

      this.prisma.auditLog.count({
        where,
      }),
    ]);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get a single audit log entry by ID.
   */
  async findOne(id: string) {
    const log = await this.prisma.auditLog.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });

    if (!log) {
      throw new NotFoundException('Audit log not found');
    }

    return log;
  }

  /**
   * Full audit history for one specific entity record,
   * e.g. every event tied to a single MissingPerson.
   */
  async findByEntity(
    entity: string,
    entityId: string,
    dto: Pick<GetAuditLogsDto, 'page' | 'limit'> = {},
  ) {
    const { page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: Prisma.AuditLogWhereInput = {
      entity,
      entityId,
    };

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: { id: true, name: true, phone: true },
          },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Full audit trail for a specific user/actor.
   */
  async findByUser(
    userId: string,
    dto: Pick<GetAuditLogsDto, 'page' | 'limit'> = {},
  ) {
    const { page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: Prisma.AuditLogWhereInput = { userId };

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: { id: true, name: true, phone: true },
          },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Audit log dashboard statistics.
   */
  async getStats(): Promise<AuditLogStats> {
    const now = new Date();

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const startOfWeek = new Date(now);
    startOfWeek.setDate(
      startOfWeek.getDate() - 7,
    );

    const [
      totalEvents,
      eventsToday,
      eventsThisWeek,
      actionGroups,
      entityGroups,
      actorTypeGroups,
    ] = await Promise.all([
      this.prisma.auditLog.count(),

      this.prisma.auditLog.count({
        where: {
          createdAt: {
            gte: startOfToday,
          },
        },
      }),

      this.prisma.auditLog.count({
        where: {
          createdAt: {
            gte: startOfWeek,
          },
        },
      }),

      this.prisma.auditLog.groupBy({
        by: ['action'],
        _count: {
          action: true,
        },
      }),

      this.prisma.auditLog.groupBy({
        by: ['entity'],
        _count: {
          entity: true,
        },
      }),

      this.prisma.auditLog.groupBy({
        by: ['actorType'],
        _count: {
          actorType: true,
        },
      }),
    ]);

    return {
      totalEvents,

      eventsToday,

      eventsThisWeek,

      eventsByAction: Object.fromEntries(
        actionGroups.map((group) => [
          group.action,
          group._count.action,
        ]),
      ),

      eventsByEntity: Object.fromEntries(
        entityGroups.map((group) => [
          group.entity,
          group._count.entity,
        ]),
      ),

      eventsByActorType: Object.fromEntries(
        actorTypeGroups.map((group) => [
          group.actorType,
          group._count.actorType,
        ]),
      ),
    };
  }
}
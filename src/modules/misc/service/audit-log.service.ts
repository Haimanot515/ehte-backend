import {
  BadRequestException,
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
  private static readonly MAX_EXPORT_ROWS = 50_000;

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
   * Distinct action values currently in use.
   * Powers filter dropdowns in the admin portal without
   * hardcoding action names client-side.
   */
  async findDistinctActions(): Promise<string[]> {
    const rows = await this.prisma.auditLog.findMany({
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
    });

    return rows.map((row) => row.action);
  }

  /**
   * Distinct entity values currently in use.
   * Same purpose as findDistinctActions, for the
   * 'entity' filter dropdown.
   */
  async findDistinctEntities(): Promise<string[]> {
    const rows = await this.prisma.auditLog.findMany({
      distinct: ['entity'],
      select: { entity: true },
      orderBy: { entity: 'asc' },
    });

    return rows.map((row) => row.entity);
  }

  /**
   * CSV export of audit logs matching the given filters,
   * for compliance/audit handoffs without needing to
   * script against the JSON API.
   *
   * Reuses the same filter surface as findAll but ignores
   * page/limit and pulls every matching row instead —
   * capped at MAX_EXPORT_ROWS so a huge unfiltered export
   * doesn't take down the process.
   */
  async exportCsv(
    dto: Omit<GetAuditLogsDto, 'page' | 'limit'>,
  ): Promise<string> {
    const {
      action,
      entity,
      entityId,
      actorType,
      userId,
      startDate,
      endDate,
    } = dto;

    const where: Prisma.AuditLogWhereInput = {
      ...(action && { action }),
      ...(entity && { entity }),
      ...(entityId && { entityId }),
      ...(actorType && { actorType }),
      ...(userId && { userId }),
      ...((startDate || endDate) && {
        createdAt: {
          ...(startDate && { gte: new Date(startDate) }),
          ...(endDate && { lte: new Date(endDate) }),
        },
      }),
    };

    const logs = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: AuditLogService.MAX_EXPORT_ROWS,
      include: {
        user: {
          select: { id: true, name: true, phone: true },
        },
      },
    });

    const header = [
      'id',
      'createdAt',
      'action',
      'entity',
      'entityId',
      'actorType',
      'userId',
      'userName',
      'userPhone',
      'diff',
    ];

    const escapeCsv = (value: unknown): string => {
      if (value === null || value === undefined) {
        return '';
      }

      const str =
        typeof value === 'string'
          ? value
          : JSON.stringify(value);

      // Wrap in quotes and escape embedded quotes whenever
      // the value could break CSV structure.
      if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }

      return str;
    };

    const rows = logs.map((log) =>
      [
        log.id,
        log.createdAt.toISOString(),
        log.action,
        log.entity,
        log.entityId,
        log.actorType,
        log.userId,
        log.user?.name ?? '',
        log.user?.phone ?? '',
        log.diff,
      ]
        .map(escapeCsv)
        .join(','),
    );

    return [header.join(','), ...rows].join('\n');
  }

  /**
   * Retention cleanup. Deletes all audit log rows
   * created strictly before the given date.
   *
   * Deliberately strict: rejects a missing/invalid date
   * instead of silently deleting everything, and returns
   * the deleted count so the SUPER_ADMIN caller/UI can
   * confirm exactly what happened.
   */
  async purgeOlderThan(
    olderThan: string,
  ): Promise<{ deletedCount: number; olderThan: string }> {
    if (!olderThan) {
      throw new BadRequestException(
        'olderThan_query_param_required',
      );
    }

    const cutoff = new Date(olderThan);

    if (isNaN(cutoff.getTime())) {
      throw new BadRequestException(
        'invalid_olderThan_date',
      );
    }

    const result = await this.prisma.auditLog.deleteMany({
      where: {
        createdAt: {
          lt: cutoff,
        },
      },
    });

    return {
      deletedCount: result.count,
      olderThan: cutoff.toISOString(),
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
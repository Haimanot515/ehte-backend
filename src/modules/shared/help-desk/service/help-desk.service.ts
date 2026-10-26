import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { HelpMessageAuthor, HelpTicketStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { dateRange, pageMeta, paging } from '../../common/paging.util';
import { findSharedRecord } from '../../common/shared-record.util';
import {
  AddTicketMessageDto,
  AdminTicketsQueryDto,
  AssignTicketDto,
  CannedRepliesQueryDto,
  CreateTicketDto,
  HelpStatsQueryDto,
  MyTicketsQueryDto,
  RateTicketDto,
  StaffReplyDto,
  UpdateTicketDto,
} from '../dto/help-desk.dto';

const MAX_ACTIVE_TICKETS_PER_USER = 10;
const REOPEN_WINDOW_DAYS = 7;
const MAX_REOPENS = 3;
const DEFAULT_STATS_DAYS = 30;

// A ticket in one of these states is still being worked on
const ACTIVE_STATUSES: HelpTicketStatus[] = [
  HelpTicketStatus.OPEN,
  HelpTicketStatus.IN_PROGRESS,
  HelpTicketStatus.WAITING_ON_USER,
];

const TICKET_SELECT = {
  id: true,
  reference: true,
  category: true,
  subject: true,
  status: true,
  priority: true,
  linkedEntity: true,
  linkedEntityId: true,
  assignedToId: true,
  firstResponseAt: true,
  resolvedAt: true,
  closedAt: true,
  closedBy: true,
  reopenCount: true,
  ratingScore: true,
  ratingComment: true,
  ratedAt: true,
  lastMessageAt: true,
  createdAt: true,
} satisfies Prisma.HelpTicketSelect;

const MESSAGE_SELECT = {
  id: true,
  authorType: true,
  authorId: true,
  body: true,
  attachmentKeys: true,
  createdAt: true,
} satisfies Prisma.HelpTicketMessageSelect;

@Injectable()
export class HelpDeskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minio: MinioService,
  ) {}

  // ── User ───────────────────────────────────────────────────────────────

  // SH-46
  async open(user: CurrentUserDto, body: CreateTicketDto) {
    if (!!body.linkedEntity !== !!body.linkedEntityId) {
      throw new BadRequestException('linkedEntity and linkedEntityId must be sent together');
    }

    const active = await this.prisma.helpTicket.count({
      where: { userId: user.id, status: { in: ACTIVE_STATUSES } },
    });
    if (active >= MAX_ACTIVE_TICKETS_PER_USER) {
      throw new ConflictException('You have too many open tickets. Please wait for a reply or close one first');
    }

    // A user may only link a ticket to a record they own. Anything else looks like "not found".
    if (body.linkedEntity && body.linkedEntityId) {
      const record = await findSharedRecord(this.prisma, body.linkedEntity, body.linkedEntityId);
      if (!record.exists || record.ownerId !== user.id) throw new NotFoundException('Linked record not found');
    }

    await this.assertAttachments(body.attachmentKeys);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ticket = await this.prisma.helpTicket.create({
          data: {
            reference: this.newReference(),
            userId: user.id,
            category: body.category,
            subject: body.subject,
            linkedEntity: body.linkedEntity ?? null,
            linkedEntityId: body.linkedEntityId ?? null,
            messages: {
              create: {
                authorType: HelpMessageAuthor.USER,
                authorId: user.id,
                body: body.body,
                attachmentKeys: body.attachmentKeys ?? [],
              },
            },
          },
          select: { ...TICKET_SELECT, messages: { select: MESSAGE_SELECT, orderBy: { createdAt: 'asc' } } },
        });
        return ticket;
      } catch (err) {
        // A reference clash is a 1 in 16 million event; just draw a new one
        const clash = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (!clash || attempt === 2) throw err;
      }
    }
    throw new ConflictException('Could not create the ticket, please try again');
  }

  // SH-47
  async listMine(user: CurrentUserDto, q: MyTicketsQueryDto) {
    const { page, limit, skip } = paging(q);
    const where: Prisma.HelpTicketWhereInput = { userId: user.id, ...(q.status ? { status: q.status } : {}) };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.helpTicket.findMany({
        where,
        select: TICKET_SELECT,
        orderBy: { lastMessageAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.helpTicket.count({ where }),
    ]);

    return { data: rows, meta: pageMeta(page, limit, total) };
  }

  // SH-48
  async getMine(user: CurrentUserDto, id: string) {
    const ticket = await this.prisma.helpTicket.findFirst({
      where: { id, userId: user.id },
      select: { ...TICKET_SELECT, messages: { select: MESSAGE_SELECT, orderBy: { createdAt: 'asc' } } },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  // SH-49
  async addUserMessage(user: CurrentUserDto, id: string, body: AddTicketMessageDto) {
    const ticket = await this.findOwned(user.id, id);
    if (ticket.status === HelpTicketStatus.CLOSED) {
      throw new ConflictException('This ticket is closed. Reopen it to reply');
    }

    await this.assertAttachments(body.attachmentKeys);

    // A reply from the user puts a waiting or resolved ticket back in the staff queue
    const nextStatus =
      ticket.status === HelpTicketStatus.OPEN || ticket.status === HelpTicketStatus.IN_PROGRESS
        ? ticket.status
        : ticket.assignedToId
          ? HelpTicketStatus.IN_PROGRESS
          : HelpTicketStatus.OPEN;

    const now = new Date();
    const [message] = await this.prisma.$transaction([
      this.prisma.helpTicketMessage.create({
        data: {
          ticketId: id,
          authorType: HelpMessageAuthor.USER,
          authorId: user.id,
          body: body.body,
          attachmentKeys: body.attachmentKeys ?? [],
        },
        select: MESSAGE_SELECT,
      }),
      this.prisma.helpTicket.update({
        where: { id },
        data: {
          status: nextStatus,
          lastMessageAt: now,
          ...(nextStatus !== ticket.status ? { resolvedAt: null } : {}),
        },
      }),
    ]);

    return message;
  }

  // SH-50
  async closeMine(user: CurrentUserDto, id: string) {
    const ticket = await this.findOwned(user.id, id);
    if (ticket.status === HelpTicketStatus.CLOSED) return this.getMine(user, id);

    await this.prisma.helpTicket.update({
      where: { id },
      data: { status: HelpTicketStatus.CLOSED, closedAt: new Date(), closedBy: HelpMessageAuthor.USER },
    });
    return this.getMine(user, id);
  }

  // SH-51
  async reopenMine(user: CurrentUserDto, id: string) {
    const ticket = await this.findOwned(user.id, id);
    if (ticket.status !== HelpTicketStatus.CLOSED && ticket.status !== HelpTicketStatus.RESOLVED) {
      throw new ConflictException('Only a closed or resolved ticket can be reopened');
    }
    if (ticket.reopenCount >= MAX_REOPENS) {
      throw new ConflictException('This ticket was reopened too many times. Please open a new ticket');
    }

    const since = ticket.closedAt ?? ticket.resolvedAt;
    if (since && Date.now() - since.getTime() > REOPEN_WINDOW_DAYS * 86_400_000) {
      throw new ConflictException(`A ticket can only be reopened within ${REOPEN_WINDOW_DAYS} days. Please open a new ticket`);
    }

    // Guard on the status we read so a double tap cannot count as two reopens
    const res = await this.prisma.helpTicket.updateMany({
      where: { id, status: ticket.status },
      data: {
        status: ticket.assignedToId ? HelpTicketStatus.IN_PROGRESS : HelpTicketStatus.OPEN,
        closedAt: null,
        closedBy: null,
        resolvedAt: null,
        reopenCount: { increment: 1 },
        lastMessageAt: new Date(),
      },
    });
    if (res.count === 0) throw new ConflictException('This ticket was just changed. Reload and try again');

    return this.getMine(user, id);
  }

  // SH-52
  async rate(user: CurrentUserDto, id: string, body: RateTicketDto) {
    const ticket = await this.findOwned(user.id, id);
    if (ticket.status !== HelpTicketStatus.RESOLVED && ticket.status !== HelpTicketStatus.CLOSED) {
      throw new ConflictException('You can rate a ticket once it is resolved or closed');
    }

    const res = await this.prisma.helpTicket.updateMany({
      where: { id, ratedAt: null },
      data: { ratingScore: body.score, ratingComment: body.comment ?? null, ratedAt: new Date() },
    });
    if (res.count === 0) throw new ConflictException('You already rated this ticket');

    return this.getMine(user, id);
  }

  // ── Staff ──────────────────────────────────────────────────────────────

  // SH-53
  async adminList(_admin: CurrentUserDto, q: AdminTicketsQueryDto) {
    const { page, limit, skip } = paging(q);

    const where: Prisma.HelpTicketWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.priority ? { priority: q.priority } : {}),
      ...(q.unassigned ? { assignedToId: null } : q.assignedToId ? { assignedToId: q.assignedToId } : {}),
      ...(q.olderThanHours ? { createdAt: { lt: new Date(Date.now() - q.olderThanHours * 3_600_000) } } : {}),
      ...(q.q
        ? {
            OR: [
              { reference: { contains: q.q, mode: 'insensitive' } },
              { subject: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.helpTicket.findMany({
        where,
        select: { ...TICKET_SELECT, user: { select: { id: true, name: true } } },
        // Priority is declared LOW..URGENT, so desc puts URGENT first. Oldest first inside each level.
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.helpTicket.count({ where }),
    ]);

    return { data: rows, meta: pageMeta(page, limit, total) };
  }

  // SH-54
  async adminGet(_admin: CurrentUserDto, id: string) {
    const ticket = await this.prisma.helpTicket.findUnique({
      where: { id },
      select: {
        ...TICKET_SELECT,
        user: { select: { id: true, name: true, phone: true, email: true } },
        messages: { select: MESSAGE_SELECT, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    // The link carries the record type and id; staff open the record from its own admin screen
    const linkedRecord =
      ticket.linkedEntity && ticket.linkedEntityId
        ? {
            entity: ticket.linkedEntity,
            entityId: ticket.linkedEntityId,
            exists: (await findSharedRecord(this.prisma, ticket.linkedEntity, ticket.linkedEntityId)).exists,
          }
        : null;

    return { ...ticket, linkedRecord };
  }

  // SH-55
  async adminUpdate(_admin: CurrentUserDto, id: string, body: UpdateTicketDto) {
    if (!body.status && !body.category && !body.priority) {
      throw new BadRequestException('Send at least one of status, category or priority');
    }

    const ticket = await this.prisma.helpTicket.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const data: Prisma.HelpTicketUpdateManyMutationInput = {
      ...(body.category ? { category: body.category } : {}),
      ...(body.priority ? { priority: body.priority } : {}),
    };

    if (body.status && body.status !== ticket.status) {
      const now = new Date();
      data.status = body.status;
      if (body.status === HelpTicketStatus.RESOLVED) {
        data.resolvedAt = now;
      } else if (body.status === HelpTicketStatus.CLOSED) {
        data.closedAt = now;
        data.closedBy = HelpMessageAuthor.STAFF;
      } else {
        // Moving back to an active state clears the end markers
        data.resolvedAt = null;
        data.closedAt = null;
        data.closedBy = null;
      }
    }

    const res = await this.prisma.helpTicket.updateMany({ where: { id, status: ticket.status }, data });
    if (res.count === 0) throw new ConflictException('This ticket was changed by someone else. Reload and try again');

    return this.prisma.helpTicket.findUniqueOrThrow({ where: { id }, select: TICKET_SELECT });
  }

  // SH-56
  async staffReply(admin: CurrentUserDto, id: string, body: StaffReplyDto) {
    const ticket = await this.prisma.helpTicket.findUnique({
      where: { id },
      select: { id: true, status: true, firstResponseAt: true, assignedToId: true },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status === HelpTicketStatus.CLOSED) {
      throw new ConflictException('This ticket is closed. Move it back to an active status first');
    }

    await this.assertAttachments(body.attachmentKeys);

    const now = new Date();
    const nextStatus = body.resolve ? HelpTicketStatus.RESOLVED : HelpTicketStatus.WAITING_ON_USER;

    const [message] = await this.prisma.$transaction([
      this.prisma.helpTicketMessage.create({
        data: {
          ticketId: id,
          authorType: HelpMessageAuthor.STAFF,
          authorId: admin.id,
          body: body.body,
          attachmentKeys: body.attachmentKeys ?? [],
        },
        select: MESSAGE_SELECT,
      }),
      this.prisma.helpTicket.update({
        where: { id },
        data: {
          status: nextStatus,
          lastMessageAt: now,
          ...(ticket.firstResponseAt ? {} : { firstResponseAt: now }),
          // The first staff member to answer an unassigned ticket takes it
          ...(ticket.assignedToId ? {} : { assignedToId: admin.id }),
          ...(body.resolve ? { resolvedAt: now } : { resolvedAt: null }),
        },
      }),
    ]);

    return message;
  }

  // SH-57
  async assign(_admin: CurrentUserDto, id: string, body: AssignTicketDto) {
    const ticket = await this.prisma.helpTicket.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    if (body.assigneeId) {
      const staff = await this.prisma.user.findFirst({
        where: {
          id: body.assigneeId,
          isActive: true,
          deletedAt: null,
          userRoles: { some: { role: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] } } } },
        },
        select: { id: true },
      });
      if (!staff) throw new BadRequestException('The assignee must be an active staff member');
    }

    return this.prisma.helpTicket.update({
      where: { id },
      data: {
        assignedToId: body.assigneeId,
        // Picking up an untouched ticket moves it out of the new queue
        ...(body.assigneeId && ticket.status === HelpTicketStatus.OPEN ? { status: HelpTicketStatus.IN_PROGRESS } : {}),
      },
      select: TICKET_SELECT,
    });
  }

  // SH-58
  async cannedReplies(q: CannedRepliesQueryDto) {
    const rows = await this.prisma.helpCannedReply.findMany({
      where: {
        active: true,
        ...(q.language ? { language: q.language } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...(q.q
          ? {
              OR: [
                { title: { contains: q.q, mode: 'insensitive' } },
                { body: { contains: q.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ category: 'asc' }, { title: 'asc' }],
      take: 200,
      select: { id: true, title: true, body: true, language: true, category: true },
    });

    return { data: rows };
  }

  // SH-59
  async stats(q: HelpStatsQueryDto) {
    const { from, to } = dateRange(q, DEFAULT_STATS_DAYS);
    const inRange: Prisma.HelpTicketWhereInput = { createdAt: { gte: from, lte: to } };

    const [byStatus, byCategory, unassigned, rating] = await Promise.all([
      this.prisma.helpTicket.groupBy({ by: ['status'], where: inRange, _count: { _all: true } }),
      this.prisma.helpTicket.groupBy({ by: ['category'], where: inRange, _count: { _all: true } }),
      this.prisma.helpTicket.count({ where: { status: { in: ACTIVE_STATUSES }, assignedToId: null } }),
      this.prisma.helpTicket.aggregate({ where: { ...inRange, ratingScore: { not: null } }, _avg: { ratingScore: true }, _count: { _all: true } }),
    ]);

    const [times] = await this.prisma.$queryRaw<
      Array<{ avgFirstResponseSeconds: number | null; avgResolutionSeconds: number | null }>
    >(Prisma.sql`
      SELECT AVG(EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt")))::float8 AS "avgFirstResponseSeconds",
             AVG(EXTRACT(EPOCH FROM (COALESCE("resolvedAt", "closedAt") - "createdAt")))::float8 AS "avgResolutionSeconds"
      FROM "help_ticket"
      WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
    `);

    const volume = await this.prisma.$queryRaw<Array<{ day: Date; count: number }>>(Prisma.sql`
      SELECT date_trunc('day', "createdAt") AS "day", COUNT(*)::int AS "count"
      FROM "help_ticket"
      WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    const hours = (seconds: number | null | undefined) =>
      seconds === null || seconds === undefined ? null : Math.round((seconds / 3600) * 10) / 10;

    return {
      from,
      to,
      total: byStatus.reduce((sum, r) => sum + r._count._all, 0),
      unassignedActive: unassigned,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      byCategory: Object.fromEntries(byCategory.map((r) => [r.category, r._count._all])),
      avgFirstResponseHours: hours(times?.avgFirstResponseSeconds),
      avgResolutionHours: hours(times?.avgResolutionSeconds),
      rating: {
        average: rating._avg.ratingScore === null ? null : Math.round(rating._avg.ratingScore * 100) / 100,
        count: rating._count._all,
      },
      volumeByDay: volume.map((v) => ({ day: v.day, count: v.count })),
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private newReference() {
    const now = new Date();
    const month = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return `HD-${month}-${randomBytes(3).toString('hex').toUpperCase()}`;
  }

  private async findOwned(userId: string, id: string) {
    const ticket = await this.prisma.helpTicket.findFirst({ where: { id, userId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  // Keys must point at files that were really uploaded. Who uploaded them is not checked.
  private async assertAttachments(keys?: string[]) {
    if (!keys?.length) return;
    const found = await Promise.all(keys.map((k) => this.minio.objectExists(k)));
    if (found.some((ok) => !ok)) {
      throw new BadRequestException('One or more attachments were not found. Upload them first and send the returned keys');
    }
  }
}

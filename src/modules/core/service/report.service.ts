import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { ReportStatus } from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';

import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { CreateReportDto, UpdateReportDto } from '../dto/report.dto';

import {
  AdminReportQueryDto,
  UpdateReportStatusDto,
  AssignReportDto,
  RequestMoreInformationDto,
  EscalateReportDto,
} from '../dto/report-admin.dto';

@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // CREATE REPORT
  // ─────────────────────────────────────────────

  async create(user: CurrentUserDto, data: CreateReportDto) {
    const report = await this.prisma.report.create({
      data: {
        userId: user.id,

        caseReference: this.generateCaseReference(),

        category: data.category,

        description: data.description,

        location: data.location ?? null,

        incidentAt: data.incidentAt ? new Date(data.incidentAt) : null,

        photo: data.photo ?? [],

        video: data.video ?? [],

        audio: data.audio ?? [],

        pdf: data.pdf ?? [],

        document: data.document ?? [],

        other: data.other ?? [],

        status: ReportStatus.PENDING,
      },
    });

    this.eventEmitter.emit(AuditEventEnum.REPORT_CREATED, {
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
      action: AuditEventEnum.REPORT_CREATED,
      entity: 'Report',
      entityId: report.id,
      diff: {
        result: 'success',
        status: report.status,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_RECEIVED, {
      reportId: report.id,
      userId: user.id,
    });

    this.eventEmitter.emit(NotificationEventEnum.NEW_REPORT, {
      reportId: report.id,
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // GET MY REPORTS
  // ─────────────────────────────────────────────

  async findMyReports(user: CurrentUserDto) {
    return this.prisma.report.findMany({
      where: {
        userId: user.id,
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ─────────────────────────────────────────────
  // GET ONE OF MY REPORTS
  // ─────────────────────────────────────────────

  async findOne(user: CurrentUserDto, reportId: string) {
    const report = await this.prisma.report.findFirst({
      where: {
        id: reportId,
        userId: user.id,
      },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    return report;
  }

  // ─────────────────────────────────────────────
  // UPDATE REPORT
  // ─────────────────────────────────────────────

  async update(user: CurrentUserDto, reportId: string, data: UpdateReportDto) {
    const existing = await this.prisma.report.findFirst({
      where: {
        id: reportId,
        userId: user.id,
      },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    if (existing.status !== ReportStatus.PENDING) {
      throw new BadRequestException('only_pending_reports_can_be_updated');
    }

    const report = await this.prisma.report.update({
      where: {
        id: reportId,
      },

      data: {
        ...(data.category !== undefined ? { category: data.category } : {}),

        ...(data.description !== undefined ? { description: data.description } : {}),

        ...(data.location !== undefined ? { location: data.location } : {}),

        ...(data.incidentAt !== undefined
          ? {
              incidentAt: new Date(data.incidentAt),
            }
          : {}),

        ...(data.photo !== undefined ? { photo: data.photo } : {}),

        ...(data.video !== undefined ? { video: data.video } : {}),

        ...(data.audio !== undefined ? { audio: data.audio } : {}),

        ...(data.pdf !== undefined ? { pdf: data.pdf } : {}),

        ...(data.document !== undefined ? { document: data.document } : {}),

        ...(data.other !== undefined ? { other: data.other } : {}),
      },
    });

    this.eventEmitter.emit(AuditEventEnum.REPORT_UPDATED, {
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
      action: AuditEventEnum.REPORT_UPDATED,
      entity: 'Report',
      entityId: report.id,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_UPDATED, {
      reportId: report.id,
      userId: user.id,
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // LIST REPORTS (ADMIN)
  //
  // NOTE: query.assignedTo is accepted and documented
  // but not yet applied — Report has no assignedToId
  // column in the current schema (see assign() below).
  // Wire this into `where` once that column exists.
  // ─────────────────────────────────────────────

  async findAllForAdmin(query: AdminReportQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      ...(query.status ? { status: query.status } : {}),

      ...(query.category ? { category: query.category } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),

      this.prisma.report.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
    };
  }

  // ─────────────────────────────────────────────
  // GET ONE REPORT — FULL DETAIL (ADMIN)
  // ─────────────────────────────────────────────

  async findOneForAdmin(admin: CurrentUserDto, reportId: string) {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },

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

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    const actorType = resolveActorType(this.getRoles(admin));

    this.eventEmitter.emit(AuditEventEnum.REPORT_OPENED, {
      userId: admin.id,
      actorType,
      action: AuditEventEnum.REPORT_OPENED,
      entity: 'Report',
      entityId: reportId,
      diff: { result: 'success' },
    });

    this.eventEmitter.emit(AuditEventEnum.REPORTER_INFORMATION_OPENED, {
      userId: admin.id,
      actorType,
      action: AuditEventEnum.REPORTER_INFORMATION_OPENED,
      entity: 'Report',
      entityId: reportId,
      diff: { result: 'success' },
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // UPDATE STATUS (ADMIN)
  // ─────────────────────────────────────────────

  async updateStatus(admin: CurrentUserDto, reportId: string, data: UpdateReportStatusDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { status: data.status },
    });

    this.eventEmitter.emit(AuditEventEnum.REPORT_STATUS_CHANGED, {
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_STATUS_CHANGED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
        note: data.note ?? null,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_UPDATED, {
      reportId: report.id,
      userId: report.userId,
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // REQUEST MORE INFORMATION (ADMIN)
  // ─────────────────────────────────────────────

  async requestMoreInformation(
    admin: CurrentUserDto,
    reportId: string,
    data: RequestMoreInformationDto,
  ) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.eventEmitter.emit(AuditEventEnum.REPORT_MORE_INFORMATION_REQUESTED, {
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_MORE_INFORMATION_REQUESTED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        message: data.message,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.MORE_INFORMATION_REQUESTED, {
      reportId,
      userId: existing.userId,
      message: data.message,
    });

    return { reportId, requested: true };
  }

  // ─────────────────────────────────────────────
  // ASSIGN (ADMIN)
  //
  // NOTE: Report has no assignedToId field in the
  // current schema. This records the audit trail
  // but does not persist the assignment until that
  // column is added.
  // ─────────────────────────────────────────────

  async assign(admin: CurrentUserDto, reportId: string, data: AssignReportDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.eventEmitter.emit(AuditEventEnum.REPORT_ASSIGNED, {
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_ASSIGNED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        assignedToUserId: data.assignedToUserId,
        note: data.note ?? null,
      },
    });

    return {
      reportId,
      assignedToUserId: data.assignedToUserId,
    };
  }

  // ─────────────────────────────────────────────
  // ESCALATE (ADMIN)
  // ─────────────────────────────────────────────

  async escalate(admin: CurrentUserDto, reportId: string, data: EscalateReportDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { status: ReportStatus.ESCALATED },
    });

    this.eventEmitter.emit(AuditEventEnum.REPORT_ESCALATED, {
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_ESCALATED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        reason: data.reason,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.HIGH_PRIORITY_REPORT, {
      reportId: report.id,
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────

  private generateCaseReference(): string {
    const year = new Date().getFullYear();
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `EHT-${year}-${random}`;
  }

  // ─────────────────────────────────────────────
  // Centralizes the unsafe roles extraction that was
  // previously repeated (with an `as unknown as` cast)
  // in every method that emits an audit event. Ideally
  // CurrentUserDto declares `roles` directly so this
  // cast can be removed entirely — it currently doesn't,
  // so this keeps the workaround in exactly one place.
  // ─────────────────────────────────────────────

  private getRoles(user: CurrentUserDto): string[] {
    return (
      (
        user as unknown as {
          roles?: string[];
        }
      ).roles ?? []
    );
  }
}

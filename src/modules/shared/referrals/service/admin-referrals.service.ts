import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InstitutionStatus, Prisma, ReferralStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { SharedRecordEntity } from 'src/common/enums/shared/shared-record-entity.enum';
import { dateRange, pageMeta, paging } from '../../common/paging.util';
import { findSharedRecord } from '../../common/shared-record.util';
import {
  AttachReferralDocumentDto,
  CreateReferralDto,
  ReferralListQueryDto,
  ReferralStatsQueryDto,
  RevealReferralDetailsDto,
  UpdateReferralStatusDto,
} from '../dto/admin-referrals.dto';

// Default time an institution has to acknowledge a referral
const DEFAULT_ACK_DUE_HOURS = 72;
const MAX_DOCUMENTS_PER_REFERRAL = 20;
const DEFAULT_STATS_DAYS = 90;

// Allowed moves. CLOSED is final.
const TRANSITIONS: Record<ReferralStatus, ReferralStatus[]> = {
  [ReferralStatus.SENT]: [ReferralStatus.ACKNOWLEDGED, ReferralStatus.IN_PROGRESS, ReferralStatus.CLOSED],
  [ReferralStatus.ACKNOWLEDGED]: [ReferralStatus.IN_PROGRESS, ReferralStatus.CLOSED],
  [ReferralStatus.IN_PROGRESS]: [ReferralStatus.CLOSED],
  [ReferralStatus.CLOSED]: [],
};

const LIST_SELECT = {
  id: true,
  institutionId: true,
  entity: true,
  entityId: true,
  status: true,
  reason: true,
  includesSensitive: true,
  createdById: true,
  sentAt: true,
  ackDueAt: true,
  acknowledgedAt: true,
  closedAt: true,
  closeOutcome: true,
  institution: { select: { id: true, name: true, status: true } },
} satisfies Prisma.ReferralSelect;

type ListRow = Prisma.ReferralGetPayload<{ select: typeof LIST_SELECT }>;

@Injectable()
export class AdminReferralsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minio: MinioService,
  ) {}

  // SH-09
  async create(admin: CurrentUserDto, body: CreateReferralDto) {
    const institution = await this.prisma.institution.findUnique({
      where: { id: body.institutionId },
      select: { id: true, status: true },
    });
    if (!institution) throw new NotFoundException('Institution not found');
    if (institution.status === InstitutionStatus.SUSPENDED) {
      throw new BadRequestException('This institution is suspended and cannot receive referrals');
    }

    const record = await findSharedRecord(this.prisma, body.entity, body.entityId);
    if (!record.exists) throw new NotFoundException('Record not found');

    // One open referral per institution and record, so the same case is not sent twice
    const open = await this.prisma.referral.findFirst({
      where: {
        institutionId: body.institutionId,
        entity: body.entity,
        entityId: body.entityId,
        status: { not: ReferralStatus.CLOSED },
      },
      select: { id: true },
    });
    if (open) throw new ConflictException('An open referral to this institution already exists for this record');

    const sentAt = new Date();
    const ackDueAt = new Date(sentAt.getTime() + (body.ackDueHours ?? DEFAULT_ACK_DUE_HOURS) * 3_600_000);

    const created = await this.prisma.referral.create({
      data: {
        institutionId: body.institutionId,
        entity: body.entity,
        entityId: body.entityId,
        reason: body.reason,
        includesSensitive: body.includesSensitive ?? false,
        createdById: admin.id,
        sentAt,
        ackDueAt,
        events: { create: { fromStatus: null, toStatus: ReferralStatus.SENT, changedById: admin.id } },
      },
      select: LIST_SELECT,
    });

    return this.shape(created);
  }

  // SH-10
  async list(_admin: CurrentUserDto, q: ReferralListQueryDto) {
    return this.page(this.buildWhere(q), q, 'desc');
  }

  // SH-16
  async overdue(_admin: CurrentUserDto, q: ReferralListQueryDto) {
    // Status filter is ignored here: overdue always means SENT and past its due time
    const where = this.buildWhere({ ...q, status: undefined });
    where.status = ReferralStatus.SENT;
    where.ackDueAt = { lt: new Date() };
    return this.page(where, q, 'asc');
  }

  // SH-13
  async byRecord(_admin: CurrentUserDto, entity: SharedRecordEntity, entityId: string, q: ReferralListQueryDto) {
    const where = this.buildWhere(q);
    where.entity = entity;
    where.entityId = entityId;
    return this.page(where, q, 'desc');
  }

  // SH-18
  async byInstitution(_admin: CurrentUserDto, institutionId: string, q: ReferralListQueryDto) {
    const exists = await this.prisma.institution.findUnique({ where: { id: institutionId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Institution not found');

    const where = this.buildWhere(q);
    where.institutionId = institutionId;
    return this.page(where, q, 'desc');
  }

  // SH-11
  async getOne(_admin: CurrentUserDto, id: string) {
    const row = await this.prisma.referral.findUnique({
      where: { id },
      select: {
        ...LIST_SELECT,
        events: { orderBy: { createdAt: 'asc' } },
        documents: { orderBy: { createdAt: 'asc' } },
        reveals: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, revealedById: true, reason: true, createdAt: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Referral not found');

    const { events, documents, reveals, ...rest } = row;
    return { ...this.shape(rest), history: events, documents, reveals };
  }

  // SH-12
  async updateStatus(admin: CurrentUserDto, id: string, body: UpdateReferralStatusDto) {
    const current = await this.prisma.referral.findUnique({
      where: { id },
      select: { id: true, status: true, acknowledgedAt: true },
    });
    if (!current) throw new NotFoundException('Referral not found');

    if (!TRANSITIONS[current.status].includes(body.status)) {
      throw new ConflictException(`A referral that is ${current.status} cannot move to ${body.status}`);
    }

    const now = new Date();
    const data: Prisma.ReferralUpdateManyMutationInput = { status: body.status };
    // Jumping straight past ACKNOWLEDGED still counts as an acknowledgement
    if (!current.acknowledgedAt) data.acknowledgedAt = now;
    if (body.status === ReferralStatus.CLOSED) {
      data.closedAt = now;
      data.closeOutcome = body.outcome ?? null;
    }

    await this.prisma.$transaction(async (tx) => {
      // Guard on the status we read so two staff members cannot both apply a move
      const res = await tx.referral.updateMany({ where: { id, status: current.status }, data });
      if (res.count === 0) throw new ConflictException('This referral was changed by someone else. Reload and try again');

      await tx.referralStatusEvent.create({
        data: {
          referralId: id,
          fromStatus: current.status,
          toStatus: body.status,
          note: body.note ?? null,
          changedById: admin.id,
        },
      });
    });

    return this.getOne(admin, id);
  }

  // SH-14
  async attachDocument(admin: CurrentUserDto, id: string, body: AttachReferralDocumentDto) {
    const referral = await this.prisma.referral.findUnique({
      where: { id },
      select: { id: true, _count: { select: { documents: true } } },
    });
    if (!referral) throw new NotFoundException('Referral not found');
    if (referral._count.documents >= MAX_DOCUMENTS_PER_REFERRAL) {
      throw new ConflictException(`A referral can have at most ${MAX_DOCUMENTS_PER_REFERRAL} documents`);
    }

    const exists = await this.minio.objectExists(body.mediaKey);
    if (!exists) throw new BadRequestException('That file was not found. Upload it first and send the returned key');

    const dup = await this.prisma.referralDocument.findFirst({
      where: { referralId: id, mediaKey: body.mediaKey },
      select: { id: true },
    });
    if (dup) throw new ConflictException('This document is already attached');

    return this.prisma.referralDocument.create({
      data: {
        referralId: id,
        mediaKey: body.mediaKey,
        fileName: body.fileName ?? null,
        mimeType: body.mimeType ?? null,
        addedById: admin.id,
      },
    });
  }

  // SH-15
  async revealDetails(admin: CurrentUserDto, id: string, body: RevealReferralDetailsDto) {
    const referral = await this.prisma.referral.findUnique({
      where: { id },
      select: { id: true, entity: true, entityId: true, includesSensitive: true },
    });
    if (!referral) throw new NotFoundException('Referral not found');
    if (!referral.includesSensitive) {
      throw new BadRequestException('This referral was not marked as carrying survivor or informant details');
    }

    const record = await findSharedRecord(this.prisma, referral.entity, referral.entityId);
    if (!record.exists) throw new NotFoundException('The referred record no longer exists');

    const owner = record.ownerId
      ? await this.prisma.user.findUnique({
          where: { id: record.ownerId },
          select: { id: true, name: true, phone: true, email: true },
        })
      : null;

    // The reveal is written before the details are returned, so no reveal goes unrecorded
    await this.prisma.referralDetailsReveal.create({
      data: { referralId: id, revealedById: admin.id, reason: body.reason },
    });

    return {
      referralId: id,
      entity: referral.entity,
      entityId: referral.entityId,
      anonymous: !owner,
      details: {
        name: owner?.name ?? null,
        phone: owner?.phone ?? null,
        email: owner?.email ?? null,
        contactPhone: record.contactPhone,
      },
    };
  }

  // SH-17
  async stats(q: ReferralStatsQueryDto) {
    const { from, to } = dateRange(q, DEFAULT_STATS_DAYS);
    const institutionFilter = q.institutionId
      ? Prisma.sql`AND "institutionId" = ${q.institutionId}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{ institutionId: string; status: ReferralStatus; count: number; avgAckSeconds: number | null }>
    >(Prisma.sql`
      SELECT "institutionId",
             "status"::text AS "status",
             COUNT(*)::int AS "count",
             AVG(EXTRACT(EPOCH FROM ("acknowledgedAt" - "sentAt")))::float8 AS "avgAckSeconds"
      FROM "referral"
      WHERE "sentAt" >= ${from} AND "sentAt" <= ${to} ${institutionFilter}
      GROUP BY "institutionId", "status"
    `);

    const overdue = await this.prisma.referral.count({
      where: {
        status: ReferralStatus.SENT,
        ackDueAt: { lt: new Date() },
        ...(q.institutionId ? { institutionId: q.institutionId } : {}),
      },
    });

    const institutions = await this.prisma.institution.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.institutionId))] } },
      select: { id: true, name: true },
    });
    const nameById = new Map(institutions.map((i) => [i.id, i.name]));

    const byInstitution = new Map<
      string,
      { institutionId: string; name: string | null; total: number; byStatus: Record<string, number>; ackSecondsSum: number; ackCount: number }
    >();
    const totals: Record<string, number> = {};

    for (const r of rows) {
      const entry = byInstitution.get(r.institutionId) ?? {
        institutionId: r.institutionId,
        name: nameById.get(r.institutionId) ?? null,
        total: 0,
        byStatus: {},
        ackSecondsSum: 0,
        ackCount: 0,
      };
      entry.total += r.count;
      entry.byStatus[r.status] = (entry.byStatus[r.status] ?? 0) + r.count;
      // Weight each status group's average by its size so the institution average is exact
      if (r.avgAckSeconds !== null) {
        entry.ackSecondsSum += r.avgAckSeconds * r.count;
        entry.ackCount += r.count;
      }
      byInstitution.set(r.institutionId, entry);
      totals[r.status] = (totals[r.status] ?? 0) + r.count;
    }

    return {
      from,
      to,
      overdue,
      totals,
      institutions: [...byInstitution.values()]
        .map(({ ackSecondsSum, ackCount, ...rest }) => ({
          ...rest,
          avgResponseHours: ackCount > 0 ? Math.round((ackSecondsSum / ackCount / 3600) * 10) / 10 : null,
        }))
        .sort((a, b) => b.total - a.total),
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private buildWhere(q: ReferralListQueryDto): Prisma.ReferralWhereInput {
    const sentAt: Prisma.DateTimeFilter = {};
    if (q.from) sentAt.gte = new Date(q.from);
    if (q.to) sentAt.lte = new Date(q.to);

    return {
      ...(q.status ? { status: q.status } : {}),
      ...(q.institutionId ? { institutionId: q.institutionId } : {}),
      ...(q.entity ? { entity: q.entity } : {}),
      ...(sentAt.gte || sentAt.lte ? { sentAt } : {}),
    };
  }

  private async page(where: Prisma.ReferralWhereInput, q: ReferralListQueryDto, order: 'asc' | 'desc') {
    const { page, limit, skip } = paging(q);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.referral.findMany({
        where,
        select: LIST_SELECT,
        orderBy: { sentAt: order },
        skip,
        take: limit,
      }),
      this.prisma.referral.count({ where }),
    ]);

    return { data: rows.map((r) => this.shape(r)), meta: pageMeta(page, limit, total) };
  }

  private shape(r: ListRow) {
    return {
      id: r.id,
      institutionId: r.institutionId,
      institutionName: r.institution.name,
      entity: r.entity,
      entityId: r.entityId,
      status: r.status,
      reason: r.reason,
      includesSensitive: r.includesSensitive,
      createdById: r.createdById,
      sentAt: r.sentAt,
      ackDueAt: r.ackDueAt,
      acknowledgedAt: r.acknowledgedAt,
      closedAt: r.closedAt,
      closeOutcome: r.closeOutcome,
      overdue: r.status === ReferralStatus.SENT && !!r.ackDueAt && r.ackDueAt < new Date(),
    };
  }
}

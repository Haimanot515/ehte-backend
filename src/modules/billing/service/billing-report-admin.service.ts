// src/modules/billing/service/billing-report-admin.service.ts
//
// Ledger, daily close, liabilities, CSV exports and statistics
// (BL-77 to BL-82, BL-85 to BL-92). Read-only: nothing here moves money.
//
// Not included: BL-83 and BL-84 (background export jobs). The CSV exports below
// are capped at MAX_EXPORT_ROWS and say so in the response headers.
import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditSeverity, PaymentStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditEventEnum } from '../../../common/enums/shared/audit-events.enum';

import { BillingEventsService } from './billing-events.service';
import {
  MAX_EXPORT_ROWS,
  dec,
  money,
  pageArgs,
  pageResult,
  resolveRange,
  toCsv,
  truncUnit,
} from './billing-admin.helpers';
import {
  BillingExportQueryDto,
  BillingStatsQueryDto,
  DailyCloseQueryDto,
  DateRangeDto,
  LedgerQueryDto,
  LiabilitiesQueryDto,
} from '../dto/billing-admin.dto';

type LedgerEntry = {
  at: Date;
  kind: 'PAYMENT_IN' | 'REFUND_OUT' | 'PAYOUT_OUT';
  amount: string;
  currency: string;
  type: string | null;
  reference: string;
  paymentId: string | null;
  disbursementId: string | null;
};

@Injectable()
export class BillingReportAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: BillingEventsService,
  ) {}

  // ═════════════════════════════════════════════
  // SUMMARY AND LEDGER
  // ═════════════════════════════════════════════

  // BL-77
  async summary(q: DateRangeDto) {
    const { from, to } = resolveRange(q.from, q.to);

    const [collected, byType, fees, refunds, payouts, allocated] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { status: { in: ['PAID', 'REFUNDED'] }, paidAt: { gte: from, lte: to } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.payment.groupBy({
        by: ['type'],
        where: { status: { in: ['PAID', 'REFUNDED'] }, paidAt: { gte: from, lte: to } },
        _sum: { amount: true },
        _count: { _all: true },
        orderBy: { type: 'asc' },
      }),
      this.prisma.payment.aggregate({
        where: { status: { in: ['PAID', 'REFUNDED'] }, paidAt: { gte: from, lte: to } },
        _sum: { chapaFee: true },
      }),
      this.prisma.payment.aggregate({
        where: { refundStatus: 'REFUNDED', refundedAt: { gte: from, lte: to } },
        _sum: { refundAmount: true },
        _count: { _all: true },
      }),
      this.prisma.disbursement.aggregate({
        where: { status: 'PAID_OUT', executedAt: { gte: from, lte: to } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.paymentAllocation.aggregate({
        where: { payment: { status: 'PAID', paidAt: { gte: from, lte: to } } },
        _sum: { amount: true },
      }),
    ]);

    return {
      range: { from, to },
      collected: { count: collected._count._all, amount: money(collected._sum.amount) },
      byType: byType.map((t) => ({ type: t.type, count: t._count._all, amount: money(t._sum.amount) })),
      gatewayFees: money(fees._sum.chapaFee),
      allocated: money(allocated._sum.amount),
      refunded: { count: refunds._count._all, amount: money(refunds._sum.refundAmount) },
      paidOut: { count: payouts._count._all, amount: money(payouts._sum.amount) },
    };
  }

  // BL-78. Every money movement, newest first. Built from the three tables that
  // hold real movements, so it cannot disagree with them.
  async ledger(q: LedgerQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const { from, to } = resolveRange(q.from, q.to);
    // Each source is read up to the end of the requested page, then merged.
    const take = skip + limit;
    const entries: LedgerEntry[] = [];
    const counts = { in: 0, refund: 0, payout: 0 };

    if (!q.kind || q.kind === 'PAYMENT_IN') {
      const where: Prisma.PaymentWhereInput = {
        status: { in: ['PAID', 'REFUNDED'] },
        paidAt: { gte: from, lte: to },
        ...(q.type ? { type: q.type } : {}),
      };
      const [rows, n] = await Promise.all([
        this.prisma.payment.findMany({
          where,
          orderBy: { paidAt: 'desc' },
          take,
          select: { id: true, txRef: true, type: true, amount: true, currency: true, paidAt: true },
        }),
        this.prisma.payment.count({ where }),
      ]);
      counts.in = n;
      for (const r of rows) {
        entries.push({
          at: r.paidAt as Date,
          kind: 'PAYMENT_IN',
          amount: money(r.amount),
          currency: r.currency,
          type: r.type,
          reference: r.txRef,
          paymentId: r.id,
          disbursementId: null,
        });
      }
    }

    if (!q.kind || q.kind === 'REFUND_OUT') {
      const where: Prisma.PaymentWhereInput = {
        refundStatus: 'REFUNDED',
        refundedAt: { gte: from, lte: to },
        ...(q.type ? { type: q.type } : {}),
      };
      const [rows, n] = await Promise.all([
        this.prisma.payment.findMany({
          where,
          orderBy: { refundedAt: 'desc' },
          take,
          select: {
            id: true,
            txRef: true,
            type: true,
            currency: true,
            refundAmount: true,
            refundReference: true,
            refundedAt: true,
          },
        }),
        this.prisma.payment.count({ where }),
      ]);
      counts.refund = n;
      for (const r of rows) {
        entries.push({
          at: r.refundedAt as Date,
          kind: 'REFUND_OUT',
          amount: money(r.refundAmount),
          currency: r.currency,
          type: r.type,
          reference: r.refundReference ?? r.txRef,
          paymentId: r.id,
          disbursementId: null,
        });
      }
    }

    if (!q.kind || q.kind === 'PAYOUT_OUT') {
      const where: Prisma.DisbursementWhereInput = {
        status: 'PAID_OUT',
        executedAt: { gte: from, lte: to },
        ...(q.type ? { allocation: { payment: { type: q.type } } } : {}),
      };
      const [rows, n] = await Promise.all([
        this.prisma.disbursement.findMany({
          where,
          orderBy: { executedAt: 'desc' },
          take,
          select: {
            id: true,
            reference: true,
            amount: true,
            currency: true,
            executedAt: true,
            allocation: { select: { paymentId: true, payment: { select: { type: true } } } },
          },
        }),
        this.prisma.disbursement.count({ where }),
      ]);
      counts.payout = n;
      for (const r of rows) {
        entries.push({
          at: r.executedAt as Date,
          kind: 'PAYOUT_OUT',
          amount: money(r.amount),
          currency: r.currency,
          type: r.allocation.payment.type,
          reference: r.reference,
          paymentId: r.allocation.paymentId,
          disbursementId: r.id,
        });
      }
    }

    entries.sort((a, b) => b.at.getTime() - a.at.getTime());
    const total = counts.in + counts.refund + counts.payout;

    return pageResult(entries.slice(skip, skip + limit), total, page, limit);
  }

  // BL-79. Totals for one UTC day. Compare these with the gateway statement.
  async dailyClose(q: DailyCloseQueryDto) {
    const day = q.date ? new Date(q.date) : new Date();
    if (Number.isNaN(day.getTime())) throw new BadRequestException('invalid_date');
    const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

    const [paid, refunded, payouts, failed, review, disputes] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { status: { in: ['PAID', 'REFUNDED'] }, paidAt: { gte: from, lt: to } },
        _sum: { amount: true, chapaFee: true },
        _count: { _all: true },
      }),
      this.prisma.payment.aggregate({
        where: { refundStatus: 'REFUNDED', refundedAt: { gte: from, lt: to } },
        _sum: { refundAmount: true },
        _count: { _all: true },
      }),
      this.prisma.disbursement.aggregate({
        where: { status: 'PAID_OUT', executedAt: { gte: from, lt: to } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.payment.count({
        where: { status: { in: ['FAILED', 'EXPIRED'] }, updatedAt: { gte: from, lt: to } },
      }),
      this.prisma.payment.count({ where: { status: PaymentStatus.REVIEW_REQUIRED } }),
      this.prisma.paymentDispute.count({ where: { status: 'OPEN' } }),
    ]);

    const collected = dec(paid._sum.amount);
    const fees = dec(paid._sum.chapaFee);
    const refundedAmount = dec(refunded._sum.refundAmount);
    const paidOut = dec(payouts._sum.amount);

    return {
      date: from.toISOString().slice(0, 10),
      collected: { count: paid._count._all, amount: money(collected) },
      gatewayFees: money(fees),
      refunded: { count: refunded._count._all, amount: money(refundedAmount) },
      paidOut: { count: payouts._count._all, amount: money(paidOut) },
      // Money that came in and has not gone out again today.
      netMovement: money(collected.sub(fees).sub(refundedAmount).sub(paidOut)),
      failedOrExpired: failed,
      // Open items that should be zero before the day is signed off.
      openReview: review,
      openDisputes: disputes,
    };
  }

  // BL-80. What the platform still owes each party.
  async liabilitiesByParty(q: LiabilitiesQueryDto) {
    const rows = await this.prisma.paymentAllocation.findMany({
      where: {
        payment: { status: 'PAID' },
        settlementStatus: q.settlementStatus ?? { in: ['PENDING', 'PARTIALLY_PAID_OUT'] },
        ...(q.partyType ? { partyType: q.partyType } : {}),
      },
      take: 10_000,
      select: {
        partyType: true,
        institutionId: true,
        amount: true,
        institution: { select: { name: true } },
        disbursements: { where: { status: 'PAID_OUT' }, select: { amount: true } },
      },
    });

    const groups = new Map<
      string,
      { partyType: string; institutionId: string | null; institutionName: string | null; owed: Prisma.Decimal; count: number }
    >();

    for (const r of rows) {
      const paidOut = r.disbursements.reduce((s, d) => s.add(d.amount), dec(0));
      const owed = r.amount.sub(paidOut);
      if (owed.lte(0)) continue;

      const key = `${r.partyType}:${r.institutionId ?? '-'}`;
      const g = groups.get(key) ?? {
        partyType: r.partyType,
        institutionId: r.institutionId,
        institutionName: r.institution?.name ?? null,
        owed: dec(0),
        count: 0,
      };
      g.owed = g.owed.add(owed);
      g.count += 1;
      groups.set(key, g);
    }

    const items = [...groups.values()]
      .sort((a, b) => b.owed.comparedTo(a.owed))
      .map((g) => ({ ...g, owed: money(g.owed) }));

    return {
      total: money(items.reduce((s, g) => s.add(g.owed), dec(0))),
      truncated: rows.length === 10_000,
      items,
    };
  }

  // ═════════════════════════════════════════════
  // CSV EXPORTS (audited)
  // ═════════════════════════════════════════════

  // BL-81
  async exportPayments(adminId: string, q: BillingExportQueryDto) {
    const { from, to } = resolveRange(q.from, q.to);
    const where: Prisma.PaymentWhereInput = {
      createdAt: { gte: from, lte: to },
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
    };

    const rows = await this.prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: MAX_EXPORT_ROWS + 1,
      select: {
        id: true,
        txRef: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        chapaFee: true,
        refundStatus: true,
        refundAmount: true,
        victimProfileId: true,
        missingPersonId: true,
        paidAt: true,
        createdAt: true,
      },
    });

    const truncated = rows.length > MAX_EXPORT_ROWS;
    const data = truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows;

    // Payer identity is not part of this export.
    const csv = toCsv(
      [
        'id', 'txRef', 'type', 'status', 'amount', 'currency', 'gatewayFee',
        'refundStatus', 'refundAmount', 'victimProfileId', 'missingPersonId', 'paidAt', 'createdAt',
      ],
      data.map((r) => [
        r.id, r.txRef, r.type, r.status, money(r.amount), r.currency,
        r.chapaFee ? money(r.chapaFee) : '', r.refundStatus ?? '',
        r.refundAmount ? money(r.refundAmount) : '', r.victimProfileId ?? '',
        r.missingPersonId ?? '', r.paidAt ?? '', r.createdAt,
      ]),
    );

    await this.auditExport(adminId, 'payments', data.length, truncated, { from, to, status: q.status, type: q.type });
    return { csv, rowCount: data.length, truncated };
  }

  // BL-82
  async exportDisbursements(adminId: string, q: BillingExportQueryDto) {
    const { from, to } = resolveRange(q.from, q.to);
    const where: Prisma.DisbursementWhereInput = {
      createdAt: { gte: from, lte: to },
      ...(q.disbursementStatus ? { status: q.disbursementStatus } : {}),
    };

    const rows = await this.prisma.disbursement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: MAX_EXPORT_ROWS + 1,
      select: {
        id: true,
        reference: true,
        externalReference: true,
        status: true,
        method: true,
        amount: true,
        currency: true,
        allocationId: true,
        rewardClaimId: true,
        createdById: true,
        approvedById: true,
        executedById: true,
        executedAt: true,
        createdAt: true,
      },
    });

    const truncated = rows.length > MAX_EXPORT_ROWS;
    const data = truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows;

    // Destination account numbers are never exported.
    const csv = toCsv(
      [
        'id', 'reference', 'externalReference', 'status', 'method', 'amount', 'currency',
        'allocationId', 'rewardClaimId', 'createdBy', 'approvedBy', 'executedBy', 'executedAt', 'createdAt',
      ],
      data.map((r) => [
        r.id, r.reference, r.externalReference ?? '', r.status, r.method, money(r.amount), r.currency,
        r.allocationId, r.rewardClaimId ?? '', r.createdById, r.approvedById ?? '',
        r.executedById ?? '', r.executedAt ?? '', r.createdAt,
      ]),
    );

    await this.auditExport(adminId, 'disbursements', data.length, truncated, {
      from, to, status: q.disbursementStatus,
    });
    return { csv, rowCount: data.length, truncated };
  }

  private async auditExport(
    adminId: string,
    what: string,
    rowCount: number,
    truncated: boolean,
    filter: Record<string, unknown>,
  ) {
    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.BILLING_EXPORTED,
      entityType: 'BillingExport',
      entityId: what,
      severity: AuditSeverity.WARNING,
      metadata: { rowCount, truncated, filter },
    });
  }

  // ═════════════════════════════════════════════
  // STATISTICS
  // ═════════════════════════════════════════════

  private paymentFilterSql(q: BillingStatsQueryDto): Prisma.Sql {
    const parts: Prisma.Sql[] = [];
    if (q.type) parts.push(Prisma.sql`AND p."type" = ${q.type}::"PaymentType"`);
    if (q.status) parts.push(Prisma.sql`AND p."status" = ${q.status}::"PaymentStatus"`);
    if (q.profileId) parts.push(Prisma.sql`AND p."victimProfileId" = ${q.profileId}`);
    if (q.institutionId) {
      parts.push(
        Prisma.sql`AND EXISTS (SELECT 1 FROM "payment_allocations" a WHERE a."paymentId" = p."id" AND a."institutionId" = ${q.institutionId})`,
      );
    }
    return parts.length ? Prisma.join(parts, ' ') : Prisma.empty;
  }

  // BL-85
  async timeline(q: BillingStatsQueryDto) {
    const { from, to } = resolveRange(q.from, q.to);
    const unit = truncUnit(q.granularity);

    // Defaults to money that was actually collected.
    const statusSql = q.status ? Prisma.empty : Prisma.sql`AND p."status" IN ('PAID','REFUNDED')`;

    const rows = await this.prisma.$queryRaw<
      Array<{ bucket: Date; count: number; amount: Prisma.Decimal; fees: Prisma.Decimal | null }>
    >(Prisma.sql`
      SELECT date_trunc(${unit}, p."paidAt") AS bucket,
             COUNT(*)::int AS count,
             COALESCE(SUM(p."amount"), 0) AS amount,
             SUM(p."chapaFee") AS fees
      FROM "payments" p
      WHERE p."paidAt" >= ${from} AND p."paidAt" <= ${to}
      ${statusSql}
      ${this.paymentFilterSql(q)}
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    return {
      granularity: unit,
      range: { from, to },
      points: rows.map((r) => ({
        bucket: r.bucket,
        count: r.count,
        amount: money(r.amount),
        gatewayFees: money(r.fees),
      })),
    };
  }

  // BL-86
  async byType(q: BillingStatsQueryDto) {
    const { from, to } = resolveRange(q.from, q.to);

    const rows = await this.prisma.payment.groupBy({
      by: ['type'],
      where: {
        status: { in: ['PAID', 'REFUNDED'] },
        paidAt: { gte: from, lte: to },
        ...(q.profileId ? { victimProfileId: q.profileId } : {}),
      },
      _sum: { amount: true, chapaFee: true },
      _count: { _all: true },
      orderBy: { type: 'asc' },
    });

    return {
      range: { from, to },
      items: rows.map((r) => ({
        type: r.type,
        count: r._count._all,
        amount: money(r._sum.amount),
        gatewayFees: money(r._sum.chapaFee),
      })),
    };
  }

  // BL-87. Gateway fees come from the payments, the platform share from the
  // PLATFORM allocations. Two small queries merged by bucket.
  async fees(q: BillingStatsQueryDto) {
    const { from, to } = resolveRange(q.from, q.to);
    const unit = truncUnit(q.granularity);

    const [gateway, platform] = await Promise.all([
      this.prisma.$queryRaw<Array<{ bucket: Date; fees: Prisma.Decimal | null }>>(Prisma.sql`
        SELECT date_trunc(${unit}, p."paidAt") AS bucket, SUM(p."chapaFee") AS fees
        FROM "payments" p
        WHERE p."status" IN ('PAID','REFUNDED')
          AND p."paidAt" >= ${from} AND p."paidAt" <= ${to}
          ${this.paymentFilterSql(q)}
        GROUP BY 1
      `),
      this.prisma.$queryRaw<Array<{ bucket: Date; share: Prisma.Decimal | null }>>(Prisma.sql`
        SELECT date_trunc(${unit}, p."paidAt") AS bucket, SUM(a."amount") AS share
        FROM "payment_allocations" a
        JOIN "payments" p ON p."id" = a."paymentId"
        WHERE a."partyType" = 'PLATFORM'::"PartyType"
          AND p."status" IN ('PAID','REFUNDED')
          AND p."paidAt" >= ${from} AND p."paidAt" <= ${to}
          ${this.paymentFilterSql(q)}
        GROUP BY 1
      `),
    ]);

    const buckets = new Map<number, { bucket: Date; gatewayFees: Prisma.Decimal; platformShare: Prisma.Decimal }>();
    const slot = (d: Date) => {
      const key = d.getTime();
      const existing = buckets.get(key);
      if (existing) return existing;
      const fresh = { bucket: d, gatewayFees: dec(0), platformShare: dec(0) };
      buckets.set(key, fresh);
      return fresh;
    };
    for (const g of gateway) slot(g.bucket).gatewayFees = dec(g.fees);
    for (const p of platform) slot(p.bucket).platformShare = dec(p.share);

    return {
      granularity: unit,
      points: [...buckets.values()]
        .sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
        .map((b) => ({
          bucket: b.bucket,
          gatewayFees: money(b.gatewayFees),
          platformShare: money(b.platformShare),
        })),
    };
  }

  // BL-88
  async failureRate(q: BillingStatsQueryDto) {
    const { from, to } = resolveRange(q.from, q.to);

    const rows = await this.prisma.payment.groupBy({
      by: ['type', 'status'],
      where: { createdAt: { gte: from, lte: to } },
      _count: { _all: true },
      orderBy: [{ type: 'asc' }, { status: 'asc' }],
    });

    const byType = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const m = byType.get(r.type) ?? {};
      m[r.status] = r._count._all;
      byType.set(r.type, m);
    }

    return {
      range: { from, to },
      items: [...byType.entries()].map(([type, counts]) => {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const failed = (counts.FAILED ?? 0) + (counts.EXPIRED ?? 0);
        return {
          type,
          total,
          failed,
          failureRatePercent: total ? Number(((failed / total) * 100).toFixed(2)) : 0,
          byStatus: counts,
        };
      }),
    };
  }

  // BL-89
  async refunds(q: BillingStatsQueryDto) {
    const { from, to } = resolveRange(q.from, q.to);
    const unit = truncUnit(q.granularity);

    const [points, byType, queue] = await Promise.all([
      this.prisma.$queryRaw<Array<{ bucket: Date; count: number; amount: Prisma.Decimal }>>(Prisma.sql`
        SELECT date_trunc(${unit}, p."refundedAt") AS bucket,
               COUNT(*)::int AS count,
               COALESCE(SUM(p."refundAmount"), 0) AS amount
        FROM "payments" p
        WHERE p."refundStatus" = 'REFUNDED'
          AND p."refundedAt" >= ${from} AND p."refundedAt" <= ${to}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      this.prisma.payment.groupBy({
        by: ['type'],
        where: { refundStatus: 'REFUNDED', refundedAt: { gte: from, lte: to } },
        _sum: { refundAmount: true },
        _count: { _all: true },
        orderBy: { type: 'asc' },
      }),
      this.prisma.payment.count({ where: { refundStatus: 'REQUESTED' } }),
    ]);

    return {
      granularity: unit,
      awaitingExecution: queue,
      points: points.map((p) => ({ bucket: p.bucket, count: p.count, amount: money(p.amount) })),
      byType: byType.map((t) => ({ type: t.type, count: t._count._all, amount: money(t._sum.refundAmount) })),
    };
  }

  // BL-90. Time from the payment being paid to the payout being paid.
  async disbursementTime(q: BillingStatsQueryDto) {
    const { from, to } = resolveRange(q.from, q.to);

    const [row] = await this.prisma.$queryRaw<
      Array<{ count: number; avg_h: number | null; p50_h: number | null; p90_h: number | null; max_h: number | null }>
    >(Prisma.sql`
      SELECT COUNT(*)::int AS count,
             AVG(EXTRACT(EPOCH FROM (d."executedAt" - p."paidAt")) / 3600) AS avg_h,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d."executedAt" - p."paidAt")) / 3600) AS p50_h,
             PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d."executedAt" - p."paidAt")) / 3600) AS p90_h,
             MAX(EXTRACT(EPOCH FROM (d."executedAt" - p."paidAt")) / 3600) AS max_h
      FROM "disbursements" d
      JOIN "payment_allocations" a ON a."id" = d."allocationId"
      JOIN "payments" p ON p."id" = a."paymentId"
      WHERE d."status" = 'PAID_OUT'
        AND d."executedAt" >= ${from} AND d."executedAt" <= ${to}
        AND p."paidAt" IS NOT NULL
    `);

    const round = (n: number | null) => (n === null ? null : Number(n.toFixed(1)));
    return {
      range: { from, to },
      count: row?.count ?? 0,
      hours: {
        average: round(row?.avg_h ?? null),
        median: round(row?.p50_h ?? null),
        p90: round(row?.p90_h ?? null),
        max: round(row?.max_h ?? null),
      },
    };
  }

  // BL-91
  async rewards(q: BillingStatsQueryDto) {
    const { from, to } = resolveRange(q.from, q.to);

    const [offers, claims, funded, paid] = await Promise.all([
      this.prisma.missingPerson.groupBy({
        by: ['rewardApproved'],
        where: { rewardOffered: true, createdAt: { gte: from, lte: to } },
        _count: { _all: true },
        _sum: { rewardAmount: true },
        orderBy: { rewardApproved: 'asc' },
      }),
      this.prisma.rewardClaim.groupBy({
        by: ['status'],
        where: { createdAt: { gte: from, lte: to } },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.payment.aggregate({
        where: { type: 'MISSING_PERSON_REWARD', status: 'PAID', paidAt: { gte: from, lte: to } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.rewardClaim.aggregate({
        where: { status: 'PAID_OUT', updatedAt: { gte: from, lte: to } },
        _sum: { rewardAmount: true },
        _count: { _all: true },
      }),
    ]);

    return {
      range: { from, to },
      offers: offers.map((o) => ({
        approved: o.rewardApproved,
        count: o._count._all,
        offeredAmount: money(o._sum.rewardAmount),
      })),
      claimsByStatus: claims.map((c) => ({ status: c.status, count: c._count._all })),
      funded: { count: funded._count._all, amount: money(funded._sum.amount) },
      paidToInformants: { count: paid._count._all, amount: money(paid._sum.rewardAmount) },
    };
  }

  // BL-92. Dashboard in one call: today, last 30 days, and open work.
  async overview() {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [today, month, review, disputes, refundsOpen, payoutsWaiting, payoutsFailed, claimsOpen, appealsOpen, held] =
      await Promise.all([
        this.prisma.payment.aggregate({
          where: { status: { in: ['PAID', 'REFUNDED'] }, paidAt: { gte: dayStart } },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        this.prisma.payment.aggregate({
          where: { status: { in: ['PAID', 'REFUNDED'] }, paidAt: { gte: monthStart } },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        this.prisma.payment.count({ where: { status: PaymentStatus.REVIEW_REQUIRED } }),
        this.prisma.paymentDispute.count({ where: { status: 'OPEN' } }),
        this.prisma.payment.count({ where: { refundStatus: 'REQUESTED' } }),
        this.prisma.disbursement.count({ where: { status: 'PENDING_APPROVAL' } }),
        this.prisma.disbursement.count({ where: { status: 'FAILED' } }),
        this.prisma.rewardClaim.count({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } }),
        this.prisma.rewardClaimAppeal.count({ where: { status: 'OPEN' } }),
        this.prisma.payment.count({ where: { heldAt: { not: null } } }),
      ]);

    return {
      today: { count: today._count._all, amount: money(today._sum.amount) },
      last30Days: { count: month._count._all, amount: money(month._sum.amount) },
      needsAttention: {
        paymentsInReview: review,
        openPaymentDisputes: disputes,
        refundsAwaitingExecution: refundsOpen,
        payoutsAwaitingApproval: payoutsWaiting,
        failedPayouts: payoutsFailed,
        rewardClaimsToReview: claimsOpen,
        rewardAppealsOpen: appealsOpen,
        paymentsOnHold: held,
      },
    };
  }
}

// src/modules/billing/service/disbursement-admin.service.ts
//
// Disbursement tools (BL-57 to BL-65). The four-eyes rules stay in
// DisbursementService: every create, approve and execute below goes through it.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditSeverity, Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditEventEnum } from '../../../common/enums/shared/audit-events.enum';

import { BillingEventsService } from './billing-events.service';
import { DisbursementService } from './disbursement.service';
import { money, pageArgs, pageResult } from './billing-admin.helpers';
import {
  BulkExecuteItemDto,
  FailedDisbursementsQueryDto,
  PagingDto,
} from '../dto/billing-admin.dto';

type BulkResult = { id: string; ok: boolean; error?: string };

@Injectable()
export class DisbursementAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly disbursements: DisbursementService,
    private readonly events: BillingEventsService,
  ) {}

  private errorText(err: unknown): string {
    const e = err as { message?: string };
    return e?.message ?? 'failed';
  }

  // BL-57. A failed disbursement is never revived. A new one is created for the
  // same allocation, which goes through approval again (creator cannot approve).
  async retry(adminId: string, id: string) {
    const d = await this.prisma.disbursement.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('disbursement_not_found');
    if (d.status !== 'FAILED') throw new BadRequestException('only_failed_disbursements_can_be_retried');

    const fresh = await this.disbursements.create(
      adminId,
      d.allocationId,
      d.method,
      d.rewardClaimId ?? undefined,
    );

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.DISBURSEMENT_RETRIED,
      entityType: 'Disbursement',
      entityId: id,
      metadata: { failedReason: d.failureReason, newDisbursementId: (fresh as { id?: string })?.id },
    });

    return fresh;
  }

  // BL-58
  async hold(adminId: string, id: string, reason: string) {
    const d = await this.prisma.disbursement.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('disbursement_not_found');
    if (d.heldAt) throw new ConflictException('already_on_hold');

    const { count } = await this.prisma.disbursement.updateMany({
      where: { id, heldAt: null, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } },
      data: { heldAt: new Date(), holdReason: reason, heldById: adminId },
    });
    if (count === 0) throw new BadRequestException('only_pending_or_approved_disbursements_can_be_held');

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.DISBURSEMENT_HELD,
      entityType: 'Disbursement',
      entityId: id,
      reason,
      severity: AuditSeverity.WARNING,
    });

    return { id, held: true };
  }

  // BL-59
  async release(adminId: string, id: string, reason: string) {
    const d = await this.prisma.disbursement.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('disbursement_not_found');
    if (!d.heldAt) throw new BadRequestException('not_on_hold');

    await this.prisma.disbursement.update({
      where: { id },
      data: { heldAt: null, holdReason: null, heldById: null },
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.DISBURSEMENT_RELEASED,
      entityType: 'Disbursement',
      entityId: id,
      reason,
      metadata: { heldById: d.heldById },
    });

    return { id, held: false };
  }

  // BL-61. Each item is approved on its own, so the creator rule applies per item.
  async bulkApprove(adminId: string, ids: string[]) {
    const results: BulkResult[] = [];
    for (const id of [...new Set(ids)]) {
      try {
        await this.disbursements.approve(adminId, id);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: this.errorText(err) });
      }
    }
    return { requested: results.length, succeeded: results.filter((r) => r.ok).length, results };
  }

  // BL-62. Items run one after another so one slow transfer never overlaps the next.
  async bulkExecute(adminId: string, items: BulkExecuteItemDto[]) {
    const results: BulkResult[] = [];
    const seen = new Set<string>();

    for (const item of items) {
      if (seen.has(item.id)) {
        results.push({ id: item.id, ok: false, error: 'duplicate_id_in_request' });
        continue;
      }
      seen.add(item.id);

      try {
        await this.disbursements.execute(adminId, item.id, {
          accountName: item.accountName,
          accountNumber: item.accountNumber,
          bankCode: item.bankCode,
          externalReference: item.externalReference,
        });
        results.push({ id: item.id, ok: true });
      } catch (err) {
        results.push({ id: item.id, ok: false, error: this.errorText(err) });
      }
    }
    return { requested: results.length, succeeded: results.filter((r) => r.ok).length, results };
  }

  // BL-63
  async timeline(id: string) {
    const d = await this.prisma.disbursement.findUnique({
      where: { id },
      select: {
        id: true,
        reference: true,
        status: true,
        method: true,
        amount: true,
        createdById: true,
        approvedById: true,
        executedById: true,
        executedAt: true,
        failureReason: true,
        heldAt: true,
        holdReason: true,
        createdAt: true,
      },
    });
    if (!d) throw new NotFoundException('disbursement_not_found');

    const audit = await this.prisma.auditLog.findMany({
      where: { entity: 'Disbursement', entityId: id },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, action: true, outcome: true, reason: true, userId: true },
    });

    return {
      disbursement: { ...d, amount: money(d.amount) },
      entries: audit.map((a) => ({
        at: a.createdAt,
        event: a.action,
        outcome: a.outcome,
        reason: a.reason,
        actorId: a.userId,
      })),
    };
  }

  // BL-64. Oldest first, so the queue is worked in order.
  async pendingApproval(q: PagingDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.DisbursementWhereInput = { status: 'PENDING_APPROVAL' };

    const [items, total] = await Promise.all([
      this.prisma.disbursement.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          reference: true,
          method: true,
          amount: true,
          currency: true,
          createdById: true,
          heldAt: true,
          createdAt: true,
          allocation: { select: { partyType: true, institutionId: true } },
        },
      }),
      this.prisma.disbursement.count({ where }),
    ]);

    return pageResult(
      items.map((i) => ({ ...i, amount: money(i.amount) })),
      total,
      page,
      limit,
    );
  }

  // BL-65
  async failed(q: FailedDisbursementsQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.DisbursementWhereInput = {
      status: 'FAILED',
      ...(q.from ? { createdAt: { gte: new Date(q.from) } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.disbursement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          reference: true,
          method: true,
          amount: true,
          failureReason: true,
          allocationId: true,
          rewardClaimId: true,
          createdAt: true,
        },
      }),
      this.prisma.disbursement.count({ where }),
    ]);

    return pageResult(
      items.map((i) => ({ ...i, amount: money(i.amount) })),
      total,
      page,
      limit,
    );
  }
}

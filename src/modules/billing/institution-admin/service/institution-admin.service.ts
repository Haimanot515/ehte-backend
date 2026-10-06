import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditSeverity, InstitutionStatus, PayoutRail, Prisma } from '@prisma/client';

import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditEventEnum } from '../../../../common/enums/shared/audit-events.enum';

import { BillingEventsService } from 'src/modules/billing/billing-events/service/billing-events.service';
import { maskTail, money, pageArgs, pageResult, resolveRange } from 'src/modules/billing/shared/billing-admin.helpers';
import { CreatePayoutDestinationDto, ExpiringAgreementsQueryDto, InstitutionsQueryDto, PayoutDestinationsQueryDto, StatementQueryDto, UpdateDraftAgreementDto, UpdateInstitutionDto, UpdatePayoutDestinationDto } from '../dto/institution-admin.dto';
import { PagingDto } from 'src/modules/billing/shared/dto/billing-common.dto';

const AGREEMENT_VERSION_MAX_ATTEMPTS = 5;

@Injectable()
export class InstitutionAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: BillingEventsService,
  ) {}

  // Account numbers and phones are never returned in full from list or detail views.
  private maskDestination<T extends { accountNumber: string | null; telebirrPhone: string | null }>(
    d: T,
  ) {
    return {
      ...d,
      accountNumber: maskTail(d.accountNumber),
      telebirrPhone: maskTail(d.telebirrPhone),
    };
  }

  private async loadInstitution(id: string) {
    const i = await this.prisma.institution.findUnique({ where: { id } });
    if (!i) throw new NotFoundException('institution_not_found');
    return i;
  }

  // BL-37
  async listInstitutions(q: InstitutionsQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.InstitutionWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.institution.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          _count: { select: { agreements: true, payoutDestinations: true, allocations: true } },
        },
      }),
      this.prisma.institution.count({ where }),
    ]);

    return pageResult(items, total, page, limit);
  }

  // BL-38
  async getInstitution(id: string) {
    const i = await this.prisma.institution.findUnique({
      where: { id },
      include: {
        agreements: {
          orderBy: [{ type: 'asc' }, { version: 'desc' }],
          select: {
            id: true,
            type: true,
            version: true,
            status: true,
            effectiveFrom: true,
            effectiveTo: true,
          },
        },
        payoutDestinations: true,
      },
    });
    if (!i) throw new NotFoundException('institution_not_found');

    return { ...i, payoutDestinations: i.payoutDestinations.map((d) => this.maskDestination(d)) };
  }

  // BL-39
  async updateInstitution(adminId: string, id: string, dto: UpdateInstitutionDto) {
    const before = await this.loadInstitution(id);

    const updated = await this.prisma.institution.update({
      where: { id },
      data: { name: dto.name },
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.INSTITUTION_UPDATED,
      entityType: 'Institution',
      entityId: id,
      entityLabel: dto.name,
      metadata: { before: before.name, after: dto.name },
    });

    return updated;
  }

  async deactivate(adminId: string, id: string, reason: string) {
    const i = await this.loadInstitution(id);
    if (i.status === InstitutionStatus.SUSPENDED) throw new ConflictException('already_suspended');

    await this.prisma.institution.update({
      where: { id },
      data: { status: InstitutionStatus.SUSPENDED },
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.INSTITUTION_DEACTIVATED,
      entityType: 'Institution',
      entityId: id,
      entityLabel: i.name,
      reason,
      severity: AuditSeverity.WARNING,
      metadata: { previousStatus: i.status },
    });

    return { id, status: InstitutionStatus.SUSPENDED };
  }

  // BL-41
  async reactivate(adminId: string, id: string, reason: string) {
    const i = await this.loadInstitution(id);
    if (i.status !== InstitutionStatus.SUSPENDED) throw new BadRequestException('not_suspended');

    // Goes back to the state it had earned: signed if it ever signed, else prospect.
    const status = i.signedAt ? InstitutionStatus.AGREEMENT_SIGNED : InstitutionStatus.PROSPECT;
    await this.prisma.institution.update({ where: { id }, data: { status } });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.INSTITUTION_REACTIVATED,
      entityType: 'Institution',
      entityId: id,
      entityLabel: i.name,
      reason,
      metadata: { newStatus: status },
    });

    return { id, status };
  }

  // BL-42
  async statement(id: string, q: StatementQueryDto) {
    const i = await this.loadInstitution(id);
    const { from, to } = resolveRange(q.from, q.to);

    const [allocated, paid, pending, disbursements] = await Promise.all([
      this.prisma.paymentAllocation.aggregate({
        where: { institutionId: id, payment: { status: 'PAID', paidAt: { gte: from, lte: to } } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.disbursement.aggregate({
        where: {
          allocation: { institutionId: id },
          status: 'PAID_OUT',
          executedAt: { gte: from, lte: to },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.paymentAllocation.aggregate({
        where: {
          institutionId: id,
          settlementStatus: { in: ['PENDING', 'PARTIALLY_PAID_OUT'] },
          payment: { status: 'PAID' },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.disbursement.findMany({
        where: { allocation: { institutionId: id }, executedAt: { gte: from, lte: to } },
        orderBy: { executedAt: 'desc' },
        take: 200,
        select: {
          id: true,
          reference: true,
          status: true,
          amount: true,
          method: true,
          executedAt: true,
        },
      }),
    ]);

    return {
      institution: { id: i.id, name: i.name, status: i.status },
      range: { from, to },
      allocated: { count: allocated._count._all, amount: money(allocated._sum.amount) },
      paidOut: { count: paid._count._all, amount: money(paid._sum.amount) },
      stillOwed: { count: pending._count._all, amount: money(pending._sum.amount) },
      disbursements: disbursements.map((d) => ({ ...d, amount: money(d.amount) })),
    };
  }

  // BL-43. Profiles reach an institution through the agreement they use.
  async profiles(id: string, q: PagingDto) {
    await this.loadInstitution(id);
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.VictimProfileWhereInput = { agreement: { institutionId: id } };

    const [items, total] = await Promise.all([
      this.prisma.victimProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          status: true,
          isPublished: true,
          totalRaised: true,
          agreementId: true,
        },
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return pageResult(items, total, page, limit);
  }

  // BL-44
  async getAgreement(id: string) {
    const a = await this.prisma.agreement.findUnique({
      where: { id },
      include: { rules: true, institution: { select: { id: true, name: true, status: true } } },
    });
    if (!a) throw new NotFoundException('agreement_not_found');
    return a;
  }

  // BL-45. Only a draft can change. Activation makes an agreement immutable.
  async updateDraft(adminId: string, id: string, dto: UpdateDraftAgreementDto) {
    const a = await this.prisma.agreement.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('agreement_not_found');
    if (a.status !== 'DRAFT') throw new BadRequestException('only_drafts_can_be_edited');

    const data: Prisma.AgreementUpdateInput = {
      ...(dto.effectiveFrom ? { effectiveFrom: dto.effectiveFrom } : {}),
      ...(dto.effectiveTo ? { effectiveTo: dto.effectiveTo } : {}),
      ...(dto.refundPolicy !== undefined ? { refundPolicy: dto.refundPolicy } : {}),
      ...(dto.cancellationPolicy !== undefined
        ? { cancellationPolicy: dto.cancellationPolicy }
        : {}),
    };
    if (Object.keys(data).length === 0) throw new BadRequestException('nothing_to_update');

    const { count } = await this.prisma.agreement.updateMany({
      where: { id, status: 'DRAFT' },
      data: data as Prisma.AgreementUpdateManyMutationInput,
    });
    if (count === 0) throw new ConflictException('agreement_is_no_longer_a_draft');

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.AGREEMENT_UPDATED,
      entityType: 'Agreement',
      entityId: id,
      metadata: { fields: Object.keys(data) },
    });

    return this.getAgreement(id);
  }

  // BL-46. Copies any agreement (usually the active one) into a new draft
  // version for renewal. Rules are copied as they are.
  async cloneAgreement(adminId: string, id: string) {
    const source = await this.prisma.agreement.findUnique({
      where: { id },
      include: { rules: true },
    });
    if (!source) throw new NotFoundException('agreement_not_found');

    for (let attempt = 1; attempt <= AGREEMENT_VERSION_MAX_ATTEMPTS; attempt++) {
      const last = await this.prisma.agreement.findFirst({
        where: { type: source.type, institutionId: source.institutionId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      try {
        const created = await this.prisma.agreement.create({
          data: {
            type: source.type,
            institutionId: source.institutionId,
            version: (last?.version ?? 0) + 1,
            currency: source.currency,
            // The new draft starts when the old one ends, or now.
            effectiveFrom: source.effectiveTo ?? new Date(),
            refundPolicy: source.refundPolicy,
            cancellationPolicy: source.cancellationPolicy,
            rules: {
              create: source.rules.map((r) => ({
                paymentType: r.paymentType,
                partyType: r.partyType,
                institutionId: r.institutionId,
                mode: r.mode,
                valueBps: r.valueBps,
                flatAmount: r.flatAmount,
              })),
            },
          },
          include: { rules: true },
        });

        await this.events.log({
          actorId: adminId,
          action: AuditEventEnum.AGREEMENT_CLONED,
          entityType: 'Agreement',
          entityId: created.id,
          metadata: { clonedFrom: id, version: created.version },
        });

        return created;
      } catch (err) {
        const lostRace =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (!lostRace || attempt === AGREEMENT_VERSION_MAX_ATTEMPTS) throw err;
      }
    }
    throw new Error('failed_to_generate_unique_agreement_version');
  }

  // BL-47
  async versions(id: string) {
    const a = await this.prisma.agreement.findUnique({
      where: { id },
      select: { type: true, institutionId: true },
    });
    if (!a) throw new NotFoundException('agreement_not_found');

    return this.prisma.agreement.findMany({
      where: { type: a.type, institutionId: a.institutionId },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        status: true,
        effectiveFrom: true,
        effectiveTo: true,
        approvedById: true,
        retiredAt: true,
        retirementReason: true,
        createdAt: true,
      },
    });
  }

  // BL-48
  async agreementProfiles(id: string, q: PagingDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.VictimProfileWhereInput = { agreementId: id };

    const [items, total] = await Promise.all([
      this.prisma.victimProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { id: true, name: true, status: true, isPublished: true, totalRaised: true },
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return pageResult(items, total, page, limit);
  }

  // BL-49
  async expiring(q: ExpiringAgreementsQueryDto) {
    const days = q.days ?? 30;
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const items = await this.prisma.agreement.findMany({
      where: { status: 'ACTIVE', effectiveTo: { not: null, lte: until } },
      orderBy: { effectiveTo: 'asc' },
      select: {
        id: true,
        type: true,
        version: true,
        institutionId: true,
        effectiveTo: true,
        institution: { select: { name: true } },
      },
    });

    return {
      days,
      items: items.map((a) => ({
        ...a,
        daysLeft: Math.ceil(((a.effectiveTo as Date).getTime() - Date.now()) / 86_400_000),
      })),
    };
  }

  // BL-50
  async listDestinations(q: PayoutDestinationsQueryDto) {
    const { page, limit, skip } = pageArgs(q);
    const where: Prisma.PayoutDestinationWhereInput = {
      ...(q.institutionId ? { institutionId: q.institutionId } : {}),
      ...(q.verified ? { isVerified: q.verified === 'true' } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.payoutDestination.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.payoutDestination.count({ where }),
    ]);

    return pageResult(
      items.map((d) => this.maskDestination(d)),
      total,
      page,
      limit,
    );
  }

  private assertDestinationFields(
    rail: PayoutRail,
    f: { bankName?: string | null; accountNumber?: string | null; telebirrPhone?: string | null },
  ) {
    if (rail === PayoutRail.BANK && (!f.bankName || !f.accountNumber)) {
      throw new BadRequestException('bank_name_and_account_number_are_required');
    }
    if (rail === PayoutRail.TELEBIRR && !f.telebirrPhone) {
      throw new BadRequestException('telebirr_phone_is_required');
    }
  }

  // BL-51
  async createDestination(adminId: string, institutionId: string, dto: CreatePayoutDestinationDto) {
    const inst = await this.loadInstitution(institutionId);
    this.assertDestinationFields(dto.rail, dto);

    const created = await this.prisma.payoutDestination.create({
      data: {
        institutionId,
        rail: dto.rail,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        telebirrPhone: dto.telebirrPhone,
        accountHolder: dto.accountHolder,
        isVerified: false,
        lastEditedById: adminId,
      },
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYOUT_DESTINATION_CREATED,
      entityType: 'PayoutDestination',
      entityId: created.id,
      entityLabel: inst.name,
      metadata: {
        rail: created.rail,
        accountNumber: maskTail(created.accountNumber),
        telebirrPhone: maskTail(created.telebirrPhone),
      },
    });

    return this.maskDestination(created);
  }

  // BL-52. Any edit clears verification.
  async updateDestination(adminId: string, id: string, dto: UpdatePayoutDestinationDto) {
    const before = await this.prisma.payoutDestination.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('payout_destination_not_found');

    const next = {
      bankName: dto.bankName ?? before.bankName,
      accountNumber: dto.accountNumber ?? before.accountNumber,
      telebirrPhone: dto.telebirrPhone ?? before.telebirrPhone,
    };
    this.assertDestinationFields(before.rail, next);

    const pending = await this.prisma.disbursement.count({
      where: { payoutDestinationId: id, status: { in: ['APPROVED', 'PROCESSING'] } },
    });
    if (pending > 0) throw new ConflictException('destination_has_payouts_in_progress');

    const updated = await this.prisma.payoutDestination.update({
      where: { id },
      data: {
        ...next,
        ...(dto.accountHolder ? { accountHolder: dto.accountHolder } : {}),
        isVerified: false,
        verifiedById: null,
        verifiedAt: null,
        verifiedNote: null,
        lastEditedById: adminId,
      },
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYOUT_DESTINATION_UPDATED,
      entityType: 'PayoutDestination',
      entityId: id,
      reason: dto.reason,
      severity: AuditSeverity.WARNING,
      metadata: {
        wasVerified: before.isVerified,
        before: {
          accountNumber: maskTail(before.accountNumber),
          telebirrPhone: maskTail(before.telebirrPhone),
          accountHolder: before.accountHolder,
        },
        after: {
          accountNumber: maskTail(updated.accountNumber),
          telebirrPhone: maskTail(updated.telebirrPhone),
          accountHolder: updated.accountHolder,
        },
      },
    });

    return this.maskDestination(updated);
  }

  // BL-53. The verifier cannot be the person who last edited the destination.
  async verifyDestination(adminId: string, id: string, note?: string) {
    const d = await this.prisma.payoutDestination.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('payout_destination_not_found');
    if (d.isVerified) throw new ConflictException('already_verified');
    if (d.lastEditedById && d.lastEditedById === adminId) {
      throw new ForbiddenException('verifier_must_differ_from_the_last_editor');
    }

    const { count } = await this.prisma.payoutDestination.updateMany({
      where: { id, isVerified: false },
      data: {
        isVerified: true,
        verifiedById: adminId,
        verifiedAt: new Date(),
        verifiedNote: note ?? null,
      },
    });
    if (count === 0) throw new ConflictException('already_verified');

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYOUT_DESTINATION_VERIFIED,
      entityType: 'PayoutDestination',
      entityId: id,
      reason: note ?? null,
      metadata: { accountNumber: maskTail(d.accountNumber), editedById: d.lastEditedById },
    });

    return { id, isVerified: true };
  }

  // BL-54
  async unverifyDestination(adminId: string, id: string, reason: string) {
    const d = await this.prisma.payoutDestination.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('payout_destination_not_found');
    if (!d.isVerified) throw new BadRequestException('not_verified');

    await this.prisma.payoutDestination.update({
      where: { id },
      data: { isVerified: false, verifiedById: null, verifiedAt: null, verifiedNote: null },
    });

    await this.events.log({
      actorId: adminId,
      action: AuditEventEnum.PAYOUT_DESTINATION_UNVERIFIED,
      entityType: 'PayoutDestination',
      entityId: id,
      reason,
      severity: AuditSeverity.WARNING,
    });

    return { id, isVerified: false };
  }

  // BL-55. Reads the audit rows we wrote above; they hold masked values only.
  async destinationHistory(id: string) {
    const d = await this.prisma.payoutDestination.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!d) throw new NotFoundException('payout_destination_not_found');

    return this.prisma.auditLog.findMany({
      where: { entity: 'PayoutDestination', entityId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        action: true,
        outcome: true,
        reason: true,
        userId: true,
        metadata: true,
      },
    });
  }
}

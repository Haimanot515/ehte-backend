// src/modules/billing/service/agreement.service.ts
//
// Agreements drive every payment split. Rules:
//   - a DRAFT can be created freely; once ACTIVE it is immutable
//   - to change terms, create a new version and re-point the profile
//   - RECIPIENT is never a rule (it is the remainder)
//   - an institution must be AGREEMENT_SIGNED before it can be used in an agreement

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PartyType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateAgreementDto } from '../dto/agreement.dto';
import { BillingEventsService } from './billing-events.service';

@Injectable()
export class AgreementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: BillingEventsService,
  ) {}

  // ── Institutions ──────────────────────────────────────────────────────────

  createInstitution(name: string) {
    return this.prisma.institution.create({ data: { name } });
  }

  async markSigned(adminId: string, id: string) {
    const { count } = await this.prisma.institution.updateMany({
      where: { id, status: 'PROSPECT' },
      data: { status: 'AGREEMENT_SIGNED', signedAt: new Date() },
    });
    if (count === 0) throw new BadRequestException('Institution is not a prospect');
    await this.events.log({ actorId: adminId, action: 'INSTITUTION_SIGNED', entityType: 'Institution', entityId: id });
  }

  // ── Agreements ────────────────────────────────────────────────────────────

  async createDraft(adminId: string, dto: CreateAgreementDto) {
    if (dto.type !== 'DIRECT' && !dto.institutionId) {
      throw new BadRequestException('institutionId is required for this agreement type');
    }
    if (dto.institutionId) await this.assertSigned(dto.institutionId);

    let bpsBySupport = 0;
    for (const r of dto.rules) {
      if (r.partyType === PartyType.RECIPIENT) {
        throw new BadRequestException('RECIPIENT cannot be a rule; it is the remainder');
      }
      if (r.mode === 'PERCENT_BPS') {
        if (!r.valueBps) throw new BadRequestException('valueBps is required for PERCENT_BPS');
        if (r.paymentType === 'SUPPORT') bpsBySupport += r.valueBps;
      } else if (!r.flatAmount || Number(r.flatAmount) <= 0) {
        throw new BadRequestException('flatAmount is required for FLAT');
      }
      if (r.partyType === PartyType.RESPONSIBLE_ORGANIZATION) {
        if (!r.institutionId) throw new BadRequestException('Organization rules need institutionId');
        await this.assertSigned(r.institutionId);
      }
    }
    if (bpsBySupport >= 10_000) {
      throw new BadRequestException('Percentage rules must total less than 100%');
    }

    const last = await this.prisma.agreement.findFirst({
      where: { type: dto.type, institutionId: dto.institutionId ?? null },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const agreement = await this.prisma.agreement.create({
      data: {
        type: dto.type,
        institutionId: dto.institutionId,
        version: (last?.version ?? 0) + 1,
        effectiveFrom: dto.effectiveFrom,
        effectiveTo: dto.effectiveTo,
        rules: {
          create: dto.rules.map((r) => ({
            paymentType: r.paymentType,
            partyType: r.partyType,
            institutionId: r.institutionId,
            mode: r.mode,
            valueBps: r.valueBps,
            flatAmount: r.flatAmount ? new Prisma.Decimal(r.flatAmount) : null,
          })),
        },
      },
      include: { rules: true },
    });
    await this.events.log({ actorId: adminId, action: 'AGREEMENT_CREATED', entityType: 'Agreement', entityId: agreement.id });
    return agreement;
  }

  /** Activation is the point of no return: the agreement becomes immutable. */
  async activate(adminId: string, id: string) {
    const a = await this.prisma.agreement.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Agreement not found');
    if (a.institutionId) await this.assertSigned(a.institutionId);

    const { count } = await this.prisma.agreement.updateMany({
      where: { id, status: 'DRAFT' },
      data: { status: 'ACTIVE', approvedById: adminId },
    });
    if (count === 0) throw new BadRequestException('Only drafts can be activated');
    await this.events.log({ actorId: adminId, action: 'AGREEMENT_ACTIVATED', entityType: 'Agreement', entityId: id });
  }

  async retire(adminId: string, id: string) {
    const { count } = await this.prisma.agreement.updateMany({
      where: { id, status: 'ACTIVE' },
      data: { status: 'RETIRED', effectiveTo: new Date() },
    });
    if (count === 0) throw new BadRequestException('Only active agreements can be retired');
    await this.events.log({ actorId: adminId, action: 'AGREEMENT_RETIRED', entityType: 'Agreement', entityId: id });
  }

  /**
   * PRD section 22: the split depends on the agreement for each case, so every profile that
   * can receive support needs one. Only while UNPUBLISHED: supporters must not see a split
   * change under a live profile. Existing Supports keep the snapshot they were created with.
   */
  async assignToProfile(adminId: string, profileId: string, agreementId: string) {
    const agreement = await this.prisma.agreement.findFirst({
      where: { id: agreementId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!agreement) throw new BadRequestException('Agreement is not active');

    const profile = await this.prisma.victimProfile.findUnique({
      where: { id: profileId },
      select: { id: true, name: true, involvesChild: true, isPublished: true, agreementId: true },
    });
    if (!profile) throw new NotFoundException('victim_profile_not_found');
    if (profile.isPublished) throw new BadRequestException('unpublish_profile_before_changing_agreement');

    const { count } = await this.prisma.victimProfile.updateMany({
      where: { id: profileId, isPublished: false },
      data: { agreementId },
    });
    if (count === 0) throw new BadRequestException('victim_profile_transition_conflict');

    await this.events.log({
      actorId: adminId,
      action: 'VICTIM_PROFILE_AGREEMENT_ASSIGNED',
      entityType: 'VictimProfile',
      entityId: profileId,
      // Same rule as VictimProfileService.profileLabel: a child's name never lands in the audit table.
      entityLabel: profile.involvesChild ? `Child profile ${profile.id.slice(0, 8)}` : (profile.name ?? null),
      metadata: { previousAgreementId: profile.agreementId, agreementId },
    });
  }

  list() {
    return this.prisma.agreement.findMany({
      orderBy: { createdAt: 'desc' },
      include: { rules: true, institution: { select: { id: true, name: true, status: true } } },
    });
  }

  private async assertSigned(institutionId: string) {
    const inst = await this.prisma.institution.findUnique({
      where: { id: institutionId },
      select: { status: true },
    });
    if (inst?.status !== 'AGREEMENT_SIGNED') {
      throw new BadRequestException('Institution has no signed agreement');
    }
  }
}

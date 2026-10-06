import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditSeverity, InformationStatus, RewardClaimStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  InformationPaginationQueryDto,
  ListInformationSubmissionsQueryDto,
} from '../dto/information-submission.dto';
import { TERMINAL_STATUSES } from './information-submission.constants';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionAdminOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

  async findAllForAdmin(query: ListInformationSubmissionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      deletedAt: null, // NEW (soft delete)
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // Pulls the tipster's name and phone; not yet audited (needs an acting-admin param and enum member).
  async findOneForAdmin(id: string) {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        missingPerson: true,
      },
    });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    return submission;
  }

  // Flags PENDING/UNDER_REVIEW submissions older than the configured stale window.
  async findStalePending() {
    const staleHours = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_STALE_PENDING_HOURS') ??
        this.configService.get<string>('CONTENT_STALE_PENDING_HOURS') ??
        48,
    );
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

    const submissions = await this.prisma.informationSubmission.findMany({
      where: {
        status: { in: [InformationStatus.PENDING, InformationStatus.UNDER_REVIEW] },
        createdAt: { lt: cutoff },
        deletedAt: null, // NEW (soft delete)
      },
      orderBy: { createdAt: 'asc' },
    });

    return submissions.map((s) => ({
      ...s,
      pendingHours: Math.floor((Date.now() - s.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
  }

  async getHistory(id: string) {
    await this.findOneForAdmin(id);

    return this.prisma.auditLog.findMany({
      where: { entity: 'InformationSubmission', entityId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 3),
    );
  }

  async findRelated(id: string) {
    const base = await this.informationSubmissionCommonService.findLiveOrThrow(id);

    const others = await this.prisma.informationSubmission.findMany({
      where: { missingPersonId: base.missingPersonId, id: { not: id }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        id: true,
        information: true,
        location: true,
        status: true,
        resolution: true,
        createdAt: true,
      },
    });

    const baseTokens = this.tokenize(`${base.information} ${base.location ?? ''}`);
    const minScore = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_RELATED_MIN_SCORE') ?? 0.15,
    );

    return others
      .map((o) => {
        const tokens = this.tokenize(`${o.information} ${o.location ?? ''}`);
        const shared = [...baseTokens].filter((t) => tokens.has(t));
        const union = new Set([...baseTokens, ...tokens]).size;
        const sameLocation =
          !!base.location &&
          !!o.location &&
          base.location.trim().toLowerCase() === o.location.trim().toLowerCase();
        const score = union === 0 ? 0 : shared.length / union + (sameLocation ? 0.1 : 0);
        return {
          id: o.id,
          status: o.status,
          resolution: o.resolution,
          createdAt: o.createdAt,
          similarity: Math.round(Math.min(score, 1) * 100) / 100,
          sameLocation,
          sharedTerms: shared.slice(0, 10),
          preview: o.information.length > 160 ? `${o.information.slice(0, 160)}…` : o.information,
        };
      })
      .filter((r) => r.similarity >= minScore)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 10);
  }

  async getRevisions(id: string, query: InformationPaginationQueryDto) {
    const exists = await this.prisma.informationSubmission.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('information_submission_not_found');
    }

    const { page, limit, skip } = this.informationSubmissionCommonService.pageArgs(query);
    const where = { submissionId: id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationRevision.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationRevision.count({ where }),
    ]);

    const names = await this.informationSubmissionCommonService.userNameMap(
      rows.map((r) => r.actorId),
    );

    return {
      data: rows.map((r) => ({
        id: r.id,
        field: r.field,
        oldValue: r.oldValue,
        newValue: r.newValue,
        reason: r.reason,
        at: r.createdAt,
        actor: r.actorId ? { id: r.actorId, name: names.get(r.actorId) ?? null } : null,
      })),
      meta: this.informationSubmissionCommonService.pageMeta(page, limit, total),
    };
  }

  async setLegalHold(admin: CurrentUserDto, id: string, legalHold: boolean, reason: string) {
    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });
    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    const text = reason.trim();
    if (!text) {
      throw new BadRequestException('reason_required');
    }

    if (submission.legalHold === legalHold) {
      return submission;
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: legalHold
        ? {
            legalHold: true,
            legalHoldReason: text,
            legalHoldAt: new Date(),
            legalHoldById: admin.id,
          }
        : { legalHold: false, legalHoldReason: null, legalHoldAt: null, legalHoldById: null },
    });

    await this.informationSubmissionCommonService.recordRevisions(
      id,
      admin.id,
      [{ field: 'legalHold', oldValue: submission.legalHold, newValue: legalHold }],
      text,
    );

    this.informationSubmissionCommonService.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_LEGAL_HOLD_CHANGED,
      submission,
      severity: AuditSeverity.CRITICAL,
      reason: text,
      diff: { previousLegalHold: submission.legalHold, newLegalHold: legalHold, result: 'success' },
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return updated;
  }

  async removeByAdmin(admin: CurrentUserDto, id: string, reason: string) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);
    this.informationSubmissionCommonService.assertNoLegalHold(submission);

    const text = reason.trim();
    if (!text) {
      throw new BadRequestException('reason_required');
    }

    await this.prisma.informationSubmission.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById: admin.id, deleteReason: text },
    });

    await this.cache.invalidateInformationSubmissionList(submission.missingPersonId);

    this.informationSubmissionCommonService.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_SOFT_DELETED,
      submission,
      severity: AuditSeverity.WARNING,
      reason: text,
      diff: { previousStatus: submission.status, result: 'success' },
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return { message: 'information_submission_removed' };
  }

  async restore(admin: CurrentUserDto, id: string, reason?: string) {
    const submission = await this.prisma.informationSubmission.findUnique({ where: { id } });
    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }
    if (!submission.deletedAt) {
      throw new BadRequestException('information_submission_not_deleted');
    }

    const updated = await this.prisma.informationSubmission.update({
      where: { id },
      data: { deletedAt: null, deletedById: null, deleteReason: null },
    });

    await this.cache.invalidateInformationSubmissionList(submission.missingPersonId);

    this.informationSubmissionCommonService.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_RESTORED,
      submission,
      severity: AuditSeverity.WARNING,
      reason: reason?.trim() || null,
      diff: { result: 'success' },
      metadata: { missingPersonId: submission.missingPersonId },
    });

    return updated;
  }

  async listTrash(query: InformationPaginationQueryDto) {
    const { page, limit, skip } = this.informationSubmissionCommonService.pageArgs(query);
    const where = { deletedAt: { not: null } };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: { missingPerson: { select: { id: true, name: true, personType: true } } },
        orderBy: { deletedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    const names = await this.informationSubmissionCommonService.userNameMap(
      rows.map((r) => r.deletedById),
    );

    return {
      data: rows.map((r) => ({
        ...r,
        deletedBy: r.deletedById
          ? { id: r.deletedById, name: names.get(r.deletedById) ?? null }
          : null,
      })),
      meta: this.informationSubmissionCommonService.pageMeta(page, limit, total),
    };
  }

  async anonymize(admin: CurrentUserDto, id: string, reason: string) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);

    const text = reason.trim();
    if (!text) {
      throw new BadRequestException('reason_required');
    }

    if (!TERMINAL_STATUSES.includes(submission.status)) {
      throw new BadRequestException('submission_not_closed');
    }
    this.informationSubmissionCommonService.assertNoLegalHold(submission);

    if (submission.anonymizedAt) {
      return submission;
    }

    const releasable: RewardClaimStatus[] = [
      RewardClaimStatus.INVALID,
      RewardClaimStatus.DUPLICATE,
      RewardClaimStatus.ALREADY_KNOWN,
      RewardClaimStatus.INELIGIBLE,
      RewardClaimStatus.REJECTED,
      RewardClaimStatus.REFUNDED,
    ];
    const activeClaims = await this.prisma.rewardClaim.count({
      where: { informationSubmissionId: id, status: { notIn: releasable } },
    });
    if (activeClaims > 0) {
      throw new BadRequestException('reward_claim_in_progress');
    }

    const informantId = submission.userId;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (informantId) {
        await tx.informationAppeal.updateMany({
          where: { submissionId: id, userId: informantId },
          data: { userId: null },
        });
        await tx.informationTimelineEvent.updateMany({
          where: { submissionId: id, actorId: informantId },
          data: { actorId: null },
        });
        await tx.informationRevision.updateMany({
          where: { submissionId: id, actorId: informantId },
          data: { actorId: null },
        });
        await tx.informationIdentityAccess.updateMany({
          where: { submissionId: id, informantId },
          data: { informantId: null },
        });
      }

      return tx.informationSubmission.update({
        where: { id },
        data: {
          userId: null,
          idempotencyKey: null,
          anonymizedAt: new Date(),
          anonymizedById: admin.id,
        },
      });
    });

    this.informationSubmissionCommonService.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_ANONYMIZED,
      submission: { id: submission.id, information: submission.information },
      severity: AuditSeverity.CRITICAL,
      reason: text,
      diff: { result: 'success' },
      metadata: { missingPersonId: submission.missingPersonId },
      omitTarget: true,
    });

    return updated;
  }
}

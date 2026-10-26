import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditSeverity,
  MissingPerson,
  MissingPersonAppealState,
  MissingPersonFlagState,
  MissingPersonMessageKind,
  MissingPersonStatus,
  Prisma,
} from '@prisma/client';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  DecideMissingPersonAppealDto,
  ListMissingPersonAppealsQueryDto,
  ListMissingPersonFlagsQueryDto,
  MissingPersonAppealDecision,
  MissingPersonFlagAction,
  ResolveMissingPersonFlagDto,
} from '../dto/missing-person.dto';
import { TERMINAL_STATUSES } from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

  // Stamps ownerSuspendedAt only; status and review queue are unchanged.
  @OnEvent('user.suspended')
  async handleUserSuspended(payload: { userId: string }): Promise<void> {
    const now = new Date();

    const { count } = await this.prisma.missingPerson.updateMany({
      where: {
        userId: payload.userId,
        status: { notIn: TERMINAL_STATUSES },
        ownerSuspendedAt: null,
      },
      data: { ownerSuspendedAt: now },
    });

    const suspendedUser = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      select: { name: true },
    });

    this.missingPersonCommonService.emitAudit({
      targetUserId: payload.userId,
      actorType: 'SYSTEM',
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'User',
      entityId: payload.userId,
      entityLabel: suspendedUser?.name ?? undefined,
      diff: { reason: 'owner_account_suspended', result: 'success' },
      metadata: { casesFlagged: count },
    });
  }

  // DTO enums and Prisma enums share string values but are different TS types.
  private asEnum<T extends string>(value: string | undefined): T | undefined {
    return value as T | undefined;
  }

  async listFlags(query: ListMissingPersonFlagsQueryDto) {
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const where: Prisma.MissingPersonFlagWhereInput = {
      ...(query.status ? { status: this.asEnum<MissingPersonFlagState>(query.status) } : {}),
      ...(query.reason ? { reason: query.reason } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPersonFlag.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: {
          missingPerson: { select: { id: true, name: true, personType: true, status: true } },
          reporter: { select: { id: true, name: true } },
        },
      }),
      this.prisma.missingPersonFlag.count({ where }),
    ]);

    return {
      data: rows.map(({ missingPerson, ...flag }) => ({
        ...flag,
        missingPerson: {
          id: missingPerson.id,
          label: this.missingPersonCommonService.caseLabel(missingPerson),
          personType: missingPerson.personType,
          status: missingPerson.status,
        },
      })),
      meta: this.missingPersonCommonService.pageMeta(page, limit, total),
    };
  }

  async listCaseFlags(id: string) {
    await this.missingPersonCommonService.loadCase(id);
    const data = await this.prisma.missingPersonFlag.findMany({
      where: { missingPersonId: id },
      orderBy: { createdAt: 'desc' },
      include: { reporter: { select: { id: true, name: true } } },
    });
    return { data };
  }

  // Hides a public case. Status moves to CANCELLED, which the workflow treats as terminal, so it
  // cannot be re-approved until a super admin lifts the takedown.
  private async hideCase(
    admin: CurrentUserDto,
    existing: MissingPerson,
    reason: string,
    operation: string,
  ) {
    const now = new Date();
    const result = await this.prisma.missingPerson.updateMany({
      where: { id: existing.id, status: MissingPersonStatus.APPROVED },
      data: {
        status: MissingPersonStatus.CANCELLED,
        takedownReason: reason,
        takedownAt: now,
        takedownById: admin.id,
        takedownPreviousStatus: MissingPersonStatus.APPROVED,
        claimedByUserId: null,
        claimedAt: null,
      },
    });
    if (result.count === 0) throw new ConflictException('missing_person_transition_conflict');

    await this.cache.invalidateMissingPersonEverywhere(existing.id);
    const updated = await this.missingPersonCommonService.loadCase(existing.id);

    this.missingPersonCommonService.auditOp(
      admin,
      updated,
      operation,
      {
        previousStatus: existing.status,
        newStatus: updated.status,
      },
      { severity: AuditSeverity.CRITICAL, reason },
    );
    this.missingPersonCommonService.notifyOwner(updated);
    return updated;
  }

  async resolveFlag(admin: CurrentUserDto, flagId: string, data: ResolveMissingPersonFlagDto) {
    const flag = await this.prisma.missingPersonFlag.findUnique({
      where: { id: flagId },
      include: { missingPerson: true },
    });
    if (!flag) throw new NotFoundException('flag_not_found');
    if (flag.status !== MissingPersonFlagState.OPEN) {
      throw new ConflictException('flag_already_resolved');
    }

    const mp = flag.missingPerson;
    const resolvedData = {
      status: MissingPersonFlagState.RESOLVED,
      resolvedAction: data.action,
      resolvedById: admin.id,
      resolvedAt: new Date(),
      resolutionNote: data.reason,
    };

    if (data.action === MissingPersonFlagAction.HIDE_CASE) {
      if (mp.status === MissingPersonStatus.APPROVED) {
        await this.hideCase(admin, mp, data.reason, 'flag_hide_case');
      }
      // Every open flag on a hidden case is settled by the same decision.
      await this.prisma.missingPersonFlag.updateMany({
        where: { missingPersonId: mp.id, status: MissingPersonFlagState.OPEN },
        data: resolvedData,
      });
    } else {
      await this.prisma.missingPersonFlag.update({ where: { id: flagId }, data: resolvedData });

      if (data.action === MissingPersonFlagAction.WARN_OWNER) {
        await this.prisma.missingPersonMessage.create({
          data: {
            missingPersonId: mp.id,
            authorId: admin.id,
            kind: MissingPersonMessageKind.WARNING,
            message: data.reason,
          },
        });
        this.missingPersonCommonService.notifyOwner(mp);
      }
    }

    this.missingPersonCommonService.auditOp(
      admin,
      mp,
      'flag_resolved',
      { flagId, action: data.action },
      { reason: data.reason },
    );
    return this.prisma.missingPersonFlag.findUniqueOrThrow({ where: { id: flagId } });
  }

  async takedown(admin: CurrentUserDto, id: string, reason: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    if (existing.status !== MissingPersonStatus.APPROVED) {
      throw new BadRequestException('only_approved_cases_can_be_taken_down');
    }
    return this.hideCase(admin, existing, reason, 'takedown');
  }

  async liftTakedown(admin: CurrentUserDto, id: string, reason: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    if (!existing.takedownAt || existing.deletedAt) {
      throw new BadRequestException('case_is_not_taken_down');
    }

    const restoreTo = existing.takedownPreviousStatus ?? MissingPersonStatus.APPROVED;
    const result = await this.prisma.missingPerson.updateMany({
      where: { id, status: MissingPersonStatus.CANCELLED, takedownAt: { not: null } },
      data: {
        status: restoreTo,
        takedownReason: null,
        takedownAt: null,
        takedownById: null,
        takedownPreviousStatus: null,
      },
    });
    if (result.count === 0) throw new ConflictException('missing_person_transition_conflict');

    await this.cache.invalidateMissingPersonEverywhere(id);
    const updated = await this.missingPersonCommonService.loadCase(id);

    this.missingPersonCommonService.auditOp(
      admin,
      updated,
      'lift_takedown',
      { previousStatus: existing.status, newStatus: updated.status },
      { severity: AuditSeverity.CRITICAL, reason },
    );
    this.missingPersonCommonService.notifyOwner(updated);
    return updated;
  }

  async listAppeals(query: ListMissingPersonAppealsQueryDto) {
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const where: Prisma.MissingPersonAppealWhereInput = {
      ...(query.status ? { status: this.asEnum<MissingPersonAppealState>(query.status) } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPersonAppeal.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: {
          missingPerson: {
            select: { id: true, name: true, personType: true, status: true, reviewNote: true },
          },
          author: { select: { id: true, name: true } },
        },
      }),
      this.prisma.missingPersonAppeal.count({ where }),
    ]);

    return {
      data: rows.map(({ missingPerson, ...appeal }) => ({
        ...appeal,
        missingPerson: {
          id: missingPerson.id,
          label: this.missingPersonCommonService.caseLabel(missingPerson),
          personType: missingPerson.personType,
          status: missingPerson.status,
          rejectionNote: missingPerson.reviewNote,
        },
      })),
      meta: this.missingPersonCommonService.pageMeta(page, limit, total),
    };
  }

  async decideAppeal(admin: CurrentUserDto, appealId: string, data: DecideMissingPersonAppealDto) {
    const appeal = await this.prisma.missingPersonAppeal.findUnique({
      where: { id: appealId },
      include: { missingPerson: true },
    });
    if (!appeal) throw new NotFoundException('appeal_not_found');

    const accepted = data.decision === MissingPersonAppealDecision.ACCEPTED;
    const decided = await this.prisma.missingPersonAppeal.updateMany({
      where: { id: appealId, status: MissingPersonAppealState.PENDING },
      data: {
        status: accepted ? MissingPersonAppealState.ACCEPTED : MissingPersonAppealState.DECLINED,
        decidedById: admin.id,
        decidedAt: new Date(),
        decisionNote: data.reason,
      },
    });
    if (decided.count === 0) throw new ConflictException('appeal_already_decided');

    const mp = appeal.missingPerson;
    if (accepted) {
      // A rejected case goes back into review. This is a deliberate exception to the status workflow.
      await this.prisma.missingPerson.updateMany({
        where: { id: mp.id, status: MissingPersonStatus.REJECTED },
        data: { status: MissingPersonStatus.UNDER_REVIEW },
      });
      await this.cache.invalidateMissingPersonEverywhere(mp.id);
    }

    await this.prisma.missingPersonMessage.create({
      data: { missingPersonId: mp.id, authorId: admin.id, message: data.reason },
    });

    const updated = await this.missingPersonCommonService.loadCase(mp.id);
    this.missingPersonCommonService.auditOp(
      admin,
      updated,
      'appeal_decided',
      {
        appealId,
        decision: data.decision,
        previousStatus: mp.status,
        newStatus: updated.status,
      },
      { reason: data.reason },
    );
    this.missingPersonCommonService.notifyOwner(updated);
    return this.prisma.missingPersonAppeal.findUniqueOrThrow({ where: { id: appealId } });
  }
}

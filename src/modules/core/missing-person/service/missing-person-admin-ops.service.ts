import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditOutcome,
  AuditSeverity,
  MissingPersonStatus,
  MissingPersonType,
  Prisma,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  AdminEditMissingPersonDto,
  ListMissingPersonsAdminQueryDto,
  PaginationQueryDto,
} from '../dto/missing-person.dto';
import { TERMINAL_STATUSES } from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonAdminOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: CacheService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

  async findAllForAdmin(query: ListMissingPersonsAdminQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { ...(query.status !== undefined ? { status: query.status } : {}) };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOneForAdmin(id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      include: { informationSubmissions: true },
    });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    return missingPerson;
  }

  async getHistory(id: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    return this.prisma.auditLog.findMany({
      where: { entity: 'MissingPerson', entityId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Soft delete. Non-terminal cases move to CANCELLED so every existing status-based query hides them.
  async removeByAdmin(admin: CurrentUserDto, id: string, reason: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);

    if (existing.deletedAt) throw new ConflictException('case_already_deleted');
    if (existing.legalHold) {
      this.missingPersonCommonService.emitCaseFailure(
        admin,
        AuditEventEnum.MISSING_PERSON_DELETED,
        existing,
        'case_under_legal_hold',
        {
          outcome: AuditOutcome.DENIED,
        },
      );
      throw new ConflictException('case_under_legal_hold');
    }

    const wasTerminal = TERMINAL_STATUSES.includes(existing.status);
    const result = await this.prisma.missingPerson.updateMany({
      where: { id, deletedAt: null },
      data: {
        deletedAt: new Date(),
        deletedById: admin.id,
        deleteReason: reason,
        deletedPreviousStatus: existing.status,
        claimedByUserId: null,
        claimedAt: null,
        ...(wasTerminal ? {} : { status: MissingPersonStatus.CANCELLED }),
      },
    });
    if (result.count === 0) throw new ConflictException('case_already_deleted');

    await this.cache.invalidateMissingPersonEverywhere(id);

    this.missingPersonCommonService.auditOp(
      admin,
      existing,
      'admin_soft_delete',
      {
        previousStatus: existing.status,
        newStatus: wasTerminal ? existing.status : MissingPersonStatus.CANCELLED,
      },
      { action: AuditEventEnum.MISSING_PERSON_DELETED, severity: AuditSeverity.CRITICAL, reason },
    );
    return { message: 'missing_person_deleted', id };
  }

  async restore(admin: CurrentUserDto, id: string, reason?: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    if (!existing.deletedAt) throw new BadRequestException('case_is_not_deleted');

    const previous = existing.deletedPreviousStatus;
    const canRestoreStatus =
      existing.status === MissingPersonStatus.CANCELLED &&
      !existing.takedownAt &&
      previous !== null &&
      !TERMINAL_STATUSES.includes(previous);

    await this.prisma.missingPerson.update({
      where: { id },
      data: {
        deletedAt: null,
        deletedById: null,
        deleteReason: null,
        deletedPreviousStatus: null,
        ...(canRestoreStatus && previous ? { status: previous } : {}),
      },
    });

    await this.cache.invalidateMissingPersonEverywhere(id);
    const updated = await this.missingPersonCommonService.loadCase(id);

    this.missingPersonCommonService.auditOp(
      admin,
      updated,
      'admin_restore',
      { previousStatus: existing.status, newStatus: updated.status },
      { severity: AuditSeverity.WARNING, reason: reason ?? null },
    );
    this.missingPersonCommonService.notifyOwner(updated);
    return updated;
  }

  async listTrash(query: PaginationQueryDto) {
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const where: Prisma.MissingPersonWhereInput = { deletedAt: { not: null } };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { deletedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);
    return { data, meta: this.missingPersonCommonService.pageMeta(page, limit, total) };
  }

  async setLegalHold(admin: CurrentUserDto, id: string, legalHold: boolean, reason: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    if (existing.legalHold === legalHold) {
      throw new ConflictException(
        legalHold ? 'legal_hold_already_set' : 'no_legal_hold_to_release',
      );
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: legalHold
        ? {
            legalHold: true,
            legalHoldReason: reason,
            legalHoldAt: new Date(),
            legalHoldById: admin.id,
          }
        : { legalHold: false, legalHoldReason: null, legalHoldAt: null, legalHoldById: null },
    });

    this.missingPersonCommonService.auditOp(
      admin,
      updated,
      legalHold ? 'legal_hold_placed' : 'legal_hold_released',
      { legalHold },
      { severity: AuditSeverity.CRITICAL, reason },
    );
    return updated;
  }

  async editByAdmin(admin: CurrentUserDto, id: string, data: AdminEditMissingPersonDto) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    this.missingPersonCommonService.assertNotClaimedByOther(
      admin,
      existing,
      AuditEventEnum.MISSING_PERSON_UPDATED,
    );

    const editable: MissingPersonStatus[] = [
      MissingPersonStatus.PENDING,
      MissingPersonStatus.UNDER_REVIEW,
      MissingPersonStatus.MORE_INFORMATION_REQUESTED,
    ];
    if (!editable.includes(existing.status) || existing.deletedAt) {
      throw new ForbiddenException('case_not_editable_by_admin_in_current_status');
    }

    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
    const patch: Prisma.MissingPersonUpdateInput = {};

    if (data.name !== undefined && data.name !== existing.name) {
      changes.push({ field: 'name', oldValue: existing.name, newValue: data.name });
      patch.name = data.name;
    }
    if (data.description !== undefined && data.description !== existing.description) {
      changes.push({
        field: 'description',
        oldValue: existing.description,
        newValue: data.description,
      });
      patch.description = data.description;
    }
    if (data.lastKnownArea !== undefined && data.lastKnownArea !== existing.lastKnownArea) {
      changes.push({
        field: 'lastKnownArea',
        oldValue: existing.lastKnownArea,
        newValue: data.lastKnownArea,
      });
      patch.lastKnownArea = data.lastKnownArea;
    }
    if (data.dateLastSeen !== undefined) {
      const next = new Date(data.dateLastSeen);
      if (next.getTime() !== existing.dateLastSeen.getTime()) {
        changes.push({
          field: 'dateLastSeen',
          oldValue: existing.dateLastSeen.toISOString(),
          newValue: next.toISOString(),
        });
        patch.dateLastSeen = next;
      }
    }

    if (changes.length === 0) throw new BadRequestException('no_changes_provided');

    const [updated] = await this.prisma.$transaction([
      this.prisma.missingPerson.update({ where: { id }, data: patch }),
      this.prisma.missingPersonRevision.createMany({
        data: changes.map((c) => ({
          missingPersonId: id,
          field: c.field,
          oldValue: (c.oldValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          newValue: (c.newValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          changedById: admin.id,
          reason: data.reason,
        })),
      }),
    ]);

    this.missingPersonCommonService.auditOp(
      admin,
      updated,
      'admin_edit',
      { fieldsChanged: changes.map((c) => c.field) },
      { reason: data.reason },
    );
    return updated;
  }

  async getRevisions(id: string, query: PaginationQueryDto) {
    await this.missingPersonCommonService.loadCase(id);
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const where = { missingPersonId: id };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPersonRevision.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { changedBy: { select: { id: true, name: true } } },
      }),
      this.prisma.missingPersonRevision.count({ where }),
    ]);
    return { data, meta: this.missingPersonCommonService.pageMeta(page, limit, total) };
  }

  async messageOwner(admin: CurrentUserDto, id: string, message: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    const created = await this.prisma.missingPersonMessage.create({
      data: { missingPersonId: id, authorId: admin.id, message },
    });
    this.missingPersonCommonService.auditOp(admin, existing, 'message_owner', {
      messageId: created.id,
    });
    this.missingPersonCommonService.notifyOwner(existing);
    return created;
  }

  // The child flag is personType: CHILD turns on the two-admin approval rules. A change needs two
  // distinct admins to propose the same value, the second call applies it.
  async correctChildFlag(
    admin: CurrentUserDto,
    id: string,
    involvesChild: boolean,
    reason: string,
  ) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    const target = involvesChild ? MissingPersonType.CHILD : MissingPersonType.WOMAN;

    if (existing.personType === target) throw new BadRequestException('child_flag_already_set');

    const sameProposal = existing.childFlagProposedValue === involvesChild;
    if (sameProposal && existing.childFlagProposedById === admin.id) {
      throw new BadRequestException('child_flag_requires_second_distinct_admin');
    }

    if (sameProposal && existing.childFlagProposedById) {
      const updated = await this.prisma.missingPerson.update({
        where: { id },
        data: {
          personType: target,
          childFlagProposedValue: null,
          childFlagProposedById: null,
          childFlagProposedAt: null,
          childFlagProposedReason: null,
          childSafetyFirstConfirmedByUserId: null,
          childSafetyFirstConfirmedAt: null,
        },
      });
      if (existing.status === MissingPersonStatus.APPROVED) {
        await this.cache.invalidateMissingPersonEverywhere(id);
      }
      this.missingPersonCommonService.auditOp(
        admin,
        updated,
        'child_flag_corrected',
        {
          previousPersonType: existing.personType,
          personType: updated.personType,
          firstProposedBy: existing.childFlagProposedById,
        },
        { severity: AuditSeverity.WARNING, reason },
      );
      return updated;
    }

    const proposed = await this.prisma.missingPerson.update({
      where: { id },
      data: {
        childFlagProposedValue: involvesChild,
        childFlagProposedById: admin.id,
        childFlagProposedAt: new Date(),
        childFlagProposedReason: reason,
      },
    });
    this.missingPersonCommonService.auditOp(
      admin,
      proposed,
      'child_flag_first_confirmation',
      { proposedValue: involvesChild, result: 'pending_second_admin_confirmation' },
      { reason },
    );
    return { ...proposed, pendingSecondConfirmation: true };
  }
}

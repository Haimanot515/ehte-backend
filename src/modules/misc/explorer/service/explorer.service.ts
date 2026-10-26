import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditOutcome, AuditSeverity, Prisma } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';

import {
  ALWAYS_HIDDEN_FIELDS,
  CHILD_REDACTED_FIELDS,
  ENTITY_POLICY,
  GATED_FIELDS,
  GATED_RELATIONS,
  MASKED_FIELDS,
  MAX_PAGE_SIZE,
  MEDIA_FIELDS,
} from './explorer.constants';

const REDACTED = 'Redacted';

const lowerFirst = (value: string) => value.charAt(0).toLowerCase() + value.slice(1);

const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [lowerFirst(m.name), m]));

type Row = Record<string, any>;

@Injectable()
export class ExplorerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private roles(user: CurrentUserDto): string[] {
    return (user as unknown as { roles?: string[] }).roles ?? [];
  }

  private can(user: CurrentUserDto, permission: PermissionsEnum): boolean {
    const held = (user as unknown as { permissions?: string[] }).permissions ?? [];
    return held.includes(String(permission));
  }

  private emitAudit(
    user: CurrentUserDto,
    action: AuditEventEnum,
    modelName: string,
    entityId: string,
    label: string | null,
    outcome: AuditOutcome,
    metadata: Record<string, unknown>,
  ): void {
    const payload: AuditEventPayload = {
      userId: user.id,
      actorType: resolveActorType(this.roles(user)),
      action,
      outcome,
      severity: outcome === AuditOutcome.DENIED ? AuditSeverity.WARNING : AuditSeverity.INFO,
      entity: modelName,
      entityId,
      entityLabel: label,
      metadata,
    };
    this.eventEmitter.emit(action, payload);
  }

  private isChild(row: Row): boolean {
    return row.involvesChild === true || row.personType === 'CHILD';
  }

  private labelOf(entity: string, row: Row): string {
    const shortId = String(row.id).slice(0, 8);
    if (this.isChild(row)) return `Child ${entity} ${shortId}`;
    const text = row.name || row.title || row.email || row.reference || row.txRef;
    return text ? String(text) : shortId;
  }

  private mask(value: string): string {
    return value.length <= 4 ? '****' : `****${value.slice(-4)}`;
  }

  private shape(user: CurrentUserDto, entity: string, row: Row): Row {
    const gated = GATED_FIELDS[entity] ?? {};
    const child = this.isChild(row);
    const out: Row = {};

    for (const [key, value] of Object.entries(row)) {
      if (ALWAYS_HIDDEN_FIELDS.has(key)) continue;
      if (gated[key] && !this.can(user, gated[key])) continue;
      if (MEDIA_FIELDS.has(key)) {
        out[key] = Array.isArray(value) ? value.length : null;
      } else if (MASKED_FIELDS.has(key) && typeof value === 'string') {
        out[key] = this.mask(value);
      } else if (child && CHILD_REDACTED_FIELDS.has(key)) {
        out[key] = value === null || value === undefined ? null : REDACTED;
      } else {
        out[key] = value;
      }
    }

    return { ...out, _label: this.labelOf(entity, row) };
  }

  private resolve(user: CurrentUserDto, entity: string, id: string) {
    const model = models.get(entity);
    const policy = ENTITY_POLICY[entity];
    if (!model || !policy) throw new NotFoundException(`Unknown entity ${entity}`);

    if (!this.can(user, policy.permission)) {
      this.emitAudit(user, AuditEventEnum.EXPLORER_ACCESS_DENIED, model.name, id, null, AuditOutcome.DENIED, {
        requiredPermission: String(policy.permission),
      });
      throw new ForbiddenException('You do not have access to this record type');
    }

    return { model, policy, delegate: (this.prisma as any)[entity] };
  }

  private visibleRelations(user: CurrentUserDto, entity: string, model: NonNullable<ReturnType<typeof models.get>>) {
    return model.fields.filter((field) => {
      if (field.kind !== 'object') return false;
      const targetPolicy = ENTITY_POLICY[lowerFirst(field.type)];
      if (!targetPolicy || !this.can(user, targetPolicy.permission)) return false;
      const gate = GATED_RELATIONS[entity]?.[field.name];
      return !gate || this.can(user, gate);
    });
  }

  async getDetail(user: CurrentUserDto, entity: string, id: string) {
    const { model, policy, delegate } = this.resolve(user, entity, id);

    const relations = this.visibleRelations(user, entity, model);
    const toOne = relations.filter((f) => !f.isList);
    const toMany = relations.filter((f) => f.isList);

    const row: Row | null = await delegate.findUnique({
      where: { id },
      include: {
        ...Object.fromEntries(toOne.map((f) => [f.name, true])),
        ...(toMany.length
          ? { _count: { select: Object.fromEntries(toMany.map((f) => [f.name, true])) } }
          : {}),
      },
    });
    if (!row) throw new NotFoundException(`${entity} ${id} not found`);

    const { _count, ...rest } = row;
    const linked: Record<string, unknown> = {};
    for (const f of toOne) {
      const target = lowerFirst(f.type);
      linked[f.name] = rest[f.name] ? { target, data: this.shape(user, target, rest[f.name]) } : null;
      delete rest[f.name];
    }

    const { _label: label, ...record } = this.shape(user, entity, rest);

    if (policy.audit) {
      this.emitAudit(user, AuditEventEnum.EXPLORER_RECORD_VIEWED, model.name, id, label, AuditOutcome.SUCCESS, {
        via: 'explorer',
      });
    }

    return {
      entity,
      label,
      record,
      toOne: linked,
      toMany: toMany.map((f) => ({
        field: f.name,
        target: lowerFirst(f.type),
        count: _count?.[f.name] ?? 0,
      })),
    };
  }

  async getRelated(
    user: CurrentUserDto,
    entity: string,
    id: string,
    field: string,
    page: number,
    limit: number,
  ) {
    const { model, delegate } = this.resolve(user, entity, id);

    const relation = this.visibleRelations(user, entity, model).find((f) => f.name === field && f.isList);
    if (!relation) throw new BadRequestException(`${field} is not available for ${entity}`);

    const target = lowerFirst(relation.type);
    const targetModel = models.get(target);
    const hasCreatedAt = targetModel?.fields.some((f) => f.name === 'createdAt');
    const take = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
    const skip = (Math.max(page, 1) - 1) * take;

    const [row, counted] = await Promise.all([
      delegate.findUnique({
        where: { id },
        select: {
          [field]: { skip, take, ...(hasCreatedAt ? { orderBy: { createdAt: 'desc' } } : {}) },
        },
      }),
      delegate.findUnique({ where: { id }, select: { _count: { select: { [field]: true } } } }),
    ]);
    if (!row) throw new NotFoundException(`${entity} ${id} not found`);

    const items = (row[field] as Row[]).map((item) => this.shape(user, target, item));

    if (ENTITY_POLICY[target].audit) {
      this.emitAudit(user, AuditEventEnum.EXPLORER_RELATION_VIEWED, model.name, id, null, AuditOutcome.SUCCESS, {
        relation: field,
        target,
        page,
        returned: items.length,
      });
    }

    return { target, total: counted._count[field], page, limit: take, items };
  }
}
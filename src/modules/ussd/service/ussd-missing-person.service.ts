import { Injectable, NotFoundException } from '@nestjs/common';
import { MissingPersonStatus, MissingPersonType, SubmissionChannel } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

export interface CreateAnonymousMissingPersonInput {
  personType: MissingPersonType;
  description: string;
  dateLastSeen: string; // ISO date string
  lastKnownArea: string;
  name?: string;
  contactPhone?: string;
}

// Same projection MissingPersonService.publicSelect uses, kept
// independent on purpose (see class-level note below).
const PUBLIC_SELECT = {
  id: true,
  personType: true,
  name: true,
  description: true,
  dateLastSeen: true,
  lastKnownArea: true,
  status: true,
  createdAt: true,
} as const;

// ─────────────────────────────────────────────
// USSD-ONLY MISSING PERSON SERVICE
//
// Deliberately independent of the core MissingPersonService — see
// the note at the top of ussd-report.service.ts for why.
//
// Deliberately NOT included here (deferred / out of scope for USSD):
//   - Idempotency/dedup, rate limiting, max-pending caps — same
//     reasoning as UssdReportService.
//   - Media attachments — USSD has no way to attach files, so this
//     always creates with empty media arrays.
//   - Reward fields — USSD has no reward-offer flow; every
//     anonymous case is created with rewardOffered: false.
//   - Two-admin CHILD-safety confirmation is unaffected: an
//     anonymous CHILD case is created PENDING, same as any other,
//     so it still passes through the admin review workflow (which
//     is entirely in MissingPersonService.updateStatus) before it
//     can ever become APPROVED. Nothing here bypasses that.
// ─────────────────────────────────────────────
@Injectable()
export class UssdMissingPersonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // Redacts CHILD case names in audit logs, same rule as
  // MissingPersonService.caseLabel.
  private caseLabel(missingPerson: {
    id: string;
    name: string | null;
    personType: MissingPersonType;
  }): string | undefined {
    if (missingPerson.personType === MissingPersonType.CHILD) {
      return `Child case ${missingPerson.id.slice(0, 8)}`;
    }
    return missingPerson.name ?? undefined;
  }

  async createAnonymous(input: CreateAnonymousMissingPersonInput) {
    const missingPerson = await this.prisma.missingPerson.create({
      data: {
        userId: null,
        contactPhone: input.contactPhone ?? null,
        personType: input.personType,
        name: input.name || null,
        description: input.description,
        dateLastSeen: new Date(input.dateLastSeen),
        lastKnownArea: input.lastKnownArea,
        status: MissingPersonStatus.PENDING,
        rewardApproved: false,
        rewardOffered: false,
        channel: SubmissionChannel.USSD,
      },
    });

    // ASSUMPTION: same 'SYSTEM' actor-type cast as
    // UssdReportService.createAnonymous — see that method's comment.
    this.emitAudit({
      actorType: 'SYSTEM',
      action: AuditEventEnum.MISSING_PERSON_CREATED,
      entity: 'MissingPerson',
      entityId: missingPerson.id,
      entityLabel: this.caseLabel(missingPerson),
      diff: {
        personType: missingPerson.personType,
        status: missingPerson.status,
        result: 'success',
      },
      metadata: { channel: SubmissionChannel.USSD },
    });

    this.eventEmitter.emit(NotificationEventEnum.NEW_MISSING_PERSON_REQUEST, {
      missingPersonId: missingPerson.id,
    });

    return missingPerson;
  }

  /**
   * Replaces the UssdMenuService's previous call into
   * MissingPersonService.findOne(). Same APPROVED-only visibility
   * rule, same public field projection — reimplemented here rather
   * than shared, per the module-independence decision. If that rule
   * ever changes, it needs to be updated in both places; that
   * duplication is the deliberate cost of keeping USSD decoupled.
   */
  async findApprovedPublic(id: string) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: PUBLIC_SELECT,
    });

    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }

    return missingPerson;
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { InformationStatus, MissingPersonStatus, SubmissionChannel } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

export interface CreateAnonymousInformationSubmissionInput {
  missingPersonId: string;
  information: string;
}

// ─────────────────────────────────────────────
// USSD-ONLY INFORMATION SUBMISSION SERVICE
//
// Deliberately independent of the core InformationSubmissionService
// (not shown to me — this file is written directly against the
// Prisma schema rather than mirrored off that service's methods).
// Please check the two ASSUMPTION-tagged spots below against the
// real enum/notification names once you've got this in front of the
// actual codebase — I don't have InformationSubmissionService or the
// AuditEventEnum/NotificationEventEnum source to confirm them.
//
// Deliberately NOT included here (deferred / out of scope for USSD):
//   - Idempotency/dedup, rate limiting — same reasoning as the other
//     two USSD-only services.
//   - Media attachments — USSD has no way to attach files.
// ─────────────────────────────────────────────
@Injectable()
export class UssdInformationSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  async createAnonymous(input: CreateAnonymousInformationSubmissionInput) {
    // Mirrors the APPROVED-only check UssdMenuService already ran via
    // findApprovedPublic() one step earlier in the flow, but re-checked
    // here defensively: a USSD session can stay open for a while, and
    // a case could move out of APPROVED (e.g. admin marks it FOUND)
    // in the gap between "enter missing person ID" and "confirm
    // submission".
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id: input.missingPersonId },
      select: { id: true, status: true },
    });

    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }

    const submission = await this.prisma.informationSubmission.create({
      data: {
        userId: null,
        missingPersonId: input.missingPersonId,
        information: input.information,
        status: InformationStatus.PENDING,
        channel: SubmissionChannel.USSD,
      },
    });

    // ASSUMPTION: same 'SYSTEM' actor-type cast pattern as the other
    // two USSD-only services.
    this.emitAudit({
      actorType: 'SYSTEM',
      // ASSUMPTION: guessing at this enum member's name by analogy
      // with REPORT_CREATED / MISSING_PERSON_CREATED — confirm
      // INFORMATION_SUBMISSION_CREATED actually exists in
      // AuditEventEnum, or swap in whatever the real name is.
      action: AuditEventEnum.INFORMATION_SUBMITTED,
      entity: 'InformationSubmission',
      entityId: submission.id,
      diff: { result: 'success', status: submission.status },
      metadata: { missingPersonId: input.missingPersonId, channel: SubmissionChannel.USSD },
    });

    // ASSUMPTION: guessing at this notification event's name the same
    // way — confirm it exists, or drop this emit if there's no
    // corresponding listener for a new tip.

    return submission;
  }
}

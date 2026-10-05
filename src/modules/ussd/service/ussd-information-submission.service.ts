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
      action: AuditEventEnum.INFORMATION_SUBMITTED,
      entity: 'InformationSubmission',
      entityId: submission.id,
      diff: { result: 'success', status: submission.status },
      metadata: { missingPersonId: input.missingPersonId, channel: SubmissionChannel.USSD },
    });

    return submission;
  }
}

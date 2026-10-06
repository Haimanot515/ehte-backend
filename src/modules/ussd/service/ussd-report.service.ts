import { Injectable } from '@nestjs/common';
import { Prisma, Report, ReportCategory, ReportStatus, SubmissionChannel } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

const CASE_REFERENCE_MAX_ATTEMPTS = 5;

export interface CreateAnonymousReportInput {
  category: ReportCategory;
  description: string;
}

export interface PublicReportStatus {
  caseReference: string;
  status: ReportStatus;
}

@Injectable()
export class UssdReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  private generateCaseReference(): string {
    const year = new Date().getFullYear();
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `EHT-${year}-${random}`;
  }

  async createAnonymous(input: CreateAnonymousReportInput): Promise<Report> {
    const report = await this.createWithUniqueCaseReference(input);

    this.emitAudit({
      actorType: 'SYSTEM',
      action: AuditEventEnum.REPORT_CREATED,
      entity: 'Report',
      entityId: report.id,
      entityLabel: report.caseReference,
      diff: { result: 'success', status: report.status },
      metadata: { category: report.category, channel: SubmissionChannel.USSD },
    });

    this.eventEmitter.emit(NotificationEventEnum.NEW_REPORT, {
      reportId: report.id,
      caseReference: report.caseReference,
    });

    return report;
  }

  /**
   * Public, unauthenticated status lookup by case reference. Returns
   * only caseReference + status — never description, media, or any
   * PII — and returns null for both "no such reference" and "exists
   * but caller shouldn't see more than status" so the caller (see
   * ussd-menu.service.ts) can render one generic message either way.
   * Deliberately not scoped to channel=USSD: a case reference is the
   * shared "if you have it, you can check status" credential
   * regardless of how the report was originally filed.
   */
  async findStatusByCaseReferencePublic(caseReference: string): Promise<PublicReportStatus | null> {
    const report = await this.prisma.report.findUnique({
      where: { caseReference },
      select: { caseReference: true, status: true },
    });

    return report ?? null;
  }

  private async createWithUniqueCaseReference(input: CreateAnonymousReportInput): Promise<Report> {
    for (let attempt = 1; attempt <= CASE_REFERENCE_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.report.create({
          data: {
            userId: null,
            caseReference: this.generateCaseReference(),
            category: input.category,
            description: input.description,
            status: ReportStatus.PENDING,
            channel: SubmissionChannel.USSD,
          },
        });
      } catch (err) {
        const isCaseReferenceCollision =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          (err.meta?.target as string[] | undefined)?.includes('caseReference');

        if (isCaseReferenceCollision && attempt < CASE_REFERENCE_MAX_ATTEMPTS) {
          continue;
        }
        throw err;
      }
    }
    // Unreachable: the loop always returns or throws.
    throw new Error('failed_to_generate_unique_case_reference');
  }
}

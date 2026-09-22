import { Injectable } from '@nestjs/common';
import { Prisma, Report, ReportCategory, ReportStatus, SubmissionChannel } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

// How many times to retry case-reference generation on a unique
// constraint collision before giving up. Mirrors ReportService's
// own retry count — kept as a separate constant deliberately, since
// this file has no dependency on ReportService at all.
const CASE_REFERENCE_MAX_ATTEMPTS = 5;

export interface CreateAnonymousReportInput {
  category: ReportCategory;
  description: string;
}

export interface PublicReportStatus {
  caseReference: string;
  status: ReportStatus;
}

// ─────────────────────────────────────────────
// USSD-ONLY REPORT SERVICE
//
// Deliberately independent of the core ReportService: no shared
// imports, no shared methods. The USSD module must not call into
// the authenticated/core services (see conversation — USSD stays
// decoupled from the "normal" application). If both services need
// to change in the same way later (e.g. case-reference format),
// that's a signal to extract a genuinely shared lower-level helper
// — not to have one call the other.
//
// Scope, deliberately NOT included here (deferred per product
// decision):
//   - Idempotency/dedup on retried USSD writes. userId is always
//     null for these rows, so ReportService's own
//     (userId, idempotencyKey) unique constraint can never catch a
//     duplicate here (Postgres NULL <> NULL). A real fix needs a
//     ussdSessionId-keyed constraint — schema work, deferred.
//   - Per-caller rate limiting / max-pending caps. USSD is reached
//     only via the telco/aggregator's session gateway, which
//     already throttles at the session layer.
//   - Media attachments. USSD has no way to attach files.
// ─────────────────────────────────────────────
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

    // ASSUMPTION: actorType has no real ANONYMOUS variant yet, same
    // gap flagged in ReportService/MissingPersonService's own
    // 'SYSTEM' casts. Using the same cast here for consistency
    // rather than inventing a third ad-hoc value — but this really
    // is a distinct case (an anonymous human caller, not a system-
    // triggered event) and is worth a real ANONYMOUS enum variant
    // whenever that enum is next touched.
    this.emitAudit({
      actorType: 'SYSTEM' as unknown as AuditEventPayload['actorType'],
      action: AuditEventEnum.REPORT_CREATED,
      entity: 'Report',
      entityId: report.id,
      entityLabel: report.caseReference,
      diff: { result: 'success', status: report.status },
      metadata: { category: report.category, channel: SubmissionChannel.USSD },
    });

    // ASSUMPTION: NEW_REPORT is the correct listener key for the
    // admin-facing "new report" notification — mirrors ReportService
    // .create(). REPORT_RECEIVED (the reporter-facing "your report
    // was received" notification) is deliberately NOT emitted here:
    // there is no user account to notify.
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
  async findStatusByCaseReferencePublic(
    caseReference: string,
  ): Promise<PublicReportStatus | null> {
    const report = await this.prisma.report.findUnique({
      where: { caseReference },
      select: { caseReference: true, status: true },
    });

    return report ?? null;
  }

  // Mirrors ReportService.createReportWithUniqueCaseReference, minus
  // the idempotencyKey race-handling branch (not applicable here —
  // see the class-level note on deferred idempotency work).
  private async createWithUniqueCaseReference(
    input: CreateAnonymousReportInput,
  ): Promise<Report> {
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
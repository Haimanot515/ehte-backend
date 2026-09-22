import { Injectable } from '@nestjs/common';
import { MissingPersonType, ReportCategory } from '@prisma/client';
import { UssdSessionService } from './ussd-session.service';
import { UssdSessionState, UssdInboundDto, UssdOutboundResult } from '../dto/ussd-session.dto';
import { UssdReportService } from './ussd-report.service';
import { UssdMissingPersonService } from './ussd-missing-person.service';
import { UssdInformationSubmissionService } from './ussd-information-submission.service';
import { RedisService } from '../../../services/redis/redis.service';

// Matches the actual ReportCategory enum in prisma/schema/report.prisma — NOT the PRD's
// prose category list ("Violence against women", "Domestic violence", etc.), which was never
// wired into the schema. Display labels are mine; enum values on the right are what's real.
const REPORT_CATEGORIES: Array<{ label: string; value: ReportCategory }> = [
  { label: 'Harassment', value: ReportCategory.HARASSMENT },
  { label: 'Abuse', value: ReportCategory.ABUSE },
  { label: 'Fraud', value: ReportCategory.FRAUD },
  { label: 'Threat', value: ReportCategory.THREAT },
  { label: 'Discrimination', value: ReportCategory.DISCRIMINATION },
  { label: 'Safety concern', value: ReportCategory.SAFETY_CONCERN },
  { label: 'Other', value: ReportCategory.OTHER },
];

const HELP_MESSAGE =
  'If you are in immediate danger, contact local police or a nearby health facility. ' +
  'For confidential support, use Ehte to report or ask a trusted person for help.';

// Throttle windows for the two unauthenticated write/read paths that have no login to lean on.
const STATUS_LOOKUP_MAX_ATTEMPTS = 5;
const STATUS_LOOKUP_WINDOW_SECONDS = 600; // 10 minutes
const STATUS_LOOKUP_THROTTLE_KEY_PREFIX = 'ussd:status-lookup-attempts:';

const TIP_SUBMIT_MAX_ATTEMPTS = 5;
const TIP_SUBMIT_WINDOW_SECONDS = 3600; // 1 hour
const TIP_SUBMIT_THROTTLE_KEY_PREFIX = 'ussd:tip-submit-attempts:';

@Injectable()
export class UssdMenuService {
  constructor(
    private readonly sessions: UssdSessionService,
    private readonly ussdReportService: UssdReportService,
    private readonly ussdMissingPersonService: UssdMissingPersonService,
    private readonly ussdInformationSubmissionService: UssdInformationSubmissionService,
    private readonly redis: RedisService,
  ) {}

  async handle(inbound: UssdInboundDto): Promise<UssdOutboundResult> {
    const existing = await this.sessions.get(inbound.sessionId);

    if (!existing) {
      await this.sessions.start(inbound.sessionId, inbound.phoneNumber);
      return this.renderRoot();
    }

    return this.route(existing, inbound.input);
  }

  private async route(state: UssdSessionState, input: string): Promise<UssdOutboundResult> {
    switch (state.step) {
      case 'ROOT':
        return this.fromRoot(state, input);

      // Report an incident
      case 'REPORT_CATEGORY':
        return this.fromReportCategory(state, input);
      case 'REPORT_DESCRIPTION':
        return this.fromReportDescription(state, input);
      case 'REPORT_CONFIRM':
        return this.fromReportConfirm(state, input);

      // Check report status
      case 'STATUS_INPUT_REF':
        return this.fromStatusInputRef(state, input);

      // Report a missing person
      case 'MISSING_PERSON_TYPE':
        return this.fromMissingPersonType(state, input);
      case 'MISSING_PERSON_NAME':
        return this.fromMissingPersonName(state, input);
      case 'MISSING_PERSON_DESCRIPTION':
        return this.fromMissingPersonDescription(state, input);
      case 'MISSING_PERSON_DATE_LAST_SEEN':
        return this.fromMissingPersonDateLastSeen(state, input);
      case 'MISSING_PERSON_LAST_AREA':
        return this.fromMissingPersonLastArea(state, input);
      case 'MISSING_PERSON_CONFIRM':
        return this.fromMissingPersonConfirm(state, input);

      // Provide information about a missing person
      case 'INFO_MISSING_PERSON_ID':
        return this.fromInfoMissingPersonId(state, input);
      case 'INFO_DESCRIPTION':
        return this.fromInfoDescription(state, input);
      case 'INFO_CONFIRM':
        return this.fromInfoConfirm(state, input);

      default:
        await this.sessions.end(state.sessionId);
        return { text: 'Session ended. Please dial again.', continueSession: false };
    }
  }

  private renderRoot(): UssdOutboundResult {
    return {
      continueSession: true,
      text:
        'Ehte\n' +
        '1. Report an incident\n' +
        '2. Report a missing person\n' +
        '3. Provide info on a missing person\n' +
        '4. Check report status\n' +
        '5. Get help / guidance\n' +
        '0. Exit',
    };
  }

  private async fromRoot(state: UssdSessionState, input: string): Promise<UssdOutboundResult> {
    switch (input) {
      case '1': {
        await this.sessions.setStep(state, 'REPORT_CATEGORY');
        const list = REPORT_CATEGORIES.map((c, i) => `${i + 1}. ${c.label}`).join('\n');
        return { continueSession: true, text: `Select category:\n${list}` };
      }
      case '2':
        await this.sessions.setStep(state, 'MISSING_PERSON_TYPE');
        return { continueSession: true, text: 'Who is missing?\n1. Woman\n2. Child' };
      case '3':
        await this.sessions.setStep(state, 'INFO_MISSING_PERSON_ID');
        return {
          continueSession: true,
          text: 'Enter the Missing Person ID (from the poster or Ehte app):',
        };
      case '4':
        await this.sessions.setStep(state, 'STATUS_INPUT_REF');
        return { continueSession: true, text: 'Enter your Case Reference number:' };
      case '5':
        await this.sessions.end(state.sessionId);
        return { continueSession: false, text: HELP_MESSAGE };
      case '0':
        await this.sessions.end(state.sessionId);
        return { continueSession: false, text: 'Thank you for using Ehte.' };
      default:
        return { continueSession: true, text: `Invalid choice.\n${this.renderRoot().text}` };
    }
  }

  // ═══════════════════════════════════════════
  // REPORT AN INCIDENT
  // ═══════════════════════════════════════════

  private async fromReportCategory(state: UssdSessionState, input: string): Promise<UssdOutboundResult> {
    const idx = Number(input) - 1;
    const category = REPORT_CATEGORIES[idx];
    if (!category) {
      return { continueSession: true, text: 'Invalid category. Please enter a number from the list.' };
    }
    await this.sessions.setStep(state, 'REPORT_DESCRIPTION', {
      category: category.value,
      categoryLabel: category.label,
    });
    return { continueSession: true, text: 'Briefly describe what happened:' };
  }

  private async fromReportDescription(state: UssdSessionState, input: string): Promise<UssdOutboundResult> {
    if (!input?.trim()) {
      return { continueSession: true, text: 'Please enter a short description, or 0 to cancel.' };
    }
    await this.sessions.setStep(state, 'REPORT_CONFIRM', { description: input.trim() });
    return {
      continueSession: true,
      text: `Category: ${state.data.categoryLabel}\nSubmit this report?\n1. Yes\n2. No, cancel`,
    };
  }

  private async fromReportConfirm(state: UssdSessionState, input: string): Promise<UssdOutboundResult> {
    if (input === '1') {
      const report = await this.ussdReportService.createAnonymous({
        category: state.data.category as ReportCategory,
        description: state.data.description,
      });
      await this.sessions.end(state.sessionId);
      return {
        continueSession: false,
        text: `Report submitted. Your Case Reference is ${report.caseReference}. Keep it to check status later.`,
      };
    }
    await this.sessions.end(state.sessionId);
    return { continueSession: false, text: 'Report cancelled.' };
  }

  // ═══════════════════════════════════════════
  // CHECK REPORT STATUS
  // ═══════════════════════════════════════════

  private async fromStatusInputRef(state: UssdSessionState, input: string): Promise<UssdOutboundResult> {
    await this.sessions.end(state.sessionId);

    const reference = input?.trim();
    if (!reference) {
      return { continueSession: false, text: 'No reference entered.' };
    }

    const withinLimit = await this.checkAndIncrementThrottle(
      STATUS_LOOKUP_THROTTLE_KEY_PREFIX + state.phoneNumber,
      STATUS_LOOKUP_WINDOW_SECONDS,
      STATUS_LOOKUP_MAX_ATTEMPTS,
    );
    if (!withinLimit) {
      return { continueSession: false, text: 'Too many attempts. Please try again later.' };
    }

    const report = await this.ussdReportService.findStatusByCaseReferencePublic(reference);
    // Same generic message whether the reference doesn't exist or belongs to an app-created
    // report — must not reveal which, or it becomes a way to fingerprint reports.
    if (!report) {
      return { continueSession: false, text: 'No report found for that reference.' };
    }
    return { continueSession: false, text: `Status for ${report.caseReference}: ${report.status}` };
  }

  // ═══════════════════════════════════════════
  // REPORT A MISSING PERSON
  // ═══════════════════════════════════════════

  private async fromMissingPersonType(state: UssdSessionState, input: string): Promise<UssdOutboundResult> {
    const personType = input === '1' ? MissingPersonType.WOMAN : input === '2' ? MissingPersonType.CHILD : null;
    if (!personType) {
      return { continueSession: true, text: 'Invalid choice.\n1. Woman\n2. Child' };
    }
    await this.sessions.setStep(state, 'MISSING_PERSON_NAME', { personType });
    return { continueSession: true, text: 'Enter their name, or 0 to skip:' };
  }

  private async fromMissingPersonName(state: UssdSessionState, input: string): Promise<UssdOutboundResult> {
    const name = input?.trim() === '0' ? '' : (input ?? '').trim();
    await this.sessions.setStep(state, 'MISSING_PERSON_DESCRIPTION', { name });
    return { continueSession: true, text: 'Briefly describe them (appearance, clothing, etc.):' };
  }

  private async fromMissingPersonDescription(
    state: UssdSessionState,
    input: string,
  ): Promise<UssdOutboundResult> {
    if (!input?.trim()) {
      return { continueSession: true, text: 'Please enter a short description.' };
    }
    await this.sessions.setStep(state, 'MISSING_PERSON_DATE_LAST_SEEN', { description: input.trim() });
    return { continueSession: true, text: 'Date last seen? Enter as DD/MM/YYYY:' };
  }

  private async fromMissingPersonDateLastSeen(
    state: UssdSessionState,
    input: string,
  ): Promise<UssdOutboundResult> {
    const iso = this.parseDdMmYyyy(input?.trim());
    if (!iso) {
      return { continueSession: true, text: 'Invalid date. Please enter as DD/MM/YYYY, e.g. 15/09/2026:' };
    }
    await this.sessions.setStep(state, 'MISSING_PERSON_LAST_AREA', { dateLastSeen: iso });
    return { continueSession: true, text: 'Last known area (town/neighborhood):' };
  }

  private async fromMissingPersonLastArea(
    state: UssdSessionState,
    input: string,
  ): Promise<UssdOutboundResult> {
    if (!input?.trim()) {
      return { continueSession: true, text: 'Please enter the last known area.' };
    }
    await this.sessions.setStep(state, 'MISSING_PERSON_CONFIRM', { lastKnownArea: input.trim() });
    return {
      continueSession: true,
      text: `Submit this missing person report?\n1. Yes\n2. No, cancel`,
    };
  }

  private async fromMissingPersonConfirm(
    state: UssdSessionState,
    input: string,
  ): Promise<UssdOutboundResult> {
    if (input === '1') {
      const missingPerson = await this.ussdMissingPersonService.createAnonymous({
        personType: state.data.personType as MissingPersonType,
        description: state.data.description,
        dateLastSeen: state.data.dateLastSeen,
        lastKnownArea: state.data.lastKnownArea,
        name: state.data.name || undefined,
        contactPhone: state.phoneNumber,
      });
      await this.sessions.end(state.sessionId);
      return {
        continueSession: false,
        text: `Missing person report submitted for review. Reference ID: ${missingPerson.id}`,
      };
    }
    await this.sessions.end(state.sessionId);
    return { continueSession: false, text: 'Missing person report cancelled.' };
  }

  // ═══════════════════════════════════════════
  // PROVIDE INFORMATION ABOUT A MISSING PERSON
  // ═══════════════════════════════════════════

  private async fromInfoMissingPersonId(
    state: UssdSessionState,
    input: string,
  ): Promise<UssdOutboundResult> {
    const missingPersonId = input?.trim();
    if (!missingPersonId) {
      await this.sessions.end(state.sessionId);
      return { continueSession: false, text: 'No ID entered.' };
    }

    // findApprovedPublic() enforces APPROVED-only visibility — an anonymous tipster should
    // only ever see/act on a publicly visible case, same rule as the app's public detail page.
    try {
      await this.ussdMissingPersonService.findApprovedPublic(missingPersonId);
    } catch {
      await this.sessions.end(state.sessionId);
      return { continueSession: false, text: 'Case not found. It may not be published yet.' };
    }

    await this.sessions.setStep(state, 'INFO_DESCRIPTION', { missingPersonId });
    return { continueSession: true, text: 'What information do you have?' };
  }

  private async fromInfoDescription(state: UssdSessionState, input: string): Promise<UssdOutboundResult> {
    if (!input?.trim()) {
      return { continueSession: true, text: 'Please enter your information, or 0 to cancel.' };
    }
    await this.sessions.setStep(state, 'INFO_CONFIRM', { information: input.trim() });
    return { continueSession: true, text: 'Submit this information?\n1. Yes\n2. No, cancel' };
  }

  private async fromInfoConfirm(state: UssdSessionState, input: string): Promise<UssdOutboundResult> {
    if (input === '1') {
      const withinLimit = await this.checkAndIncrementThrottle(
        TIP_SUBMIT_THROTTLE_KEY_PREFIX + state.phoneNumber,
        TIP_SUBMIT_WINDOW_SECONDS,
        TIP_SUBMIT_MAX_ATTEMPTS,
      );
      await this.sessions.end(state.sessionId);
      if (!withinLimit) {
        return { continueSession: false, text: 'Too many submissions. Please try again later.' };
      }

      await this.ussdInformationSubmissionService.createAnonymous({
        missingPersonId: state.data.missingPersonId,
        information: state.data.information,
      });
      return { continueSession: false, text: 'Thank you. Your information has been submitted for review.' };
    }
    await this.sessions.end(state.sessionId);
    return { continueSession: false, text: 'Cancelled.' };
  }

  // ═══════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════

  /** Returns true if the caller is still within the attempt limit; false once exceeded. */
  private async checkAndIncrementThrottle(
    key: string,
    windowSeconds: number,
    maxAttempts: number,
  ): Promise<boolean> {
    const attempts = await this.redis.incrementWithTtl(key, windowSeconds);
    return attempts === null || attempts <= maxAttempts;
  }

  /** DD/MM/YYYY -> ISO date string, or null if not a valid real calendar date. */
  private parseDdMmYyyy(input?: string): string | null {
    if (!input) return null;
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input);
    if (!match) return null;

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));

    const isRealDate =
      date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    if (!isRealDate || date.getTime() > Date.now()) return null;

    return date.toISOString();
  }
}
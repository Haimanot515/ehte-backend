#!/usr/bin/env python3
"""
apply-audit-fixes.py: one command that adds the missing audit events to the Ehte backend.

Usage (from the project root, where src/ lives):
    python3 apply-audit-fixes.py src --dry-run     # show what would change
    python3 apply-audit-fixes.py src               # apply
Commit or stash first so `git diff` shows exactly what changed. Safe to run twice.
"""
import os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'src'
DRY = '--dry-run' in sys.argv
OK, SKIP, FAIL = [], [], []

def path(p): return os.path.join(ROOT, p)
def read(p):
    with open(path(p), encoding='utf-8') as f: return f.read()
def write(p, s):
    if not DRY:
        with open(path(p), 'w', encoding='utf-8') as f: f.write(s)

def has_import_name(src, name):
    return re.search(r'import[^;]*\b' + re.escape(name) + r'\b[^;]*from', src) is not None

def last_import_end(src):
    end = 0
    for m in re.finditer(r'^import[^;]*;[ \t]*\n', src, re.M): end = m.end()
    return end

def add_named_import(src, name, module):
    if has_import_name(src, name): return src
    m = re.search(r"(import\s*\{)([^}]*)(\}\s*from\s*'" + re.escape(module) + r"';)", src)
    if m:
        inner = m.group(2).rstrip()
        sep = '' if inner.endswith(',') or inner.strip() == '' else ','
        if '\n' in m.group(2):
            new = m.group(1) + inner + sep + '\n  ' + name + ',\n' + m.group(3)
        else:
            new = m.group(1) + inner.rstrip() + sep + ' ' + name + ' ' + m.group(3)
        return src[:m.start()] + new + src[m.end():]
    i = last_import_end(src)
    return src[:i] + "import { %s } from '%s';\n" % (name, module) + src[i:]

ENUM_MOD = 'src/common/enums/shared/audit-events.enum'

def replace_once(label, rel, old, new, imports=()):
    try: s = read(rel)
    except FileNotFoundError:
        FAIL.append((label, rel + ' not found')); return
    if new in s: SKIP.append((label, 'already applied')); return
    if s.count(old) != 1:
        FAIL.append((label, '%s: anchor matched %d times (expected 1); apply by hand' % (rel, s.count(old)))); return
    s = s.replace(old, new)
    for name, mod in imports: s = add_named_import(s, name, mod)
    write(rel, s); OK.append((label, rel))

# ---------------------------------------------------------------- 1. enum values
ENUM_GROUPS = {
  "Report actions emitted via act() but never declared (silently dropped by the listener before)": [
    "REPORT_EVIDENCE_ADDED",
    "REPORT_EVIDENCE_REMOVED",
    "REPORT_EVIDENCE_REDACTED",
    "REPORT_MESSAGE_POSTED",
    "REPORT_FEEDBACK_SUBMITTED",
    "REPORT_REOPEN_REQUESTED",
    "REPORT_LOCATION_CHANGED",
    "REPORT_LOCATION_VIEWED",
    "REPORT_SYNCED",
    "REPORT_ERASURE_REQUESTED",
    "REPORT_URGENT_FLAGGED",
    "REPORT_ANONYMITY_CHANGED",
    "REPORT_CATEGORY_CHANGED",
    "REPORT_PRIORITY_CHANGED",
    "REPORT_RESOLVED",
    "REPORT_MERGED",
    "REPORT_UNMERGED",
    "REPORT_SPLIT",
    "REPORT_TEAM_ASSIGNED",
    "REPORT_DE_ESCALATED",
    "REPORT_ARCHIVED",
    "REPORT_UNARCHIVED",
    "REPORT_DELETED",
    "REPORT_RESTORED",
    "REPORT_INTEGRITY_FLAGGED",
    "REPORT_INTEGRITY_CLEARED",
    "REPORT_LINKED",
    "REPORT_UNLINKED",
    "REPORT_DUE_DATE_CHANGED",
    "REPORT_TAGS_CHANGED",
    "REPORT_SENSITIVITY_CHANGED",
    "REPORT_ACCESS_GRANTED",
    "REPORT_ACCESS_REVOKED",
    "REPORTER_REVEALED",
    "REPORT_LEGAL_HOLD_CHANGED",
    "REPORT_CASE_FILE_GENERATED",
    "REPORT_EMAIL_SENT",
    "REPORT_EXPORTED",
    "REPORT_EXPORT_DOWNLOADED",
    "REPORT_INFO_REQUEST_CHANGED",
    "REPORT_BULK_ACTION"
  ],
  "Billing / institutions": [
    "INSTITUTION_CREATED"
  ],
  "Billing / webhook": [
    "PAYMENT_WEBHOOK_REJECTED",
    "PAYMENT_WEBHOOK_PAYLOAD_INVALID"
  ],
  "Posts / retention": [
    "POST_RETENTION_PURGED"
  ],
  "Media": [
    "MEDIA_UPLOADED",
    "MEDIA_PRESIGNED_UPLOAD_CREATED",
    "MEDIA_DELETED"
  ],
  "Users (admin reads)": [
    "USER_PROFILE_VIEWED",
    "USER_SESSIONS_VIEWED"
  ],
  "Billing admin reads": [
    "PAYOUT_DESTINATIONS_VIEWED",
    "BILLING_PAYMENT_VIEWED",
    "BILLING_LEDGER_VIEWED",
    "INSTITUTION_STATEMENT_VIEWED"
  ],
  "Notifications (admin)": [
    "NOTIFICATION_ADMIN_CREATED",
    "NOTIFICATION_ADMIN_DELETED",
    "NOTIFICATION_ADMIN_BULK_DELETED"
  ],
  "Audit-log views": [
    "AUDIT_PRIVILEGED_ACTIONS_VIEWED",
    "AUDIT_MONEY_ACTIONS_VIEWED",
    "AUDIT_DENIED_VIEWED",
    "AUDIT_USER_TRAIL_VIEWED",
    "AUDIT_TARGET_TRAIL_VIEWED",
    "AUDIT_SESSION_TRAIL_VIEWED",
    "AUDIT_REQUEST_TRAIL_VIEWED"
  ],
  "Auth / OTP": [
    "OTP_RESENT",
    "TWO_FACTOR_CHALLENGE_RESENT"
  ],
  "Roles": [
    "ROLE_ASSIGNMENT_REQUEST_EXPIRED"
  ],
  "Reports / evidence": [
    "REPORT_EVIDENCE_REGISTERED",
    "REPORT_EVIDENCE_CUSTODY_VIEWED"
  ],
  "Information submissions": [
    "INFORMATION_SUBMISSION_ATTACHMENTS_SYNCED"
  ],
  "Export jobs (expiry on read)": [
    "REPORT_EXPORT_EXPIRED",
    "MISSING_PERSON_EXPORT_EXPIRED",
    "INFORMATION_SUBMISSION_EXPORT_EXPIRED",
    "SUPPORT_EXPORT_EXPIRED",
    "USER_EXPORT_EXPIRED"
  ],
  "Support": [
    "SUPPORT_INCOMING_VIEWED"
  ],
  "Reports / messages": [
    "REPORT_MESSAGES_READ"
  ],
  "Reports (reporter side)": [
    "REPORT_CONTACT_PREFERENCE_CHANGED",
    "REPORT_UPDATES_MUTED",
    "REPORT_FOLLOW_UP_CREATED"
  ],
  "Audit-log tooling": [
    "AUDIT_SAVED_FILTER_CREATED",
    "AUDIT_SAVED_FILTER_UPDATED",
    "AUDIT_SAVED_FILTER_DELETED",
    "AUDIT_SAVED_FILTER_RUN",
    "AUDIT_LEGAL_HOLD_PREVIEWED"
  ],
  "Missing persons (new, no existing value fits)": [
    "MISSING_PERSON_CLAIMED",
    "MISSING_PERSON_UNCLAIMED",
    "MISSING_PERSON_FOUND_REPORT_DECLINED",
    "MISSING_PERSON_MEDIA_REDACTION_REQUESTED",
    "MISSING_PERSON_CASE_UPDATE_POSTED",
    "MISSING_PERSON_CHILD_FLAG_FIRST_CONFIRMED",
    "MISSING_PERSON_OWNER_MESSAGED",
    "MISSING_PERSON_EXPORT_STARTED",
    "MISSING_PERSON_EXPORT_DOWNLOADED"
  ]
}

def patch_enum():
    rel = 'common/enums/shared/audit-events.enum.ts'
    s = read(rel)
    existing = set(re.findall(r"^\s+(\w+)\s*=\s*'", s, re.M))
    block = ''
    added = 0
    for g, names in ENUM_GROUPS.items():
        todo = [n for n in names if n not in existing]
        if not todo: continue
        block += '\n  // %s\n' % g
        for n in todo: block += "  %s = '%s',\n" % (n, n); added += 1
    if not added: SKIP.append(('enum values', 'all present')); return
    i = s.rstrip().rfind('}')
    s = s[:i].rstrip('\n') + '\n' + block + '}\n'
    write(rel, s); OK.append(('enum values (%d added)' % added, rel))

# ---------------------------------------------------------------- 2. decorator + interceptor
DECORATOR = r"""import { SetMetadata } from '@nestjs/common';
import { AuditSeverity } from '@prisma/client';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';

export const AUDIT_EVENT_KEY = 'audit_event_options';

export interface AuditEventOptions {
  action: AuditEventEnum;
  entity: string;
  /** Where the entity id comes from. `response` lists candidate keys on the returned object. */
  entityId?: { param?: string; query?: string; body?: string; response?: string[] };
  /** Route param holding the user the action is about (sets targetUserId). */
  targetUserParam?: string;
  /** Copy these request parts (primitive values only, secrets skipped) into metadata. */
  capture?: Array<'params' | 'query'>;
  metadata?: Record<string, unknown>;
  severity?: AuditSeverity;
  /** Set false to record only failures (for example rejected webhooks). Default true. */
  onSuccess?: boolean;
  /** Action to record when the handler throws; return null to skip. */
  onError?: AuditEventEnum | ((err: unknown) => AuditEventEnum | null);
}

/**
 * Records an audit event when the handler finishes. Use for controller endpoints that have no
 * audit emit of their own. The actor, IP, session and request id come from the request context.
 */
export const AuditEvent = (options: AuditEventOptions) => SetMetadata(AUDIT_EVENT_KEY, options);
"""

INTERCEPTOR = r"""import { CallHandler, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ActorType, AuditOutcome, AuditSeverity } from '@prisma/client';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

import { AUDIT_EVENT_KEY, AuditEventOptions } from '../decorators/audit-event.decorator';
import { AuditEventEnum } from '../enums/shared/audit-events.enum';
import { CurrentUserDto } from '../dtos/current-user.dto';
import { resolveActorType } from '../utils/actor-type.util';
import { AuditEventPayload } from '../../modules/misc/audit-log/events/audit.events';

type Req = {
  user?: CurrentUserDto;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

const SECRET_KEY = /token|password|secret|otp|code|signature/i;

@Injectable()
export class AuditEventInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditEventInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.get<AuditEventOptions | undefined>(AUDIT_EVENT_KEY, ctx.getHandler());
    if (!opts || ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Req>();

    return next.handle().pipe(
      tap((res) => {
        if (opts.onSuccess !== false) this.emit(opts, opts.action, req, res);
      }),
      catchError((err: unknown) => {
        const action = typeof opts.onError === 'function' ? opts.onError(err) : opts.onError;
        if (action) this.emit(opts, action, req, undefined, err);
        return throwError(() => err);
      }),
    );
  }

  private emit(opts: AuditEventOptions, action: AuditEventEnum, req: Req, res?: unknown, err?: unknown) {
    try {
      const user = req.user;
      const metadata: Record<string, unknown> = { ...(opts.metadata ?? {}) };
      for (const part of opts.capture ?? []) {
        const src = req[part] ?? {};
        for (const [k, v] of Object.entries(src).slice(0, 20)) {
          if (SECRET_KEY.test(k)) continue;
          if (['string', 'number', 'boolean'].includes(typeof v)) metadata[k] = String(v).slice(0, 200);
        }
      }
      const payload: AuditEventPayload = {
        userId: user?.id ?? null,
        actorType: user ? resolveActorType(user.roles ?? []) : ActorType.USER,
        action,
        entity: opts.entity,
        entityId: this.resolveId(opts, req, res),
        targetUserId: opts.targetUserParam ? this.str(req.params?.[opts.targetUserParam]) : null,
        outcome: err ? AuditOutcome.FAILURE : AuditOutcome.SUCCESS,
        severity: err ? AuditSeverity.WARNING : (opts.severity ?? AuditSeverity.INFO),
        reason: err ? this.errMsg(err) : null,
        metadata: Object.keys(metadata).length ? metadata : null,
      };
      this.eventEmitter.emit(action, payload);
    } catch (e) {
      // Auditing must never break the request.
      this.logger.warn('audit emit failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  private resolveId(opts: AuditEventOptions, req: Req, res: unknown): string | null {
    const id = opts.entityId;
    if (!id) return null;
    if (id.param) return this.str(req.params?.[id.param]);
    if (id.query) return this.str(req.query?.[id.query]);
    if (id.body) return this.str(req.body?.[id.body]);
    if (id.response && res && typeof res === 'object') {
      const o = res as Record<string, unknown>;
      const inner = (o.data && typeof o.data === 'object' ? o.data : {}) as Record<string, unknown>;
      for (const k of id.response) {
        const v = this.str(o[k]) ?? this.str(inner[k]);
        if (v) return v;
      }
    }
    return null;
  }

  private str(v: unknown): string | null {
    return typeof v === 'string' && v ? v.slice(0, 200) : typeof v === 'number' ? String(v) : null;
  }

  private errMsg(err: unknown): string {
    if (err instanceof HttpException) return (err.message || 'http_error').slice(0, 300);
    return (err instanceof Error ? err.message : 'error').slice(0, 300);
  }
}
"""

def create_infra():
    for rel, body in (('common/decorators/audit-event.decorator.ts', DECORATOR),
                      ('common/interceptors/audit-event.interceptor.ts', INTERCEPTOR)):
        if os.path.exists(path(rel)): SKIP.append(('create ' + rel, 'exists')); continue
        if not DRY:
            os.makedirs(os.path.dirname(path(rel)), exist_ok=True)
            write(rel, body)
        OK.append(('create', rel))
    rel = 'app.module.ts'
    s = read(rel)
    if 'AuditEventInterceptor' in s: SKIP.append(('register interceptor', 'already')); return
    imp = "import { ActorContextInterceptor } from './common/interceptors/actor-context.interceptor';\n"
    prov = "    { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },\n"
    if s.count(imp) != 1 or s.count(prov) != 1:
        FAIL.append(('register interceptor', 'app.module.ts anchors not found; add AuditEventInterceptor as an APP_INTERCEPTOR by hand')); return
    s = s.replace(imp, imp + "import { AuditEventInterceptor } from './common/interceptors/audit-event.interceptor';\n")
    s = s.replace(prov, prov + "    { provide: APP_INTERCEPTOR, useClass: AuditEventInterceptor },\n")
    write(rel, s); OK.append(('register interceptor', rel))

# ---------------------------------------------------------------- 3. controller decorators
E = 'AuditEventEnum.'
DECOS = [
 # (file, handler, options)
 ('modules/auth/controller/auth.controller.ts', 'resendSignupOtp', "action: %sOTP_RESENT, entity: 'Otp', metadata: { purpose: 'signup' }" % E),
 ('modules/auth/controller/auth.controller.ts', 'resendForgotPasswordOtp', "action: %sOTP_RESENT, entity: 'Otp', metadata: { purpose: 'forgot_password' }" % E),
 ('modules/auth/controller/auth.controller.ts', 'twoFactorLoginResend', "action: %sTWO_FACTOR_CHALLENGE_RESENT, entity: 'TwoFactorChallenge'" % E),
 ('modules/auth/controller/admin-auth.controller.ts', 'resendForgotPasswordOtp', "action: %sOTP_RESENT, entity: 'Otp', metadata: { purpose: 'admin_forgot_password' }" % E),
 ('modules/media/controller/media.controller.ts', 'createPresignedUpload', "action: %sMEDIA_PRESIGNED_UPLOAD_CREATED, entity: 'Media'" % E),
 ('modules/media/controller/media.controller.ts', 'uploadFile', "action: %sMEDIA_UPLOADED, entity: 'Media', entityId: { response: ['key', 'id', 'filepath', 'path'] }" % E),
 ('modules/media/controller/media.controller.ts', 'deleteObject', "action: %sMEDIA_DELETED, entity: 'Media', entityId: { query: 'key' }, severity: AuditSeverity.WARNING" % E),
 ('modules/core/user/controller/user.controller.ts', 'getUserById', "action: %sUSER_PROFILE_VIEWED, entity: 'User', entityId: { param: 'id' }, targetUserParam: 'id'" % E),
 ('modules/core/user/controller/user.controller.ts', 'getUserSessions', "action: %sUSER_SESSIONS_VIEWED, entity: 'User', entityId: { param: 'id' }, targetUserParam: 'id'" % E),
 ('modules/billing/institution-admin/controller/institution-admin.controller.ts', 'listDestinations', "action: %sPAYOUT_DESTINATIONS_VIEWED, entity: 'PayoutDestination', capture: ['query']" % E),
 ('modules/billing/institution-admin/controller/institution-admin.controller.ts', 'statement', "action: %sINSTITUTION_STATEMENT_VIEWED, entity: 'Institution', entityId: { param: 'id' }, capture: ['query']" % E),
 ('modules/billing/billing-report/controller/billing-report.controller.ts', 'getPayment', "action: %sBILLING_PAYMENT_VIEWED, entity: 'Payment', entityId: { param: 'id' }" % E),
 ('modules/billing/billing-report/controller/billing-report-admin.controller.ts', 'ledger', "action: %sBILLING_LEDGER_VIEWED, entity: 'Ledger', capture: ['query']" % E),
 ('modules/billing/agreement/controller/agreement.controller.ts', 'createInstitution', "action: %sINSTITUTION_CREATED, entity: 'Institution', entityId: { response: ['id'] }" % E),
 ('modules/billing/chapa-webhook/controller/chapa-webhook.controller.ts', 'handle',
   "action: %sPAYMENT_WEBHOOK_REJECTED, entity: 'PaymentWebhook', onSuccess: false, onError: (e) => e instanceof UnauthorizedException ? %sPAYMENT_WEBHOOK_REJECTED : e instanceof BadRequestException ? %sPAYMENT_WEBHOOK_PAYLOAD_INVALID : null" % (E, E, E)),
 ('modules/misc/notification/controller/notification.controller.ts', 'createNotification', "action: %sNOTIFICATION_ADMIN_CREATED, entity: 'Notification', entityId: { response: ['id'] }" % E),
 ('modules/misc/notification/controller/notification.controller.ts', 'deleteAdminBulk', "action: %sNOTIFICATION_ADMIN_BULK_DELETED, entity: 'Notification', severity: AuditSeverity.WARNING" % E),
 ('modules/misc/notification/controller/notification.controller.ts', 'deleteAdminAllRead', "action: %sNOTIFICATION_ADMIN_BULK_DELETED, entity: 'Notification', metadata: { scope: 'all_read' }, severity: AuditSeverity.WARNING" % E),
 ('modules/misc/notification/controller/notification.controller.ts', 'deleteAdminNotification', "action: %sNOTIFICATION_ADMIN_DELETED, entity: 'Notification', entityId: { param: 'id' }, severity: AuditSeverity.WARNING" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'getPrivilegedActions', "action: %sAUDIT_PRIVILEGED_ACTIONS_VIEWED, entity: 'AuditLog', capture: ['query']" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'getMoneyActions', "action: %sAUDIT_MONEY_ACTIONS_VIEWED, entity: 'AuditLog', capture: ['query']" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'getDenied', "action: %sAUDIT_DENIED_VIEWED, entity: 'AuditLog', capture: ['query']" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'getAuditLogsForUser', "action: %sAUDIT_USER_TRAIL_VIEWED, entity: 'User', entityId: { param: 'userId' }, targetUserParam: 'userId', capture: ['query']" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'getAuditLogsForTarget', "action: %sAUDIT_TARGET_TRAIL_VIEWED, entity: 'User', entityId: { param: 'targetUserId' }, targetUserParam: 'targetUserId', capture: ['query']" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'getAuditLogsForSession', "action: %sAUDIT_SESSION_TRAIL_VIEWED, entity: 'Session', entityId: { param: 'sessionId' }, capture: ['query']" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'getAuditLogsForRequest', "action: %sAUDIT_REQUEST_TRAIL_VIEWED, entity: 'Request', entityId: { param: 'requestId' }, capture: ['query']" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'createSavedFilter', "action: %sAUDIT_SAVED_FILTER_CREATED, entity: 'AuditSavedFilter', entityId: { response: ['id'] }" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'updateSavedFilter', "action: %sAUDIT_SAVED_FILTER_UPDATED, entity: 'AuditSavedFilter', entityId: { param: 'id' }" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'deleteSavedFilter', "action: %sAUDIT_SAVED_FILTER_DELETED, entity: 'AuditSavedFilter', entityId: { param: 'id' }" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'runSavedFilter', "action: %sAUDIT_SAVED_FILTER_RUN, entity: 'AuditSavedFilter', entityId: { param: 'id' }, capture: ['query']" % E),
 ('modules/misc/audit-log/controller/audit-log.controller.ts', 'previewLegalHold', "action: %sAUDIT_LEGAL_HOLD_PREVIEWED, entity: 'AuditLegalHold'" % E),
 ('modules/core/report/controller/report.controller.ts', 'findEvidenceCustody', "action: %sREPORT_EVIDENCE_CUSTODY_VIEWED, entity: 'Report', entityId: { param: 'id' }, capture: ['params']" % E),
 ('modules/core/report/controller/report.controller.ts', 'findMessages', "action: %sREPORT_MESSAGES_READ, entity: 'Report', entityId: { param: 'id' }" % E),
 ('modules/core/report/controller/report.controller.ts', 'setContactPreference', "action: %sREPORT_CONTACT_PREFERENCE_CHANGED, entity: 'Report', entityId: { param: 'id' }" % E),
 ('modules/core/report/controller/report.controller.ts', 'muteUpdates', "action: %sREPORT_UPDATES_MUTED, entity: 'Report', entityId: { param: 'id' }" % E),
 ('modules/core/report/controller/report.controller.ts', 'createFollowUp', "action: %sREPORT_FOLLOW_UP_CREATED, entity: 'Report', entityId: { param: 'id' }" % E),
 ('modules/core/support/controller/support.controller.ts', 'findOneIncoming', "action: %sSUPPORT_INCOMING_VIEWED, entity: 'Support', entityId: { param: 'id' }" % E),
]

def decorate(rel, handler, opts):
    label = 'decorate %s.%s' % (os.path.basename(rel), handler)
    try: s = read(rel)
    except FileNotFoundError: FAIL.append((label, rel + ' not found')); return
    ms = list(re.finditer(r'^([ \t]+)(?:async\s+)?' + re.escape(handler) + r'\s*\(', s, re.M))
    if len(ms) != 1: FAIL.append((label, 'handler matched %d times; add @AuditEvent by hand' % len(ms))); return
    m = ms[0]
    action = re.search(r'action: AuditEventEnum\.(\w+)', opts).group(1)
    prefix = s[:m.start()]
    block = prefix[prefix.rfind('\n  }\n') + 1:]   # decorators of this handler only
    if '@AuditEvent(' in block:
        SKIP.append((label, 'already decorated')); return
    line = '%s@AuditEvent({ %s })\n' % (m.group(1), opts)
    s = s[:m.start()] + line + s[m.start():]
    s = add_named_import(s, 'AuditEvent', 'src/common/decorators/audit-event.decorator')
    s = add_named_import(s, 'AuditEventEnum', ENUM_MOD)
    if 'AuditSeverity.' in opts: s = add_named_import(s, 'AuditSeverity', '@prisma/client')
    write(rel, s); OK.append((label, action))

# ---------------------------------------------------------------- 4. service-level patches
MP_MAP = """const MISSING_PERSON_OPERATION_ACTIONS: Record<string, AuditEventEnum> = {
  admin_restore: AuditEventEnum.MISSING_PERSON_RESTORED,
  admin_edit: AuditEventEnum.MISSING_PERSON_EDITED_BY_ADMIN,
  merge: AuditEventEnum.MISSING_PERSON_MERGED,
  merged_into: AuditEventEnum.MISSING_PERSON_MERGED,
  lift_takedown: AuditEventEnum.MISSING_PERSON_TAKEDOWN_LIFTED,
  owner_account_suspended: AuditEventEnum.MISSING_PERSON_TAKEN_DOWN,
  reader_flag: AuditEventEnum.MISSING_PERSON_FLAGGED,
  flag_resolved: AuditEventEnum.MISSING_PERSON_FLAG_RESOLVED,
  appeal_submitted: AuditEventEnum.MISSING_PERSON_APPEAL_SUBMITTED,
  appeal_decided: AuditEventEnum.MISSING_PERSON_APPEAL_DECIDED,
  owner_found_report: AuditEventEnum.MISSING_PERSON_FOUND_REPORTED,
  found_report_declined: AuditEventEnum.MISSING_PERSON_FOUND_REPORT_DECLINED,
  reopen: AuditEventEnum.MISSING_PERSON_REOPENED,
  assign: AuditEventEnum.MISSING_PERSON_ASSIGNED,
  unassign: AuditEventEnum.MISSING_PERSON_UNASSIGNED,
  claim: AuditEventEnum.MISSING_PERSON_CLAIMED,
  unclaim: AuditEventEnum.MISSING_PERSON_UNCLAIMED,
  reward_review: AuditEventEnum.MISSING_PERSON_REWARD_REVIEWED,
  redact_media_requested: AuditEventEnum.MISSING_PERSON_MEDIA_REDACTION_REQUESTED,
  case_update_posted: AuditEventEnum.MISSING_PERSON_CASE_UPDATE_POSTED,
  child_flag_first_confirmation: AuditEventEnum.MISSING_PERSON_CHILD_FLAG_FIRST_CONFIRMED,
  child_safety_first_confirmation: AuditEventEnum.MISSING_PERSON_CHILD_FLAG_FIRST_CONFIRMED,
  message_owner: AuditEventEnum.MISSING_PERSON_OWNER_MESSAGED,
  export_csv: AuditEventEnum.MISSING_PERSON_EXPORTED,
  export_job_started: AuditEventEnum.MISSING_PERSON_EXPORT_STARTED,
  export_job_download: AuditEventEnum.MISSING_PERSON_EXPORT_DOWNLOADED,
};

"""

def patch_missing_person():
    rel = 'modules/core/missing-person/service/missing-person-common.service.ts'
    old = """  emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }
"""
    new = """  emitAudit(payload: AuditEventPayload): void {
    // Operations that were all logged as MISSING_PERSON_UPDATED get their own action.
    const op = (payload.metadata as { operation?: string } | null | undefined)?.operation;
    const specific = op ? MISSING_PERSON_OPERATION_ACTIONS[op] : undefined;
    const remap =
      !!specific &&
      (payload.action === AuditEventEnum.MISSING_PERSON_UPDATED || op === 'export_job_download');
    const out = remap ? { ...payload, action: specific } : payload;
    this.eventEmitter.emit(out.action, out);
  }
"""
    try: s = read(rel)
    except FileNotFoundError: FAIL.append(('missing-person action remap', rel + ' not found')); return
    if 'MISSING_PERSON_OPERATION_ACTIONS' in s: SKIP.append(('missing-person action remap', 'already applied')); return
    if s.count(old) != 1 or '@Injectable()' not in s: FAIL.append(('missing-person action remap', 'anchor not found')); return
    s = s.replace(old, new)
    s = s.replace('@Injectable()', MP_MAP + '@Injectable()', 1)
    s = add_named_import(s, 'AuditEventEnum', ENUM_MOD)
    write(rel, s); OK.append(('missing-person action remap', rel))

def patch_services():
    # report status: CLOSED / REJECTED get their own action
    replace_once('report CLOSED/REJECTED actions', 'modules/core/report/service/report-workflow.service.ts',
"""      action: AuditEventEnum.REPORT_STATUS_CHANGED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      reason: data.note ?? null,""",
"""      action:
        report.status === ReportStatus.CLOSED
          ? AuditEventEnum.REPORT_CLOSED
          : report.status === ReportStatus.REJECTED
            ? AuditEventEnum.REPORT_REJECTED
            : AuditEventEnum.REPORT_STATUS_CHANGED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      reason: data.note ?? null,""", imports=[('ReportStatus', '@prisma/client')])

    # role assignment requests that expire
    replace_once('role request expiry', 'modules/auth/service/role.service.ts',
"""  private async expireStaleRequests(): Promise<void> {
    await this.prisma.roleAssignmentRequest.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
  }""",
"""  private async expireStaleRequests(): Promise<void> {
    const stale = await this.prisma.roleAssignmentRequest.findMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } },
      select: { id: true, roleId: true, targetUserId: true },
    });
    if (stale.length === 0) return;
    const { count } = await this.prisma.roleAssignmentRequest.updateMany({
      where: { id: { in: stale.map((r) => r.id) }, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    if (count === 0) return;
    for (const r of stale) {
      this.emitAudit({
        actorType: ActorType.SYSTEM,
        action: AuditEventEnum.ROLE_ASSIGNMENT_REQUEST_EXPIRED,
        entity: 'RoleAssignmentRequest',
        entityId: r.id,
        targetUserId: r.targetUserId,
        diff: { result: 'success', roleId: r.roleId },
      });
    }
  }""", imports=[('ActorType', '@prisma/client')])

    # scheduled post purge
    rel = 'modules/core/post/service/post-retention.service.ts'
    replace_once('post retention: inject emitter', rel,
"""    private readonly configService: ConfigService,
  ) {}""",
"""    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}""", imports=[('EventEmitter2', '@nestjs/event-emitter'), ('ActorType', '@prisma/client'), ('AuditEventEnum', ENUM_MOD)])
    replace_once('post retention: audit each purge', rel,
"""        this.logger.log(`purged post ${post.id} (${reason})`);""",
"""        this.eventEmitter.emit(AuditEventEnum.POST_RETENTION_PURGED, {
          actorType: ActorType.SYSTEM,
          action: AuditEventEnum.POST_RETENTION_PURGED,
          entity: 'Post',
          entityId: post.id,
          reason,
          metadata: { mediaFiles: filepaths.length },
        });
        this.logger.log(`purged post ${post.id} (${reason})`);""")

    # evidence row created lazily on a GET
    rel = 'modules/core/report/service/report-case-management.service.ts'
    replace_once('evidence registered (start)', rel,
"""    return this.prisma.reportEvidence.create({
      data: {
        reportId: report.id,
        kind: field.toUpperCase() as ReportEvidenceKind,""",
"""    const created = await this.prisma.reportEvidence.create({
      data: {
        reportId: report.id,
        kind: field.toUpperCase() as ReportEvidenceKind,""")
    replace_once('evidence registered (end)', rel,
"""          create: { action: 'ADDED', actorId: report.userId, note: 'initial_submission' },
        },
      },
    });
  }""",
"""          create: { action: 'ADDED', actorId: report.userId, note: 'initial_submission' },
        },
      },
    });
    this.eventEmitter.emit(AuditEventEnum.REPORT_EVIDENCE_REGISTERED, {
      actorType: ActorType.SYSTEM,
      action: AuditEventEnum.REPORT_EVIDENCE_REGISTERED,
      entity: 'Report',
      entityId: report.id,
      metadata: { evidenceId: created.id, storageKey: key },
    });
    return created;
  }""", imports=[('ActorType', '@prisma/client'), ('AuditEventEnum', ENUM_MOD)])

    # export jobs that expire
    replace_once('report export expiry', 'modules/core/report/service/report-export.service.ts',
"""      await this.prisma.reportExportJob.update({
        where: { id: j.id },
        data: { status: 'EXPIRED', storageKey: null },
      });""",
"""      await this.prisma.reportExportJob.update({
        where: { id: j.id },
        data: { status: 'EXPIRED', storageKey: null },
      });
      this.reportCommonService.emitAudit({
        actorType: ActorType.SYSTEM,
        action: AuditEventEnum.REPORT_EXPORT_EXPIRED,
        entity: 'ReportExportJob',
        entityId: j.id,
      });""", imports=[('ActorType', '@prisma/client'), ('AuditEventEnum', ENUM_MOD)])
    replace_once('information export expiry', 'modules/core/information-submission/service/information-submission-export.service.ts',
"""      if (expired && job.storageKey) {
        await this.informationSubmissionCommonService.deleteMediaFiles([job.storageKey]);
      }""",
"""      if (expired && job.storageKey) {
        await this.informationSubmissionCommonService.deleteMediaFiles([job.storageKey]);
      }
      if (expired) {
        this.informationSubmissionCommonService.emitAudit({
          actorType: ActorType.SYSTEM,
          action: AuditEventEnum.INFORMATION_SUBMISSION_EXPORT_EXPIRED,
          entity: 'InformationExportJob',
          entityId: id,
        });
      }""", imports=[('ActorType', '@prisma/client'), ('AuditEventEnum', ENUM_MOD)])

# ---------------------------------------------------------------- run
patch_enum()
create_infra()
for f, h, o in DECOS: decorate(f, h, o)
patch_missing_person()
patch_services()

print('\n%s' % ('DRY RUN (no files written)' if DRY else 'APPLIED'))
print('  changed: %d   already done: %d   needs attention: %d' % (len(OK), len(SKIP), len(FAIL)))
for l, w in OK: print('  + %s  [%s]' % (l, w))
for l, w in SKIP: print('  = %s  (%s)' % (l, w))
for l, w in FAIL: print('  ! %s: %s' % (l, w))
print("""
Still manual (not found or not safe to automate): support-export expiry, user-export expiry,
information-submission attachment sync, missing-person export-job expiry, and the victim-profile
APPROVED / VERIFIED / PRIVACY_REVIEWED steps. Their enum values are added; only the emit line is left.
Next: run `npx tsc --noEmit` and your tests.""")
sys.exit(1 if FAIL else 0)

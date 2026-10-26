import { Prisma, ReportStatus } from '@prisma/client';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { RolesEnum } from 'src/common/enums/roles.enum';

// Adjust to match your actual PRD workflow if it changes
export const ALLOWED_STATUS_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  [ReportStatus.PENDING]: [ReportStatus.RECEIVED, ReportStatus.REJECTED],
  [ReportStatus.RECEIVED]: [ReportStatus.UNDER_REVIEW, ReportStatus.REJECTED],
  [ReportStatus.UNDER_REVIEW]: [
    ReportStatus.ASSIGNED,
    ReportStatus.ESCALATED,
    ReportStatus.UNABLE_TO_VERIFY,
    ReportStatus.REJECTED,
  ],
  [ReportStatus.ASSIGNED]: [ReportStatus.IN_PROGRESS, ReportStatus.ESCALATED],
  [ReportStatus.IN_PROGRESS]: [
    ReportStatus.ESCALATED,
    ReportStatus.CLOSED,
    ReportStatus.UNABLE_TO_VERIFY,
  ],
  [ReportStatus.ESCALATED]: [ReportStatus.IN_PROGRESS, ReportStatus.CLOSED],
  [ReportStatus.UNABLE_TO_VERIFY]: [ReportStatus.CLOSED, ReportStatus.UNDER_REVIEW],
  [ReportStatus.CLOSED]: [],
  [ReportStatus.REJECTED]: [],
};

// Terminal statuses used by findStalePending() and maybeFlagUserForRejections()
export const TERMINAL_STATUSES: ReportStatus[] = [ReportStatus.CLOSED, ReportStatus.REJECTED];

export const ADMIN_ROLE_NAMES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

// Retry cap for case-reference generation on a unique constraint collision
export const CASE_REFERENCE_MAX_ATTEMPTS = 5;

// Actual Postgres table name for the Report model (schema.prisma: @@map("report")).
// $queryRaw bypasses Prisma's model->table mapping, so raw SQL must use this name.
export const REPORT_TABLE = Prisma.raw('report');

// Six media-array fields shared by CreateReportDto/UpdateReportDto and Report
export const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;

export type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];

export type MediaBearing = Record<MediaFieldName, string[]>;

export type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

export const NEW_AUDIT_ACTIONS = [
  'REPORT_EVIDENCE_ADDED',
  'REPORT_EVIDENCE_REMOVED',
  'REPORT_EVIDENCE_REDACTED',
  'REPORT_MESSAGE_POSTED',
  'REPORT_FEEDBACK_SUBMITTED',
  'REPORT_REOPEN_REQUESTED',
  'REPORT_LOCATION_CHANGED',
  'REPORT_LOCATION_VIEWED',
  'REPORT_SYNCED',
  'REPORT_ERASURE_REQUESTED',
  'REPORT_URGENT_FLAGGED',
  'REPORT_ANONYMITY_CHANGED',
  'REPORT_CATEGORY_CHANGED',
  'REPORT_PRIORITY_CHANGED',
  'REPORT_RESOLVED',
  'REPORT_MERGED',
  'REPORT_UNMERGED',
  'REPORT_SPLIT',
  'REPORT_TEAM_ASSIGNED',
  'REPORT_DE_ESCALATED',
  'REPORT_ARCHIVED',
  'REPORT_UNARCHIVED',
  'REPORT_DELETED',
  'REPORT_RESTORED',
  'REPORT_INTEGRITY_FLAGGED',
  'REPORT_INTEGRITY_CLEARED',
  'REPORT_LINKED',
  'REPORT_UNLINKED',
  'REPORT_DUE_DATE_CHANGED',
  'REPORT_TAGS_CHANGED',
  'REPORT_SENSITIVITY_CHANGED',
  'REPORT_ACCESS_GRANTED',
  'REPORT_ACCESS_REVOKED',
  'REPORTER_REVEALED',
  'REPORT_LEGAL_HOLD_CHANGED',
  'REPORT_CASE_FILE_GENERATED',
  'REPORT_EMAIL_SENT',
  'REPORT_EXPORTED',
  'REPORT_EXPORT_DOWNLOADED',
  'REPORT_INFO_REQUEST_CHANGED',
  'REPORT_BULK_ACTION',
] as const;

export type NewAuditAction = (typeof NEW_AUDIT_ACTIONS)[number];

export const act = (a: NewAuditAction): AuditEventEnum => a as unknown as AuditEventEnum;

// Plain-string domain events for the new flows (consumed by notification
// listeners). Existing NotificationEventEnum members are reused where they fit.
export const NEW_EVENTS = {
  MESSAGE_CREATED: 'report.message.created',
  REOPEN_REQUESTED: 'report.reopen.requested',
  URGENT_FLAGGED: 'report.urgent.flagged',
  INFORMATION_REMINDER: 'report.information-request.reminder',
  INFORMATION_REVIEWED: 'report.information-request.reviewed',
  EVIDENCE_REDACTION_REQUESTED: 'report.evidence.redaction-requested',
  EMAIL_REPLY: 'report.email.reply',
  EXPORT_JOB_CREATED: 'report.export-job.created',
  ERASURE_REQUESTED: 'report.erasure.requested',
} as const;

export type RequestCtx = { ip?: string };

export const ANON_KEY_PREFIX = 'anon_';

export const TERMINAL_SQL = Prisma.raw(`('CLOSED','REJECTED')`);

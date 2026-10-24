import { Prisma, VictimProfile, VictimProfileStatus } from '@prisma/client';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';

export const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;

export type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];

export type MediaBearing = Record<MediaFieldName, string[]>;

export type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

export const UPDATABLE_FIELD_NAMES = [
  'name',
  'description',
  'story',
  'supportGoal',
  'photo',
  'video',
  'audio',
  'pdf',
  'document',
  'other',
  'involvesChild',
] as const;

export type ProfileAuditRef = Pick<VictimProfile, 'id' | 'name' | 'involvesChild' | 'createdByUserId'>;

export type ConflictAuditContext = {
  admin: CurrentUserDto;
  action: AuditEventEnum;
  profile: ProfileAuditRef;
};

export const STALE_ELIGIBLE_EXCLUDED_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PUBLISHED,
  VictimProfileStatus.REJECTED,
];

export const money = (d: Prisma.Decimal | number | string | null | undefined): string =>
  d == null ? '0.00' : new Prisma.Decimal(d).toFixed(2);

export async function mapWithConcurrency<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

// Creator-side lifecycle rules.
export const CREATOR_EDITABLE_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PENDING,
  VictimProfileStatus.REJECTED,
  VictimProfileStatus.CHANGES_REQUESTED,
];

export const CREATOR_WITHDRAWABLE_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PENDING,
  VictimProfileStatus.UNDER_REVIEW,
  VictimProfileStatus.VERIFIED,
  VictimProfileStatus.CONSENT_PENDING,
  VictimProfileStatus.APPROVED,
  VictimProfileStatus.CHANGES_REQUESTED,
];

export const CREATOR_RESUBMITTABLE_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.CHANGES_REQUESTED,
  VictimProfileStatus.REJECTED,
];

// Admin-side lifecycle rules.
export const CHANGE_REQUESTABLE_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PENDING,
  VictimProfileStatus.UNDER_REVIEW,
  VictimProfileStatus.VERIFIED,
  VictimProfileStatus.CONSENT_PENDING,
  VictimProfileStatus.APPROVED,
];

// Statuses that are "in the pipeline" (waiting on staff) — used by aging / backlog / child stats.
export const PIPELINE_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.PENDING,
  VictimProfileStatus.UNDER_REVIEW,
  VictimProfileStatus.VERIFIED,
  VictimProfileStatus.CONSENT_PENDING,
  VictimProfileStatus.APPROVED,
];

// Statuses from which a gate re-derivation is meaningful (anything that is not a closed outcome).
export const GATE_DRIVEN_STATUSES: VictimProfileStatus[] = [
  ...PIPELINE_STATUSES,
  VictimProfileStatus.PUBLISHED,
];

export const CLOSED_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.REJECTED,
  VictimProfileStatus.WITHDRAWN,
  VictimProfileStatus.COMPLETED,
];

export const APPROVED_OUTCOME_STATUSES: VictimProfileStatus[] = [
  VictimProfileStatus.APPROVED,
  VictimProfileStatus.PUBLISHED,
  VictimProfileStatus.COMPLETED,
];

// Which next statuses each status can reach, and through which endpoint (VP-65).
export const STATUS_TRANSITIONS: Record<
  VictimProfileStatus,
  Array<{ to: VictimProfileStatus; via: string }>
> = {
  PENDING: [
    { to: 'UNDER_REVIEW', via: 'PATCH admin/:id/gates' },
    { to: 'CHANGES_REQUESTED', via: 'PATCH admin/:id/request-changes' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  UNDER_REVIEW: [
    { to: 'CONSENT_PENDING', via: 'PATCH admin/:id/gates' },
    { to: 'VERIFIED', via: 'PATCH admin/:id/gates' },
    { to: 'CHANGES_REQUESTED', via: 'PATCH admin/:id/request-changes' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  CONSENT_PENDING: [
    { to: 'UNDER_REVIEW', via: 'POST admin/:id/consent' },
    { to: 'VERIFIED', via: 'POST admin/:id/consent' },
    { to: 'CHANGES_REQUESTED', via: 'PATCH admin/:id/request-changes' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  VERIFIED: [
    { to: 'APPROVED', via: 'PATCH admin/:id/gates (isAdminApproved)' },
    { to: 'CHANGES_REQUESTED', via: 'PATCH admin/:id/request-changes' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  APPROVED: [
    { to: 'PUBLISHED', via: 'PATCH admin/:id/publish' },
    { to: 'CHANGES_REQUESTED', via: 'PATCH admin/:id/request-changes' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  PUBLISHED: [
    { to: 'UNPUBLISHED', via: 'PATCH admin/:id/unpublish' },
    { to: 'UNPUBLISHED', via: 'POST admin/:id/takedown' },
    { to: 'COMPLETED', via: 'PATCH admin/:id/complete' },
  ],
  UNPUBLISHED: [{ to: 'PUBLISHED', via: 'PATCH admin/:id/publish (all gates must still hold)' }],
  CHANGES_REQUESTED: [
    { to: 'PENDING', via: 'PATCH mine/:id/resubmit (creator; re-derived from gates)' },
    { to: 'REJECTED', via: 'PATCH admin/:id/reject' },
    { to: 'WITHDRAWN', via: 'PATCH mine/:id/withdraw (creator)' },
  ],
  REJECTED: [
    {
      to: 'PENDING',
      via: 'PATCH admin/:id/resubmit | PATCH mine/:id/resubmit | appeal overturned',
    },
  ],
  WITHDRAWN: [],
  COMPLETED: [{ to: 'PUBLISHED', via: 'PATCH admin/:id/reopen' }],
};

// What a creator is allowed to see in their own timeline. Internal actions (gate flips,
// claims, child-safety confirmations, flags, bank verification...) are deliberately absent.
export const CREATOR_VISIBLE_STAFF_ACTIONS: AuditEventEnum[] = [
  AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
  AuditEventEnum.VICTIM_PROFILE_UNPUBLISHED,
  AuditEventEnum.VICTIM_PROFILE_REJECTED,
  AuditEventEnum.VICTIM_PROFILE_RESUBMITTED,
  AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED,
  AuditEventEnum.VICTIM_PROFILE_COMPLETED,
  AuditEventEnum.VICTIM_PROFILE_REOPENED,
  AuditEventEnum.VICTIM_PROFILE_TAKEDOWN,
  AuditEventEnum.VICTIM_PROFILE_TAKEDOWN_LIFTED,
  AuditEventEnum.VICTIM_PROFILE_APPEAL_DECIDED,
  AuditEventEnum.VICTIM_PROFILE_UPDATE_POSTED,
];

export const CREATOR_TIMELINE_ACTIONS: AuditEventEnum[] = [
  ...CREATOR_VISIBLE_STAFF_ACTIONS,
  AuditEventEnum.VICTIM_PROFILE_CREATED,
  AuditEventEnum.VICTIM_PROFILE_UPDATED,
  AuditEventEnum.VICTIM_PROFILE_WITHDRAWN,
  AuditEventEnum.VICTIM_PROFILE_APPEAL_CREATED,
];

// Used by the review-time / backlog stats, which are derived from the audit trail so they work
// for transitions made by the existing methods too.
export const FIRST_REVIEW_ACTIONS: AuditEventEnum[] = [
  AuditEventEnum.VICTIM_PROFILE_CLAIMED,
  AuditEventEnum.VICTIM_PROFILE_GATES_UPDATED,
  AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_FIRST_CONFIRMED,
  AuditEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
  AuditEventEnum.VICTIM_PROFILE_CHANGES_REQUESTED,
  AuditEventEnum.VICTIM_PROFILE_REJECTED,
  AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
];

export const DECISION_ACTIONS: AuditEventEnum[] = [
  AuditEventEnum.VICTIM_PROFILE_PUBLISHED,
  AuditEventEnum.VICTIM_PROFILE_REJECTED,
];

export const CHILD_FLAG_PROPOSAL_TTL_MS = 72 * 60 * 60 * 1000;

// Public-facing projection (kept identical to the select used by findPublic / findOnePublic so
// serializePublicProfile() keeps working for every public list).
export const PUBLIC_PROFILE_SELECT = {
  id: true,
  name: true,
  story: true,
  supportGoal: true,
  photo: true,
  involvesChild: true,
  totalRaised: true,
  createdAt: true,
} satisfies Prisma.VictimProfileSelect;

export const maskAccount = (n: string | null | undefined): string | null =>
  n ? `${'•'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}` : null;

// CSV: quote every cell and neutralise spreadsheet-formula injection (=, +, -, @, tab, CR).
export const csvCell = (v: unknown): string => {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export const hoursBetween = (a: Date, b: Date): number => (b.getTime() - a.getTime()) / 3_600_000;

export const summarize = (hours: number[]) => {
  if (!hours.length) return { count: 0, avgHours: null, medianHours: null, p90Hours: null };
  const s = [...hours].sort((x, y) => x - y);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    count: s.length,
    avgHours: r(s.reduce((a, b) => a + b, 0) / s.length),
    medianHours: r(at(0.5)),
    p90Hours: r(at(0.9)),
  };
};

export const EXPORT_COLUMNS = [
    'id',
    'label',
    'status',
    'supportGoal',
    'totalRaised',
    'involvesChild',
    'isPublished',
    'donationsPaused',
    'assignedReviewerId',
    'claimedByUserId',
    'createdByUserId',
    'createdAt',
    'updatedAt',
  ] as const;
export const STATS_ROW_CAP = 20_000;
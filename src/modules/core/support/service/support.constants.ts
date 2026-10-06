import { Prisma, SupportDisputeReason, SupportStatus } from '@prisma/client';
import { RolesEnum } from 'src/common/enums/roles.enum';

export const ADMIN_ROLE_NAMES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

// Only these statuses are shown publicly and counted in total raised (financial) or offers received.
export const COUNTED_STATUSES: SupportStatus[] = [SupportStatus.CONFIRMED, SupportStatus.COMPLETED];

export const ANONYMOUS_LABEL = 'An anonymous supporter';

// Default number of days an unanswered non-financial offer waits before it is auto-cancelled.
export const DEFAULT_OFFER_EXPIRY_DAYS = 14;

// Never includes allocationSnapshot or the User relation.
export const SUPPORT_OWNER_SELECT = {
  id: true,
  victimProfileId: true,
  userId: true,
  type: true,
  status: true,
  agreementType: true,
  message: true,
  categories: true,
  anonymous: true,
  contactMayBeShared: true,
  victimConfirmedReceiptAt: true,
  transferReference: true,
  amount: true,
  recipientAmount: true,
  organizationAmount: true,
  platformAmount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SupportSelect;

// Bank details and internal review fields are deliberately left out.
export const VICTIM_PROFILE_SUMMARY_SELECT = {
  id: true,
  name: true,
  description: true,
  photo: true,
  status: true,
  isPublished: true,
  supportGoal: true,
  totalRaised: true,
} satisfies Prisma.VictimProfileSelect;

// ── Constants for the case-management endpoints (SP-01 .. SP-68) ──

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_ACTIVE_ATTACHMENTS = 10;

export const EXPORT_SYNC_ROW_CAP = 5_000;

export const EXPORT_JOB_ROW_CAP = 50_000;

export const EXPORT_JOB_TTL_HOURS = 24;

export const MAX_ACTIVE_EXPORT_JOBS_PER_ADMIN = 2;

export const MARK_ALL_READ_BATCH = 1_000;

export const MARK_ALL_READ_MAX_BATCHES = 10;

export const BULK_EXPIRE_MAX = 500;

// Repeat-dispute rule: this many disputes, or at least one confirmed non-delivery.
export const REPEAT_DISPUTE_THRESHOLD = 2;

export const SUPPORTER_DISPUTE_REASONS: SupportDisputeReason[] = [
  SupportDisputeReason.MISMATCH,
  SupportDisputeReason.RECIPIENT_DENIES_RECEIPT,
  SupportDisputeReason.OTHER,
];

export const RECIPIENT_DISPUTE_REASONS: SupportDisputeReason[] = [
  SupportDisputeReason.NOT_DELIVERED,
  SupportDisputeReason.MISMATCH,
  SupportDisputeReason.OTHER,
];

export const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  gif: 'image/gif',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};

// Admin list rows: supporter contact is included because the team follows up off the platform.
export const adminListSelect = (adminId: string) =>
  ({
    ...SUPPORT_OWNER_SELECT,
    assignedReviewerId: true,
    user: { select: { id: true, name: true, phone: true, email: true } },
    victimProfile: { select: { id: true, name: true, claimedByUserId: true } },
    adminReads: { where: { adminId }, select: { adminId: true } },
  }) satisfies Prisma.SupportSelect;

// What the supporter sees about their own attachments.
export const ATTACHMENT_OWNER_SELECT = {
  id: true,
  key: true,
  kind: true,
  mimeType: true,
  note: true,
  createdAt: true,
} satisfies Prisma.SupportAttachmentSelect;

export const DISPUTE_SELECT = {
  id: true,
  supportId: true,
  side: true,
  reason: true,
  details: true,
  status: true,
  outcome: true,
  resolutionReason: true,
  resolvedAt: true,
  createdAt: true,
} satisfies Prisma.SupportDisputeSelect;

// ───────────────────────────── shared helpers ─────────────────────────────

export const INCOMING_SELECT = {
  id: true,
  status: true,
  categories: true,
  message: true,
  anonymous: true,
  createdAt: true,
  victimConfirmedReceiptAt: true,
  thanksSentAt: true,
  declinedAt: true,
  recipientOpenedAt: true,
  victimProfile: { select: { id: true, name: true } },
  user: { select: { name: true } },
} satisfies Prisma.SupportSelect;

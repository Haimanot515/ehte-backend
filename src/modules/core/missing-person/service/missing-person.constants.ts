import { MissingPerson, MissingPersonStatus, Prisma } from '@prisma/client';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';

// Media array fields shared by the DTOs and the MissingPerson model.
export const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;

export type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];

export type MediaBearing = Record<MediaFieldName, string[]>;

export type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

export const UPDATABLE_FIELD_NAMES = [
  'personType',
  'name',
  'description',
  'dateLastSeen',
  'lastKnownArea',
  'photo',
  'video',
  'audio',
  'pdf',
  'document',
  'other',
] as const;

export type MissingPersonAuditRef = Pick<MissingPerson, 'id' | 'name' | 'personType' | 'userId'>;

export const TERMINAL_STATUSES: MissingPersonStatus[] = [
  MissingPersonStatus.REJECTED,
  MissingPersonStatus.FOUND,
  MissingPersonStatus.EXPIRED,
  MissingPersonStatus.CANCELLED,
];

// Cases still waiting on an initial decision.
export const BACKLOG_STATUSES: MissingPersonStatus[] = [
  MissingPersonStatus.PENDING,
  MissingPersonStatus.UNDER_REVIEW,
  MissingPersonStatus.MORE_INFORMATION_REQUESTED,
];

export type PageQuery = { page?: number; limit?: number };

export type BulkResult = {
  succeeded: string[];
  failed: Array<{ id: string; reason: string }>;
};

export const EDITABLE_STATUSES: MissingPersonStatus[] = [
  MissingPersonStatus.PENDING,
  MissingPersonStatus.MORE_INFORMATION_REQUESTED,
];

export const ALLOWED_TRANSITIONS: Record<MissingPersonStatus, MissingPersonStatus[]> = {
  [MissingPersonStatus.PENDING]: [
    MissingPersonStatus.UNDER_REVIEW,
    MissingPersonStatus.CANCELLED,
    MissingPersonStatus.EXPIRED,
  ],
  [MissingPersonStatus.UNDER_REVIEW]: [
    MissingPersonStatus.MORE_INFORMATION_REQUESTED,
    MissingPersonStatus.APPROVED,
    MissingPersonStatus.REJECTED,
    MissingPersonStatus.CANCELLED,
    MissingPersonStatus.EXPIRED,
  ],
  [MissingPersonStatus.MORE_INFORMATION_REQUESTED]: [
    MissingPersonStatus.CANCELLED,
    MissingPersonStatus.EXPIRED,
  ],
  [MissingPersonStatus.APPROVED]: [MissingPersonStatus.FOUND, MissingPersonStatus.EXPIRED],
  [MissingPersonStatus.REJECTED]: [],
  [MissingPersonStatus.FOUND]: [],
  [MissingPersonStatus.EXPIRED]: [],
  [MissingPersonStatus.CANCELLED]: [],
};

// Explicit public projection so new model fields never leak by default.
export const PUBLIC_SELECT = {
  id: true,
  personType: true,
  name: true,
  description: true,
  dateLastSeen: true,
  lastKnownArea: true,
  photo: true,
  video: true,
  audio: true,
  pdf: true,
  document: true,
  other: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Deleted and merged cases are hidden from the admin queues below.
export const ADMIN_BASE_WHERE: Prisma.MissingPersonWhereInput = {
  deletedAt: null,
  mergedIntoId: null,
};

// Audit actions that mean something to the family, used by the owner timeline and unread badge.
export const FAMILY_VISIBLE_ACTIONS: string[] = [
  AuditEventEnum.MISSING_PERSON_CREATED,
  AuditEventEnum.MISSING_PERSON_APPROVED,
  AuditEventEnum.MISSING_PERSON_REJECTED,
  AuditEventEnum.MISSING_PERSON_FOUND,
  AuditEventEnum.MISSING_PERSON_MORE_INFO_REQUESTED,
  AuditEventEnum.MISSING_PERSON_UPDATED,
];

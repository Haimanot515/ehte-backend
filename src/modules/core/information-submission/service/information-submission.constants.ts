import { InformationStatus } from '@prisma/client';

// Media array fields shared by the DTOs and the InformationSubmission model.
export const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;

export type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];

export type MediaBearing = Record<MediaFieldName, string[]>;

export type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

export const ALLOWED_STATUS_TRANSITIONS: Record<InformationStatus, InformationStatus[]> = {
  [InformationStatus.PENDING]: [InformationStatus.UNDER_REVIEW],
  [InformationStatus.UNDER_REVIEW]: [],
  [InformationStatus.REVIEWED]: [],
  [InformationStatus.REJECTED]: [],
};

export const OPEN_STATUSES: InformationStatus[] = [
  InformationStatus.PENDING,
  InformationStatus.UNDER_REVIEW,
];

export const TERMINAL_STATUSES: InformationStatus[] = [
  InformationStatus.REVIEWED,
  InformationStatus.REJECTED,
];

export const PRIORITY_RANK: Record<string, number> = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3,
};

// Emitted when an admin asks for a face/region blur. A worker is expected to listen for it,
// write the redacted copy to MinIO and set InformationAttachment.redactedKey/redactionStatus.
export const MEDIA_REDACTION_REQUESTED_EVENT = 'information-submission.media.redaction-requested';

import { PostAppealStatus, PostFlagStatus, PostStatus, PostType } from '@prisma/client';

// Statuses the owner may edit/submit from; PENDING is frozen until admin action.
export const OWNER_EDITABLE_STATUSES: PostStatus[] = [PostStatus.DRAFT, PostStatus.CHANGES_REQUESTED];

// The six media-array fields shared by CreatePostDto/UpdatePostDto and the Post model.
export const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;
export type MediaFieldName = (typeof MEDIA_FIELD_NAMES)[number];
export type MediaBearing = Record<MediaFieldName, string[]>;
export type MediaBearingDto = Partial<Record<MediaFieldName, string[] | undefined>>;

export type PostAuditRef = {
  id: string;
  userId: string;
  title: string | null;
  type: PostType;
};

// Titles are free text, so the audit label is capped to keep it list-friendly.
export const ENTITY_LABEL_MAX_LENGTH = 120;

// Single source of truth for what status can move to what.
export const ALLOWED_STATUS_TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  [PostStatus.DRAFT]: [PostStatus.PENDING],
  [PostStatus.PENDING]: [
    PostStatus.APPROVED,
    PostStatus.REJECTED,
    PostStatus.CHANGES_REQUESTED,
    PostStatus.DRAFT,
  ],
  [PostStatus.CHANGES_REQUESTED]: [PostStatus.PENDING],
  [PostStatus.APPROVED]: [PostStatus.PUBLISHED, PostStatus.REJECTED],
  [PostStatus.PUBLISHED]: [PostStatus.UNPUBLISHED],
  [PostStatus.UNPUBLISHED]: [PostStatus.PUBLISHED],
  [PostStatus.REJECTED]: [],
};

export const STATUSES_THAT_CHANGE_PUBLIC_VISIBILITY: PostStatus[] = [
  PostStatus.PUBLISHED,
  PostStatus.UNPUBLISHED,
];

export const PUBLIC_POST_OMIT_FIELDS = [
  'userId',
  'reviewNote',
  'idempotencyKey',
  'claimedByUserId',
  'claimedAt',
  'childSafetyFirstConfirmedByUserId',
  'childSafetyFirstConfirmedAt',
  'ownerSuspendedAt',
  'takedownReason',
  'takedownAt',
  'takedownById',
] as const;

// Open-state shortcuts for flags and appeals.
export const FLAG_OPEN = PostFlagStatus.OPEN;
export const APPEAL_OPEN = PostAppealStatus.OPEN;

// Statuses of the author-facing summary, in the order the response lists them.
export const SUMMARY_STATUSES: PostStatus[] = Object.values(PostStatus);

// Only these transitions are shown to the author in their review timeline.
export const AUTHOR_VISIBLE_REASON_STATUSES: string[] = [
  PostStatus.REJECTED,
  PostStatus.CHANGES_REQUESTED,
];

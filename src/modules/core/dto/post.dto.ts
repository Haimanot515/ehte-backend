import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { Transform, Type } from 'class-transformer';

import { PostStatus, PostType } from '@prisma/client';

export class CreatePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsString()
  @MinLength(3)
  content!: string;

  @IsEnum(PostType)
  type!: PostType;

  // Added — flags content involving a child, driving the
  // additional-review gate required by PRD §32. Optional so
  // existing clients that don't send it keep working (defaults
  // to false in the service).
  @IsOptional()
  @IsBoolean()
  involvesChild?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];
}

// ─────────────────────────────────────────────
// Added — owner edit, PATCH /posts/me/:id.
// Allowed only while DRAFT or CHANGES_REQUESTED
// (enforced in PostService, not here).
// ─────────────────────────────────────────────

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  content?: string;

  @IsOptional()
  @IsEnum(PostType)
  type?: PostType;

  @IsOptional()
  @IsBoolean()
  involvesChild?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];
}

// ─────────────────────────────────────────────
// Added — admin "Request changes", PRD §24.
// PATCH /posts/:id/request-changes
// ─────────────────────────────────────────────

export class RequestPostChangesDto {
  @IsString()
  @MinLength(3)
  message!: string;
}

// ─────────────────────────────────────────────
// Added — admin approve body. childSafetyConfirmed
// is required (enforced in PostService.approve)
// whenever the post has involvesChild = true.
// ─────────────────────────────────────────────

export class ApprovePostDto {
  @IsOptional()
  @IsBoolean()
  childSafetyConfirmed?: boolean;
}

// ─────────────────────────────────────────────
// Added — admin reject body, PRD §24 + §40
// (Transparency: "Users should understand what
// happens to their information"). Mirrors
// RequestPostChangesDto so the owner always gets a
// reason when a Post leaves their control instead
// of just a bare status flip.
// ─────────────────────────────────────────────

export class RejectPostDto {
  @IsString()
  @MinLength(3)
  reason!: string;
}

// ─────────────────────────────────────────────
// Added — admin "official Post" creation, PRD §13:
// "Authorized administrators can create official
// Posts." Reuses CreatePostDto's content fields but
// adds an explicit choice of whether the post skips
// review straight to APPROVED (still gated behind
// the normal publish step) — admin authorship is
// itself the review, so PENDING would be redundant.
// involvesChild is still honoured: if true, publish()
// is unaffected, but approve()'s child-safety gate
// does not apply here since there is no approve()
// call in this path — the admin creating the post
// IS the confirmation. Kept as a separate flag
// (not inferred) so admins acting on behalf of a
// user can't accidentally bypass review by mislabeling
// authorship.
// ─────────────────────────────────────────────

export class AdminCreatePostDto extends CreatePostDto {
  // If true, the post is created directly as APPROVED,
  // ready for an explicit /publish call. If false (default),
  // it is created as PENDING, going through the normal
  // approve/reject/request-changes flow like a user post —
  // useful when an admin is drafting on someone else's behalf
  // and still wants a second reviewer to sign off.
  @IsOptional()
  @IsBoolean()
  publishImmediately?: boolean;
}

// ─────────────────────────────────────────────
// Added — admin list filters/pagination for
// GET /posts, matching AdminReportQueryDto's shape.
//
// Fixed — involvesChild now uses the same
// string-aware @Transform as ListUsersQueryDto's
// isActive/discreetModeEnabled. @Type(() => Boolean)
// coerces via JS's Boolean(), so the string "false"
// (any non-empty string) becomes `true` — silently
// inverting the filter. @Transform below checks the
// raw value against the literal string 'true'.
// ─────────────────────────────────────────────

export class AdminPostQueryDto {
  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;

  @IsOptional()
  @IsEnum(PostType)
  type?: PostType;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  involvesChild?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ─────────────────────────────────────────────
// Added — pagination for GET /posts/published.
// PRD §30 (Low Bandwidth Requirements): "low data
// usage, lightweight screens". This is the one
// anonymous, public, unauthenticated endpoint here —
// the most likely to be hit hard and to grow
// unbounded — so it gets the same page/limit shape
// AdminPostQueryDto already has for the admin list.
// ─────────────────────────────────────────────

export class PublishedPostsQueryDto {
  @IsOptional()
  @IsEnum(PostType)
  type?: PostType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

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

import { Type } from 'class-transformer';

import { PostStatus, PostType } from '@prisma/client';

export class CreatePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsString()
  @MinLength(3)
  content: string;

  @IsEnum(PostType)
  type: PostType;

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
  message: string;
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
// Added — admin list filters/pagination for
// GET /posts, matching AdminReportQueryDto's shape.
// ─────────────────────────────────────────────

export class AdminPostQueryDto {
  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;

  @IsOptional()
  @IsEnum(PostType)
  type?: PostType;

  @IsOptional()
  @Type(() => Boolean)
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
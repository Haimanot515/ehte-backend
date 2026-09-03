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

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { PostStatus, PostType } from '@prisma/client';

export class CreatePostDto {
  @ApiPropertyOptional({ maxLength: 200, example: 'Community safety walk this Saturday' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiProperty({ minLength: 3, example: 'Details about the incident or awareness message...' })
  @IsString()
  @MinLength(3)
  content!: string;

  @ApiProperty({ enum: PostType, example: PostType.AWARENESS })
  @IsEnum(PostType)
  type!: PostType;

  // Flags content involving a child, driving the additional-review
  // gate required by PRD §32. Optional so existing clients that
  // don't send it keep working (defaults to false in the service).
  @ApiPropertyOptional({ default: false, description: 'Triggers additional child-safety review (PRD §32).' })
  @IsOptional()
  @IsBoolean()
  involvesChild?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];
}

// ─────────────────────────────────────────────
// Owner edit, PATCH /posts/me/:id.
// Allowed only while DRAFT or CHANGES_REQUESTED
// (enforced in PostService, not here).
// ─────────────────────────────────────────────

export class UpdatePostDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ minLength: 3 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  content?: string;

  @ApiPropertyOptional({ enum: PostType })
  @IsOptional()
  @IsEnum(PostType)
  type?: PostType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  involvesChild?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];
}

// ─────────────────────────────────────────────
// Admin "Request changes", PRD §24.
// PATCH /posts/:id/request-changes
// ─────────────────────────────────────────────

export class RequestPostChangesDto {
  @ApiProperty({ minLength: 3, example: 'Please blur the second photo before resubmitting.' })
  @IsString()
  @MinLength(3)
  message!: string;
}

// ─────────────────────────────────────────────
// Admin approve body. childSafetyConfirmed is
// required (enforced in PostService.approve)
// whenever the post has involvesChild = true.
// ─────────────────────────────────────────────

export class ApprovePostDto {
  @ApiPropertyOptional({
    description: 'Required (must be true) when the post has involvesChild = true (PRD §32).',
  })
  @IsOptional()
  @IsBoolean()
  childSafetyConfirmed?: boolean;
}

// ─────────────────────────────────────────────
// Admin reject body, PRD §24 + §40 (Transparency).
// ─────────────────────────────────────────────

export class RejectPostDto {
  @ApiProperty({ minLength: 3, example: 'Content does not comply with platform guidelines.' })
  @IsString()
  @MinLength(3)
  reason!: string;
}

// ─────────────────────────────────────────────
// FIX (#2 / #3) — Admin "official Post" creation,
// PRD §13. Previously this DTO had NO
// childSafetyConfirmed field at all, so an
// involvesChild=true post created via this path
// could reach APPROVED (and then PUBLISHED) with
// zero explicit child-safety confirmation anywhere
// in the code or the audit trail — only a comment
// asserting "admin authorship IS the confirmation."
//
// Now mirrors ApprovePostDto: when involvesChild is
// true AND publishImmediately is true (the
// straight-to-APPROVED path), childSafetyConfirmed
// must be explicitly true. Enforced in
// PostService.createOfficial.
// ─────────────────────────────────────────────

export class AdminCreatePostDto extends CreatePostDto {
  // If true (default), the post is created directly as APPROVED,
  // ready for an explicit /publish call. If false, it is created
  // as PENDING and goes through the normal approve/reject/
  // request-changes flow like a user post.
  @ApiPropertyOptional({
    default: true,
    description: 'If true, skips straight to APPROVED. If false, goes through normal PENDING review.',
  })
  @IsOptional()
  @IsBoolean()
  publishImmediately?: boolean;

  // Required when involvesChild is true AND publishImmediately
  // is true. Not required on the PENDING path, since that path
  // still goes through approve()'s own gate later.
  @ApiPropertyOptional({
    description: 'Required (must be true) when involvesChild is true and publishImmediately is true.',
  })
  @IsOptional()
  @IsBoolean()
  childSafetyConfirmed?: boolean;
}

// ─────────────────────────────────────────────
// Admin list filters/pagination for GET /posts,
// matching AdminReportQueryDto's shape.
//
// involvesChild uses a string-aware @Transform
// (the naive @Type(() => Boolean) would turn the
// string "false" into `true` via JS's Boolean()).
//
// FIX (#6) — added authorId, the equivalent of
// assignedTo on the Report query. Previously there
// was no way to pull "all posts by this user."
// ─────────────────────────────────────────────

export class AdminPostQueryDto {
  @ApiPropertyOptional({ enum: PostStatus })
  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;

  @ApiPropertyOptional({ enum: PostType })
  @IsOptional()
  @IsEnum(PostType)
  type?: PostType;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  involvesChild?: boolean;

  @ApiPropertyOptional({ description: 'Filter by post author (userId).' })
  @IsOptional()
  @IsString()
  authorId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ─────────────────────────────────────────────
// Pagination for GET /posts/published. PRD §30
// (Low Bandwidth Requirements).
// ─────────────────────────────────────────────

export class PublishedPostsQueryDto {
  @ApiPropertyOptional({ enum: PostType })
  @IsOptional()
  @IsEnum(PostType)
  type?: PostType;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ─────────────────────────────────────────────
// FIX (#13) — PATCH /posts/:id/status previously
// read `status` straight off the request body with
// @Body('status'), bypassing DTO validation. Any
// string could reach Prisma. Now routed through a
// real DTO with @IsEnum, matching every other write
// endpoint in this controller.
// ─────────────────────────────────────────────

export class UpdatePostStatusDto {
  @ApiProperty({ enum: PostStatus })
  @IsEnum(PostStatus)
  status!: PostStatus;

  // FIX (#1) — required whenever the target status is
  // APPROVED or PUBLISHED and the post has involvesChild
  // = true. Closes the bypass where this generic endpoint
  // could skip approve()'s child-safety gate entirely.
  @ApiPropertyOptional({
    description: 'Required (must be true) when moving an involvesChild post to APPROVED or PUBLISHED.',
  })
  @IsOptional()
  @IsBoolean()
  childSafetyConfirmed?: boolean;
}
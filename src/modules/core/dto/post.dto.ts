import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
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

  @ApiPropertyOptional({
    default: false,
    description: 'Triggers additional child-safety review (PRD §32).',
  })
  @IsOptional()
  @IsBoolean()
  involvesChild?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  // NOTE: same as pdf above — whatever document content-types you
  // intend to accept must be listed in MEDIA_ALLOWED_MIME_TYPES.
  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];

  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;
}

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

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO filepaths returned by POST /media/upload-url',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];
}

export class RequestPostChangesDto {
  @ApiProperty({ minLength: 3, example: 'Please blur the second photo before resubmitting.' })
  @IsString()
  @MinLength(3)
  message!: string;
}

export class ApprovePostDto {
  @ApiPropertyOptional({
    description:
      'Required (must be true) when the post has involvesChild = true (PRD §32). Two DIFFERENT admins must each send true before the post actually becomes APPROVED.',
  })
  @IsOptional()
  @IsBoolean()
  childSafetyConfirmed?: boolean;
}

export class RejectPostDto {
  @ApiProperty({ minLength: 3, example: 'Content does not comply with platform guidelines.' })
  @IsString()
  @MinLength(3)
  reason!: string;
}

export class AdminCreatePostDto extends CreatePostDto {
  @ApiPropertyOptional({
    default: true,
    description:
      'If true, skips straight to APPROVED. If false, goes through normal PENDING review.',
  })
  @IsOptional()
  @IsBoolean()
  publishImmediately?: boolean;

  @ApiPropertyOptional({
    description:
      'Required (must be true) when involvesChild is true and publishImmediately is true.',
  })
  @IsOptional()
  @IsBoolean()
  childSafetyConfirmed?: boolean;
}

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

export class UpdatePostStatusDto {
  @ApiProperty({ enum: PostStatus })
  @IsEnum(PostStatus)
  status!: PostStatus;

  @ApiPropertyOptional({
    description:
      'Required (must be true) when moving an involvesChild post to APPROVED or PUBLISHED. Two DIFFERENT admins must each send true.',
  })
  @IsOptional()
  @IsBoolean()
  childSafetyConfirmed?: boolean;
}

export class BulkPostIdsDto {
  @ApiProperty({ type: [String], description: 'Post ids to act on in one request.' })
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  ids!: string[];
}

export class BulkRejectPostDto extends BulkPostIdsDto {
  @ApiProperty({ minLength: 3, example: 'Content does not comply with platform guidelines.' })
  @IsString()
  @MinLength(3)
  reason!: string;
}

export class PostPageQueryDto {
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

export class UnreadPostsQueryDto extends PostPageQueryDto {
  @ApiPropertyOptional({ enum: PostStatus })
  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;

  @ApiPropertyOptional({ enum: PostType })
  @IsOptional()
  @IsEnum(PostType)
  type?: PostType;
}

export class PostAuthorRollupQueryDto extends PostPageQueryDto {
  @ApiPropertyOptional({ enum: ['totalPosts', 'lastPostAt', 'pending'] })
  @IsOptional()
  @IsIn(['totalPosts', 'lastPostAt', 'pending'])
  sortBy?: 'totalPosts' | 'lastPostAt' | 'pending';

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

export class PostsByAuthorQueryDto extends PostPageQueryDto {
  @ApiPropertyOptional({ enum: PostStatus })
  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;

  @ApiPropertyOptional({ enum: PostType })
  @IsOptional()
  @IsEnum(PostType)
  type?: PostType;
}

export class FlaggedPostsQueryDto extends PostPageQueryDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'DISMISSED', 'ACTIONED'], default: 'OPEN' })
  @IsOptional()
  @IsIn(['OPEN', 'DISMISSED', 'ACTIONED'])
  flagStatus?: 'OPEN' | 'DISMISSED' | 'ACTIONED';
}

export class PostAppealsQueryDto extends PostPageQueryDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'UPHELD', 'OVERTURNED'], default: 'OPEN' })
  @IsOptional()
  @IsIn(['OPEN', 'UPHELD', 'OVERTURNED'])
  appealStatus?: 'OPEN' | 'UPHELD' | 'OVERTURNED';
}

export class PostTimelineQueryDto {
  @ApiProperty({ example: '2026-09-01T00:00:00.000Z' })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: '2026-10-01T00:00:00.000Z' })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ enum: ['day', 'week', 'month'], default: 'day' })
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  bucket?: 'day' | 'week' | 'month';

  @ApiPropertyOptional({ enum: PostStatus })
  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;

  @ApiPropertyOptional({ enum: PostType })
  @IsOptional()
  @IsEnum(PostType)
  type?: PostType;

  @ApiPropertyOptional({ description: 'Filter by post author (userId).' })
  @IsOptional()
  @IsString()
  authorId?: string;
}

export class AppealPostDto {
  @ApiProperty({
    minLength: 20,
    maxLength: 2000,
    example: 'The photo shows a public event and no one is identifiable. Please review again.',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  message!: string;
}

export class FlagPostDto {
  @ApiProperty({
    enum: ['MISINFORMATION', 'ABUSE', 'PRIVACY', 'CHILD_SAFETY', 'SPAM', 'OTHER'],
  })
  @IsIn(['MISINFORMATION', 'ABUSE', 'PRIVACY', 'CHILD_SAFETY', 'SPAM', 'OTHER'])
  reason!: 'MISINFORMATION' | 'ABUSE' | 'PRIVACY' | 'CHILD_SAFETY' | 'SPAM' | 'OTHER';

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  details?: string;
}

export class ResolvePostFlagsDto {
  @ApiProperty({ enum: ['DISMISSED', 'ACTIONED'] })
  @IsIn(['DISMISSED', 'ACTIONED'])
  outcome!: 'DISMISSED' | 'ACTIONED';

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class TakedownPostDto {
  @ApiProperty({ minLength: 10, maxLength: 1000, example: 'Shows an identifiable minor.' })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Notify the author of the takedown and their right to appeal.',
  })
  @IsOptional()
  @IsBoolean()
  notifyAuthor?: boolean;
}

export class DecidePostAppealDto {
  @ApiProperty({ enum: ['UPHELD', 'OVERTURNED'] })
  @IsIn(['UPHELD', 'OVERTURNED'])
  decision!: 'UPHELD' | 'OVERTURNED';

  @ApiProperty({ minLength: 10, maxLength: 1000 })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note!: string;
}

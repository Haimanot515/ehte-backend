import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

import { MissingPersonType, MissingPersonStatus } from '@prisma/client';

// ─────────────────────────────────────────────
// FIX: media fields now take bare MinIO object keys (e.g.
// "photo/<uuid>.jpg"), validated with @IsArray() @IsString({ each:
// true }) — same as CreateReportDto/UpdateReportDto and every
// other media-bearing DTO in the codebase (Post, VictimProfile).
//
// Previously these were validated with @IsUrl({}, { each: true }),
// requiring a full https://... URL — the only media-bearing DTO
// that did this. That mismatch is what caused every submission to
// fail with media_files_not_found: MinioService.objectExists()/
// statObject() expect a bare key scoped to the single configured
// bucket, not a full URL (which, for path-style S3/MinIO URLs,
// embeds the bucket name as a path segment MinIO was never asked
// to skip). Aligning the validator with every other module removes
// the need for any URL-unwrapping logic in the service layer —
// the console's uploader already returns a bare `filepath`/`key`
// from POST /media/presigned-upload, so no client-side change is
// needed once this field just accepts that value directly.
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// CREATE MISSING PERSON DTO
// ─────────────────────────────────────────────

export class CreateMissingPersonDto {
  @ApiProperty({ enum: MissingPersonType })
  @IsEnum(MissingPersonType)
  personType: MissingPersonType;

  @ApiPropertyOptional({ example: 'Metania Shiferaw' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiProperty({
    example: 'Metania was last seen wearing a blue jacket and black trousers...',
  })
  @IsString()
  @MaxLength(5000)
  description: string;

  @ApiProperty({ example: '2026-09-10T00:00:00.000Z' })
  @IsDateString()
  dateLastSeen: string;

  @ApiProperty({ example: 'Bole, Addis Ababa' })
  @IsString()
  @MaxLength(500)
  lastKnownArea: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['photo/550e8400-e29b-41d4-a716-446655440000.jpg'],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];

  // ─────────────────────────────────────────
  // REWARD PROPOSAL
  //
  // The submitter can PROPOSE a reward here — "I will pay this
  // amount if the missing person is found." rewardOffered gates the
  // other two: rewardAmount is REQUIRED the moment rewardOffered is
  // true (enforced below via @ValidateIf — a bare "I'm offering a
  // reward" with no number attached isn't a real commitment), while
  // rewardDetails stays optional either way (conditions, how to
  // claim, etc.).
  //
  // This is a proposal only: it does NOT make the reward visible on
  // the public endpoints and does NOT need admin sign-off to be
  // saved. rewardApproved is deliberately absent from this DTO and
  // always defaults to false at creation — approving a proposed
  // reward is an admin-only decision made after review, via
  // PATCH /missing-persons/admin/:id/reward (UpdateMissingPersonRewardDto).
  // See MissingPersonService.buildRewardProposalUpdate() for how
  // rewardAmount/rewardDetails are gated behind rewardOffered.
  // ─────────────────────────────────────────
  @ApiPropertyOptional({
    description:
      'Whether the submitter is offering a reward for information — "I will pay this amount if the missing person is found."',
  })
  @IsOptional()
  @IsBoolean()
  rewardOffered?: boolean;

  @ApiPropertyOptional({
    description:
      'Reward amount to pay if the missing person is found (platform base currency unit). Required when rewardOffered is true.',
    example: 20000,
  })
  @ValidateIf((o: CreateMissingPersonDto) => o.rewardOffered === true)
  @IsInt()
  @Min(1)
  rewardAmount?: number;

  @ApiPropertyOptional({
    description:
      'Free-text reward details (e.g. conditions, how to claim). Only meaningful when rewardOffered is true; ignored otherwise.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rewardDetails?: string;

  // ─────────────────────────────────────────
  // RE-AUTHENTICATION
  //
  // Verified and stripped by ReauthGuard before this DTO's data
  // reaches MissingPersonService.create() — never persisted or
  // returned. Optional here since it can instead be supplied via
  // the X-Reauth-Credential header; the guard accepts either.
  // Mirrors CreateReportDto's credential field.
  // ─────────────────────────────────────────
  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;

  // NOTE (item #5, idempotency): deliberately NOT a DTO field. Same
  // convention as CreateReportDto/CreatePostDto — the client sends
  // an Idempotency-Key header instead, read by
  // MissingPersonController.create() via
  // @Headers('idempotency-key') and passed through to
  // MissingPersonService.create(). Keeping it out of the body means
  // it can never accidentally get persisted or echoed back on the
  // record itself.
}

// ─────────────────────────────────────────────
// UPDATE MISSING PERSON DTO
// ─────────────────────────────────────────────

export class UpdateMissingPersonDto {
  @ApiPropertyOptional({ enum: MissingPersonType })
  @IsOptional()
  @IsEnum(MissingPersonType)
  personType?: MissingPersonType;

  @ApiPropertyOptional({ example: 'Metania Shiferaw' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'Updated description with more detail.' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ example: '2026-09-10T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  dateLastSeen?: string;

  @ApiPropertyOptional({ example: 'Bole, Addis Ababa' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  lastKnownArea?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];

  // ─────────────────────────────────────────
  // REWARD PROPOSAL (edit)
  //
  // Same rule as CreateMissingPersonDto: rewardAmount is required
  // the instant this request sets rewardOffered to true (via
  // @ValidateIf below) — so flipping the flag on always comes with
  // a concrete number in the same request, even if the case already
  // had reward fields from an earlier submission. rewardApproved is
  // still absent here — see the NOTE in CreateMissingPersonDto. If
  // the case's reward was already approved and the submitter
  // changes any of these three fields, MissingPersonService.update()
  // resets rewardApproved back to false so a since-edited proposal
  // can't keep riding on a sign-off that was given for different
  // terms.
  // ─────────────────────────────────────────
  @ApiPropertyOptional({
    description:
      'Whether the submitter is offering a reward for information — "I will pay this amount if the missing person is found."',
  })
  @IsOptional()
  @IsBoolean()
  rewardOffered?: boolean;

  @ApiPropertyOptional({
    description:
      'Reward amount to pay if the missing person is found (platform base currency unit). Required when this request sets rewardOffered to true.',
    example: 20000,
  })
  @ValidateIf((o: UpdateMissingPersonDto) => o.rewardOffered === true)
  @IsInt()
  @Min(1)
  rewardAmount?: number;

  @ApiPropertyOptional({
    description:
      'Free-text reward details (e.g. conditions, how to claim). Only meaningful when rewardOffered is true; ignored otherwise.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rewardDetails?: string;

  // Mirrors CreateMissingPersonDto's credential field — update()
  // is also gated behind ReauthGuard per the controller's TODO.
  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;
}

// ─────────────────────────────────────────────
// ADMIN — UPDATE STATUS DTO
// reviewNote is required by the service layer when status is
// REJECTED or MORE_INFORMATION_REQUESTED (validated in the
// service, not here, since the requirement is conditional on
// the value of `status`).
// ─────────────────────────────────────────────

export class UpdateMissingPersonStatusDto {
  @ApiProperty({ enum: MissingPersonStatus })
  @IsEnum(MissingPersonStatus)
  status: MissingPersonStatus;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;

  // NEW (item #16, child-safety dual control): must be explicitly
  // true when moving a personType=CHILD case to APPROVED. The
  // service records the first admin's confirmation and requires a
  // second, distinct admin to confirm again before the transition
  // actually goes through — mirrors ApprovePostDto.childSafetyConfirmed.
  // Ignored for non-CHILD cases.
  @ApiPropertyOptional({
    description:
      'Required (true) when approving a case where personType is CHILD. Ignored otherwise.',
  })
  @IsOptional()
  @IsBoolean()
  childSafetyConfirmed?: boolean;
}

// ─────────────────────────────────────────────
// ADMIN — UPDATE REWARD DTO
//
// Separate from UpdateMissingPersonStatusDto on purpose: approving
// a case (status = APPROVED) and approving its reward are two
// distinct decisions that shouldn't be forced into the same
// request — an admin may want to approve the case for public
// listing before a reward has even been proposed, or may need to
// revisit the reward later without touching status at all.
//
// rewardOffered is NOT here — only the submitter can propose that a
// reward exists at all (via CreateMissingPersonDto/
// UpdateMissingPersonDto). This DTO only lets an admin approve or
// reject the submitter's existing proposal, and optionally adjust
// the figure/details as part of that decision — it can't invent a
// reward the submitter never offered. The service rejects
// rewardApproved: true when the case's rewardOffered is false.
//
// rewardAmount/rewardDetails here are OPTIONAL overrides: if
// omitted, the service keeps whatever the submitter last proposed.
// If provided, they replace the stored value regardless of
// rewardApproved (e.g. an admin can correct a submitter's typo
// while rejecting, so the next review starts from a clean value).
// A final rewardAmount is required (via override or existing value)
// whenever rewardApproved is true.
//
// Approving does NOT clear rewardAmount/rewardDetails from the row
// on later rejection — the public-facing read paths mask
// rewardAmount/rewardDetails whenever rewardApproved is false, so
// there's no separate need to null the underlying data.
//
// This DTO only reaches the service through an ADMIN/SUPER_ADMIN
// -gated endpoint (PATCH /missing-persons/admin/:id/reward), never
// through the submitter-facing create/update routes.
// ─────────────────────────────────────────────

export class UpdateMissingPersonRewardDto {
  @ApiProperty({
    description:
      "Whether the case's proposed reward is approved for public display. Requires the case to have rewardOffered = true and a final reward amount (existing or provided here).",
  })
  @IsBoolean()
  rewardApproved: boolean;

  @ApiPropertyOptional({
    description:
      "Override the reward amount (platform base currency unit). Omit to keep the submitter's proposed amount.",
    example: 50000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  rewardAmount?: number;

  @ApiPropertyOptional({
    description: "Override the reward details text. Omit to keep the submitter's proposed details.",
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rewardDetails?: string;
}

// ─────────────────────────────────────────────
// LIST QUERY DTOs (pagination)
// ─────────────────────────────────────────────

export class ListMissingPersonsQueryDto {
  @ApiPropertyOptional({ enum: MissingPersonType })
  @IsOptional()
  @IsEnum(MissingPersonType)
  type?: MissingPersonType;

  @ApiPropertyOptional({ default: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class ListMissingPersonsAdminQueryDto {
  @ApiPropertyOptional({ enum: MissingPersonStatus })
  @IsOptional()
  @IsEnum(MissingPersonStatus)
  status?: MissingPersonStatus;

  @ApiPropertyOptional({ default: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
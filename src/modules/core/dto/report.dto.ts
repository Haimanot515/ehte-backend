import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

import { ReportStatus, ReportCategory } from '@prisma/client';

// ─────────────────────────────────────────────
// REPORTER-FACING
// ─────────────────────────────────────────────

export class CreateReportDto {
  @ApiProperty({
    enum: ReportCategory,
    example: ReportCategory.HARASSMENT,
    description: 'Category of the incident',
  })
  @IsEnum(ReportCategory)
  category: ReportCategory;

  @ApiProperty({
    example: 'The incident happened at approximately 8 PM...',
    description: 'Detailed description of the incident',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(10000)
  description: string;

  @ApiPropertyOptional({
    example: 'Addis Ababa',
    description: 'Location of the incident',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @ApiPropertyOptional({
    example: '2026-08-28T20:00:00.000Z',
    description: 'Date and time when the incident occurred',
  })
  @IsOptional()
  @IsDateString()
  incidentAt?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['reports/photo-123.jpg'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['reports/video-123.mp4'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['reports/audio-123.mp3'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['reports/document-123.pdf'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];
}

export class UpdateReportDto {
  @ApiPropertyOptional({
    enum: ReportCategory,
    example: ReportCategory.HARASSMENT,
  })
  @IsOptional()
  @IsEnum(ReportCategory)
  category?: ReportCategory;

  @ApiPropertyOptional({
    example: 'Updated description of the incident...',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(10000)
  description?: string;

  @ApiPropertyOptional({
    example: 'Addis Ababa',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @ApiPropertyOptional({
    example: '2026-08-28T20:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  incidentAt?: string;

  @ApiPropertyOptional({
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];
}

// ─────────────────────────────────────────────
// ADMIN-FACING
// ─────────────────────────────────────────────

export class AdminReportQueryDto {
  @ApiPropertyOptional({ enum: ReportStatus })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @ApiPropertyOptional({ enum: ReportCategory })
  @IsOptional()
  @IsEnum(ReportCategory)
  category?: ReportCategory;

  @ApiPropertyOptional({ description: 'Filter by assigned admin userId' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({
    enum: ['assigned', 'unassigned'],
    description:
      'Filter by whether a report has any admin assigned, regardless of who. Ignored if assignedTo is also provided (assignedTo is more specific).',
  })
  @IsOptional()
  @IsIn(['assigned', 'unassigned'])
  assignmentStatus?: 'assigned' | 'unassigned';

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class UpdateReportStatusDto {
  @ApiProperty({ enum: ReportStatus, description: 'New status for the report' })
  @IsEnum(ReportStatus)
  status: ReportStatus;

  @ApiPropertyOptional({ description: 'Optional internal note explaining the status change' })
  @IsOptional()
  @IsString()
  note?: string;
}

export class RequestMoreInformationDto {
  @ApiProperty({
    example: 'Could you clarify the exact time and location of the incident?',
    description: 'Message sent to the reporter requesting more detail',
  })
  @IsString()
  message: string;
}

export class RespondToInformationRequestDto {
  @ApiProperty({
    example: 'The incident took place near the west entrance around 6:30pm.',
    description: "The reporter's response to the admin's information request",
  })
  @IsString()
  responseMessage: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Optional supporting files (URLs) attached to the response',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  responseFiles?: string[];
}

export class AssignReportDto {
  @ApiProperty({ description: 'Id of the admin the report is being assigned to' })
  @IsUUID()
  assignedToUserId: string;

  @ApiPropertyOptional({ description: 'Optional internal note about the assignment' })
  @IsOptional()
  @IsString()
  note?: string;
}

export class EscalateReportDto {
  @ApiProperty({
    example: 'Immediate safety risk to the reporter',
    description: 'Reason the report is being escalated',
  })
  @IsString()
  reason: string;
}
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  MinLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { ReportStatus, ReportCategory } from '@prisma/client';

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

  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;
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

export class PageQueryDto {
  @ApiPropertyOptional({ description: 'Page' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Limit' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ReportStatsQueryDto {
  @ApiPropertyOptional({ description: 'From' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'To' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: ReportStatus, description: 'Status' })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @ApiPropertyOptional({ enum: ReportCategory, description: 'Category' })
  @IsOptional()
  @IsEnum(ReportCategory)
  category?: ReportCategory;

  @ApiPropertyOptional({ description: 'Channel' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  channel?: string;

  @ApiPropertyOptional({ description: 'Assigned to' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({ description: 'Region' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;
}

export class StatsTimelineQueryDto extends ReportStatsQueryDto {
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'], description: 'Bucket' })
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  bucket?: 'day' | 'week' | 'month';
}

export class ReportListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Sort by' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], description: 'Order' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

export class ReportCountsQueryDto {
  @ApiPropertyOptional({ enum: ReportStatus, description: 'Status' })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @ApiPropertyOptional({ enum: ReportCategory, description: 'Category' })
  @IsOptional()
  @IsEnum(ReportCategory)
  category?: ReportCategory;

  @ApiPropertyOptional({ description: 'Assigned to' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;
}

export class UnreadReportsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ReportStatus, description: 'Status' })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @ApiPropertyOptional({ enum: ReportCategory, description: 'Category' })
  @IsOptional()
  @IsEnum(ReportCategory)
  category?: ReportCategory;
}

export class ByUserQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['totalReports', 'unread', 'lastReportAt'], description: 'Sort by' })
  @IsOptional()
  @IsIn(['totalReports', 'unread', 'lastReportAt'])
  sortBy?: 'totalReports' | 'unread' | 'lastReportAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], description: 'Order' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

export class UserReportsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ReportStatus, description: 'Status' })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @ApiPropertyOptional({ enum: ReportCategory, description: 'Category' })
  @IsOptional()
  @IsEnum(ReportCategory)
  category?: ReportCategory;

  @ApiPropertyOptional({ description: 'Is read' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  isRead?: boolean;
}

export class RepeatReportersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Min reports' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(100)
  minReports?: number;
}

export class SlaBreachingQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Within hours' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  withinHours?: number;
}

export class FollowUpsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Due before' })
  @IsOptional()
  @IsDateString()
  dueBefore?: string;
}

export class PendingInformationRequestsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Overdue only' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  overdueOnly?: boolean;
}

export class SearchReportsQueryDto extends PageQueryDto {
  @ApiProperty({ description: 'Q' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q: string;

  @ApiPropertyOptional({ enum: ReportStatus, description: 'Status' })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @ApiPropertyOptional({ enum: ReportCategory, description: 'Category' })
  @IsOptional()
  @IsEnum(ReportCategory)
  category?: ReportCategory;

  @ApiPropertyOptional({ description: 'Assigned to' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;
}

export class ExportReportsQueryDto extends ReportStatsQueryDto {}

export class ReportMapQueryDto extends ReportStatsQueryDto {
  @ApiPropertyOptional({ description: 'Bbox' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bbox?: string;

  @ApiPropertyOptional({ description: 'Zoom' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(22)
  zoom?: number;
}

export class NearbyReportsQueryDto extends PageQueryDto {
  @ApiProperty({ description: 'Lat' })
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @ApiProperty({ description: 'Lng' })
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;

  @ApiPropertyOptional({ description: 'Radius km' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(500)
  radiusKm?: number;

  @ApiPropertyOptional({ enum: ReportStatus, description: 'Status' })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @ApiPropertyOptional({ enum: ReportCategory, description: 'Category' })
  @IsOptional()
  @IsEnum(ReportCategory)
  category?: ReportCategory;
}

export class HotspotsQueryDto extends ReportStatsQueryDto {
  @ApiPropertyOptional({ description: 'Grid km' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(50)
  gridKm?: number;
}

export class AccessLogQueryDto extends PageQueryDto {}

export class EvidenceRemovalQueryDto {
  @ApiProperty({ description: 'Reason' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

export class SoftDeleteReportQueryDto {
  @ApiProperty({ description: 'Reason' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

export class QueueNextQueryDto {
  @ApiPropertyOptional({ description: 'Team id' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  teamId?: string;
}

export class ReportLocationDto {
  @ApiProperty({ description: 'Latitude' })
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude: number;

  @ApiProperty({ description: 'Longitude' })
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude: number;

  @ApiPropertyOptional({ description: 'Accuracy meters' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100000)
  accuracyMeters?: number;

  @ApiPropertyOptional({ description: 'Captured at' })
  @IsOptional()
  @IsDateString()
  capturedAt?: string;

  @ApiPropertyOptional({ description: 'Address' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;
}

export class AddReportEvidenceDto {
  @ApiPropertyOptional({ description: 'Note' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CreateReportMessageDto {
  @ApiProperty({ description: 'Message' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;
}

export class RequestReopenDto {
  @ApiProperty({ description: 'Reason' })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason: string;
}

export class ReportFeedbackDto {
  @ApiProperty({ description: 'Rating' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({ description: 'Comment' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

export class AttachReportLocationDto {
  @ApiProperty({ type: ReportLocationDto, description: 'Gps' })
  @ValidateNested()
  @Type(() => ReportLocationDto)
  gps: ReportLocationDto;
}

export class SyncReportItemDto {
  @ApiProperty({ description: 'Client id' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  clientId: string;

  @ApiProperty({ description: 'Created at' })
  @IsDateString()
  createdAt: string;

  @ApiProperty({ type: Object, description: 'Data' })
  @IsObject()
  data: Record<string, unknown>;
}

export class SyncReportsDto {
  @ApiProperty({ type: [SyncReportItemDto], description: 'Items' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SyncReportItemDto)
  items: SyncReportItemDto[];
}

export class ReportDeleteRequestDto {
  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class MuteReportDto {
  @ApiProperty({ description: 'Muted' })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  muted: boolean;

  @ApiPropertyOptional({ description: 'Until' })
  @IsOptional()
  @IsDateString()
  until?: string;
}

export class UrgentReportDto {
  @ApiPropertyOptional({ description: 'Details' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  details?: string;

  @ApiPropertyOptional({ type: ReportLocationDto, description: 'Gps' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportLocationDto)
  gps?: ReportLocationDto;
}

export class ContactPreferenceDto {
  @ApiProperty({ enum: ['IN_APP', 'EMAIL', 'PHONE', 'SMS', 'NONE'], description: 'Method' })
  @IsIn(['IN_APP', 'EMAIL', 'PHONE', 'SMS', 'NONE'])
  method: 'IN_APP' | 'EMAIL' | 'PHONE' | 'SMS' | 'NONE';

  @ApiPropertyOptional({ description: 'Window' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  window?: string;
}

export class ChangeAnonymityDto {
  @ApiProperty({ description: 'Anonymous' })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  anonymous: boolean;

  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class BulkReportIdsDto {
  @ApiProperty({ type: [String], description: 'Ids' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids: string[];
}

export class ReadAllReportsDto {
  @ApiPropertyOptional({ enum: ReportStatus, description: 'Status' })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @ApiPropertyOptional({ enum: ReportCategory, description: 'Category' })
  @IsOptional()
  @IsEnum(ReportCategory)
  category?: ReportCategory;

  @ApiPropertyOptional({ description: 'Assigned to' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;
}

export class UpdateReportCategoryDto {
  @ApiProperty({ enum: ReportCategory, description: 'Category' })
  @IsEnum(ReportCategory)
  category: ReportCategory;

  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UpdateReportPriorityDto {
  @ApiProperty({ enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], description: 'Priority' })
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ResolveReportDto {
  @ApiProperty({ enum: ['RESOLVED', 'NO_ACTION', 'REFERRED', 'UNFOUNDED'], description: 'Outcome' })
  @IsIn(['RESOLVED', 'NO_ACTION', 'REFERRED', 'UNFOUNDED'])
  outcome: 'RESOLVED' | 'NO_ACTION' | 'REFERRED' | 'UNFOUNDED';

  @ApiProperty({ description: 'Summary' })
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  summary: string;
}

export class BulkAssignReportsDto {
  @ApiProperty({ type: [String], description: 'Ids' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids: string[];

  @ApiProperty({ description: 'Admin id' })
  @IsUUID()
  adminId: string;
}

export class BulkUpdateReportStatusDto {
  @ApiProperty({ type: [String], description: 'Ids' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids: string[];

  @ApiProperty({ enum: ReportStatus, description: 'Status' })
  @IsEnum(ReportStatus)
  status: ReportStatus;

  @ApiPropertyOptional({ description: 'Note' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class BulkUnassignReportsDto {
  @ApiProperty({ type: [String], description: 'Ids' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids: string[];
}

export class MergeReportDto {
  @ApiProperty({ description: 'Target report id' })
  @IsUUID()
  targetReportId: string;

  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AssignTeamDto {
  @ApiProperty({ description: 'Team id' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  teamId: string;
}

export class DeEscalateReportDto {
  @ApiProperty({ description: 'Reason' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

export class MarkSpamDto {
  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class MarkFalseReportDto {
  @ApiProperty({ description: 'Reason' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({ description: 'Malicious' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  malicious?: boolean;
}

export class UnmarkReportDto {
  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class LinkReportRecordDto {
  @ApiProperty({
    enum: ['REPORT', 'MISSING_PERSON', 'VICTIM_PROFILE', 'INFORMATION_SUBMISSION', 'POST'],
    description: 'Record type',
  })
  @IsIn(['REPORT', 'MISSING_PERSON', 'VICTIM_PROFILE', 'INFORMATION_SUBMISSION', 'POST'])
  recordType: 'REPORT' | 'MISSING_PERSON' | 'VICTIM_PROFILE' | 'INFORMATION_SUBMISSION' | 'POST';

  @ApiProperty({ description: 'Record id' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  recordId: string;

  @ApiPropertyOptional({ description: 'Note' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UnmergeReportDto {
  @ApiPropertyOptional({ description: 'Merge id' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  mergeId?: string;

  @ApiProperty({ description: 'Reason' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

export class SplitReportDto {
  @ApiProperty({ description: 'Description' })
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  description: string;

  @ApiPropertyOptional({ type: [String], description: 'Evidence ids' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  evidenceIds?: string[];

  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ArchiveReportDto {
  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class SetDueDateDto {
  @ApiProperty({ description: 'Due at' })
  @IsDateString()
  dueAt: string;

  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CreateFollowUpDto {
  @ApiProperty({ description: 'Remind at' })
  @IsDateString()
  remindAt: string;

  @ApiPropertyOptional({ description: 'Note' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AddReportTagsDto {
  @ApiProperty({ type: [String], description: 'Tags' })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  tags: string[];
}

export class BulkTagReportsDto {
  @ApiProperty({ type: [String], description: 'Ids' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids: string[];

  @ApiPropertyOptional({ type: [String], description: 'Add tags' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  addTags?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Remove tags' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  removeTags?: string[];
}

export class SaveReportViewDto {
  @ApiProperty({ description: 'Name' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @ApiProperty({ type: Object, description: 'Filters' })
  @IsObject()
  filters: Record<string, unknown>;
}

export class UpdateReportViewDto {
  @ApiPropertyOptional({ description: 'Name' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ type: Object, description: 'Filters' })
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;
}

export class RedactEvidenceDto {
  @ApiProperty({ description: 'Reason' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({ type: Object, description: 'Regions' })
  @IsOptional()
  @IsObject()
  regions?: Record<string, unknown>;
}

export class CancelInformationRequestDto {
  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ExtendInformationRequestDto {
  @ApiProperty({ description: 'Due at' })
  @IsDateString()
  dueAt: string;

  @ApiPropertyOptional({ description: 'Reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReviewInformationResponseDto {
  @ApiProperty({ enum: ['ACCEPT', 'ASK_AGAIN'], description: 'Decision' })
  @IsIn(['ACCEPT', 'ASK_AGAIN'])
  decision: 'ACCEPT' | 'ASK_AGAIN';

  @ApiPropertyOptional({ description: 'Note' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class UpdateReportSensitivityDto {
  @ApiProperty({ enum: ['STANDARD', 'RESTRICTED', 'CHILD_INVOLVED'], description: 'Level' })
  @IsIn(['STANDARD', 'RESTRICTED', 'CHILD_INVOLVED'])
  level: 'STANDARD' | 'RESTRICTED' | 'CHILD_INVOLVED';

  @ApiProperty({ description: 'Reason' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

export class GrantReportAccessDto {
  @ApiProperty({ description: 'Admin id' })
  @IsUUID()
  adminId: string;

  @ApiProperty({ description: 'Reason' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({ description: 'Expires at' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class RevealReporterDto {
  @ApiProperty({ description: 'Reason' })
  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  reason: string;

  @ApiPropertyOptional({ description: 'Ticket ref' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ticketRef?: string;
}

export class LegalHoldDto {
  @ApiProperty({ description: 'Enabled' })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({ description: 'Reason' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

export class UpdateReportLocationDto {
  @ApiPropertyOptional({ type: ReportLocationDto, description: 'Gps' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportLocationDto)
  gps?: ReportLocationDto;

  @ApiPropertyOptional({ description: 'Verified' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  verified?: boolean;

  @ApiPropertyOptional({ description: 'Note' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReplyToReportEmailDto {
  @ApiPropertyOptional({ description: 'Subject' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @ApiProperty({ description: 'Body' })
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body: string;
}

export class StartExportJobDto extends ReportStatsQueryDto {
  @ApiPropertyOptional({ enum: ['csv', 'xlsx'], description: 'Format' })
  @IsOptional()
  @IsIn(['csv', 'xlsx'])
  format?: 'csv' | 'xlsx';
}

// Drafts accept the same fields as a new report, all optional.
export class SaveReportDraftDto extends PartialType(CreateReportDto) {}

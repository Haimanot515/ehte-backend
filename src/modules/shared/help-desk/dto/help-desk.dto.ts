import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { HelpTicketPriority, HelpTicketStatus } from '@prisma/client';
import { SharedRecordEntity } from 'src/common/enums/shared/shared-record-entity.enum';
import { PagedQueryDto } from '../../common/paged-query.dto';

// Replace with your real ticket categories if they differ
export const HELP_CATEGORIES = [
  'ACCOUNT',
  'REPORT',
  'MISSING_PERSON',
  'VICTIM_PROFILE',
  'SUPPORT_PAYMENT',
  'TECHNICAL',
  'OTHER',
];

export const MAX_TICKET_ATTACHMENTS = 5;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

export class CreateTicketDto {
  @IsIn(HELP_CATEGORIES)
  category: string;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(150)
  subject: string;

  // The first message of the ticket
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;

  // Both linked fields go together or not at all
  @IsOptional()
  @IsEnum(SharedRecordEntity)
  linkedEntity?: SharedRecordEntity;

  @IsOptional()
  @IsUUID()
  linkedEntityId?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_TICKET_ATTACHMENTS)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  attachmentKeys?: string[];
}

export class MyTicketsQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsEnum(HelpTicketStatus)
  status?: HelpTicketStatus;
}

export class AddTicketMessageDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_TICKET_ATTACHMENTS)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  attachmentKeys?: string[];
}

export class RateTicketDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  score: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  comment?: string;
}

export class AdminTicketsQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsEnum(HelpTicketStatus)
  status?: HelpTicketStatus;

  @IsOptional()
  @IsIn(HELP_CATEGORIES)
  category?: string;

  @IsOptional()
  @IsEnum(HelpTicketPriority)
  priority?: HelpTicketPriority;

  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  unassigned?: boolean;

  // Only tickets opened more than this many hours ago
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8760)
  olderThanHours?: number;

  // Matches the reference or the subject
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q?: string;
}

export class UpdateTicketDto {
  @IsOptional()
  @IsEnum(HelpTicketStatus)
  status?: HelpTicketStatus;

  @IsOptional()
  @IsIn(HELP_CATEGORIES)
  category?: string;

  @IsOptional()
  @IsEnum(HelpTicketPriority)
  priority?: HelpTicketPriority;
}

export class StaffReplyDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_TICKET_ATTACHMENTS)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  attachmentKeys?: string[];

  // Marks the ticket RESOLVED with this reply. Otherwise it waits on the user.
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  resolve?: boolean;
}

export class AssignTicketDto {
  // Send null to remove the current assignee
  @ValidateIf((o: AssignTicketDto) => o.assigneeId !== null)
  @IsUUID()
  assigneeId: string | null;
}

export class CannedRepliesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q?: string;
}

export class HelpStatsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

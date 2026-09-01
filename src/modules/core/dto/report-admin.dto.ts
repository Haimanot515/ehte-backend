import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';

import { ReportStatus } from '@prisma/client';

export class AdminReportQueryDto {
  @ApiPropertyOptional({ enum: ReportStatus })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  // ─────────────────────────────────────────────
  // TODO: Report has no assignedToId column in the
  // current schema (see ReportService.assign()).
  // This filter is documented/accepted but not yet
  // wired up in findAllForAdmin() until that column
  // is added.
  // ─────────────────────────────────────────────
  @ApiPropertyOptional({
    description:
      'Not yet implemented — Report has no assignedToId column yet',
  })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}

export class UpdateReportStatusDto {
  @ApiProperty({
    enum: ReportStatus,
    description: 'New status for the report',
  })
  @IsEnum(ReportStatus)
  status: ReportStatus;

  @ApiPropertyOptional({
    description: 'Optional internal note explaining the status change',
  })
  @IsOptional()
  @IsString()
  note?: string;
}

export class RequestMoreInformationDto {
  @ApiProperty({
    example:
      'Could you clarify the exact time and location of the incident?',
    description: 'Message sent to the reporter requesting more detail',
  })
  @IsString()
  message: string;
}

export class AssignReportDto {
  @ApiProperty({
    description: 'Id of the admin the report is being assigned to',
  })
  @IsUUID()
  assignedToUserId: string;

  @ApiPropertyOptional({
    description: 'Optional internal note about the assignment',
  })
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

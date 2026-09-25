// src/modules/billing/dto/funding.dto.ts
//
// DTOs for FundingQueryService's read-only endpoints (section 3 of the
// billing review: public/donor/case-owner/finder funding views, plus the
// admin per-profile / per-case funding breakdowns).
//
// Pagination follows AuditPagingDto's offset convention (misc/dto/audit-log.dto.ts):
// page + limit, capped, defaulted. No cursor mode here — these lists are
// small enough (one payer's history, one profile's payments) that offset
// paging is sufficient and simpler for the frontend to build page controls with.

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class FundingPagingDto {
  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
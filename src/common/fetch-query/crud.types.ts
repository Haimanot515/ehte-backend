
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum FilterOperator {
  EQ = 'eq',
  NE = 'ne',
  GT = 'gt',
  GTE = 'gte',
  LT = 'lt',
  LTE = 'lte',
  LIKE = 'like',
  IN = 'in',
  BETWEEN = 'between',
  ISNULL = 'isnull',
  NOTNULL = 'notnull',
}

export class Where {
  @ApiProperty()
  @IsString()
  column!: string;

  @ApiProperty()
  value: any;

  @ApiPropertyOptional({
    enum: FilterOperator,
  })
  @IsOptional()
  @IsEnum(FilterOperator)
  operator!: FilterOperator;
}

export class Order {
  @ApiProperty()
  @IsString()
  column!: string;

  @ApiPropertyOptional({
    enum: ['ASC', 'DESC'],
  })
  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  direction?: 'ASC' | 'DESC';
}

export class FetchQuery {
  @ApiPropertyOptional({
    type: [String],
    default: [],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  select: string[] = [];

  @ApiPropertyOptional({
    description: 'Filter conditions',
    default: [],
  })
  @IsOptional()
  where: Where[][] = [];

  @ApiPropertyOptional({
    type: [Order],
    default: [],
  })
  @IsOptional()
  @IsArray()
  orderBy: Order[] = [];

  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    default: 1,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({
    description: 'Items per page',
    default: 10,
    maximum: 100,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 10;
}

export class PaginatedResult<T> {
  @ApiProperty()
  total!: number;

  @ApiProperty({
    isArray: true,
  })
  items!: T[];
}


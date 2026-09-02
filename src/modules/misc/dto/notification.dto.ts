import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  ArrayNotEmpty,
  Min,
} from 'class-validator';

import { Type } from 'class-transformer';

import { NotificationType } from '@prisma/client';

export class CreateNotificationDto {
  @ApiPropertyOptional({
    example: 'uuid',
    description: 'User ID. Leave empty for a broadcast notification.',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiProperty({
    enum: NotificationType,
    example: NotificationType.GENERAL,
  })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiProperty({
    example: 'Report Received',
  })
  @IsString()
  title: string;

  @ApiProperty({
    example: 'Your report has been received successfully.',
  })
  @IsString()
  body: string;
}

export class MarkBulkReadDto {
  @ApiProperty({
    type: [String],
    example: ['notification-id-1', 'notification-id-2'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', {
    each: true,
  })
  ids: string[];
}

export class NotificationQueryDto {
  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isRead?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

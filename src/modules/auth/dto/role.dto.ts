import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({
    example: 'reports_reviewer',
    description: 'Unique role name (used in @Roles() checks — keep it a stable slug)',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name: string;
}

export class UpdateRoleDto {
  @ApiPropertyOptional({
    example: 'reports_reviewer',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name?: string;
}
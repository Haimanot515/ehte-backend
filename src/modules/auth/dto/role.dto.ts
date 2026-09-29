import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// RECONSTRUCTED — original file wasn't shared; merge with your real fields.
export class CreateRoleDto {
  @ApiProperty({ example: 'CONTENT_MODERATOR', description: 'Unique role name' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[A-Z][A-Z0-9_]*$/, {
    message: 'name must be UPPER_SNAKE_CASE (A-Z, 0-9, underscore; starts with a letter)',
  })
  name: string;

  @ApiPropertyOptional({
    example: 'Reviews and moderates user-submitted posts.',
    description: 'What this role is for — shown in the admin UI.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateRoleDto extends PartialType(CreateRoleDto) {}

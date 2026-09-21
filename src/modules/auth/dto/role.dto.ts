import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// RECONSTRUCTED — original file wasn't shared; merge with your real fields.
export class CreateRoleDto {
  @ApiProperty({ example: 'CONTENT_MODERATOR', description: 'Unique role name' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
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
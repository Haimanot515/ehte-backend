import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { RolesEnum } from 'src/common/enums/roles.enum';

export class UpdateUserDto {
  @ApiPropertyOptional({
    example: 'Haimanot',
    description: 'Updated display name',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;
}

export class UpdateDiscreetModeDto {
  @ApiProperty({
    example: true,
    description: 'Enable or disable Discreet Mode',
  })
  @IsBoolean()
  enabled: boolean;
}

// ─────────────────────────────────────────────
// ADMIN — ASSIGN ROLE
// PRD 23/24: Admin Portal > Users / Roles and Permissions
//
// Kept as a fixed enum of role names (RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
// rather than accepting an arbitrary role id, matching RolesEnum
// (src/common/enums/roles.enum.ts) and the names seeded by
// RolesSeeder. If your Role table grows beyond these two admin-side
// names, swap this for a roleId lookup instead.
// ─────────────────────────────────────────────

export class AssignUserRoleDto {
  @ApiProperty({
    example: RolesEnum.ADMIN,
    description: 'Role to grant the user',
    enum: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN],
  })
  @IsString()
  @IsIn([RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN])
  role: RolesEnum.ADMIN | RolesEnum.SUPER_ADMIN;
}

// ─────────────────────────────────────────────
// ADMIN — LIST USERS (query)
// GET /users
// PRD 23: Admin Portal > Users
// ─────────────────────────────────────────────

export class ListUsersQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;

  @ApiPropertyOptional({
    example: 'haim',
    description: 'Matches against name or phone',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter to users holding this role id',
  })
  @IsOptional()
  @IsUUID('4')
  roleId?: string;

  @ApiPropertyOptional({ description: 'Filter by active status' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Filter by Discreet Mode status' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  discreetModeEnabled?: boolean;
}
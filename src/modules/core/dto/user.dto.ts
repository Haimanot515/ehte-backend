import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
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

// ─────────────────────────────────────────────
// DISCREET MODE
// PATCH /users/me/discreet-mode
//
// This endpoint only configures Discreet Mode — it does not
// perform sensitive-action re-authentication. That is a separate
// concern, handled by a re-auth guard/flow elsewhere: Discreet
// Mode OFF checks the normal password; Discreet Mode ON accepts
// either the password or the Discreet Mode passcode.
//
// passcode is required when enabled === true (covers both
// first-time setup and rotating an existing passcode). It is
// ignored when enabled === false.
//
// NOTE: the re-auth credential itself (body.password) is NOT a
// field on this DTO. ReauthGuard reads and deletes it from the raw
// request body before NestJS's ValidationPipe ever builds this
// DTO, so it never reaches the controller/service layer. See
// ReauthGuard + @RequireReauthentication() on
// UserController.updateDiscreetMode().
// ─────────────────────────────────────────────
export class UpdateDiscreetModeDto {
  @ApiProperty({
    example: true,
    description: 'Enable or disable Discreet Mode',
  })
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({
    example: '482913',
    description: 'Discreet Mode passcode. Required when enabling Discreet Mode.',
  })
  @ValidateIf((o) => o.enabled === true)
  @IsString()
  @MinLength(4)
  @MaxLength(12)
  passcode?: string;
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

  // FIX: added to support filtering admin registrations by completion
  // status — e.g. "show me every registration still stuck in REGISTERING
  // state" (no password set, never activated) versus completed accounts.
  // Maps to `passwordHash IS NULL` / `IS NOT NULL` in UserService.listUsers()
  // rather than a stored enum column, since "pending" isn't a persisted
  // state of its own — it's derived from passwordHash being unset.
  @ApiPropertyOptional({
    description:
      'Filter admin registrations by completion status — "pending" is a registration ' +
      'still awaiting the invited admin to set their password; "completed" already has one.',
    enum: ['pending', 'completed'],
  })
  @IsOptional()
  @IsIn(['pending', 'completed'])
  registrationStatus?: 'pending' | 'completed';
}

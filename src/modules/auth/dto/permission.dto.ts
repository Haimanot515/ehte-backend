import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

export class AssignPermissionsDto {
  @ApiProperty({
    enum: PermissionsEnum,
    isArray: true,
    example: [PermissionsEnum.REPORT_READ, PermissionsEnum.REPORT_ASSIGN],
    description:
      'One or more permissions to grant to the role. Already-granted ' +
      'permissions in this list are silently ignored (idempotent).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(PermissionsEnum, { each: true })
  permissions: PermissionsEnum[];
}

// NEW: bulk revoke, kept separate from AssignPermissionsDto for clarity.
export class RevokePermissionsDto {
  @ApiProperty({
    enum: PermissionsEnum,
    isArray: true,
    example: [PermissionsEnum.REPORT_ASSIGN],
    description: 'One or more permissions to revoke from the role in a single call.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(PermissionsEnum, { each: true })
  permissions: PermissionsEnum[];
}

// NEW: set/replace the whole list; empty array is valid (strips all permissions).
export class SetPermissionsDto {
  @ApiProperty({
    enum: PermissionsEnum,
    isArray: true,
    example: [PermissionsEnum.REPORT_READ, PermissionsEnum.REPORT_ASSIGN],
    description:
      'The complete target permission list for this role. Permissions not ' +
      'in this list that the role currently has will be removed; permissions ' +
      'in this list that the role does not yet have will be added. Pass an ' +
      'empty array to strip the role of all permissions.',
  })
  @IsArray()
  @ArrayUnique()
  @IsEnum(PermissionsEnum, { each: true })
  permissions: PermissionsEnum[];
}

// New DTOs for the endpoints added to PermissionController (AR-52, AR-55).

// AR-52 — read-only dry run. Give role IDs, or a user ID to use their current roles.
export class SimulatePermissionDto {
  @ApiProperty({ enum: PermissionsEnum, description: 'The permission to test' })
  @IsEnum(PermissionsEnum)
  permission: PermissionsEnum;

  @ApiPropertyOptional({ type: [String], description: 'Roles to test as a set' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  roleIds?: string[];

  @ApiPropertyOptional({ description: "Test a user's current roles instead of roleIds" })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

// AR-55 — GET /permissions/users/:userId/diff?from=&to=
export class PermissionDiffQueryDto {
  @ApiProperty({ description: 'Start of the period, ISO date' })
  @IsDateString()
  from: string;

  @ApiPropertyOptional({ description: 'End of the period, ISO date. Defaults to now.' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

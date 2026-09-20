import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsEnum } from 'class-validator';
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
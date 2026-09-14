import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsEnum } from 'class-validator';
// NOTE: adjust this import path to match your actual file location.
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

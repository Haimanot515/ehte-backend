import { SetMetadata } from '@nestjs/common';

import { PermissionsEnum } from '../enums/permissions.enum';

export const PERMISSIONS_KEY = 'permissions';

// Typed against PermissionsEnum (not `string`) so a typo'd or renamed
// permission name fails at compile time, not silently at runtime as a
// 403 nobody can explain. Every call site should pass PermissionsEnum
// members, e.g. @RequirePermissions(PermissionsEnum.REPORT_READ).
export const RequirePermissions = (...permissions: PermissionsEnum[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
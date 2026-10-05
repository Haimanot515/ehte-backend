import { SetMetadata } from '@nestjs/common';

import { PermissionsEnum } from '../enums/permissions.enum';

export const PERMISSIONS_KEY = 'permissions';

export const RequirePermissions = (...permissions: PermissionsEnum[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

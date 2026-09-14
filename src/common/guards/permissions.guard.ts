import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { Reflector } from '@nestjs/core';

import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No permissions required
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    const user = request.user as
      | {
          permissions?: string[];
        }
      | undefined;

    if (!user?.permissions?.length) {
      throw new ForbiddenException('Missing permissions');
    }

    const normalize = (permission: string) => permission.trim().toUpperCase();

    const userPermissions = new Set(user.permissions.map(normalize));

    // Every required permission must be present — unlike RolesGuard's
    // "any one role matches" semantics, permissions are additive checks
    // per endpoint (e.g. an endpoint needing both 'user:create' AND
    // 'user:assign-role' shouldn't pass with just one of them).
    const hasAllPermissions = requiredPermissions.every((permission) =>
      userPermissions.has(normalize(permission)),
    );

    if (!hasAllPermissions) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}

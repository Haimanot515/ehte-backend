import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { Reflector } from '@nestjs/core';

import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No roles required
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    const user = request.user as
      | {
          roles?: string[];
        }
      | undefined;

    if (!user?.roles?.length) {
      throw new ForbiddenException('Missing roles');
    }

    const normalize = (role: string) => role.trim().toUpperCase();

    const userRoles = new Set(user.roles.map(normalize));

    const hasRole = requiredRoles.some((role) => userRoles.has(normalize(role)));

    if (!hasRole) {
      throw new ForbiddenException('Insufficient role');
    }

    return true;
  }
}

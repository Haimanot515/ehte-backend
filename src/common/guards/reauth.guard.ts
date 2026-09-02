import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { Reflector } from '@nestjs/core';

import { ReauthService } from '../services/reauth.service';

import { REQUIRE_REAUTH_KEY } from '../decorators/reauth.decorator';

@Injectable()
export class ReauthGuard {
  constructor(
    private readonly reflector: Reflector,
    private readonly reauthService: ReauthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiresReauth = this.reflector.getAllAndOverride<boolean>(REQUIRE_REAUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Endpoint does not require re-authentication
    if (!requiresReauth) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    const user = request.user;

    // JwtAuthGuard should already have
    // authenticated the user.
    if (!user?.id) {
      throw new UnauthorizedException('authentication_required');
    }

    // GET requests carry the password via the
    // X-Reauth-Password header (no request body).
    // POST/PATCH requests carry it in body.password.
    const password = request.headers['x-reauth-password'] ?? request.body?.password;

    if (!password || typeof password !== 'string') {
      throw new UnauthorizedException('reauthentication_required');
    }

    const validPassword = await this.reauthService.verifyPassword(user.id, password);

    if (!validPassword) {
      throw new UnauthorizedException('wrong_password');
    }

    // Do not allow the password to reach
    // the controller/service.
    if (request.body && typeof request.body === 'object') {
      delete request.body.password;
    }

    return true;
  }
}

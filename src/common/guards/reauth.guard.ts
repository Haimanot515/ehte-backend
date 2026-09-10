import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { Reflector } from '@nestjs/core';

import { ReauthService } from '../../services/reauthentication/reauth.service';

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

    // FIX: renamed from "password" to "credential" — this can be
    // either the account password or (when Discreet Mode is on)
    // the Discreet Mode passcode; calling it "password" everywhere
    // was misleading given what it actually accepts.
    //
    // GET requests carry it via the X-Reauth-Credential header
    // (no request body). POST/PATCH requests carry it in
    // body.credential.
    //
    // Backward compatibility: the old X-Reauth-Password header and
    // body.password field are still accepted. Remove these two
    // fallbacks once every client has migrated to the new names.
    const credential =
      request.headers['x-reauth-credential'] ??
      request.headers['x-reauth-password'] ??
      request.body?.credential ??
      request.body?.password;

    if (!credential || typeof credential !== 'string') {
      throw new UnauthorizedException('reauthentication_required');
    }

    // FIX: call verifyCredential() directly instead of the
    // verifyPassword() alias, since this guard is the primary
    // caller ReauthService.verifyPassword()'s docstring names as
    // still needing migration.
    const validCredential = await this.reauthService.verifyCredential(user.id, credential);

    if (!validCredential) {
      throw new UnauthorizedException('invalid_credential');
    }

    // Do not allow the credential to reach the controller/service.
    // Strip both the new and legacy field names.
    if (request.body && typeof request.body === 'object') {
      delete request.body.credential;
      delete request.body.password;
    }

    return true;
  }
}

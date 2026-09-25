import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { PrismaService } from 'src/prisma/prisma.service';
import { CacheService } from 'src/services/redis/cache.service';

type AccessTokenPayload = {
  sub: string;
  phone: string;
  roles: string[];
  permissions: string[];
  sid?: string;
};

// What the guards need, loaded from Postgres and cached briefly in Redis.
// A dead session is cached too (as { alive: false }) so a revoked-but-validly-signed
// token can't be used to hammer the database.
export type SessionAuth = { alive: false } | { alive: true; roles: string[]; permissions: string[] };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt-access') {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),

      ignoreExpiration: false,

      secretOrKey: configService.getOrThrow<string>('jwt.secret'),
    });
  }

  // A valid signature only proves the token was issued once. The session must still exist
  // and the user must still be active, and roles/permissions come from the database (via a
  // short-lived cache), not from the token, so logout, deactivation, password change and
  // role changes take effect within seconds instead of when the access token expires.
  async validate(payload: AccessTokenPayload) {
    // Every token issued by TokenUtil carries a session id. One without it predates this
    // check; the client gets a new one through /refresh.
    if (!payload.sid) {
      throw new UnauthorizedException('invalid_token');
    }

    const sessionId = payload.sid;

    const auth = await this.cache.wrapSessionAuth<SessionAuth>(payload.sub, sessionId, () =>
      this.loadSessionAuth(payload.sub, sessionId),
    );

    if (!auth.alive) {
      throw new UnauthorizedException('session_revoked');
    }

    return {
      id: payload.sub,
      phone: payload.phone,
      roles: auth.roles,
      permissions: auth.permissions,
      sessionId,
    };
  }

  private async loadSessionAuth(userId: string, sessionId: string): Promise<SessionAuth> {
    // Rotated sessions have revokedAt set; logout/reset/deactivate delete the row.
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });

    if (!session) return { alive: false };

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        isActive: true,
        userRoles: {
          select: {
            role: {
              select: {
                name: true,
                rolePermissions: { select: { permission: { select: { name: true } } } },
              },
            },
          },
        },
      },
    });

    if (!user || !user.isActive) return { alive: false };

    const roles = user.userRoles.map((userRole) => userRole.role.name);
    const permissions = [
      ...new Set(
        user.userRoles.flatMap((userRole) =>
          userRole.role.rolePermissions.map((rp) => rp.permission.name),
        ),
      ),
    ];

    return { alive: true, roles, permissions };
  }
}
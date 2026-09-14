import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomUUID } from 'crypto';

import { PrismaService } from 'src/prisma/prisma.service';

type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

// Extracted from AuthService: JWT issuing + opaque-token (refresh/registration/
// promotion/email-change) hashing, used across login, refresh, registration,
// promotion, and email-change flows.

@Injectable()
export class TokenUtil {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ISSUE TOKENS
  async issueTokens(
    userId: string,
    // phone/email are honest separate fields, not one overloaded "phone" param.
    identity: { phone?: string | null; email?: string | null },
    roles: string[],
    // Flattened, deduped permission names baked into both token payloads.
    permissions: string[],
    // Optional tx client so refresh() creates the session inside the same transaction.
    tx: Pick<typeof this.prisma, 'session'> = this.prisma,
  ): Promise<TokenPair> {
    const phone = identity.phone ?? null;
    const email = identity.email ?? null;

    // Both durations go through the same bare-number-means-hours normalization.
    const expiresInStr = this.normalizeDurationString(
      this.configService.get<string>('jwt.expiresIn', '24h'),
    );

    const expiresIn = expiresInStr as any;

    const accessToken = this.jwtService.sign(
      { sub: userId, phone, email, roles, permissions },
      { expiresIn },
    );

    // Refresh tokens use a dedicated secret/TTL so a leaked access secret can't forge them.
    const refreshSecret =
      this.configService.get<string>('jwt.refreshSecret') ??
      this.configService.getOrThrow<string>('jwt.secret');

    const refreshExpiresIn = this.normalizeDurationString(
      this.configService.get<string>('jwt.refreshExpiresIn', '7d'),
    );

    const refreshToken = this.jwtService.sign(
      {
        sub: userId,
        phone,
        email,
        roles,
        permissions,
        type: 'refresh',
        // Unique jti so same-second tokens stay distinguishable
        jti: randomUUID(),
      },
      {
        secret: refreshSecret,
        expiresIn: refreshExpiresIn as any,
      },
    );

    await tx.session.create({
      data: {
        userId,
        // Store an HMAC hash, not the raw token, so a DB read can't be replayed.
        refreshToken: this.hashOpaqueToken(refreshToken, 'refresh'),
        expiresAt: new Date(Date.now() + this.parseDurationToMs(refreshExpiresIn)),
      },
    });

    return { accessToken, refreshToken };
  }

  // Deterministic HMAC-SHA256 for lookup by equality (bcrypt can't be queried directly).
  hashOpaqueToken(
    token: string,
    purpose: 'refresh' | 'registration' | 'promotion' | 'email_change' = 'refresh',
  ): string {
    const secret =
      purpose !== 'refresh'
        ? this.configService.get<string>('jwt.registrationSecret') ??
          this.configService.get<string>('jwt.refreshSecret') ??
          this.configService.getOrThrow<string>('jwt.secret')
        : this.configService.get<string>('jwt.refreshSecret') ??
          this.configService.getOrThrow<string>('jwt.secret');

    return createHmac('sha256', secret).update(token).digest('hex');
  }

  // A bare number means hours, applied consistently to every duration config value.
  private normalizeDurationString(raw: string): string {
    const trimmed = raw.trim();
    return /^\d+$/.test(trimmed) ? `${trimmed}h` : trimmed;
  }

  // Converts "7d"/"24h"/"30m"/"45s" or bare seconds into ms.
  private parseDurationToMs(duration: string): number {
    const match = /^(\d+)\s*(d|h|m|s)?$/.exec(duration.trim());

    if (!match) {
      throw new BadRequestException('invalid_duration_config');
    }

    const value = Number(match[1]);
    const unit = match[2] ?? 's';

    const unitMs: Record<string, number> = {
      d: 24 * 60 * 60 * 1000,
      h: 60 * 60 * 1000,
      m: 60 * 1000,
      s: 1000,
    };

    return value * unitMs[unit];
  }
}
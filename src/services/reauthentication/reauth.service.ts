import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';
import { CacheService } from 'src/services/redis/cache.service'; // REDIS

@Injectable()
export class ReauthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService, // REDIS
  ) {}

  async verifyCredential(userId: string, credential: string): Promise<boolean> {
    if (!credential || typeof credential !== 'string') {
      return false;
    }

    // REDIS: checked before touching Postgres or bcrypt — a locked-out caller gets an
    // immediate, cheap rejection instead of paying for a user lookup and a hash compare.
    if (await this.cache.isReauthLocked(userId)) {
      throw new UnauthorizedException('reauthentication_locked');
    }

    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        passwordHash: true,
        discreetModeEnabled: true,
        discreetModePasscodeHash: true,
        isActive: true,
      },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    if (!user.isActive) {
      return false;
    }

    const passwordMatches = user.passwordHash
      ? await bcrypt.compare(credential, user.passwordHash)
      : false;

    if (passwordMatches) {
      // REDIS: clear any attempts/lock left over from earlier wrong guesses.
      await this.cache.resetReauthFailures(userId);
      return true;
    }

    if (user.discreetModeEnabled && user.discreetModePasscodeHash) {
      const passcodeMatches = await bcrypt.compare(credential, user.discreetModePasscodeHash);

      if (passcodeMatches) {
        // REDIS
        await this.cache.resetReauthFailures(userId);
        return true;
      }
    }

    // REDIS: both checks failed (or Discreet Mode wasn't eligible) — count it.
    const maxAttempts = this.configService.get<number>('security.maxReauthAttempts', 5);
    await this.cache.recordReauthFailure(userId, maxAttempts);

    return false;
  }

  // Backward-compatible alias for verifyCredential(), same password-or-passcode rule
  async verifyPassword(userId: string, credential: string): Promise<boolean> {
    return this.verifyCredential(userId, credential);
  }
}

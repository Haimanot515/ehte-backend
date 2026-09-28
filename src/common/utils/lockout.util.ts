import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/prisma/prisma.service';
import { CacheService } from 'src/services/redis/cache.service'; // REDIS

// Extracted from AuthService: shared lockout logic used by login(), adminLoginByEmail(),
// and every OTP-verify method (phone verification, password reset).
//
// REDIS: failed-password attempts are counted in Redis (security connection, atomic
// INCR+EXPIRE, fixed window = TTL.FAILED_LOGIN_ATTEMPTS) instead of one Postgres UPDATE per
// wrong password. Postgres stays the source of truth for the LOCK itself: `lockedUntil` is
// still written to the user row, because assertNotLocked() and every other reader use it.
// If Redis is unreachable the counter falls back to the original Postgres increment, so an
// outage can never remove lockout protection.

@Injectable()
export class LockoutUtil {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService, // REDIS
  ) {}

  // Throws before password comparison if the account is currently locked.
  assertNotLocked(user: { lockedUntil: Date | null }): void {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('account_locked');
    }
  }

  // Counts a failed attempt; sets lockedUntil once the threshold is hit.
  async recordFailedLogin(userId: string): Promise<void> {
    const maxAttempts = this.configService.get<number>('security.maxLoginAttempts', 5);

    const lockoutMinutes = this.configService.get<number>('security.lockoutDurationMinutes', 15);

    // REDIS: null means the security store is unreachable.
    const attempts = await this.cache.incrementFailedLoginAttempts(userId);

    if (attempts !== null) {
      if (attempts >= maxAttempts) {
        await this.prisma.user.update({
          where: { id: userId },
          data: {
            lockedUntil: new Date(Date.now() + lockoutMinutes * 60 * 1000),
            failedLoginAttempts: 0,
          },
        });
        // The lock now carries the state; start the next window clean.
        await this.cache.resetFailedLoginAttempts(userId);
      }
      return;
    }

    // Fallback: original Postgres-only behaviour.
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });

    if (updated.failedLoginAttempts >= maxAttempts) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          lockedUntil: new Date(Date.now() + lockoutMinutes * 60 * 1000),
          failedLoginAttempts: 0,
        },
      });
    }
  }

  // Clears any accumulated attempts/lock once the correct password is provided.
  async resetLoginAttempts(user: {
    id: string;
    failedLoginAttempts: number;
    lockedUntil: Date | null;
  }): Promise<void> {
    // REDIS: the counter lives here now, so the Postgres row can show 0 attempts while Redis
    // holds some. Clear it on every successful login (one cheap DEL; retried if Redis is down).
    await this.cache.resetFailedLoginAttempts(user.id);

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }
  }

  // Locks the account once an OTP hits max attempts, same as a failed-password lockout.
  async lockAccountForOtpAbuse(userId: string): Promise<void> {
    const lockoutMinutes = this.configService.get<number>('security.lockoutDurationMinutes', 15);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        lockedUntil: new Date(Date.now() + lockoutMinutes * 60 * 1000),
        failedLoginAttempts: 0,
      },
    });

    // REDIS: same as above: the lock replaces the counter.
    await this.cache.resetFailedLoginAttempts(userId);
  }
}
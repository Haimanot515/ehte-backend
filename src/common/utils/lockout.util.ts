import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/prisma/prisma.service';

// Extracted from AuthService: shared lockout logic used by login(), adminLoginByEmail(),
// and every OTP-verify method (phone verification, password reset).

@Injectable()
export class LockoutUtil {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  // Throws before password comparison if the account is currently locked.
  assertNotLocked(user: { lockedUntil: Date | null }): void {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('account_locked');
    }
  }

  // Increments failedLoginAttempts; sets lockedUntil once the threshold is hit.
  async recordFailedLogin(userId: string): Promise<void> {
    const maxAttempts = this.configService.get<number>('security.maxLoginAttempts', 5);

    const lockoutMinutes = this.configService.get<number>('security.lockoutDurationMinutes', 15);

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
  }
}
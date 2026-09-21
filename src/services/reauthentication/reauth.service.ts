import { Injectable, NotFoundException } from '@nestjs/common';

import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';

// Re-auth gate: the password is always accepted, the Discreet Mode passcode only when Discreet Mode is on
@Injectable()
export class ReauthService {
  constructor(private readonly prisma: PrismaService) {}

  async verifyCredential(userId: string, credential: string): Promise<boolean> {
    if (!credential || typeof credential !== 'string') {
      return false;
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
      return true;
    }

    if (user.discreetModeEnabled && user.discreetModePasscodeHash) {
      const passcodeMatches = await bcrypt.compare(credential, user.discreetModePasscodeHash);

      if (passcodeMatches) {
        return true;
      }
    }

    return false;
  }

  // Backward-compatible alias for verifyCredential(), same password-or-passcode rule
  async verifyPassword(userId: string, credential: string): Promise<boolean> {
    return this.verifyCredential(userId, credential);
  }
}
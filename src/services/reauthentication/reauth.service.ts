import { Injectable, NotFoundException } from '@nestjs/common';

import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';

// ─────────────────────────────────────────────
// SENSITIVE-ACTION RE-AUTHENTICATION
//
// This is the separate re-auth concern referenced in
// UserService.updateDiscreetMode()'s comments — that endpoint only
// configures Discreet Mode; this service is what actually gates a
// sensitive action behind a credential check.
//
// Rule:
//   Discreet Mode OFF → only the account password is accepted.
//   Discreet Mode ON  → the account password OR the Discreet Mode
//                        passcode is accepted (either one, not both).
//
// Both credentials are compared as bcrypt hashes. The plaintext
// credential is never stored, and discreetModePasscodeHash is never
// returned to the client from any endpoint.
// ─────────────────────────────────────────────
@Injectable()
export class ReauthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Verify a user's credential for a sensitive action.
   *
   * Discreet Mode OFF:
   *   - Only the account password is accepted.
   *
   * Discreet Mode ON:
   *   - The account password OR the Discreet Mode passcode is
   *     accepted.
   */
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

    // ───────────────────────────────────────────
    // Always allow the normal account password.
    // ───────────────────────────────────────────
    const passwordMatches = user.passwordHash
      ? await bcrypt.compare(credential, user.passwordHash)
      : false;

    if (passwordMatches) {
      return true;
    }

    // ───────────────────────────────────────────
    // Passcode is accepted ONLY when Discreet Mode is enabled.
    // ───────────────────────────────────────────
    if (user.discreetModeEnabled && user.discreetModePasscodeHash) {
      const passcodeMatches = await bcrypt.compare(credential, user.discreetModePasscodeHash);

      if (passcodeMatches) {
        return true;
      }
    }

    return false;
  }

  /**
   * Backward-compatible alias for callers (e.g. an existing
   * ReauthGuard) still invoking verifyPassword() directly. Follows
   * the same Discreet Mode password-OR-passcode rule as
   * verifyCredential() — this is not a password-only check anymore.
   *
   * Migrate call sites to verifyCredential() when convenient, then
   * remove this alias.
   */
  async verifyPassword(userId: string, credential: string): Promise<boolean> {
    return this.verifyCredential(userId, credential);
  }
}
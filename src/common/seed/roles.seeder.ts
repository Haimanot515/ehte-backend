import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';

import { RolesEnum } from '../enums/roles.enum';

// ─────────────────────────────────────────────
// RETRY CONFIG
//
// Neon (and other serverless/autosuspend Postgres providers) can
// take longer than a single query timeout to wake a suspended
// compute on the very first connection of a boot cycle. Rather
// than let that cold-start delay crash the entire app on startup
// (onApplicationBootstrap failures are fatal — see main.ts's
// bootstrap().catch()), retry with backoff before giving up.
// ─────────────────────────────────────────────

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class RolesSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(RolesSeeder.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const name of Object.values(RolesEnum)) {
      await this.upsertWithRetry(name);
    }
  }

  private async upsertWithRetry(name: RolesEnum): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.prisma.role.upsert({
          where: {
            name,
          },
          create: {
            name,
          },
          update: {},
        });

        return;
      } catch (error) {
        lastError = error;

        const isLastAttempt = attempt === MAX_ATTEMPTS;

        if (isLastAttempt) {
          break;
        }

        const delayMs = BASE_DELAY_MS * attempt;

        this.logger.warn(
          `Failed to seed role "${name}" (attempt ${attempt}/${MAX_ATTEMPTS}), ` +
            `retrying in ${delayMs}ms. This is expected if the database is waking ` +
            `from a suspended state. Error: ${(error as Error).message}`,
        );

        await sleep(delayMs);
      }
    }

    this.logger.error(
      `Failed to seed role "${name}" after ${MAX_ATTEMPTS} attempts. Giving up.`,
    );

    throw lastError;
  }
}
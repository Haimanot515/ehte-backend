import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';

import { RolesEnum } from '../enums/roles.enum';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// isProtected/description now set explicitly here rather than via a hardcoded TS array.
// SYSTEM is now protected — it was missing from the old PROTECTED_ROLE_NAMES array.

interface SeedRoleDef {
  name: RolesEnum;
  description: string;
  isProtected: boolean;
}

const ROLE_DEFS: SeedRoleDef[] = [
  {
    name: RolesEnum.SUPER_ADMIN,
    description: 'Full system access. Cannot be renamed or deleted.',
    isProtected: true,
  },
  {
    name: RolesEnum.ADMIN,
    description: 'Operational admin access. Cannot be renamed or deleted.',
    isProtected: true,
  },
  {
    name: RolesEnum.SYSTEM,
    description: 'Reserved for automated/service actors. Cannot be renamed or deleted.',
    isProtected: true,
  },
  {
    name: RolesEnum.USER,
    description: 'Default role for authenticated non-admin users.',
    isProtected: false,
  },
];

@Injectable()
export class RolesSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(RolesSeeder.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const def of ROLE_DEFS) {
      await this.upsertWithRetry(def);
    }
  }

  private async upsertWithRetry(def: SeedRoleDef): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.prisma.role.upsert({
          where: { name: def.name },
          create: {
            name: def.name,
            description: def.description,
            isProtected: def.isProtected,
          },
          update: {
            isProtected: def.isProtected,
            description: def.description,
          },
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
          `Failed to seed role "${def.name}" (attempt ${attempt}/${MAX_ATTEMPTS}), ` +
            `retrying in ${delayMs}ms. This is expected if the database is waking ` +
            `from a suspended state. Error: ${(error as Error).message}`,
        );

        await sleep(delayMs);
      }
    }

    this.logger.error(
      `Failed to seed role "${def.name}" after ${MAX_ATTEMPTS} attempts. Giving up.`,
    );

    throw lastError;
  }
}
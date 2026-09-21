import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';
import { RolesEnum } from '../enums/roles.enum';

// Seeds the initial USER account on boot, keyed by PHONE.
// This matches the USER authentication flow in AuthController/AuthService.
//
// Configure via:
// USER_PHONE     (default: +251900000000)
// USER_NAME      (default: Ehte Test User)
// USER_PASSWORD  (default: P@ssw0rd)
//
// All three fall back to the defaults below if the corresponding
// env var is missing from .env — so this seeder never throws just
// because .env is incomplete. It DOES throw if the RolesEnum.USER
// role row doesn't exist yet (see below) — that one's load-bearing.

@Injectable()
export class UserSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(UserSeeder.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const rawPhone = this.config.get<string>('USER_PHONE', '+251900000000');

    const phone = rawPhone.trim();

    const name = this.config.get<string>('USER_NAME', 'Ehte Test User');

    const password = this.config.get<string>('USER_PASSWORD', 'P@ssw0rd');

    const existingUser = await this.prisma.user.findUnique({
      where: {
        phone,
      },
    });

    if (existingUser) {
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        name,
        phone,
        passwordHash: hashedPassword,

        // The seeded USER is already verified.
        // Therefore login() can be used immediately.
        isPhoneVerified: true,
        isActive: true,
      },
    });

    const role = await this.prisma.role.findUnique({
      where: {
        name: RolesEnum.USER,
      },
    });

    if (!role) {
      throw new Error(
        `Required role "${RolesEnum.USER}" was not found. Ensure RolesSeeder runs before UserSeeder.`,
      );
    }

    await this.prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: role.id,
      },
    });

    this.logger.log(`Seeded initial USER account: ${phone} / ${password}`);
  }
}
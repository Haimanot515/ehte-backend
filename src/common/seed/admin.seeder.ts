import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';
import { RolesEnum } from '../enums/roles.enum';

// Seeds the initial SUPER_ADMIN account on boot, keyed by EMAIL — matching
// AuthService.adminLoginByEmail(), the only admin login path. Phone-based
// admin seeding/login has been removed; this seeder no longer touches
// phone at all. Configure via ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD.

@Injectable()
export class AdminSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminSeeder.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const rawEmail = this.config.get<string>('ADMIN_EMAIL', 'admin@ehte.com');

    // Normalize the same way AuthService does (trim + lowercase), so the
    // seeded row matches what adminLoginByEmail()'s findUnique({ email }) expects
    const email = rawEmail.trim().toLowerCase();

    const name = this.config.get<string>('ADMIN_NAME', 'Ehte System Admin');

    const password = this.config.get<string>('ADMIN_PASSWORD', 'P@ssw0rd');

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        name,
        email,
        passwordHash: hashedPassword,
        // Email-only admin: no phone at all, matching the invite-created
        // admin shape (isPhoneVerified left at its schema default of false)
        isActive: true,
        isEmailVerified: true,
      },
    });

    const role = await this.prisma.role.upsert({
      where: {
        name: RolesEnum.SUPER_ADMIN,
      },
      create: {
        name: RolesEnum.SUPER_ADMIN,
      },
      update: {},
    });

    await this.prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: role.id,
      },
    });

    this.logger.log(`Seeded initial SUPER_ADMIN account: ${email}`);
  }
}
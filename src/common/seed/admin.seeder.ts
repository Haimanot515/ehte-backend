import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';
import { RolesEnum } from '../enums/roles.enum';

const DEV_DEFAULT_PASSWORD = 'P@ssw0rd';
const MIN_PROD_PASSWORD_LENGTH = 12;

@Injectable()
export class AdminSeeder {
  private readonly logger = new Logger(AdminSeeder.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private isDevLike(): boolean {
    const env = this.config.get<string>('app.env') ?? process.env.NODE_ENV ?? '';
    return env === 'development' || env === 'test';
  }

  async run(): Promise<void> {
    const devLike = this.isDevLike();

    const configuredEmail = this.config.get<string>('ADMIN_EMAIL');
    const configuredPassword = this.config.get<string>('ADMIN_PASSWORD');

    // Outside development there are no fallback credentials: both must be set explicitly.
    if (!devLike && (!configuredEmail || !configuredPassword)) {
      this.logger.error(
        'Initial SUPER_ADMIN not seeded: set ADMIN_EMAIL and ADMIN_PASSWORD (no defaults outside development).',
      );
      return;
    }

    const rawEmail = configuredEmail || 'admin@ehte.com';

    // Normalize the same way AuthService does (trim + lowercase), so the
    // seeded row matches what adminLoginByEmail()'s findUnique({ email }) expects
    const email = rawEmail.trim().toLowerCase();

    const name = this.config.get<string>('ADMIN_NAME') || 'Ehte System Admin';

    const password = configuredPassword || DEV_DEFAULT_PASSWORD;

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return;
    }

    if (!devLike && (password === DEV_DEFAULT_PASSWORD || password.length < MIN_PROD_PASSWORD_LENGTH)) {
      this.logger.error(
        `Initial SUPER_ADMIN not seeded: ADMIN_PASSWORD must be at least ${MIN_PROD_PASSWORD_LENGTH} characters and not the development default.`,
      );
      return;
    }

    const role = await this.prisma.role.findUnique({
      where: {
        name: RolesEnum.SUPER_ADMIN,
      },
    });

    if (!role) {
      throw new Error(
        `Required role "${RolesEnum.SUPER_ADMIN}" was not found. Ensure RolesSeeder runs before AdminSeeder.`,
      );
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

    await this.prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: role.id,
      },
    });

    this.logger.log(`Seeded initial SUPER_ADMIN account: ${email}`);
  }
}

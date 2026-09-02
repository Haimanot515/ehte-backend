import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';
import { RolesEnum } from '../enums/roles.enum';

@Injectable()
export class AdminSeeder implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const phone = this.config.get<string>('ADMIN_PHONE', '+251900000000');

    const name = this.config.get<string>('ADMIN_NAME', 'Ehte System Admin');

    const password = this.config.get<string>('ADMIN_PASSWORD', 'P@ssw0rd');

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
        password: hashedPassword,
        isActive: true,
        isPhoneVerified: true,
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
  }
}

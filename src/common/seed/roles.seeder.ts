import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';

import { RolesEnum } from '../enums/roles.enum';

@Injectable()
export class RolesSeeder implements OnApplicationBootstrap {
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const name of Object.values(RolesEnum)) {
      await this.prisma.role.upsert({
        where: {
          name,
        },
        create: {
          name,
        },
        update: {},
      });
    }
  }
}

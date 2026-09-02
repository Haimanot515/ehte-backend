import { Injectable, NotFoundException } from '@nestjs/common';

import * as bcrypt from 'bcrypt';

import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class ReauthService {
  constructor(private readonly prisma: PrismaService) {}

  async verifyPassword(userId: string, password: string): Promise<boolean> {
    if (!password || typeof password !== 'string') {
      return false;
    }

    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        password: true,
        isActive: true,
      },
    });

    if (!user) {
      throw new NotFoundException('user_not_found');
    }

    if (!user.isActive || !user.password) {
      return false;
    }

    return bcrypt.compare(password, user.password);
  }
}

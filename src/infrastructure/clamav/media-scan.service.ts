import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from 'src/prisma/prisma.service';

const LOCK_STALE_MS = 5 * 60 * 1000;

@Injectable()
export class MediaScanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.get<string>('CLAMAV_ENABLED') === 'true';
  }

  async registerPending(key: string): Promise<void> {
    if (!this.enabled) return;
    const ttlHours = Number(this.config.get<string>('MEDIA_SCAN_PENDING_TTL_HOURS') ?? 2);
    await this.prisma.mediaScan.upsert({
      where: { objectKey: key },
      update: {},
      create: {
        objectKey: key,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
      },
    });
  }

  async registerClean(key: string): Promise<void> {
    if (!this.enabled) return;
    await this.prisma.mediaScan.upsert({
      where: { objectKey: key },
      update: { status: 'CLEAN', scannedAt: new Date() },
      create: { objectKey: key, status: 'CLEAN', scannedAt: new Date() },
    });
  }

  async assertUsable(key: string): Promise<void> {
    if (!this.enabled) return;
    const row = await this.prisma.mediaScan.findUnique({
      where: { objectKey: key },
      select: { status: true },
    });
    if (!row || row.status === 'CLEAN') return;
    throw new BadRequestException(`media_scan_${row.status.toLowerCase()}:${key}`);
  }

  findDue(limit: number) {
    return this.prisma.mediaScan.findMany({
      where: { status: 'PENDING', OR: [{ lockedAt: null }, { lockedAt: { lt: this.staleLock() } }] },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true, objectKey: true, expiresAt: true },
    });
  }

  async claim(id: string): Promise<boolean> {
    const result = await this.prisma.mediaScan.updateMany({
      where: {
        id,
        status: 'PENDING',
        OR: [{ lockedAt: null }, { lockedAt: { lt: this.staleLock() } }],
      },
      data: { lockedAt: new Date() },
    });
    return result.count === 1;
  }

  async release(id: string): Promise<void> {
    await this.prisma.mediaScan.update({ where: { id }, data: { lockedAt: null } });
  }

  async markClean(id: string): Promise<void> {
    await this.prisma.mediaScan.update({
      where: { id },
      data: { status: 'CLEAN', lockedAt: null, scannedAt: new Date() },
    });
  }

  async markBlocked(id: string, status: 'INFECTED' | 'REJECTED', signature: string): Promise<void> {
    await this.prisma.mediaScan.update({
      where: { id },
      data: { status, signature, lockedAt: null, scannedAt: new Date() },
    });
  }

  async recordFailure(id: string, maxAttempts: number): Promise<void> {
    const row = await this.prisma.mediaScan.update({
      where: { id },
      data: { attempts: { increment: 1 }, lockedAt: null },
    });
    if (row.attempts >= maxAttempts) {
      await this.prisma.mediaScan.update({ where: { id }, data: { status: 'FAILED' } });
    }
  }

  async remove(id: string): Promise<void> {
    await this.prisma.mediaScan.delete({ where: { id } });
  }

  private staleLock(): Date {
    return new Date(Date.now() - LOCK_STALE_MS);
  }
}

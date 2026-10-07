import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ApiClient, ApiClientStatus, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { dateRange, pageMeta, paging } from '../../common/paging.util';
import {
  ApiClientAuditQueryDto,
  ApiClientsQueryDto,
  ApiClientUsageQueryDto,
  CreateApiClientDto,
  UpdateApiClientDto,
} from '../dto/api-clients.dto';

// After a rotation the old secret keeps working this long, so partners can switch over
const ROTATION_GRACE_HOURS = 24;
const DAY_MS = 86_400_000;
const MAX_HOURLY_RANGE_DAYS = 14;
const MAX_RANGE_DAYS = 90;

// Hashes and the raw secret never leave the service
type SafeClient = Omit<ApiClient, 'secretHash' | 'previousSecretHash'> & { hasPreviousSecret: boolean };

@Injectable()
export class ApiClientsService {
  constructor(private readonly prisma: PrismaService) {}

  // SH-88
  async create(admin: CurrentUserDto, body: CreateApiClientDto) {
    if (body.institutionId) {
      const institution = await this.prisma.institution.findUnique({
        where: { id: body.institutionId },
        select: { id: true },
      });
      if (!institution) throw new BadRequestException('institution_not_found');
    }

    const secret = this.newSecret();
    const row = await this.prisma.apiClient.create({
      data: {
        name: body.name,
        clientId: this.newClientId(),
        secretHash: this.hash(secret),
        scopes: body.scopes,
        ipAllowlist: body.ipAllowlist ?? [],
        rateLimitPerMinute: body.rateLimitPerMinute ?? null,
        institutionId: body.institutionId ?? null,
        createdById: admin.id,
      },
    });

    // The only time the secret is returned
    return { ...this.safe(row), clientSecret: secret };
  }

  // SH-89
  async list(q: ApiClientsQueryDto) {
    const { page, limit, skip } = paging(q);
    const where: Prisma.ApiClientWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.institutionId ? { institutionId: q.institutionId } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
      ...(q.unusedForDays
        ? this.unusedWhere(new Date(Date.now() - q.unusedForDays * DAY_MS))
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.apiClient.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.apiClient.count({ where }),
    ]);

    return { data: rows.map((r) => this.safe(r)), meta: pageMeta(page, limit, total) };
  }

  // SH-90
  async getOne(id: string) {
    const row = await this.require(id);
    const since = new Date(Date.now() - DAY_MS);

    const [recentCalls, calls24h, errors24h] = await Promise.all([
      this.prisma.apiClientCall.findMany({
        where: { clientId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, method: true, route: true, statusCode: true, durationMs: true, createdAt: true },
      }),
      this.prisma.apiClientCall.count({ where: { clientId: id, createdAt: { gte: since } } }),
      this.prisma.apiClientCall.count({ where: { clientId: id, createdAt: { gte: since }, statusCode: { gte: 400 } } }),
    ]);

    return { ...this.safe(row), last24h: { calls: calls24h, errors: errors24h }, recentCalls };
  }

  // SH-91
  async update(_admin: CurrentUserDto, id: string, body: UpdateApiClientDto) {
    const existing = await this.require(id);
    if (existing.status === ApiClientStatus.REVOKED) throw new ConflictException('api_client_revoked');

    const data: Prisma.ApiClientUncheckedUpdateManyInput = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.scopes !== undefined ? { scopes: body.scopes } : {}),
      ...(body.ipAllowlist !== undefined ? { ipAllowlist: body.ipAllowlist } : {}),
      // null clears the per-client limit
      ...(body.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: body.rateLimitPerMinute } : {}),
    };
    if (Object.keys(data).length === 0) throw new BadRequestException('nothing_to_update');

    // Guard on status so an update cannot slip in after a revoke
    const result = await this.prisma.apiClient.updateMany({
      where: { id, status: ApiClientStatus.ACTIVE },
      data,
    });
    if (result.count === 0) throw new ConflictException('api_client_revoked');

    return this.safe(await this.require(id));
  }

  // SH-92
  async rotateSecret(_admin: CurrentUserDto, id: string) {
    const existing = await this.require(id);
    if (existing.status === ApiClientStatus.REVOKED) throw new ConflictException('api_client_revoked');

    const secret = this.newSecret();
    const now = new Date();
    const previousSecretExpiresAt = new Date(now.getTime() + ROTATION_GRACE_HOURS * 3_600_000);

    // Guard on the old hash so two rotations at once cannot both win
    const result = await this.prisma.apiClient.updateMany({
      where: { id, status: ApiClientStatus.ACTIVE, secretHash: existing.secretHash },
      data: {
        secretHash: this.hash(secret),
        previousSecretHash: existing.secretHash,
        previousSecretExpiresAt,
        secretRotatedAt: now,
      },
    });
    if (result.count === 0) throw new ConflictException('api_client_changed_try_again');

    return { id, clientId: existing.clientId, clientSecret: secret, previousSecretExpiresAt, rotatedAt: now };
  }

  // SH-93
  async revoke(admin: CurrentUserDto, id: string) {
    const revokedAt = new Date();
    const result = await this.prisma.apiClient.updateMany({
      where: { id, status: ApiClientStatus.ACTIVE },
      data: {
        status: ApiClientStatus.REVOKED,
        revokedAt,
        revokedById: admin.id,
        // A revoked client has no grace period, both secrets stop at once
        previousSecretHash: null,
        previousSecretExpiresAt: null,
      },
    });

    if (result.count === 0) {
      await this.require(id);
      throw new ConflictException('api_client_already_revoked');
    }

    return { id, status: ApiClientStatus.REVOKED, revokedAt };
  }

  // SH-94
  async usage(id: string, q: ApiClientUsageQueryDto) {
    await this.require(id);

    const interval = q.interval ?? 'day';
    const { from, to } = dateRange(q, 7);
    if (from.getTime() >= to.getTime()) throw new BadRequestException('from_must_be_before_to');

    const days = (to.getTime() - from.getTime()) / DAY_MS;
    if (days > MAX_RANGE_DAYS) throw new BadRequestException(`range_too_large_max_${MAX_RANGE_DAYS}_days`);
    if (interval === 'hour' && days > MAX_HOURLY_RANGE_DAYS) {
      throw new BadRequestException(`hourly_range_too_large_max_${MAX_HOURLY_RANGE_DAYS}_days`);
    }

    const [series, byRoute, totals] = await Promise.all([
      this.prisma.$queryRaw<Array<{ bucket: Date; calls: number; errors: number }>>(Prisma.sql`
        SELECT date_trunc(${interval}::text, "createdAt") AS bucket,
               COUNT(*)::int AS calls,
               (COUNT(*) FILTER (WHERE "statusCode" >= 400))::int AS errors
        FROM "api_client_call"
        WHERE "clientId" = ${id} AND "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY 1
        ORDER BY 1
      `),
      this.prisma.apiClientCall.groupBy({
        by: ['method', 'route'],
        where: { clientId: id, createdAt: { gte: from, lte: to } },
        _count: { _all: true },
        _avg: { durationMs: true },
        orderBy: { _count: { route: 'desc' } },
        take: 20,
      }),
      this.prisma.apiClientCall.aggregate({
        where: { clientId: id, createdAt: { gte: from, lte: to } },
        _count: { _all: true },
        _avg: { durationMs: true },
      }),
    ]);

    return {
      clientId: id,
      range: { from, to },
      interval,
      totals: { calls: totals._count._all, avgDurationMs: this.round(totals._avg.durationMs) },
      series,
      byRoute: byRoute.map((r) => ({
        method: r.method,
        route: r.route,
        calls: r._count._all,
        avgDurationMs: this.round(r._avg.durationMs),
      })),
    };
  }

  // SH-95
  async audit(_admin: CurrentUserDto, id: string, q: ApiClientAuditQueryDto) {
    await this.require(id);

    const { page, limit, skip } = paging(q);
    const { from, to } = dateRange(q, 7);
    const where: Prisma.ApiClientCallWhereInput = {
      clientId: id,
      createdAt: { gte: from, lte: to },
      ...(q.method ? { method: q.method } : {}),
      ...(q.route ? { route: { contains: q.route, mode: 'insensitive' } } : {}),
      ...(q.statusCode ? { statusCode: q.statusCode } : q.failedOnly ? { statusCode: { gte: 400 } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.apiClientCall.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.apiClientCall.count({ where }),
    ]);

    return { data: rows, meta: pageMeta(page, limit, total) };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async require(id: string) {
    const row = await this.prisma.apiClient.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('api_client_not_found');
    return row;
  }

  private safe(row: ApiClient): SafeClient {
    const { secretHash: _s, previousSecretHash, ...rest } = row;
    const stillValid =
      !!previousSecretHash && !!row.previousSecretExpiresAt && row.previousSecretExpiresAt.getTime() > Date.now();
    return { ...rest, hasPreviousSecret: stillValid };
  }

  private unusedWhere(cutoff: Date): Prisma.ApiClientWhereInput {
    return {
      OR: [{ lastUsedAt: { lt: cutoff } }, { lastUsedAt: null, createdAt: { lt: cutoff } }],
    };
  }

  // 32 random bytes is enough entropy that a plain SHA-256 is safe and lets the gateway look it up fast
  private newSecret(): string {
    return `sk_${randomBytes(32).toString('base64url')}`;
  }

  private newClientId(): string {
    return `ehte_${randomBytes(12).toString('hex')}`;
  }

  private hash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  private round(value: number | null | undefined): number | null {
    return value === null || value === undefined ? null : Math.round(value);
  }
}

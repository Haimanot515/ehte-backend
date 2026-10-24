import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { MissingPersonStatus, MissingPersonType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { PaginationQueryDto } from '../dto/missing-person.dto';
import { ADMIN_BASE_WHERE } from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonDuplicatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

  async listDuplicates(query: PaginationQueryDto) {
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);

    const rows = await this.prisma.$queryRaw<
      {
        caseId: string;
        duplicateId: string;
        personType: string;
        name: string | null;
        areaA: string;
        areaB: string;
        createdAtA: Date;
        createdAtB: Date;
        total: number;
      }[]
    >`
      SELECT a.id AS "caseId", b.id AS "duplicateId", a."personType"::text AS "personType",
             a.name AS name, a."lastKnownArea" AS "areaA", b."lastKnownArea" AS "areaB",
             a."createdAt" AS "createdAtA", b."createdAt" AS "createdAtB",
             COUNT(*) OVER()::int AS total
      FROM missing_person a
      JOIN missing_person b
        ON a.id < b.id
       AND a."personType" = b."personType"
       AND a.name IS NOT NULL
       AND LOWER(TRIM(a.name)) = LOWER(TRIM(b.name))
      WHERE a."deletedAt" IS NULL AND b."deletedAt" IS NULL
        AND a."mergedIntoId" IS NULL AND b."mergedIntoId" IS NULL
        AND a.status NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED', 'FOUND')
        AND b.status NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED', 'FOUND')
      ORDER BY a."createdAt" DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    return {
      data: rows.map(({ total: _total, name, ...row }) => ({
        ...row,
        label:
          row.personType === MissingPersonType.CHILD
            ? `Child case ${row.caseId.slice(0, 8)}`
            : name,
      })),
      meta: this.missingPersonCommonService.pageMeta(page, limit, rows[0]?.total ?? 0),
    };
  }

  async findPossibleDuplicates(id: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    const window = 3 * 24 * 60 * 60 * 1000;

    const or: Prisma.MissingPersonWhereInput[] = [
      {
        lastKnownArea: { equals: existing.lastKnownArea, mode: 'insensitive' },
        dateLastSeen: {
          gte: new Date(existing.dateLastSeen.getTime() - window),
          lte: new Date(existing.dateLastSeen.getTime() + window),
        },
      },
    ];
    if (existing.name?.trim()) {
      or.push({ name: { equals: existing.name.trim(), mode: 'insensitive' } });
    }

    const candidates = await this.prisma.missingPerson.findMany({
      where: {
        ...ADMIN_BASE_WHERE,
        id: { not: id },
        personType: existing.personType,
        OR: or,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        name: true,
        personType: true,
        status: true,
        lastKnownArea: true,
        dateLastSeen: true,
        createdAt: true,
        userId: true,
      },
    });

    return {
      data: candidates.map((c) => {
        const matchedOn: string[] = [];
        if (
          existing.name &&
          c.name &&
          existing.name.trim().toLowerCase() === c.name.trim().toLowerCase()
        ) {
          matchedOn.push('name');
        }
        if (
          c.lastKnownArea.toLowerCase() === existing.lastKnownArea.toLowerCase() &&
          Math.abs(c.dateLastSeen.getTime() - existing.dateLastSeen.getTime()) <= window
        ) {
          matchedOn.push('area_and_date');
        }
        return { ...c, label: this.missingPersonCommonService.caseLabel(c), matchedOn };
      }),
    };
  }

  // Moves tips, claims and updates onto this case and retires the duplicate.
  async merge(admin: CurrentUserDto, id: string, duplicateId: string, reason?: string) {
    if (id === duplicateId) throw new BadRequestException('cannot_merge_a_case_into_itself');

    const [primary, duplicate] = await Promise.all([
      this.missingPersonCommonService.loadCase(id),
      this.missingPersonCommonService.loadCase(duplicateId),
    ]);

    if (primary.deletedAt || primary.mergedIntoId)
      throw new BadRequestException('target_case_not_available');
    if (duplicate.deletedAt || duplicate.mergedIntoId)
      throw new BadRequestException('duplicate_case_not_available');
    if (duplicate.legalHold) throw new ConflictException('duplicate_under_legal_hold');

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.informationSubmission.updateMany({
        where: { missingPersonId: duplicateId },
        data: { missingPersonId: id },
      }),
      this.prisma.missingPersonUpdate.updateMany({
        where: { missingPersonId: duplicateId },
        data: { missingPersonId: id },
      }),
      this.prisma.missingPerson.update({
        where: { id: duplicateId },
        data: {
          mergedIntoId: id,
          mergedAt: now,
          mergedById: admin.id,
          status: MissingPersonStatus.CANCELLED,
          closureReason: `merged_into:${id}`,
          closedAt: now,
          claimedByUserId: null,
          claimedAt: null,
        },
      }),
    ]);

    await Promise.all([
      this.cache.invalidateMissingPersonEverywhere(id),
      this.cache.invalidateMissingPersonEverywhere(duplicateId),
    ]);

    this.missingPersonCommonService.auditOp(
      admin,
      primary,
      'merge',
      { mergedDuplicateId: duplicateId, duplicatePreviousStatus: duplicate.status },
      { reason: reason ?? null },
    );
    this.missingPersonCommonService.auditOp(
      admin,
      duplicate,
      'merged_into',
      {
        mergedIntoId: id,
        previousStatus: duplicate.status,
        newStatus: MissingPersonStatus.CANCELLED,
      },
      { reason: reason ?? null },
    );

    return this.missingPersonCommonService.loadCase(id);
  }
}

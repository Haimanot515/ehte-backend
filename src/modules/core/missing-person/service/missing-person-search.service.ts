import { Injectable } from '@nestjs/common';
import { MissingPersonStatus, MissingPersonType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AdminSearchMissingPersonsQueryDto } from '../dto/missing-person.dto';
import { ADMIN_BASE_WHERE } from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

    async searchForAdmin(admin: CurrentUserDto, query: AdminSearchMissingPersonsQueryDto) {
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const q = query.q.trim();

    const where: Prisma.MissingPersonWhereInput = {
      ...ADMIN_BASE_WHERE,
      ...(query.status !== undefined ? { status: query.status } : {}),
      OR: [
        { id: q },
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { lastKnownArea: { contains: q, mode: 'insensitive' } },
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { readStates: { where: { adminId: admin.id }, select: { adminId: true } } },
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data: rows.map(({ readStates, ...item }) => ({ ...item, isRead: readStates.length > 0 })),
      meta: this.missingPersonCommonService.pageMeta(page, limit, total),
    };
  }

  // Column names here are fixed internal constants, never user input.
  private async facet(
    column: string,
    limit = 50,
  ): Promise<Array<{ value: string; count: number }>> {
    const col = Prisma.raw(`mp."${column}"::text`);
    return this.prisma.$queryRaw<Array<{ value: string; count: number }>>`
      SELECT ${col} AS value, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE mp."deletedAt" IS NULL AND mp."mergedIntoId" IS NULL AND ${col} IS NOT NULL
      GROUP BY 1
      ORDER BY count DESC, value ASC
      LIMIT ${limit}
    `;
  }

  async getFacets() {
    const [status, personType, gender, ageGroup, area, assignedTo] = await Promise.all([
      this.facet('status'),
      this.facet('personType'),
      this.facet('gender'),
      this.facet('ageGroup'),
      this.facet('lastKnownArea', 25),
      this.facet('assignedToUserId'),
    ]);
    return { status, personType, gender, ageGroup, area, assignedTo };
  }

  async getFilterOptions() {
    const [areas, genders, ageGroups, assignees] = await Promise.all([
      this.facet('lastKnownArea', 200),
      this.facet('gender'),
      this.facet('ageGroup'),
      this.prisma.user.findMany({
        where: { assignedMissingPersons: { some: {} } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      statuses: Object.values(MissingPersonStatus),
      personTypes: Object.values(MissingPersonType),
      areas: areas.map((a) => a.value),
      genders: genders.map((g) => g.value),
      ageGroups: ageGroups.map((a) => a.value),
      assignees,
    };
  }
}

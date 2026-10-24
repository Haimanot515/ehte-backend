import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MissingPersonStatus, MissingPersonType, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  FlagMissingPersonDto,
  ListMissingPersonsQueryDto,
  RecentMissingPersonsQueryDto,
  SearchMissingPersonsQueryDto,
} from '../dto/missing-person.dto';
import { PUBLIC_SELECT } from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonPublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

  async getPublicMediaDownloadUrl(id: string, key: string): Promise<{ url: string }> {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: PUBLIC_SELECT,
    });

    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }

    const owned = this.missingPersonCommonService.collectMediaFields(missingPerson).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  async findOne(id: string) {
    type PublicMissingPerson = Prisma.MissingPersonGetPayload<{ select: typeof this.publicSelect }>;

    const cached = await this.cache.getMissingPerson<PublicMissingPerson>(id);
    if (cached !== null) return cached;

    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: PUBLIC_SELECT,
    });

    if (!missingPerson || missingPerson.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }

    await this.cache.setMissingPerson(id, missingPerson);
    return missingPerson;
  }

  async findAll(query: ListMissingPersonsQueryDto) {
    return this.cache.wrapMissingPersonList(query as unknown as Record<string, unknown>, () =>
      this.findAllUncached(query),
    );
  }

  private async findAllUncached(query: ListMissingPersonsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      status: MissingPersonStatus.APPROVED,
      ...(query.type !== undefined ? { personType: query.type } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        select: PUBLIC_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async search(query: SearchMissingPersonsQueryDto) {
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const q = query.q.trim();

    const where: Prisma.MissingPersonWhereInput = {
      status: MissingPersonStatus.APPROVED,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { lastKnownArea: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ],
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        select: PUBLIC_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data,
      meta: this.missingPersonCommonService.pageMeta(page, limit, total),
    };
  }

  async getPublicStats() {
    const [active, found, activeChildren, activeWomen] = await Promise.all([
      this.prisma.missingPerson.count({ where: { status: MissingPersonStatus.APPROVED } }),
      this.prisma.missingPerson.count({ where: { status: MissingPersonStatus.FOUND } }),
      this.prisma.missingPerson.count({
        where: { status: MissingPersonStatus.APPROVED, personType: MissingPersonType.CHILD },
      }),
      this.prisma.missingPerson.count({
        where: { status: MissingPersonStatus.APPROVED, personType: MissingPersonType.WOMAN },
      }),
    ]);
    return { active, found, activeByType: { CHILD: activeChildren, WOMAN: activeWomen } };
  }

  async findRecent(query: RecentMissingPersonsQueryDto) {
    const data = await this.prisma.missingPerson.findMany({
      where: { status: MissingPersonStatus.APPROVED },
      select: PUBLIC_SELECT,
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 10,
    });
    return { data };
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private publicWebUrl(id: string): string {
    const base = (this.configService.get<string>('WEB_BASE_URL') ?? '').replace(/\/+$/, '');
    return `${base}/missing-persons/${id}`;
  }

  async getPoster(id: string) {
    const mp = await this.missingPersonCommonService.loadApprovedPublic(id);
    const photoUrl = mp.photo[0]
      ? ((await this.missingPersonCommonService.presignKeys([mp.photo[0]]))[0]?.url ?? null)
      : null;

    const contactPhone = this.configService.get<string>('MISSING_PERSON_POSTER_CONTACT') ?? null;
    const url = this.publicWebUrl(mp.id);

    const e = (v: string | null | undefined) => this.escapeHtml(v ?? '');
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>Missing: ${e(mp.name ?? 'Unknown')}</title></head>` +
      `<body style="font-family:sans-serif;max-width:700px;margin:24px auto;text-align:center">` +
      `<h1 style="font-size:48px;margin:0">MISSING</h1>` +
      (photoUrl
        ? `<img src="${e(photoUrl)}" style="max-width:100%;max-height:420px" alt="">`
        : '') +
      `<h2>${e(mp.name ?? 'Name not provided')}</h2>` +
      `<p>Last seen ${e(mp.dateLastSeen.toISOString().slice(0, 10))} near ${e(mp.lastKnownArea)}</p>` +
      `<p>${e(mp.description)}</p>` +
      (contactPhone ? `<p>Call: ${e(contactPhone)}</p>` : '') +
      `<p>${e(url)}</p></body></html>`;

    return {
      id: mp.id,
      title: 'MISSING',
      name: mp.name,
      personType: mp.personType,
      description: mp.description,
      dateLastSeen: mp.dateLastSeen,
      lastKnownArea: mp.lastKnownArea,
      photoUrl,
      contactPhone,
      url,
      html,
      generatedAt: new Date(),
    };
  }

  async getShare(id: string) {
    const mp = await this.missingPersonCommonService.loadApprovedPublic(id);
    const url = this.publicWebUrl(mp.id);
    const deepLinkBase =
      this.configService.get<string>('APP_DEEP_LINK_BASE') ?? 'ehte://missing-persons';

    const who = mp.name ?? 'A missing person';
    const text =
      `${who} was last seen on ${mp.dateLastSeen.toISOString().slice(0, 10)} ` +
      `near ${mp.lastKnownArea}. If you have any information, please open the link.`;

    return {
      id: mp.id,
      title: `Missing: ${mp.name ?? 'Help us find this person'}`,
      text,
      url,
      deepLink: `${deepLinkBase.replace(/\/+$/, '')}/${mp.id}`,
    };
  }

  async flag(user: CurrentUserDto, id: string, data: FlagMissingPersonDto) {
    const mp = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!mp || mp.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }
    if (mp.userId === user.id) {
      throw new BadRequestException('cannot_flag_own_case');
    }

    try {
      const flag = await this.prisma.missingPersonFlag.create({
        data: {
          missingPersonId: id,
          reporterId: user.id,
          reason: data.reason,
          details: data.details ?? null,
        },
      });
      this.missingPersonCommonService.auditOp(user, mp, 'reader_flag', {
        flagId: flag.id,
        reason: data.reason,
      });
      return { id: flag.id, status: flag.status, createdAt: flag.createdAt };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('already_flagged_by_you');
      }
      throw err;
    }
  }

  // One row per user per case per day. Owner views are not counted.
  async recordView(user: CurrentUserDto, id: string) {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id },
      select: { status: true, userId: true },
    });
    if (!mp || mp.status !== MissingPersonStatus.APPROVED) {
      throw new NotFoundException('missing_person_not_found');
    }
    if (mp.userId === user.id) return { recorded: false };

    const viewedOn = new Date(new Date().toISOString().slice(0, 10));
    const { count } = await this.prisma.missingPersonView.createMany({
      data: [{ missingPersonId: id, userId: user.id, viewedOn }],
      skipDuplicates: true,
    });
    return { recorded: count > 0 };
  }
}

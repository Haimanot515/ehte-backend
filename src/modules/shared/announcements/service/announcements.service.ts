import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Announcement, AnnouncementEventKind, AnnouncementSeverity, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { pageMeta, paging } from '../../common/paging.util';
import {
  AdminAnnouncementsQueryDto,
  AnnouncementTranslation,
  CreateAnnouncementDto,
  MyAnnouncementsQueryDto,
  PreviewAnnouncementDto,
  UpdateAnnouncementDto,
} from '../dto/announcements.dto';

type AnnouncementStatus = 'SCHEDULED' | 'ACTIVE' | 'ENDED';

@Injectable()
export class AnnouncementsService {
  constructor(private readonly prisma: PrismaService) {}

  async listActive(user: CurrentUserDto, q: MyAnnouncementsQueryDto) {
    const now = new Date();
    const me = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { profile: { select: { region: true, preferredLanguage: true } } },
    });
    const language = q.language ?? me?.profile?.preferredLanguage ?? null;

    const rows = await this.prisma.announcement.findMany({
      where: {
        AND: [
          this.activeWhere(now),
          this.audienceWhere(user.roles ?? [], me?.profile?.region ?? null, language),
          { dismissals: { none: { userId: user.id } } },
        ],
      },
      orderBy: [{ severity: 'desc' }, { startsAt: 'desc' }],
      take: q.limit ?? 20,
    });

    if (rows.length > 0) {
      await this.prisma.announcementEvent.createMany({
        data: rows.map((r) => ({
          announcementId: r.id,
          userId: user.id,
          kind: AnnouncementEventKind.SHOWN,
        })),
        skipDuplicates: true,
      });
    }

    return {
      data: rows.map((r) => ({
        id: r.id,
        severity: r.severity,
        linkUrl: r.linkUrl,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        ...this.pick(r.translations, language),
      })),
    };
  }

  async dismiss(user: CurrentUserDto, id: string) {
    await this.requireAnnouncement(id);

    await this.prisma.announcementDismissal.upsert({
      where: { announcementId_userId: { announcementId: id, userId: user.id } },
      create: { announcementId: id, userId: user.id },
      update: {},
    });

    return { id, dismissed: true };
  }

  async recordClick(user: CurrentUserDto, id: string) {
    await this.requireAnnouncement(id);

    await this.prisma.announcementEvent.createMany({
      data: [{ announcementId: id, userId: user.id, kind: AnnouncementEventKind.CLICKED }],
      skipDuplicates: true,
    });

    return { id, clicked: true };
  }

  async create(admin: CurrentUserDto, body: CreateAnnouncementDto) {
    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
    const endsAt = body.endsAt ? new Date(body.endsAt) : null;
    this.assertWindow(startsAt, endsAt);

    const row = await this.prisma.announcement.create({
      data: {
        translations: body.translations as unknown as Prisma.InputJsonValue,
        severity: body.severity ?? AnnouncementSeverity.INFO,
        audienceRoles: body.audienceRoles ?? [],
        regions: body.regions ?? [],
        languages: body.languages ?? [],
        linkUrl: body.linkUrl ?? null,
        startsAt,
        endsAt,
        createdById: admin.id,
      },
    });

    return this.shapeAdmin(row, new Date());
  }

  async adminList(q: AdminAnnouncementsQueryDto) {
    const { page, limit, skip } = paging(q);
    const now = new Date();
    const where: Prisma.AnnouncementWhereInput = {
      ...(q.severity ? { severity: q.severity } : {}),
      ...(q.status ? this.statusWhere(q.status as AnnouncementStatus, now) : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.announcement.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.announcement.count({ where }),
    ]);

    const ids = rows.map((r) => r.id);
    const [events, dismissals] = await Promise.all([
      this.prisma.announcementEvent.groupBy({
        by: ['announcementId', 'kind'],
        where: { announcementId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.announcementDismissal.groupBy({
        by: ['announcementId'],
        where: { announcementId: { in: ids } },
        _count: { _all: true },
      }),
    ]);

    const countOf = (id: string, kind: AnnouncementEventKind) =>
      events.find((e) => e.announcementId === id && e.kind === kind)?._count._all ?? 0;

    return {
      data: rows.map((r) => ({
        ...this.shapeAdmin(r, now),
        reach: {
          shown: countOf(r.id, AnnouncementEventKind.SHOWN),
          clicked: countOf(r.id, AnnouncementEventKind.CLICKED),
          dismissed: dismissals.find((d) => d.announcementId === r.id)?._count._all ?? 0,
        },
      })),
      meta: pageMeta(page, limit, total),
    };
  }

  async reach(id: string) {
    await this.requireAnnouncement(id);

    const [events, dismissed] = await Promise.all([
      this.prisma.announcementEvent.groupBy({
        by: ['kind'],
        where: { announcementId: id },
        _count: { _all: true },
      }),
      this.prisma.announcementDismissal.count({ where: { announcementId: id } }),
    ]);

    const shown = events.find((e) => e.kind === AnnouncementEventKind.SHOWN)?._count._all ?? 0;
    const clicked = events.find((e) => e.kind === AnnouncementEventKind.CLICKED)?._count._all ?? 0;

    return {
      id,
      shown,
      clicked,
      dismissed,
      clickRate: shown > 0 ? Number((clicked / shown).toFixed(4)) : 0,
    };
  }

  async preview(id: string, body: PreviewAnnouncementDto) {
    const row = await this.requireAnnouncement(id);

    const matches = (list: string[], value?: string) =>
      list.length === 0 || (!!value && list.includes(value));

    return {
      id,
      severity: row.severity,
      linkUrl: row.linkUrl,
      audienceMatch:
        matches(row.audienceRoles, body.role) &&
        matches(row.regions, body.region) &&
        matches(row.languages, body.language),
      ...this.pick(row.translations, body.language ?? null),
    };
  }

  async update(admin: CurrentUserDto, id: string, body: UpdateAnnouncementDto) {
    const existing = await this.requireAnnouncement(id);
    if (existing.endedAt) throw new ConflictException('announcement_already_ended');

    const startsAt = body.startsAt ? new Date(body.startsAt) : existing.startsAt;
    const endsAt = body.endsAt ? new Date(body.endsAt) : existing.endsAt;
    this.assertWindow(startsAt, endsAt, !!body.endsAt);

    const row = await this.prisma.announcement.update({
      where: { id },
      data: {
        ...(body.translations
          ? { translations: body.translations as unknown as Prisma.InputJsonValue }
          : {}),
        ...(body.severity ? { severity: body.severity } : {}),
        ...(body.audienceRoles ? { audienceRoles: body.audienceRoles } : {}),
        ...(body.regions ? { regions: body.regions } : {}),
        ...(body.languages ? { languages: body.languages } : {}),
        ...(body.linkUrl !== undefined ? { linkUrl: body.linkUrl } : {}),
        ...(body.startsAt ? { startsAt } : {}),
        ...(body.endsAt ? { endsAt } : {}),
      },
    });

    return this.shapeAdmin(row, new Date());
  }

  async end(admin: CurrentUserDto, id: string) {
    const endedAt = new Date();
    const result = await this.prisma.announcement.updateMany({
      where: { id, endedAt: null },
      data: { endedAt, endedById: admin.id },
    });

    if (result.count === 0) {
      await this.requireAnnouncement(id);
      throw new ConflictException('announcement_already_ended');
    }

    return { id, endedAt };
  }

  private async requireAnnouncement(id: string) {
    const row = await this.prisma.announcement.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('announcement_not_found');
    return row;
  }

  private assertWindow(startsAt: Date, endsAt: Date | null, endsAtChanged = true) {
    if (!endsAt) return;
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('ends_at_must_be_after_starts_at');
    }
    if (endsAtChanged && endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('ends_at_must_be_in_future');
    }
  }

  private activeWhere(now: Date): Prisma.AnnouncementWhereInput {
    return {
      startsAt: { lte: now },
      endedAt: null,
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    };
  }

  private statusWhere(status: AnnouncementStatus, now: Date): Prisma.AnnouncementWhereInput {
    if (status === 'SCHEDULED') return { startsAt: { gt: now }, endedAt: null };
    if (status === 'ACTIVE') return this.activeWhere(now);
    return { OR: [{ endedAt: { not: null } }, { endsAt: { lte: now } }] };
  }

  private audienceWhere(
    roles: string[],
    region: string | null,
    language: string | null,
  ): Prisma.AnnouncementWhereInput {
    return {
      AND: [
        {
          OR: [
            { audienceRoles: { isEmpty: true } },
            ...(roles.length ? [{ audienceRoles: { hasSome: roles } }] : []),
          ],
        },
        {
          OR: [{ regions: { isEmpty: true } }, ...(region ? [{ regions: { has: region } }] : [])],
        },
        {
          OR: [
            { languages: { isEmpty: true } },
            ...(language ? [{ languages: { has: language } }] : []),
          ],
        },
      ],
    };
  }

  private statusOf(row: Announcement, now: Date): AnnouncementStatus {
    if (row.endedAt || (row.endsAt && row.endsAt.getTime() <= now.getTime())) return 'ENDED';
    if (row.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
    return 'ACTIVE';
  }

  private shapeAdmin(row: Announcement, now: Date) {
    return { ...row, status: this.statusOf(row, now) };
  }

  private pick(translations: Prisma.JsonValue, language: string | null) {
    const map =
      translations && typeof translations === 'object' && !Array.isArray(translations)
        ? (translations as unknown as Record<string, AnnouncementTranslation>)
        : {};
    const chosen = language && map[language] ? language : map.en ? 'en' : Object.keys(map)[0];
    const t = chosen ? map[chosen] : undefined;

    return { language: chosen ?? null, title: t?.title ?? '', body: t?.body ?? '' };
  }
}

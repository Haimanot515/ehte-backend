import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ContentEntry, ContentKind, ContentStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { pageMeta, paging } from '../../common/paging.util';
import {
  AdminContentQueryDto,
  ContentListQueryDto,
  ContentSearchQueryDto,
  CreateContentDto,
  UpdateContentDto,
} from '../dto/content.dto';

const DEFAULT_LANGUAGE = 'en';
const SNIPPET_LENGTH = 160;

@Injectable()
export class ContentService {
  constructor(private readonly prisma: PrismaService) {}

  // SH-68
  async listFaqs(user: CurrentUserDto, q: ContentListQueryDto) {
    const languages = await this.languagesFor(user, q.lang);
    const rows = await this.published(ContentKind.FAQ, languages, q.category);

    return {
      language: languages[0],
      data: this.bestPerSlug(rows, languages).map((r) => this.shapePublic(r, true)),
    };
  }

  // SH-69. The list leaves the body out, a guide can be long.
  async listGuides(user: CurrentUserDto, q: ContentListQueryDto) {
    const languages = await this.languagesFor(user, q.lang);
    const rows = await this.published(ContentKind.SAFETY_GUIDE, languages, q.category);

    return {
      language: languages[0],
      data: this.bestPerSlug(rows, languages).map((r) => this.shapePublic(r, false)),
    };
  }

  // SH-71
  async search(user: CurrentUserDto, q: ContentSearchQueryDto) {
    const languages = await this.languagesFor(user, q.lang);
    const needle = q.q.trim();

    const rows = await this.prisma.contentEntry.findMany({
      where: {
        status: ContentStatus.PUBLISHED,
        deletedAt: null,
        language: { in: languages },
        ...(q.kind ? { kind: q.kind } : {}),
        OR: [
          { title: { contains: needle, mode: 'insensitive' } },
          { body: { contains: needle, mode: 'insensitive' } },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    });

    const data = this.bestPerSlug(rows, languages)
      .slice(0, q.limit ?? 20)
      .map((r) => ({
        kind: r.kind,
        slug: r.slug,
        language: r.language,
        title: r.title,
        category: r.category,
        snippet: this.snippet(r.body, needle),
      }));

    return { query: needle, language: languages[0], data };
  }

  // SH-70
  async getGuide(user: CurrentUserDto, slug: string, q: ContentListQueryDto) {
    const languages = await this.languagesFor(user, q.lang);

    const rows = await this.prisma.contentEntry.findMany({
      where: {
        kind: ContentKind.SAFETY_GUIDE,
        slug,
        status: ContentStatus.PUBLISHED,
        deletedAt: null,
        language: { in: languages },
      },
    });

    const best = this.bestPerSlug(rows, languages)[0];
    if (!best) throw new NotFoundException('guide_not_found');

    return {
      ...this.shapePublic(best, true),
      // Tells the app which other languages exist for this guide
      availableLanguages: await this.languagesOf(ContentKind.SAFETY_GUIDE, slug),
    };
  }

  // SH-72
  async adminList(q: AdminContentQueryDto) {
    const { page, limit, skip } = paging(q);
    const where: Prisma.ContentEntryWhereInput = {
      ...(q.includeDeleted ? {} : { deletedAt: null }),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.language ? { language: q.language } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.q
        ? {
            OR: [
              { title: { contains: q.q, mode: 'insensitive' } },
              { slug: { contains: q.q, mode: 'insensitive' } },
              { body: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.contentEntry.findMany({
        where,
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { slug: 'asc' }, { language: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.contentEntry.count({ where }),
    ]);

    return { data: rows, meta: pageMeta(page, limit, total) };
  }

  // SH-73
  async create(admin: CurrentUserDto, body: CreateContentDto) {
    // The unique key covers soft-deleted rows too, so look at those as well
    const existing = await this.prisma.contentEntry.findUnique({
      where: { kind_slug_language: { kind: body.kind, slug: body.slug, language: body.language } },
      select: { id: true, deletedAt: true },
    });
    if (existing) {
      throw new ConflictException(existing.deletedAt ? 'content_exists_but_was_deleted' : 'content_already_exists');
    }

    try {
      return await this.prisma.contentEntry.create({
        data: {
          kind: body.kind,
          slug: body.slug,
          language: body.language,
          title: body.title,
          body: body.body,
          category: body.category ?? null,
          sortOrder: body.sortOrder ?? 0,
          status: body.status ?? ContentStatus.DRAFT,
          createdById: admin.id,
        },
      });
    } catch (err) {
      // Two admins creating the same entry at the same moment
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('content_already_exists');
      }
      throw err;
    }
  }

  // SH-74
  async update(admin: CurrentUserDto, id: string, body: UpdateContentDto) {
    await this.requireLive(id);

    const data: Prisma.ContentEntryUncheckedUpdateManyInput = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    };
    if (Object.keys(data).length === 0) throw new BadRequestException('nothing_to_update');

    // Guard on deletedAt so an edit cannot revive an entry deleted a moment ago
    const result = await this.prisma.contentEntry.updateMany({
      where: { id, deletedAt: null },
      data: { ...data, updatedById: admin.id },
    });
    if (result.count === 0) throw new NotFoundException('content_not_found');

    return this.requireLive(id);
  }

  // SH-75
  async softDelete(admin: CurrentUserDto, id: string) {
    const deletedAt = new Date();
    const result = await this.prisma.contentEntry.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt, updatedById: admin.id },
    });

    if (result.count === 0) {
      const row = await this.prisma.contentEntry.findUnique({ where: { id }, select: { id: true } });
      if (!row) throw new NotFoundException('content_not_found');
      throw new ConflictException('content_already_deleted');
    }

    return { id, deletedAt };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async requireLive(id: string) {
    const row = await this.prisma.contentEntry.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new NotFoundException('content_not_found');
    return row;
  }

  private published(kind: ContentKind, languages: string[], category?: string) {
    return this.prisma.contentEntry.findMany({
      where: {
        kind,
        status: ContentStatus.PUBLISHED,
        deletedAt: null,
        language: { in: languages },
        ...(category ? { category } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    });
  }

  private async languagesOf(kind: ContentKind, slug: string) {
    const rows = await this.prisma.contentEntry.findMany({
      where: { kind, slug, status: ContentStatus.PUBLISHED, deletedAt: null },
      select: { language: true },
      orderBy: { language: 'asc' },
    });
    return rows.map((r) => r.language);
  }

  /**
   * Languages to try, best first: ?lang=, else the user's saved language, then the base language
   * (pt-BR becomes pt), then English so a reader always gets something.
   */
  private async languagesFor(user: CurrentUserDto | undefined, requested?: string): Promise<string[]> {
    let wanted = requested;

    if (!wanted && user?.id) {
      const profile = await this.prisma.userProfile.findUnique({
        where: { userId: user.id },
        select: { preferredLanguage: true },
      });
      wanted = profile?.preferredLanguage ?? undefined;
    }

    const out: string[] = [];
    const add = (lang?: string | null) => {
      if (lang && !out.includes(lang)) out.push(lang);
    };

    add(wanted);
    add(wanted?.split('-')[0]);
    add(DEFAULT_LANGUAGE);
    return out;
  }

  // One entry per slug, in the best available language. Input order (sortOrder) is kept.
  private bestPerSlug(rows: ContentEntry[], languages: string[]): ContentEntry[] {
    const rank = (lang: string) => {
      const i = languages.indexOf(lang);
      return i === -1 ? languages.length : i;
    };

    const chosen = new Map<string, ContentEntry>();
    for (const row of rows) {
      const key = `${row.kind}:${row.slug}`;
      const current = chosen.get(key);
      if (!current || rank(row.language) < rank(current.language)) chosen.set(key, row);
    }

    const keepOrder = new Map(rows.map((r, i) => [`${r.kind}:${r.slug}`, i]));
    return [...chosen.values()].sort(
      (a, b) => (keepOrder.get(`${a.kind}:${a.slug}`) ?? 0) - (keepOrder.get(`${b.kind}:${b.slug}`) ?? 0),
    );
  }

  private shapePublic(row: ContentEntry, withBody: boolean) {
    return {
      slug: row.slug,
      kind: row.kind,
      language: row.language,
      title: row.title,
      category: row.category,
      updatedAt: row.updatedAt,
      ...(withBody ? { body: row.body } : {}),
    };
  }

  private snippet(body: string, needle: string): string {
    const index = body.toLowerCase().indexOf(needle.toLowerCase());
    if (index === -1) return body.slice(0, SNIPPET_LENGTH).trim();

    const start = Math.max(0, index - 50);
    const text = body.slice(start, start + SNIPPET_LENGTH).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${text}${start + SNIPPET_LENGTH < body.length ? '…' : ''}`;
  }
}

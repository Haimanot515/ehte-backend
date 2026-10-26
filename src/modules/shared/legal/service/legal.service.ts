import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LegalDocument, LegalDocumentStatus, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { pageMeta, paging } from '../../common/paging.util';
import { parseLanguages } from '../../common/shared-record.util';
import {
  AcceptLegalDto,
  CreateLegalDocumentDto,
  LegalAcceptancesQueryDto,
  LegalDocumentsListQueryDto,
  UpdateLegalDraftDto,
} from '../dto/legal.dto';

const DEFAULT_LANGUAGE = 'en';
const EXPORT_ROW_CAP = 10_000;
const PENDING_SAMPLE_SIZE = 100;
// A new version may be dated this far in the past to absorb clock drift between client and server
const EFFECTIVE_PAST_TOLERANCE_MS = 5 * 60_000;

interface CurrentVersion {
  type: string;
  version: string;
  effectiveAt: Date;
  requiresReacceptance: boolean;
  docs: LegalDocument[];
}

@Injectable()
export class LegalService {
  constructor(private readonly prisma: PrismaService) {}

  // SH-37
  async listCurrent(rawLanguage?: string | string[]) {
    const wanted = this.languagePreference(rawLanguage);
    const current = await this.currentVersions();

    return {
      data: [...current.values()].map((c) => {
        const doc = this.pickLanguage(c.docs, wanted);
        return {
          id: doc.id,
          type: c.type,
          language: doc.language,
          version: c.version,
          title: doc.title,
          effectiveAt: c.effectiveAt,
          requiresReacceptance: c.requiresReacceptance,
          availableLanguages: c.docs.map((d) => d.language),
        };
      }),
    };
  }

  // SH-38
  async getCurrent(type: string, rawLanguage?: string | string[]) {
    const current = (await this.currentVersions(type.toUpperCase())).get(type.toUpperCase());
    if (!current) throw new NotFoundException('Document not found');

    const doc = this.pickLanguage(current.docs, this.languagePreference(rawLanguage));
    return {
      id: doc.id,
      type: current.type,
      language: doc.language,
      version: current.version,
      title: doc.title,
      body: doc.body,
      effectiveAt: current.effectiveAt,
      requiresReacceptance: current.requiresReacceptance,
      availableLanguages: current.docs.map((d) => d.language),
    };
  }

  // SH-39
  async accept(user: CurrentUserDto, body: AcceptLegalDto, req: Request) {
    const docs = await this.prisma.legalDocument.findMany({ where: { id: { in: body.documentIds } } });
    if (docs.length !== body.documentIds.length) throw new NotFoundException('One or more documents were not found');

    // Only the version that is current for its type can be accepted
    const current = await this.currentVersions();
    for (const doc of docs) {
      const c = current.get(doc.type);
      if (!c || !c.docs.some((d) => d.id === doc.id)) {
        throw new ConflictException(`${doc.type} ${doc.version} is not the current version. Reload the terms and accept again`);
      }
    }

    const ipAddress = this.clientIp(req);
    const channel = body.channel ?? 'APP';

    const res = await this.prisma.legalAcceptance.createMany({
      data: docs.map((d) => ({
        userId: user.id,
        documentId: d.id,
        documentType: d.type,
        version: d.version,
        channel,
        ipAddress,
      })),
      // Accepting the same document twice is harmless
      skipDuplicates: true,
    });

    return {
      accepted: docs.map((d) => ({ documentId: d.id, type: d.type, version: d.version })),
      newlyRecorded: res.count,
    };
  }

  // SH-40
  async myStatus(user: CurrentUserDto) {
    const [current, mine] = await Promise.all([
      this.currentVersions(),
      this.prisma.legalAcceptance.findMany({
        where: { userId: user.id },
        orderBy: { acceptedAt: 'desc' },
        select: { documentType: true, version: true, acceptedAt: true, document: { select: { effectiveAt: true } } },
      }),
    ]);

    // Latest acceptance per type, judged by the effective date of the accepted version
    const latest = new Map<string, (typeof mine)[number]>();
    for (const a of mine) {
      const best = latest.get(a.documentType);
      if (!best || a.document.effectiveAt > best.document.effectiveAt) latest.set(a.documentType, a);
    }

    const requiredSince = await this.requiredSinceByType();

    const data = [...current.values()].map((c) => {
      const accepted = latest.get(c.type);
      const since = requiredSince.get(c.type);
      const needsAcceptance = !accepted || (!!since && accepted.document.effectiveAt < since);
      return {
        type: c.type,
        currentVersion: c.version,
        acceptedVersion: accepted?.version ?? null,
        acceptedAt: accepted?.acceptedAt ?? null,
        needsAcceptance,
        // One entry per language, so the client can send the one the user read
        documents: c.docs.map((d) => ({ id: d.id, language: d.language })),
      };
    });

    return { needsAcceptance: data.some((d) => d.needsAcceptance), documents: data };
  }

  // SH-42
  async adminList(q: LegalDocumentsListQueryDto) {
    const { page, limit, skip } = paging(q);
    const where: Prisma.LegalDocumentWhereInput = {
      ...(q.type ? { type: q.type } : {}),
      ...(q.language ? { language: q.language } : {}),
      ...(q.status ? { status: q.status } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.legalDocument.findMany({
        where,
        orderBy: [{ type: 'asc' }, { effectiveAt: 'desc' }, { language: 'asc' }],
        skip,
        take: limit,
        select: {
          id: true,
          type: true,
          language: true,
          version: true,
          title: true,
          status: true,
          effectiveAt: true,
          requiresReacceptance: true,
          publishedAt: true,
          createdAt: true,
          _count: { select: { acceptances: true } },
        },
      }),
      this.prisma.legalDocument.count({ where }),
    ]);

    return {
      data: rows.map(({ _count, ...r }) => ({ ...r, acceptanceCount: _count.acceptances })),
      meta: pageMeta(page, limit, total),
    };
  }

  // SH-41
  async publish(admin: CurrentUserDto, body: CreateLegalDocumentDto) {
    const effectiveAt = new Date(body.effectiveAt);
    if (!body.saveAsDraft && effectiveAt.getTime() < Date.now() - EFFECTIVE_PAST_TOLERANCE_MS) {
      throw new BadRequestException('effectiveAt cannot be in the past for a published version');
    }

    const now = new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const doc = await tx.legalDocument.create({
          data: {
            type: body.type,
            language: body.language,
            version: body.version,
            title: body.title,
            body: body.body,
            effectiveAt,
            requiresReacceptance: body.requiresReacceptance ?? false,
            createdById: admin.id,
            ...(body.saveAsDraft
              ? { status: LegalDocumentStatus.DRAFT }
              : { status: LegalDocumentStatus.PUBLISHED, publishedById: admin.id, publishedAt: now }),
          },
        });
        if (!body.saveAsDraft) await this.retireOlder(tx, doc);
        return this.shapeAdmin(doc);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`${body.type} ${body.language} version ${body.version} already exists`);
      }
      throw err;
    }
  }

  // SH-44
  async editDraft(admin: CurrentUserDto, id: string, body: UpdateLegalDraftDto) {
    const doc = await this.prisma.legalDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.status !== LegalDocumentStatus.DRAFT) {
      throw new ConflictException('Only a draft can be edited. Publish a new version instead');
    }

    const effectiveAt = body.effectiveAt ? new Date(body.effectiveAt) : doc.effectiveAt;
    if (body.publish && effectiveAt.getTime() < Date.now() - EFFECTIVE_PAST_TOLERANCE_MS) {
      throw new BadRequestException('Set effectiveAt to now or later before publishing');
    }

    const data: Prisma.LegalDocumentUpdateManyMutationInput = {
      ...(body.version !== undefined ? { version: body.version } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.effectiveAt !== undefined ? { effectiveAt } : {}),
      ...(body.requiresReacceptance !== undefined ? { requiresReacceptance: body.requiresReacceptance } : {}),
      ...(body.publish ? { status: LegalDocumentStatus.PUBLISHED, publishedAt: new Date() } : {}),
    };

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Guard on DRAFT so a publish and an edit at the same moment cannot both win
        const res = await tx.legalDocument.updateMany({
          where: { id, status: LegalDocumentStatus.DRAFT },
          data: { ...data, ...(body.publish ? { publishedById: admin.id } : {}) },
        });
        if (res.count === 0) throw new ConflictException('This draft was just published or changed');

        const fresh = await tx.legalDocument.findUniqueOrThrow({ where: { id } });
        if (body.publish) await this.retireOlder(tx, fresh);
        return this.shapeAdmin(fresh);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Another version with that number already exists for this document and language');
      }
      throw err;
    }
  }

  // SH-43
  async acceptances(_admin: CurrentUserDto, q: LegalAcceptancesQueryDto) {
    const acceptedAt: Prisma.DateTimeFilter = {};
    if (q.from) acceptedAt.gte = new Date(q.from);
    if (q.to) acceptedAt.lte = new Date(q.to);

    const where: Prisma.LegalAcceptanceWhereInput = {
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.documentId ? { documentId: q.documentId } : {}),
      ...(q.type ? { documentType: q.type } : {}),
      ...(q.version ? { version: q.version } : {}),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(acceptedAt.gte || acceptedAt.lte ? { acceptedAt } : {}),
    };

    const select = {
      id: true,
      userId: true,
      documentId: true,
      documentType: true,
      version: true,
      channel: true,
      ipAddress: true,
      acceptedAt: true,
      document: { select: { language: true } },
      user: { select: { name: true, phone: true } },
    } satisfies Prisma.LegalAcceptanceSelect;

    const shape = (r: Prisma.LegalAcceptanceGetPayload<{ select: typeof select }>) => ({
      id: r.id,
      userId: r.userId,
      userName: r.user.name,
      // Phone is masked: staff can tell accounts apart without reading full numbers
      userPhone: this.maskPhone(r.user.phone),
      documentId: r.documentId,
      type: r.documentType,
      version: r.version,
      language: r.document.language,
      channel: r.channel,
      ipAddress: r.ipAddress,
      acceptedAt: r.acceptedAt,
    });

    if (q.format === 'csv') {
      const rows = await this.prisma.legalAcceptance.findMany({
        where,
        select,
        orderBy: { acceptedAt: 'desc' },
        take: EXPORT_ROW_CAP,
      });
      const header = ['acceptedAt', 'userId', 'userName', 'userPhone', 'type', 'version', 'language', 'channel', 'ipAddress'];
      const lines = rows.map(shape).map((r) =>
        [r.acceptedAt.toISOString(), r.userId, r.userName, r.userPhone, r.type, r.version, r.language, r.channel, r.ipAddress]
          .map((v) => this.csvCell(v))
          .join(','),
      );
      return {
        fileName: `legal-acceptances-${new Date().toISOString().slice(0, 10)}.csv`,
        rowCount: rows.length,
        truncated: rows.length === EXPORT_ROW_CAP,
        csv: [header.join(','), ...lines].join('\n'),
      };
    }

    const { page, limit, skip } = paging(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.legalAcceptance.findMany({ where, select, orderBy: { acceptedAt: 'desc' }, skip, take: limit }),
      this.prisma.legalAcceptance.count({ where }),
    ]);

    return { data: rows.map(shape), meta: pageMeta(page, limit, total) };
  }

  // SH-45
  async pendingAcceptance() {
    const current = await this.currentVersions();
    const requiredSince = await this.requiredSinceByType();
    const activeUsers: Prisma.UserWhereInput = { isActive: true, deletedAt: null };
    const totalActiveUsers = await this.prisma.user.count({ where: activeUsers });

    const data: Array<{
      type: string;
      version: string;
      totalActiveUsers: number;
      pending: number;
      accepted: number;
      sample: Array<{ id: string; name: string | null }>;
    }> = [];
    for (const c of current.values()) {
      const since = requiredSince.get(c.type);
      // A user is pending if they never accepted this type, or only accepted a version older than the
      // latest one that demands re-acceptance
      const hasAccepted: Prisma.UserWhereInput = {
        legalAcceptances: {
          some: {
            documentType: c.type,
            ...(since ? { document: { effectiveAt: { gte: since } } } : {}),
          },
        },
      };
      const where: Prisma.UserWhereInput = { ...activeUsers, NOT: hasAccepted };

      const [pending, sample] = await Promise.all([
        this.prisma.user.count({ where }),
        this.prisma.user.findMany({
          where,
          select: { id: true, name: true },
          orderBy: { createdAt: 'asc' },
          take: PENDING_SAMPLE_SIZE,
        }),
      ]);

      data.push({
        type: c.type,
        version: c.version,
        totalActiveUsers,
        pending,
        accepted: totalActiveUsers - pending,
        sample,
      });
    }

    return { data };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  // The current version of each type is the PUBLISHED one with the latest effective date that has
  // already started. All languages of that version are returned together.
  private async currentVersions(type?: string): Promise<Map<string, CurrentVersion>> {
    const docs = await this.prisma.legalDocument.findMany({
      where: {
        status: LegalDocumentStatus.PUBLISHED,
        effectiveAt: { lte: new Date() },
        ...(type ? { type } : {}),
      },
      orderBy: [{ effectiveAt: 'desc' }, { publishedAt: 'desc' }],
    });

    const out = new Map<string, CurrentVersion>();
    for (const doc of docs) {
      const existing = out.get(doc.type);
      if (!existing) {
        out.set(doc.type, {
          type: doc.type,
          version: doc.version,
          effectiveAt: doc.effectiveAt,
          requiresReacceptance: doc.requiresReacceptance,
          docs: [doc],
        });
      } else if (existing.version === doc.version) {
        existing.docs.push(doc);
        existing.requiresReacceptance = existing.requiresReacceptance || doc.requiresReacceptance;
      }
    }
    return out;
  }

  // Per type, the latest effective date among started versions that require re-acceptance
  private async requiredSinceByType(): Promise<Map<string, Date>> {
    const rows = await this.prisma.legalDocument.groupBy({
      by: ['type'],
      where: {
        status: LegalDocumentStatus.PUBLISHED,
        requiresReacceptance: true,
        effectiveAt: { lte: new Date() },
      },
      _max: { effectiveAt: true },
    });
    return new Map(rows.filter((r) => r._max.effectiveAt).map((r) => [r.type, r._max.effectiveAt as Date]));
  }

  private languagePreference(raw?: string | string[]) {
    const list = parseLanguages(raw);
    return list.includes(DEFAULT_LANGUAGE) ? list : [...list, DEFAULT_LANGUAGE];
  }

  // First language the caller asked for that exists, then English, then whatever is available
  private pickLanguage(docs: LegalDocument[], wanted: string[]): LegalDocument {
    for (const lang of wanted) {
      const exact = docs.find((d) => d.language.toLowerCase() === lang);
      if (exact) return exact;
      const base = docs.find((d) => d.language.toLowerCase().split('-')[0] === lang.split('-')[0]);
      if (base) return base;
    }
    return docs[0];
  }

  // Once a version is live, older published versions of the same type and language are retired.
  // A version dated in the future leaves the old one live until its start date.
  private async retireOlder(tx: Prisma.TransactionClient, doc: LegalDocument) {
    if (doc.effectiveAt.getTime() > Date.now()) return;
    await tx.legalDocument.updateMany({
      where: {
        type: doc.type,
        language: doc.language,
        status: LegalDocumentStatus.PUBLISHED,
        id: { not: doc.id },
        effectiveAt: { lte: doc.effectiveAt },
      },
      data: { status: LegalDocumentStatus.RETIRED },
    });
  }

  private shapeAdmin(doc: LegalDocument) {
    return {
      id: doc.id,
      type: doc.type,
      language: doc.language,
      version: doc.version,
      title: doc.title,
      body: doc.body,
      status: doc.status,
      effectiveAt: doc.effectiveAt,
      requiresReacceptance: doc.requiresReacceptance,
      publishedAt: doc.publishedAt,
      createdAt: doc.createdAt,
    };
  }

  private clientIp(req: Request): string | null {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    return first || req.ip || null;
  }

  private maskPhone(phone: string | null) {
    if (!phone) return null;
    return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
  }

  // Quotes a value and neutralises spreadsheet formulas (=, +, -, @ at the start)
  private csvCell(value: string | null | undefined) {
    const text = value ?? '';
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  }
}

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditOutcome, AuditSeverity, MissingPersonRedactionStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { PaginationQueryDto, RedactMissingPersonMediaDto } from '../dto/missing-person.dto';
import { MEDIA_FIELD_NAMES } from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonMediaAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

  async getMediaDownloadUrl(
    admin: CurrentUserDto,
    id: string,
    key: string,
  ): Promise<{ url: string }> {
    const missingPerson = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    const owned = this.missingPersonCommonService.collectMediaFields(missingPerson).includes(key);
    if (!owned) {
      this.missingPersonCommonService.emitCaseFailure(
        admin,
        AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED,
        missingPerson,
        'media_not_found_on_missing_person',
        {
          outcome: AuditOutcome.DENIED,
          ...this.missingPersonCommonService.targetUserFor(admin, missingPerson),
          metadata: { requestedKey: key },
        },
      );
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);

    this.missingPersonCommonService.emitAudit({
      userId: admin.id,
      ...this.missingPersonCommonService.targetUserFor(admin, missingPerson),
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED,
      entity: 'MissingPerson',
      entityId: id,
      entityLabel: this.missingPersonCommonService.caseLabel(missingPerson),
      diff: { result: 'success' },
      metadata: { key },
    });

    return { url };
  }

  async listAttachments(id: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);

    const redactions = await this.prisma.missingPersonRedaction.findMany({
      where: { missingPersonId: id },
      orderBy: { createdAt: 'desc' },
      select: { mediaKey: true, status: true, mode: true, createdAt: true },
    });
    const latestRedaction = new Map<string, (typeof redactions)[number]>();
    for (const r of redactions)
      if (!latestRedaction.has(r.mediaKey)) latestRedaction.set(r.mediaKey, r);

    const entries = MEDIA_FIELD_NAMES.flatMap((field) =>
      existing[field].map((key) => ({ field, key })),
    );

    const data = await Promise.all(
      entries.map(async ({ field, key }) => {
        let size: number | null = null;
        let contentType: string | null = null;
        let hash: string | null = null;
        try {
          const stat = await this.minioService.statObject(key);
          size = stat.size;
          contentType = stat.contentType;
          hash = (stat as unknown as { etag?: string }).etag ?? null;
        } catch {
          // The object is missing in storage, report it with empty metadata.
        }
        const redaction = latestRedaction.get(key);
        return {
          field,
          key,
          size,
          contentType,
          hash,
          missingInStorage: size === null,
          redactionStatus: redaction?.status ?? null,
          redactionMode: redaction?.mode ?? null,
        };
      }),
    );

    return { missingPersonId: id, mediaTotalBytes: existing.mediaTotalBytes, data };
  }

  // Records the request. Pixel processing needs image tooling, so a worker completes PENDING rows.
  async redactMedia(
    admin: CurrentUserDto,
    id: string,
    key: string,
    data: RedactMissingPersonMediaDto,
  ) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    if (existing.legalHold) throw new ConflictException('case_under_legal_hold');
    if (!this.missingPersonCommonService.collectMediaFields(existing).includes(key)) {
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const redaction = await this.prisma.missingPersonRedaction.create({
      data: {
        missingPersonId: id,
        mediaKey: key,
        mode: data.mode,
        reason: data.reason ?? null,
        status: MissingPersonRedactionStatus.PENDING,
        requestedById: admin.id,
      },
    });

    this.missingPersonCommonService.auditOp(
      admin,
      existing,
      'redact_media_requested',
      { mode: data.mode },
      { severity: AuditSeverity.WARNING, reason: data.reason ?? null, metadata: { key } },
    );
    return redaction;
  }

  async getMediaCustody(id: string, key: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    if (!this.missingPersonCommonService.collectMediaFields(existing).includes(key)) {
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const [events, redactions] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          entity: 'MissingPerson',
          entityId: id,
          action: AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED,
          metadata: { path: ['key'], equals: key },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, userId: true, actorType: true, outcome: true, createdAt: true },
      }),
      this.prisma.missingPersonRedaction.findMany({
        where: { missingPersonId: id, mediaKey: key },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const userIds = [...new Set(events.map((e) => e.userId).filter((v): v is string => !!v))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    return {
      key,
      events: events.map((e) => ({
        id: e.id,
        at: e.createdAt,
        outcome: e.outcome,
        actorType: e.actorType,
        userId: e.userId,
        userName: e.userId ? (nameOf.get(e.userId) ?? null) : null,
      })),
      redactions,
    };
  }

  // Everything admins did on this case, plus who has it marked read.
  async getAccessLog(id: string, query: PaginationQueryDto) {
    await this.missingPersonCommonService.loadCase(id);
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const where: Prisma.AuditLogWhereInput = {
      entity: 'MissingPerson',
      entityId: id,
      userId: { not: null },
      actorType: { in: ['ADMIN', 'SUPER_ADMIN'] },
    };

    const [events, total, readers] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          userId: true,
          actorName: true,
          action: true,
          outcome: true,
          createdAt: true,
          ipAddress: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
      this.prisma.missingPersonReadState.findMany({
        where: { missingPersonId: id },
        include: { admin: { select: { id: true, name: true } } },
        orderBy: { readAt: 'desc' },
      }),
    ]);

    return {
      readers: readers.map((r) => ({
        adminId: r.adminId,
        adminName: r.admin.name,
        readAt: r.readAt,
      })),
      data: events,
      meta: this.missingPersonCommonService.pageMeta(page, limit, total),
    };
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditOutcome,
  MissingPerson,
  MissingPersonStatus,
  MissingPersonUpdateAuthorType,
  Prisma,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  AdminRenewMissingPersonDto,
  CreateMissingPersonUpdateDto,
  PaginationQueryDto,
  RenewMissingPersonDto,
} from '../dto/missing-person.dto';
import { MEDIA_FIELD_NAMES } from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonCaseUpdatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

  // Shared by owner and admin renewal. Extends from the later of now and the current expiry.
  private async applyRenewal(
    actor: CurrentUserDto,
    existing: MissingPerson,
    extendDays: number | undefined,
    operation: string,
    reason?: string,
  ) {
    if (existing.status !== MissingPersonStatus.APPROVED || existing.deletedAt) {
      this.missingPersonCommonService.emitCaseFailure(
        actor,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'renewal_requires_approved_case',
        {
          diff: { currentStatus: existing.status },
        },
      );
      throw new BadRequestException('renewal_requires_approved_case');
    }

    const defaultDays = Number(
      this.configService.get<string>('MISSING_PERSON_RENEW_DEFAULT_DAYS') ?? 30,
    );
    const days = extendDays ?? defaultDays;
    const now = new Date();
    const base = existing.expiresAt && existing.expiresAt > now ? existing.expiresAt : now;
    const expiresAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    const updated = await this.prisma.missingPerson.update({
      where: { id: existing.id },
      data: { expiresAt, lastRenewedAt: now, renewalCount: { increment: 1 } },
    });

    this.missingPersonCommonService.auditOp(
      actor,
      updated,
      operation,
      {
        previousExpiresAt: existing.expiresAt,
        expiresAt,
        extendDays: days,
      },
      { reason: reason ?? null },
    );
    return updated;
  }

  async renewByOwner(user: CurrentUserDto, id: string, data: RenewMissingPersonDto) {
    const existing = await this.missingPersonCommonService.loadOwnCase(user, id);
    const updated = await this.applyRenewal(user, existing, data.extendDays, 'owner_renew');
    return this.missingPersonCommonService.toOwnerView(updated);
  }

  async renewByAdmin(admin: CurrentUserDto, id: string, data: AdminRenewMissingPersonDto) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    return this.applyRenewal(admin, existing, data.extendDays, 'admin_renew', data.reason);
  }

  // Shared by owner and staff updates. Public immediately, so the case must be APPROVED.
  private async createCaseUpdate(
    actor: CurrentUserDto,
    existing: MissingPerson,
    data: CreateMissingPersonUpdateDto,
    authorType: MissingPersonUpdateAuthorType,
  ) {
    if (existing.status !== MissingPersonStatus.APPROVED) {
      throw new BadRequestException('updates_require_approved_case');
    }

    const photos = data.photo ?? [];
    if (photos.length) {
      this.missingPersonCommonService.assertAttachmentCounts({
        photo: photos,
        video: [],
        audio: [],
        pdf: [],
        document: [],
        other: [],
      });
      const validated = await this.missingPersonCommonService.validateMediaFilesExist(photos);
      this.missingPersonCommonService.assertTotalBytes(
        validated.reduce((sum, v) => sum + v.size, 0),
      );
    }

    const created = await this.prisma.missingPersonUpdate.create({
      data: {
        missingPersonId: existing.id,
        authorId: actor.id,
        authorType,
        message: data.message,
        photo: photos,
      },
    });

    this.missingPersonCommonService.auditOp(actor, existing, 'case_update_posted', {
      authorType,
      updateId: created.id,
    });
    return { ...created, photos: await this.missingPersonCommonService.presignKeys(created.photo) };
  }

  async addOwnerUpdate(user: CurrentUserDto, id: string, data: CreateMissingPersonUpdateDto) {
    const existing = await this.missingPersonCommonService.loadOwnCase(user, id);
    return this.createCaseUpdate(user, existing, data, MissingPersonUpdateAuthorType.OWNER);
  }

  async addStaffUpdate(admin: CurrentUserDto, id: string, data: CreateMissingPersonUpdateDto) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    return this.createCaseUpdate(admin, existing, data, MissingPersonUpdateAuthorType.STAFF);
  }

  async listOwnerUpdates(user: CurrentUserDto, id: string, query: PaginationQueryDto) {
    await this.missingPersonCommonService.loadOwnCase(user, id);
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const where = { missingPersonId: id, authorId: user.id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPersonUpdate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.missingPersonUpdate.count({ where }),
    ]);

    const data = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        photos: await this.missingPersonCommonService.presignKeys(row.photo),
      })),
    );
    return { data, meta: this.missingPersonCommonService.pageMeta(page, limit, total) };
  }

  async listPublicUpdates(id: string, query: PaginationQueryDto) {
    await this.missingPersonCommonService.loadApprovedPublic(id);
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const where = { missingPersonId: id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPersonUpdate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { id: true, authorType: true, message: true, photo: true, createdAt: true },
      }),
      this.prisma.missingPersonUpdate.count({ where }),
    ]);

    const data = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        authorType: row.authorType,
        message: row.message,
        createdAt: row.createdAt,
        photos: await this.missingPersonCommonService.presignKeys(row.photo),
      })),
    );
    return { data, meta: this.missingPersonCommonService.pageMeta(page, limit, total) };
  }

  // Shared by owner and admin media removal. Legal hold blocks it for everyone.
  private async removeMediaKey(
    actor: CurrentUserDto,
    existing: MissingPerson,
    key: string,
    operation: string,
  ) {
    if (existing.legalHold) {
      this.missingPersonCommonService.emitCaseFailure(
        actor,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'case_under_legal_hold',
        {
          outcome: AuditOutcome.DENIED,
        },
      );
      throw new ConflictException('case_under_legal_hold');
    }

    const field = MEDIA_FIELD_NAMES.find((f) => existing[f].includes(key));
    if (!field) throw new NotFoundException('media_not_found_on_missing_person');

    let removedBytes = 0;
    try {
      removedBytes = (await this.minioService.statObject(key)).size;
    } catch {
      removedBytes = 0;
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id: existing.id },
      data: {
        ...({
          [field]: existing[field].filter((k) => k !== key),
        } as Prisma.MissingPersonUpdateInput),
        mediaTotalBytes: Math.max(0, existing.mediaTotalBytes - removedBytes),
      },
    });

    await this.missingPersonCommonService.deleteMediaFiles([key]);

    if (existing.status === MissingPersonStatus.APPROVED) {
      await this.cache.invalidateMissingPersonEverywhere(existing.id);
    }

    this.missingPersonCommonService.auditOp(
      actor,
      updated,
      operation,
      { field },
      { metadata: { key, removedBytes } },
    );
    return updated;
  }

  async removeOwnerMedia(user: CurrentUserDto, id: string, key: string) {
    const existing = await this.missingPersonCommonService.loadOwnCase(user, id);
    const updated = await this.removeMediaKey(user, existing, key, 'owner_remove_media');
    return this.missingPersonCommonService.toOwnerView(updated);
  }

  async removeMediaByAdmin(admin: CurrentUserDto, id: string, key: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    this.missingPersonCommonService.assertNotClaimedByOther(
      admin,
      existing,
      AuditEventEnum.MISSING_PERSON_UPDATED,
    );
    return this.removeMediaKey(admin, existing, key, 'admin_remove_media');
  }
}

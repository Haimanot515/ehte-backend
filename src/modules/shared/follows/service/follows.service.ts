import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MissingPersonStatus, MissingPersonType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { FollowableEntity } from 'src/common/enums/shared/followable-entity.enum';
import { pageMeta, paging } from '../../common/paging.util';
import { CreateFollowDto, FollowListQueryDto, UpdateFollowSettingsDto } from '../dto/follows.dto';

@Injectable()
export class FollowsService {
  constructor(private readonly prisma: PrismaService) {}

  async follow(user: CurrentUserDto, body: CreateFollowDto) {
    await this.assertFollowable(user, body.entity, body.entityId);

    const row = await this.prisma.follow.upsert({
      where: this.key(user.id, body.entity, body.entityId),
      create: {
        userId: user.id,
        entity: body.entity,
        entityId: body.entityId,
        updateKinds: body.updateKinds ?? [],
        channels: body.channels ?? [],
      },
      update: {
        ...(body.updateKinds ? { updateKinds: body.updateKinds } : {}),
        ...(body.channels ? { channels: body.channels } : {}),
      },
    });

    return this.shape(row.entity, row.entityId, row);
  }

  async list(user: CurrentUserDto, q: FollowListQueryDto) {
    const { page, limit, skip } = paging(q);
    const where: Prisma.FollowWhereInput = {
      userId: user.id,
      ...(q.entity ? { entity: q.entity } : {}),
    };

    const [rows, total, me] = await this.prisma.$transaction([
      this.prisma.follow.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.follow.count({ where }),
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: { discreetModeEnabled: true },
      }),
    ]);

    const discreet = me?.discreetModeEnabled ?? false;
    const missingIds = rows.filter((r) => r.entity === FollowableEntity.MISSING_PERSON).map((r) => r.entityId);
    const profileIds = rows.filter((r) => r.entity === FollowableEntity.VICTIM_PROFILE).map((r) => r.entityId);

    const [missing, profiles] = await Promise.all([
      this.prisma.missingPerson.findMany({
        where: { id: { in: missingIds } },
        select: { id: true, name: true, status: true, personType: true },
      }),
      this.prisma.victimProfile.findMany({
        where: { id: { in: profileIds } },
        select: { id: true, name: true, status: true, involvesChild: true },
      }),
    ]);

    const missingById = new Map(missing.map((m) => [m.id, m]));
    const profileById = new Map(profiles.map((p) => [p.id, p]));

    const data = rows.map((r) => {
      const target =
        r.entity === FollowableEntity.MISSING_PERSON
          ? missingById.get(r.entityId)
          : profileById.get(r.entityId);
      const isChild =
        r.entity === FollowableEntity.MISSING_PERSON
          ? (target as { personType?: MissingPersonType } | undefined)?.personType === MissingPersonType.CHILD
          : (target as { involvesChild?: boolean } | undefined)?.involvesChild === true;

      return {
        ...this.shape(r.entity, r.entityId, r),
        available: !!target,
        targetStatus: target?.status ?? null,
        label: target && !discreet && !isChild ? (target.name ?? null) : null,
      };
    });

    return { data, meta: pageMeta(page, limit, total) };
  }

  async unfollow(user: CurrentUserDto, entity: FollowableEntity, entityId: string) {
    const ops: Prisma.PrismaPromise<Prisma.BatchPayload>[] = [
      this.prisma.follow.deleteMany({ where: { userId: user.id, entity, entityId } }),
    ];

    if (entity === FollowableEntity.VICTIM_PROFILE) {
      ops.push(
        this.prisma.victimProfileFollow.deleteMany({ where: { profileId: entityId, userId: user.id } }),
      );
    }

    await this.prisma.$transaction(ops);

    return { entity, entityId, following: false };
  }

  async status(user: CurrentUserDto, entity: FollowableEntity, entityId: string) {
    const row = await this.prisma.follow.findUnique({ where: this.key(user.id, entity, entityId) });
    if (row) return this.shape(entity, entityId, row);

    if (entity === FollowableEntity.VICTIM_PROFILE) {
      const legacy = await this.prisma.victimProfileFollow.findUnique({
        where: { profileId_userId: { profileId: entityId, userId: user.id } },
      });
      if (legacy) {
        return this.shape(entity, entityId, { updateKinds: [], channels: [], createdAt: legacy.createdAt });
      }
    }

    return this.shape(entity, entityId, null);
  }

  async updateSettings(
    user: CurrentUserDto,
    entity: FollowableEntity,
    entityId: string,
    body: UpdateFollowSettingsDto,
  ) {
    if (body.updateKinds === undefined && body.channels === undefined) {
      throw new BadRequestException('no_settings_provided');
    }

    const current = await this.status(user, entity, entityId);
    if (!current.following) throw new NotFoundException('not_following');

    const row = await this.prisma.follow.upsert({
      where: this.key(user.id, entity, entityId),
      create: {
        userId: user.id,
        entity,
        entityId,
        updateKinds: body.updateKinds ?? [],
        channels: body.channels ?? [],
      },
      update: {
        ...(body.updateKinds !== undefined ? { updateKinds: body.updateKinds } : {}),
        ...(body.channels !== undefined ? { channels: body.channels } : {}),
      },
    });

    return this.shape(entity, entityId, row);
  }

  async count(entity: FollowableEntity, entityId: string) {
    const [direct, legacy] = await Promise.all([
      this.prisma.follow.count({ where: { entity, entityId } }),
      entity === FollowableEntity.VICTIM_PROFILE
        ? this.prisma.victimProfileFollow.count({
            where: { profileId: entityId, user: { follows: { none: { entity, entityId } } } },
          })
        : Promise.resolve(0),
    ]);

    return { entity, entityId, count: direct + legacy };
  }

  // Fan-out callers must drop names from the message text whenever discreet is true.
  async listFollowersForNotification(entity: FollowableEntity, entityId: string, kind: string) {
    const rows = await this.prisma.follow.findMany({
      where: {
        entity,
        entityId,
        user: { isActive: true },
        OR: [{ updateKinds: { isEmpty: true } }, { updateKinds: { has: kind } }],
      },
      select: { userId: true, channels: true, user: { select: { discreetModeEnabled: true } } },
    });

    return rows.map((r) => ({
      userId: r.userId,
      channels: r.channels,
      discreet: r.user.discreetModeEnabled,
    }));
  }

  private key(userId: string, entity: FollowableEntity, entityId: string) {
    return { userId_entity_entityId: { userId, entity, entityId } };
  }

  private shape(
    entity: FollowableEntity,
    entityId: string,
    row: { updateKinds: string[]; channels: string[]; createdAt: Date } | null,
  ) {
    return {
      entity,
      entityId,
      following: !!row,
      updateKinds: row?.updateKinds ?? [],
      channels: row?.channels ?? [],
      followedAt: row?.createdAt ?? null,
    };
  }

  private async assertFollowable(user: CurrentUserDto, entity: FollowableEntity, entityId: string) {
    if (entity === FollowableEntity.MISSING_PERSON) {
      const found = await this.prisma.missingPerson.findFirst({
        where: { id: entityId, OR: [{ status: MissingPersonStatus.APPROVED }, { userId: user.id }] },
        select: { id: true },
      });
      if (!found) throw new NotFoundException('follow_target_not_found');
      return;
    }

    const found = await this.prisma.victimProfile.findFirst({
      where: { id: entityId, OR: [{ isPublished: true }, { createdByUserId: user.id }] },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('follow_target_not_found');
  }
}

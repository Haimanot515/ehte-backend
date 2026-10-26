import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, VictimProfile, VictimProfileStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  FindPublicVictimProfilesQueryDto,
  PagedQueryDto,
  PublicSearchQueryDto,
} from '../dto/victim-profile.dto';
import { money, PUBLIC_PROFILE_SELECT } from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfilePublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  private getPubliclyVisibleMediaKeys(
    profile: Pick<VictimProfile, 'photo' | 'involvesChild'>,
  ): string[] {
    return profile.involvesChild ? [] : profile.photo;
  }

  async getPublicMediaDownloadUrl(id: string, key: string): Promise<{ url: string }> {
    const profile = await this.prisma.victimProfile.findFirst({
      where: {
        id,
        status: VictimProfileStatus.PUBLISHED,
        isPublished: true,
        isVerified: true,
        isSafetyReviewed: true,
        hasConsent: true,
        isPrivacyReviewed: true,
        isAdminApproved: true,
      },
      select: {
        photo: true,
        involvesChild: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const allowedKeys = this.getPubliclyVisibleMediaKeys(profile);
    if (!allowedKeys.includes(key)) {
      throw new NotFoundException('media_not_found_on_profile');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  async findPublic(query: FindPublicVictimProfilesQueryDto) {
    return this.cache.wrapVictimProfileList(query as unknown as Record<string, unknown>, () =>
      this.findPublicUncached(query),
    );
  }

  private async findPublicUncached(query: FindPublicVictimProfilesQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;

    const where = {
      status: VictimProfileStatus.PUBLISHED,

      isPublished: true,

      isVerified: true,
      isSafetyReviewed: true,
      hasConsent: true,
      isPrivacyReviewed: true,
      isAdminApproved: true,

      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { story: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,

        select: {
          id: true,
          name: true,
          story: true,

          supportGoal: true,

          photo: true,
          involvesChild: true,

          totalRaised: true,

          createdAt: true,
        },

        orderBy: { createdAt: 'desc' },

        skip: (page - 1) * limit,
        take: limit,
      }),

      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: profiles.map((profile) =>
        this.victimProfileCommonService.serializePublicProfile(profile),
      ),

      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOnePublic(id: string) {
    const cached =
      await this.cache.getVictimProfile<
        ReturnType<typeof this.victimProfileCommonService.serializePublicProfile>
      >(id);
    if (cached !== null) return cached;

    const profile = await this.prisma.victimProfile.findFirst({
      where: {
        id,

        status: VictimProfileStatus.PUBLISHED,
        isPublished: true,

        isVerified: true,
        isSafetyReviewed: true,
        hasConsent: true,
        isPrivacyReviewed: true,
        isAdminApproved: true,
      },

      select: {
        id: true,
        name: true,
        story: true,

        supportGoal: true,

        photo: true,
        involvesChild: true,

        totalRaised: true,

        createdAt: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const serialized = this.victimProfileCommonService.serializePublicProfile(profile);
    await this.cache.setVictimProfile(id, serialized);
    return serialized;
  }

  async getPublicStats() {
    const raised = await this.prisma.victimProfile.aggregate({
      where: {
        status: VictimProfileStatus.PUBLISHED,
        isPublished: true,
      },
      _sum: { totalRaised: true },
    });

    return {
      totalRaisedAllProfiles: money(raised._sum.totalRaised ?? 0),
    };
  }

  // VP-15
  async findPublicUpdates(_user: CurrentUserDto, id: string, query: PagedQueryDto) {
    await this.victimProfileCommonService.assertPublishedProfile(id);
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where: Prisma.VictimProfileUpdateWhereInput = { profileId: id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfileUpdate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { id: true, title: true, body: true, isStaff: true, createdAt: true },
      }),
      this.prisma.victimProfileUpdate.count({ where }),
    ]);

    return { data: rows, meta: this.victimProfileCommonService.metaOf(page, limit, total) };
  }

  // VP-16  (donors of a published profile; only confirmed donations)
  async findPublicSupporters(_user: CurrentUserDto, id: string, query: PagedQueryDto) {
    await this.victimProfileCommonService.assertPublishedProfile(id);
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where: Prisma.PaymentWhereInput = { victimProfileId: id, status: 'PAID' };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        orderBy: { paidAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          isAnonymous: true,
          amount: true,
          paidAt: true,
          createdAt: true,
          payerUser: { select: { name: true } },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    // Anonymity wins: no name and no amount for an anonymous donor. Never fees, references or transfer state.
    return {
      data: rows.map((s) => ({
        id: s.id,
        anonymous: s.isAnonymous,
        name: s.isAnonymous ? null : (s.payerUser?.name ?? null),
        amount: s.isAnonymous ? null : money(s.amount),
        createdAt: s.paidAt ?? s.createdAt,
      })),
      meta: this.victimProfileCommonService.metaOf(page, limit, total),
    };
  }

  // VP-18
  async searchPublic(_user: CurrentUserDto, query: PublicSearchQueryDto) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where: Prisma.VictimProfileWhereInput = {
      ...this.victimProfileCommonService.publicWhere(),
      OR: [
        { name: { contains: query.q, mode: 'insensitive' } },
        { story: { contains: query.q, mode: 'insensitive' } },
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        select: PUBLIC_PROFILE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.victimProfileCommonService.serializePublicProfile(row)),
      meta: this.victimProfileCommonService.metaOf(page, limit, total),
    };
  }

  // VP-19
  async findFeaturedPublic(_user: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where: Prisma.VictimProfileWhereInput = {
      ...this.victimProfileCommonService.publicWhere(),
      isFeatured: true,
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        select: PUBLIC_PROFILE_SELECT,
        orderBy: { featuredAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.victimProfileCommonService.serializePublicProfile(row)),
      meta: this.victimProfileCommonService.metaOf(page, limit, total),
    };
  }

  // VP-20
  async getShareInfo(_user: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.assertPublishedProfile(id);

    const base = (
      this.configService.get<string>('app.publicUrl') ??
      this.configService.get<string>('FRONTEND_URL') ??
      ''
    ).replace(/\/+$/, '');
    const scheme = this.configService.get<string>('APP_DEEP_LINK_SCHEME') ?? 'ehte';

    // Child profiles never put a name in share text.
    const text = profile.involvesChild
      ? 'A child needs our help. Please read their story and support if you can.'
      : `Please read ${profile.name ? `${profile.name}'s` : 'this'} story and support if you can.`;

    return {
      id,
      text,
      url: `${base}/victim-profiles/${id}`,
      deepLink: `${scheme}://victim-profiles/${id}`,
    };
  }

  // VP-21
  async recordView(user: CurrentUserDto, id: string) {
    await this.victimProfileCommonService.assertPublishedProfile(id);

    // One view per user per profile per hour, so refreshes don't inflate the numbers.
    const recent = await this.prisma.victimProfileView.findFirst({
      where: {
        profileId: id,
        userId: user.id,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
      select: { id: true },
    });
    if (recent) return { recorded: false };

    await this.prisma.victimProfileView.create({ data: { profileId: id, userId: user.id } });
    return { recorded: true };
  }

  // VP-22  (POST toggles: there is no separate unfollow route in the controller)
  async followProfile(user: CurrentUserDto, id: string) {
    await this.victimProfileCommonService.assertPublishedProfile(id);

    const key = { profileId_userId: { profileId: id, userId: user.id } };
    const existing = await this.prisma.victimProfileFollow.findUnique({ where: key });

    if (existing) {
      await this.prisma.victimProfileFollow.delete({ where: key });
      return { id, following: false };
    }

    await this.prisma.victimProfileFollow.create({ data: { profileId: id, userId: user.id } });
    return { id, following: true };
  }

  // VP-23
  async getPublicGoal(_user: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.assertPublishedProfile(id);

    const raised = new Prisma.Decimal(profile.totalRaised);
    const goal = profile.supportGoal ? new Prisma.Decimal(profile.supportGoal) : null;
    const percent =
      goal && goal.gt(0) ? Math.min(100, Math.round(raised.div(goal).mul(100).toNumber())) : null;
    const daysLeft = profile.fundingEndsAt
      ? Math.max(0, Math.ceil((profile.fundingEndsAt.getTime() - Date.now()) / 86_400_000))
      : null;

    return {
      id,
      goal: goal ? money(goal) : null,
      raised: money(raised),
      percent,
      daysLeft,
      donationsPaused: profile.donationsPaused,
    };
  }
}
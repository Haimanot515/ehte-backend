import { Injectable, NotFoundException } from '@nestjs/common';
import { SupportStatus, SupportType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { COUNTED_STATUSES, ANONYMOUS_LABEL } from './support.constants';

@Injectable()
export class SupportPublicService {
  constructor(private readonly prisma: PrismaService) {}

  // Public list for a published profile. Only CONFIRMED or COMPLETED supports, respecting the
  // anonymous flag. No notes, contact details, user IDs or allocation data.
  async findForVictimProfile(victimProfileId: string) {
    await this.assertPublishedProfile(victimProfileId);

    const supports = await this.prisma.support.findMany({
      where: { victimProfileId, status: { in: COUNTED_STATUSES } },
      select: {
        id: true,
        type: true,
        status: true,
        categories: true,
        anonymous: true,
        amount: true,
        recipientAmount: true,
        createdAt: true,
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return supports.map((support) => ({
      id: support.id,
      type: support.type,
      status: support.status,
      categories: support.categories,
      // The recipient's share, so the list adds up to total raised.
      amount:
        support.type === SupportType.FINANCIAL
          ? Number(support.recipientAmount ?? support.amount ?? 0)
          : null,
      supporterName: support.anonymous || !support.user?.name ? ANONYMOUS_LABEL : support.user.name,
      createdAt: support.createdAt,
    }));
  }

  // Goods have no money value, so they are counted separately next to total raised.
  async getOfferCounts(victimProfileId: string) {
    await this.assertPublishedProfile(victimProfileId);

    const [received, delivered] = await this.prisma.$transaction([
      this.prisma.support.count({
        where: {
          victimProfileId,
          type: SupportType.NON_FINANCIAL,
          status: { in: COUNTED_STATUSES },
        },
      }),
      this.prisma.support.count({
        where: {
          victimProfileId,
          type: SupportType.NON_FINANCIAL,
          status: SupportStatus.COMPLETED,
        },
      }),
    ]);

    return { offersReceived: received, offersDelivered: delivered };
  }

  private async assertPublishedProfile(victimProfileId: string): Promise<void> {
    const profile = await this.prisma.victimProfile.findFirst({
      where: { id: victimProfileId, status: 'PUBLISHED', isPublished: true },
      select: { id: true },
    });
    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }
  }
}

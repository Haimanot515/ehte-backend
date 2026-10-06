import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import {
  AuditOutcome,
  AuditSeverity,
  Prisma,
  VictimProfileAppealStatus,
  VictimProfileFlagStatus,
  VictimProfileStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import {
  AppealDecision,
  CreateAppealDto,
  DecideAppealDto,
  FindAppealsQueryDto,
  FlagReason,
  FlagResolution,
  FlagVictimProfileDto,
  PagedQueryDto,
  ResolveFlagDto,
} from '../dto/victim-profile.dto';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  // VP-48
  async createAppeal(user: CurrentUserDto, id: string, data: CreateAppealDto) {
    const profile = await this.victimProfileCommonService.getMineOr404(user, id);

    if (profile.status !== VictimProfileStatus.REJECTED) {
      throw new BadRequestException('only_rejected_profiles_can_be_appealed');
    }

    const open = await this.prisma.victimProfileAppeal.findFirst({
      where: { profileId: id, status: VictimProfileAppealStatus.OPEN },
      select: { id: true },
    });
    if (open) throw new ConflictException('appeal_already_open');

    const maxAppeals = Number(this.configService.get<string>('PROFILE_MAX_APPEALS') ?? 2);
    const previous = await this.prisma.victimProfileAppeal.count({ where: { profileId: id } });
    if (previous >= maxAppeals) throw new BadRequestException('appeal_limit_reached');

    const appeal = await this.prisma.victimProfileAppeal.create({
      data: { profileId: id, authorId: user.id, message: data.message },
    });

    this.victimProfileCommonService.auditSuccess(
      user,
      AuditEventEnum.VICTIM_PROFILE_APPEAL_CREATED,
      profile,
      {
        metadata: { appealId: appeal.id, appealNumber: previous + 1 },
      },
    );

    return appeal;
  }

  // VP-17
  async flagProfile(user: CurrentUserDto, id: string, data: FlagVictimProfileDto) {
    const profile = await this.victimProfileCommonService.assertPublishedProfile(id);

    if (profile.createdByUserId === user.id) {
      throw new BadRequestException('cannot_flag_your_own_profile');
    }

    const existing = await this.prisma.victimProfileFlag.findUnique({
      where: { profileId_reporterId: { profileId: id, reporterId: user.id } },
      select: { id: true },
    });
    if (existing) throw new ConflictException('profile_already_flagged_by_you');

    let flag;
    try {
      flag = await this.prisma.victimProfileFlag.create({
        data: { profileId: id, reporterId: user.id, reason: data.reason, details: data.details },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('profile_already_flagged_by_you');
      }
      throw err;
    }

    this.victimProfileCommonService.auditSuccess(
      user,
      AuditEventEnum.VICTIM_PROFILE_FLAGGED,
      { ...profile, createdByUserId: profile.createdByUserId },
      {
        severity:
          data.reason === FlagReason.IDENTIFIES_CHILD
            ? AuditSeverity.CRITICAL
            : AuditSeverity.WARNING,
        diff: { reason: data.reason },
        metadata: { flagId: flag.id },
      },
    );

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_FLAGGED, {
      victimProfileId: id,
      flagId: flag.id,
      reason: data.reason,
    });

    return { id: flag.id, status: flag.status, createdAt: flag.createdAt };
  }

  // VP-43
  async findFlagsForProfile(admin: CurrentUserDto, id: string, query: PagedQueryDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where: Prisma.VictimProfileFlagWhereInput = { profileId: id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfileFlag.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfileFlag.count({ where }),
    ]);

    this.victimProfileCommonService.logAdminView(admin, profile, 'flags');
    return { data: rows, meta: this.victimProfileCommonService.metaOf(page, limit, total) };
  }

  // VP-42
  async resolveFlag(admin: CurrentUserDto, flagId: string, data: ResolveFlagDto) {
    const flag = await this.prisma.victimProfileFlag.findUnique({ where: { id: flagId } });
    if (!flag) throw new NotFoundException('victim_profile_flag_not_found');
    if (flag.status !== VictimProfileFlagStatus.OPEN) {
      throw new ConflictException('victim_profile_flag_already_resolved');
    }

    const profile = await this.victimProfileCommonService.getProfileOr404(flag.profileId);

    // Claim the flag first (open -> resolved) so two admins can't both act on it.
    const status =
      data.resolution === FlagResolution.DISMISS
        ? VictimProfileFlagStatus.DISMISSED
        : VictimProfileFlagStatus.ACTIONED;
    const claimed = await this.prisma.victimProfileFlag.updateMany({
      where: { id: flagId, status: VictimProfileFlagStatus.OPEN },
      data: {
        status,
        resolution: data.resolution,
        resolvedById: admin.id,
        resolvedAt: new Date(),
        note: data.reason,
      },
    });
    if (claimed.count === 0) throw new ConflictException('victim_profile_flag_already_resolved');

    try {
      if (data.resolution === FlagResolution.UNPUBLISH && profile.isPublished) {
        await this.victimProfileCommonService.unpublish(admin, profile.id);
      } else if (data.resolution === FlagResolution.PAUSE_DONATIONS && !profile.donationsPaused) {
        await this.victimProfileCommonService.pauseDonations(admin, profile.id, {
          reason: data.reason,
        });
      }
    } catch (err) {
      // The action failed, so put the flag back in the queue rather than losing it.
      await this.prisma.victimProfileFlag.update({
        where: { id: flagId },
        data: {
          status: VictimProfileFlagStatus.OPEN,
          resolution: null,
          resolvedById: null,
          resolvedAt: null,
          note: null,
        },
      });
      throw err;
    }

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_FLAG_RESOLVED,
      profile,
      {
        reason: data.reason,
        diff: { flagId, resolution: data.resolution, flagReason: flag.reason },
      },
    );

    return this.prisma.victimProfileFlag.findUniqueOrThrow({ where: { id: flagId } });
  }

  // VP-46
  async findAppeals(_admin: CurrentUserDto, query: FindAppealsQueryDto) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where: Prisma.VictimProfileAppealWhereInput = {
      ...(query.status ? { status: query.status as VictimProfileAppealStatus } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfileAppeal.findMany({
        where,
        include: {
          profile: {
            select: { id: true, name: true, involvesChild: true, status: true, reviewNote: true },
          },
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfileAppeal.count({ where }),
    ]);

    return {
      data: rows.map(({ profile, ...appeal }) => ({
        ...appeal,
        profile: {
          id: profile.id,
          label: this.victimProfileCommonService.profileLabel(profile),
          status: profile.status,
          rejectionReason: profile.reviewNote,
        },
      })),
      meta: this.victimProfileCommonService.metaOf(page, limit, total),
    };
  }

  // VP-47
  async decideAppeal(admin: CurrentUserDto, appealId: string, data: DecideAppealDto) {
    const appeal = await this.prisma.victimProfileAppeal.findUnique({ where: { id: appealId } });
    if (!appeal) throw new NotFoundException('victim_profile_appeal_not_found');
    if (appeal.status !== VictimProfileAppealStatus.OPEN) {
      throw new ConflictException('victim_profile_appeal_already_decided');
    }

    const profile = await this.victimProfileCommonService.getProfileOr404(appeal.profileId);

    // Four eyes: whoever rejected it must not also decide the appeal (super admins excepted).
    if (!this.victimProfileCommonService.getRoles(admin).includes(RolesEnum.SUPER_ADMIN)) {
      const rejection = await this.prisma.auditLog.findFirst({
        where: {
          entity: 'VictimProfile',
          entityId: profile.id,
          action: AuditEventEnum.VICTIM_PROFILE_REJECTED,
          outcome: AuditOutcome.SUCCESS,
        },
        orderBy: { createdAt: 'desc' },
        select: { userId: true },
      });
      if (rejection?.userId === admin.id) {
        this.victimProfileCommonService.emitProfileFailure(
          admin,
          AuditEventEnum.VICTIM_PROFILE_APPEAL_DECIDED,
          profile,
          'appeal_requires_a_different_reviewer',
          {
            outcome: AuditOutcome.DENIED,
          },
        );
        throw new ForbiddenException('appeal_requires_a_different_reviewer');
      }
    }

    const overturn = data.decision === AppealDecision.OVERTURN_REJECTION;

    if (overturn) {
      if (profile.status !== VictimProfileStatus.REJECTED) {
        throw new BadRequestException('victim_profile_not_rejected');
      }
      // Reuses the existing admin resubmit(): re-derives the status from the gates, audited as usual.
      await this.victimProfileCommonService.resubmit(admin, profile.id);
    }

    const decided = await this.prisma.victimProfileAppeal.updateMany({
      where: { id: appealId, status: VictimProfileAppealStatus.OPEN },
      data: {
        status: overturn ? VictimProfileAppealStatus.OVERTURNED : VictimProfileAppealStatus.UPHELD,
        decidedById: admin.id,
        decidedAt: new Date(),
        decisionNote: data.reason,
      },
    });
    if (decided.count === 0) throw new ConflictException('victim_profile_appeal_already_decided');

    await this.cache.invalidateVictimProfileEverywhere(profile.id);

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_APPEAL_DECIDED,
      profile,
      {
        reason: data.reason,
        diff: {
          appealId,
          decision: data.decision,
          creatorMessage: data.reason,
        },
      },
    );

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_APPEAL_DECIDED, {
      userId: appeal.authorId,
      victimProfileId: profile.id,
      appealId,
      decision: data.decision,
    });

    return this.prisma.victimProfileAppeal.findUniqueOrThrow({ where: { id: appealId } });
  }
}

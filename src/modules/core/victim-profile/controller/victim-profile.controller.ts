import { MediaUpload } from 'src/common/decorators/media-upload.decorator';
import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { MediaKeyQueryDto } from 'src/modules/media/dto/media-key-query.dto';

import { VictimProfileSubmissionService } from '../service/victim-profile-submission.service';
import { VictimProfileMineService } from '../service/victim-profile-mine.service';
import { VictimProfilePublicService } from '../service/victim-profile-public.service';
import { VictimProfileModerationService } from '../service/victim-profile-moderation.service';

import {
  CreateAppealDto,
  CreateProfileUpdateDto,
  CreateVictimProfileDto,
  FindAllVictimProfilesQueryDto,
  FindPublicVictimProfilesQueryDto,
  FlagVictimProfileDto,
  PagedQueryDto,
  PublicSearchQueryDto,
  UpdateVictimProfileDto,
} from '../dto/victim-profile.dto';

/**
 * USER SIDE of victim profiles: submit a profile, manage the profiles I created ("mine"),
 * and the public pages supporters read. Everything an admin does lives in
 * AdminVictimProfileController (/victim-profiles/admin/...).
 *
 *   POST   /victim-profiles                 user submits a profile (admins use POST /victim-profiles/admin)
 *   /victim-profiles/mine/...               profiles I created (a user, or an admin who created one)
 *   /victim-profiles/public/...             published profiles; the list, stats, detail and media are anonymous
 *
 * Literal routes sit above the ":id" routes in each group so "stats", "search" or "supported" are never read as an id.
 */
@ApiTags('Victim Profiles')
@Controller('victim-profiles')
export class VictimProfileController {
  constructor(
    private readonly victimProfileSubmissionService: VictimProfileSubmissionService,
    private readonly victimProfileMineService: VictimProfileMineService,
    private readonly victimProfilePublicService: VictimProfilePublicService,
    private readonly victimProfileModerationService: VictimProfileModerationService,
  ) {}

  // ── User: submit a profile ──
  @Post()
  @MediaUpload(CreateVictimProfileDto)
  @Roles(RolesEnum.USER)
  @RequirePermissions(PermissionsEnum.PROFILE_CREATE)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'User: submit a victim/survivor support profile for review',
  })
  async create(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: CreateVictimProfileDto,

    @Headers('idempotency-key')
    idempotencyKey?: string,
  ) {
    return this.victimProfileSubmissionService.create(user, data, idempotencyKey);
  }

  // VP-01
  @Get('mine')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: list the profiles I submitted, with status and review note',
  })
  async findMine(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: FindAllVictimProfilesQueryDto,
  ) {
    return this.victimProfileMineService.findMine(user, query);
  }

  // VP-03
  @Get('mine/summary')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: my profile counts by status',
  })
  async getMineSummary(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.victimProfileMineService.getMineSummary(user);
  }

  // VP-12
  @Get('mine/unread-updates/count')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: count of my profiles with an unseen status change or message',
  })
  async countMineUnreadUpdates(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.victimProfileMineService.countMineUnreadUpdates(user);
  }

  // VP-14
  @Patch('mine/seen-all')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: mark all my profile updates as seen',
  })
  async markAllMineSeen(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.victimProfileMineService.markAllMineSeen(user);
  }

  // VP-02
  @Get('mine/:id')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: get one of my profiles with its review note and requested changes',
  })
  async findOneMine(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileMineService.findOneMine(user, id);
  }

  // VP-04
  @Patch('mine/:id')
  @MediaUpload(UpdateVictimProfileDto)
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: edit my profile while pending, rejected or changes requested',
  })
  async updateMine(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: UpdateVictimProfileDto,
  ) {
    return this.victimProfileMineService.updateMine(user, id, data);
  }

  // VP-05
  @Patch('mine/:id/withdraw')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: withdraw my profile before publication',
  })
  async withdrawMine(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileMineService.withdrawMine(user, id);
  }

  // VP-06
  @Patch('mine/:id/resubmit')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: send my corrected profile back for review',
  })
  async resubmitMine(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileMineService.resubmitMine(user, id);
  }

  // VP-07
  @Get('mine/:id/media')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Creator: get a short-lived download URL for my profile's media",
  })
  async getMineMediaDownloadUrl(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Query()
    query: MediaKeyQueryDto,
  ) {
    return this.victimProfileMineService.getMineMediaDownloadUrl(user, id, query);
  }

  // VP-08
  @Delete('mine/:id/media/:key')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: remove one file from my profile',
  })
  async removeMineMedia(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Param('key')
    key: string,
  ) {
    return this.victimProfileMineService.removeMineMedia(user, id, key);
  }

  // VP-09
  @Get('mine/:id/timeline')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: review history for my profile (no internal notes)',
  })
  async getMineTimeline(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileMineService.getMineTimeline(user, id);
  }

  // VP-10
  @Get('mine/:id/funding')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: what my profile raised and what was paid out (no donor identity)',
  })
  async getMineFunding(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileMineService.getMineFunding(user, id);
  }

  // VP-11
  @Post('mine/:id/updates')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: post a progress update for supporters',
  })
  async createMineUpdate(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: CreateProfileUpdateDto,
  ) {
    return this.victimProfileMineService.createMineUpdate(user, id, data);
  }

  // VP-13
  @Patch('mine/:id/seen')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: mark the latest update on my profile as seen',
  })
  async markMineSeen(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileMineService.markMineSeen(user, id);
  }

  // VP-48
  @Post('mine/:id/appeal')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Creator: appeal a rejection',
  })
  async createAppeal(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: CreateAppealDto,
  ) {
    return this.victimProfileModerationService.createAppeal(user, id, data);
  }

  @Get('public')
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get published victim profiles',
  })
  async findPublic(
    @Query()
    query: FindPublicVictimProfilesQueryDto,
  ) {
    return this.victimProfilePublicService.findPublic(query);
  }

  @Get('public/stats')
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get platform-wide total raised across published victim profiles',
  })
  async getPublicStats() {
    return this.victimProfilePublicService.getPublicStats();
  }

  // VP-18
  @Get('public/search')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logged-in: search published profiles',
  })
  async searchPublic(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: PublicSearchQueryDto,
  ) {
    return this.victimProfilePublicService.searchPublic(user, query);
  }

  // VP-19
  @Get('public/featured')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logged-in: featured published profiles',
  })
  async findFeaturedPublic(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: PagedQueryDto,
  ) {
    return this.victimProfilePublicService.findFeaturedPublic(user, query);
  }

  // VP-24
  @Get('public/mine/supported')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logged-in: profiles I have supported',
  })
  async findMySupported(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: PagedQueryDto,
  ) {
    return this.victimProfileMineService.findMySupported(user, query);
  }

  @Get('public/:id')
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get a single published victim profile',
  })
  async findOnePublic(
    @Param('id')
    id: string,
  ) {
    return this.victimProfilePublicService.findOnePublic(id);
  }

  @Get('public/:id/media')
  @AllowAnonymous()
  @ApiOperation({
    summary: "Get a short-lived download URL for a published profile's media",
  })
  async getPublicMedia(
    @Param('id')
    id: string,

    @Query()
    query: MediaKeyQueryDto,
  ) {
    return this.victimProfilePublicService.getPublicMediaDownloadUrl(id, query.key);
  }

  // VP-15
  @Get('public/:id/updates')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logged-in: progress updates for a published profile',
  })
  async findPublicUpdates(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Query()
    query: PagedQueryDto,
  ) {
    return this.victimProfilePublicService.findPublicUpdates(user, id, query);
  }

  // VP-16
  @Get('public/:id/supporters')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logged-in: supporter list that honours anonymity choices',
  })
  async findPublicSupporters(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Query()
    query: PagedQueryDto,
  ) {
    return this.victimProfilePublicService.findPublicSupporters(user, id, query);
  }

  // VP-17
  @Post('public/:id/flag')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logged-in: report a profile as false, abusive or identifying a child',
  })
  async flagProfile(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: FlagVictimProfileDto,
  ) {
    return this.victimProfileModerationService.flagProfile(user, id, data);
  }

  // VP-20
  @Get('public/:id/share')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logged-in: share text and deep link for a published profile',
  })
  async getShareInfo(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfilePublicService.getShareInfo(user, id);
  }

  // VP-21
  @Post('public/:id/view')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logged-in: record a profile view for analytics',
  })
  async recordView(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfilePublicService.recordView(user, id);
  }

  // VP-22
  @Post('public/:id/follow')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logged-in: follow a profile for updates',
  })
  async followProfile(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfilePublicService.followProfile(user, id);
  }

  // VP-23
  @Get('public/:id/goal')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logged-in: goal, raised so far and days left',
  })
  async getPublicGoal(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfilePublicService.getPublicGoal(user, id);
  }
}
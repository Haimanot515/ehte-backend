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

import { VictimProfileCommonService } from '../service/victim-profile-common.service';
import { VictimProfileSubmissionService } from '../service/victim-profile-submission.service';
import { VictimProfileMineService } from '../service/victim-profile-mine.service';
import { VictimProfilePublicService } from '../service/victim-profile-public.service';
import { VictimProfileReviewService } from '../service/victim-profile-review.service';
import { VictimProfileChildSafetyService } from '../service/victim-profile-child-safety.service';
import { VictimProfileFundingService } from '../service/victim-profile-funding.service';
import { VictimProfileAdminOpsService } from '../service/victim-profile-admin-ops.service';
import { VictimProfileModerationService } from '../service/victim-profile-moderation.service';
import { VictimProfileInboxService } from '../service/victim-profile-inbox.service';
import { VictimProfileSearchService } from '../service/victim-profile-search.service';
import { VictimProfileExportService } from '../service/victim-profile-export.service';
import { VictimProfileStatsService } from '../service/victim-profile-stats.service';
import { VictimProfileWorkflowService } from '../service/victim-profile-workflow.service';

import {
  AdminEditVictimProfileDto,
  AdminSearchQueryDto,
  AnonymizeDto,
  AssignReviewerDto,
  BulkAssignDto,
  BulkIdsDto,
  BulkReasonDto,
  BulkRequestChangesDto,
  CompleteProfileDto,
  CreateAppealDto,
  CreateProfileUpdateDto,
  CreateVictimProfileDto,
  DateRangeQueryDto,
  DecideAppealDto,
  ExportQueryDto,
  FindAllVictimProfilesQueryDto,
  FindAppealsQueryDto,
  FindFlagsQueryDto,
  FindPublicVictimProfilesQueryDto,
  FindUnreadVictimProfilesQueryDto,
  FlagVictimProfileDto,
  LegalHoldDto,
  LiftTakedownDto,
  PagedQueryDto,
  PublicSearchQueryDto,
  ReadAllDto,
  ReasonDto,
  RecordConsentDto,
  RedactMediaDto,
  RemoveMediaDto,
  RequestChangesDto,
  ResolveFlagDto,
  RevokeConsentDto,
  StatsQueryDto,
  StatsTimelineQueryDto,
  TakedownDto,
  UpdateBankDetailsDto,
  UpdateChildFlagDto,
  UpdateChildSafetyReviewDto,
  UpdateGoalDto,
  UpdateVictimGateDto,
  UpdateVictimProfileDto,
  VerifyBankDetailsDto,
} from '../dto/victim-profile.dto';

@ApiTags('Victim Profiles')
@Controller('victim-profiles')
export class VictimProfileController {
  constructor(
    private readonly victimProfileCommonService: VictimProfileCommonService,
    private readonly victimProfileSubmissionService: VictimProfileSubmissionService,
    private readonly victimProfileMineService: VictimProfileMineService,
    private readonly victimProfilePublicService: VictimProfilePublicService,
    private readonly victimProfileReviewService: VictimProfileReviewService,
    private readonly victimProfileChildSafetyService: VictimProfileChildSafetyService,
    private readonly victimProfileFundingService: VictimProfileFundingService,
    private readonly victimProfileAdminOpsService: VictimProfileAdminOpsService,
    private readonly victimProfileModerationService: VictimProfileModerationService,
    private readonly victimProfileInboxService: VictimProfileInboxService,
    private readonly victimProfileSearchService: VictimProfileSearchService,
    private readonly victimProfileExportService: VictimProfileExportService,
    private readonly victimProfileStatsService: VictimProfileStatsService,
    private readonly victimProfileWorkflowService: VictimProfileWorkflowService,
  ) {}

  // Open to self-submission by regular users as well as admins.
  @Post()
  @MediaUpload(CreateVictimProfileDto)
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_CREATE)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a victim/survivor support profile (admin or self-submitted by user)',
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

  // ── Creator: my profiles (literals first, then mine/:id) ──

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

  // Kept above public/:id so "stats" isn't matched as :id.
  @Get('public/stats')
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get platform-wide total raised across published victim profiles',
  })
  async getPublicStats() {
    return this.victimProfilePublicService.getPublicStats();
  }

  // ── Logged-in supporters: literals, kept above public/:id ──

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

  // ── Logged-in supporters: public/:id/* ──

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

  @Get(':id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get a victim profile',
  })
  async findOne(
    @Param('id')
    id: string,
  ) {
    return this.victimProfileSubmissionService.findOne(id);
  }

  @Get(':id/supports')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get support/donation summary for a victim profile',
  })
  async getSupportsSummary(
    @Param('id')
    id: string,
  ) {
    return this.victimProfileFundingService.getSupportsSummary(id);
  }

  @Get(':id/media')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Admin: get a short-lived download URL for a profile's media",
  })
  async getMedia(
    @CurrentUser()
    admin: CurrentUserDto,

    @Param('id')
    id: string,

    @Query()
    query: MediaKeyQueryDto,
  ) {
    return this.victimProfileSubmissionService.getMediaDownloadUrl(admin, id, query.key);
  }

  @Patch(':id/claim')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: claim a victim profile for review' })
  async claim(
    @CurrentUser()
    admin: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileReviewService.claim(admin, id);
  }

  @Patch(':id/unclaim')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: release a claimed victim profile' })
  async unclaim(
    @CurrentUser()
    admin: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileReviewService.unclaim(admin, id);
  }

  @Patch(':id')
  @MediaUpload(UpdateVictimProfileDto)
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: update a victim profile',
  })
  async update(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: UpdateVictimProfileDto,
  ) {
    return this.victimProfileSubmissionService.update(user, id, data);
  }

  @Delete(':id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: delete a victim profile',
  })
  async remove(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileSubmissionService.remove(user, id);
  }

  // ── Admin: literal routes, kept above every admin/:id route ──

  // VP-27
  @Patch('admin/bulk/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: mark many profiles read',
  })
  async bulkMarkRead(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: BulkIdsDto,
  ) {
    return this.victimProfileInboxService.bulkMarkRead(user, data);
  }

  // VP-28
  @Patch('admin/bulk/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: mark many profiles unread',
  })
  async bulkMarkUnread(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: BulkIdsDto,
  ) {
    return this.victimProfileInboxService.bulkMarkUnread(user, data);
  }

  // VP-29
  @Patch('admin/read-all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: mark all profiles matching a filter read',
  })
  async markAllRead(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: ReadAllDto,
  ) {
    return this.victimProfileInboxService.markAllRead(user, data);
  }

  // VP-30
  @Get('admin/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: list my unread profiles',
  })
  async findUnread(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: FindUnreadVictimProfilesQueryDto,
  ) {
    return this.victimProfileInboxService.findUnread(user, query);
  }

  // VP-31
  @Get('admin/unread/count')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: unread badge count',
  })
  async countUnread(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.victimProfileInboxService.countUnread(user);
  }

  // VP-32
  @Get('admin/unread/count/by-status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: unread count by status',
  })
  async countUnreadByStatus(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.victimProfileInboxService.countUnreadByStatus(user);
  }

  // VP-33
  @Get('admin/unread/count/by-category')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: unread count by need category',
  })
  async countUnreadByCategory(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.victimProfileInboxService.countUnreadByCategory(user);
  }

  // VP-34
  @Get('admin/counts')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: total, read and unread counts',
  })
  async getReadCounts(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.victimProfileInboxService.getReadCounts(user);
  }

  // VP-40
  @Get('admin/by-creator/repeat-rejections')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: creators with repeated rejections or suspected fraud',
  })
  async findRepeatRejectionCreators(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: PagedQueryDto,
  ) {
    return this.victimProfileInboxService.findRepeatRejectionCreators(user, query);
  }

  // VP-35
  @Get('admin/by-creator')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: one row per creator with total, read and unread',
  })
  async findCreatorsSummary(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: PagedQueryDto,
  ) {
    return this.victimProfileInboxService.findCreatorsSummary(user, query);
  }

  // VP-36
  @Get('admin/by-creator/:creatorId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Admin: one creator's profiles with isRead",
  })
  async findByCreator(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('creatorId')
    creatorId: string,

    @Query()
    query: FindAllVictimProfilesQueryDto,
  ) {
    return this.victimProfileInboxService.findByCreator(user, creatorId, query);
  }

  // VP-37
  @Get('admin/by-creator/:creatorId/summary')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Admin: one creator's totals by status",
  })
  async getCreatorSummary(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('creatorId')
    creatorId: string,
  ) {
    return this.victimProfileInboxService.getCreatorSummary(user, creatorId);
  }

  // VP-38
  @Patch('admin/by-creator/:creatorId/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Admin: mark all of a creator's profiles read",
  })
  async markCreatorRead(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('creatorId')
    creatorId: string,
  ) {
    return this.victimProfileInboxService.markCreatorRead(user, creatorId);
  }

  // VP-39
  @Patch('admin/by-creator/:creatorId/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Admin: mark all of a creator's profiles unread",
  })
  async markCreatorUnread(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('creatorId')
    creatorId: string,
  ) {
    return this.victimProfileInboxService.markCreatorUnread(user, creatorId);
  }

  // VP-41
  @Get('admin/flags')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: reader flag queue',
  })
  async findFlags(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: FindFlagsQueryDto,
  ) {
    return this.victimProfileInboxService.findFlags(user, query);
  }

  // VP-42
  @Patch('admin/flags/:flagId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: resolve a flag (dismiss, unpublish or pause donations)',
  })
  async resolveFlag(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('flagId')
    flagId: string,

    @Body()
    data: ResolveFlagDto,
  ) {
    return this.victimProfileModerationService.resolveFlag(user, flagId, data);
  }

  // VP-46
  @Get('admin/appeals')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: list appeals against rejections',
  })
  async findAppeals(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: FindAppealsQueryDto,
  ) {
    return this.victimProfileModerationService.findAppeals(user, query);
  }

  // VP-47
  @Patch('admin/appeals/:appealId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: decide an appeal',
  })
  async decideAppeal(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('appealId')
    appealId: string,

    @Body()
    data: DecideAppealDto,
  ) {
    return this.victimProfileModerationService.decideAppeal(user, appealId, data);
  }

  // VP-51
  @Patch('admin/bulk/assign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Super admin: assign a reviewer to many profiles',
  })
  async bulkAssign(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: BulkAssignDto,
  ) {
    return this.victimProfileWorkflowService.bulkAssign(user, data);
  }

  // VP-53
  @Patch('admin/bulk/request-changes')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: request changes on many profiles with one message',
  })
  async bulkRequestChanges(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: BulkRequestChangesDto,
  ) {
    return this.victimProfileWorkflowService.bulkRequestChanges(user, data);
  }

  // VP-54
  @Patch('admin/bulk/reject')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: reject many profiles with one reason',
  })
  async bulkReject(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: BulkReasonDto,
  ) {
    return this.victimProfileWorkflowService.bulkReject(user, data);
  }

  // VP-55
  @Patch('admin/bulk/unpublish')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UNPUBLISH)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: unpublish many profiles (for example during an incident)',
  })
  async bulkUnpublish(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: BulkReasonDto,
  ) {
    return this.victimProfileWorkflowService.bulkUnpublish(user, data);
  }

  // VP-66
  @Get('admin/duplicates')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: queue of suspected duplicate profiles',
  })
  async findDuplicates(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: PagedQueryDto,
  ) {
    return this.victimProfileWorkflowService.findDuplicates(user, query);
  }

  // VP-69
  @Get('admin/trash')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Super admin: list soft-deleted profiles',
  })
  async findTrash(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: PagedQueryDto,
  ) {
    return this.victimProfileAdminOpsService.findTrash(user, query);
  }

  // VP-84
  @Get('admin/search')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: full-text search across all profiles',
  })
  async searchForAdmin(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: AdminSearchQueryDto,
  ) {
    return this.victimProfileSearchService.searchForAdmin(user, query);
  }

  // VP-85
  @Get('admin/facets')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: counts for the filter sidebar',
  })
  async getFacets(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileSearchService.getFacets(user, query);
  }

  // VP-86
  @Get('admin/filters/options')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: dropdown values for filters',
  })
  async getFilterOptions(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.victimProfileSearchService.getFilterOptions(user);
  }

  // VP-87
  @Get('admin/export')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: export profiles as CSV (row-capped, audited)',
  })
  async exportCsv(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: ExportQueryDto,
  ) {
    return this.victimProfileExportService.exportCsv(user, query);
  }

  // VP-88
  @Post('admin/export-jobs')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: start a background export',
  })
  async createExportJob(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: ExportQueryDto,
  ) {
    return this.victimProfileExportService.createExportJob(user, data);
  }

  // VP-89
  @Get('admin/export-jobs/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: export job progress',
  })
  async getExportJob(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileExportService.getExportJob(user, id);
  }

  // VP-90
  @Get('admin/export-jobs/:id/download')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: short-lived download link for a finished export (audited)',
  })
  async getExportJobDownload(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileExportService.getExportJobDownload(user, id);
  }

  // VP-91
  @Get('admin/stats/timeline')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: stats, profiles per day, week or month',
  })
  async getStatsTimeline(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsTimelineQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsTimeline(user, query);
  }

  // VP-92
  @Get('admin/stats/by-status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: stats, profiles by status',
  })
  async getStatsByStatus(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsByStatus(user, query);
  }

  // VP-93
  @Get('admin/stats/by-category')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: stats, profiles by need category',
  })
  async getStatsByCategory(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsByCategory(user, query);
  }

  // VP-94
  @Get('admin/stats/review-time')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: stats, time to first review and decision',
  })
  async getStatsReviewTime(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsReviewTime(user, query);
  }

  // VP-95
  @Get('admin/stats/backlog')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: stats, pending profiles over time',
  })
  async getStatsBacklog(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsBacklog(user, query);
  }

  // VP-96
  @Get('admin/stats/aging')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: stats, pending profiles by age bucket',
  })
  async getStatsAging(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsAging(user, query);
  }

  // VP-97
  @Get('admin/stats/approval-rate')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: stats, approved against rejected',
  })
  async getStatsApprovalRate(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsApprovalRate(user, query);
  }

  // VP-98
  @Get('admin/stats/funding')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: stats, raised, fees and paid out over time',
  })
  async getStatsFunding(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsFunding(user, query);
  }

  // VP-99
  @Get('admin/stats/goal-progress')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: stats, profiles by percent of goal reached',
  })
  async getStatsGoalProgress(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsGoalProgress(user, query);
  }

  // VP-100
  @Get('admin/stats/child-involved')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: stats, child-involved profiles and their review path',
  })
  async getStatsChildInvolved(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsChildInvolved(user, query);
  }

  // VP-101
  @Get('admin/stats/by-admin')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Super admin: stats, reviewer workload and speed',
  })
  async getStatsByAdmin(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsByAdmin(user, query);
  }

  // VP-102
  @Get('admin/stats/overview')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: stats, dashboard in one call',
  })
  async getStatsOverview(
    @CurrentUser()
    user: CurrentUserDto,

    @Query()
    query: StatsQueryDto,
  ) {
    return this.victimProfileStatsService.getStatsOverview(user, query);
  }

  @Get('admin/all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: list victim profiles',
  })
  async findAllForAdmin(
    @Query()
    query: FindAllVictimProfilesQueryDto,
  ) {
    return this.victimProfileReviewService.findAllForAdmin(query);
  }

  @Get('admin/stats')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get victim profile counts by status, including total raised',
  })
  async getStats() {
    return this.victimProfileStatsService.getStats();
  }

  @Get('admin/stale')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get unclaimed victim profiles that have been waiting too long',
  })
  async findStalePending() {
    return this.victimProfileReviewService.findStalePending();
  }

  @Get('admin/reconcile-totals')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: diff cached vs. live totalRaised across all profiles (dry run, no writes)',
  })
  async reconcileAllTotalsDryRun(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.victimProfileFundingService.reconcileAllTotals(user, false);
  }

  @Post('admin/reconcile-totals')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: reconcile and auto-correct totalRaised across all profiles',
  })
  async reconcileAllTotalsFix(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.victimProfileFundingService.reconcileAllTotals(user, true);
  }

  @Get('admin/:id/reconcile-total')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: diff cached vs. live totalRaised for one profile (dry run, no writes)',
  })
  async reconcileOneDryRun(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileFundingService.reconcileProfileTotal(user, id, false);
  }

  @Get('admin/:id/history')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get audit history for a victim profile',
  })
  async getHistory(
    @Param('id')
    id: string,
  ) {
    return this.victimProfileReviewService.getHistory(id);
  }

  @Get('admin/:id/gates')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get approval gate status for a victim profile',
  })
  async getGates(
    @Param('id')
    id: string,
  ) {
    return this.victimProfileReviewService.getGates(id);
  }

  @Patch('admin/:id/gates')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: update victim profile approval gates',
  })
  async updateGates(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: UpdateVictimGateDto,
  ) {
    return this.victimProfileReviewService.updateGates(user, id, data);
  }

  @Patch('admin/:id/child-safety-review')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: record child-safety review outcome for a victim profile (requires two admins)',
  })
  async updateChildSafetyReview(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: UpdateChildSafetyReviewDto,
  ) {
    return this.victimProfileChildSafetyService.updateChildSafetyReview(user, id, data);
  }

  @Patch('admin/:id/consent/revoke')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: revoke previously recorded consent for a victim profile',
  })
  async revokeConsent(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: RevokeConsentDto,
  ) {
    return this.victimProfileChildSafetyService.revokeConsent(user, id, data);
  }

  @Patch('admin/:id/bank-details')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: update the off-platform transfer destination on a victim profile',
  })
  async updateBankDetails(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: UpdateBankDetailsDto,
  ) {
    return this.victimProfileFundingService.updateBankDetails(user, id, data);
  }

  @Patch('admin/:id/publish')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_PUBLISH)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: publish approved victim profile',
  })
  async publish(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileReviewService.publish(user, id);
  }

  @Patch('admin/:id/unpublish')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UNPUBLISH)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: unpublish victim profile',
  })
  async unpublish(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileCommonService.unpublish(user, id);
  }

  @Patch('admin/:id/reject')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: reject victim profile',
  })
  async reject(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileCommonService.reject(user, id);
  }

  @Patch('admin/:id/resubmit')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: return a rejected victim profile to the approval pipeline',
  })
  async resubmit(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileCommonService.resubmit(user, id);
  }

  // ── Admin: routes under admin/:id ──

  // VP-25
  @Patch('admin/:id/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: mark a profile read',
  })
  async markRead(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileInboxService.markRead(user, id);
  }

  // VP-26
  @Patch('admin/:id/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: mark a profile unread',
  })
  async markUnread(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileInboxService.markUnread(user, id);
  }

  // VP-43
  @Get('admin/:id/flags')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: flags on one profile',
  })
  async findFlagsForProfile(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Query()
    query: PagedQueryDto,
  ) {
    return this.victimProfileModerationService.findFlagsForProfile(user, id, query);
  }

  // VP-44
  @Post('admin/:id/takedown')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UNPUBLISH)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: emergency takedown (unpublish, pause donations, block republishing)',
  })
  async takedown(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: TakedownDto,
  ) {
    return this.victimProfileWorkflowService.takedown(user, id, data);
  }

  // VP-45
  @Post('admin/:id/lift-takedown')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_PUBLISH)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Super admin: reverse a takedown',
  })
  async liftTakedown(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: LiftTakedownDto,
  ) {
    return this.victimProfileWorkflowService.liftTakedown(user, id, data);
  }

  // VP-49
  @Patch('admin/:id/assign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Super admin: assign a reviewer to a profile',
  })
  async assignReviewer(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: AssignReviewerDto,
  ) {
    return this.victimProfileWorkflowService.assignReviewer(user, id, data);
  }

  // VP-50
  @Patch('admin/:id/unassign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Super admin: remove the reviewer from a profile',
  })
  async unassignReviewer(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileWorkflowService.unassignReviewer(user, id);
  }

  // VP-52
  @Patch('admin/:id/request-changes')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: ask the creator for changes',
  })
  async requestChanges(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: RequestChangesDto,
  ) {
    return this.victimProfileWorkflowService.requestChanges(user, id, data);
  }

  // VP-56
  @Patch('admin/:id/complete')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: mark the need fulfilled and close funding',
  })
  async complete(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: CompleteProfileDto,
  ) {
    return this.victimProfileWorkflowService.complete(user, id, data);
  }

  // VP-57
  @Patch('admin/:id/reopen')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: reopen a completed profile',
  })
  async reopen(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: ReasonDto,
  ) {
    return this.victimProfileWorkflowService.reopen(user, id, data);
  }

  // VP-58
  @Post('admin/:id/updates')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: post a public progress update as staff',
  })
  async createAdminUpdate(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: CreateProfileUpdateDto,
  ) {
    return this.victimProfileAdminOpsService.createAdminUpdate(user, id, data);
  }

  // VP-59
  @Get('admin/:id/consent')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: show the recorded consent (who, when, document)',
  })
  async getConsent(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileChildSafetyService.getConsent(user, id);
  }

  // VP-60
  @Post('admin/:id/consent')
  @MediaUpload(RecordConsentDto)
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: record consent with an uploaded signed form',
  })
  async recordConsent(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: RecordConsentDto,
  ) {
    return this.victimProfileChildSafetyService.recordConsent(user, id, data);
  }

  // VP-61
  @Patch('admin/:id/feature')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_PUBLISH)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: feature a profile',
  })
  async feature(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileAdminOpsService.feature(user, id);
  }

  // VP-62
  @Patch('admin/:id/unfeature')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_PUBLISH)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: remove the feature from a profile',
  })
  async unfeature(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileAdminOpsService.unfeature(user, id);
  }

  // VP-63
  @Patch('admin/:id/edit')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: edit profile text before publishing (history kept)',
  })
  async adminEdit(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: AdminEditVictimProfileDto,
  ) {
    return this.victimProfileAdminOpsService.adminEdit(user, id, data);
  }

  // VP-64
  @Patch('admin/:id/child-flag')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: correct the child-involved flag (dual-admin confirmation)',
  })
  async updateChildFlag(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: UpdateChildFlagDto,
  ) {
    return this.victimProfileChildSafetyService.updateChildFlag(user, id, data);
  }

  // VP-65
  @Get('admin/:id/transitions')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: allowed next statuses for a profile',
  })
  async getTransitions(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileReviewService.getTransitions(user, id);
  }

  // VP-67
  @Delete('admin/:id/soft')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Super admin: soft delete a profile with a reason',
  })
  async softDelete(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: ReasonDto,
  ) {
    return this.victimProfileAdminOpsService.softDelete(user, id, data);
  }

  // VP-68
  @Post('admin/:id/restore')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Super admin: restore a soft-deleted profile',
  })
  async restore(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileAdminOpsService.restore(user, id);
  }

  // VP-70
  @Get('admin/:id/revisions')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: field-level change history for a profile',
  })
  async getRevisions(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileAdminOpsService.getRevisions(user, id);
  }

  // VP-71
  @Patch('admin/:id/pause-donations')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: pause new donations while a flag or review is open',
  })
  async pauseDonations(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: ReasonDto,
  ) {
    return this.victimProfileCommonService.pauseDonations(user, id, data);
  }

  // VP-72
  @Patch('admin/:id/resume-donations')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: resume donations',
  })
  async resumeDonations(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileFundingService.resumeDonations(user, id);
  }

  // VP-73
  @Patch('admin/:id/goal')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: change the funding goal (audited, re-auth)',
  })
  async updateGoal(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: UpdateGoalDto,
  ) {
    return this.victimProfileFundingService.updateGoal(user, id, data);
  }

  // VP-74
  @Get('admin/:id/bank-details/history')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: history of changes to the transfer destination (masked)',
  })
  async getBankDetailsHistory(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileFundingService.getBankDetailsHistory(user, id);
  }

  // VP-75
  @Patch('admin/:id/bank-details/verify')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: mark the transfer destination verified',
  })
  async verifyBankDetails(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: VerifyBankDetailsDto,
  ) {
    return this.victimProfileFundingService.verifyBankDetails(user, id, data);
  }

  // VP-76
  @Get('admin/:id/funding-timeline')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: donations received per day',
  })
  async getFundingTimeline(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Query()
    query: DateRangeQueryDto,
  ) {
    return this.victimProfileFundingService.getFundingTimeline(user, id, query);
  }

  // VP-77
  @Get('admin/:id/attachments')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: files with type, size, scan status and hash',
  })
  async getAttachments(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileAdminOpsService.getAttachments(user, id);
  }

  // VP-78
  @Delete('admin/:id/media/:key')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: remove a file (for example one that identifies a child)',
  })
  async removeMedia(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Param('key')
    key: string,

    @Body()
    data: RemoveMediaDto,
  ) {
    return this.victimProfileAdminOpsService.removeMedia(user, id, key, data);
  }

  // VP-79
  @Post('admin/:id/media/:key/redact')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: redact a file (blur faces or hide details)',
  })
  async redactMedia(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Param('key')
    key: string,

    @Body()
    data: RedactMediaDto,
  ) {
    return this.victimProfileAdminOpsService.redactMedia(user, id, key, data);
  }

  // VP-80
  @Get('admin/:id/media/:key/custody')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: who viewed or downloaded a file',
  })
  async getMediaCustody(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Param('key')
    key: string,
  ) {
    return this.victimProfileAdminOpsService.getMediaCustody(user, id, key);
  }

  // VP-81
  @Get('admin/:id/access-log')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Super admin: who viewed this profile in the admin area',
  })
  async getAccessLog(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Query()
    query: PagedQueryDto,
  ) {
    return this.victimProfileAdminOpsService.getAccessLog(user, id, query);
  }

  // VP-82
  @Patch('admin/:id/legal-hold')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Super admin: set or clear a legal hold (blocks deletion and purge)',
  })
  async setLegalHold(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: LegalHoldDto,
  ) {
    return this.victimProfileAdminOpsService.setLegalHold(user, id, data);
  }

  // VP-83
  @Post('admin/:id/anonymize')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Super admin: remove identifying fields after closure (re-auth, audited)',
  })
  async anonymize(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: AnonymizeDto,
  ) {
    return this.victimProfileAdminOpsService.anonymize(user, id, data);
  }
}
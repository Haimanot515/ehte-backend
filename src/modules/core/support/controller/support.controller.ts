import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { SupportSubmissionService } from '../service/support-submission.service';
import { SupportMineService } from '../service/support-mine.service';
import { SupportPublicService } from '../service/support-public.service';
import { SupportIncomingService } from '../service/support-incoming.service';
import { SupportLifecycleService } from '../service/support-lifecycle.service';
import { SupportInboxService } from '../service/support-inbox.service';
import { SupportSupportersService } from '../service/support-supporters.service';
import { SupportModerationService } from '../service/support-moderation.service';
import { SupportAdminOpsService } from '../service/support-admin-ops.service';
import { SupportSearchService } from '../service/support-search.service';
import { SupportExportService } from '../service/support-export.service';
import { SupportStatsService } from '../service/support-stats.service';
import { MediaUpload } from 'src/common/decorators/media-upload.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import {
  AssignSupportReviewerDto,
  BulkExpireSupportDto,
  BulkSupportIdsDto,
  BulkSupportReasonDto,
  CancelSupportDto,
  CompleteSupportDto,
  CreateSupportDisputeDto,
  CreateSupportDto,
  CreateSupportMessageDto,
  DeclineIncomingSupportDto,
  FlagSupportDto,
  ListSupportDisputesQueryDto,
  ListSupportFlagsQueryDto,
  ListSupportQueryDto,
  ListUnreadSupportQueryDto,
  ReadAllSupportDto,
  ReassignSupportProfileDto,
  ResolveSupportDisputeDto,
  RestrictSupporterDto,
  SendThanksDto,
  SupportExportQueryDto,
  SupportPagedQueryDto,
  SupportReasonDto,
  SupportSearchQueryDto,
  SupportStatsQueryDto,
  SupportStatsTimelineQueryDto,
  UpdateSupportDto,
  UploadSupportProofDto,
} from '../dto/support.dto';

@ApiTags('Support')
@ApiBearerAuth('access-token')
@Controller('support')
export class SupportController {
  constructor(
    private readonly supportSubmissionService: SupportSubmissionService,
    private readonly supportMineService: SupportMineService,
    private readonly supportPublicService: SupportPublicService,
    private readonly supportIncomingService: SupportIncomingService,
    private readonly supportLifecycleService: SupportLifecycleService,
    private readonly supportInboxService: SupportInboxService,
    private readonly supportSupportersService: SupportSupportersService,
    private readonly supportModerationService: SupportModerationService,
    private readonly supportAdminOpsService: SupportAdminOpsService,
    private readonly supportSearchService: SupportSearchService,
    private readonly supportExportService: SupportExportService,
    private readonly supportStatsService: SupportStatsService,
  ) {}

  // POST /support — any authenticated user; non-financial offers only, starts PENDING.
  @Post()
  @ApiOperation({
    summary: 'Offer non-financial support',
    description:
      'Authenticated users can offer goods, time or skills for a published victim profile by ticking ' +
      'one or more checklist items. The offer is recorded as PENDING and an admin follows up; the ' +
      'handover happens off the platform. No amount is accepted. Money is paid through ' +
      'POST /payments/victim-profile/:victimProfileId/support-checkout instead.',
  })
  async create(@CurrentUser() user: CurrentUserDto, @Body() data: CreateSupportDto) {
    return this.supportSubmissionService.create(user, data);
  }

  // GET /support — admin queue.
  @Get()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({
    summary: 'Admin: list supports',
    description:
      'Lists supports, newest first, optionally filtered by status and type. Use status=PENDING ' +
      'and type=NON_FINANCIAL to find offers waiting for follow-up. Includes the supporter name and contact.',
  })
  async listForAdmin(@Query() query: ListSupportQueryDto) {
    return this.supportAdminOpsService.listForAdmin(query);
  }

  // GET /support/mine
  @Get('mine')
  @ApiOperation({
    summary: 'Get my support requests',
    description:
      'Returns the support requests created by the currently authenticated user. ' +
      'Each request includes its associated victim profile.',
  })
  async findMine(@CurrentUser() user: CurrentUserDto) {
    return this.supportMineService.findMine(user);
  }

  // GET /support/stats — declared before ':id' so "stats" isn't matched as an id.
  @Get('stats')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get support counts by status and total confirmed amount' })
  async getStats() {
    return this.supportStatsService.getStats();
  }

  // GET /support/victim/:victimProfileId/summary — declared before the plain route for readability.
  @Get('victim/:victimProfileId/summary')
  @ApiOperation({
    summary: 'Offer counts for a victim profile',
    description:
      'Returns how many non-financial offers were received and delivered for a published profile. ' +
      'Shown next to total raised, since goods have no money value.',
  })
  async getOfferCounts(@Param('victimProfileId') victimProfileId: string) {
    return this.supportPublicService.getOfferCounts(victimProfileId);
  }

  // GET /support/victim/:victimProfileId — public list for a published profile.
  @Get('victim/:victimProfileId')
  @ApiOperation({
    summary: 'Get public support list for a victim profile',
    description:
      'Returns only CONFIRMED or COMPLETED supports of a published victim profile. ' +
      'Supporters who chose to stay anonymous are shown as an anonymous supporter. ' +
      'Notes, contact details and user IDs are never returned.',
  })
  async findForVictimProfile(@Param('victimProfileId') victimProfileId: string) {
    return this.supportPublicService.findForVictimProfile(victimProfileId);
  }

  // ── New literal routes, kept above GET :id and every :id/... route so they are never read as an id. ──

  // SP-04 — GET /support/mine/summary
  @Get('mine/summary')
  @ApiOperation({ summary: 'My offer counts by status' })
  async getMySupportSummary(@CurrentUser() user: CurrentUserDto) {
    return this.supportMineService.getMySupportSummary(user);
  }

  // SP-05 — GET /support/mine/stats
  @Get('mine/stats')
  @ApiOperation({ summary: 'My impact: offers completed, profiles helped' })
  async getMySupportImpact(@CurrentUser() user: CurrentUserDto) {
    return this.supportMineService.getMySupportImpact(user);
  }

  // SP-10 — GET /support/mine/unread-updates/count
  @Get('mine/unread-updates/count')
  @ApiOperation({ summary: 'Offers with an unseen status change or message' })
  async countMyUnreadUpdates(@CurrentUser() user: CurrentUserDto) {
    return this.supportMineService.countMyUnreadUpdates(user);
  }

  // SP-12 — PATCH /support/mine/seen-all
  @Patch('mine/seen-all')
  @ApiOperation({ summary: 'Mark all updates on my offers as seen' })
  async markAllMineSeen(@CurrentUser() user: CurrentUserDto) {
    return this.supportMineService.markAllMineSeen(user);
  }

  // SP-13 — GET /support/incoming
  @Get('incoming')
  @ApiOperation({ summary: 'Offers made to profiles I own, with status' })
  async findIncoming(@CurrentUser() user: CurrentUserDto, @Query() query: SupportPagedQueryDto) {
    return this.supportIncomingService.findIncoming(user, query);
  }

  // SP-18 — GET /support/incoming/summary
  @Get('incoming/summary')
  @ApiOperation({ summary: 'Counts of incoming offers by status' })
  async getIncomingSummary(@CurrentUser() user: CurrentUserDto) {
    return this.supportIncomingService.getIncomingSummary(user);
  }

  // SP-19 — GET /support/incoming/unread-count
  @Get('incoming/unread-count')
  @ApiOperation({ summary: 'Incoming offers I have not opened' })
  async countIncomingUnread(@CurrentUser() user: CurrentUserDto) {
    return this.supportIncomingService.countIncomingUnread(user);
  }

  // SP-14 — GET /support/incoming/:id
  @Get('incoming/:id')
  @ApiOperation({
    summary: 'One incoming offer (supporter identity honours their anonymity choice)',
  })
  async findOneIncoming(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.supportIncomingService.findOneIncoming(id, user);
  }

  // SP-15 — PATCH /support/incoming/:id/decline
  @Patch('incoming/:id/decline')
  @ApiOperation({ summary: 'Decline an incoming offer that does not fit, with a reason' })
  async declineIncoming(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: DeclineIncomingSupportDto,
  ) {
    return this.supportLifecycleService.declineIncoming(id, user, data);
  }

  // SP-25 — GET /support/unread
  @Get('unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: my unread offers' })
  async findUnread(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ListUnreadSupportQueryDto,
  ) {
    return this.supportInboxService.findUnread(admin, query);
  }

  // SP-26 — GET /support/unread/count
  @Get('unread/count')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: unread badge count' })
  async countUnread(@CurrentUser() admin: CurrentUserDto) {
    return this.supportInboxService.countUnread(admin);
  }

  // SP-27 — GET /support/counts
  @Get('counts')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: total, read and unread offers' })
  async getReadCounts(@CurrentUser() admin: CurrentUserDto) {
    return this.supportInboxService.getReadCounts(admin);
  }

  // SP-22 — PATCH /support/bulk/read
  @Patch('bulk/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: mark many offers read' })
  async bulkMarkRead(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkSupportIdsDto) {
    return this.supportInboxService.bulkMarkRead(admin, data);
  }

  // SP-23 — PATCH /support/bulk/unread
  @Patch('bulk/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: mark many offers unread' })
  async bulkMarkUnread(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkSupportIdsDto) {
    return this.supportInboxService.bulkMarkUnread(admin, data);
  }

  // SP-24 — PATCH /support/read-all
  @Patch('read-all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: mark all offers matching a filter read' })
  async markAllRead(@CurrentUser() admin: CurrentUserDto, @Body() data: ReadAllSupportDto) {
    return this.supportInboxService.markAllRead(admin, data);
  }

  // SP-43 — PATCH /support/bulk/confirm
  @Patch('bulk/confirm')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @ApiOperation({ summary: 'Admin: confirm many non-financial offers at once' })
  async bulkConfirm(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkSupportIdsDto) {
    return this.supportLifecycleService.bulkConfirm(admin, data);
  }

  // SP-44 — PATCH /support/bulk/cancel
  @Patch('bulk/cancel')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({ summary: 'Admin: cancel many offers with a reason' })
  async bulkCancel(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkSupportReasonDto) {
    return this.supportLifecycleService.bulkCancel(admin, data);
  }

  // SP-45 — PATCH /support/bulk/expire
  @Patch('bulk/expire')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({ summary: 'Admin: expire old pending offers nobody confirmed' })
  async bulkExpire(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkExpireSupportDto) {
    return this.supportAdminOpsService.bulkExpire(admin, data);
  }

  // SP-33 — GET /support/by-supporter/repeat-disputes
  @Get('by-supporter/repeat-disputes')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: supporters with repeated disputes or non-delivery' })
  async findRepeatDisputeSupporters(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportPagedQueryDto,
  ) {
    return this.supportSupportersService.findRepeatDisputeSupporters(admin, query);
  }

  // SP-28 — GET /support/by-supporter
  @Get('by-supporter')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({
    summary: 'Admin: one row per supporter with total, read, unread, completed, disputed',
  })
  async findSupportersSummary(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportPagedQueryDto,
  ) {
    return this.supportSupportersService.findSupportersSummary(admin, query);
  }

  // SP-29 — GET /support/by-supporter/:supporterId
  @Get('by-supporter/:supporterId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: "Admin: one supporter's offers" })
  async findBySupporter(
    @CurrentUser() admin: CurrentUserDto,
    @Param('supporterId') supporterId: string,
    @Query() query: ListSupportQueryDto,
  ) {
    return this.supportSupportersService.findBySupporter(supporterId, admin, query);
  }

  // SP-30 — GET /support/by-supporter/:supporterId/summary
  @Get('by-supporter/:supporterId/summary')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: "Admin: a supporter's totals by status and reliability" })
  async getSupporterSummary(
    @CurrentUser() admin: CurrentUserDto,
    @Param('supporterId') supporterId: string,
  ) {
    return this.supportSupportersService.getSupporterSummary(supporterId, admin);
  }

  // SP-32 — PATCH /support/by-supporter/:supporterId/read
  @Patch('by-supporter/:supporterId/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: "Admin: mark all of a supporter's offers read" })
  async markSupporterRead(
    @CurrentUser() admin: CurrentUserDto,
    @Param('supporterId') supporterId: string,
  ) {
    return this.supportSupportersService.markSupporterRead(supporterId, admin);
  }

  // SP-38 — POST /support/by-supporter/:supporterId/restrict
  @Post('by-supporter/:supporterId/restrict')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({ summary: 'Admin: block a supporter from making new offers' })
  async restrictSupporter(
    @CurrentUser() admin: CurrentUserDto,
    @Param('supporterId') supporterId: string,
    @Body() data: RestrictSupporterDto,
  ) {
    return this.supportSupportersService.restrictSupporter(supporterId, admin, data);
  }

  // SP-39 — DELETE /support/by-supporter/:supporterId/restrict
  @Delete('by-supporter/:supporterId/restrict')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({ summary: "Admin: lift a supporter's restriction" })
  async liftSupporterRestriction(
    @CurrentUser() admin: CurrentUserDto,
    @Param('supporterId') supporterId: string,
  ) {
    return this.supportSupportersService.liftSupporterRestriction(supporterId, admin);
  }

  // SP-31 — GET /support/by-profile
  @Get('by-profile')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({
    summary: 'Admin: one row per victim profile with offers, completed, pending, disputed',
  })
  async findProfilesSummary(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportPagedQueryDto,
  ) {
    return this.supportSupportersService.findProfilesSummary(admin, query);
  }

  // SP-34 — GET /support/disputes
  @Get('disputes')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: queue of open disputes' })
  async findDisputes(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ListSupportDisputesQueryDto,
  ) {
    return this.supportModerationService.findDisputes(admin, query);
  }

  // SP-35 — GET /support/disputes/:disputeId
  @Get('disputes/:disputeId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: one dispute with both sides and proof' })
  async findOneDispute(
    @CurrentUser() admin: CurrentUserDto,
    @Param('disputeId') disputeId: string,
  ) {
    return this.supportModerationService.findOneDispute(disputeId, admin);
  }

  // SP-36 — PATCH /support/disputes/:disputeId
  @Patch('disputes/:disputeId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({ summary: 'Admin: resolve a dispute with an outcome and reason' })
  async resolveDispute(
    @CurrentUser() admin: CurrentUserDto,
    @Param('disputeId') disputeId: string,
    @Body() data: ResolveSupportDisputeDto,
  ) {
    return this.supportLifecycleService.resolveDispute(disputeId, admin, data);
  }

  // SP-41 — GET /support/flags
  @Get('flags')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: queue of suspicious offers' })
  async findFlags(@CurrentUser() admin: CurrentUserDto, @Query() query: ListSupportFlagsQueryDto) {
    return this.supportModerationService.findFlags(admin, query);
  }

  // SP-55 — GET /support/search
  @Get('search')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: search offers by reference, supporter or profile' })
  async searchSupports(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportSearchQueryDto,
  ) {
    return this.supportSearchService.searchSupports(admin, query);
  }

  // SP-56 — GET /support/facets
  @Get('facets')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: counts for the filter sidebar' })
  async getSupportFacets(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportStatsQueryDto,
  ) {
    return this.supportSearchService.getSupportFacets(admin, query);
  }

  // SP-57 — GET /support/export
  @Get('export')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Admin: export offers as CSV (row-capped, audited)' })
  async exportSupportsCsv(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportExportQueryDto,
  ) {
    return this.supportExportService.exportSupportsCsv(admin, query);
  }

  // SP-58 — POST /support/export-jobs
  @Post('export-jobs')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Admin: start a background export' })
  async createSupportExportJob(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: SupportExportQueryDto,
  ) {
    return this.supportExportService.createSupportExportJob(admin, data);
  }

  // SP-59 — GET /support/export-jobs/:id
  @Get('export-jobs/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: export job progress' })
  async getSupportExportJob(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.supportExportService.getSupportExportJob(id, admin);
  }

  // SP-60 — GET /support/export-jobs/:id/download
  @Get('export-jobs/:id/download')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: short-lived download link for a finished export (audited)' })
  async getSupportExportJobDownload(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.supportExportService.getSupportExportJobDownload(id, admin);
  }

  // SP-61 — GET /support/stats/timeline
  @Get('stats/timeline')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: support stats, offers per day, week or month' })
  async getSupportStatsTimeline(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportStatsTimelineQueryDto,
  ) {
    return this.supportStatsService.getSupportStatsTimeline(admin, query);
  }

  // SP-62 — GET /support/stats/by-status
  @Get('stats/by-status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: support stats, offers by status' })
  async getSupportStatsByStatus(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportStatsQueryDto,
  ) {
    return this.supportStatsService.getSupportStatsByStatus(admin, query);
  }

  // SP-63 — GET /support/stats/by-type
  @Get('stats/by-type')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: support stats, financial against non-financial' })
  async getSupportStatsByType(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportStatsQueryDto,
  ) {
    return this.supportStatsService.getSupportStatsByType(admin, query);
  }

  // SP-64 — GET /support/stats/fulfilment-time
  @Get('stats/fulfilment-time')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: support stats, time from offer to completed' })
  async getSupportStatsFulfilmentTime(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportStatsQueryDto,
  ) {
    return this.supportStatsService.getSupportStatsFulfilmentTime(admin, query);
  }

  // SP-65 — GET /support/stats/completion-rate
  @Get('stats/completion-rate')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: support stats, completed, cancelled and failed' })
  async getSupportStatsCompletionRate(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportStatsQueryDto,
  ) {
    return this.supportStatsService.getSupportStatsCompletionRate(admin, query);
  }

  // SP-66 — GET /support/stats/disputes
  @Get('stats/disputes')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: support stats, disputes over time and by outcome' })
  async getSupportStatsDisputes(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportStatsQueryDto,
  ) {
    return this.supportStatsService.getSupportStatsDisputes(admin, query);
  }

  // SP-67 — GET /support/stats/aging
  @Get('stats/aging')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: support stats, pending offers by age bucket' })
  async getSupportStatsAging(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportStatsQueryDto,
  ) {
    return this.supportStatsService.getSupportStatsAging(admin, query);
  }

  // SP-68 — GET /support/stats/overview
  @Get('stats/overview')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: support stats, dashboard in one call' })
  async getSupportStatsOverview(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SupportStatsQueryDto,
  ) {
    return this.supportStatsService.getSupportStatsOverview(admin, query);
  }

  // GET /support/:id — owner or admin only (checked in the service).
  @Get(':id')
  @ApiOperation({
    summary: 'Get support by ID',
    description:
      'Returns a support by its ID. Only the supporter who created it, or an Admin / Super Admin, ' +
      'can read it. The response never includes the full user record.',
  })
  async findOne(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.supportMineService.findOne(id, user);
  }

  // PATCH /support/:id/confirm — admin accepts a non-financial offer.
  @Patch(':id/confirm')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @ApiOperation({
    summary: 'Confirm a non-financial offer (Admin)',
    description:
      'Admin or Super Admin accepts a PENDING non-financial offer. The claimed victim (if any) ' +
      'is notified at this point. Financial supports are confirmed automatically by a successful ' +
      'Chapa payment and cannot be confirmed here.',
  })
  async confirm(@Param('id') id: string, @CurrentUser() admin: CurrentUserDto) {
    return this.supportLifecycleService.confirm(id, admin);
  }

  // PATCH /support/:id/complete — marks a confirmed support as completed.
  @Patch(':id/complete')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({
    summary: 'Complete support (Admin)',
    description:
      'Admin or Super Admin marks a confirmed support as completed after it has been fully handled. ' +
      'A note is required and is stored in the audit trail. This endpoint does not process ' +
      'or transfer money.',
  })
  async complete(
    @Param('id') id: string,
    @CurrentUser() admin: CurrentUserDto,
    @Body() body: CompleteSupportDto,
  ) {
    return this.supportLifecycleService.complete(id, admin, body.note);
  }

  // PATCH /support/:id/confirm-receipt — the claimed victim confirms they received non-financial help.
  @Patch(':id/confirm-receipt')
  @ApiOperation({
    summary: 'Confirm receipt of non-financial help (victim)',
    description:
      'The user who claimed the victim profile can confirm, with one tap, that the help was received. ' +
      'Optional. Only for non-financial supports that are CONFIRMED or COMPLETED.',
  })
  async confirmReceipt(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.supportMineService.confirmReceipt(id, user);
  }

  // PATCH /support/:id/cancel — owner (non-financial, PENDING only) or admin.
  @Patch(':id/cancel')
  @ApiOperation({
    summary: 'Cancel support',
    description:
      'The supporter can cancel their own non-financial offer while it is still PENDING. ' +
      'A paid financial support cannot be cancelled by the user; a refund is a separate admin action. ' +
      'Admin and Super Admin users can cancel any support, which also lowers total raised for ' +
      'financial supports.',
  })
  async cancel(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: CancelSupportDto,
  ) {
    return this.supportLifecycleService.cancel(id, user, body?.reason);
  }

  // ── New routes under :id ──

  // SP-01 — PATCH /support/:id
  @Patch(':id')
  @ApiOperation({ summary: 'Edit the details of my pending offer' })
  async updateMyOffer(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: UpdateSupportDto,
  ) {
    return this.supportSubmissionService.updateMyOffer(id, user, data);
  }

  // SP-02 — POST /support/:id/proof
  @Post(':id/proof')
  @MediaUpload(UploadSupportProofDto)
  @ApiOperation({ summary: 'Upload proof of delivery, such as a photo or receipt' })
  async uploadProof(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: UploadSupportProofDto,
  ) {
    return this.supportSubmissionService.uploadProof(id, user, data);
  }

  // SP-03 — DELETE /support/:id/proof/:key
  @Delete(':id/proof/:key')
  @ApiOperation({ summary: 'Remove a proof file from my pending offer' })
  async removeProof(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Param('key') key: string,
  ) {
    return this.supportSubmissionService.removeProof(id, key, user);
  }

  // SP-06 — GET /support/:id/timeline
  @Get(':id/timeline')
  @ApiOperation({ summary: 'Status history of my offer, with no internal notes' })
  async getTimeline(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.supportMineService.getTimeline(id, user);
  }

  // SP-07 — POST /support/:id/dispute
  @Post(':id/dispute')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Report a mismatch or a recipient who denies receiving the help' })
  async createDispute(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: CreateSupportDisputeDto,
  ) {
    return this.supportMineService.createDispute(id, user, data);
  }

  // SP-08 — POST /support/:id/messages
  @Post(':id/messages')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send a message about my offer to the admin team' })
  async sendMessage(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: CreateSupportMessageDto,
  ) {
    return this.supportMineService.sendMessage(id, user, data);
  }

  // SP-09 — GET /support/:id/messages
  @Get(':id/messages')
  @ApiOperation({ summary: 'Read the message thread on my offer' })
  async getMessages(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: SupportPagedQueryDto,
  ) {
    return this.supportMineService.getMessages(id, user, query);
  }

  // SP-11 — PATCH /support/:id/seen
  @Patch(':id/seen')
  @ApiOperation({ summary: 'Mark the latest update on my offer as seen' })
  async markSeen(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.supportMineService.markSeen(id, user);
  }

  // SP-16 — POST /support/:id/dispute-receipt
  @Post(':id/dispute-receipt')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Recipient: report that the help was not delivered or does not match' })
  async disputeReceipt(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: CreateSupportDisputeDto,
  ) {
    return this.supportIncomingService.disputeReceipt(id, user, data);
  }

  // SP-17 — POST /support/:id/thanks
  @Post(':id/thanks')
  @ApiOperation({ summary: 'Recipient: send a thank-you to the supporter' })
  async sendThanks(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: SendThanksDto,
  ) {
    return this.supportIncomingService.sendThanks(id, user, data);
  }

  // SP-20 — PATCH /support/:id/read
  @Patch(':id/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: mark an offer read' })
  async markRead(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.supportInboxService.markRead(id, admin);
  }

  // SP-21 — PATCH /support/:id/unread
  @Patch(':id/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: mark an offer unread' })
  async markUnread(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.supportInboxService.markUnread(id, admin);
  }

  // SP-37 — GET /support/:id/disputes
  @Get(':id/disputes')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: disputes on one offer' })
  async findDisputesForSupport(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.supportModerationService.findDisputesForSupport(id, admin);
  }

  // SP-40 — POST /support/:id/flag
  @Post(':id/flag')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({ summary: 'Admin: flag an offer as suspicious' })
  async flagSupport(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: FlagSupportDto,
  ) {
    return this.supportModerationService.flagSupport(id, admin, data);
  }

  // SP-42 — PATCH /support/:id/assign
  @Patch(':id/assign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({ summary: 'Super admin: assign a reviewer to an offer' })
  async assignReviewer(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AssignSupportReviewerDto,
  ) {
    return this.supportAdminOpsService.assignReviewer(id, admin, data);
  }

  // SP-46 — PATCH /support/:id/mark-failed
  @Patch(':id/mark-failed')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({ summary: 'Admin: mark an offer FAILED with a reason' })
  async markFailed(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: SupportReasonDto,
  ) {
    return this.supportLifecycleService.markFailed(id, admin, data);
  }

  // SP-47 — PATCH /support/:id/reopen
  @Patch(':id/reopen')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({ summary: 'Admin: reopen a cancelled or failed offer' })
  async reopen(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: SupportReasonDto,
  ) {
    return this.supportLifecycleService.reopen(id, admin, data);
  }

  // SP-48 — PATCH /support/:id/reassign-profile
  @Patch(':id/reassign-profile')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({ summary: 'Admin: move an offer to another victim profile' })
  async reassignProfile(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: ReassignSupportProfileDto,
  ) {
    return this.supportAdminOpsService.reassignProfile(id, admin, data);
  }

  // SP-49 — GET /support/:id/transitions
  @Get(':id/transitions')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: allowed next statuses for an offer' })
  async getTransitions(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.supportLifecycleService.getTransitions(id, admin);
  }

  // SP-50 — GET /support/:id/revisions
  @Get(':id/revisions')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Admin: field-level change history for an offer' })
  async getRevisions(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.supportAdminOpsService.getRevisions(id, admin);
  }

  // SP-51 — POST /support/:id/messages/staff
  @Post(':id/messages/staff')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({ summary: 'Admin: staff reply to the supporter, visible in their thread' })
  async sendStaffMessage(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: CreateSupportMessageDto,
  ) {
    return this.supportAdminOpsService.sendStaffMessage(id, admin, data);
  }

  // SP-52 — GET /support/:id/attachments
  @Get(':id/attachments')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({ summary: 'Admin: proof files with type, size, scan status and hash' })
  async getAttachments(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.supportAdminOpsService.getAttachments(id, admin);
  }

  // SP-53 — DELETE /support/:id/proof/:key/admin
  @Delete(':id/proof/:key/admin')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({
    summary: 'Admin: remove a proof file (for example one that shows a face or address)',
  })
  async adminRemoveProof(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Param('key') key: string,
  ) {
    return this.supportAdminOpsService.adminRemoveProof(id, key, admin);
  }

  // SP-54 — GET /support/:id/proof/:key/custody
  @Get(':id/proof/:key/custody')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Admin: who viewed or downloaded a proof file' })
  async getProofCustody(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Param('key') key: string,
  ) {
    return this.supportAdminOpsService.getProofCustody(id, key, admin);
  }
}
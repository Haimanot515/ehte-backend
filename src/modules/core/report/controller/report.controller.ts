import { ReportCategory } from '@prisma/client';
import { MediaFolder } from 'src/common/enums/media-folder.enum';
import { Request } from 'express';
import { Req } from '@nestjs/common';
import { MediaUpload, RESPONSE_FILES_FIELDS } from 'src/common/decorators/media-upload.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { ReportCommonService } from '../service/report-common.service';
import { ReportSubmissionService } from '../service/report-submission.service';
import { ReportReporterService } from '../service/report-reporter.service';
import { ReportCommunicationService } from '../service/report-communication.service';
import { ReportInboxService } from '../service/report-inbox.service';
import { ReportWorkflowService } from '../service/report-workflow.service';
import { ReportLifecycleService } from '../service/report-lifecycle.service';
import { ReportCaseManagementService } from '../service/report-case-management.service';
import { ReportAccessService } from '../service/report-access.service';
import { ReportLocationService } from '../service/report-location.service';
import { ReportSearchService } from '../service/report-search.service';
import { ReportExportService } from '../service/report-export.service';
import { ReportStatsService } from '../service/report-stats.service';

import {
  PageQueryDto,
  CreateReportDto,
  UpdateReportDto,
  AdminReportQueryDto,
  UpdateReportStatusDto,
  AssignReportDto,
  RequestMoreInformationDto,
  EscalateReportDto,
  RespondToInformationRequestDto,
  // --- new ---
  AccessLogQueryDto,
  AddReportEvidenceDto,
  AddReportTagsDto,
  ArchiveReportDto,
  AssignTeamDto,
  AttachReportLocationDto,
  BulkAssignReportsDto,
  BulkReportIdsDto,
  BulkTagReportsDto,
  BulkUnassignReportsDto,
  BulkUpdateReportStatusDto,
  ByUserQueryDto,
  CancelInformationRequestDto,
  ChangeAnonymityDto,
  ContactPreferenceDto,
  CreateFollowUpDto,
  CreateReportMessageDto,
  DeEscalateReportDto,
  EvidenceRemovalQueryDto,
  ExportReportsQueryDto,
  ExtendInformationRequestDto,
  FollowUpsQueryDto,
  GrantReportAccessDto,
  HotspotsQueryDto,
  LegalHoldDto,
  LinkReportRecordDto,
  MarkFalseReportDto,
  MarkSpamDto,
  MergeReportDto,
  MuteReportDto,
  NearbyReportsQueryDto,
  PendingInformationRequestsQueryDto,
  QueueNextQueryDto,
  ReadAllReportsDto,
  RedactEvidenceDto,
  RepeatReportersQueryDto,
  ReplyToReportEmailDto,
  ReportCountsQueryDto,
  ReportDeleteRequestDto,
  ReportFeedbackDto,
  ReportListQueryDto,
  ReportMapQueryDto,
  ReportStatsQueryDto,
  RequestReopenDto,
  ResolveReportDto,
  RevealReporterDto,
  ReviewInformationResponseDto,
  SaveReportDraftDto,
  SaveReportViewDto,
  SearchReportsQueryDto,
  SetDueDateDto,
  SlaBreachingQueryDto,
  SoftDeleteReportQueryDto,
  SplitReportDto,
  StartExportJobDto,
  StatsTimelineQueryDto,
  SyncReportsDto,
  UnmarkReportDto,
  UnmergeReportDto,
  UnreadReportsQueryDto,
  UpdateReportCategoryDto,
  UpdateReportLocationDto,
  UpdateReportPriorityDto,
  UpdateReportSensitivityDto,
  UpdateReportViewDto,
  UrgentReportDto,
  UserReportsQueryDto,
} from '../dto/report.dto';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { MediaKeyQueryDto } from 'src/modules/media/dto/media-key-query.dto';

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@Controller('reports')
export class ReportController {
  constructor(
    private readonly reportCommonService: ReportCommonService,
    private readonly reportSubmissionService: ReportSubmissionService,
    private readonly reportReporterService: ReportReporterService,
    private readonly reportCommunicationService: ReportCommunicationService,
    private readonly reportInboxService: ReportInboxService,
    private readonly reportWorkflowService: ReportWorkflowService,
    private readonly reportLifecycleService: ReportLifecycleService,
    private readonly reportCaseManagementService: ReportCaseManagementService,
    private readonly reportAccessService: ReportAccessService,
    private readonly reportLocationService: ReportLocationService,
    private readonly reportSearchService: ReportSearchService,
    private readonly reportExportService: ReportExportService,
    private readonly reportStatsService: ReportStatsService,
  ) {}

  // Accepts an optional Idempotency-Key so a dropped-response retry
  // returns the original report instead of creating a duplicate
  @Post()
  @MediaUpload(CreateReportDto)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiOperation({ summary: 'Submit a new report' })
  async create(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateReportDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.reportSubmissionService.create(user, data, idempotencyKey);
  }

  @Get('me')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get reports submitted by the current user' })
  async findMyReports(@CurrentUser() user: CurrentUserDto) {
    return this.reportSubmissionService.findMyReports(user);
  }

  // Declared before ':id' so "assigned-to-me" isn't matched as a route param
  @Get('assigned-to-me')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get reports assigned to the current admin' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAssignedToMe(
    @CurrentUser() admin: CurrentUserDto,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.reportWorkflowService.findAssignedToMe(admin, { page, limit });
  }

  // Declared before ':id' so "stale" isn't matched as a report id
  @Get('stale')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get unassigned reports that have been waiting too long' })
  async findStalePending() {
    return this.reportWorkflowService.findStalePending();
  }

  // Declared before ':id' so "stats" isn't matched as a report id
  @Get('stats')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get report statistics for the dashboard' })
  async getStats() {
    return this.reportStatsService.getStats();
  }

  @Get()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'List all reports (admin)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'assignedTo', required: false })
  @ApiQuery({ name: 'assignmentStatus', required: false, enum: ['assigned', 'unassigned'] })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAll(@Query() query: AdminReportQueryDto) {
    return this.reportWorkflowService.findAllForAdmin(query);
  }

  // RPT-29
  @Get('me/summary')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get my report totals by status' })
  async getMyReportSummary(@CurrentUser() user: CurrentUserDto) {
    return this.reportReporterService.getMySummary(user);
  }

  // RPT-30
  @Get('me/unread-updates/count')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Count the report updates I have not seen' })
  async countMyUnreadUpdates(@CurrentUser() user: CurrentUserDto) {
    return this.reportReporterService.countMyUnreadUpdates(user);
  }

  // RPT-32
  @Patch('me/seen-all')
  @ApiOperation({ summary: 'Mark all my report updates as seen' })
  async markAllUpdatesSeen(@CurrentUser() user: CurrentUserDto) {
    return this.reportReporterService.markAllSeen(user);
  }

  // RPT-88 ★
  @Get('me/information-requests/pending')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get information requests waiting for my answer' })
  async findMyPendingInformationRequests(
    @CurrentUser() user: CurrentUserDto,
    @Query() query: ReportListQueryDto,
  ) {
    return this.reportReporterService.findMyPendingInformationRequests(user, query);
  }

  // RPT-93
  @Post('drafts')
  @MediaUpload(SaveReportDraftDto)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Save a report draft' })
  async saveDraft(@CurrentUser() user: CurrentUserDto, @Body() data: SaveReportDraftDto) {
    return this.reportSubmissionService.saveDraft(user, data);
  }

  // RPT-94
  @Get('drafts')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get my report drafts' })
  async findMyDrafts(@CurrentUser() user: CurrentUserDto, @Query() query: ReportListQueryDto) {
    return this.reportSubmissionService.listDrafts(user, query);
  }

  // RPT-95
  @Patch('drafts/:draftId')
  @MediaUpload(SaveReportDraftDto)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Update one of my drafts' })
  async updateDraft(
    @CurrentUser() user: CurrentUserDto,
    @Param('draftId') draftId: string,
    @Body() data: SaveReportDraftDto,
  ) {
    return this.reportSubmissionService.updateDraft(user, draftId, data);
  }

  // RPT-96
  @Delete('drafts/:draftId')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Delete one of my drafts' })
  async deleteDraft(@CurrentUser() user: CurrentUserDto, @Param('draftId') draftId: string) {
    return this.reportSubmissionService.deleteDraft(user, draftId);
  }

  // RPT-97 — Same checks as POST /reports
  @Post('drafts/:draftId/submit')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiOperation({ summary: 'Submit a draft as a report' })
  async submitDraft(@CurrentUser() user: CurrentUserDto, @Param('draftId') draftId: string) {
    return this.reportSubmissionService.submitDraft(user, draftId);
  }

  // RPT-98 — Each item carries a clientId so a retry does not create duplicates
  @Post('sync')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiOperation({ summary: 'Submit reports that were queued while offline' })
  async syncOfflineReports(@CurrentUser() user: CurrentUserDto, @Body() data: SyncReportsDto) {
    return this.reportSubmissionService.syncReports(user, data);
  }

  // RPT-100 — Only ever returns the caller's own reports
  @Get('track/:reference')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Find my report by its reference' })
  async trackByReference(
    @CurrentUser() user: CurrentUserDto,
    @Param('reference') reference: string,
  ) {
    return this.reportReporterService.trackByReference(user, reference);
  }

  // RPT-16 ★
  @Patch('bulk/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: mark many reports as read for me' })
  async bulkMarkRead(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkReportIdsDto) {
    return this.reportInboxService.bulkMarkRead(admin, data.ids);
  }

  // RPT-17
  @Patch('bulk/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: mark many reports as unread for me' })
  async bulkMarkUnread(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkReportIdsDto) {
    return this.reportInboxService.bulkMarkUnread(admin, data.ids);
  }

  // RPT-18
  @Patch('read-all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: mark all reports matching a filter as read for me' })
  async markAllRead(@CurrentUser() admin: CurrentUserDto, @Body() data: ReadAllReportsDto) {
    return this.reportInboxService.readAll(admin, data);
  }

  // RPT-19 ★
  @Get('unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread reports' })
  async findUnread(@CurrentUser() admin: CurrentUserDto, @Query() query: UnreadReportsQueryDto) {
    return this.reportInboxService.listUnread(admin, query);
  }

  // RPT-20 ★
  @Get('unread/count')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread badge count' })
  async getUnreadCount(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportCountsQueryDto) {
    return this.reportInboxService.countUnread(admin);
  }

  // RPT-21
  @Get('unread/count/by-status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread count by status' })
  async getUnreadCountByStatus(@CurrentUser() admin: CurrentUserDto) {
    return this.reportInboxService.countUnreadByStatus(admin);
  }

  // RPT-22
  @Get('unread/count/by-category')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread count by category' })
  async getUnreadCountByCategory(@CurrentUser() admin: CurrentUserDto) {
    return this.reportInboxService.countUnreadByCategory(admin);
  }

  // RPT-159 ★
  @Get('counts')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my total, read and unread report counts' })
  async getCounts(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportCountsQueryDto) {
    return this.reportInboxService.getCounts(admin, query);
  }

  // RPT-23 ★ — Service writes an audit event; anonymous and USSD reporters group by a masked id
  @Get('by-user')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORTER_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get one row per reporter with total, read and unread counts' })
  async findByUser(@CurrentUser() admin: CurrentUserDto, @Query() query: ByUserQueryDto) {
    return this.reportInboxService.listByUser(admin, query);
  }

  // RPT-28 — Declared before by-user/:userId
  @Get('by-user/repeat')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORTER_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get users who have made several reports' })
  async findRepeatReporters(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: RepeatReportersQueryDto,
  ) {
    return this.reportInboxService.listRepeatReporters(admin, query);
  }

  // RPT-24 ★ — Service writes an audit event
  @Get('by-user/:userId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORTER_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "Admin: get one user's reports, each with isRead" })
  async findReportsOfUser(
    @CurrentUser() admin: CurrentUserDto,
    @Param('userId') userId: string,
    @Query() query: UserReportsQueryDto,
  ) {
    return this.reportInboxService.getUserReports(admin, userId, query);
  }

  // RPT-25
  @Get('by-user/:userId/summary')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORTER_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "Admin: get one user's totals by status and category" })
  async getUserSummary(@CurrentUser() admin: CurrentUserDto, @Param('userId') userId: string) {
    return this.reportInboxService.getUserSummary(admin, userId);
  }

  // RPT-26
  @Get('by-user/:userId/timeline')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORTER_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "Admin: get one user's reports per month" })
  async getUserTimeline(
    @CurrentUser() admin: CurrentUserDto,
    @Param('userId') userId: string,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportInboxService.getUserTimeline(admin, userId);
  }

  // RPT-27
  @Patch('by-user/:userId/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: "Admin: mark all of one user's reports as read for me" })
  async markUserReportsRead(@CurrentUser() admin: CurrentUserDto, @Param('userId') userId: string) {
    return this.reportInboxService.markUserReportsRead(admin, userId);
  }

  // RPT-160
  @Patch('by-user/:userId/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: "Admin: mark all of one user's reports as unread for me" })
  async markUserReportsUnread(
    @CurrentUser() admin: CurrentUserDto,
    @Param('userId') userId: string,
  ) {
    return this.reportInboxService.markUserReportsUnread(admin, userId);
  }

  // RPT-09
  @Patch('bulk/assign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_ASSIGN)
  @ApiOperation({ summary: 'Super admin: assign many reports to an administrator' })
  async bulkAssign(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkAssignReportsDto) {
    return this.reportWorkflowService.bulkAssign(admin, data);
  }

  // RPT-10
  @Patch('bulk/status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_UPDATE_STATUS)
  @ApiOperation({ summary: 'Admin: change the status of many reports' })
  async bulkUpdateStatus(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: BulkUpdateReportStatusDto,
  ) {
    return this.reportWorkflowService.bulkUpdateStatus(admin, data);
  }

  // RPT-73 — Claims the report for the caller, so it changes state even though it is a GET
  @Get('queue/next')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: take the next report from my queue' })
  async takeNextFromQueue(@CurrentUser() admin: CurrentUserDto, @Query() query: QueueNextQueryDto) {
    return this.reportWorkflowService.queueNext(admin, query);
  }

  // RPT-75
  @Get('escalated')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get escalated reports' })
  async findEscalated(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportListQueryDto) {
    return this.reportWorkflowService.listEscalated(admin, query);
  }

  // RPT-80
  @Patch('bulk/unassign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_ASSIGN)
  @ApiOperation({ summary: 'Super admin: unassign many reports' })
  async bulkUnassign(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkUnassignReportsDto) {
    return this.reportWorkflowService.bulkUnassign(admin, data.ids);
  }

  // RPT-113
  @Get('archived')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get archived reports' })
  async findArchived(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportListQueryDto) {
    return this.reportLifecycleService.listArchived(admin, query);
  }

  // RPT-116
  @Get('trash')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_DELETE)
  @ApiOperation({ summary: 'Super admin: get deleted reports' })
  async findTrash(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportListQueryDto) {
    return this.reportLifecycleService.listTrash(admin, query);
  }

  // RPT-122
  @Get('spam')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get the spam queue' })
  async findSpam(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportListQueryDto) {
    return this.reportLifecycleService.listSpam(admin, query);
  }

  // RPT-164
  @Get('duplicates')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get the suspected duplicates queue' })
  async findSuspectedDuplicates(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportListQueryDto,
  ) {
    return this.reportLifecycleService.listDuplicates(admin, query);
  }

  // RPT-45
  @Get('sla/breaching')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get reports past or near their deadline' })
  async findSlaBreaching(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: SlaBreachingQueryDto,
  ) {
    return this.reportCaseManagementService.listSlaBreaching(admin, query);
  }

  // RPT-49
  @Get('follow-ups')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my due reminders' })
  async findMyFollowUps(@CurrentUser() admin: CurrentUserDto, @Query() query: FollowUpsQueryDto) {
    return this.reportCaseManagementService.listFollowUps(admin, query);
  }

  // RPT-59
  @Patch('bulk/tags')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_TRIAGE)
  @ApiOperation({ summary: 'Admin: tag many reports at once' })
  async bulkTag(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkTagReportsDto) {
    return this.reportCaseManagementService.bulkTag(admin, data);
  }

  // RPT-62
  @Get('watching')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get reports I follow' })
  async findWatching(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportListQueryDto) {
    return this.reportCaseManagementService.listWatching(admin, query);
  }

  // RPT-63
  @Get('views')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my saved filters' })
  async findViews(@CurrentUser() admin: CurrentUserDto) {
    return this.reportCaseManagementService.listViews(admin);
  }

  // RPT-64
  @Post('views')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: save a filter' })
  async createView(@CurrentUser() admin: CurrentUserDto, @Body() data: SaveReportViewDto) {
    return this.reportCaseManagementService.saveView(admin, data);
  }

  // RPT-65
  @Patch('views/:viewId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: edit a saved filter' })
  async updateView(
    @CurrentUser() admin: CurrentUserDto,
    @Param('viewId') viewId: string,
    @Body() data: UpdateReportViewDto,
  ) {
    return this.reportCaseManagementService.updateView(admin, viewId, data);
  }

  // RPT-66
  @Delete('views/:viewId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: delete a saved filter' })
  async deleteView(@CurrentUser() admin: CurrentUserDto, @Param('viewId') viewId: string) {
    return this.reportCaseManagementService.deleteView(admin, viewId);
  }

  // RPT-87
  @Get('information-requests/pending')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_REQUEST_INFO)
  @ApiOperation({ summary: 'Admin: get outstanding and overdue information requests' })
  async findPendingInformationRequests(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: PendingInformationRequestsQueryDto,
  ) {
    return this.reportCommunicationService.listPendingInformationRequests(admin, query);
  }

  // GP-05
  @Get('map')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_LOCATION_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get clustered report pins for the map' })
  async findMapPins(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportMapQueryDto) {
    return this.reportLocationService.getMapPins(admin, query);
  }

  // GP-06
  @Get('nearby')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_LOCATION_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get reports near a point' })
  async findNearby(@CurrentUser() admin: CurrentUserDto, @Query() query: NearbyReportsQueryDto) {
    return this.reportLocationService.findNearby(admin, query);
  }

  // GP-07
  @Get('hotspots')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get heatmap data' })
  async getHotspots(@CurrentUser() admin: CurrentUserDto, @Query() query: HotspotsQueryDto) {
    return this.reportLocationService.getHotspots(admin, query);
  }

  // RPT-11
  @Get('export')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_EXPORT)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'Admin: export reports as CSV (row-capped)' })
  async exportCsv(@CurrentUser() admin: CurrentUserDto, @Query() query: ExportReportsQueryDto) {
    return this.reportExportService.exportReports(admin, query);
  }

  // RPT-128 ★
  @Get('search')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: full-text search of reports' })
  async search(@CurrentUser() admin: CurrentUserDto, @Query() query: SearchReportsQueryDto) {
    return this.reportSearchService.searchReports(admin, query);
  }

  // RPT-129 ★
  @Get('by-reference/:reference')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: find a report by its reference' })
  async findByReference(
    @CurrentUser() admin: CurrentUserDto,
    @Param('reference') reference: string,
  ) {
    return this.reportSearchService.findByReference(admin, reference);
  }

  // RPT-130
  @Get('facets')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get filter sidebar counts' })
  async getFacets(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportStatsQueryDto) {
    return this.reportSearchService.getFacets(admin, query);
  }

  // RPT-131
  @Get('filters/options')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get dropdown values for the report filters' })
  async getFilterOptions(@CurrentUser() admin: CurrentUserDto) {
    return this.reportSearchService.getFilterOptions(admin);
  }

  // RPT-133
  @Post('export-jobs')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_EXPORT)
  @ApiOperation({ summary: 'Admin: start a background export' })
  async startExportJob(@CurrentUser() admin: CurrentUserDto, @Body() data: StartExportJobDto) {
    return this.reportExportService.startExportJob(admin, data);
  }

  // RPT-134
  @Get('export-jobs')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_EXPORT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my exports' })
  async findMyExportJobs(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportListQueryDto) {
    return this.reportExportService.listExportJobs(admin, query);
  }

  // RPT-135
  @Get('export-jobs/:jobId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_EXPORT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get the progress of an export' })
  async getExportJob(@CurrentUser() admin: CurrentUserDto, @Param('jobId') jobId: string) {
    return this.reportExportService.getExportJob(admin, jobId);
  }

  // RPT-136
  @Get('export-jobs/:jobId/download')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_EXPORT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get a download link for an export (audited)' })
  async downloadExportJob(@CurrentUser() admin: CurrentUserDto, @Param('jobId') jobId: string) {
    return this.reportExportService.getExportDownload(admin, jobId);
  }

  // RPT-141
  @Get('categories')
  @ApiOperation({ summary: 'Get the report categories for the submit form' })
  async findCategories() {
    return Object.values(ReportCategory);
  }

  // RPT-33 ★
  @Get('stats/timeline')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get reports per day, week or month' })
  async getStatsTimeline(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: StatsTimelineQueryDto,
  ) {
    return this.reportStatsService.getStatsTimeline(admin, query);
  }

  // RPT-34
  @Get('stats/compare')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: compare against the previous period' })
  async getStatsCompare(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportStatsQueryDto) {
    return this.reportStatsService.getStatsCompare(admin, query);
  }

  // RPT-35
  @Get('stats/by-hour')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get reports by hour and weekday' })
  async getStatsByHour(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportStatsQueryDto) {
    return this.reportStatsService.getStatsByHour(admin, query);
  }

  // RPT-36
  @Get('stats/resolution-time')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get response and close times' })
  async getStatsResolutionTime(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportStatsService.getStatsResolutionTime(admin, query);
  }

  // RPT-37
  @Get('stats/backlog')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get open reports over time' })
  async getStatsBacklog(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportStatsQueryDto) {
    return this.reportStatsService.getStatsBacklog(admin, query);
  }

  // RPT-38
  @Get('stats/by-status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get reports by status' })
  async getStatsByStatus(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportStatsService.getStatsByStatus(admin, query);
  }

  // RPT-39
  @Get('stats/by-category')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get reports by category' })
  async getStatsByCategory(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportStatsService.getStatsByCategory(admin, query);
  }

  // RPT-40
  @Get('stats/by-channel')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get reports by channel' })
  async getStatsByChannel(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportStatsService.getStatsByChannel(admin, query);
  }

  // RPT-41
  @Get('stats/by-admin')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Super admin: get reports per assignee' })
  async getStatsByAdmin(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportStatsQueryDto) {
    return this.reportStatsService.getStatsByAdmin(admin, query);
  }

  // RPT-42
  @Get('stats/by-priority')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get reports by priority' })
  async getStatsByPriority(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportStatsService.getStatsByPriority(admin, query);
  }

  // RPT-43
  @Get('stats/assignment')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get assigned, unassigned and stale counts' })
  async getStatsAssignment(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportCommonService.getStatsAssignment(admin, query);
  }

  // RPT-44 ★
  @Get('stats/overview')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get the whole dashboard in one call' })
  async getStatsOverview(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportStatsService.getStatsOverview(admin, query);
  }

  // RPT-152
  @Get('stats/aging')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get reports by age bucket' })
  async getStatsAging(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportStatsQueryDto) {
    return this.reportStatsService.getStatsAging(admin, query);
  }

  // RPT-153
  @Get('stats/sla')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get the share of reports within SLA' })
  async getStatsSla(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportStatsQueryDto) {
    return this.reportStatsService.getStatsSla(admin, query);
  }

  // RPT-154
  @Get('stats/feedback')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get reporter satisfaction' })
  async getStatsFeedback(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportStatsService.getStatsFeedback(admin, query);
  }

  // RPT-155
  @Get('stats/reopened')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get the reopen rate' })
  async getStatsReopened(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportStatsService.getStatsReopened(admin, query);
  }

  // RPT-156
  @Get('stats/escalations')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get escalation statistics' })
  async getStatsEscalations(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportStatsService.getStatsEscalations(admin, query);
  }

  // RPT-157
  @Get('stats/spam')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get the spam rate' })
  async getStatsSpam(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportStatsQueryDto) {
    return this.reportStatsService.getStatsSpam(admin, query);
  }

  // RPT-158
  @Get('stats/by-tag')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get reports by tag' })
  async getStatsByTag(@CurrentUser() admin: CurrentUserDto, @Query() query: ReportStatsQueryDto) {
    return this.reportStatsService.getStatsByTag(admin, query);
  }

  // GP-08
  @Get('stats/by-region')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get report counts by region' })
  async getStatsByRegion(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ReportStatsQueryDto,
  ) {
    return this.reportStatsService.getStatsByRegion(admin, query);
  }

  @Get(':id')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get one of my reports' })
  async findOne(@CurrentUser() user: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportSubmissionService.findOne(user, reportId);
  }

  @Get(':id/media')
  @ApiOperation({ summary: "Get a short-lived download URL for one of my report's media" })
  async getMedia(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Query() query: MediaKeyQueryDto,
  ) {
    return this.reportReporterService.getMediaDownloadUrl(user, reportId, query.key);
  }

  @Patch(':id')
  @MediaUpload(UpdateReportDto)
  @ApiOperation({ summary: 'Update a pending report' })
  async update(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UpdateReportDto,
  ) {
    return this.reportSubmissionService.update(user, reportId, data);
  }

  @Patch(':id/withdraw')
  @ApiOperation({ summary: 'Withdraw a pending report (reporter)' })
  async withdraw(@CurrentUser() user: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportSubmissionService.withdraw(user, reportId);
  }

  @Get(':id/admin')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORTER_INFO_READ)
  @ApiOperation({ summary: 'Get full report detail including reporter information (admin)' })
  async findOneForAdmin(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportWorkflowService.findOneForAdmin(admin, reportId);
  }

  @Get(':id/admin/media')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORTER_INFO_READ)
  @ApiOperation({ summary: "Admin: get a short-lived download URL for a report's media" })
  async getMediaForAdmin(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Query() query: MediaKeyQueryDto,
  ) {
    return this.reportCaseManagementService.getMediaDownloadUrlForAdmin(admin, reportId, query.key);
  }

  @Get(':id/history')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get the audit timeline for one report' })
  async getHistory(@Param('id') reportId: string) {
    return this.reportWorkflowService.getHistory(reportId);
  }

  @Patch(':id/status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_UPDATE_STATUS)
  @ApiOperation({ summary: 'Update report status (admin)' })
  async updateStatus(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UpdateReportStatusDto,
  ) {
    return this.reportWorkflowService.updateStatus(admin, reportId, data);
  }

  @Get(':id/information-requests')
  @ApiOperation({
    summary:
      'List information requests for a report (reporter sees their own report; admin sees any report they can access)',
  })
  async findInformationRequests(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
  ) {
    return this.reportCommunicationService.findInformationRequests(user, reportId);
  }

  @Get(':id/information-requests/:requestId')
  @ApiOperation({ summary: 'Get a single information request for a report' })
  async findOneInformationRequest(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.reportCommunicationService.findOneInformationRequest(user, reportId, requestId);
  }

  @Patch(':id/request-information')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_REQUEST_INFO)
  @ApiOperation({ summary: 'Request more information from reporter (admin)' })
  async requestMoreInformation(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: RequestMoreInformationDto,
  ) {
    return this.reportCommunicationService.requestMoreInformation(admin, reportId, data);
  }

  @Post(':id/information-requests/:requestId/respond')
  @MediaUpload(RespondToInformationRequestDto, RESPONSE_FILES_FIELDS)
  @ApiOperation({ summary: 'Respond to an admin information request (reporter)' })
  async respondToInformationRequest(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('requestId') requestId: string,
    @Body() data: RespondToInformationRequestDto,
  ) {
    return this.reportCommunicationService.respondToInformationRequest(user, reportId, requestId, data);
  }

  @Patch(':id/assign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_ASSIGN)
  @ApiOperation({ summary: 'Assign report to an administrator (super admin)' })
  async assign(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: AssignReportDto,
  ) {
    return this.reportWorkflowService.assign(admin, reportId, data);
  }

  @Patch(':id/unassign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_ASSIGN)
  @ApiOperation({ summary: 'Unassign report from its current administrator (super admin)' })
  async unassign(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportWorkflowService.unassign(admin, reportId);
  }

  @Patch(':id/escalate')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_ESCALATE)
  @ApiOperation({ summary: 'Escalate an urgent report (admin)' })
  async escalate(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: EscalateReportDto,
  ) {
    return this.reportWorkflowService.escalate(admin, reportId, data);
  }

  // RPT-01 ★
  @Post(':id/evidence')
  @MediaUpload(AddReportEvidenceDto)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiOperation({ summary: 'Add evidence to my report after submission' })
  async addEvidence(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: AddReportEvidenceDto,
    @Req() req: Request,
  ) {
    const body = req.body as Record<string, unknown>;
    const files = Object.values(MediaFolder)
      .flatMap((folder) => ([] as unknown[]).concat(body[folder] ?? []))
      .filter((key): key is string => typeof key === 'string')
      .map((storageKey) => ({ storageKey }));

    return this.reportReporterService.addEvidence(user, reportId, files, data, { ip: req.ip });
  }

  // RPT-02
  @Post(':id/messages')
  @MediaUpload(CreateReportMessageDto)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiOperation({ summary: 'Send a follow-up note on my report' })
  async addMessage(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: CreateReportMessageDto,
  ) {
    return this.reportCommunicationService.createMessage(user, reportId, data);
  }

  // RPT-03 — Service: the reporter must own the report; an admin needs REPORT_READ and access to it
  @Get(':id/messages')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get the follow-up thread of a report (reporter or admin)' })
  async findMessages(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Query() query: PageQueryDto,
  ) {
    return this.reportCommunicationService.listMessages(user, reportId, query);
  }

  // RPT-04
  @Post(':id/reopen-request')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Ask for a closed report to be reopened' })
  async requestReopen(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: RequestReopenDto,
  ) {
    return this.reportReporterService.requestReopen(user, reportId, data);
  }

  // RPT-05
  @Post(':id/feedback')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rate how my report was handled' })
  async submitFeedback(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: ReportFeedbackDto,
  ) {
    return this.reportReporterService.submitFeedback(user, reportId, data);
  }

  // GP-01 — Needs the location schema change first
  @Post(':id/location')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Attach the incident location to my report' })
  async attachLocation(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: AttachReportLocationDto,
  ) {
    return this.reportLocationService.attachLocation(user, reportId, data);
  }

  // RPT-31
  @Patch(':id/seen')
  @ApiOperation({ summary: 'Mark the latest update on my report as seen' })
  async markUpdatesSeen(@CurrentUser() user: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportReporterService.markSeen(user, reportId);
  }

  // RPT-99 ★
  @Get(':id/timeline')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get the status history of my report, without internal notes' })
  async getReporterTimeline(@CurrentUser() user: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportReporterService.getReporterTimeline(user, reportId);
  }

  // RPT-101
  @Get(':id/pdf')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Download my report as a PDF' })
  async downloadPdf(@CurrentUser() user: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportReporterService.generateMyReportPdf(user, reportId);
  }

  // RPT-102 — Service refuses while a legal hold is set
  @Post(':id/delete-request')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiOperation({ summary: 'Ask for my report to be erased' })
  async requestErasure(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: ReportDeleteRequestDto,
  ) {
    return this.reportReporterService.requestErasure(user, reportId, data);
  }

  // RPT-103
  @Patch(':id/mute')
  @ApiOperation({ summary: 'Mute or unmute updates for my report' })
  async muteUpdates(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: MuteReportDto,
  ) {
    return this.reportReporterService.muteReport(user, reportId, data);
  }

  // RPT-161 ★ — No re-auth on purpose: this must work in an emergency
  @Post(':id/urgent')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Flag immediate danger; auto-escalates and alerts the on-duty admin' })
  async flagUrgent(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UrgentReportDto,
  ) {
    return this.reportReporterService.flagUrgent(user, reportId, data);
  }

  // RPT-162
  @Patch(':id/contact-preference')
  @ApiOperation({ summary: 'Choose how staff may contact me' })
  async setContactPreference(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: ContactPreferenceDto,
  ) {
    return this.reportReporterService.setContactPreference(user, reportId, data);
  }

  // RPT-163 — Policy decision: confirm the rule before building
  @Patch(':id/anonymity')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Change whether staff can see my identity' })
  async changeAnonymity(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: ChangeAnonymityDto,
  ) {
    return this.reportReporterService.changeAnonymity(user, reportId, data);
  }

  // RPT-14 ★
  @Patch(':id/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: mark one report as read for me' })
  async markRead(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportInboxService.markRead(admin, reportId);
  }

  // RPT-15 ★
  @Patch(':id/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: mark one report as unread for me' })
  async markUnread(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportInboxService.markUnread(admin, reportId);
  }

  // RPT-06 ★
  @Patch(':id/category')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_TRIAGE)
  @ApiOperation({ summary: 'Admin: correct the category of a report' })
  async updateCategory(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UpdateReportCategoryDto,
  ) {
    return this.reportWorkflowService.updateCategory(admin, reportId, data);
  }

  // RPT-07 ★
  @Patch(':id/priority')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_TRIAGE)
  @ApiOperation({ summary: 'Admin: set the priority of a report' })
  async updatePriority(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UpdateReportPriorityDto,
  ) {
    return this.reportWorkflowService.updatePriority(admin, reportId, data);
  }

  // RPT-08 ★
  @Post(':id/resolve')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_UPDATE_STATUS)
  @ApiOperation({ summary: 'Admin: close a report with an outcome and summary' })
  async resolve(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: ResolveReportDto,
  ) {
    return this.reportWorkflowService.resolve(admin, reportId, data);
  }

  // RPT-12
  @Get(':id/related')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get reports related to this one' })
  async findRelated(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportLifecycleService.findRelated(admin, reportId);
  }

  // RPT-13
  @Post(':id/merge')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_TRIAGE)
  @ApiOperation({ summary: 'Admin: merge a duplicate report into another' })
  async merge(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: MergeReportDto,
  ) {
    return this.reportLifecycleService.merge(admin, reportId, data);
  }

  // RPT-72
  @Patch(':id/assign-team')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_ASSIGN)
  @ApiOperation({ summary: 'Super admin: assign a report to a team queue' })
  async assignTeam(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: AssignTeamDto,
  ) {
    return this.reportWorkflowService.assignTeam(admin, reportId, data);
  }

  // RPT-74
  @Patch(':id/de-escalate')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_ESCALATE)
  @ApiOperation({ summary: 'Admin: lower an escalation' })
  async deEscalate(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: DeEscalateReportDto,
  ) {
    return this.reportWorkflowService.deEscalate(admin, reportId, data);
  }

  // RPT-76
  @Get(':id/escalations')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get the escalation history of a report' })
  async findEscalations(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportWorkflowService.getEscalations(admin, reportId);
  }

  // RPT-81
  @Get(':id/transitions')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get the statuses a report may move to next' })
  async getAllowedTransitions(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportWorkflowService.getAllowedTransitions(admin, reportId);
  }

  // RPT-111
  @Patch(':id/archive')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_UPDATE_STATUS)
  @ApiOperation({ summary: 'Admin: archive a report' })
  async archive(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: ArchiveReportDto,
  ) {
    return this.reportLifecycleService.archive(admin, reportId, data);
  }

  // RPT-112
  @Patch(':id/unarchive')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_UPDATE_STATUS)
  @ApiOperation({ summary: 'Admin: unarchive a report' })
  async unarchive(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportLifecycleService.unarchive(admin, reportId);
  }

  // RPT-114 — Service refuses while a legal hold is set
  @Delete(':id')
  @RequireReauthentication()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_DELETE)
  @ApiOperation({ summary: 'Super admin: soft delete a report' })
  async softDelete(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Query() query: SoftDeleteReportQueryDto,
  ) {
    return this.reportLifecycleService.softDelete(admin, reportId, query);
  }

  // RPT-115
  @Post(':id/restore')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_DELETE)
  @ApiOperation({ summary: 'Super admin: restore a deleted report' })
  async restore(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportLifecycleService.restore(admin, reportId);
  }

  // RPT-119
  @Post(':id/mark-spam')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_UPDATE_STATUS)
  @ApiOperation({ summary: 'Admin: mark a report as spam' })
  async markSpam(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: MarkSpamDto,
  ) {
    return this.reportLifecycleService.markSpam(admin, reportId, data);
  }

  // RPT-120
  @Post(':id/mark-false')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_UPDATE_STATUS)
  @ApiOperation({ summary: 'Admin: mark a report as false or malicious' })
  async markFalse(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: MarkFalseReportDto,
  ) {
    return this.reportLifecycleService.markFalse(admin, reportId, data);
  }

  // RPT-121
  @Patch(':id/unmark')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_UPDATE_STATUS)
  @ApiOperation({ summary: 'Admin: undo a spam or false mark' })
  async unmark(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UnmarkReportDto,
  ) {
    return this.reportLifecycleService.unmark(admin, reportId, data);
  }

  // RPT-123
  @Get(':id/links')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get records linked to a report' })
  async findLinks(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportLifecycleService.getLinks(admin, reportId);
  }

  // RPT-124
  @Post(':id/links')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_TRIAGE)
  @ApiOperation({ summary: 'Admin: link a record to a report' })
  async addLink(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: LinkReportRecordDto,
  ) {
    return this.reportLifecycleService.addLink(admin, reportId, data);
  }

  // RPT-125
  @Delete(':id/links/:linkId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_TRIAGE)
  @ApiOperation({ summary: 'Admin: remove a link from a report' })
  async removeLink(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.reportLifecycleService.removeLink(admin, reportId, linkId);
  }

  // RPT-126
  @Post(':id/unmerge')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_TRIAGE)
  @ApiOperation({ summary: 'Admin: undo a merge' })
  async unmerge(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UnmergeReportDto,
  ) {
    return this.reportLifecycleService.unmerge(admin, reportId, data);
  }

  // RPT-127
  @Get(':id/merge-history')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get the merge history of a report' })
  async findMergeHistory(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportLifecycleService.getMergeHistory(admin, reportId);
  }

  // RPT-165
  @Post(':id/split')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_TRIAGE)
  @ApiOperation({ summary: 'Admin: split one report into two' })
  async split(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: SplitReportDto,
  ) {
    return this.reportLifecycleService.split(admin, reportId, data);
  }

  // RPT-46
  @Get(':id/sla')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get the SLA clock of a report' })
  async getSla(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportCaseManagementService.getSla(admin, reportId);
  }

  // RPT-47
  @Patch(':id/due-date')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_TRIAGE)
  @ApiOperation({ summary: 'Admin: set or extend the due date of a report' })
  async setDueDate(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: SetDueDateDto,
  ) {
    return this.reportCaseManagementService.setDueDate(admin, reportId, data);
  }

  // RPT-48
  @Post(':id/follow-up')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: set a reminder for myself on a report' })
  async createFollowUp(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: CreateFollowUpDto,
  ) {
    return this.reportCaseManagementService.createFollowUp(admin, reportId, data);
  }

  // RPT-57
  @Post(':id/tags')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_TRIAGE)
  @ApiOperation({ summary: 'Admin: add tags to a report' })
  async addTags(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: AddReportTagsDto,
  ) {
    return this.reportCaseManagementService.addTags(admin, reportId, data);
  }

  // RPT-58
  @Delete(':id/tags/:tagId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_TRIAGE)
  @ApiOperation({ summary: 'Admin: remove a tag from a report' })
  async removeTag(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('tagId') tagId: string,
  ) {
    return this.reportCaseManagementService.removeTag(admin, reportId, tagId);
  }

  // RPT-60
  @Post(':id/watch')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: follow a report' })
  async watch(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportCaseManagementService.watch(admin, reportId);
  }

  // RPT-61
  @Delete(':id/watch')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: unfollow a report' })
  async unwatch(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportCaseManagementService.unwatch(admin, reportId);
  }

  // RPT-82 — Service: the reporter must own the report; an admin needs REPORT_READ and access to it
  @Get(':id/evidence')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get the evidence list of a report (reporter or admin)' })
  async findEvidence(@CurrentUser() user: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportCaseManagementService.listEvidence(user, reportId);
  }

  // RPT-83 — Uses the evidence record id, not the storage key, because keys contain slashes
  @Delete(':id/evidence/:evidenceId')
  @RequireReauthentication()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_EVIDENCE_MANAGE)
  @ApiOperation({ summary: 'Admin: remove evidence from a report' })
  async removeEvidence(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('evidenceId') evidenceId: string,
    @Query() query: EvidenceRemovalQueryDto,
  ) {
    return this.reportCaseManagementService.removeEvidence(admin, reportId, evidenceId, query);
  }

  // RPT-84
  @Get(':id/evidence/:evidenceId/custody')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORT_AUDIT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get who viewed an evidence file' })
  async findEvidenceCustody(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('evidenceId') evidenceId: string,
  ) {
    return this.reportCaseManagementService.getEvidenceCustody(admin, reportId, evidenceId);
  }

  // RPT-85
  @Post(':id/evidence/:evidenceId/redact')
  @RequireReauthentication()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_EVIDENCE_MANAGE)
  @ApiOperation({ summary: 'Admin: redact an evidence file' })
  async redactEvidence(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('evidenceId') evidenceId: string,
    @Body() data: RedactEvidenceDto,
  ) {
    return this.reportCaseManagementService.redactEvidence(admin, reportId, evidenceId, data);
  }

  // RPT-86 — Service writes an audit event
  @Get(':id/case-file')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORTER_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get the printable case file' })
  async getCaseFile(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportCaseManagementService.getCaseFile(admin, reportId);
  }

  // RPT-89
  @Patch(':id/information-requests/:requestId/cancel')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_REQUEST_INFO)
  @ApiOperation({ summary: 'Admin: withdraw an information request' })
  async cancelInformationRequest(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('requestId') requestId: string,
    @Body() data: CancelInformationRequestDto,
  ) {
    return this.reportCommunicationService.cancelInformationRequest(admin, reportId, requestId, data);
  }

  // RPT-90
  @Post(':id/information-requests/:requestId/remind')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_REQUEST_INFO)
  @ApiOperation({ summary: 'Admin: remind the reporter about an information request' })
  async remindInformationRequest(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.reportCommunicationService.remindInformationRequest(admin, reportId, requestId);
  }

  // RPT-91
  @Patch(':id/information-requests/:requestId/extend')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_REQUEST_INFO)
  @ApiOperation({ summary: 'Admin: extend the deadline of an information request' })
  async extendInformationRequest(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('requestId') requestId: string,
    @Body() data: ExtendInformationRequestDto,
  ) {
    return this.reportCommunicationService.extendInformationRequest(admin, reportId, requestId, data);
  }

  // RPT-92
  @Patch(':id/information-requests/:requestId/review')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_REQUEST_INFO)
  @ApiOperation({ summary: 'Admin: accept a response or ask again' })
  async reviewInformationResponse(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('requestId') requestId: string,
    @Body() data: ReviewInformationResponseDto,
  ) {
    return this.reportCommunicationService.reviewInformationResponse(admin, reportId, requestId, data);
  }

  // RPT-104 ★
  @Patch(':id/sensitivity')
  @RequireReauthentication()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_SENSITIVITY_MANAGE)
  @ApiOperation({ summary: 'Admin: mark a report restricted or child-involved' })
  async updateSensitivity(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UpdateReportSensitivityDto,
  ) {
    return this.reportAccessService.updateSensitivity(admin, reportId, data);
  }

  // RPT-105 ★
  @Get(':id/access-log')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_AUDIT_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Super admin: get who viewed a report' })
  async findAccessLog(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Query() query: AccessLogQueryDto,
  ) {
    return this.reportAccessService.getAccessLog(admin, reportId, query);
  }

  // RPT-106
  @Get(':id/access-grants')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_SENSITIVITY_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Super admin: get who may open a restricted report' })
  async findAccessGrants(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportAccessService.listAccessGrants(admin, reportId);
  }

  // RPT-107
  @Post(':id/access-grants')
  @RequireReauthentication()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_SENSITIVITY_MANAGE)
  @ApiOperation({ summary: 'Super admin: grant an administrator access to a report' })
  async grantAccess(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: GrantReportAccessDto,
  ) {
    return this.reportAccessService.grantAccess(admin, reportId, data);
  }

  // RPT-108
  @Delete(':id/access-grants/:adminId')
  @RequireReauthentication()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_SENSITIVITY_MANAGE)
  @ApiOperation({ summary: "Super admin: revoke an administrator's access to a report" })
  async revokeAccess(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('adminId') adminId: string,
  ) {
    return this.reportAccessService.revokeAccess(admin, reportId, adminId);
  }

  // RPT-109 — Always audited; reason is required
  @Post(':id/reveal-reporter')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @RequireReauthentication()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_REVEAL_REPORTER)
  @ApiOperation({ summary: "Super admin: break-glass reveal of the reporter's identity" })
  async revealReporter(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: RevealReporterDto,
  ) {
    return this.reportAccessService.revealReporter(admin, reportId, data);
  }

  // RPT-110
  @Patch(':id/legal-hold')
  @RequireReauthentication()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_SENSITIVITY_MANAGE)
  @ApiOperation({ summary: 'Super admin: set or clear a legal hold that blocks deletion' })
  async setLegalHold(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: LegalHoldDto,
  ) {
    return this.reportAccessService.setLegalHold(admin, reportId, data);
  }

  // GP-09 — Service writes an audit event
  @Get(':id/location')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_LOCATION_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get the precise incident location (audited)' })
  async getLocation(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportLocationService.getLocation(admin, reportId);
  }

  // GP-10
  @Patch(':id/location')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_LOCATION_UPDATE)
  @ApiOperation({ summary: 'Admin: correct or verify the incident location' })
  async updateLocation(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UpdateReportLocationDto,
  ) {
    return this.reportLocationService.updateLocation(admin, reportId, data);
  }

  // EM-20 — Needs inbound email intake
  @Get(':id/emails')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORTER_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get the email thread of a report' })
  async findEmails(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Query() query: PageQueryDto,
  ) {
    return this.reportCommunicationService.listEmails(admin, reportId, query);
  }

  // EM-21 — Needs inbound email intake
  @Post(':id/email-reply')
  @RequireReauthentication()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_EMAIL_REPLY, PermissionsEnum.REPORTER_INFO_READ)
  @ApiOperation({ summary: 'Admin: reply to the reporter by email' })
  async replyByEmail(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: ReplyToReportEmailDto,
  ) {
    return this.reportCommunicationService.replyToEmail(admin, reportId, data);
  }

  // RPT-132
  @Get(':id/revisions')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get the field-level history of a report' })
  async findRevisions(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Query() query: PageQueryDto,
  ) {
    return this.reportSearchService.getRevisions(admin, reportId, query);
  }
}

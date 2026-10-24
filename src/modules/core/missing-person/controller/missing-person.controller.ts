import { MediaUpload } from 'src/common/decorators/media-upload.decorator';
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

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { MissingPersonStatus } from '@prisma/client';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { MediaKeyQueryDto } from 'src/modules/media/dto/media-key-query.dto';

import {
  AdminCreateMissingPersonDto,
  AdminEditMissingPersonDto,
  AdminMissingPersonExportDto,
  AdminRenewMissingPersonDto,
  AdminSearchMissingPersonsQueryDto,
  AppealMissingPersonRejectionDto,
  AssignMissingPersonDto,
  BulkAssignMissingPersonDto,
  BulkExpireMissingPersonDto,
  BulkMissingPersonIdsDto,
  BulkRejectMissingPersonDto,
  CorrectMissingPersonChildFlagDto,
  CreateMissingPersonDto,
  CreateMissingPersonUpdateDto,
  DecideMissingPersonAppealDto,
  DeleteMissingPersonAdminDto,
  FlagMissingPersonDto,
  LiftTakedownMissingPersonDto,
  ListMissingPersonAppealsQueryDto,
  ListMissingPersonFlagsQueryDto,
  ListMissingPersonsAdminQueryDto,
  ListMissingPersonsQueryDto,
  MarkAllMissingPersonsReadDto,
  MergeMissingPersonDto,
  MessageMissingPersonOwnerDto,
  MissingPersonFoundReportDto,
  MissingPersonLegalHoldDto,
  MissingPersonStatsQueryDto,
  MissingPersonStatsTimelineQueryDto,
  PaginationQueryDto,
  RecentMissingPersonsQueryDto,
  RedactMissingPersonMediaDto,
  ReopenMissingPersonDto,
  RenewMissingPersonDto,
  ResolveMissingPersonFlagDto,
  RestoreMissingPersonDto,
  SearchMissingPersonsQueryDto,
  TakedownMissingPersonDto,
  UpdateMissingPersonDto,
  UpdateMissingPersonStatusDto,
  VerifyFoundMissingPersonDto,
} from '../dto/missing-person.dto';

import { MissingPersonSubmissionService } from '../service/missing-person-submission.service';
import { MissingPersonMineService } from '../service/missing-person-mine.service';
import { MissingPersonCaseUpdatesService } from '../service/missing-person-case-updates.service';
import { MissingPersonPublicService } from '../service/missing-person-public.service';
import { MissingPersonReviewService } from '../service/missing-person-review.service';
import { MissingPersonModerationService } from '../service/missing-person-moderation.service';
import { MissingPersonAdminOpsService } from '../service/missing-person-admin-ops.service';
import { MissingPersonDuplicatesService } from '../service/missing-person-duplicates.service';
import { MissingPersonMediaAdminService } from '../service/missing-person-media-admin.service';
import { MissingPersonSearchService } from '../service/missing-person-search.service';
import { MissingPersonInboxService } from '../service/missing-person-inbox.service';
import { MissingPersonExportService } from '../service/missing-person-export.service';
import { MissingPersonStatsService } from '../service/missing-person-stats.service';

@ApiTags('Missing Persons')
@Controller('missing-persons')
export class MissingPersonController {
  constructor(
    private readonly missingPersonSubmissionService: MissingPersonSubmissionService,
    private readonly missingPersonMineService: MissingPersonMineService,
    private readonly missingPersonCaseUpdatesService: MissingPersonCaseUpdatesService,
    private readonly missingPersonPublicService: MissingPersonPublicService,
    private readonly missingPersonReviewService: MissingPersonReviewService,
    private readonly missingPersonModerationService: MissingPersonModerationService,
    private readonly missingPersonAdminOpsService: MissingPersonAdminOpsService,
    private readonly missingPersonDuplicatesService: MissingPersonDuplicatesService,
    private readonly missingPersonMediaAdminService: MissingPersonMediaAdminService,
    private readonly missingPersonSearchService: MissingPersonSearchService,
    private readonly missingPersonInboxService: MissingPersonInboxService,
    private readonly missingPersonExportService: MissingPersonExportService,
    private readonly missingPersonStatsService: MissingPersonStatsService,
  ) {}

  @Post()
  @MediaUpload(CreateMissingPersonDto)
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Submit a missing person report' })
  async create(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateMissingPersonDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.missingPersonSubmissionService.create(user, data, idempotencyKey);
  }

  @Get('admin/stats')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get missing person statistics for the dashboard' })
  async getStats() {
    return this.missingPersonStatsService.getStats();
  }

  // Admin creates a case directly. CHILD cases still need two-admin approval.
  @Post('admin')
  @MediaUpload(AdminCreateMissingPersonDto)
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: create a missing person case directly' })
  async createByAdmin(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: AdminCreateMissingPersonDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.missingPersonSubmissionService.createByAdmin(admin, data, idempotencyKey);
  }

  @Get('mine')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get my missing person submissions' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findMine(@CurrentUser() user: CurrentUserDto, @Query() query: ListMissingPersonsQueryDto) {
    return this.missingPersonMineService.findMine(user, query);
  }

  @Get('mine/summary')
  @ApiBearerAuth('access-token')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get my case counts by status' })
  async getMySummary(@CurrentUser() user: CurrentUserDto) {
    return this.missingPersonMineService.getMySummary(user);
  }

  @Get('mine/unread-updates/count')
  @ApiBearerAuth('access-token')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Count my cases with a status change or admin message I have not seen' })
  async countMyUnreadUpdates(@CurrentUser() user: CurrentUserDto) {
    return this.missingPersonMineService.countMyUnreadUpdates(user);
  }

  @Patch('mine/seen-all')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Mark all updates on my cases as seen' })
  async markAllMineSeen(@CurrentUser() user: CurrentUserDto) {
    return this.missingPersonMineService.markAllMineSeen(user);
  }

  @Get('mine/:id/media')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: "Get a short-lived download URL for one of my own submission's media" })
  async getMediaForOwner(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: MediaKeyQueryDto,
  ) {
    return this.missingPersonMineService.getMediaDownloadUrlForOwner(user, id, query.key);
  }

  @Get('mine/:id')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get one of my cases with review notes and requested changes' })
  async findOneMine(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonMineService.findOneMine(user, id);
  }

  @Get('mine/:id/timeline')
  @ApiBearerAuth('access-token')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get the family-facing review and update timeline for my case' })
  async getMyTimeline(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonMineService.getMyTimeline(user, id);
  }

  @Patch('mine/:id/found')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Report my missing person as found, pending admin verification' })
  async reportFound(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: MissingPersonFoundReportDto,
  ) {
    return this.missingPersonMineService.reportFoundByOwner(user, id, data);
  }

  @Post('mine/:id/renew')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Extend my listing before it expires' })
  async renewMine(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: RenewMissingPersonDto,
  ) {
    return this.missingPersonCaseUpdatesService.renewByOwner(user, id, data);
  }

  @Post('mine/:id/updates')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Add a public update to my case' })
  async addMyUpdate(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: CreateMissingPersonUpdateDto,
  ) {
    return this.missingPersonCaseUpdatesService.addOwnerUpdate(user, id, data);
  }

  @Get('mine/:id/updates')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'List the updates I posted on my case' })
  async listMyUpdates(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.missingPersonCaseUpdatesService.listOwnerUpdates(user, id, query);
  }

  @Delete('mine/:id/media/:key')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Remove one photo or file from my case' })
  async removeMyMedia(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Param('key') key: string,
  ) {
    return this.missingPersonCaseUpdatesService.removeOwnerMedia(user, id, key);
  }

  @Get('mine/:id/tips')
  @ApiBearerAuth('access-token')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get a summary of tips received on my case, without informant identity',
  })
  async getMyTipsSummary(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonMineService.getMyTipsSummary(user, id);
  }

  @Patch('mine/:id/seen')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Mark the latest update on my case as seen' })
  async markMineSeen(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonMineService.markMineSeen(user, id);
  }

  @Post('mine/:id/appeal')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Appeal the rejection of my case' })
  async appealMine(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AppealMissingPersonRejectionDto,
  ) {
    return this.missingPersonMineService.appealRejection(user, id, data);
  }

  @Post('mine/:id/duplicate')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Copy my case into a new draft for a related case' })
  async duplicateMine(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.missingPersonSubmissionService.duplicateAsDraft(user, id, idempotencyKey);
  }

  @Get()
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get approved missing persons (requires login)' })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAll(@Query() query: ListMissingPersonsQueryDto) {
    return this.missingPersonPublicService.findAll(query);
  }

  @Get('search')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Search approved missing persons by name, area or description' })
  async search(@Query() query: SearchMissingPersonsQueryDto) {
    return this.missingPersonPublicService.search(query);
  }

  @Get('stats')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get active and found counts for a logged-in dashboard' })
  async getPublicStats() {
    return this.missingPersonPublicService.getPublicStats();
  }

  @Get('recent')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get the newest approved missing persons' })
  async findRecent(@Query() query: RecentMissingPersonsQueryDto) {
    return this.missingPersonPublicService.findRecent(query);
  }

  // Literal admin routes come before ':id' so they are not swallowed.
  @Get('admin/all')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get all missing person submissions' })
  @ApiQuery({ name: 'status', required: false, enum: MissingPersonStatus })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAllForAdmin(@Query() query: ListMissingPersonsAdminQueryDto) {
    return this.missingPersonAdminOpsService.findAllForAdmin(query);
  }

  @Get('admin/stale')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: get unreviewed missing person cases that have waited too long' })
  async findStalePending() {
    return this.missingPersonReviewService.findStalePending();
  }

  @Patch('admin/bulk/read')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: mark many cases read' })
  async bulkMarkRead(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkMissingPersonIdsDto) {
    return this.missingPersonInboxService.bulkMarkRead(admin, data.ids);
  }

  @Patch('admin/bulk/unread')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: mark many cases unread' })
  async bulkMarkUnread(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: BulkMissingPersonIdsDto,
  ) {
    return this.missingPersonInboxService.bulkMarkUnread(admin, data.ids);
  }

  @Patch('admin/bulk/assign')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Super admin: assign many cases to a reviewer' })
  async bulkAssign(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkAssignMissingPersonDto) {
    return this.missingPersonReviewService.bulkAssign(admin, data.ids, data.adminId);
  }

  @Patch('admin/bulk/approve')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: approve many low-risk cases' })
  async bulkApprove(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkMissingPersonIdsDto) {
    return this.missingPersonReviewService.bulkApprove(admin, data.ids);
  }

  @Patch('admin/bulk/reject')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: reject many cases with one reason' })
  async bulkReject(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkRejectMissingPersonDto) {
    return this.missingPersonReviewService.bulkReject(admin, data.ids, data.reviewNote);
  }

  @Patch('admin/bulk/expire')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: expire many old cases with a reason' })
  async bulkExpire(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkExpireMissingPersonDto) {
    return this.missingPersonReviewService.bulkExpire(admin, data.ids, data.reason);
  }

  @Patch('admin/read-all')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: mark all cases matching a filter read' })
  async markAllRead(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: MarkAllMissingPersonsReadDto,
  ) {
    return this.missingPersonInboxService.markAllRead(admin, data);
  }

  @Get('admin/unread')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread cases' })
  async findUnread(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ListMissingPersonsAdminQueryDto,
  ) {
    return this.missingPersonInboxService.findUnread(admin, query);
  }

  @Get('admin/unread/count')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread badge count' })
  async countUnread(@CurrentUser() admin: CurrentUserDto) {
    return this.missingPersonInboxService.countUnread(admin);
  }

  @Get('admin/unread/count/by-status')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread count by status' })
  async countUnreadByStatus(@CurrentUser() admin: CurrentUserDto) {
    return this.missingPersonInboxService.countUnreadByStatus(admin);
  }

  @Get('admin/unread/count/by-area')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread count by area' })
  async countUnreadByArea(@CurrentUser() admin: CurrentUserDto) {
    return this.missingPersonInboxService.countUnreadByArea(admin);
  }

  @Get('admin/counts')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get total, read and unread counts' })
  async getReadCounts(@CurrentUser() admin: CurrentUserDto) {
    return this.missingPersonInboxService.getReadCounts(admin);
  }

  @Get('admin/by-owner')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: one row per owner with total, read, unread and pending' })
  async listByOwner(@CurrentUser() admin: CurrentUserDto, @Query() query: PaginationQueryDto) {
    return this.missingPersonInboxService.listByOwner(admin, query);
  }

  @Get('admin/by-owner/repeat-rejections')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: owners with repeated rejections or suspected false listings' })
  async listRepeatRejections(@Query() query: PaginationQueryDto) {
    return this.missingPersonInboxService.listRepeatRejections(query);
  }

  @Get('admin/by-owner/:ownerId')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "Admin: get one owner's cases with isRead" })
  async findByOwner(
    @CurrentUser() admin: CurrentUserDto,
    @Param('ownerId') ownerId: string,
    @Query() query: ListMissingPersonsAdminQueryDto,
  ) {
    return this.missingPersonInboxService.findByOwner(admin, ownerId, query);
  }

  @Get('admin/by-owner/:ownerId/summary')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "Admin: get one owner's totals by status" })
  async getOwnerSummary(@CurrentUser() admin: CurrentUserDto, @Param('ownerId') ownerId: string) {
    return this.missingPersonInboxService.getOwnerSummary(admin, ownerId);
  }

  @Patch('admin/by-owner/:ownerId/read')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: "Admin: mark all of an owner's cases read" })
  async markOwnerRead(@CurrentUser() admin: CurrentUserDto, @Param('ownerId') ownerId: string) {
    return this.missingPersonInboxService.markOwnerRead(admin, ownerId);
  }

  @Patch('admin/by-owner/:ownerId/unread')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: "Admin: mark all of an owner's cases unread" })
  async markOwnerUnread(@CurrentUser() admin: CurrentUserDto, @Param('ownerId') ownerId: string) {
    return this.missingPersonInboxService.markOwnerUnread(admin, ownerId);
  }

  @Get('admin/flags')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get the reader flag queue' })
  async listFlags(@Query() query: ListMissingPersonFlagsQueryDto) {
    return this.missingPersonModerationService.listFlags(query);
  }

  @Patch('admin/flags/:flagId')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({
    summary: 'Admin: resolve a flag by dismissing, hiding the case or warning the owner',
  })
  async resolveFlag(
    @CurrentUser() admin: CurrentUserDto,
    @Param('flagId') flagId: string,
    @Body() data: ResolveMissingPersonFlagDto,
  ) {
    return this.missingPersonModerationService.resolveFlag(admin, flagId, data);
  }

  @Get('admin/found-claims')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get owner found reports waiting for verification' })
  async listFoundClaims(@Query() query: PaginationQueryDto) {
    return this.missingPersonReviewService.listFoundClaims(query);
  }

  @Get('admin/appeals')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get appeals against rejections' })
  async listAppeals(@Query() query: ListMissingPersonAppealsQueryDto) {
    return this.missingPersonModerationService.listAppeals(query);
  }

  @Patch('admin/appeals/:appealId')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: decide an appeal with a reason' })
  async decideAppeal(
    @CurrentUser() admin: CurrentUserDto,
    @Param('appealId') appealId: string,
    @Body() data: DecideMissingPersonAppealDto,
  ) {
    return this.missingPersonModerationService.decideAppeal(admin, appealId, data);
  }

  @Get('admin/duplicates')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get the queue of suspected duplicate cases' })
  async listDuplicates(@Query() query: PaginationQueryDto) {
    return this.missingPersonDuplicatesService.listDuplicates(query);
  }

  @Get('admin/trash')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Super admin: list deleted cases' })
  async listTrash(@Query() query: PaginationQueryDto) {
    return this.missingPersonAdminOpsService.listTrash(query);
  }

  @Get('admin/search')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: full-text search across all cases' })
  async searchForAdmin(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: AdminSearchMissingPersonsQueryDto,
  ) {
    return this.missingPersonSearchService.searchForAdmin(admin, query);
  }

  @Get('admin/facets')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: get counts for the filter sidebar' })
  async getFacets() {
    return this.missingPersonSearchService.getFacets();
  }

  @Get('admin/filters/options')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: get dropdown values for filters' })
  async getFilterOptions() {
    return this.missingPersonSearchService.getFilterOptions();
  }

  @Get('admin/export')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: export cases as CSV, row-capped and audited' })
  async exportCsv(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: AdminMissingPersonExportDto,
  ) {
    return this.missingPersonExportService.exportCsv(admin, query);
  }

  @Post('admin/export-jobs')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: start a background export' })
  async startExportJob(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: AdminMissingPersonExportDto,
  ) {
    return this.missingPersonExportService.startExportJob(admin, data);
  }

  @Get('admin/export-jobs/:id')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get the progress of an export job' })
  async getExportJob(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonExportService.getExportJob(admin, id);
  }

  @Get('admin/export-jobs/:id/download')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get a short-lived download link for an export, audited' })
  async downloadExportJob(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonExportService.getExportJobDownloadUrl(admin, id);
  }

  @Get('admin/stats/timeline')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: cases per day, week or month' })
  async getStatsTimeline(@Query() query: MissingPersonStatsTimelineQueryDto) {
    return this.missingPersonStatsService.getStatsTimeline(query);
  }

  @Get('admin/stats/by-status')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: cases by status' })
  async getStatsByStatus(@Query() query: MissingPersonStatsQueryDto) {
    return this.missingPersonStatsService.getStatsByStatus(query);
  }

  @Get('admin/stats/by-area')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: cases by region and area' })
  async getStatsByArea(@Query() query: MissingPersonStatsQueryDto) {
    return this.missingPersonStatsService.getStatsByArea(query);
  }

  @Get('admin/stats/by-demographics')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: cases by age group and gender' })
  async getStatsByDemographics(@Query() query: MissingPersonStatsQueryDto) {
    return this.missingPersonStatsService.getStatsByDemographics(query);
  }

  @Get('admin/stats/resolution-time')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: time from listing to found' })
  async getStatsResolutionTime(@Query() query: MissingPersonStatsQueryDto) {
    return this.missingPersonStatsService.getStatsResolutionTime(query);
  }

  @Get('admin/stats/found-rate')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: found against still missing, over time' })
  async getStatsFoundRate(@Query() query: MissingPersonStatsQueryDto) {
    return this.missingPersonStatsService.getStatsFoundRate(query);
  }

  @Get('admin/stats/review-time')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: time to first review and decision' })
  async getStatsReviewTime(@Query() query: MissingPersonStatsQueryDto) {
    return this.missingPersonStatsService.getStatsReviewTime(query);
  }

  @Get('admin/stats/backlog')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: pending cases over time' })
  async getStatsBacklog(@Query() query: MissingPersonStatsQueryDto) {
    return this.missingPersonStatsService.getStatsBacklog(query);
  }

  @Get('admin/stats/aging')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: pending cases by age bucket' })
  async getStatsAging(@Query() query: MissingPersonStatsQueryDto) {
    return this.missingPersonStatsService.getStatsAging(query);
  }

  @Get('admin/stats/tips')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: tips per case and time to first tip' })
  async getStatsTips(@Query() query: MissingPersonStatsQueryDto) {
    return this.missingPersonStatsService.getStatsTips(query);
  }

  @Get('admin/stats/by-admin')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Super admin: reviewer workload and speed' })
  async getStatsByAdmin(@Query() query: MissingPersonStatsQueryDto) {
    return this.missingPersonStatsService.getStatsByAdmin(query);
  }

  @Get('admin/stats/overview')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: dashboard overview in one call' })
  async getStatsOverview(@Query() query: MissingPersonStatsQueryDto) {
    return this.missingPersonStatsService.getStatsOverview(query);
  }

  @Get('admin/:id')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ, PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get full detail for one missing person' })
  async findOneForAdmin(@Param('id') id: string) {
    return this.missingPersonAdminOpsService.findOneForAdmin(id);
  }

  @Get('admin/:id/media')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: "Admin: get a short-lived download URL for a submission's media" })
  async getMedia(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: MediaKeyQueryDto,
  ) {
    return this.missingPersonMediaAdminService.getMediaDownloadUrl(admin, id, query.key);
  }

  @Get('admin/:id/history')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: get the audit timeline for one missing person case' })
  async getHistory(@Param('id') id: string) {
    return this.missingPersonAdminOpsService.getHistory(id);
  }

  @Patch('admin/:id/claim')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: claim a missing person case' })
  async claim(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonReviewService.claimMissingPerson(admin, id);
  }

  @Patch('admin/:id/unclaim')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: release a claimed missing person case' })
  async unclaim(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonReviewService.unclaimMissingPerson(admin, id);
  }

  @Patch('admin/:id/read')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: mark one case read' })
  async markRead(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonInboxService.markRead(admin, id);
  }

  @Patch('admin/:id/unread')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: mark one case unread' })
  async markUnread(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonInboxService.markUnread(admin, id);
  }

  @Get('admin/:id/flags')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get flags on one case' })
  async listCaseFlags(@Param('id') id: string) {
    return this.missingPersonModerationService.listCaseFlags(id);
  }

  @Post('admin/:id/takedown')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: emergency takedown that hides the case and blocks re-approval' })
  async takedown(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: TakedownMissingPersonDto,
  ) {
    return this.missingPersonModerationService.takedown(admin, id, data.reason);
  }

  @Post('admin/:id/lift-takedown')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Super admin: reverse a takedown with a reason' })
  async liftTakedown(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: LiftTakedownMissingPersonDto,
  ) {
    return this.missingPersonModerationService.liftTakedown(admin, id, data.reason);
  }

  @Patch('admin/:id/assign')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Super admin: assign a reviewer to a case' })
  async assign(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AssignMissingPersonDto,
  ) {
    return this.missingPersonReviewService.assign(admin, id, data.adminId);
  }

  @Patch('admin/:id/unassign')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Super admin: remove the reviewer from a case' })
  async unassign(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonReviewService.unassign(admin, id);
  }

  @Patch('admin/:id/verify-found')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: "Admin: confirm or decline an owner's found report" })
  async verifyFound(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: VerifyFoundMissingPersonDto,
  ) {
    return this.missingPersonReviewService.verifyFound(admin, id, data.confirmed, data.reviewNote);
  }

  @Patch('admin/:id/reopen')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: reopen an expired, cancelled or wrongly found case' })
  async reopen(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: ReopenMissingPersonDto,
  ) {
    return this.missingPersonReviewService.reopen(admin, id, data.reason);
  }

  @Patch('admin/:id/renew')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: "Admin: extend a listing on the owner's behalf" })
  async renewByAdmin(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminRenewMissingPersonDto,
  ) {
    return this.missingPersonCaseUpdatesService.renewByAdmin(admin, id, data);
  }

  @Get('admin/:id/possible-duplicates')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get likely duplicates of one case' })
  async findPossibleDuplicates(@Param('id') id: string) {
    return this.missingPersonDuplicatesService.findPossibleDuplicates(id);
  }

  @Post('admin/:id/merge')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: merge a duplicate case, keeping tips and history' })
  async merge(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: MergeMissingPersonDto,
  ) {
    return this.missingPersonDuplicatesService.merge(admin, id, data.duplicateId, data.reason);
  }

  @Patch('admin/:id/edit')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: edit case text before approval, with history kept' })
  async editByAdmin(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminEditMissingPersonDto,
  ) {
    return this.missingPersonAdminOpsService.editByAdmin(admin, id, data);
  }

  @Get('admin/:id/transitions')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: get the allowed next statuses for one case' })
  async getTransitions(@Param('id') id: string) {
    return this.missingPersonReviewService.getTransitions(id);
  }

  @Post('admin/:id/updates')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: post a public case update as staff' })
  async addStaffUpdate(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: CreateMissingPersonUpdateDto,
  ) {
    return this.missingPersonCaseUpdatesService.addStaffUpdate(admin, id, data);
  }

  @Post('admin/:id/message-owner')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: send the owner a message shown in their timeline' })
  async messageOwner(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: MessageMissingPersonOwnerDto,
  ) {
    return this.missingPersonAdminOpsService.messageOwner(admin, id, data.message);
  }

  @Patch('admin/:id/child-flag')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: correct the child-involved flag, with dual-admin confirmation' })
  async correctChildFlag(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: CorrectMissingPersonChildFlagDto,
  ) {
    return this.missingPersonAdminOpsService.correctChildFlag(admin, id, data.involvesChild, data.reason);
  }

  @Delete('admin/:id')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Super admin: soft delete a case with a reason' })
  async removeByAdmin(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: DeleteMissingPersonAdminDto,
  ) {
    return this.missingPersonAdminOpsService.removeByAdmin(admin, id, data.reason);
  }

  @Post('admin/:id/restore')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Super admin: restore a deleted case' })
  async restore(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: RestoreMissingPersonDto,
  ) {
    return this.missingPersonAdminOpsService.restore(admin, id, data.reason);
  }

  @Get('admin/:id/attachments')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: list files with type, size, scan status and hash' })
  async listAttachments(@Param('id') id: string) {
    return this.missingPersonMediaAdminService.listAttachments(id);
  }

  @Delete('admin/:id/media/:key')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: remove a file from a case' })
  async removeMedia(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Param('key') key: string,
  ) {
    return this.missingPersonCaseUpdatesService.removeMediaByAdmin(admin, id, key);
  }

  @Post('admin/:id/media/:key/redact')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REDACT)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: blur faces or hide details in a file' })
  async redactMedia(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() data: RedactMissingPersonMediaDto,
  ) {
    return this.missingPersonMediaAdminService.redactMedia(admin, id, key, data);
  }

  @Get('admin/:id/media/:key/custody')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get who viewed or downloaded a file' })
  async getMediaCustody(@Param('id') id: string, @Param('key') key: string) {
    return this.missingPersonMediaAdminService.getMediaCustody(id, key);
  }

  @Get('admin/:id/access-log')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Super admin: get who viewed this case in the admin area' })
  async getAccessLog(@Param('id') id: string, @Query() query: PaginationQueryDto) {
    return this.missingPersonMediaAdminService.getAccessLog(id, query);
  }

  @Patch('admin/:id/legal-hold')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Super admin: place or release a legal hold that blocks deletion and purge',
  })
  async setLegalHold(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: MissingPersonLegalHoldDto,
  ) {
    return this.missingPersonAdminOpsService.setLegalHold(admin, id, data.legalHold, data.reason);
  }

  @Get('admin/:id/revisions')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get the field-level change history of one case' })
  async getRevisions(@Param('id') id: string, @Query() query: PaginationQueryDto) {
    return this.missingPersonAdminOpsService.getRevisions(id, query);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get one approved missing person (requires login)' })
  async findOne(@Param('id') id: string) {
    return this.missingPersonPublicService.findOne(id);
  }

  @Get(':id/media')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Get a short-lived download URL for an approved submission's media (requires login)",
  })
  async getPublicMedia(@Param('id') id: string, @Query() query: MediaKeyQueryDto) {
    return this.missingPersonPublicService.getPublicMediaDownloadUrl(id, query.key);
  }

  @Get(':id/poster')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get a printable poster for an approved missing person' })
  async getPoster(@Param('id') id: string) {
    return this.missingPersonPublicService.getPoster(id);
  }

  @Get(':id/updates')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get the public update timeline for an approved missing person' })
  async listPublicUpdates(@Param('id') id: string, @Query() query: PaginationQueryDto) {
    return this.missingPersonCaseUpdatesService.listPublicUpdates(id, query);
  }

  @Get(':id/share')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get share text and a deep link for an approved missing person' })
  async getShare(@Param('id') id: string) {
    return this.missingPersonPublicService.getShare(id);
  }

  @Post(':id/flag')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Report a listing as false, abusive or identifying a child' })
  async flag(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: FlagMissingPersonDto,
  ) {
    return this.missingPersonPublicService.flag(user, id, data);
  }

  @Post(':id/view')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Record a view of an approved missing person for analytics' })
  async recordView(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonPublicService.recordView(user, id);
  }

  @Patch(':id')
  @MediaUpload(UpdateMissingPersonDto)
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Update my missing person submission' })
  async update(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: UpdateMissingPersonDto,
  ) {
    return this.missingPersonSubmissionService.update(user, id, data);
  }

  @Delete(':id')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Delete my missing person submission' })
  async remove(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonSubmissionService.remove(user, id);
  }

  @Patch('admin/:id/status')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: update missing person status' })
  async updateStatus(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: UpdateMissingPersonStatusDto,
  ) {
    return this.missingPersonReviewService.updateStatus(
      admin,
      id,
      data.status,
      data.reviewNote,
      data.childSafetyConfirmed,
    );
  }
}

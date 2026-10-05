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

import { InformationStatus } from '@prisma/client';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { MediaKeyQueryDto } from 'src/modules/media/dto/media-key-query.dto';

import { InformationSubmissionService } from '../service/information-submission.service';

import {
  AddInformationEvidenceDto,
  AdminInformationExportDto,
  AdminSearchInformationSubmissionsQueryDto,
  AnonymizeInformationSubmissionDto,
  AppealInformationRejectionDto,
  AssignInformationSubmissionDto,
  BulkAssignInformationSubmissionDto,
  BulkInformationSubmissionIdsDto,
  BulkRejectInformationSubmissionDto,
  BulkReviewInformationSubmissionDto,
  CreateInformationSubmissionDto,
  DeleteInformationSubmissionAdminDto,
  EscalateInformationDto,
  InformationLegalHoldDto,
  InformationPaginationQueryDto,
  InformationStatsQueryDto,
  InformationStatsTimelineQueryDto,
  ListInformationSubmissionsQueryDto,
  MarkAllInformationReadDto,
  MarkInformationAlreadyKnownDto,
  MarkInformationDuplicateDto,
  MessageInformantDto,
  RedactInformationMediaDto,
  RequestInformationDto,
  RespondToInformationQuestionDto,
  RestoreInformationSubmissionDto,
  ReviewInformationSubmissionDto,
  RevealInformantDto,
  SetInformationCredibilityDto,
  SetInformationPriorityDto,
  UpdateInformationSubmissionDto,
  UpdateInformationSubmissionStatusDto,
} from '../dto/information-submission.dto';

// Media download URLs live here (not a generic media module) since authorization
// must go through the same visibility rules as findOne/findForMissingPerson/findOneForAdmin.
@ApiTags('Information Submissions')
@ApiBearerAuth('access-token')
@Controller('information-submissions')
export class InformationSubmissionController {
  constructor(private readonly informationSubmissionService: InformationSubmissionService) {}

  // POST /information-submissions/missing-person/:missingPersonId
  @Post('missing-person/:missingPersonId')
  @MediaUpload(CreateInformationSubmissionDto)
  @ApiOperation({ summary: 'Submit information about a missing person' })
  async create(
    @Param('missingPersonId') missingPersonId: string,
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateInformationSubmissionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.informationSubmissionService.create(user, missingPersonId, data, idempotencyKey);
  }

  // GET /information-submissions/mine
  @Get('mine')
  @ApiOperation({ summary: 'Get my information submissions' })
  @ApiQuery({ name: 'status', required: false, enum: InformationStatus })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findMine(
    @CurrentUser() user: CurrentUserDto,
    @Query() query: ListInformationSubmissionsQueryDto,
  ) {
    return this.informationSubmissionService.findMine(user.id, query);
  }

  @Get('mine/summary')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get my tip counts by status' })
  async getMySummary(@CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.getMySummary(user);
  }

  @Get('mine/unread-updates/count')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Count my tips with an unseen status change or question' })
  async countMyUnreadUpdates(@CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.countMyUnreadUpdates(user);
  }

  @Patch('mine/seen-all')
  @ApiOperation({ summary: 'Mark all updates on my tips as seen' })
  async markAllMineSeen(@CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.markAllMineSeen(user);
  }

  // GET /information-submissions/missing-person/:missingPersonId/mine — before the public route below.
  @Get('missing-person/:missingPersonId/mine')
  @ApiOperation({ summary: 'Get my information submissions for one missing person' })
  async findMineForMissingPerson(
    @Param('missingPersonId') missingPersonId: string,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.informationSubmissionService.findMineForMissingPerson(user.id, missingPersonId);
  }

  // GET /information-submissions/missing-person/:missingPersonId — public.
  @Get('missing-person/:missingPersonId')
  @AllowAnonymous()
  @ApiOperation({ summary: 'Get reviewed information for a missing person' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findForMissingPerson(
    @Param('missingPersonId') missingPersonId: string,
    @Query() query: ListInformationSubmissionsQueryDto,
  ) {
    return this.informationSubmissionService.findForMissingPerson(missingPersonId, query);
  }

  // GET /information-submissions/public/:id/media?key=... — only for REVIEWED submissions.
  @Get('public/:id/media')
  @AllowAnonymous()
  @ApiOperation({ summary: "Get a short-lived download URL for a reviewed submission's media" })
  async getPublicMedia(@Param('id') id: string, @Query() query: MediaKeyQueryDto) {
    return this.informationSubmissionService.getPublicMediaDownloadUrl(id, query.key);
  }

  // GET /information-submissions/:id
  @Get(':id')
  @ApiOperation({ summary: 'Get my information submission' })
  async findOne(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.findOne(id, user.id);
  }

  // GET /information-submissions/:id/media?key=... — owner only.
  @Get(':id/media')
  @ApiOperation({ summary: 'Get a short-lived download URL for my submission media' })
  async getMedia(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserDto,
    @Query() query: MediaKeyQueryDto,
  ) {
    return this.informationSubmissionService.getMediaDownloadUrl(id, user.id, query.key);
  }

  @Get(':id/timeline')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get the informant-facing review history of my tip' })
  async getMyTimeline(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.getMyTimeline(user, id);
  }

  @Get(':id/questions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get open questions from the admin team about my tip' })
  async getMyQuestions(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.getMyQuestions(user, id);
  }

  @Post(':id/respond')
  @ApiOperation({ summary: 'Answer an admin question about my tip' })
  async respond(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserDto,
    @Body() data: RespondToInformationQuestionDto,
  ) {
    return this.informationSubmissionService.respond(user, id, data);
  }

  @Post(':id/evidence')
  @MediaUpload(AddInformationEvidenceDto)
  @ApiOperation({ summary: 'Add a photo or file to my tip after submitting' })
  async addEvidence(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserDto,
    @Body() data: AddInformationEvidenceDto,
  ) {
    return this.informationSubmissionService.addEvidence(user, id, data);
  }

  @Delete(':id/media/:key')
  @ApiOperation({ summary: 'Remove one file from my pending tip' })
  async removeMyMedia(
    @Param('id') id: string,
    @Param('key') key: string,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.informationSubmissionService.removeOwnMedia(user, id, key);
  }

  @Patch(':id/seen')
  @ApiOperation({ summary: 'Mark the latest update on my tip as seen' })
  async markMineSeen(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.markMineSeen(user, id);
  }

  @Get(':id/outcome')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get whether my tip helped, without case details' })
  async getMyOutcome(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.getMyOutcome(user, id);
  }

  @Get(':id/reward-status')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get the status of any reward claim linked to my tip' })
  async getMyRewardStatus(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.getMyRewardStatus(user, id);
  }

  @Post(':id/appeal')
  @ApiOperation({ summary: 'Appeal the rejection of my tip' })
  async appeal(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserDto,
    @Body() data: AppealInformationRejectionDto,
  ) {
    return this.informationSubmissionService.appealRejection(user, id, data);
  }

  // PATCH /information-submissions/:id — only while PENDING (enforced in service).
  @Patch(':id')
  @MediaUpload(UpdateInformationSubmissionDto)
  @ApiOperation({ summary: 'Update my information submission' })
  async update(
    @Param('id') id: string,
    @Body() data: UpdateInformationSubmissionDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.informationSubmissionService.update(id, user, data);
  }

  // DELETE /information-submissions/:id — only while PENDING (enforced in service).
  @Delete(':id')
  @ApiOperation({ summary: 'Delete my information submission' })
  async remove(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.remove(id, user);
  }

  // GET /information-submissions/admin/all
  @Get('admin/all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: list information submissions' })
  @ApiQuery({ name: 'status', required: false, enum: InformationStatus })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAllForAdmin(@Query() query: ListInformationSubmissionsQueryDto) {
    return this.informationSubmissionService.findAllForAdmin(query);
  }

  // GET /information-submissions/admin/stats — declared before 'admin/:id'.
  @Get('admin/stats')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get information submission counts by status' })
  async getStats() {
    return this.informationSubmissionService.getStats();
  }

  // GET /information-submissions/admin/stale — declared before 'admin/:id'.
  @Get('admin/stale')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({
    summary: 'Admin: get information submissions that have been waiting too long',
  })
  async findStalePending() {
    return this.informationSubmissionService.findStalePending();
  }

  @Patch('admin/bulk/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: mark many tips read' })
  async bulkMarkRead(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: BulkInformationSubmissionIdsDto,
  ) {
    return this.informationSubmissionService.bulkMarkRead(admin, data.ids);
  }

  @Patch('admin/bulk/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: mark many tips unread' })
  async bulkMarkUnread(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: BulkInformationSubmissionIdsDto,
  ) {
    return this.informationSubmissionService.bulkMarkUnread(admin, data.ids);
  }

  @Patch('admin/bulk/assign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Super admin: assign many tips to a reviewer' })
  async bulkAssign(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: BulkAssignInformationSubmissionDto,
  ) {
    return this.informationSubmissionService.bulkAssign(admin, data.ids, data.adminId);
  }

  @Patch('admin/bulk/review')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: review many tips with one outcome and reason' })
  async bulkReview(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: BulkReviewInformationSubmissionDto,
  ) {
    return this.informationSubmissionService.bulkReview(
      admin,
      data.ids,
      data.status,
      data.reviewNote,
    );
  }

  @Patch('admin/bulk/reject')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: reject many tips with one reason' })
  async bulkReject(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: BulkRejectInformationSubmissionDto,
  ) {
    return this.informationSubmissionService.bulkReject(admin, data.ids, data.reviewNote);
  }

  @Patch('admin/read-all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: mark all tips matching a filter read' })
  async markAllRead(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: MarkAllInformationReadDto,
  ) {
    return this.informationSubmissionService.markAllRead(admin, data);
  }

  @Get('admin/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread tips' })
  async findUnread(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: ListInformationSubmissionsQueryDto,
  ) {
    return this.informationSubmissionService.findUnread(admin, query);
  }

  @Get('admin/unread/count')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread badge count' })
  async countUnread(@CurrentUser() admin: CurrentUserDto) {
    return this.informationSubmissionService.countUnread(admin);
  }

  @Get('admin/unread/count/by-status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread count by status' })
  async countUnreadByStatus(@CurrentUser() admin: CurrentUserDto) {
    return this.informationSubmissionService.countUnreadByStatus(admin);
  }

  @Get('admin/unread/count/by-case')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get my unread count by missing-person case' })
  async countUnreadByCase(@CurrentUser() admin: CurrentUserDto) {
    return this.informationSubmissionService.countUnreadByCase(admin);
  }

  @Get('admin/counts')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get total, read and unread counts' })
  async getReadCounts(@CurrentUser() admin: CurrentUserDto) {
    return this.informationSubmissionService.getReadCounts(admin);
  }

  @Get('admin/by-case')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: one row per missing-person case with total, read and unread' })
  async listByCase(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: InformationPaginationQueryDto,
  ) {
    return this.informationSubmissionService.listByCase(admin, query);
  }

  @Get('admin/by-case/:missingPersonId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get all tips on one case with isRead' })
  async findByCase(
    @CurrentUser() admin: CurrentUserDto,
    @Param('missingPersonId') missingPersonId: string,
    @Query() query: ListInformationSubmissionsQueryDto,
  ) {
    return this.informationSubmissionService.findByCase(admin, missingPersonId, query);
  }

  @Patch('admin/by-case/:missingPersonId/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: mark all tips on a case read' })
  async markCaseRead(
    @CurrentUser() admin: CurrentUserDto,
    @Param('missingPersonId') missingPersonId: string,
  ) {
    return this.informationSubmissionService.markCaseRead(admin, missingPersonId);
  }

  @Patch('admin/by-case/:missingPersonId/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: mark all tips on a case unread' })
  async markCaseUnread(
    @CurrentUser() admin: CurrentUserDto,
    @Param('missingPersonId') missingPersonId: string,
  ) {
    return this.informationSubmissionService.markCaseUnread(admin, missingPersonId);
  }

  @Get('admin/by-informant')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: one row per informant with total, read, unread, accepted and rejected' })
  async listByInformant(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: InformationPaginationQueryDto,
  ) {
    return this.informationSubmissionService.listByInformant(admin, query);
  }

  @Get('admin/by-informant/repeat-rejections')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: informants with repeated rejected or false tips' })
  async listRepeatRejections(@Query() query: InformationPaginationQueryDto) {
    return this.informationSubmissionService.listRepeatRejections(query);
  }

  @Get('admin/by-informant/:informantId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(
    PermissionsEnum.MISSING_PERSON_INFO_READ,
    PermissionsEnum.INFORMANT_IDENTITY_READ,
  )
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "Admin: get one informant's tips, needs the identity permission" })
  async findByInformant(
    @CurrentUser() admin: CurrentUserDto,
    @Param('informantId') informantId: string,
    @Query() query: ListInformationSubmissionsQueryDto,
  ) {
    return this.informationSubmissionService.findByInformant(admin, informantId, query);
  }

  @Get('admin/by-informant/:informantId/summary')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "Admin: get one informant's totals by status and reliability" })
  async getInformantSummary(
    @CurrentUser() admin: CurrentUserDto,
    @Param('informantId') informantId: string,
  ) {
    return this.informationSubmissionService.getInformantSummary(admin, informantId);
  }

  @Get('admin/trash')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Super admin: list deleted tips' })
  async listTrash(@Query() query: InformationPaginationQueryDto) {
    return this.informationSubmissionService.listTrash(query);
  }

  @Get('admin/search')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: full-text search across all tips' })
  async searchForAdmin(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: AdminSearchInformationSubmissionsQueryDto,
  ) {
    return this.informationSubmissionService.searchForAdmin(admin, query);
  }

  @Get('admin/facets')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: get counts for the filter sidebar' })
  async getFacets() {
    return this.informationSubmissionService.getFacets();
  }

  @Get('admin/filters/options')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: get dropdown values for filters' })
  async getFilterOptions() {
    return this.informationSubmissionService.getFilterOptions();
  }

  @Get('admin/export')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: export tips as CSV, row-capped, audited, without informant identity' })
  async exportCsv(
    @CurrentUser() admin: CurrentUserDto,
    @Query() query: AdminInformationExportDto,
  ) {
    return this.informationSubmissionService.exportCsv(admin, query);
  }

  @Post('admin/export-jobs')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: start a background export' })
  async startExportJob(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: AdminInformationExportDto,
  ) {
    return this.informationSubmissionService.startExportJob(admin, data);
  }

  @Get('admin/export-jobs/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get the progress of an export job' })
  async getExportJob(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.informationSubmissionService.getExportJob(admin, id);
  }

  @Get('admin/export-jobs/:id/download')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get a short-lived download link for an export, audited' })
  async downloadExportJob(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.informationSubmissionService.getExportJobDownloadUrl(admin, id);
  }

  @Get('admin/stats/timeline')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: tips per day, week or month' })
  async getStatsTimeline(@Query() query: InformationStatsTimelineQueryDto) {
    return this.informationSubmissionService.getStatsTimeline(query);
  }

  @Get('admin/stats/by-status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: tips by status' })
  async getStatsByStatus(@Query() query: InformationStatsQueryDto) {
    return this.informationSubmissionService.getStatsByStatus(query);
  }

  @Get('admin/stats/by-case')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: tips per case' })
  async getStatsByCase(@Query() query: InformationStatsQueryDto) {
    return this.informationSubmissionService.getStatsByCase(query);
  }

  @Get('admin/stats/review-time')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: time to first review and decision' })
  async getStatsReviewTime(@Query() query: InformationStatsQueryDto) {
    return this.informationSubmissionService.getStatsReviewTime(query);
  }

  @Get('admin/stats/backlog')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: pending tips over time' })
  async getStatsBacklog(@Query() query: InformationStatsQueryDto) {
    return this.informationSubmissionService.getStatsBacklog(query);
  }

  @Get('admin/stats/aging')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: pending tips by age bucket' })
  async getStatsAging(@Query() query: InformationStatsQueryDto) {
    return this.informationSubmissionService.getStatsAging(query);
  }

  @Get('admin/stats/usefulness')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: share of tips that were useful, duplicate or already known' })
  async getStatsUsefulness(@Query() query: InformationStatsQueryDto) {
    return this.informationSubmissionService.getStatsUsefulness(query);
  }

  @Get('admin/stats/response-time')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: how fast informants answer admin questions' })
  async getStatsResponseTime(@Query() query: InformationStatsQueryDto) {
    return this.informationSubmissionService.getStatsResponseTime(query);
  }

  @Get('admin/stats/by-admin')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Super admin: reviewer workload and speed' })
  async getStatsByAdmin(@Query() query: InformationStatsQueryDto) {
    return this.informationSubmissionService.getStatsByAdmin(query);
  }

  @Get('admin/stats/overview')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: dashboard overview in one call' })
  async getStatsOverview(@Query() query: InformationStatsQueryDto) {
    return this.informationSubmissionService.getStatsOverview(query);
  }

  // GET /information-submissions/admin/:id
  @Get('admin/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: get full detail for one information submission' })
  async findOneForAdmin(@Param('id') id: string) {
    return this.informationSubmissionService.findOneForAdmin(id);
  }

  // GET /information-submissions/admin/:id/media?key=...
  @Get('admin/:id/media')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: "Admin: get a short-lived download URL for a submission's media" })
  async getMediaForAdmin(
    @Param('id') id: string,
    @Query() query: MediaKeyQueryDto,
    @CurrentUser() admin: CurrentUserDto,
  ) {
    return this.informationSubmissionService.getMediaDownloadUrlForAdmin(admin, id, query.key);
  }

  // GET /information-submissions/admin/:id/history
  @Get('admin/:id/history')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: get the audit timeline for one information submission' })
  async getHistory(@Param('id') id: string) {
    return this.informationSubmissionService.getHistory(id);
  }

  @Patch('admin/:id/read')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: mark one tip read' })
  async markRead(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.informationSubmissionService.markRead(admin, id);
  }

  @Patch('admin/:id/unread')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: mark one tip unread' })
  async markUnread(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.informationSubmissionService.markUnread(admin, id);
  }

  @Patch('admin/:id/request-information')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: ask the informant for clarification' })
  async requestInformation(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: RequestInformationDto,
  ) {
    return this.informationSubmissionService.requestInformation(admin, id, data.question);
  }

  @Patch('admin/:id/claim')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: claim a tip for review' })
  async claim(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.informationSubmissionService.claim(admin, id);
  }

  @Patch('admin/:id/unclaim')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: release a claimed tip' })
  async unclaim(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.informationSubmissionService.unclaim(admin, id);
  }

  @Patch('admin/:id/assign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Super admin: assign a reviewer to a tip' })
  async assign(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AssignInformationSubmissionDto,
  ) {
    return this.informationSubmissionService.assign(admin, id, data.adminId);
  }

  @Patch('admin/:id/unassign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Super admin: remove the reviewer from a tip' })
  async unassign(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.informationSubmissionService.unassign(admin, id);
  }

  @Get('admin/:id/related')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get other tips on the same case with similar content' })
  async findRelated(@Param('id') id: string) {
    return this.informationSubmissionService.findRelated(id);
  }

  @Patch('admin/:id/mark-duplicate')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: mark a tip as a duplicate of another' })
  async markDuplicate(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: MarkInformationDuplicateDto,
  ) {
    return this.informationSubmissionService.markDuplicate(admin, id, data.duplicateOfId, data.reason);
  }

  @Patch('admin/:id/mark-already-known')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: mark information the case already had' })
  async markAlreadyKnown(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: MarkInformationAlreadyKnownDto,
  ) {
    return this.informationSubmissionService.markAlreadyKnown(admin, id, data.reason);
  }

  @Post('admin/:id/escalate')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: escalate an urgent sighting to the referral flow' })
  async escalate(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: EscalateInformationDto,
  ) {
    return this.informationSubmissionService.escalate(admin, id, data);
  }

  @Patch('admin/:id/priority')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: set the priority of a tip' })
  async setPriority(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: SetInformationPriorityDto,
  ) {
    return this.informationSubmissionService.setPriority(admin, id, data.priority);
  }

  @Patch('admin/:id/credibility')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: record a credibility rating with a reason' })
  async setCredibility(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: SetInformationCredibilityDto,
  ) {
    return this.informationSubmissionService.setCredibility(admin, id, data.credibility, data.reason);
  }

  @Get('admin/:id/transitions')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: get the allowed next statuses for one tip' })
  async getTransitions(@Param('id') id: string) {
    return this.informationSubmissionService.getTransitions(id);
  }

  @Post('admin/:id/messages')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: send the informant a message shown in their timeline' })
  async messageInformant(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: MessageInformantDto,
  ) {
    return this.informationSubmissionService.messageInformant(admin, id, data.message);
  }

  @Get('admin/:id/revisions')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get the field-level change history of one tip' })
  async getRevisions(@Param('id') id: string, @Query() query: InformationPaginationQueryDto) {
    return this.informationSubmissionService.getRevisions(id, query);
  }

  @Delete('admin/:id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Super admin: soft delete a tip with a reason' })
  async removeByAdmin(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: DeleteInformationSubmissionAdminDto,
  ) {
    return this.informationSubmissionService.removeByAdmin(admin, id, data.reason);
  }

  @Post('admin/:id/restore')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Super admin: restore a deleted tip' })
  async restore(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: RestoreInformationSubmissionDto,
  ) {
    return this.informationSubmissionService.restore(admin, id, data.reason);
  }

  @Get('admin/:id/attachments')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: list files with type, size, scan status and hash' })
  async listAttachments(@Param('id') id: string) {
    return this.informationSubmissionService.listAttachments(id);
  }

  @Delete('admin/:id/media/:key')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: remove a file from a tip' })
  async removeMediaByAdmin(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Param('key') key: string,
  ) {
    return this.informationSubmissionService.removeMediaByAdmin(admin, id, key);
  }

  @Post('admin/:id/media/:key/redact')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: blur faces or hide details in a file' })
  async redactMedia(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() data: RedactInformationMediaDto,
  ) {
    return this.informationSubmissionService.redactMedia(admin, id, key, data);
  }

  @Get('admin/:id/media/:key/custody')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get who viewed or downloaded a file' })
  async getMediaCustody(@Param('id') id: string, @Param('key') key: string) {
    return this.informationSubmissionService.getMediaCustody(id, key);
  }

  @Post('admin/:id/reveal-informant')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.INFORMANT_IDENTITY_READ)
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "Admin: reveal the informant's identity once, with a reason, audited" })
  async revealInformant(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: RevealInformantDto,
  ) {
    return this.informationSubmissionService.revealInformant(admin, id, data.reason);
  }

  @Get('admin/:id/identity-access-log')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Super admin: get who revealed the informant and why' })
  async getIdentityAccessLog(@Param('id') id: string, @Query() query: InformationPaginationQueryDto) {
    return this.informationSubmissionService.getIdentityAccessLog(id, query);
  }

  @Get('admin/:id/access-log')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Super admin: get who viewed this tip in the admin area' })
  async getAccessLog(@Param('id') id: string, @Query() query: InformationPaginationQueryDto) {
    return this.informationSubmissionService.getAccessLog(id, query);
  }

  @Patch('admin/:id/legal-hold')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Super admin: place or release a legal hold that blocks deletion and purge' })
  async setLegalHold(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: InformationLegalHoldDto,
  ) {
    return this.informationSubmissionService.setLegalHold(admin, id, data.legalHold, data.reason);
  }

  @Post('admin/:id/anonymize')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Super admin: remove identifying fields after closure' })
  async anonymize(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AnonymizeInformationSubmissionDto,
  ) {
    return this.informationSubmissionService.anonymize(admin, id, data.reason);
  }

  // PATCH /information-submissions/admin/:id/status — only moves PENDING -> UNDER_REVIEW.
  @Patch('admin/:id/status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: move information submission to under review' })
  async updateStatus(
    @Param('id') id: string,
    @Body() data: UpdateInformationSubmissionStatusDto,
    @CurrentUser() admin: CurrentUserDto,
  ) {
    return this.informationSubmissionService.updateStatus(admin, id, data.status);
  }

  // PATCH /information-submissions/admin/:id/review — only from UNDER_REVIEW.
  @Patch('admin/:id/review')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_REVIEW)
  @ApiOperation({ summary: 'Admin: review information submission' })
  async review(
    @Param('id') id: string,
    @Body() data: ReviewInformationSubmissionDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.informationSubmissionService.review(id, data.status, data.reviewNote, user);
  }
}
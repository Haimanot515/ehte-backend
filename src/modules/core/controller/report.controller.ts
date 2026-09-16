import {
  Body,
  Controller,
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

import { ReportService } from '../service/report.service';

import {
  CreateReportDto,
  UpdateReportDto,
  AdminReportQueryDto,
  UpdateReportStatusDto,
  AssignReportDto,
  RequestMoreInformationDto,
  EscalateReportDto,
  RespondToInformationRequestDto,
} from '../dto/report.dto';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
// NOTE: adjust these two import paths to match your actual file locations —
// they were not present in the source file provided, so the names/paths
// below follow the same convention as Roles / RolesEnum above.
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
// NOTE: adjust this path to wherever MediaModule actually lives — same
// DTO VictimProfileController/PostController already use for their
// media routes.
import { MediaKeyQueryDto } from 'src/modules/media/dto/media-key-query.dto';

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@Controller('reports')
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  // ─────────────────────────────────────────────
  // CREATE REPORT
  // POST /reports
  //
  // FIX (item #5): accepts an optional Idempotency-Key header —
  // same convention as PostController.create — so a client
  // retrying after a dropped response doesn't create a duplicate
  // report. ReportService.create returns the original report on a
  // repeat key instead.
  //
  // FIX (item #12): route-specific burst limit, same values as
  // PostController.create — 5 creates/min is generous for a real
  // reporter but meaningfully slows a scripted flood. Reports go
  // straight to PENDING on create (no separate submit step like
  // Post has), so this is the only creation-side throttle point.
  // ─────────────────────────────────────────────
  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiOperation({ summary: 'Submit a new report' })
  async create(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateReportDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.reportService.create(user, data, idempotencyKey);
  }

  @Get('me')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get reports submitted by the current user' })
  async findMyReports(@CurrentUser() user: CurrentUserDto) {
    return this.reportService.findMyReports(user);
  }

  // ─────────────────────────────────────────────
  // MY ASSIGNED REPORTS (ADMIN)
  // GET /reports/assigned-to-me
  //
  // Declared before GET /reports/:id so "assigned-to-me"
  // is never matched as a route parameter.
  //
  // ActorType.ADMIN, ActorType.SUPER_ADMIN
  // ─────────────────────────────────────────────

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
    return this.reportService.findAssignedToMe(admin, { page, limit });
  }

  // ─────────────────────────────────────────────
  // ADMIN — STALE / UNREVIEWED-TOO-LONG REPORTS
  // GET /reports/stale
  // (item #15)
  //
  // Declared BEFORE ':id' so Nest doesn't treat "stale" as a
  // report id — same route-order reasoning as "assigned-to-me"
  // above and PostController's equivalent route.
  //
  // Flags reports that are both unassigned AND not yet in a
  // terminal status (CLOSED/REJECTED) and older than the
  // configured threshold — a report that's already ASSIGNED to
  // someone actively working it is not "forgotten" the same way
  // an untouched PENDING one is, so this checks assignment too,
  // not just status, unlike PostService.findStalePending (Post
  // has no assignment concept).
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
  @Get('stale')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get unassigned reports that have been waiting too long' })
  async findStalePending() {
    return this.reportService.findStalePending();
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
    return this.reportService.findAllForAdmin(query);
  }

  // ─────────────────────────────────────────────
  // GET ONE OF MY REPORTS
  // GET /reports/:id
  //
  // FIX (item #23): added re-authentication + no-store, matching
  // PostController.findMyPost's treatment of a single owned
  // record. A report is at least as sensitive as a post, so it
  // shouldn't have a weaker re-auth posture than Post's equivalent
  // single-record read.
  // ─────────────────────────────────────────────
  @Get(':id')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get one of my reports' })
  async findOne(@CurrentUser() user: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportService.findOne(user, reportId);
  }

  // ─────────────────────────────────────────────
  // GET MEDIA DOWNLOAD URL (REPORTER — OWN REPORT)
  // GET /reports/:id/media?key=...
  //
  // Mirrors VictimProfileController/PostController's media-download
  // routes, scoped the same way findOne() already is: a reporter may
  // only request a URL for a key attached to a report they own.
  // ─────────────────────────────────────────────
  @Get(':id/media')
  @ApiOperation({ summary: "Get a short-lived download URL for one of my report's media" })
  async getMedia(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Query() query: MediaKeyQueryDto,
  ) {
    return this.reportService.getMediaDownloadUrl(user, reportId, query.key);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a pending report' })
  async update(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UpdateReportDto,
  ) {
    return this.reportService.update(user, reportId, data);
  }

  @Patch(':id/withdraw')
  @ApiOperation({ summary: 'Withdraw a pending report (reporter)' })
  async withdraw(@CurrentUser() user: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportService.withdraw(user, reportId);
  }

  @Get(':id/admin')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORTER_INFO_READ)
  @ApiOperation({ summary: 'Get full report detail including reporter information (admin)' })
  async findOneForAdmin(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportService.findOneForAdmin(admin, reportId);
  }

  // ─────────────────────────────────────────────
  // GET MEDIA DOWNLOAD URL (ADMIN)
  // GET /reports/:id/admin/media?key=...
  //
  // Viewing a report's media is open to any ADMIN or SUPER_ADMIN,
  // matching findOneForAdmin()'s access rule — same permissions as
  // that route, since this is another way to access the same
  // reporter-submitted content. Assignment only gates *acting* on a
  // report elsewhere in this controller.
  // ─────────────────────────────────────────────
  @Get(':id/admin/media')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ, PermissionsEnum.REPORTER_INFO_READ)
  @ApiOperation({ summary: "Admin: get a short-lived download URL for a report's media" })
  async getMediaForAdmin(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Query() query: MediaKeyQueryDto,
  ) {
    return this.reportService.getMediaDownloadUrlForAdmin(admin, reportId, query.key);
  }

  // ─────────────────────────────────────────────
  // ADMIN — PER-REPORT HISTORY / TIMELINE
  // GET /reports/:id/history
  // (item #18)
  //
  // Mirrors PostController.getHistory. Same ASSUMPTION as Post:
  // relies on an `auditLog` model populated by a listener
  // subscribed to the events emitAudit() already fires throughout
  // ReportService.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
  @Get(':id/history')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get the audit timeline for one report' })
  async getHistory(@Param('id') reportId: string) {
    return this.reportService.getHistory(reportId);
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
    return this.reportService.updateStatus(admin, reportId, data);
  }

  // ─────────────────────────────────────────────
  // INFORMATION REQUESTS
  // ─────────────────────────────────────────────

  @Get(':id/information-requests')
  @ApiOperation({
    summary:
      'List information requests for a report (reporter sees their own report; admin sees any report they can access)',
  })
  async findInformationRequests(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
  ) {
    return this.reportService.findInformationRequests(user, reportId);
  }

  @Get(':id/information-requests/:requestId')
  @ApiOperation({ summary: 'Get a single information request for a report' })
  async findOneInformationRequest(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.reportService.findOneInformationRequest(user, reportId, requestId);
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
    return this.reportService.requestMoreInformation(admin, reportId, data);
  }

  @Post(':id/information-requests/:requestId/respond')
  @ApiOperation({ summary: 'Respond to an admin information request (reporter)' })
  async respondToInformationRequest(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Param('requestId') requestId: string,
    @Body() data: RespondToInformationRequestDto,
  ) {
    return this.reportService.respondToInformationRequest(user, reportId, requestId, data);
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
    return this.reportService.assign(admin, reportId, data);
  }

  @Patch(':id/unassign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_ASSIGN)
  @ApiOperation({ summary: 'Unassign report from its current administrator (super admin)' })
  async unassign(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportService.unassign(admin, reportId);
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
    return this.reportService.escalate(admin, reportId, data);
  }
}
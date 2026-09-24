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
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { MediaKeyQueryDto } from 'src/modules/media/dto/media-key-query.dto';

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@Controller('reports')
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  // Accepts an optional Idempotency-Key so a dropped-response retry
  // returns the original report instead of creating a duplicate
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
    return this.reportService.findAssignedToMe(admin, { page, limit });
  }

  // Declared before ':id' so "stale" isn't matched as a report id
  @Get('stale')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.REPORT_READ)
  @ApiOperation({ summary: 'Admin: get unassigned reports that have been waiting too long' })
  async findStalePending() {
    return this.reportService.findStalePending();
  }

  // Declared before ':id' so "stats" isn't matched as a report id
  @Get('stats')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get report counts by status' })
  async getStats() {
    return this.reportService.getStats();
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

  @Get(':id')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get one of my reports' })
  async findOne(@CurrentUser() user: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportService.findOne(user, reportId);
  }

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
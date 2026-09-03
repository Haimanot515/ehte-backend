import { Body, Controller, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

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

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@Controller('reports')
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @Post()
  @RequireReauthentication()
  @ApiOperation({ summary: 'Submit a new report' })
  async create(@CurrentUser() user: CurrentUserDto, @Body() data: CreateReportDto) {
    return this.reportService.create(user, data);
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

  @Get()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
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
  @ApiOperation({ summary: 'Get one of my reports' })
  async findOne(@CurrentUser() user: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportService.findOne(user, reportId);
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
  @ApiOperation({ summary: 'Get full report detail including reporter information (admin)' })
  async findOneForAdmin(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportService.findOneForAdmin(admin, reportId);
  }

  @Patch(':id/status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
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
  @ApiOperation({ summary: 'Unassign report from its current administrator (super admin)' })
  async unassign(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportService.unassign(admin, reportId);
  }

  @Patch(':id/escalate')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Escalate an urgent report (admin)' })
  async escalate(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: EscalateReportDto,
  ) {
    return this.reportService.escalate(admin, reportId, data);
  }
}
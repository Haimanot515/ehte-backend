import { Body, Controller, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { ReportService } from '../service/report.service';

import { CreateReportDto, UpdateReportDto } from '../dto/report.dto';

import {
  AdminReportQueryDto,
  UpdateReportStatusDto,
  AssignReportDto,
  RequestMoreInformationDto,
  EscalateReportDto,
} from '../dto/report-admin.dto';

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

  // ─────────────────────────────────────────────
  // CREATE REPORT
  // POST /reports
  //
  // Any authenticated user (ActorType.USER)
  // Requires password re-authentication (PRD).
  // ─────────────────────────────────────────────

  @Post()
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Submit a new report',
  })
  async create(@CurrentUser() user: CurrentUserDto, @Body() data: CreateReportDto) {
    return this.reportService.create(user, data);
  }

  // ─────────────────────────────────────────────
  // MY REPORTS
  // GET /reports/me
  //
  // Declared before GET /reports/:id and
  // GET /reports so "me" is never matched as a
  // route parameter.
  //
  // Any authenticated user (ActorType.USER)
  // Requires password re-authentication (PRD),
  // sent via X-Reauth-Password header since this
  // is a GET request. Response is never cached.
  // ─────────────────────────────────────────────

  @Get('me')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get reports submitted by the current user',
  })
  async findMyReports(@CurrentUser() user: CurrentUserDto) {
    return this.reportService.findMyReports(user);
  }

  // ─────────────────────────────────────────────
  // LIST ALL REPORTS
  // GET /reports
  //
  // Declared before GET /reports/:id, both being
  // single-segment routes matched in declaration
  // order.
  //
  // ActorType.ADMIN, ActorType.SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'List all reports (admin)',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'assignedTo', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAll(@Query() query: AdminReportQueryDto) {
    return this.reportService.findAllForAdmin(query);
  }

  // ─────────────────────────────────────────────
  // GET ONE REPORT
  // GET /reports/:id
  //
  // Scoped to reports owned by the requesting
  // user; ownership is enforced in ReportService.
  //
  // Any authenticated user (ActorType.USER)
  // ─────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({
    summary: 'Get one of my reports',
  })
  async findOne(@CurrentUser() user: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportService.findOne(user, reportId);
  }

  // ─────────────────────────────────────────────
  // UPDATE REPORT
  // PATCH /reports/:id
  //
  // Allowed only for the report owner while
  // status is PENDING.
  //
  // Any authenticated user (ActorType.USER)
  // ─────────────────────────────────────────────

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a pending report',
  })
  async update(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UpdateReportDto,
  ) {
    return this.reportService.update(user, reportId, data);
  }

  // ─────────────────────────────────────────────
  // GET ONE REPORT — FULL DETAIL (ADMIN)
  // GET /reports/:id/admin
  //
  // Includes reporter identity. Access is logged
  // per PRD Section 25.
  //
  // ActorType.ADMIN, ActorType.SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get(':id/admin')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get full report detail including reporter information (admin)',
  })
  async findOneForAdmin(@CurrentUser() admin: CurrentUserDto, @Param('id') reportId: string) {
    return this.reportService.findOneForAdmin(admin, reportId);
  }

  // ─────────────────────────────────────────────
  // UPDATE STATUS
  // PATCH /reports/:id/status
  //
  // ActorType.ADMIN, ActorType.SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Patch(':id/status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Update report status (admin)',
  })
  async updateStatus(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: UpdateReportStatusDto,
  ) {
    return this.reportService.updateStatus(admin, reportId, data);
  }

  // ─────────────────────────────────────────────
  // REQUEST MORE INFORMATION
  // PATCH /reports/:id/request-information
  //
  // ActorType.ADMIN, ActorType.SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Patch(':id/request-information')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Request more information from reporter (admin)',
  })
  async requestMoreInformation(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: RequestMoreInformationDto,
  ) {
    return this.reportService.requestMoreInformation(admin, reportId, data);
  }

  // ─────────────────────────────────────────────
  // ASSIGN
  // PATCH /reports/:id/assign
  //
  // ActorType.SUPER_ADMIN only
  // ─────────────────────────────────────────────

  @Patch(':id/assign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Assign report to an administrator (super admin)',
  })
  async assign(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: AssignReportDto,
  ) {
    return this.reportService.assign(admin, reportId, data);
  }

  // ─────────────────────────────────────────────
  // ESCALATE
  // PATCH /reports/:id/escalate
  //
  // ActorType.ADMIN, ActorType.SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Patch(':id/escalate')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Escalate an urgent report (admin)',
  })
  async escalate(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') reportId: string,
    @Body() data: EscalateReportDto,
  ) {
    return this.reportService.escalate(admin, reportId, data);
  }
}

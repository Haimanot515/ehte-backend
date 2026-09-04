import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { InformationStatus } from '@prisma/client';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { InformationSubmissionService } from '../service/information-submission.service';

import {
  CreateInformationSubmissionDto,
  ListInformationSubmissionsQueryDto,
  ReviewInformationSubmissionDto,
  UpdateInformationSubmissionDto,
  UpdateInformationSubmissionStatusDto,
} from '../dto/information-submission.dto';

@ApiTags('Information Submissions')
@ApiBearerAuth('access-token')
@Controller('information-submissions')
export class InformationSubmissionController {
  constructor(private readonly informationSubmissionService: InformationSubmissionService) {}

  // ─────────────────────────────────────────────
  // CREATE
  // POST /information-submissions/missing-person/:missingPersonId
  // ─────────────────────────────────────────────

  @Post('missing-person/:missingPersonId')
  @ApiOperation({ summary: 'Submit information about a missing person' })
  async create(
    @Param('missingPersonId') missingPersonId: string,
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateInformationSubmissionDto,
  ) {
    return this.informationSubmissionService.create(user.id, missingPersonId, data);
  }

  // ─────────────────────────────────────────────
  // MY SUBMISSIONS (paginated)
  // GET /information-submissions/mine
  // ─────────────────────────────────────────────

  @Get('mine')
  @ApiOperation({ summary: 'Get my information submissions' })
  @ApiQuery({ name: 'status', required: false, enum: InformationStatus })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findMine(@CurrentUser() user: CurrentUserDto, @Query() query: ListInformationSubmissionsQueryDto) {
    return this.informationSubmissionService.findMine(user.id, query);
  }

  // ─────────────────────────────────────────────
  // MY SUBMISSIONS FOR ONE MISSING PERSON
  // GET /information-submissions/missing-person/:missingPersonId/mine
  //
  // Registered before the public
  // 'missing-person/:missingPersonId' route so 'mine' is never
  // swallowed as a missingPersonId value.
  // ─────────────────────────────────────────────

  @Get('missing-person/:missingPersonId/mine')
  @ApiOperation({ summary: 'Get my information submissions for one missing person' })
  async findMineForMissingPerson(
    @Param('missingPersonId') missingPersonId: string,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.informationSubmissionService.findMineForMissingPerson(user.id, missingPersonId);
  }

  // ─────────────────────────────────────────────
  // INFORMATION FOR MISSING PERSON (public, paginated)
  // GET /information-submissions/missing-person/:missingPersonId
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // GET ONE
  // GET /information-submissions/:id
  // ─────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Get my information submission' })
  async findOne(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.findOne(id, user.id);
  }

  // ─────────────────────────────────────────────
  // UPDATE MY SUBMISSION
  // PATCH /information-submissions/:id
  // Only while PENDING (enforced in service).
  // ─────────────────────────────────────────────

  @Patch(':id')
  @ApiOperation({ summary: 'Update my information submission' })
  async update(
    @Param('id') id: string,
    @Body() data: UpdateInformationSubmissionDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.informationSubmissionService.update(id, user.id, data);
  }

  // ─────────────────────────────────────────────
  // DELETE MY SUBMISSION
  // DELETE /information-submissions/:id
  // Only while PENDING (enforced in service).
  // ─────────────────────────────────────────────

  @Delete(':id')
  @ApiOperation({ summary: 'Delete my information submission' })
  async remove(@Param('id') id: string, @CurrentUser() user: CurrentUserDto) {
    return this.informationSubmissionService.remove(id, user);
  }

  // ─────────────────────────────────────────────
  // ADMIN — ALL (paginated, lightweight)
  // GET /information-submissions/admin/all
  //
  // Registered before ':id' so this literal route is never
  // swallowed by the param route above.
  // ─────────────────────────────────────────────

  @Get('admin/all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: list information submissions' })
  @ApiQuery({ name: 'status', required: false, enum: InformationStatus })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAllForAdmin(@Query() query: ListInformationSubmissionsQueryDto) {
    return this.informationSubmissionService.findAllForAdmin(query);
  }

  // ─────────────────────────────────────────────
  // ADMIN — ONE (full detail)
  // GET /information-submissions/admin/:id
  //
  // Registered before the public ':id' route above would normally
  // matter, but since 'admin' isn't a valid submission id shape
  // this is purely for readability/consistency with Missing Person.
  // ─────────────────────────────────────────────

  @Get('admin/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: get full detail for one information submission' })
  async findOneForAdmin(@Param('id') id: string) {
    return this.informationSubmissionService.findOneForAdmin(id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — STATUS
  // PATCH /information-submissions/admin/:id/status
  // Only moves PENDING → UNDER_REVIEW (enforced in service).
  // ─────────────────────────────────────────────

  @Patch('admin/:id/status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: move information submission to under review' })
  async updateStatus(
    @Param('id') id: string,
    @Body() data: UpdateInformationSubmissionStatusDto,
    @CurrentUser() admin: CurrentUserDto,
  ) {
    return this.informationSubmissionService.updateStatus(admin, id, data.status);
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVIEW (terminal decision)
  // PATCH /information-submissions/admin/:id/review
  // Only valid from UNDER_REVIEW; reviewNote required on REJECTED
  // (enforced in service).
  // ─────────────────────────────────────────────

  @Patch('admin/:id/review')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: review information submission' })
  async review(
    @Param('id') id: string,
    @Body() data: ReviewInformationSubmissionDto,
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.informationSubmissionService.review(id, data.status, data.reviewNote, user);
  }
}
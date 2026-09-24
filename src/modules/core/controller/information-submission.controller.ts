import {
  Body,
  Controller,
  Delete,
  Get,
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
import { MediaKeyQueryDto } from 'src/modules/media/dto/media-key-query.dto';

import { InformationSubmissionService } from '../service/information-submission.service';

import {
  CreateInformationSubmissionDto,
  ListInformationSubmissionsQueryDto,
  ReviewInformationSubmissionDto,
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
  @ApiOperation({ summary: 'Submit information about a missing person' })
  async create(
    @Param('missingPersonId') missingPersonId: string,
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateInformationSubmissionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.informationSubmissionService.create(
      user,
      missingPersonId,
      data,
      idempotencyKey,
    );
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

  // PATCH /information-submissions/:id — only while PENDING (enforced in service).
  @Patch(':id')
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
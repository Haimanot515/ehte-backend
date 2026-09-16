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
// NOTE: adjust these two import paths to match your actual file locations —
// same convention as Roles / RolesEnum above.
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

// NOTE: adjust this path to wherever MediaModule actually lives —
// same DTO used by VictimProfileController for its media routes.
import { MediaKeyQueryDto } from 'src/modules/media/dto/media-key-query.dto';

import { InformationSubmissionService } from '../service/information-submission.service';

import {
  CreateInformationSubmissionDto,
  ListInformationSubmissionsQueryDto,
  ReviewInformationSubmissionDto,
  UpdateInformationSubmissionDto,
  UpdateInformationSubmissionStatusDto,
} from '../dto/information-submission.dto';

// ─────────────────────────────────────────────
// Media download URLs are deliberately NOT served by a generic
// media module — same reasoning as VictimProfileController.
// Authorization for "can this caller download this specific
// object" has to go through the same visibility rules findOne()/
// findForMissingPerson()/findOneForAdmin() already enforce, so it
// lives here, split into owner / public / admin variants.
// ─────────────────────────────────────────────

@ApiTags('Information Submissions')
@ApiBearerAuth('access-token')
@Controller('information-submissions')
export class InformationSubmissionController {
  constructor(private readonly informationSubmissionService: InformationSubmissionService) {}

  // ─────────────────────────────────────────────
  // CREATE
  // POST /information-submissions/missing-person/:missingPersonId
  //
  // FIX (item #5): accepts an optional Idempotency-Key header so a
  // client retrying after a dropped response (double-tap on a
  // flaky connection) doesn't end up creating two identical
  // submissions — InformationSubmissionService.create returns the
  // original submission on a repeat key instead.
  // ─────────────────────────────────────────────

  @Post('missing-person/:missingPersonId')
  @ApiOperation({ summary: 'Submit information about a missing person' })
  async create(
    @Param('missingPersonId') missingPersonId: string,
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateInformationSubmissionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.informationSubmissionService.create(
      user.id,
      missingPersonId,
      data,
      idempotencyKey,
    );
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
  async findMine(
    @CurrentUser() user: CurrentUserDto,
    @Query() query: ListInformationSubmissionsQueryDto,
  ) {
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
  // PUBLIC — MEDIA DOWNLOAD URL
  // GET /information-submissions/public/:id/media?key=...
  //
  // Registered before the owner ':id' route below so 'public' is
  // never swallowed as a submission id value.
  //
  // Returns a download URL only for media on a submission that has
  // reached REVIEWED — same visibility contract as
  // findForMissingPerson(). A submission that exists but isn't
  // reviewed yet, or a key not actually attached to it, both 404.
  // ─────────────────────────────────────────────

  @Get('public/:id/media')
  @AllowAnonymous()
  @ApiOperation({ summary: "Get a short-lived download URL for a reviewed submission's media" })
  async getPublicMedia(@Param('id') id: string, @Query() query: MediaKeyQueryDto) {
    return this.informationSubmissionService.getPublicMediaDownloadUrl(id, query.key);
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
  // MEDIA — DOWNLOAD URL (owner)
  // GET /information-submissions/:id/media?key=...
  //
  // Owner can request a download URL for any media key actually
  // attached to their own submission, regardless of status — same
  // admin-style ownership check as findOne(), scoped to the caller.
  // ─────────────────────────────────────────────

  @Get(':id/media')
  @ApiOperation({ summary: 'Get a short-lived download URL for my submission media' })
  async getMedia(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserDto,
    @Query() query: MediaKeyQueryDto,
  ) {
    return this.informationSubmissionService.getMediaDownloadUrl(id, user.id, query.key);
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
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: list information submissions' })
  @ApiQuery({ name: 'status', required: false, enum: InformationStatus })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAllForAdmin(@Query() query: ListInformationSubmissionsQueryDto) {
    return this.informationSubmissionService.findAllForAdmin(query);
  }

  // ─────────────────────────────────────────────
  // ADMIN — STALE / UNREVIEWED-TOO-LONG SUBMISSIONS
  // GET /information-submissions/admin/stale
  // (item #15)
  //
  // Declared BEFORE 'admin/:id' so Nest doesn't treat "stale" as a
  // submission id — same route-order reasoning as elsewhere in
  // this controller and PostController.
  // ─────────────────────────────────────────────

  @Get('admin/stale')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({
    summary: 'Admin: get information submissions that have been waiting too long',
  })
  async findStalePending() {
    return this.informationSubmissionService.findStalePending();
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
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: get full detail for one information submission' })
  async findOneForAdmin(@Param('id') id: string) {
    return this.informationSubmissionService.findOneForAdmin(id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — MEDIA DOWNLOAD URL
  // GET /information-submissions/admin/:id/media?key=...
  //
  // Admins can request a download URL for any media key actually
  // attached to the submission, regardless of status — same
  // admin-only, no-visibility-filtering access as findOneForAdmin().
  // ─────────────────────────────────────────────

  @Get('admin/:id/media')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: "Admin: get a short-lived download URL for a submission's media" })
  async getMediaForAdmin(@Param('id') id: string, @Query() query: MediaKeyQueryDto) {
    return this.informationSubmissionService.getMediaDownloadUrlForAdmin(id, query.key);
  }

  // ─────────────────────────────────────────────
  // ADMIN — PER-SUBMISSION HISTORY / TIMELINE
  // GET /information-submissions/admin/:id/history
  // (item #18)
  // ─────────────────────────────────────────────

  @Get('admin/:id/history')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: get the audit timeline for one information submission' })
  async getHistory(@Param('id') id: string) {
    return this.informationSubmissionService.getHistory(id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — STATUS
  // PATCH /information-submissions/admin/:id/status
  // Only moves PENDING → UNDER_REVIEW (enforced in service).
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // ADMIN — REVIEW (terminal decision)
  // PATCH /information-submissions/admin/:id/review
  // Only valid from UNDER_REVIEW; reviewNote required on REJECTED
  // (enforced in service).
  // ─────────────────────────────────────────────

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
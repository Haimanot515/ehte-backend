import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { MissingPersonStatus } from '@prisma/client';
// NOTE: adjust these two import paths to match your actual file locations —
// same convention as Roles / RolesEnum above.
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
// NOTE: adjust this path to wherever MediaModule actually lives — same
// DTO VictimProfileController/PostController/ReportController already
// use for their media routes.
import { MediaKeyQueryDto } from 'src/modules/media/dto/media-key-query.dto';

import {
  CreateMissingPersonDto,
  ListMissingPersonsAdminQueryDto,
  ListMissingPersonsQueryDto,
  UpdateMissingPersonDto,
  UpdateMissingPersonStatusDto,
} from '../dto/missing-person.dto';

import { MissingPersonService } from '../service/missing-person.service';

@ApiTags('Missing Persons')
@Controller('missing-persons')
export class MissingPersonController {
  constructor(private readonly missingPersonService: MissingPersonService) {}

  // ─────────────────────────────────────────────
  // CREATE
  // POST /missing-persons
  // Authenticated USER
  // TODO: apply the project's re-authentication guard here
  // (sensitive-data endpoint — see review item 7).
  // ─────────────────────────────────────────────

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Submit a missing person report' })
  async create(@CurrentUser() user: CurrentUserDto, @Body() data: CreateMissingPersonDto) {
    return this.missingPersonService.create(user, data);
  }

  // ─────────────────────────────────────────────
  // MY SUBMISSIONS (paginated)
  // GET /missing-persons/mine
  // Authenticated USER
  // TODO: apply the project's re-authentication guard here.
  // ─────────────────────────────────────────────

  @Get('mine')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get my missing person submissions' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findMine(@CurrentUser() user: CurrentUserDto, @Query() query: ListMissingPersonsQueryDto) {
    return this.missingPersonService.findMine(user, query);
  }

  // ─────────────────────────────────────────────
  // OWNER — GET MEDIA DOWNLOAD URL
  // GET /missing-persons/mine/:id/media?key=...
  //
  // Lets the submitter request a download URL for a key attached
  // to their own submission, in any status — mirrors
  // ReportController's reporter-owned media route. findMine()
  // returns raw filepaths with no way to turn them into an actual
  // URL otherwise.
  //
  // Different path depth from 'mine' (1 segment) and from the
  // public ':id' route below (1 segment), so declaration order
  // relative to those doesn't matter — grouped here for readability.
  //
  // Authenticated USER
  // ─────────────────────────────────────────────

  @Get('mine/:id/media')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: "Get a short-lived download URL for one of my own submission's media" })
  async getMediaForOwner(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: MediaKeyQueryDto,
  ) {
    return this.missingPersonService.getMediaDownloadUrlForOwner(user, id, query.key);
  }

  // ─────────────────────────────────────────────
  // PUBLIC LIST
  // GET /missing-persons
  // Anonymous
  // ─────────────────────────────────────────────

  @Get()
  @AllowAnonymous()
  @ApiOperation({ summary: 'Get approved missing persons' })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAll(@Query() query: ListMissingPersonsQueryDto) {
    return this.missingPersonService.findAll(query);
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ALL (lightweight list)
  // GET /missing-persons/admin/all
  // ADMIN / SUPER_ADMIN
  //
  // Registered before ':id' and 'admin/:id' so this literal route
  // is never swallowed by a param route.
  // ─────────────────────────────────────────────

  @Get('admin/all')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: get all missing person submissions' })
  @ApiQuery({ name: 'status', required: false, enum: MissingPersonStatus })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAllForAdmin(@Query() query: ListMissingPersonsAdminQueryDto) {
    return this.missingPersonService.findAllForAdmin(query);
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ONE (full detail, incl. information submissions)
  // GET /missing-persons/admin/:id
  // ADMIN / SUPER_ADMIN
  //
  // Registered before the public ':id' route below.
  //
  // Requires both MISSING_PERSON_READ and
  // MISSING_PERSON_INFO_READ because the payload includes
  // the related information submissions, not just the
  // missing-person record itself.
  // ─────────────────────────────────────────────

  @Get('admin/:id')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ, PermissionsEnum.MISSING_PERSON_INFO_READ)
  @ApiOperation({ summary: 'Admin: get full detail for one missing person' })
  async findOneForAdmin(@Param('id') id: string) {
    return this.missingPersonService.findOneForAdmin(id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET MEDIA DOWNLOAD URL
  // GET /missing-persons/admin/:id/media?key=...
  //
  // Admins can request a download URL for any media key actually
  // attached to the submission, regardless of status — same
  // admin-only, no-visibility-filtering access as findOneForAdmin().
  // ─────────────────────────────────────────────

  @Get('admin/:id/media')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: "Admin: get a short-lived download URL for a submission's media" })
  async getMedia(@Param('id') id: string, @Query() query: MediaKeyQueryDto) {
    return this.missingPersonService.getMediaDownloadUrl(id, query.key);
  }

  // ─────────────────────────────────────────────
  // PUBLIC ONE
  // GET /missing-persons/:id
  // Anonymous — only ever returns APPROVED records
  // ─────────────────────────────────────────────

  @Get(':id')
  @AllowAnonymous()
  @ApiOperation({ summary: 'Get one approved missing person' })
  async findOne(@Param('id') id: string) {
    return this.missingPersonService.findOne(id);
  }

  // ─────────────────────────────────────────────
  // PUBLIC — GET MEDIA DOWNLOAD URL
  // GET /missing-persons/:id/media?key=...
  //
  // Same visibility gate as findOne(): the record must be
  // APPROVED. Different path depth from the single-segment ':id'
  // route above, so order relative to it doesn't matter — grouped
  // here for readability.
  //
  // Anonymous
  // ─────────────────────────────────────────────

  @Get(':id/media')
  @AllowAnonymous()
  @ApiOperation({ summary: "Get a short-lived download URL for an approved submission's media" })
  async getPublicMedia(@Param('id') id: string, @Query() query: MediaKeyQueryDto) {
    return this.missingPersonService.getPublicMediaDownloadUrl(id, query.key);
  }

  // ─────────────────────────────────────────────
  // UPDATE MY SUBMISSION
  // PATCH /missing-persons/:id
  // Authenticated USER — only while PENDING or
  // MORE_INFORMATION_REQUESTED (enforced in service)
  // TODO: apply the project's re-authentication guard here.
  // ─────────────────────────────────────────────

  @Patch(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Update my missing person submission' })
  async update(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: UpdateMissingPersonDto,
  ) {
    return this.missingPersonService.update(user, id, data);
  }

  // ─────────────────────────────────────────────
  // DELETE MY SUBMISSION
  // DELETE /missing-persons/:id
  // Authenticated USER — only while PENDING (enforced in service)
  // TODO: apply the project's re-authentication guard here.
  // ─────────────────────────────────────────────

  @Delete(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Delete my missing person submission' })
  async remove(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonService.remove(user, id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  // PATCH /missing-persons/admin/:id/status
  // ADMIN / SUPER_ADMIN — transitions enforced in service;
  // reviewNote required for REJECTED / MORE_INFORMATION_REQUESTED
  // ─────────────────────────────────────────────

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
    return this.missingPersonService.updateStatus(admin, id, data.status, data.reviewNote);
  }
}

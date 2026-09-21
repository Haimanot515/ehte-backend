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
  CreateMissingPersonDto,
  ListMissingPersonsAdminQueryDto,
  ListMissingPersonsQueryDto,
  UpdateMissingPersonDto,
  UpdateMissingPersonRewardDto,
  UpdateMissingPersonStatusDto,
} from '../dto/missing-person.dto';

import { MissingPersonService } from '../service/missing-person.service';

@ApiTags('Missing Persons')
@Controller('missing-persons')
export class MissingPersonController {
  constructor(private readonly missingPersonService: MissingPersonService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Submit a missing person report' })
  async create(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateMissingPersonDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.missingPersonService.create(user, data, idempotencyKey);
  }

  // Admin creates a case directly. CHILD cases still need two-admin approval.
  @Post('admin')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: create a missing person case directly' })
  async createByAdmin(
    @CurrentUser() admin: CurrentUserDto,
    @Body() data: AdminCreateMissingPersonDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.missingPersonService.createByAdmin(admin, data, idempotencyKey);
  }

  @Get('mine')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get my missing person submissions' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findMine(@CurrentUser() user: CurrentUserDto, @Query() query: ListMissingPersonsQueryDto) {
    return this.missingPersonService.findMine(user, query);
  }

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

  @Get()
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get approved missing persons (requires login)' })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAll(@Query() query: ListMissingPersonsQueryDto) {
    return this.missingPersonService.findAll(query);
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
    return this.missingPersonService.findAllForAdmin(query);
  }

  @Get('admin/stale')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: get unreviewed missing person cases that have waited too long' })
  async findStalePending() {
    return this.missingPersonService.findStalePending();
  }

  @Get('admin/:id')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ, PermissionsEnum.MISSING_PERSON_INFO_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin: get full detail for one missing person' })
  async findOneForAdmin(@Param('id') id: string) {
    return this.missingPersonService.findOneForAdmin(id);
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
    return this.missingPersonService.getMediaDownloadUrl(admin, id, query.key);
  }

  @Get('admin/:id/history')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_READ)
  @ApiOperation({ summary: 'Admin: get the audit timeline for one missing person case' })
  async getHistory(@Param('id') id: string) {
    return this.missingPersonService.getHistory(id);
  }

  @Patch('admin/:id/claim')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: claim a missing person case' })
  async claim(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonService.claimMissingPerson(admin, id);
  }

  @Patch('admin/:id/unclaim')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: release a claimed missing person case' })
  async unclaim(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonService.unclaimMissingPerson(admin, id);
  }

  @Patch('admin/:id/reward')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MISSING_PERSON_REVIEW)
  @ApiOperation({ summary: 'Admin: approve or revise the reward for a missing person case' })
  async updateReward(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: UpdateMissingPersonRewardDto,
  ) {
    return this.missingPersonService.updateReward(
      admin,
      id,
      data.rewardApproved,
      data.rewardAmount,
      data.rewardDetails,
    );
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get one approved missing person (requires login)' })
  async findOne(@Param('id') id: string) {
    return this.missingPersonService.findOne(id);
  }

  @Get(':id/media')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Get a short-lived download URL for an approved submission's media (requires login)",
  })
  async getPublicMedia(@Param('id') id: string, @Query() query: MediaKeyQueryDto) {
    return this.missingPersonService.getPublicMediaDownloadUrl(id, query.key);
  }

  @Patch(':id')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Update my missing person submission' })
  async update(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: UpdateMissingPersonDto,
  ) {
    return this.missingPersonService.update(user, id, data);
  }

  @Delete(':id')
  @ApiBearerAuth('access-token')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Delete my missing person submission' })
  async remove(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.missingPersonService.remove(user, id);
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
    return this.missingPersonService.updateStatus(
      admin,
      id,
      data.status,
      data.reviewNote,
      data.childSafetyConfirmed,
    );
  }
}
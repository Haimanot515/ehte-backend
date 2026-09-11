import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
// NOTE: adjust these two import paths to match your actual file locations —
// same convention as Roles / RolesEnum above.
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import { VictimProfileService } from '../service/victim-profile.service';

import {
  CreateVictimProfileDto,
  FindAllVictimProfilesQueryDto,
  FindPublicVictimProfilesQueryDto,
  RevokeConsentDto,
  UpdateBankDetailsDto,
  UpdateChildSafetyReviewDto,
  UpdateVictimGateDto,
  UpdateVictimProfileDto,
} from '../dto/victim-profile.dto';

// ─────────────────────────────────────────────
// PRD §19: "Authorized administrators can create or manage a
// Victim/Survivor Profile." Every mutating and single-record read
// route below is admin-only. The only public-facing routes are
// GET /victim-profiles/public and GET /victim-profiles/public/:id.
// ─────────────────────────────────────────────

@ApiTags('Victim Profiles')
@Controller('victim-profiles')
export class VictimProfileController {
  constructor(private readonly victimProfileService: VictimProfileService) {}

  // ─────────────────────────────────────────────
  // CREATE
  // POST /victim-profiles
  // ─────────────────────────────────────────────

  @Post()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_CREATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: create a victim/survivor support profile',
  })
  async create(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: CreateVictimProfileDto,
  ) {
    return this.victimProfileService.create(user, data);
  }

  // ─────────────────────────────────────────────
  // PUBLIC PROFILES — LIST
  // GET /victim-profiles/public
  // ─────────────────────────────────────────────

  @Get('public')
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get published victim profiles',
  })
  async findPublic(
    @Query()
    query: FindPublicVictimProfilesQueryDto,
  ) {
    return this.victimProfileService.findPublic(query);
  }

  // ─────────────────────────────────────────────
  // PUBLIC PROFILES — SINGLE
  // GET /victim-profiles/public/:id
  // ─────────────────────────────────────────────

  @Get('public/:id')
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get a single published victim profile',
  })
  async findOnePublic(
    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.findOnePublic(id);
  }

  // ─────────────────────────────────────────────
  // GET ONE
  // GET /victim-profiles/:id
  // ─────────────────────────────────────────────

  @Get(':id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get a victim profile',
  })
  async findOne(
    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.findOne(id);
  }

  // ─────────────────────────────────────────────
  // GET ONE — SUPPORT/DONATION SUMMARY
  // GET /victim-profiles/:id/supports
  //
  // findOne() already includes confirmed supports, but as support
  // volume grows a dashboard shouldn't have to pull the whole
  // profile payload just to show totals.
  // ─────────────────────────────────────────────

  @Get(':id/supports')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get support/donation summary for a victim profile',
  })
  async getSupportsSummary(
    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.getSupportsSummary(id);
  }

  // ─────────────────────────────────────────────
  // UPDATE
  // PATCH /victim-profiles/:id
  // ─────────────────────────────────────────────

  @Patch(':id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: update a victim profile',
  })
  async update(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: UpdateVictimProfileDto,
  ) {
    return this.victimProfileService.update(user, id, data);
  }

  // ─────────────────────────────────────────────
  // DELETE
  // DELETE /victim-profiles/:id
  // ─────────────────────────────────────────────

  @Delete(':id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: delete a victim profile',
  })
  async remove(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.remove(user, id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — ALL
  // GET /victim-profiles/admin/all
  // ─────────────────────────────────────────────

  @Get('admin/all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: list victim profiles',
  })
  async findAllForAdmin(
    @Query()
    query: FindAllVictimProfilesQueryDto,
  ) {
    return this.victimProfileService.findAllForAdmin(query);
  }

  // ─────────────────────────────────────────────
  // ADMIN — DASHBOARD STATISTICS
  // GET /victim-profiles/admin/stats
  //
  // Avoids the dashboard having to page through every profile
  // just to compute per-status counts.
  // ─────────────────────────────────────────────

  @Get('admin/stats')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get victim profile counts by status',
  })
  async getStats() {
    return this.victimProfileService.getStats();
  }

  // ─────────────────────────────────────────────
  // ADMIN — AUDIT HISTORY
  // GET /victim-profiles/admin/:id/history
  // ─────────────────────────────────────────────

  @Get('admin/:id/history')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.AUDIT_LOG_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get audit history for a victim profile',
  })
  async getHistory(
    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.getHistory(id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET APPROVAL/GATE STATUS
  // GET /victim-profiles/admin/:id/gates
  //
  // Lets the admin dashboard render checklist state without
  // inspecting the whole profile payload.
  // ─────────────────────────────────────────────

  @Get('admin/:id/gates')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get approval gate status for a victim profile',
  })
  async getGates(
    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.getGates(id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE APPROVAL GATES
  // PATCH /victim-profiles/admin/:id/gates
  // ─────────────────────────────────────────────

  @Patch('admin/:id/gates')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: update victim profile approval gates',
  })
  async updateGates(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: UpdateVictimGateDto,
  ) {
    return this.victimProfileService.updateGates(id, data, user.id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — CHILD SAFETY REVIEW (§32)
  // PATCH /victim-profiles/admin/:id/child-safety-review
  // ─────────────────────────────────────────────

  @Patch('admin/:id/child-safety-review')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: record child-safety review outcome for a victim profile',
  })
  async updateChildSafetyReview(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: UpdateChildSafetyReviewDto,
  ) {
    return this.victimProfileService.updateChildSafetyReview(id, data, user.id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVOKE CONSENT
  // PATCH /victim-profiles/admin/:id/consent/revoke
  // ─────────────────────────────────────────────

  @Patch('admin/:id/consent/revoke')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: revoke previously recorded consent for a victim profile',
  })
  async revokeConsent(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: RevokeConsentDto,
  ) {
    return this.victimProfileService.revokeConsent(id, data, user.id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE BANK DETAILS
  // PATCH /victim-profiles/admin/:id/bank-details
  //
  // Sensitive financial operation. NOTE: SUPPORT_PAYMENT_MANAGE is
  // currently not in adminPermissions, so an ordinary ADMIN will be
  // denied here even with this decorator in place — only
  // SUPER_ADMIN gets it, by design (least privilege). If an ADMIN
  // reports being blocked on this route, that is expected, not a bug.
  // ─────────────────────────────────────────────

  @Patch('admin/:id/bank-details')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: update the off-platform transfer destination on a victim profile',
  })
  async updateBankDetails(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: UpdateBankDetailsDto,
  ) {
    return this.victimProfileService.updateBankDetails(id, data, user.id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — PUBLISH
  // PATCH /victim-profiles/admin/:id/publish
  // ─────────────────────────────────────────────

  @Patch('admin/:id/publish')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_PUBLISH)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: publish approved victim profile',
  })
  async publish(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.publish(id, user.id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — UNPUBLISH
  // PATCH /victim-profiles/admin/:id/unpublish
  // ─────────────────────────────────────────────

  @Patch('admin/:id/unpublish')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UNPUBLISH)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: unpublish victim profile',
  })
  async unpublish(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.unpublish(id, user.id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — REJECT
  // PATCH /victim-profiles/admin/:id/reject
  // ─────────────────────────────────────────────

  @Patch('admin/:id/reject')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: reject victim profile',
  })
  async reject(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.reject(id, user.id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — RESUBMIT AFTER REJECTION
  // PATCH /victim-profiles/admin/:id/resubmit
  // ─────────────────────────────────────────────

  @Patch('admin/:id/resubmit')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: return a rejected victim profile to the approval pipeline',
  })
  async resubmit(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.resubmit(id, user.id);
  }
}
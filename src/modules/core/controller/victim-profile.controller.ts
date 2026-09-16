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

import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';

import { MediaKeyQueryDto } from 'src/modules/media/dto/media-key-query.dto';

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

@ApiTags('Victim Profiles')
@Controller('victim-profiles')
export class VictimProfileController {
  constructor(private readonly victimProfileService: VictimProfileService) {}

  // ─────────────────────────────────────────────
  // CREATE
  // POST /victim-profiles
  //
  // FIX (item #5): accepts an optional Idempotency-Key header, same
  // convention as ReportController.create, so a client retrying
  // after a dropped response doesn't create a duplicate profile.
  //
  // FIX (item #12): route-specific burst limit — creation is
  // admin-only so spam risk is lower than a public-facing endpoint,
  // but a compromised or careless admin session shouldn't be able to
  // flood the review queue either.
  //
  // FIX (item #23): sensitive/high-stakes creation now requires
  // re-authentication, matching ReportController.create's posture.
  // ─────────────────────────────────────────────

  @Post()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_CREATE)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: create a victim/survivor support profile',
  })
  async create(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: CreateVictimProfileDto,

    @Headers('idempotency-key')
    idempotencyKey?: string,
  ) {
    return this.victimProfileService.create(user, data, idempotencyKey);
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
  // PUBLIC PROFILES — MEDIA DOWNLOAD URL
  // GET /victim-profiles/public/:id/media?key=...
  // ─────────────────────────────────────────────

  @Get('public/:id/media')
  @AllowAnonymous()
  @ApiOperation({
    summary: "Get a short-lived download URL for a published profile's media",
  })
  async getPublicMedia(
    @Param('id')
    id: string,

    @Query()
    query: MediaKeyQueryDto,
  ) {
    return this.victimProfileService.getPublicMediaDownloadUrl(id, query.key);
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
  // GET MEDIA DOWNLOAD URL (admin)
  // GET /victim-profiles/:id/media?key=...
  // ─────────────────────────────────────────────

  @Get(':id/media')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Admin: get a short-lived download URL for a profile's media",
  })
  async getMedia(
    @CurrentUser()
    admin: CurrentUserDto,

    @Param('id')
    id: string,

    @Query()
    query: MediaKeyQueryDto,
  ) {
    return this.victimProfileService.getMediaDownloadUrl(admin, id, query.key);
  }

  // ─────────────────────────────────────────────
  // CLAIM / UNCLAIM (item #17)
  // PATCH /victim-profiles/:id/claim
  // PATCH /victim-profiles/:id/unclaim
  //
  // Self-serve claim, open to any ADMIN/SUPER_ADMIN — the write-side
  // gate lives in VictimProfileService.assertAdminCanAccessProfile,
  // which every mutating method below now calls. Unclaim is left
  // open to ADMIN too (the service itself restricts a plain ADMIN to
  // releasing only their own claim; SUPER_ADMIN can release any).
  // ─────────────────────────────────────────────

  @Patch(':id/claim')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: claim a victim profile for review' })
  async claim(
    @CurrentUser()
    admin: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.claim(admin, id);
  }

  @Patch(':id/unclaim')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: release a claimed victim profile' })
  async unclaim(
    @CurrentUser()
    admin: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.unclaim(admin, id);
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
  // ADMIN — STALE / UNCLAIMED-TOO-LONG PROFILES (item #15)
  // GET /victim-profiles/admin/stale
  // ─────────────────────────────────────────────

  @Get('admin/stale')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get unclaimed victim profiles that have been waiting too long',
  })
  async findStalePending() {
    return this.victimProfileService.findStalePending();
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
    return this.victimProfileService.updateGates(user, id, data);
  }

  // ─────────────────────────────────────────────
  // ADMIN — CHILD SAFETY REVIEW (§32 / item #16)
  // PATCH /victim-profiles/admin/:id/child-safety-review
  //
  // Requires two DIFFERENT admins to confirm before
  // isChildSafetyReviewed flips true — see the service method's
  // header comment. The response for a first confirmation looks the
  // same shape as a full profile but isChildSafetyReviewed will
  // still read false; the client should surface that distinction
  // (e.g. "waiting on a second reviewer") rather than treating any
  // 200 as "review complete."
  // ─────────────────────────────────────────────

  @Patch('admin/:id/child-safety-review')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_REVIEW)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: record child-safety review outcome for a victim profile (requires two admins)',
  })
  async updateChildSafetyReview(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: UpdateChildSafetyReviewDto,
  ) {
    return this.victimProfileService.updateChildSafetyReview(user, id, data);
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVOKE CONSENT
  // PATCH /victim-profiles/admin/:id/consent/revoke
  // ─────────────────────────────────────────────

  @Patch('admin/:id/consent/revoke')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PROFILE_UPDATE)
  @RequireReauthentication()
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
    return this.victimProfileService.revokeConsent(user, id, data);
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE BANK DETAILS
  // PATCH /victim-profiles/admin/:id/bank-details
  //
  // FIX (item #23): re-authentication added — this is the most
  // financially sensitive write in this controller (it's the
  // off-platform transfer destination), and SUPPORT_PAYMENT_MANAGE
  // alone isn't a second factor.
  // ─────────────────────────────────────────────

  @Patch('admin/:id/bank-details')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @RequireReauthentication()
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
    return this.victimProfileService.updateBankDetails(user, id, data);
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
    return this.victimProfileService.publish(user, id);
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
    return this.victimProfileService.unpublish(user, id);
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
    return this.victimProfileService.reject(user, id);
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
    return this.victimProfileService.resubmit(user, id);
  }
}
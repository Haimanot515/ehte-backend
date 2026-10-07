import { Body, Controller, Get, Param, ParseEnumPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { PermissionsEnum as P } from 'src/common/enums/permissions.enum';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditSeverity } from '@prisma/client';
import { SharedRecordEntity } from 'src/common/enums/shared/shared-record-entity.enum';
import { AdminReferralsService } from '../service/admin-referrals.service';
import {
  AttachReferralDocumentDto,
  CreateReferralDto,
  ReferralListQueryDto,
  ReferralStatsQueryDto,
  RevealReferralDetailsDto,
  UpdateReferralStatusDto,
} from '../dto/admin-referrals.dto';

/**
 * REFERRALS TO INSTITUTIONS (SH-09 to SH-18).
 *
 * ROUTE ORDER: 'overdue', 'stats' and 'by-record/...' are declared before ':id'.
 * SH-15 (reveal-details) needs re-auth plus a reason, and every reveal is audited.
 * SH-18 lives under 'admin/institutions/:id/referrals' so the class has no prefix.
 */
@ApiTags('Admin: referrals')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin')
export class AdminReferralsController {
  constructor(private readonly referrals: AdminReferralsService) {}

  // SH-09
  @Post('referrals')
  @RequirePermissions(P.REFERRAL_MANAGE)
  @AuditEvent({ action: AuditEventEnum.REFERRAL_CREATED, entity: 'Referral' })
  @ApiOperation({ summary: 'Admin: refer a record to an institution and track the outcome' })
  create(@CurrentUser() admin: CurrentUserDto, @Body() body: CreateReferralDto) {
    return this.referrals.create(admin, body);
  }

  // SH-10
  @Get('referrals')
  @RequirePermissions(P.REFERRAL_MANAGE)
  @ApiOperation({ summary: 'Admin: referrals by status and institution' })
  list(@CurrentUser() admin: CurrentUserDto, @Query() q: ReferralListQueryDto) {
    return this.referrals.list(admin, q);
  }

  // SH-16
  @Get('referrals/overdue')
  @RequirePermissions(P.REFERRAL_MANAGE)
  @ApiOperation({ summary: 'Admin: referrals with no acknowledgement after the set time' })
  overdue(@CurrentUser() admin: CurrentUserDto, @Query() q: ReferralListQueryDto) {
    return this.referrals.overdue(admin, q);
  }

  // SH-17
  @Get('referrals/stats')
  @RequirePermissions(P.REFERRAL_MANAGE)
  @ApiOperation({ summary: 'Admin: referrals by institution, status and response time' })
  stats(@Query() q: ReferralStatsQueryDto) {
    return this.referrals.stats(q);
  }

  // SH-13
  @Get('referrals/by-record/:entity/:entityId')
  @RequirePermissions(P.REFERRAL_MANAGE)
  @ApiOperation({ summary: 'Admin: referrals on one record' })
  @ApiParam({ name: 'entity', enum: SharedRecordEntity })
  byRecord(
    @CurrentUser() admin: CurrentUserDto,
    @Param('entity', new ParseEnumPipe(SharedRecordEntity)) entity: SharedRecordEntity,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Query() q: ReferralListQueryDto,
  ) {
    return this.referrals.byRecord(admin, entity, entityId, q);
  }

  // SH-11
  @Get('referrals/:id')
  @RequirePermissions(P.REFERRAL_MANAGE)
  @AuditEvent({ action: AuditEventEnum.REFERRAL_VIEWED, entity: 'Referral', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: one referral with its status history' })
  getOne(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.referrals.getOne(admin, id);
  }

  // SH-12
  @Patch('referrals/:id/status')
  @RequirePermissions(P.REFERRAL_MANAGE)
  @AuditEvent({ action: AuditEventEnum.REFERRAL_STATUS_CHANGED, entity: 'Referral', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: acknowledged, in progress or closed, with notes' })
  updateStatus(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateReferralStatusDto,
  ) {
    return this.referrals.updateStatus(admin, id, body);
  }

  // SH-14
  @Post('referrals/:id/documents')
  @RequirePermissions(P.REFERRAL_MANAGE)
  @AuditEvent({ action: AuditEventEnum.REFERRAL_DOCUMENT_ATTACHED, entity: 'Referral', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: attach a document (uploaded media key) to a referral' })
  attachDocument(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AttachReferralDocumentDto,
  ) {
    return this.referrals.attachDocument(admin, id, body);
  }

  // SH-15
  @Post('referrals/:id/reveal-details')
  @RequirePermissions(P.REFERRAL_SENSITIVE)
  @RequireReauthentication()
  @AuditEvent({ action: AuditEventEnum.REFERRAL_DETAILS_REVEALED, entity: 'Referral', entityId: { param: 'id' }, severity: AuditSeverity.WARNING })
  @ApiOperation({
    summary: 'Admin: show survivor or informant details to be shared (reason + re-auth, audited)',
  })
  revealDetails(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevealReferralDetailsDto,
  ) {
    return this.referrals.revealDetails(admin, id, body);
  }

  // SH-18
  @Get('institutions/:id/referrals')
  @RequirePermissions(P.REFERRAL_MANAGE)
  @ApiOperation({ summary: 'Admin: referrals sent to one institution' })
  byInstitution(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ReferralListQueryDto,
  ) {
    return this.referrals.byInstitution(admin, id, q);
  }
}

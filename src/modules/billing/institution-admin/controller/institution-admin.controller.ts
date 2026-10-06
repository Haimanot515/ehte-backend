import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { CurrentUserDto } from '../../../../common/dtos/current-user.dto';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { RolesEnum } from '../../../../common/enums/roles.enum';
import { RequirePermissions } from '../../../../common/decorators/require-permissions.decorator';
import { RequireReauthentication } from '../../../../common/decorators/reauth.decorator';
import { PermissionsEnum as P } from '../../../../common/enums/permissions.enum';

import { InstitutionAdminService } from '../service/institution-admin.service';
import { CreatePayoutDestinationDto, ExpiringAgreementsQueryDto, InstitutionsQueryDto, PayoutDestinationsQueryDto, StatementQueryDto, UpdateDraftAgreementDto, UpdateInstitutionDto, UpdatePayoutDestinationDto } from '../dto/institution-admin.dto';
import { PagingDto, ReasonBodyDto } from 'src/modules/billing/shared/dto/billing-common.dto';

@ApiTags('Billing admin: institutions and agreements')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/billing')
export class InstitutionAdminController {
  constructor(private readonly svc: InstitutionAdminService) {}

  // ── Institutions ─────────────────────────────────────────────────────

  // BL-37
  @Get('institutions')
  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @ApiOperation({ summary: 'Admin: list institutions' })
  list(@Query() q: InstitutionsQueryDto) {
    return this.svc.listInstitutions(q);
  }

  // BL-38
  @Get('institutions/:id')
  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @ApiOperation({
    summary: 'Admin: one institution with agreements and masked payout destinations',
  })
  get(@Param('id') id: string) {
    return this.svc.getInstitution(id);
  }

  // BL-39
  @Patch('institutions/:id')
  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @ApiOperation({ summary: 'Admin: edit institution details' })
  update(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: UpdateInstitutionDto,
  ) {
    return this.svc.updateInstitution(admin.id, id, body);
  }

  // BL-40
  @Patch('institutions/:id/deactivate')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Super admin: suspend an institution without deleting history' })
  deactivate(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: ReasonBodyDto,
  ) {
    return this.svc.deactivate(admin.id, id, body.reason);
  }

  // BL-41
  @Patch('institutions/:id/reactivate')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Super admin: bring a suspended institution back' })
  reactivate(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: ReasonBodyDto,
  ) {
    return this.svc.reactivate(admin.id, id, body.reason);
  }

  // BL-42
  @Get('institutions/:id/statement')
  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @ApiOperation({ summary: 'Admin: allocations and payouts for an institution over a period' })
  statement(@Param('id') id: string, @Query() q: StatementQueryDto) {
    return this.svc.statement(id, q);
  }

  // BL-43
  @Get('institutions/:id/profiles')
  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @ApiOperation({ summary: 'Admin: victim profiles tied to an institution through its agreements' })
  profiles(@Param('id') id: string, @Query() q: PagingDto) {
    return this.svc.profiles(id, q);
  }

  // BL-51
  @Post('institutions/:id/payout-destination')
  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: create an institution payout destination (starts unverified)' })
  createDestination(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: CreatePayoutDestinationDto,
  ) {
    return this.svc.createDestination(admin.id, id, body);
  }

  // ── Agreements ───────────────────────────────────────────────────────

  // BL-49 (declared before agreements/:id)
  @Get('agreements/expiring')
  @RequirePermissions(P.AGREEMENTS_MANAGE)
  @ApiOperation({ summary: 'Admin: active agreements ending soon' })
  expiring(@Query() q: ExpiringAgreementsQueryDto) {
    return this.svc.expiring(q);
  }

  // BL-44
  @Get('agreements/:id')
  @RequirePermissions(P.AGREEMENTS_MANAGE)
  @ApiOperation({ summary: 'Admin: one agreement with its rules' })
  getAgreement(@Param('id') id: string) {
    return this.svc.getAgreement(id);
  }

  // BL-45
  @Patch('agreements/:id')
  @RequirePermissions(P.AGREEMENTS_MANAGE)
  @ApiOperation({ summary: 'Admin: edit a draft agreement before activation' })
  updateDraft(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: UpdateDraftAgreementDto,
  ) {
    return this.svc.updateDraft(admin.id, id, body);
  }

  // BL-46
  @Post('agreements/:id/clone')
  @RequirePermissions(P.AGREEMENTS_MANAGE)
  @ApiOperation({ summary: 'Admin: copy an agreement into a new draft version for renewal' })
  clone(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.svc.cloneAgreement(admin.id, id);
  }

  // BL-47
  @Get('agreements/:id/versions')
  @RequirePermissions(P.AGREEMENTS_MANAGE)
  @ApiOperation({ summary: 'Admin: version history of an agreement' })
  versions(@Param('id') id: string) {
    return this.svc.versions(id);
  }

  // BL-48
  @Get('agreements/:id/profiles')
  @RequirePermissions(P.AGREEMENTS_MANAGE)
  @ApiOperation({ summary: 'Admin: victim profiles using an agreement' })
  agreementProfiles(@Param('id') id: string, @Query() q: PagingDto) {
    return this.svc.agreementProfiles(id, q);
  }

  // ── Payout destinations ──────────────────────────────────────────────

  // BL-50
  @Get('payout-destinations')
  @RequirePermissions(P.DISBURSEMENTS_CREATE)
  @ApiOperation({ summary: 'Admin: list payout destinations, masked, with the verified flag' })
  listDestinations(@Query() q: PayoutDestinationsQueryDto) {
    return this.svc.listDestinations(q);
  }

  // BL-52
  @Patch('payout-destinations/:id')
  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Admin: edit a payout destination',
    description: 'Clears verification. Refused while a payout to it is approved or processing.',
  })
  updateDestination(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: UpdatePayoutDestinationDto,
  ) {
    return this.svc.updateDestination(admin.id, id, body);
  }

  // BL-53
  @Post('payout-destinations/:id/verify')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Super admin: mark a payout destination verified after a check',
    description: 'The verifier must be a different admin from the last editor.',
  })
  verify(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: Partial<ReasonBodyDto>,
  ) {
    return this.svc.verifyDestination(admin.id, id, body?.reason);
  }

  // BL-54
  @Post('payout-destinations/:id/unverify')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Super admin: clear verification, for example after a fraud report' })
  unverify(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: ReasonBodyDto,
  ) {
    return this.svc.unverifyDestination(admin.id, id, body.reason);
  }

  // BL-55
  @Get('payout-destinations/:id/history')
  @RequirePermissions(P.DISBURSEMENTS_CREATE)
  @ApiOperation({ summary: 'Admin: who changed a destination and when, with masked values' })
  destinationHistory(@Param('id') id: string) {
    return this.svc.destinationHistory(id);
  }
}

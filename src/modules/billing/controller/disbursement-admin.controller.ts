import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RolesEnum } from '../../../common/enums/roles.enum';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { RequireReauthentication } from '../../../common/decorators/reauth.decorator';
import { PermissionsEnum as P } from '../../../common/enums/permissions.enum';

import { DisbursementAdminService } from '../service/disbursement-admin.service';
import { DisbursementService } from '../service/disbursement.service';
import {
  BulkDisbursementIdsDto,
  BulkExecuteDisbursementsDto,
  FailedDisbursementsQueryDto,
  MarkDisbursementPaidDto,
  PagingDto,
  ReasonBodyDto,
} from '../dto/billing-admin.dto';

@ApiTags('Billing admin: disbursements')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/billing')
export class DisbursementAdminController {
  constructor(
    private readonly svc: DisbursementAdminService,
    private readonly disbursements: DisbursementService,
  ) {}

  // BL-64
  @Get('disbursements/pending-approval')
  @RequirePermissions(P.DISBURSEMENTS_APPROVE)
  @ApiOperation({ summary: 'Admin: disbursements waiting for approval, oldest first' })
  pendingApproval(@Query() q: PagingDto) {
    return this.svc.pendingApproval(q);
  }

  // BL-65
  @Get('disbursements/failed')
  @RequirePermissions(P.DISBURSEMENTS_EXECUTE)
  @ApiOperation({ summary: 'Admin: failed disbursements with the failure reason' })
  failed(@Query() q: FailedDisbursementsQueryDto) {
    return this.svc.failed(q);
  }

  // BL-61
  @Post('disbursements/bulk/approve')
  @RequirePermissions(P.DISBURSEMENTS_APPROVE)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Admin: approve many disbursements',
    description:
      'Each item is approved on its own, so the rule that the creator cannot approve applies per item.',
  })
  bulkApprove(@CurrentUser() admin: CurrentUserDto, @Body() body: BulkDisbursementIdsDto) {
    return this.svc.bulkApprove(admin.id, body.ids);
  }

  // BL-62
  @Post('disbursements/bulk/execute')
  @RequirePermissions(P.DISBURSEMENTS_EXECUTE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: execute many approved disbursements, one after another' })
  bulkExecute(@CurrentUser() admin: CurrentUserDto, @Body() body: BulkExecuteDisbursementsDto) {
    return this.svc.bulkExecute(admin.id, body.items);
  }

  // BL-57
  @Post('disbursements/:id/retry')
  @RequirePermissions(P.DISBURSEMENTS_CREATE)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Admin: retry a failed disbursement',
    description: 'Creates a new disbursement for the same allocation. It needs approval again.',
  })
  retry(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.svc.retry(admin.id, id);
  }

  // BL-58
  @Post('disbursements/:id/hold')
  @RequirePermissions(P.DISBURSEMENTS_APPROVE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: hold a disbursement before execution, with a reason' })
  hold(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string, @Body() body: ReasonBodyDto) {
    return this.svc.hold(admin.id, id, body.reason);
  }

  // BL-59
  @Post('disbursements/:id/release')
  @RequirePermissions(P.DISBURSEMENTS_APPROVE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: release a held disbursement' })
  release(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: ReasonBodyDto,
  ) {
    return this.svc.release(admin.id, id, body.reason);
  }

  // BL-60
  @Post('disbursements/:id/mark-paid')
  @RequirePermissions(P.DISBURSEMENTS_EXECUTE)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Admin: record a manual payout for a disbursement stuck in PROCESSING',
    description:
      'Needs a bank slip or transfer reference. A different admin from the executor must confirm.',
  })
  markPaid(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: MarkDisbursementPaidDto,
  ) {
    return this.disbursements.markPaidManually(admin.id, id, body.externalReference, body.reason);
  }

  // BL-63
  @Get('disbursements/:id/timeline')
  @RequirePermissions(P.DISBURSEMENTS_CREATE)
  @ApiOperation({ summary: 'Admin: every step on a disbursement with who and when' })
  timeline(@Param('id') id: string) {
    return this.svc.timeline(id);
  }
}

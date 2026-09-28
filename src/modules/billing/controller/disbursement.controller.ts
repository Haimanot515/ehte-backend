// src/modules/billing/controller/disbursement.controller.ts   (admin: payouts)
//
// Four-eyes: the admin who creates a disbursement cannot approve it.
// Give create / approve / execute to different roles where staffing allows.
//
// Reward-offer and per-informant-claim endpoints moved to reward.controller.ts
// so each controller resolves to exactly one Swagger tag.

import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RolesEnum } from '../../../common/enums/roles.enum';
import { PermissionsEnum as P } from '../../../common/enums/permissions.enum';
import { DisbursementService } from '../service/disbursement.service';
import { CreateDisbursementDto, ExecuteDisbursementDto } from '../dto/disbursement.dto';

@ApiTags('Disbursements')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/billing') // guards are global (AppModule)
export class DisbursementController {
  constructor(private readonly disbursements: DisbursementService) {}

  @RequirePermissions(P.DISBURSEMENTS_EXECUTE)
  @Get('banks')
  @ApiOperation({ summary: 'Admin: list supported payout banks' })
  banks() {
    return this.disbursements.listBanks();
  }

  @RequirePermissions(P.DISBURSEMENTS_CREATE)
  @Post('allocations/:id/disbursements')
  @ApiOperation({ summary: 'Admin: create a disbursement for an allocation (four-eyes: creator cannot approve)' })
  create(
    @CurrentUser() a: CurrentUserDto,
    @Param('id') id: string,
    @Body() dto: CreateDisbursementDto,
  ) {
    return this.disbursements.create(a.id, id, dto.method, dto.rewardClaimId);
  }

  @RequirePermissions(P.DISBURSEMENTS_APPROVE)
  @Post('disbursements/:id/approve')
  @ApiOperation({ summary: 'Admin: approve a pending disbursement (four-eyes: approver cannot be the creator)' })
  approve(@CurrentUser() a: CurrentUserDto, @Param('id') id: string) {
    return this.disbursements.approve(a.id, id);
  }

  @RequirePermissions(P.DISBURSEMENTS_EXECUTE)
  @Post('disbursements/:id/execute')
  @ApiOperation({ summary: 'Admin: execute an approved disbursement (sends the payout)' })
  execute(
    @CurrentUser() a: CurrentUserDto,
    @Param('id') id: string,
    @Body() dto: ExecuteDisbursementDto,
  ) {
    return this.disbursements.execute(a.id, id, dto);
  }
}

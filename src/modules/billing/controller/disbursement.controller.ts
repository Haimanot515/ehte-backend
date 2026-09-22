// src/modules/billing/controller/disbursement.controller.ts   (admin: rewards + payouts)
//
// Four-eyes: the admin who creates a disbursement cannot approve it.
// Give create / approve / execute to different roles where staffing allows.

import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RolesEnum } from '../../../common/enums/roles.enum';
import { PermissionsEnum as P } from '../../../common/enums/permissions.enum';
import { RewardService } from '../service/reward.service';
import { DisbursementService } from '../service/disbursement.service';
import { ApproveClaimDto, ReasonDto } from '../dto/payment.dto';
import { CreateDisbursementDto, ExecuteDisbursementDto } from '../dto/disbursement.dto';

@ApiTags('Billing Admin')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/billing') // guards are global (AppModule)
export class DisbursementController {
  constructor(
    private readonly rewards: RewardService,
    private readonly disbursements: DisbursementService,
  ) {}

  // ── Rewards ───────────────────────────────────────────────────────────────

  @RequirePermissions(P.REWARDS_APPROVE)
  @Post('missing-persons/:missingPersonId/reward/approve')
  approveReward(@CurrentUser() a: CurrentUserDto, @Param('missingPersonId') id: string) {
    return this.rewards.approveOffer(a.id, id);
  }

  @RequirePermissions(P.REWARDS_APPROVE)
  @Post('missing-persons/:missingPersonId/reward/reject')
  rejectReward(
    @CurrentUser() a: CurrentUserDto,
    @Param('missingPersonId') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.rewards.rejectOffer(a.id, id, dto.reason);
  }

  @RequirePermissions(P.REWARDS_VERIFY_CLAIM)
  @Post('missing-persons/:missingPersonId/reward/approve-claim')
  approveClaim(
    @CurrentUser() a: CurrentUserDto,
    @Param('missingPersonId') id: string,
    @Body() dto: ApproveClaimDto,
  ) {
    return this.rewards.approveClaim(a.id, id, dto.submissionId);
  }

  @RequirePermissions(P.REWARDS_APPROVE)
  @Post('missing-persons/:missingPersonId/reward/close')
  closeReward(
    @CurrentUser() a: CurrentUserDto,
    @Param('missingPersonId') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.rewards.closeWithoutPayout(a.id, id, dto.reason);
  }

  // ── Disbursements ─────────────────────────────────────────────────────────

  @RequirePermissions(P.DISBURSEMENTS_EXECUTE)
  @Get('banks')
  banks() {
    return this.disbursements.listBanks();
  }

  @RequirePermissions(P.DISBURSEMENTS_CREATE)
  @Post('allocations/:id/disbursements')
  create(
    @CurrentUser() a: CurrentUserDto,
    @Param('id') id: string,
    @Body() dto: CreateDisbursementDto,
  ) {
    return this.disbursements.create(a.id, id, dto.method);
  }

  @RequirePermissions(P.DISBURSEMENTS_APPROVE)
  @Post('disbursements/:id/approve')
  approve(@CurrentUser() a: CurrentUserDto, @Param('id') id: string) {
    return this.disbursements.approve(a.id, id);
  }

  @RequirePermissions(P.DISBURSEMENTS_EXECUTE)
  @Post('disbursements/:id/execute')
  execute(
    @CurrentUser() a: CurrentUserDto,
    @Param('id') id: string,
    @Body() dto: ExecuteDisbursementDto,
  ) {
    return this.disbursements.execute(a.id, id, dto);
  }
}

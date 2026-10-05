import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RolesEnum } from '../../../common/enums/roles.enum';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { RequireReauthentication } from '../../../common/decorators/reauth.decorator';
import { PermissionsEnum as P } from '../../../common/enums/permissions.enum';

import { RewardAdminService } from '../service/reward-admin.service';
import {
  DecideRewardAppealDto,
  ReasonBodyDto,
  RewardAppealsQueryDto,
  RewardClaimsQueryDto,
  RewardOffersQueryDto,
} from '../dto/billing-admin.dto';

@ApiTags('Billing admin: rewards')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/billing')
export class RewardAdminController {
  constructor(private readonly svc: RewardAdminService) {}

  // ── Offers ───────────────────────────────────────────────────────────

  // BL-73 (declared before rewards list so the literal wins)
  @Get('rewards/pending-approval')
  @RequirePermissions(P.REWARDS_APPROVE)
  @ApiOperation({ summary: 'Admin: reward offers waiting for approval, oldest first' })
  pendingOffers(@Query() q: RewardOffersQueryDto) {
    return this.svc.pendingOffers(q);
  }

  // BL-72
  @Get('rewards')
  @RequirePermissions(P.REWARDS_APPROVE)
  @ApiOperation({ summary: 'Admin: reward offers with status, amount and funding state' })
  listOffers(@Query() q: RewardOffersQueryDto) {
    return this.svc.listOffers(q);
  }

  // ── Claims ───────────────────────────────────────────────────────────

  // BL-70 (declared before reward-claims/:claimId)
  @Get('reward-claims/appeals')
  @RequirePermissions(P.REWARDS_VERIFY_CLAIM)
  @ApiOperation({ summary: 'Admin: informant appeals queue' })
  listAppeals(@Query() q: RewardAppealsQueryDto) {
    return this.svc.listAppeals(q);
  }

  // BL-71
  @Patch('reward-claims/appeals/:appealId')
  @RequirePermissions(P.REWARDS_APPROVE)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Admin: decide an informant appeal, with a reason',
    description: 'UPHOLD reopens the claim for review. It does not approve it.',
  })
  decideAppeal(
    @CurrentUser() admin: CurrentUserDto,
    @Param('appealId') appealId: string,
    @Body() body: DecideRewardAppealDto,
  ) {
    return this.svc.decideAppeal(admin.id, appealId, body);
  }

  // BL-66
  @Get('reward-claims')
  @RequirePermissions(P.REWARDS_VERIFY_CLAIM)
  @ApiOperation({ summary: 'Admin: queue of reward claims, filter by status and case' })
  listClaims(@Query() q: RewardClaimsQueryDto) {
    return this.svc.listClaims(q);
  }

  // BL-67
  @Get('reward-claims/:claimId')
  @RequirePermissions(P.REWARDS_VERIFY_CLAIM)
  @ApiOperation({
    summary: 'Admin: one claim with scores, decision and payout state (no informant identity)',
  })
  getClaim(@Param('claimId') claimId: string) {
    return this.svc.getClaim(claimId);
  }

  // BL-68
  @Get('reward-claims/:claimId/timeline')
  @RequirePermissions(P.REWARDS_VERIFY_CLAIM)
  @ApiOperation({ summary: 'Admin: every step on a claim' })
  timeline(@Param('claimId') claimId: string) {
    return this.svc.timeline(claimId);
  }

  // BL-76
  @Get('reward-claims/:claimId/duplicates')
  @RequirePermissions(P.REWARDS_VERIFY_CLAIM)
  @ApiOperation({ summary: 'Admin: other claims on the same case that look related' })
  duplicates(@Param('claimId') claimId: string) {
    return this.svc.duplicates(claimId);
  }

  // BL-69
  @Post('reward-claims/:claimId/reopen')
  @RequirePermissions(P.REWARDS_APPROVE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: reopen a decided claim after an appeal, with a reason' })
  reopen(
    @CurrentUser() admin: CurrentUserDto,
    @Param('claimId') claimId: string,
    @Body() body: ReasonBodyDto,
  ) {
    return this.svc.reopen(admin.id, claimId, body.reason);
  }

  // BL-75
  @Post('reward-claims/:claimId/reveal-informant')
  @RequirePermissions(P.INFORMANT_IDENTITY_READ)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Admin: show the informant identity once, with a reason',
    description:
      'The only route that returns the informant. Every call is written to the audit log.',
  })
  reveal(
    @CurrentUser() admin: CurrentUserDto,
    @Param('claimId') claimId: string,
    @Body() body: ReasonBodyDto,
  ) {
    return this.svc.revealInformant(admin.id, claimId, body.reason);
  }
}

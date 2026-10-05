import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RolesEnum } from '../../../common/enums/roles.enum';
import { PermissionsEnum as P } from '../../../common/enums/permissions.enum';
import { RewardService } from '../service/reward.service';
import { ReasonDto } from '../dto/payment.dto';
import {
  CreateClaimFromSubmissionDto,
  DecideClaimDto,
  ScoreClaimDto,
  SetEvaluationWeightsDto,
  SetFundingMethodDto,
  SplitRewardDto,
} from '../dto/reward-claim.dto';

@ApiTags('Rewards')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/billing') // guards are global (AppModule)
export class RewardController {
  constructor(private readonly rewards: RewardService) {}

  // ── Offer ─────────────────────────────────────────────────────────────

  @RequirePermissions(P.REWARDS_APPROVE)
  @Post('missing-persons/:missingPersonId/reward/approve')
  @ApiOperation({ summary: 'Admin: approve a reward offer for a missing-person case' })
  approveReward(@CurrentUser() a: CurrentUserDto, @Param('missingPersonId') id: string) {
    return this.rewards.approveOffer(a.id, id);
  }

  @RequirePermissions(P.REWARDS_APPROVE)
  @Post('missing-persons/:missingPersonId/reward/reject')
  @ApiOperation({ summary: 'Admin: reject a reward offer for a missing-person case' })
  rejectReward(
    @CurrentUser() a: CurrentUserDto,
    @Param('missingPersonId') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.rewards.rejectOffer(a.id, id, dto.reason);
  }

  @RequirePermissions(P.REWARDS_APPROVE)
  @Post('missing-persons/:missingPersonId/reward/funding-method')
  @ApiOperation({ summary: 'Admin: set how an approved reward will be funded' })
  setFundingMethod(
    @CurrentUser() a: CurrentUserDto,
    @Param('missingPersonId') id: string,
    @Body() dto: SetFundingMethodDto,
  ) {
    return this.rewards.setFundingMethod(a.id, id, dto);
  }

  @RequirePermissions(P.REWARDS_APPROVE)
  @Post('missing-persons/:missingPersonId/reward/evaluation-weights')
  @ApiOperation({ summary: 'Admin: set the scoring weights used to evaluate informant claims' })
  setEvaluationWeights(
    @CurrentUser() a: CurrentUserDto,
    @Param('missingPersonId') id: string,
    @Body() dto: SetEvaluationWeightsDto,
  ) {
    return this.rewards.setEvaluationWeights(a.id, id, dto);
  }

  @RequirePermissions(P.REWARDS_APPROVE)
  @Post('missing-persons/:missingPersonId/reward/close')
  @ApiOperation({ summary: 'Admin: close a reward offer without a payout' })
  closeReward(
    @CurrentUser() a: CurrentUserDto,
    @Param('missingPersonId') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.rewards.closeWithoutPayout(a.id, id, dto.reason);
  }

  // ── Per-informant claims ──────────────────────────────────────────────

  @RequirePermissions(P.REWARDS_VERIFY_CLAIM)
  @Post('missing-persons/:missingPersonId/reward/claims')
  @ApiOperation({ summary: 'Admin: create a reward claim from an information submission' })
  createClaim(
    @CurrentUser() a: CurrentUserDto,
    @Param('missingPersonId') id: string,
    @Body() dto: CreateClaimFromSubmissionDto,
  ) {
    return this.rewards.createClaimFromSubmission(a.id, id, dto.informationSubmissionId);
  }

  @RequirePermissions(P.REWARDS_VERIFY_CLAIM)
  @Post('reward-claims/:claimId/score')
  @ApiOperation({ summary: 'Admin: score a reward claim against the evaluation weights' })
  scoreClaim(
    @CurrentUser() a: CurrentUserDto,
    @Param('claimId') claimId: string,
    @Body() dto: ScoreClaimDto,
  ) {
    return this.rewards.scoreClaim(a.id, claimId, dto);
  }

  @RequirePermissions(P.REWARDS_VERIFY_CLAIM)
  @Post('reward-claims/:claimId/decide')
  @ApiOperation({ summary: 'Admin: approve or deny a scored reward claim' })
  decideClaim(
    @CurrentUser() a: CurrentUserDto,
    @Param('claimId') claimId: string,
    @Body() dto: DecideClaimDto,
  ) {
    return this.rewards.decideClaim(a.id, claimId, dto);
  }

  @RequirePermissions(P.REWARDS_APPROVE)
  @Post('missing-persons/:missingPersonId/reward/split')
  @ApiOperation({ summary: 'Admin: split an approved reward across multiple informant claims' })
  splitReward(
    @CurrentUser() a: CurrentUserDto,
    @Param('missingPersonId') id: string,
    @Body() dto: SplitRewardDto,
  ) {
    return this.rewards.splitReward(a.id, id, dto);
  }
}

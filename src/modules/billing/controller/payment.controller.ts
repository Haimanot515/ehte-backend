// src/modules/billing/controller/payment.controller.ts
//
// User-facing. Adjust the three project-specific imports to your real exports:
//   CurrentUser / CurrentUserDto / Reauth

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequireReauthentication } from '../../../common/decorators/reauth.decorator';
import { Throttle } from '@nestjs/throttler';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';
import { PaymentService, Payer } from '../service/payment.service';
import { AllocationPreviewQueryDto } from '../dto/payment.dto';

// The ONLY place that maps your user object to a payer. Names are never sent to Chapa.
const toPayer = (u: CurrentUserDto): Payer => ({
  id: u.id,
  email: (u as { email?: string | null }).email ?? null,
});

@ApiTags('Billing')
@ApiBearerAuth('access-token')
@Controller('billing') // JWT, Reauth, Roles, Permissions guards are global (AppModule)
export class PaymentController {
  constructor(
    private readonly payments: PaymentService,
  ) {}

  // ── Support a victim/survivor ─────────────────────────────────────────────

  @Get('support/:profileId/preview')
  preview(@Param('profileId') profileId: string, @Query() q: AllocationPreviewQueryDto) {
    return this.payments.previewSupport(profileId, q.amount);
  }

  // Step 1 is the existing POST /support (creates a PENDING Support with a server-computed split).
  // Step 2: pay for it with Chapa.
  @Post('support/:supportId/checkout')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  checkout(@CurrentUser() user: CurrentUserDto, @Param('supportId') supportId: string) {
    return this.payments.initiateSupportCheckout(toPayer(user), supportId);
  }

  // ── Missing-person reward (requester) ─────────────────────────────────────
  // Password re-authentication: touches sensitive Missing Person information.

  // NOTE: reward proposal (rewardOffered/rewardAmount/rewardDetails) is set when a user
  // creates or updates a MissingPerson request, via MissingPersonController — not here.
  @RequireReauthentication()
  @Post('missing-persons/:missingPersonId/fund-reward')
  fund(@CurrentUser() user: CurrentUserDto, @Param('missingPersonId') missingPersonId: string) {
    return this.payments.initiateRewardFunding(toPayer(user), missingPersonId);
  }

  // ── Status: the app polls this after Chapa redirects back ─────────────────

  @Get('payments/:txRef')
  status(@CurrentUser() user: CurrentUserDto, @Param('txRef') txRef: string) {
    return this.payments.getStatus(txRef, user.id);
  }
}

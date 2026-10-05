// src/modules/billing/controller/payer-billing.controller.ts
//
// New user-facing billing routes (BL-01 to BL-09, BL-13 to BL-15).
// Registered BEFORE PaymentController and FundingController in BillingModule so
// literal paths like `payments/mine/summary` and `rewards/mine/summary` win over
// `payments/mine/:id` and `rewards/mine/:claimId`.
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';
import { RequireReauthentication } from '../../../common/decorators/reauth.decorator';

import { PayerBillingService } from '../service/payer-billing.service';
import {
  AnnualStatementQueryDto,
  CreateRewardAppealDto,
  OpenPaymentDisputeDto,
} from '../dto/billing-admin.dto';

@ApiTags('Payments (me)')
@ApiBearerAuth('access-token')
@Controller()
export class PayerBillingController {
  constructor(private readonly payer: PayerBillingService) {}

  // ── Literal paths first ──────────────────────────────────────────────

  // BL-04
  @Get('payments/mine/summary')
  @ApiOperation({ summary: 'My payment totals by type and status' })
  summary(@CurrentUser() user: CurrentUserDto) {
    return this.payer.summary(user.id);
  }

  // BL-05
  @Get('payments/mine/stats')
  @ApiOperation({ summary: 'What I have given in total and to how many profiles' })
  stats(@CurrentUser() user: CurrentUserDto) {
    return this.payer.stats(user.id);
  }

  // BL-08
  @Get('payments/mine/annual-statement')
  @ApiOperation({ summary: 'Yearly statement of what I gave, for my records' })
  annualStatement(@CurrentUser() user: CurrentUserDto, @Query() query: AnnualStatementQueryDto) {
    return this.payer.annualStatement(user.id, query.year);
  }

  // BL-15
  @Get('rewards/mine/summary')
  @ApiOperation({ summary: 'My reward claims by status and total paid' })
  claimsSummary(@CurrentUser() user: CurrentUserDto) {
    return this.payer.myClaimsSummary(user.id);
  }

  // ── Payment actions ──────────────────────────────────────────────────

  // BL-02
  @Post('payments/:txRef/retry')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Start a new checkout for one of my failed or expired payments',
    description: 'Creates a new payment through the normal checkout flow. The old payment is left as it is.',
  })
  retry(@CurrentUser() user: CurrentUserDto, @Param('txRef') txRef: string) {
    return this.payer.retry(user, txRef);
  }

  // BL-01
  @Get('payments/:id/receipt')
  @ApiOperation({ summary: 'Receipt for one of my paid payments' })
  receipt(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.payer.receipt(user.id, id);
  }

  // BL-07
  @Get('payments/:id/refund-status')
  @ApiOperation({ summary: 'Refund status for one of my payments' })
  refundStatus(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.payer.refundStatus(user.id, id);
  }

  // BL-06
  @Post('payments/:id/dispute')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Report a charge I do not recognise, or a double charge' })
  dispute(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: OpenPaymentDisputeDto,
  ) {
    return this.payer.openDispute(user.id, id, body);
  }

  // ── Informant rewards ────────────────────────────────────────────────

  // BL-09
  @Get('rewards/mine/:claimId')
  @ApiOperation({ summary: 'One of my reward claims, with status and decision reason' })
  myClaim(@CurrentUser() user: CurrentUserDto, @Param('claimId') claimId: string) {
    return this.payer.myClaim(user.id, claimId);
  }

  // BL-14
  @Get('rewards/mine/:claimId/timeline')
  @ApiOperation({ summary: 'History of one of my reward claims' })
  myClaimTimeline(@CurrentUser() user: CurrentUserDto, @Param('claimId') claimId: string) {
    return this.payer.myClaimTimeline(user.id, claimId);
  }

  // BL-13
  @Post('rewards/mine/:claimId/appeal')
  @RequireReauthentication()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Appeal an INVALID or INELIGIBLE decision on my claim' })
  appeal(
    @CurrentUser() user: CurrentUserDto,
    @Param('claimId') claimId: string,
    @Body() body: CreateRewardAppealDto,
  ) {
    return this.payer.appeal(user.id, claimId, body);
  }
}

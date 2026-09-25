// src/modules/billing/controller/funding.controller.ts
//
// Section 3's public/donor/case-owner/finder funding endpoints, plus the
// admin per-entity funding breakdowns (which naturally share
// FundingQueryService with the public/donor views of the same profile or
// case). Billing-wide admin reports (payments list, allocations queue,
// disbursements list, liabilities) live in billing-report.controller.ts
// instead, so this controller stays scoped to "funding for one thing".
//
// Route order: literal/public routes are declared before ':id' routes
// within each group, same convention as AuditLogController.

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import { FundingQueryService } from '../service/funding-query.service';
import { FundingPagingDto } from '../dto/funding.dto';

@ApiTags('Funding')
@Controller()
export class FundingController {
  constructor(private readonly funding: FundingQueryService) {}

  // ── PUBLIC ────────────────────────────────────────────────────────────

  @Get('billing/public/victim-profiles/:id/funding')
  @AllowAnonymous()
  @ApiOperation({ summary: 'Public: raised amount, goal and progress for a published profile' })
  getPublicProfileFunding(@Param('id') id: string) {
    return this.funding.getPublicProfileFunding(id);
  }

  @Get('billing/public/missing-persons/:id/reward')
  @AllowAnonymous()
  @ApiOperation({ summary: 'Public: coarse reward status for a missing-person case' })
  getPublicRewardFunding(@Param('id') id: string) {
    return this.funding.getPublicRewardFunding(id);
  }

  // ── DONOR ────────────────────────────────────────────────────────────

  @Get('payments/mine')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'My payment history' })
  getMyPayments(@CurrentUser() user: CurrentUserDto, @Query() query: FundingPagingDto) {
    return this.funding.getMyPayments(user.id, query.page, query.limit);
  }

  @Get('payments/mine/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'My receipt for one payment, with its allocation snapshot' })
  getMyPaymentById(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.funding.getMyPaymentById(user.id, id);
  }

  // ── CASE OWNER ───────────────────────────────────────────────────────

  @Get('missing-persons/mine/:id/reward')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Case owner: reward funding, claim and refund state for my case' })
  getMyRewardFunding(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.funding.getMyRewardFunding(user.id, id);
  }

  // ── FINDER ───────────────────────────────────────────────────────────

  @Get('rewards/mine')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Finder: my approved reward claims and their payout status' })
  getMyRewardClaims(@CurrentUser() user: CurrentUserDto) {
    return this.funding.getMyRewardClaims(user.id);
  }

  // ── ADMIN: per-entity funding views ─────────────────────────────────

  @Get('admin/billing/victim-profiles/:id/funding')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiOperation({
    summary: 'Admin: gross, fees, per-party split, pending/in-flight/paid-out for a profile',
  })
  getProfileFundingBreakdown(@Param('id') id: string) {
    return this.funding.getProfileFundingBreakdown(id);
  }

  @Get('admin/billing/victim-profiles/:id/payments')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: paginated payments for a profile' })
  getProfilePayments(@Param('id') id: string, @Query() query: FundingPagingDto) {
    return this.funding.getProfilePayments(id, query.page, query.limit);
  }

  @Get('admin/billing/missing-persons/:id/reward')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiOperation({
    summary: 'Admin: reward offer, payments, claim, submission, disbursement and refund state',
  })
  getRewardAdminView(@Param('id') id: string) {
    return this.funding.getRewardAdminView(id);
  }
}
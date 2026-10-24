import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';

import { PaymentsAdminService } from '../service/payments-admin.service';
import { PayoutService } from '../service/payout.service';
import {
  DisbursementListQueryDto,
  PauseReasonDto,
  PaymentListQueryDto,
  ResolveReviewDto,
  TotalsQueryDto,
} from '../dto/payments.dto';

/**
 * ADMIN SIDE (Option 2: Transfer). No admin approves a single transfer; admins watch, pause and fix.
 *
 * PaymentsAdminService expects:
 *   listPayments(query) / getPayment(id) / listDisbursements(query) / getDisbursement(id)
 *   getTotals(victimProfileId?) -> { raised, sent, onTheWay, waiting, fees }
 *       raised   = sum of PAID payments
 *       sent     = sum of Disbursement PAID
 *       onTheWay = sum of Disbursement CREATED + SUBMITTED + UNKNOWN
 *       waiting  = raised - sent - onTheWay   (never below 0)
 *   pausePayouts(admin, victimProfileId, reason) / resumePayouts(admin, victimProfileId)
 *       set VictimProfile.payoutsPaused; audited. Pausing never touches donationsPaused.
 *   resolveReview(admin, paymentId, decision, reason)
 *       for Payment.status = REVIEW_REQUIRED only (e.g. amount mismatch).
 *
 * PayoutService expects (the same code the timer job calls):
 *   runForVictim(victimProfileId, actor?) -> { disbursementId | null, reason? }
 *       Locks the VictimProfile row, refuses if payoutsPaused, no verified PayoutDestination,
 *       any Disbursement still CREATED/SUBMITTED/UNKNOWN, or nothing unsent. Records the Disbursement
 *       (with destinationSnapshot) BEFORE calling Chapa, then marks SUBMITTED.
 *   checkDisbursement(id, actor?)  -> Disbursement
 *       Asks Chapa for the status of an UNKNOWN/SUBMITTED transfer. Updates it to PAID or FAILED
 *       only when Chapa says so. NEVER resends.
 *
 * Literal routes sit above ':id' routes so "totals" is not read as an id.
 */
@ApiTags('Admin payments')
@Controller('admin')
export class AdminPaymentsController {
  constructor(
    private readonly admin: PaymentsAdminService,
    private readonly payouts: PayoutService,
  ) {}

  // ── Totals ──

  @Get('payments/totals')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: totals (raised, sent, on the way, waiting) for one victim or for everyone',
  })
  async totals(@Query() query: TotalsQueryDto) {
    return this.admin.getTotals(query.victimProfileId);
  }

  // ── Payments ──

  @Get('payments')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: list all payments' })
  async listPayments(@Query() query: PaymentListQueryDto) {
    return this.admin.listPayments(query);
  }

  @Get('payments/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: one payment' })
  async getPayment(@Param('id') id: string) {
    return this.admin.getPayment(id);
  }

  @Patch('payments/:id/resolve-review')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.PAYMENT_REFUND)
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: accept or refund a payment that needs review' })
  async resolveReview(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: ResolveReviewDto,
  ) {
    return this.admin.resolveReview(user, id, data.decision, data.reason);
  }

  // ── Transfers (disbursements) ──

  @Get('disbursements')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: list all transfers to victims' })
  async listDisbursements(@Query() query: DisbursementListQueryDto) {
    return this.admin.listDisbursements(query);
  }

  @Get('disbursements/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: one transfer (account number masked)' })
  async getDisbursement(@Param('id') id: string) {
    return this.admin.getDisbursement(id);
  }

  // Safe to press repeatedly: it only asks Chapa for the status and never sends money again.
  @Post('disbursements/:id/check')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: re-check an unclear transfer with Chapa (never resends)' })
  async checkDisbursement(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.payouts.checkDisbursement(id, user);
  }

  // ── Pause / resume transfers for one victim ──

  @Patch('payouts/:victimProfileId/pause')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: pause transfers to a victim (donations stay open)' })
  async pausePayouts(
    @CurrentUser() user: CurrentUserDto,
    @Param('victimProfileId') victimProfileId: string,
    @Body() data: PauseReasonDto,
  ) {
    return this.admin.pausePayouts(user, victimProfileId, data.reason);
  }

  @Patch('payouts/:victimProfileId/resume')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: resume transfers to a victim' })
  async resumePayouts(
    @CurrentUser() user: CurrentUserDto,
    @Param('victimProfileId') victimProfileId: string,
  ) {
    return this.admin.resumePayouts(user, victimProfileId);
  }

  // Same code as the timer job, so it cannot double-send: the job and this route share one lock.
  @Post('payouts/:victimProfileId/run')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @RequireReauthentication()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin: send a victim\'s confirmed, unsent balance now' })
  async runPayout(
    @CurrentUser() user: CurrentUserDto,
    @Param('victimProfileId') victimProfileId: string,
  ) {
    return this.payouts.runForVictim(victimProfileId, user);
  }
}
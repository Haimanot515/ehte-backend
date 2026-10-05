// src/modules/billing/controller/billing-report-admin.controller.ts
//
// Ledger, daily close, liabilities, CSV exports and statistics
// (BL-77 to BL-82, BL-85 to BL-92). Read-only.
import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RolesEnum } from '../../../common/enums/roles.enum';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { RequireReauthentication } from '../../../common/decorators/reauth.decorator';
import { PermissionsEnum as P } from '../../../common/enums/permissions.enum';

import { BillingReportAdminService } from '../service/billing-report-admin.service';
import {
  BillingExportQueryDto,
  BillingStatsQueryDto,
  DailyCloseQueryDto,
  DateRangeDto,
  LedgerQueryDto,
  LiabilitiesQueryDto,
} from '../dto/billing-admin.dto';

@ApiTags('Billing admin: reports and statistics')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/billing')
export class BillingReportAdminController {
  constructor(private readonly svc: BillingReportAdminService) {}

  // BL-77
  @Get('summary')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: totals by period and type: collected, allocated, refunded, paid out' })
  summary(@Query() q: DateRangeDto) {
    return this.svc.summary(q);
  }

  // BL-78
  @Get('ledger')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Super admin: every money movement, filtered by date, kind and type' })
  ledger(@Query() q: LedgerQueryDto) {
    return this.svc.ledger(q);
  }

  // BL-79
  @Get('daily-close')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: end-of-day totals to compare with the gateway statement' })
  dailyClose(@Query() q: DailyCloseQueryDto) {
    return this.svc.dailyClose(q);
  }

  // BL-80
  @Get('liabilities/by-party')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Super admin: money still owed to each institution, profile and informant' })
  liabilitiesByParty(@Query() q: LiabilitiesQueryDto) {
    return this.svc.liabilitiesByParty(q);
  }

  // ── Exports ──────────────────────────────────────────────────────────

  // BL-81
  @Get('export/payments')
  @RequirePermissions(P.BILLING_EXPORT)
  @RequireReauthentication()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Admin: CSV of payments, row-capped and audited. Payer identity is left out.' })
  async exportPayments(
    @CurrentUser() admin: CurrentUserDto,
    @Query() q: BillingExportQueryDto,
    @Res() res: Response,
  ) {
    const { csv, rowCount, truncated } = await this.svc.exportPayments(admin.id, q);
    this.sendCsv(res, 'payments', csv, rowCount, truncated);
  }

  // BL-82
  @Get('export/disbursements')
  @RequirePermissions(P.BILLING_EXPORT)
  @RequireReauthentication()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Admin: CSV of disbursements, row-capped and audited. Account numbers are left out.' })
  async exportDisbursements(
    @CurrentUser() admin: CurrentUserDto,
    @Query() q: BillingExportQueryDto,
    @Res() res: Response,
  ) {
    const { csv, rowCount, truncated } = await this.svc.exportDisbursements(admin.id, q);
    this.sendCsv(res, 'disbursements', csv, rowCount, truncated);
  }

  private sendCsv(res: Response, name: string, csv: string, rowCount: number, truncated: boolean) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${Date.now()}.csv"`);
    res.setHeader('X-Row-Count', String(rowCount));
    res.setHeader('X-Truncated', String(truncated));
    res.setHeader('Access-Control-Expose-Headers', 'X-Row-Count, X-Truncated');
    res.send(csv);
  }

  // ── Statistics ───────────────────────────────────────────────────────

  // BL-92
  @Get('stats/overview')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: billing dashboard in one call' })
  overview() {
    return this.svc.overview();
  }

  // BL-85
  @Get('stats/timeline')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: money collected per day, week or month' })
  timeline(@Query() q: BillingStatsQueryDto) {
    return this.svc.timeline(q);
  }

  // BL-86
  @Get('stats/by-type')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: support, reward and posting fees' })
  byType(@Query() q: BillingStatsQueryDto) {
    return this.svc.byType(q);
  }

  // BL-87
  @Get('stats/fees')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: gateway fees and platform share over time' })
  fees(@Query() q: BillingStatsQueryDto) {
    return this.svc.fees(q);
  }

  // BL-88
  @Get('stats/failure-rate')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: failed and expired payments by type' })
  failureRate(@Query() q: BillingStatsQueryDto) {
    return this.svc.failureRate(q);
  }

  // BL-89
  @Get('stats/refunds')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: refunds over time and by type' })
  refunds(@Query() q: BillingStatsQueryDto) {
    return this.svc.refunds(q);
  }

  // BL-90
  @Get('stats/disbursement-time')
  @RequirePermissions(P.DISBURSEMENTS_CREATE)
  @ApiOperation({ summary: 'Admin: hours from payment to payout (average, median, p90, max)' })
  disbursementTime(@Query() q: BillingStatsQueryDto) {
    return this.svc.disbursementTime(q);
  }

  // BL-91
  @Get('stats/rewards')
  @RequirePermissions(P.REWARDS_APPROVE)
  @ApiOperation({ summary: 'Admin: reward offers, claims and money paid to informants' })
  rewards(@Query() q: BillingStatsQueryDto) {
    return this.svc.rewards(q);
  }
}

// src/modules/billing/controller/billing-report.controller.ts
//
// Section 3's billing-wide admin reports: the payout queue (G23), the
// payments list/detail and REVIEW_REQUIRED resolution (G9), the
// disbursements list/detail, and the liabilities report (G27).
//
// Cancel/refund for disbursements and rewards stay on
// disbursement.controller.ts (it already injects DisbursementService and
// RewardService) rather than being duplicated here.

import { Controller, Get, Param, Post, Body, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import { FundingQueryService } from '../service/funding-query.service';
import { PaymentService } from '../service/payment.service';
import {
  GetAllocationsDto,
  GetDisbursementsDto,
  GetPaymentsDto,
  ResolveReviewDto,
} from '../dto/billing-report.dto';

@ApiTags('Billing Admin — Reports')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/billing')
export class BillingReportController {
  constructor(
    private readonly funding: FundingQueryService,
    private readonly payments: PaymentService,
  ) {}

  // ── Payments ─────────────────────────────────────────────────────────

  @Get('payments')
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: list payments, filterable by status, type, date, party' })
  listPayments(@Query() query: GetPaymentsDto) {
    const where: Prisma.PaymentWhereInput = {
      status: query.status,
      type: query.type,
      victimProfileId: query.victimProfileId,
      missingPersonId: query.missingPersonId,
      payerUserId: query.payerUserId,
      createdAt:
        query.startDate || query.endDate
          ? { gte: query.startDate ? new Date(query.startDate) : undefined, lte: query.endDate ? new Date(query.endDate) : undefined }
          : undefined,
    };
    return this.funding.listPayments(where, query.page, query.limit);
  }

  @Get('payments/:id')
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: full detail for one payment, with allocations and disbursements' })
  getPayment(@Param('id') id: string) {
    return this.funding.getPaymentById(id);
  }

  @Post('payments/:id/resolve-review')
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @ApiOperation({ summary: 'Admin: resolve a REVIEW_REQUIRED payment (fixes G9)' })
  resolveReview(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() dto: ResolveReviewDto,
  ) {
    return this.payments.resolveReview(admin.id, id, dto);
  }

  // ── Allocations (payout queue, G23) ─────────────────────────────────

  @Get('allocations')
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: payout queue — allocations filtered by settlement status' })
  listAllocations(@Query() query: GetAllocationsDto) {
    const where: Prisma.PaymentAllocationWhereInput = {
      settlementStatus: query.settlementStatus,
      partyType: query.partyType,
      disbursements: query.undisbursedOnly ? { none: {} } : undefined,
    };
    return this.funding.listAllocations(where, query.page, query.limit);
  }

  // ── Disbursements ────────────────────────────────────────────────────

  @Get('disbursements')
  @RequirePermissions(PermissionsEnum.DISBURSEMENTS_CREATE)
  @ApiOperation({ summary: 'Admin: list disbursements, filterable by status' })
  listDisbursements(@Query() query: GetDisbursementsDto) {
    const where: Prisma.DisbursementWhereInput = {
      status: query.status,
      allocationId: query.allocationId,
    };
    return this.funding.listDisbursements(where, query.page, query.limit);
  }

  @Get('disbursements/:id')
  @RequirePermissions(PermissionsEnum.DISBURSEMENTS_CREATE)
  @ApiOperation({ summary: 'Admin: detail for one disbursement, with its allocation and payment' })
  getDisbursement(@Param('id') id: string) {
    return this.funding.getDisbursementById(id);
  }

  // ── Liabilities (G27) ────────────────────────────────────────────────

  @Get('liabilities')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Super admin: unpaid allocations vs Chapa balance' })
  getLiabilities() {
    return this.funding.getLiabilities();
  }
}
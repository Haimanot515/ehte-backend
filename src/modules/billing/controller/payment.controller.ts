import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PaymentService } from '../service/payment.service';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

// DRAFT: this controller was not provided, so it is written to match
// SupportController's conventions. Verify base path, route names, and
// param routes against the real file before merging.

@ApiTags('Payments')
@ApiBearerAuth('access-token')
@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  // Declared before ':txRef' routes so "stats" is never matched as a param.
  @Get('stats')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get payment statistics for the dashboard' })
  async getStats() {
    return this.paymentService.getStats();
  }

  @Get('support/:supportId/preview')
  @ApiOperation({ summary: 'Preview the allocation split for a support amount' })
  async previewSupport(
    @Param('supportId') supportId: string,
    @Query('amount') amount: string,
  ) {
    return this.paymentService.previewSupport(supportId, amount);
  }

  @Post('support/:supportId/checkout')
  @ApiOperation({ summary: 'Start a Chapa checkout for an existing support pledge' })
  async initiateSupportCheckout(
    @CurrentUser() user: CurrentUserDto,
    @Param('supportId') supportId: string,
  ) {
    return this.paymentService.initiateSupportCheckout(user, supportId);
  }

  @Post('missing-person/:missingPersonId/reward-checkout')
  @ApiOperation({ summary: 'Start a Chapa checkout to fund an approved reward' })
  async initiateRewardFunding(
    @CurrentUser() user: CurrentUserDto,
    @Param('missingPersonId') missingPersonId: string,
  ) {
    return this.paymentService.initiateRewardFunding(user, missingPersonId);
  }

  @Get(':txRef/status')
  @ApiOperation({ summary: 'Get the status of a payment by tx_ref (payer only)' })
  async getStatus(@Param('txRef') txRef: string, @CurrentUser() user: CurrentUserDto) {
    return this.paymentService.getStatus(txRef, user.id);
  }
}
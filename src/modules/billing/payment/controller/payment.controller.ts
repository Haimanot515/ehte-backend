import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PaymentService } from '../service/payment.service';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { MyPaymentsQueryDto, SupportCheckoutDto } from '../dto/payment.dto';

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

  @Get('mine')
  @ApiOperation({ summary: 'List my payments, including pending, failed and expired ones' })
  async listMine(@CurrentUser() user: CurrentUserDto, @Query() query: MyPaymentsQueryDto) {
    return this.paymentService.listMine(user.id, query);
  }

  @Get('support/:victimProfileId/preview')
  @ApiOperation({ summary: 'Preview the allocation split for a support amount on a victim profile' })
  async previewSupport(
    @Param('victimProfileId') victimProfileId: string,
    @Query('amount') amount: string,
  ) {
    return this.paymentService.previewSupport(victimProfileId, amount);
  }

  @Post('victim-profile/:victimProfileId/support-checkout')
  @ApiOperation({
    summary: 'Start a Chapa checkout to financially support a victim profile',
    description:
      'Send the amount and the anonymous choice. The server checks the profile, works out the split ' +
      'and creates a PENDING payment. No Support exists until Chapa confirms the money.',
  })
  async initiateSupportCheckout(
    @CurrentUser() user: CurrentUserDto,
    @Param('victimProfileId') victimProfileId: string,
    @Body() body: SupportCheckoutDto,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-preview-hash') previewHash?: string,
  ) {
    return this.paymentService.initiateSupportCheckout(
      user,
      victimProfileId,
      body.amount,
      body.anonymous ?? true,
      idempotencyKey,
      previewHash,
    );
  }

  @Post('missing-person/:missingPersonId/reward-checkout')
  @ApiOperation({ summary: 'Start a Chapa checkout to fund an approved reward' })
  async initiateRewardFunding(
    @CurrentUser() user: CurrentUserDto,
    @Param('missingPersonId') missingPersonId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-preview-hash') previewHash?: string,
  ) {
    return this.paymentService.initiateRewardFunding(
      user,
      missingPersonId,
      idempotencyKey,
      previewHash,
    );
  }

  @Post('victim-profile/:victimProfileId/posting-fee-checkout')
  @ApiOperation({ summary: 'Start a Chapa checkout for a Victim Profile posting fee' })
  async initiateVictimProfilePostingFeeCheckout(
    @CurrentUser() user: CurrentUserDto,
    @Param('victimProfileId') victimProfileId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-preview-hash') previewHash?: string,
  ) {
    return this.paymentService.initiatePostingFeeCheckout(
      user,
      'VICTIM_PROFILE',
      victimProfileId,
      idempotencyKey,
      previewHash,
    );
  }

  @Post('missing-person/:missingPersonId/posting-fee-checkout')
  @ApiOperation({ summary: 'Start a Chapa checkout for a Missing Person posting/promotion fee' })
  async initiateMissingPersonPostingFeeCheckout(
    @CurrentUser() user: CurrentUserDto,
    @Param('missingPersonId') missingPersonId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-preview-hash') previewHash?: string,
  ) {
    return this.paymentService.initiatePostingFeeCheckout(
      user,
      'MISSING_PERSON',
      missingPersonId,
      idempotencyKey,
      previewHash,
    );
  }

  @Get(':txRef/status')
  @ApiOperation({ summary: 'Get the status of a payment by tx_ref (payer only)' })
  async getStatus(@Param('txRef') txRef: string, @CurrentUser() user: CurrentUserDto) {
    return this.paymentService.getStatus(txRef, user.id);
  }
}
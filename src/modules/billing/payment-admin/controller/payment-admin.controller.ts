import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { CurrentUserDto } from '../../../../common/dtos/current-user.dto';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { RolesEnum } from '../../../../common/enums/roles.enum';
import { RequirePermissions } from '../../../../common/decorators/require-permissions.decorator';
import { RequireReauthentication } from '../../../../common/decorators/reauth.decorator';
import { PermissionsEnum as P } from '../../../../common/enums/permissions.enum';

import { PaymentAdminService } from '../service/payment-admin.service';
import { BulkExecuteRefundsDto, ExecuteRefundDto, PaymentDisputesQueryDto, PaymentSearchQueryDto, RefundListQueryDto, RequestRefundDto, ResolvePaymentDisputeDto, ReviewQueueQueryDto, WebhookEventsQueryDto } from '../dto/payment-admin.dto';
import { PagingDto, ReasonBodyDto } from 'src/modules/billing/shared/dto/billing-common.dto';

@ApiTags('Billing admin: payments and refunds')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/billing')
export class PaymentAdminController {
  constructor(private readonly svc: PaymentAdminService) {}

  @Get('webhook-events')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: log of received gateway webhooks with result' })
  listWebhookEvents(@Query() q: WebhookEventsQueryDto) {
    return this.svc.listWebhookEvents(q);
  }

  @Get('webhook-events/:id')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: one webhook event with its payload and result' })
  getWebhookEvent(@Param('id') id: string) {
    return this.svc.getWebhookEvent(id);
  }

  @Post('webhook-events/:id/replay')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.SUPPORT_PAYMENT_MANAGE)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Super admin: replay a stored webhook',
    description:
      'Asks the gateway for the current state of the payment. The stored payload is never trusted as an instruction.',
  })
  replay(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.svc.replayWebhookEvent(admin.id, id);
  }

  @Get('payments/by-payer')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: one row per payer with count, total, failed and refunded' })
  byPayer(@CurrentUser() admin: CurrentUserDto, @Query() q: PagingDto) {
    return this.svc.byPayer(admin, q);
  }

  @Get('payments/by-payer/:userId')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: "Admin: one payer's payments" })
  payerPayments(@Param('userId') userId: string, @Query() q: PagingDto) {
    return this.svc.payerPayments(userId, q);
  }

  @Get('payments/by-profile/:profileId')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: payments to one victim profile, with fees and allocations' })
  profilePayments(@Param('profileId') profileId: string, @Query() q: PagingDto) {
    return this.svc.profilePayments(profileId, q);
  }

  @Get('payments/review-queue')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: payments waiting for manual review, oldest first' })
  reviewQueue(@Query() q: ReviewQueueQueryDto) {
    return this.svc.reviewQueue(q);
  }

  @Get('payments/excess-queue')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: approved payments where the payer paid more than was due' })
  excessQueue(@Query() q: PagingDto) {
    return this.svc.listExcess(q);
  }

  @Get('payments/search')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: search payments by reference, tx ref, payer or profile' })
  search(@Query() q: PaymentSearchQueryDto) {
    return this.svc.search(q);
  }

  @Get('payments/disputes')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: queue of payer disputes' })
  listDisputes(@Query() q: PaymentDisputesQueryDto) {
    return this.svc.listDisputes(q);
  }

  @Patch('payments/disputes/:disputeId')
  @RequirePermissions(P.SUPPORT_PAYMENT_MANAGE)
  @ApiOperation({ summary: 'Admin: resolve a payer dispute with a reason' })
  resolveDispute(
    @CurrentUser() admin: CurrentUserDto,
    @Param('disputeId') disputeId: string,
    @Body() body: ResolvePaymentDisputeDto,
  ) {
    return this.svc.resolveDispute(admin.id, disputeId, body);
  }

  @Post('payments/:txRef/reconcile')
  @RequirePermissions(P.SUPPORT_PAYMENT_MANAGE)
  @ApiOperation({ summary: 'Admin: check a payment against the gateway now' })
  reconcile(@CurrentUser() admin: CurrentUserDto, @Param('txRef') txRef: string) {
    return this.svc.reconcileNow(admin.id, txRef);
  }

  @Get('payments/:id/timeline')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: every status change, webhook and admin action on one payment' })
  timeline(@Param('id') id: string) {
    return this.svc.timeline(id);
  }

  @Post('payments/:id/hold')
  @RequirePermissions(P.SUPPORT_PAYMENT_MANAGE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: freeze a payment from payout, with a reason' })
  hold(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string, @Body() body: ReasonBodyDto) {
    return this.svc.hold(admin.id, id, body.reason);
  }

  @Post('payments/:id/release')
  @RequirePermissions(P.SUPPORT_PAYMENT_MANAGE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: release a held payment' })
  release(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: ReasonBodyDto,
  ) {
    return this.svc.release(admin.id, id, body.reason);
  }

  @Get('refunds')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({ summary: 'Admin: queue of refunds, requested by default' })
  listRefunds(@Query() q: RefundListQueryDto) {
    return this.svc.listRefunds(q);
  }

  // Declared before the refunds/:id routes.
  @Patch('refunds/bulk/execute')
  @RequirePermissions(P.PAYMENT_REFUND)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: execute many refunds. Each item succeeds or fails on its own.' })
  bulkExecute(@CurrentUser() admin: CurrentUserDto, @Body() body: BulkExecuteRefundsDto) {
    return this.svc.bulkExecuteRefunds(admin, body.items);
  }

  @Post('payments/:id/refund')
  @RequirePermissions(P.PAYMENT_REFUND)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Admin: request a refund, full or partial, with a reason',
    description:
      'Only records the request. A different admin executes it with POST refunds/:id/execute.',
  })
  requestRefund(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: RequestRefundDto,
  ) {
    return this.svc.requestRefund(admin.id, id, body);
  }

  @Get('refunds/:id')
  @RequirePermissions(P.SUPPORT_PAYMENT_READ)
  @ApiOperation({
    summary: 'Admin: one refund with its payment, allocations and disputes (id is the payment id)',
  })
  getRefund(@Param('id') id: string) {
    return this.svc.getRefund(id);
  }

  @Post('refunds/:id/execute')
  @RequirePermissions(P.PAYMENT_REFUND)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Admin: execute a requested refund by recording the manual refund reference',
    description:
      'The executor must differ from the requester. A full refund cancels unpaid disbursements.',
  })
  executeRefund(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: ExecuteRefundDto,
  ) {
    return this.svc.executeRefund(admin, id, body);
  }

  @Post('refunds/:id/reject')
  @RequirePermissions(P.PAYMENT_REFUND)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: decline a refund request, with a reason' })
  rejectRefund(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: ReasonBodyDto,
  ) {
    return this.svc.rejectRefund(admin.id, id, body.reason);
  }

  @Post('refunds/:id/retry')
  @RequirePermissions(P.PAYMENT_REFUND)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Admin: put a failed or rejected refund back in the queue' })
  retryRefund(@CurrentUser() admin: CurrentUserDto, @Param('id') id: string) {
    return this.svc.retryRefund(admin.id, id);
  }

  @Post('payments/:id/refund-excess')
  @RequirePermissions(P.PAYMENT_REFUND)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Admin: return the overpaid part of a payment, through Chapa or by recording a manual reference',
    description: 'The admin who approved the overpaid payment cannot be the one who refunds it.',
  })
  refundExcess(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: ExecuteRefundDto,
  ) {
    return this.svc.executeExcessRefund(admin, id, body);
  }
}
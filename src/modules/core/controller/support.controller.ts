import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupportService } from '../service/support.service';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import {
  CancelSupportDto,
  CompleteSupportDto,
  CreateSupportDto,
  ListSupportQueryDto,
} from '../dto/support.dto';

@ApiTags('Support')
@ApiBearerAuth('access-token')
@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  // POST /support — any authenticated user; non-financial offers only, starts PENDING.
  @Post()
  @ApiOperation({
    summary: 'Offer non-financial support',
    description:
      'Authenticated users can offer goods, time or skills for a published victim profile by ticking ' +
      'one or more checklist items. The offer is recorded as PENDING and an admin follows up; the ' +
      'handover happens off the platform. No amount is accepted. Money is paid through ' +
      'POST /payments/victim-profile/:victimProfileId/support-checkout instead.',
  })
  async create(@CurrentUser() user: CurrentUserDto, @Body() data: CreateSupportDto) {
    return this.supportService.create(user, data);
  }

  // GET /support — admin queue.
  @Get()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_READ)
  @ApiOperation({
    summary: 'Admin: list supports',
    description:
      'Lists supports, newest first, optionally filtered by status and type. Use status=PENDING ' +
      'and type=NON_FINANCIAL to find offers waiting for follow-up. Includes the supporter name and contact.',
  })
  async listForAdmin(@Query() query: ListSupportQueryDto) {
    return this.supportService.listForAdmin(query);
  }

  // GET /support/mine
  @Get('mine')
  @ApiOperation({
    summary: 'Get my support requests',
    description:
      'Returns the support requests created by the currently authenticated user. ' +
      'Each request includes its associated victim profile.',
  })
  async findMine(@CurrentUser() user: CurrentUserDto) {
    return this.supportService.findMine(user);
  }

  // GET /support/stats — declared before ':id' so "stats" isn't matched as an id.
  @Get('stats')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: get support counts by status and total confirmed amount' })
  async getStats() {
    return this.supportService.getStats();
  }

  // GET /support/victim/:victimProfileId/summary — declared before the plain route for readability.
  @Get('victim/:victimProfileId/summary')
  @ApiOperation({
    summary: 'Offer counts for a victim profile',
    description:
      'Returns how many non-financial offers were received and delivered for a published profile. ' +
      'Shown next to total raised, since goods have no money value.',
  })
  async getOfferCounts(@Param('victimProfileId') victimProfileId: string) {
    return this.supportService.getOfferCounts(victimProfileId);
  }

  // GET /support/victim/:victimProfileId — public list for a published profile.
  @Get('victim/:victimProfileId')
  @ApiOperation({
    summary: 'Get public support list for a victim profile',
    description:
      'Returns only CONFIRMED or COMPLETED supports of a published victim profile. ' +
      'Supporters who chose to stay anonymous are shown as an anonymous supporter. ' +
      'Notes, contact details and user IDs are never returned.',
  })
  async findForVictimProfile(@Param('victimProfileId') victimProfileId: string) {
    return this.supportService.findForVictimProfile(victimProfileId);
  }

  // GET /support/:id — owner or admin only (checked in the service).
  @Get(':id')
  @ApiOperation({
    summary: 'Get support by ID',
    description:
      'Returns a support by its ID. Only the supporter who created it, or an Admin / Super Admin, ' +
      'can read it. The response never includes the full user record.',
  })
  async findOne(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.supportService.findOne(id, user);
  }

  // PATCH /support/:id/confirm — admin accepts a non-financial offer.
  @Patch(':id/confirm')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @ApiOperation({
    summary: 'Confirm a non-financial offer (Admin)',
    description:
      'Admin or Super Admin accepts a PENDING non-financial offer. The claimed victim (if any) ' +
      'is notified at this point. Financial supports are confirmed automatically by a successful ' +
      'Chapa payment and cannot be confirmed here.',
  })
  async confirm(@Param('id') id: string, @CurrentUser() admin: CurrentUserDto) {
    return this.supportService.confirm(id, admin);
  }

  // PATCH /support/:id/complete — marks a confirmed support as completed.
  @Patch(':id/complete')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_REVIEW)
  @ApiOperation({
    summary: 'Complete support (Admin)',
    description:
      'Admin or Super Admin marks a confirmed support as completed after it has been fully handled. ' +
      'A note is required and is stored in the audit trail. This endpoint does not process ' +
      'or transfer money.',
  })
  async complete(
    @Param('id') id: string,
    @CurrentUser() admin: CurrentUserDto,
    @Body() body: CompleteSupportDto,
  ) {
    return this.supportService.complete(id, admin, body.note);
  }

  // PATCH /support/:id/confirm-receipt — the claimed victim confirms they received non-financial help.
  @Patch(':id/confirm-receipt')
  @ApiOperation({
    summary: 'Confirm receipt of non-financial help (victim)',
    description:
      'The user who claimed the victim profile can confirm, with one tap, that the help was received. ' +
      'Optional. Only for non-financial supports that are CONFIRMED or COMPLETED.',
  })
  async confirmReceipt(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.supportService.confirmReceipt(id, user);
  }

  // PATCH /support/:id/cancel — owner (non-financial, PENDING only) or admin.
  @Patch(':id/cancel')
  @ApiOperation({
    summary: 'Cancel support',
    description:
      'The supporter can cancel their own non-financial offer while it is still PENDING. ' +
      'A paid financial support cannot be cancelled by the user; a refund is a separate admin action. ' +
      'Admin and Super Admin users can cancel any support, which also lowers total raised for ' +
      'financial supports.',
  })
  async cancel(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() body: CancelSupportDto,
  ) {
    return this.supportService.cancel(id, user, body?.reason);
  }
}
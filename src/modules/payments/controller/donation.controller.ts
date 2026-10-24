import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { DonationService } from '../service/donation.service';
import { CreateDonationDto, PagedDto } from '../dto/payments.dto';

/**
 * SUPPORTER SIDE (Option 2: Transfer).
 *
 * Service methods this controller expects on DonationService:
 *   start(user, dto, idempotencyKey?)  -> { paymentId, txRef, checkoutUrl }
 *       Refuses when the profile is not published, donationsPaused, taken down, deleted or completed.
 *       Creates Payment(PENDING) with a unique txRef BEFORE calling Chapa initialize.
 *   verifyForPayer(user, txRef)        -> { status, amount, currency }
 *       Same code path as the webhook: asks Chapa to verify, checks amount + currency, marks PAID once.
 *   findMine(user, query)              -> paged own donations
 *   getPublicTotals(victimProfileId)   -> { raised, donorCount }  (no transfer details)
 */
@ApiTags('Donations')
@Controller('donations')
export class DonationController {
  constructor(private readonly donations: DonationService) {}

  // Literals first so they are not matched as :txRef.

  @Get('mine')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Supporter: list my donations' })
  async findMine(@CurrentUser() user: CurrentUserDto, @Query() query: PagedDto) {
    return this.donations.findMine(user, query);
  }

  // Public: only what the victim page may show. Never bank details, fees or transfer state.
  @Get('public/:victimProfileId/totals')
  @AllowAnonymous()
  @ApiOperation({ summary: 'Public: total raised and donor count for one published profile' })
  async publicTotals(@Param('victimProfileId') victimProfileId: string) {
    return this.donations.getPublicTotals(victimProfileId);
  }

  @Post()
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Supporter: start a donation and get the Chapa checkout URL' })
  async start(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateDonationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.donations.start(user, data, idempotencyKey);
  }

  // Called by the return page after Chapa redirects the donor back.
  @Get('verify/:txRef')
  @Roles(RolesEnum.USER, RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Supporter: check the result of my donation with Chapa' })
  async verify(@CurrentUser() user: CurrentUserDto, @Param('txRef') txRef: string) {
    return this.donations.verifyForPayer(user, txRef);
  }
}
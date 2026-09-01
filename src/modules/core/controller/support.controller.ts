import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { SupportService } from '../service/support.service';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { CreateSupportDto } from '../dto/support.dto';

@ApiTags('Support')
@ApiBearerAuth('access-token')
@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  // ─────────────────────────────────────────────
  // CREATE SUPPORT REQUEST
  // POST /support
  //
  // ROLE:
  // - Any authenticated USER
  // - ADMIN
  // - SUPER_ADMIN
  //
  // PAYMENT:
  // - No payment gateway is integrated yet.
  // - This endpoint only creates a support record.
  // - Payment is handled off-platform.
  // - New support starts with PENDING status.
  // ─────────────────────────────────────────────

  @Post()
  @ApiOperation({
    summary: 'Create a support request',
    description:
      'Authenticated users can create a support request for a published victim profile. ' +
      'Payment is not processed by EHTE at this stage. The supporter declares the support ' +
      'and any off-platform payment information. The support is created with PENDING status.',
  })
  async create(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateSupportDto,
  ) {
    return this.supportService.create(user, data);
  }

  // ─────────────────────────────────────────────
  // MY SUPPORT REQUESTS
  // GET /support/mine
  //
  // ROLE:
  // - Authenticated USER
  // - ADMIN
  // - SUPER_ADMIN
  //
  // PURPOSE:
  // Returns support requests created by the
  // currently authenticated user.
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // SUPPORT FOR VICTIM PROFILE
  // GET /support/victim/:victimProfileId
  //
  // ROLE:
  // - Authenticated user
  //
  // PURPOSE:
  // Returns support records associated with
  // a specific victim profile.
  //
  // NOTE:
  // No @Roles() restriction is currently applied
  // to this endpoint.
  // ─────────────────────────────────────────────

  @Get('victim/:victimProfileId')
  @ApiOperation({
    summary: 'Get support for a victim profile',
    description:
      'Returns support records associated with the specified victim profile. ' +
      'This endpoint currently has no explicit role restriction in the controller.',
  })
  async findForVictimProfile(
    @Param('victimProfileId') victimProfileId: string,
  ) {
    return this.supportService.findForVictimProfile(victimProfileId);
  }

  // ─────────────────────────────────────────────
  // GET ONE SUPPORT REQUEST
  // GET /support/:id
  //
  // ROLE:
  // - Authenticated user
  //
  // PURPOSE:
  // Returns a support request by its ID.
  //
  // NOTE:
  // No @Roles() restriction is currently applied
  // to this endpoint.
  // ─────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({
    summary: 'Get support by ID',
    description:
      'Returns a support request by its ID, including the associated victim profile ' +
      'and user information. This endpoint currently has no explicit role restriction ' +
      'in the controller.',
  })
  async findOne(@Param('id') id: string) {
    return this.supportService.findOne(id);
  }

  // ─────────────────────────────────────────────
  // CONFIRM SUPPORT PAYMENT
  // PATCH /support/:id/confirm
  //
  // ROLE:
  // - ADMIN
  // - SUPER_ADMIN
  //
  // PAYMENT:
  // - Payment is handled off-platform.
  // - Admin manually verifies that the transfer
  //   was actually received.
  // - Changes status to CONFIRMED.
  // ─────────────────────────────────────────────

  @Patch(':id/confirm')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Confirm support payment (Admin)',
    description:
      'Admin or Super Admin manually confirms that the off-platform support payment ' +
      'has been received. This does not process a payment through EHTE. It only changes ' +
      'the support status to CONFIRMED after staff verification.',
  })
  async confirm(@Param('id') id: string) {
    return this.supportService.confirm(id);
  }

  // ─────────────────────────────────────────────
  // COMPLETE SUPPORT
  // PATCH /support/:id/complete
  //
  // ROLE:
  // - ADMIN
  // - SUPER_ADMIN
  //
  // PURPOSE:
  // Marks a confirmed support request as completed.
  // ─────────────────────────────────────────────

  @Patch(':id/complete')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Complete support (Admin)',
    description:
      'Admin or Super Admin marks a confirmed support request as completed after ' +
      'the support process has been fully handled. This endpoint does not process ' +
      'or transfer money.',
  })
  async complete(@Param('id') id: string) {
    return this.supportService.complete(id);
  }

  // ─────────────────────────────────────────────
  // CANCEL SUPPORT
  // PATCH /support/:id/cancel
  //
  // ROLE:
  // - Support creator can cancel their own support.
  // - ADMIN can cancel support.
  // - SUPER_ADMIN can cancel support.
  //
  // PURPOSE:
  // Cancels the support request.
  //
  // NOTE:
  // A normal user cannot cancel a support that has
  // already been CONFIRMED.
  // ─────────────────────────────────────────────

  @Patch(':id/cancel')
  @ApiOperation({
    summary: 'Cancel support',
    description:
      'The user who created the support can cancel their own support request. ' +
      'Admin and Super Admin users can cancel support requests as well. ' +
      'A normal user cannot cancel a support that has already been confirmed.',
  })
  async cancel(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
  ) {
    return this.supportService.cancel(id, user);
  }
}

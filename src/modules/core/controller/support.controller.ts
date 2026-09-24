import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupportService } from '../service/support.service';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { CreateSupportDto } from '../dto/support.dto';

@ApiTags('Support')
@ApiBearerAuth('access-token')
@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  // POST /support — any authenticated user; payment is handled off-platform, starts PENDING.
  @Post()
  @ApiOperation({
    summary: 'Create a support request',
    description:
      'Authenticated users can create a support request for a published victim profile. ' +
      'Payment is not processed by EHTE at this stage. The supporter declares the support ' +
      'and any off-platform payment information. The support is created with PENDING status.',
  })
  async create(@CurrentUser() user: CurrentUserDto, @Body() data: CreateSupportDto) {
    return this.supportService.create(user, data);
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

  // GET /support/victim/:victimProfileId — no @Roles/@RequirePermissions; service-level concern.
  @Get('victim/:victimProfileId')
  @ApiOperation({
    summary: 'Get support for a victim profile',
    description:
      'Returns support records associated with the specified victim profile. ' +
      'This endpoint currently has no explicit role restriction in the controller.',
  })
  async findForVictimProfile(@Param('victimProfileId') victimProfileId: string) {
    return this.supportService.findForVictimProfile(victimProfileId);
  }

  // GET /support/:id — no @Roles/@RequirePermissions; service-level concern.
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

  // PATCH /support/:id/confirm — admin verifies the off-platform transfer arrived.
  @Patch(':id/confirm')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.SUPPORT_PAYMENT_MANAGE)
  @ApiOperation({
    summary: 'Confirm support payment (Admin)',
    description:
      'Admin or Super Admin manually confirms that the off-platform support payment ' +
      'has been received. This does not process a payment through EHTE. It only changes ' +
      'the support status to CONFIRMED after staff verification.',
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
      'Admin or Super Admin marks a confirmed support request as completed after ' +
      'the support process has been fully handled. This endpoint does not process ' +
      'or transfer money.',
  })
  async complete(@Param('id') id: string, @CurrentUser() admin: CurrentUserDto) {
    return this.supportService.complete(id, admin);
  }

  // PATCH /support/:id/cancel — owner or admin; a non-admin can't cancel a CONFIRMED support.
  @Patch(':id/cancel')
  @ApiOperation({
    summary: 'Cancel support',
    description:
      'The user who created the support can cancel their own support request. ' +
      'Admin and Super Admin users can cancel support requests as well. ' +
      'A normal user cannot cancel a support that has already been confirmed.',
  })
  async cancel(@CurrentUser() user: CurrentUserDto, @Param('id') id: string) {
    return this.supportService.cancel(id, user);
  }
}
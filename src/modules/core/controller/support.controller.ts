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
  // Any authenticated user — this is the supporter declaring
  // they're sending (or have sent) money off-platform.
  // ─────────────────────────────────────────────

  @Post()
  @ApiOperation({ summary: 'Create a support request' })
  async create(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateSupportDto,
  ) {
    return this.supportService.create(user, data);
  }

  // ─────────────────────────────────────────────
  // MY SUPPORT REQUESTS
  // GET /support/mine
  // ─────────────────────────────────────────────

  @Get('mine')
  @ApiOperation({ summary: 'Get my support requests' })
  async findMine(@CurrentUser() user: CurrentUserDto) {
    return this.supportService.findMine(user);
  }

  // ─────────────────────────────────────────────
  // SUPPORT FOR VICTIM PROFILE
  // GET /support/victim/:victimProfileId
  // ─────────────────────────────────────────────

  @Get('victim/:victimProfileId')
  @ApiOperation({ summary: 'Get support for a victim profile' })
  async findForVictimProfile(
    @Param('victimProfileId') victimProfileId: string,
  ) {
    return this.supportService.findForVictimProfile(victimProfileId);
  }

  // ─────────────────────────────────────────────
  // GET ONE SUPPORT REQUEST
  // GET /support/:id
  // ─────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Get support by ID' })
  async findOne(@Param('id') id: string) {
    return this.supportService.findOne(id);
  }

  // ─────────────────────────────────────────────
  // CONFIRM SUPPORT PAYMENT
  // PATCH /support/:id/confirm
  // Admin only — represents staff verifying the off-platform
  // transfer actually arrived.
  // ─────────────────────────────────────────────

  @Patch(':id/confirm')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Confirm support payment' })
  async confirm(@Param('id') id: string) {
    return this.supportService.confirm(id);
  }

  // ─────────────────────────────────────────────
  // COMPLETE SUPPORT PAYMENT
  // PATCH /support/:id/complete
  // Admin only.
  // ─────────────────────────────────────────────

  @Patch(':id/complete')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Complete support payment' })
  async complete(@Param('id') id: string) {
    return this.supportService.complete(id);
  }

  // ─────────────────────────────────────────────
  // CANCEL SUPPORT PAYMENT
  // PATCH /support/:id/cancel
  // The support's own creator, or an admin.
  // ─────────────────────────────────────────────

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancel support payment' })
  async cancel(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
  ) {
    return this.supportService.cancel(id, user);
  }
}
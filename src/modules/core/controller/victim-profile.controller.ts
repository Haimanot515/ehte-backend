import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  VictimProfileStatus,
} from '@prisma/client';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { VictimProfileService } from '../service/victim-profile.service';

import {
  CreateVictimProfileDto,
  UpdateVictimGateDto,
  UpdateVictimProfileDto,
} from '../dto/victim-profile.dto';

@ApiTags('Victim Profiles')
@Controller('victim-profiles')
export class VictimProfileController {
  constructor(
    private readonly victimProfileService: VictimProfileService,
  ) {}

  // ─────────────────────────────────────────────
  // CREATE
  // POST /victim-profiles
  // ─────────────────────────────────────────────

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Create a victim/survivor support profile',
  })
  async create(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: CreateVictimProfileDto,
  ) {
    return this.victimProfileService.create(
      user,
      data,
    );
  }

  // ─────────────────────────────────────────────
  // PUBLIC PROFILES
  // GET /victim-profiles/public
  // ─────────────────────────────────────────────

  @Get('public')
  @AllowAnonymous()
  @ApiOperation({
    summary:
      'Get published victim profiles',
  })
  async findPublic() {
    return this.victimProfileService.findPublic();
  }

  // ─────────────────────────────────────────────
  // GET ONE
  // GET /victim-profiles/:id
  // ─────────────────────────────────────────────

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Get a victim profile',
  })
  async findOne(
    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.findOne(
      id,
    );
  }

  // ─────────────────────────────────────────────
  // UPDATE
  // PATCH /victim-profiles/:id
  // ─────────────────────────────────────────────

  @Patch(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Update a victim profile',
  })
  async update(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: UpdateVictimProfileDto,
  ) {
    return this.victimProfileService.update(
      user,
      id,
      data,
    );
  }

  // ─────────────────────────────────────────────
  // DELETE
  // DELETE /victim-profiles/:id
  // ─────────────────────────────────────────────

  @Delete(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Delete a victim profile',
  })
  async remove(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.remove(
      user,
      id,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — ALL
  // GET /victim-profiles/admin/all
  // ─────────────────────────────────────────────

  @Get('admin/all')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Admin: list victim profiles',
  })
  async findAllForAdmin(
    @Query('status')
    status?: VictimProfileStatus,
  ) {
    return this.victimProfileService.findAllForAdmin(
      status,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — APPROVAL GATES
  // PATCH /victim-profiles/admin/:id/gates
  // ─────────────────────────────────────────────

  @Patch('admin/:id/gates')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Admin: update victim profile approval gates',
  })
  async updateGates(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: UpdateVictimGateDto,
  ) {
    return this.victimProfileService.updateGates(
      id,
      data,
      user.id,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — PUBLISH
  // PATCH /victim-profiles/admin/:id/publish
  // ─────────────────────────────────────────────

  @Patch('admin/:id/publish')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Admin: publish approved victim profile',
  })
  async publish(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.publish(
      id,
      user.id,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — UNPUBLISH
  // PATCH /victim-profiles/admin/:id/unpublish
  // ─────────────────────────────────────────────

  @Patch('admin/:id/unpublish')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Admin: unpublish victim profile',
  })
  async unpublish(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.unpublish(
      id,
      user.id,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — REJECT
  // PATCH /victim-profiles/admin/:id/reject
  // ─────────────────────────────────────────────

  @Patch('admin/:id/reject')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Admin: reject victim profile',
  })
  async reject(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.reject(
      id,
      user.id,
    );
  }
}
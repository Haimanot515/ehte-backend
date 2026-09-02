import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { VictimProfileService } from '../service/victim-profile.service';

import {
  CreateVictimProfileDto,
  FindAllVictimProfilesQueryDto,
  UpdateVictimGateDto,
  UpdateVictimProfileDto,
} from '../dto/victim-profile.dto';

// ─────────────────────────────────────────────
// PRD §19: "Authorized administrators can create or manage a
// Victim/Survivor Profile." Every mutating and single-record read
// route below is admin-only. The only public-facing route is
// GET /victim-profiles/public.
// ─────────────────────────────────────────────

@ApiTags('Victim Profiles')
@Controller('victim-profiles')
export class VictimProfileController {
  constructor(private readonly victimProfileService: VictimProfileService) {}

  // ─────────────────────────────────────────────
  // CREATE
  // POST /victim-profiles
  // Restricted to ADMIN / SUPER_ADMIN (PRD §19, §24)
  // ─────────────────────────────────────────────

  @Post()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: create a victim/survivor support profile',
  })
  async create(
    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: CreateVictimProfileDto,
  ) {
    return this.victimProfileService.create(user, data);
  }

  // ─────────────────────────────────────────────
  // PUBLIC PROFILES
  // GET /victim-profiles/public
  // Only route accessible to the public app (PRD §20)
  // ─────────────────────────────────────────────

  @Get('public')
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get published victim profiles',
  })
  async findPublic() {
    return this.victimProfileService.findPublic();
  }

  // ─────────────────────────────────────────────
  // GET ONE
  // GET /victim-profiles/:id
  // Restricted to ADMIN / SUPER_ADMIN — pre-approval profiles
  // contain unreviewed sensitive detail (PRD §19/§20).
  // ─────────────────────────────────────────────

  @Get(':id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get a victim profile',
  })
  async findOne(
    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.findOne(id);
  }

  // ─────────────────────────────────────────────
  // UPDATE
  // PATCH /victim-profiles/:id
  // Restricted to ADMIN / SUPER_ADMIN (PRD §24)
  // ─────────────────────────────────────────────

  @Patch(':id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: update a victim profile',
  })
  async update(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,

    @Body()
    data: UpdateVictimProfileDto,
  ) {
    return this.victimProfileService.update(user, id, data);
  }

  // ─────────────────────────────────────────────
  // DELETE
  // DELETE /victim-profiles/:id
  // Restricted to ADMIN / SUPER_ADMIN (PRD §24)
  // ─────────────────────────────────────────────

  @Delete(':id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: delete a victim profile',
  })
  async remove(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.remove(user, id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — ALL
  // GET /victim-profiles/admin/all
  // ─────────────────────────────────────────────

  @Get('admin/all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: list victim profiles',
  })
  async findAllForAdmin(
    @Query()
    query: FindAllVictimProfilesQueryDto,
  ) {
    return this.victimProfileService.findAllForAdmin(query);
  }

  // ─────────────────────────────────────────────
  // ADMIN — APPROVAL GATES
  // PATCH /victim-profiles/admin/:id/gates
  // ─────────────────────────────────────────────

  @Patch('admin/:id/gates')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: update victim profile approval gates',
  })
  async updateGates(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: UpdateVictimGateDto,
  ) {
    return this.victimProfileService.updateGates(id, data, user.id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — PUBLISH
  // PATCH /victim-profiles/admin/:id/publish
  // ─────────────────────────────────────────────

  @Patch('admin/:id/publish')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: publish approved victim profile',
  })
  async publish(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.publish(id, user.id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — UNPUBLISH
  // PATCH /victim-profiles/admin/:id/unpublish
  // ─────────────────────────────────────────────

  @Patch('admin/:id/unpublish')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: unpublish victim profile',
  })
  async unpublish(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.unpublish(id, user.id);
  }

  // ─────────────────────────────────────────────
  // ADMIN — REJECT
  // PATCH /victim-profiles/admin/:id/reject
  // ─────────────────────────────────────────────

  @Patch('admin/:id/reject')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: reject victim profile',
  })
  async reject(
    @CurrentUser()
    user: CurrentUserDto,

    @Param('id')
    id: string,
  ) {
    return this.victimProfileService.reject(id, user.id);
  }
}

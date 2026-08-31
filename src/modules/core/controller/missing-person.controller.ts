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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import {
  MissingPersonStatus,
  MissingPersonType,
} from '@prisma/client';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';

import {
  CreateMissingPersonDto,
  UpdateMissingPersonDto,
} from '../dto/missing-person.dto';

import { MissingPersonService } from '../service/missing-person.service';

@ApiTags('Missing Persons')
@Controller('missing-persons')
export class MissingPersonController {
  constructor(
    private readonly missingPersonService: MissingPersonService,
  ) {}

  // ─────────────────────────────────────────────
  // CREATE
  // POST /missing-persons
  // Authenticated USER
  // ─────────────────────────────────────────────

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Submit a missing person report',
  })
  async create(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreateMissingPersonDto,
  ) {
    return this.missingPersonService.create(
      user,
      data,
    );
  }

  // ─────────────────────────────────────────────
  // MY SUBMISSIONS
  // GET /missing-persons/mine
  // Authenticated USER
  // ─────────────────────────────────────────────

  @Get('mine')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get my missing person submissions',
  })
  async findMine(
    @CurrentUser() user: CurrentUserDto,
  ) {
    return this.missingPersonService.findMine(
      user,
    );
  }

  // ─────────────────────────────────────────────
  // PUBLIC LIST
  // GET /missing-persons
  // Anonymous
  // ─────────────────────────────────────────────

  @Get()
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get approved missing persons',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: MissingPersonType,
  })
  async findAll(
    @Query('type') type?: MissingPersonType,
  ) {
    return this.missingPersonService.findAll(
      type,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — GET ALL
  // GET /missing-persons/admin/all
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Get('admin/all')
  @ApiBearerAuth('access-token')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({
    summary:
      'Admin: get all missing person submissions',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: MissingPersonStatus,
  })
  async findAllForAdmin(
    @Query('status') status?: MissingPersonStatus,
  ) {
    return this.missingPersonService.findAllForAdmin(
      status,
    );
  }

  // ─────────────────────────────────────────────
  // PUBLIC ONE
  // GET /missing-persons/:id
  // Anonymous
  // ─────────────────────────────────────────────

  @Get(':id')
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get one approved missing person',
  })
  async findOne(
    @Param('id') id: string,
  ) {
    return this.missingPersonService.findOne(
      id,
    );
  }

  // ─────────────────────────────────────────────
  // UPDATE MY SUBMISSION
  // PATCH /missing-persons/:id
  // Authenticated USER
  // ─────────────────────────────────────────────

  @Patch(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Update my missing person submission',
  })
  async update(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: UpdateMissingPersonDto,
  ) {
    return this.missingPersonService.update(
      user,
      id,
      data,
    );
  }

  // ─────────────────────────────────────────────
  // DELETE MY SUBMISSION
  // DELETE /missing-persons/:id
  // Authenticated USER
  // ─────────────────────────────────────────────

  @Delete(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Delete my missing person submission',
  })
  async remove(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') id: string,
  ) {
    return this.missingPersonService.remove(
      user,
      id,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  // PATCH /missing-persons/admin/:id/status
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────

  @Patch('admin/:id/status')
  @ApiBearerAuth('access-token')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({
    summary:
      'Admin: update missing person status',
  })
  async updateStatus(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') id: string,
    @Body('status') status: MissingPersonStatus,
  ) {
    return this.missingPersonService.updateStatus(
      admin,
      id,
      status,
    );
  }
}
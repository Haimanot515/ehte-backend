import {
  Body,
  Controller,
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

import { InformationStatus } from '@prisma/client';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { InformationSubmissionService } from '../service/information-submission.service';

import { CreateInformationSubmissionDto } from '../dto/information-submission.dto';

@ApiTags('Information Submissions')
@ApiBearerAuth('access-token')
@Controller('information-submissions')
export class InformationSubmissionController {
  constructor(
    private readonly informationSubmissionService: InformationSubmissionService,
  ) {}

  // ─────────────────────────────────────────────
  // CREATE
  // POST /information-submissions/missing-person/:missingPersonId
  // ─────────────────────────────────────────────

  @Post('missing-person/:missingPersonId')
  @ApiOperation({
    summary:
      'Submit information about a missing person',
  })
  async create(
    @Param('missingPersonId')
    missingPersonId: string,

    @CurrentUser()
    user: CurrentUserDto,

    @Body()
    data: CreateInformationSubmissionDto,
  ) {
    return this.informationSubmissionService.create(
      user.id,
      missingPersonId,
      data,
    );
  }

  // ─────────────────────────────────────────────
  // MY SUBMISSIONS
  // GET /information-submissions/mine
  // ─────────────────────────────────────────────

  @Get('mine')
  @ApiOperation({
    summary:
      'Get my information submissions',
  })
  async findMine(
    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.informationSubmissionService.findMine(
      user.id,
    );
  }

  // ─────────────────────────────────────────────
  // INFORMATION FOR MISSING PERSON
  // GET /information-submissions/missing-person/:missingPersonId
  // ─────────────────────────────────────────────

  @Get('missing-person/:missingPersonId')
  @ApiOperation({
    summary:
      'Get reviewed information for a missing person',
  })
  async findForMissingPerson(
    @Param('missingPersonId')
    missingPersonId: string,
  ) {
    return this.informationSubmissionService.findForMissingPerson(
      missingPersonId,
    );
  }

  // ─────────────────────────────────────────────
  // GET ONE
  // GET /information-submissions/:id
  // ─────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({
    summary:
      'Get my information submission',
  })
  async findOne(
    @Param('id')
    id: string,

    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.informationSubmissionService.findOne(
      id,
      user.id,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — ALL
  // GET /information-submissions/admin/all
  //
  // Registered before ':id' so this literal route is never
  // swallowed by the param route above.
  // ─────────────────────────────────────────────

  @Get('admin/all')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Admin: list information submissions',
  })
  async findAllForAdmin(
    @Query('status')
    status?: InformationStatus,
  ) {
    return this.informationSubmissionService.findAllForAdmin(
      status,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — STATUS
  // PATCH /information-submissions/admin/:id/status
  // ─────────────────────────────────────────────

  @Patch('admin/:id/status')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Admin: update information submission status',
  })
  async updateStatus(
    @Param('id')
    id: string,

    @Body('status')
    status: InformationStatus,
  ) {
    return this.informationSubmissionService.updateStatus(
      id,
      status,
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN — REVIEW
  // PATCH /information-submissions/admin/:id/review
  // ─────────────────────────────────────────────

  @Patch('admin/:id/review')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Admin: review information submission',
  })
  async review(
    @Param('id')
    id: string,

    @Body('status')
    status: InformationStatus,

    @CurrentUser()
    user: CurrentUserDto,
  ) {
    return this.informationSubmissionService.review(
      id,
      status,
      user,
    );
  }
}
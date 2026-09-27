// src/modules/billing/controller/institution.controller.ts   (admin)
//
// GAP 8. Separate from AgreementController's existing POST /institutions and
// POST /institutions/:id/mark-signed (which own the bare create/sign
// lifecycle) — this controller owns the KYC profile and review workflow on
// top of that.
//
// ASSUMPTION TO VERIFY: P.INSTITUTIONS_KYC_MANAGE and P.INSTITUTIONS_KYC_REVIEW
// are new PermissionsEnum members that need adding and wiring into your
// role->permission map, kept separate from the existing INSTITUTIONS_MANAGE
// so "can create/sign an institution" and "can approve its KYC" can be
// granted independently.

import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { KycStatus } from '@prisma/client';
import { RequireReauthentication } from '../../../common/decorators/reauth.decorator';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RolesEnum } from '../../../common/enums/roles.enum';
import { PermissionsEnum as P } from '../../../common/enums/permissions.enum';
import { InstitutionService } from '../service/institution.service';
import { ReviewInstitutionKycDto, UpdateInstitutionKycDto } from '../dto/institution.dto';

@ApiTags('Billing Admin')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/billing/institutions') // guards are global (AppModule)
export class InstitutionController {
  constructor(private readonly institutions: InstitutionService) {}

  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @Get()
  list(@Query('kycStatus') kycStatus?: string) {
    const values = Object.values(KycStatus) as string[];
    const status = values.includes(kycStatus ?? '') ? (kycStatus as KycStatus) : undefined;
    return this.institutions.list(status);
  }

  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.institutions.findOne(id);
  }

  @RequirePermissions(P.INSTITUTIONS_KYC_MANAGE)
  @Patch(':id/kyc')
  updateKyc(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() dto: UpdateInstitutionKycDto,
  ) {
    return this.institutions.updateKycProfile(actor.id, id, dto);
  }

  @RequirePermissions(P.INSTITUTIONS_KYC_MANAGE)
  @Post(':id/kyc/submit')
  submitKyc(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return this.institutions.submitForReview(actor.id, id);
  }

  // Approving/rejecting KYC changes what an institution is trusted to
  // receive money against — same reauth guard as agreement retire / bank
  // detail edits (see agreement.controller.ts / victim-profile.controller.ts).
  @RequirePermissions(P.INSTITUTIONS_KYC_REVIEW)
  @RequireReauthentication()
  @Post(':id/kyc/review')
  reviewKyc(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() dto: ReviewInstitutionKycDto,
  ) {
    return this.institutions.reviewKyc(actor.id, id, dto);
  }
}
// src/modules/billing/controller/agreement.controller.ts   (admin)

import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequireReauthentication } from '../../../common/decorators/reauth.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentUserDto } from '../../../common/dtos/current-user.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RolesEnum } from '../../../common/enums/roles.enum';
import { PermissionsEnum as P } from '../../../common/enums/permissions.enum';
import { AgreementService } from '../service/agreement.service';
import { AssignAgreementDto, CreateAgreementDto, CreateInstitutionDto, RetireAgreementDto } from '../dto/agreement.dto';

@ApiTags('Billing Admin')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/billing') // guards are global (AppModule)
export class AgreementController {
  constructor(private readonly agreements: AgreementService) {}

  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @Post('institutions')
  createInstitution(@Body() dto: CreateInstitutionDto) {
    return this.agreements.createInstitution(dto.name);
  }

  @RequirePermissions(P.INSTITUTIONS_MANAGE)
  @Post('institutions/:id/mark-signed')
  markSigned(@CurrentUser() a: CurrentUserDto, @Param('id') id: string) {
    return this.agreements.markSigned(a.id, id);
  }

  @RequirePermissions(P.AGREEMENTS_MANAGE)
  @Get('agreements')
  list() {
    return this.agreements.list();
  }

  @RequirePermissions(P.AGREEMENTS_MANAGE)
  @Post('agreements')
  create(@CurrentUser() a: CurrentUserDto, @Body() dto: CreateAgreementDto) {
    return this.agreements.createDraft(a.id, dto);
  }

  @RequirePermissions(P.AGREEMENTS_ACTIVATE)
  @Post('agreements/:id/activate')
  activate(@CurrentUser() a: CurrentUserDto, @Param('id') id: string) {
    return this.agreements.activate(a.id, id);
  }

  // Same protection as PATCH /victim-profiles/admin/:id/bank-details (reauth + money permission).
  @RequirePermissions(P.AGREEMENTS_MANAGE)
  @RequireReauthentication()
  @Patch('profiles/:profileId/agreement')
  assign(
    @CurrentUser() a: CurrentUserDto,
    @Param('profileId') profileId: string,
    @Body() dto: AssignAgreementDto,
  ) {
    return this.agreements.assignToProfile(a.id, profileId, dto.agreementId);
  }

  // Section 28: admin should see the impact review before retiring.
  @RequirePermissions(P.AGREEMENTS_ACTIVATE)
  @Get('agreements/:id/retirement-impact')
  retirementImpact(@Param('id') id: string) {
    return this.agreements.getRetirementImpact(id);
  }

  // Sensitive financial transition (section 28) — same reauth guard as bank-detail edits.
  @RequirePermissions(P.AGREEMENTS_ACTIVATE)
  @RequireReauthentication()
  @Post('agreements/:id/retire')
  retire(@CurrentUser() a: CurrentUserDto, @Param('id') id: string, @Body() dto: RetireAgreementDto) {
    return this.agreements.retire(a.id, id, dto);
  }
}

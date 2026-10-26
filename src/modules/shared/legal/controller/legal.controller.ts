import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum as P } from 'src/common/enums/permissions.enum';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { LegalService } from '../service/legal.service';
import {
  AcceptLegalDto,
  CreateLegalDocumentDto,
  LegalAcceptancesQueryDto,
  LegalDocumentQueryDto,
  LegalDocumentsListQueryDto,
  UpdateLegalDraftDto,
} from '../dto/legal.dto';

/**
 * LEGAL DOCUMENTS AND CONSENT (SH-37 to SH-45).
 *
 * Public reads (SH-37, SH-38) are @AllowAnonymous: the terms must be readable before sign-up.
 * 'users/me/legal' is a literal that must be matched before any 'users/:id' route — register
 * this module before UserModule (same rule as MyAuditController).
 * ROUTE ORDER inside 'admin/legal': 'acceptances' and 'pending-acceptance' before ':id'.
 * Language comes from ?lang= or the Accept-Language header; the service falls back to the default.
 */
@ApiTags('Legal and consent')
@Controller()
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  // SH-37
  @AllowAnonymous()
  @Get('legal/documents')
  @ApiOperation({ summary: 'Current version of each legal document, with language and effective date' })
  listCurrent(@Req() req: Request, @Query() q: LegalDocumentQueryDto) {
    return this.legal.listCurrent(q.lang ?? req.headers['accept-language']);
  }

  // SH-38
  @AllowAnonymous()
  @Get('legal/documents/:type/current')
  @ApiOperation({ summary: 'Current text of one document in the caller language' })
  getCurrent(@Param('type') type: string, @Req() req: Request, @Query() q: LegalDocumentQueryDto) {
    return this.legal.getCurrent(type, q.lang ?? req.headers['accept-language']);
  }

  // SH-39
  @ApiBearerAuth('access-token')
  @Post('legal/accept')
  @AuditEvent({ action: AuditEventEnum.LEGAL_ACCEPTED, entity: 'LegalAcceptance', capture: ['body'] })
  @ApiOperation({ summary: 'Record acceptance of specific document versions' })
  accept(@CurrentUser() user: CurrentUserDto, @Req() req: Request, @Body() body: AcceptLegalDto) {
    return this.legal.accept(user, body, req);
  }

  // SH-40
  @ApiBearerAuth('access-token')
  @Get('users/me/legal')
  @ApiOperation({ summary: 'Which versions I accepted and whether a newer one needs acceptance' })
  myLegal(@CurrentUser() user: CurrentUserDto) {
    return this.legal.myStatus(user);
  }

  // ── Admin ──────────────────────────────────────────────────────────────

  // SH-42
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.LEGAL_MANAGE)
  @Get('admin/legal/documents')
  @ApiOperation({ summary: 'Admin: versions with acceptance counts' })
  adminList(@Query() q: LegalDocumentsListQueryDto) {
    return this.legal.adminList(q);
  }

  // SH-41
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.LEGAL_MANAGE)
  @Post('admin/legal/documents')
  @AuditEvent({ action: AuditEventEnum.LEGAL_DOCUMENT_PUBLISHED, entity: 'LegalDocument' })
  @ApiOperation({ summary: 'Admin: publish a new version (language, text, effective date, re-acceptance flag)' })
  publish(@CurrentUser() admin: CurrentUserDto, @Body() body: CreateLegalDocumentDto) {
    return this.legal.publish(admin, body);
  }

  // SH-43
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.LEGAL_MANAGE)
  @Get('admin/legal/acceptances')
  @AuditEvent({ action: AuditEventEnum.LEGAL_ACCEPTANCES_VIEWED, entity: 'LegalAcceptance' })
  @ApiOperation({ summary: 'Admin: who accepted which version (filterable, exportable, audited)' })
  acceptances(@CurrentUser() admin: CurrentUserDto, @Query() q: LegalAcceptancesQueryDto) {
    return this.legal.acceptances(admin, q);
  }

  // SH-45
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.LEGAL_MANAGE)
  @Get('admin/legal/pending-acceptance')
  @ApiOperation({ summary: 'Admin: users who have not accepted the latest version' })
  pendingAcceptance() {
    return this.legal.pendingAcceptance();
  }

  // SH-44
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.LEGAL_MANAGE)
  @Patch('admin/legal/documents/:id')
  @AuditEvent({ action: AuditEventEnum.LEGAL_DRAFT_EDITED, entity: 'LegalDocument', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: edit a draft version before it is published' })
  editDraft(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateLegalDraftDto) {
    return this.legal.editDraft(admin, id, body);
  }
}

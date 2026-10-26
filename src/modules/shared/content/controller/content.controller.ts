import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum as P } from 'src/common/enums/permissions.enum';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { ContentService } from '../service/content.service';
import {
  AdminContentQueryDto,
  ContentListQueryDto,
  ContentSearchQueryDto,
  CreateContentDto,
  UpdateContentDto,
} from '../dto/content.dto';

/**
 * FAQ AND SAFETY GUIDANCE (SH-68 to SH-75).
 * ROUTE ORDER: 'safety-guides' (list), then 'safety-guides/:slug'; 'search' is a literal.
 * Language is chosen by ?lang= and falls back to the user's saved language (service).
 */
@ApiTags('Content: FAQ and safety guides')
@ApiBearerAuth('access-token')
@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  // SH-68
  @Get('content/faqs')
  @ApiOperation({ summary: 'FAQ entries in my language' })
  faqs(@CurrentUser() user: CurrentUserDto, @Query() q: ContentListQueryDto) {
    return this.content.listFaqs(user, q);
  }

  // SH-69
  @Get('content/safety-guides')
  @ApiOperation({ summary: 'Safety guides, for example what to do after an incident' })
  guides(@CurrentUser() user: CurrentUserDto, @Query() q: ContentListQueryDto) {
    return this.content.listGuides(user, q);
  }

  // SH-71
  @Get('content/search')
  @ApiOperation({ summary: 'Search FAQs and guides' })
  search(@CurrentUser() user: CurrentUserDto, @Query() q: ContentSearchQueryDto) {
    return this.content.search(user, q);
  }

  // SH-70
  @Get('content/safety-guides/:slug')
  @ApiOperation({ summary: 'One safety guide' })
  guide(@CurrentUser() user: CurrentUserDto, @Param('slug') slug: string, @Query() q: ContentListQueryDto) {
    return this.content.getGuide(user, slug, q);
  }

  // SH-72
  @Get('admin/content')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.CONTENT_MANAGE)
  @ApiOperation({ summary: 'Admin: entries with status' })
  adminList(@Query() q: AdminContentQueryDto) {
    return this.content.adminList(q);
  }

  // SH-73
  @Post('admin/content')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.CONTENT_MANAGE)
  @AuditEvent({ action: AuditEventEnum.CONTENT_CREATED, entity: 'Content' })
  @ApiOperation({ summary: 'Admin: create an entry (kind, language, title, body)' })
  create(@CurrentUser() admin: CurrentUserDto, @Body() body: CreateContentDto) {
    return this.content.create(admin, body);
  }

  // SH-74
  @Patch('admin/content/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.CONTENT_MANAGE)
  @AuditEvent({ action: AuditEventEnum.CONTENT_EDITED, entity: 'Content', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: edit an entry' })
  update(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateContentDto) {
    return this.content.update(admin, id, body);
  }

  // SH-75
  @Delete('admin/content/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.CONTENT_MANAGE)
  @AuditEvent({ action: AuditEventEnum.CONTENT_DELETED, entity: 'Content', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: remove an entry (soft delete)' })
  remove(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.content.softDelete(admin, id);
  }
}

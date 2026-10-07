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
import { AnnouncementsService } from '../service/announcements.service';
import {
  AdminAnnouncementsQueryDto,
  CreateAnnouncementDto,
  MyAnnouncementsQueryDto,
  PreviewAnnouncementDto,
  UpdateAnnouncementDto,
} from '../dto/announcements.dto';

/**
 * ANNOUNCEMENTS (SH-60 to SH-67) — in-app notices, separate from awareness posts.
 * Discreet mode: the service must not put names or the app name in anything pushed outside the app.
 * ROUTE ORDER: admin ':id/reach' and ':id/preview' are distinct from ':id' by method/segments.
 */
@ApiTags('Announcements')
@ApiBearerAuth('access-token')
@Controller()
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  // SH-60
  @Get('announcements')
  @ApiOperation({ summary: 'Active announcements for me, by role, region and language' })
  active(@CurrentUser() user: CurrentUserDto, @Query() q: MyAnnouncementsQueryDto) {
    return this.announcements.listActive(user, q);
  }

  // SH-61
  @Post('announcements/:id/dismiss')
  @ApiOperation({ summary: 'Dismiss one announcement for me' })
  dismiss(@CurrentUser() user: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.dismiss(user, id);
  }

  // SH-62
  @Post('admin/announcements')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.ANNOUNCEMENT_MANAGE)
  @AuditEvent({ action: AuditEventEnum.ANNOUNCEMENT_CREATED, entity: 'Announcement' })
  @ApiOperation({ summary: 'Admin: create with audience, start and end time, severity and languages' })
  create(@CurrentUser() admin: CurrentUserDto, @Body() body: CreateAnnouncementDto) {
    return this.announcements.create(admin, body);
  }

  // SH-63
  @Get('admin/announcements')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.ANNOUNCEMENT_MANAGE)
  @ApiOperation({ summary: 'Admin: announcements with status and reach' })
  adminList(@Query() q: AdminAnnouncementsQueryDto) {
    return this.announcements.adminList(q);
  }

  // SH-66
  @Get('admin/announcements/:id/reach')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.ANNOUNCEMENT_MANAGE)
  @ApiOperation({ summary: 'Admin: shown, dismissed and clicked counts' })
  reach(@Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.reach(id);
  }

  // SH-67
  @Post('admin/announcements/:id/preview')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.ANNOUNCEMENT_MANAGE)
  @ApiOperation({ summary: 'Admin: preview how it looks for a role and language' })
  preview(@Param('id', ParseUUIDPipe) id: string, @Body() body: PreviewAnnouncementDto) {
    return this.announcements.preview(id, body);
  }

  // SH-64
  @Patch('admin/announcements/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.ANNOUNCEMENT_MANAGE)
  @AuditEvent({ action: AuditEventEnum.ANNOUNCEMENT_EDITED, entity: 'Announcement', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: edit an announcement' })
  update(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateAnnouncementDto) {
    return this.announcements.update(admin, id, body);
  }

  // SH-65
  @Delete('admin/announcements/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.ANNOUNCEMENT_MANAGE)
  @AuditEvent({ action: AuditEventEnum.ANNOUNCEMENT_ENDED, entity: 'Announcement', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: end an announcement early' })
  end(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.end(admin, id);
  }
}

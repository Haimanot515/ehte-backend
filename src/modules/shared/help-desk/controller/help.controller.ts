import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum as P } from 'src/common/enums/permissions.enum';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { HelpDeskService } from '../service/help-desk.service';
import {
  AddTicketMessageDto,
  AdminTicketsQueryDto,
  AssignTicketDto,
  CannedRepliesQueryDto,
  CreateTicketDto,
  HelpStatsQueryDto,
  MyTicketsQueryDto,
  RateTicketDto,
  StaffReplyDto,
  UpdateTicketDto,
} from '../dto/help-desk.dto';

/**
 * HELP DESK (SH-46 to SH-59). User routes are under 'help/tickets', staff under 'admin/help'.
 *
 * ROUTE ORDER: 'help/tickets/mine' before any ':id' route; 'admin/help/canned-replies' and
 * 'admin/help/stats' before 'admin/help/tickets/:id'.
 * Internal staff comments are NOT here — they use the notes routes (SH-02).
 */
@ApiTags('Help desk')
@ApiBearerAuth('access-token')
@Controller()
export class HelpDeskController {
  constructor(private readonly help: HelpDeskService) {}

  // ── User ───────────────────────────────────────────────────────────────

  // SH-46
  @Post('help/tickets')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @AuditEvent({ action: AuditEventEnum.HELP_TICKET_OPENED, entity: 'HelpTicket' })
  @ApiOperation({ summary: 'Open a ticket with a category and an optional link to a record' })
  open(@CurrentUser() user: CurrentUserDto, @Body() body: CreateTicketDto) {
    return this.help.open(user, body);
  }

  // SH-47
  @Get('help/tickets/mine')
  @ApiOperation({ summary: 'List my tickets with status' })
  mine(@CurrentUser() user: CurrentUserDto, @Query() q: MyTicketsQueryDto) {
    return this.help.listMine(user, q);
  }

  // SH-48
  @Get('help/tickets/mine/:id')
  @ApiOperation({ summary: 'One of my tickets with its thread' })
  mineOne(@CurrentUser() user: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.help.getMine(user, id);
  }

  // SH-49
  @Post('help/tickets/:id/messages')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Add a reply to my ticket' })
  reply(@CurrentUser() user: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: AddTicketMessageDto) {
    return this.help.addUserMessage(user, id, body);
  }

  // SH-50
  @Patch('help/tickets/:id/close')
  @ApiOperation({ summary: 'Close my ticket' })
  close(@CurrentUser() user: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.help.closeMine(user, id);
  }

  // SH-51
  @Patch('help/tickets/:id/reopen')
  @ApiOperation({ summary: 'Reopen a closed ticket within the allowed time' })
  reopen(@CurrentUser() user: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.help.reopenMine(user, id);
  }

  // SH-52
  @Post('help/tickets/:id/rating')
  @ApiOperation({ summary: 'Rate the answer I received' })
  rate(@CurrentUser() user: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: RateTicketDto) {
    return this.help.rate(user, id, body);
  }

  // ── Staff ──────────────────────────────────────────────────────────────

  // SH-53
  @Get('admin/help/tickets')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.HELP_MANAGE)
  @ApiOperation({ summary: 'Admin: ticket queue filtered by status, category and age' })
  adminList(@CurrentUser() admin: CurrentUserDto, @Query() q: AdminTicketsQueryDto) {
    return this.help.adminList(admin, q);
  }

  // SH-58
  @Get('admin/help/canned-replies')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.HELP_MANAGE)
  @ApiOperation({ summary: 'Admin: saved replies for common questions' })
  cannedReplies(@Query() q: CannedRepliesQueryDto) {
    return this.help.cannedReplies(q);
  }

  // SH-59
  @Get('admin/help/stats')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.HELP_MANAGE)
  @ApiOperation({ summary: 'Admin: volume, first-response time and resolution time' })
  stats(@Query() q: HelpStatsQueryDto) {
    return this.help.stats(q);
  }

  // SH-54
  @Get('admin/help/tickets/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.HELP_MANAGE)
  @AuditEvent({ action: AuditEventEnum.HELP_TICKET_VIEWED, entity: 'HelpTicket', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: one ticket with its thread and linked record' })
  adminGet(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.help.adminGet(admin, id);
  }

  // SH-55
  @Patch('admin/help/tickets/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.HELP_MANAGE)
  @AuditEvent({ action: AuditEventEnum.HELP_TICKET_UPDATED, entity: 'HelpTicket', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: change status, category or priority' })
  adminUpdate(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateTicketDto) {
    return this.help.adminUpdate(admin, id, body);
  }

  // SH-56
  @Post('admin/help/tickets/:id/messages')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(P.HELP_MANAGE)
  @AuditEvent({ action: AuditEventEnum.HELP_TICKET_STAFF_REPLIED, entity: 'HelpTicket', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: staff reply visible to the user (internal notes use the notes routes)' })
  staffReply(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: StaffReplyDto) {
    return this.help.staffReply(admin, id, body);
  }

  // SH-57
  @Patch('admin/help/tickets/:id/assign')
  @Roles(RolesEnum.SUPER_ADMIN)
  @AuditEvent({ action: AuditEventEnum.HELP_TICKET_ASSIGNED, entity: 'HelpTicket', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Super admin: assign a staff member to a ticket' })
  assign(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: AssignTicketDto) {
    return this.help.assign(admin, id, body);
  }
}

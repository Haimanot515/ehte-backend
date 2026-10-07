import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { UserBlockingAbuseService } from '../service/user-blocking-abuse.service';
import {
  AbuseReportsQueryDto,
  AbuseStatsQueryDto,
  BlockedListQueryDto,
  CreateAbuseReportDto,
  ResolveAbuseReportDto,
} from '../dto/user-blocking-abuse.dto';

/**
 * USER BLOCKING AND ABUSE (SH-76 to SH-84).
 *
 * 'users/me/blocked' is a literal under 'users/' — register this module BEFORE UserModule so
 * it is matched before any 'users/:id' route.
 * ROUTE ORDER inside 'admin/abuse-reports': 'stats' and 'by-user/:userId' before ':id'.
 *
 * OVERLAP: UserController already exposes GET users/abuse-reports (US-33, Super Admin). SH-80
 * (GET admin/abuse-reports, Admin) serves the same queue. Point both at one service method,
 * or retire US-33 once the admin app moves over.
 */
@ApiTags('User blocking and abuse')
@ApiBearerAuth('access-token')
@Controller()
export class UserBlockingAbuseController {
  constructor(private readonly svc: UserBlockingAbuseService) {}

  // SH-78
  @Get('users/me/blocked')
  @ApiOperation({ summary: 'List who I blocked' })
  myBlocked(@CurrentUser() user: CurrentUserDto, @Query() q: BlockedListQueryDto) {
    return this.svc.listBlocked(user, q);
  }

  // SH-76
  @Post('users/:id/block')
  @AuditEvent({ action: AuditEventEnum.USER_BLOCKED, entity: 'User', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Block another user from contacting me' })
  block(@CurrentUser() user: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.block(user, id);
  }

  // SH-77
  @Delete('users/:id/block')
  @AuditEvent({ action: AuditEventEnum.USER_UNBLOCKED, entity: 'User', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Remove a block' })
  unblock(@CurrentUser() user: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.unblock(user, id);
  }

  // SH-79
  @Post('users/:id/report-abuse')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @AuditEvent({ action: AuditEventEnum.USER_ABUSE_REPORTED, entity: 'User', entityId: { param: 'id' } })
  @ApiOperation({ summary: "Report a user's behaviour with a reason and optional evidence" })
  reportAbuse(@CurrentUser() user: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateAbuseReportDto) {
    return this.svc.reportAbuse(user, id, body);
  }

  // ── Admin ──────────────────────────────────────────────────────────────

  // SH-80
  @Get('admin/abuse-reports')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: queue of abuse reports' })
  adminList(@CurrentUser() admin: CurrentUserDto, @Query() q: AbuseReportsQueryDto) {
    return this.svc.adminList(admin, q);
  }

  // SH-84
  @Get('admin/abuse-reports/stats')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: reports over time and by outcome' })
  adminStats(@Query() q: AbuseStatsQueryDto) {
    return this.svc.adminStats(q);
  }

  // SH-83
  @Get('admin/abuse-reports/by-user/:userId')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: reports against one user' })
  adminByUser(@CurrentUser() admin: CurrentUserDto, @Param('userId', ParseUUIDPipe) userId: string, @Query() q: AbuseReportsQueryDto) {
    return this.svc.adminByUser(admin, userId, q);
  }

  // SH-81
  @Get('admin/abuse-reports/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @AuditEvent({ action: AuditEventEnum.ABUSE_REPORT_VIEWED, entity: 'AbuseReport', entityId: { param: 'id' } })
  @ApiOperation({ summary: "Admin: one report with its evidence and the user's history" })
  adminGet(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.adminGet(admin, id);
  }

  // SH-82
  @Patch('admin/abuse-reports/:id')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @AuditEvent({ action: AuditEventEnum.ABUSE_REPORT_RESOLVED, entity: 'AbuseReport', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: resolve with an outcome (dismiss, warn, suspend) and a reason' })
  adminResolve(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: ResolveAbuseReportDto) {
    return this.svc.adminResolve(admin, id, body);
  }
}

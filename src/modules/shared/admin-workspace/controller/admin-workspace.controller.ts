import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum as P } from 'src/common/enums/permissions.enum';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AdminWorkspaceService } from '../service/admin-workspace.service';
import {
  ActivityFeedQueryDto,
  AdminGlobalSearchQueryDto,
  HandoverDto,
  MyWorkQueryDto,
  RecentQueryDto,
  SlaQueryDto,
  WorkspaceStatsQueryDto,
} from '../dto/admin-workspace.dto';

/**
 * ADMIN WORKSPACE (SH-25 to SH-36). Every route is a literal, so order only matters
 * between 'my-work' and 'my-work/overdue' (different paths, no clash).
 * Results are masked by the caller's role in the service (search, activity feed).
 */
@ApiTags('Admin: workspace')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin')
export class AdminWorkspaceController {
  constructor(private readonly workspace: AdminWorkspaceService) {}

  // SH-25
  @Get('search')
  @ApiOperation({ summary: 'Admin: global search across reports, posts, cases, profiles and users' })
  search(@CurrentUser() admin: CurrentUserDto, @Query() q: AdminGlobalSearchQueryDto) {
    return this.workspace.globalSearch(admin, q);
  }

  // SH-26
  @Get('my-work')
  @ApiOperation({ summary: 'Admin: everything I claimed or am assigned, with age and next action' })
  myWork(@CurrentUser() admin: CurrentUserDto, @Query() q: MyWorkQueryDto) {
    return this.workspace.myWork(admin, q);
  }

  // SH-32
  @Get('my-work/overdue')
  @ApiOperation({ summary: 'Admin: my claimed items past their stale threshold' })
  myWorkOverdue(@CurrentUser() admin: CurrentUserDto, @Query() q: MyWorkQueryDto) {
    return this.workspace.myWorkOverdue(admin, q);
  }

  // SH-27
  @Get('dashboard/summary')
  @ApiOperation({ summary: 'Admin: pending counts, stale items, payments to review, open flags' })
  dashboardSummary(@CurrentUser() admin: CurrentUserDto) {
    return this.workspace.dashboardSummary(admin);
  }

  // SH-28
  @Get('workload')
  @Roles(RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Super admin: open items per admin, to balance assignment' })
  workload() {
    return this.workspace.workload();
  }

  // SH-29
  @Get('unread-summary')
  @ApiOperation({ summary: 'Admin: my unread counts for every module (sidebar badges)' })
  unreadSummary(@CurrentUser() admin: CurrentUserDto) {
    return this.workspace.unreadSummary(admin);
  }

  // SH-30
  @Get('queues')
  @ApiOperation({ summary: 'Admin: every queue with its size and oldest age' })
  queues(@CurrentUser() admin: CurrentUserDto) {
    return this.workspace.queues(admin);
  }

  // SH-31
  @Get('recent')
  @ApiOperation({ summary: 'Admin: records I opened recently, across modules' })
  recent(@CurrentUser() admin: CurrentUserDto, @Query() q: RecentQueryDto) {
    return this.workspace.recent(admin, q);
  }

  // SH-33
  @Post('handover')
  @AuditEvent({ action: AuditEventEnum.ADMIN_HANDOVER, entity: 'AdminHandover' })
  @ApiOperation({ summary: 'Admin: hand all my open claims to another admin before leave' })
  handover(@CurrentUser() admin: CurrentUserDto, @Body() body: HandoverDto) {
    return this.workspace.handover(admin, body);
  }

  // SH-34
  @Get('sla')
  @ApiOperation({ summary: 'Admin: items near or past the response target, by module' })
  sla(@CurrentUser() admin: CurrentUserDto, @Query() q: SlaQueryDto) {
    return this.workspace.sla(admin, q);
  }

  // SH-35
  @Get('activity-feed')
  @ApiOperation({ summary: 'Admin: recent team actions on shared records (no sensitive detail)' })
  activityFeed(@CurrentUser() admin: CurrentUserDto, @Query() q: ActivityFeedQueryDto) {
    return this.workspace.activityFeed(admin, q);
  }

  // SH-36
  @Get('stats/overview')
  @RequirePermissions(P.DASHBOARD_READ)
  @ApiOperation({ summary: 'Admin: company-wide dashboard in one call' })
  statsOverview(@CurrentUser() admin: CurrentUserDto, @Query() q: WorkspaceStatsQueryDto) {
    return this.workspace.statsOverview(admin, q);
  }
}

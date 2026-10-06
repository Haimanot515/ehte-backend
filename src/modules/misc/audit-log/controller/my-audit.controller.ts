import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuditLogService } from '../service/audit-log.service';
import { MyActivityQueryDto } from '../dto/audit-log.dto';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

/**
 * A signed-in person's OWN account activity (AL-41, AL-42). Any authenticated user.
 *
 * Deliberately a separate controller: AuditLogController is admin-only through a class-level
 * @Roles, and these two routes must work for everyone. AuditLogModule registers this controller
 * BEFORE AuditLogController, so 'me' is never read as an audit log id by 'GET :id'.
 *
 * Privacy: rows carry no IP address, device, session or request detail, and only the caller's
 * own events are ever returned (the user id comes from the token, never from the request).
 */
@Controller('audit-logs')
@ApiTags('Audit Logs')
@ApiBearerAuth('access-token')
export class MyAuditController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get('me')
  @ApiOperation({
    summary: 'My own account activity: sign-ins, password changes, profile edits',
    description: 'IP address and device detail are never included.',
  })
  async getMyActivity(@CurrentUser() viewer: CurrentUserDto, @Query() query: MyActivityQueryDto) {
    return this.auditLogService.findMyActivity(viewer, query);
  }

  @Get('me/security')
  @ApiOperation({
    summary: 'My security events: new device, failed sign-ins (redacted)',
    description: 'Only security-relevant events about my account.',
  })
  async getMySecurity(@CurrentUser() viewer: CurrentUserDto, @Query() query: MyActivityQueryDto) {
    return this.auditLogService.findMySecurityEvents(viewer, query);
  }
}

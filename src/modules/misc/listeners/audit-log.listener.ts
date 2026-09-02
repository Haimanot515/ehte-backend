import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';

import { AuditEventPayload } from '../events/audit.events';

import { AuditLogService } from '../service/audit-log.service';

@Injectable()
export class AuditLogListener {
  constructor(private readonly auditLogService: AuditLogService) {}

  @OnEvent(AuditEventEnum.USER_CREATED)
  @OnEvent(AuditEventEnum.USER_UPDATED)
  @OnEvent(AuditEventEnum.USER_DEACTIVATED)
  @OnEvent(AuditEventEnum.LOGIN_SUCCESS)
  @OnEvent(AuditEventEnum.LOGIN_FAILED)
  @OnEvent(AuditEventEnum.LOGOUT)
  @OnEvent(AuditEventEnum.PASSWORD_CHANGED)
  @OnEvent(AuditEventEnum.PASSWORD_RESET)
  @OnEvent(AuditEventEnum.OTP_VERIFIED)
  @OnEvent(AuditEventEnum.DISCREET_MODE_ENABLED)
  @OnEvent(AuditEventEnum.DISCREET_MODE_DISABLED)
  @OnEvent(AuditEventEnum.REPORT_CREATED)
  @OnEvent(AuditEventEnum.REPORT_UPDATED)
  @OnEvent(AuditEventEnum.REPORT_STATUS_CHANGED)
  @OnEvent(AuditEventEnum.REPORT_ASSIGNED)
  @OnEvent(AuditEventEnum.REPORT_ESCALATED)
  @OnEvent(AuditEventEnum.REPORT_CLOSED)
  @OnEvent(AuditEventEnum.REPORT_REJECTED)
  @OnEvent(AuditEventEnum.POST_CREATED)
  @OnEvent(AuditEventEnum.POST_UPDATED)
  @OnEvent(AuditEventEnum.POST_APPROVED)
  @OnEvent(AuditEventEnum.POST_REJECTED)
  @OnEvent(AuditEventEnum.POST_PUBLISHED)
  @OnEvent(AuditEventEnum.POST_UNPUBLISHED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_CREATED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_UPDATED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_APPROVED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_REJECTED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_FOUND)
  @OnEvent(AuditEventEnum.INFORMATION_SUBMITTED)
  @OnEvent(AuditEventEnum.INFORMATION_REVIEWED)
  @OnEvent(AuditEventEnum.INFORMATION_REJECTED)
  @OnEvent(AuditEventEnum.VICTIM_PROFILE_CREATED)
  @OnEvent(AuditEventEnum.VICTIM_PROFILE_UPDATED)
  @OnEvent(AuditEventEnum.VICTIM_PROFILE_VERIFIED)
  @OnEvent(AuditEventEnum.VICTIM_PROFILE_CONSENT_RECORDED)
  @OnEvent(AuditEventEnum.VICTIM_PROFILE_PRIVACY_REVIEWED)
  @OnEvent(AuditEventEnum.VICTIM_PROFILE_APPROVED)
  @OnEvent(AuditEventEnum.VICTIM_PROFILE_PUBLISHED)
  @OnEvent(AuditEventEnum.VICTIM_PROFILE_REJECTED)
  @OnEvent(AuditEventEnum.SUPPORT_CREATED)
  @OnEvent(AuditEventEnum.SUPPORT_CONFIRMED)
  @OnEvent(AuditEventEnum.SUPPORT_COMPLETED)
  @OnEvent(AuditEventEnum.SUPPORT_CANCELLED)
  @OnEvent(AuditEventEnum.SUPPORT_FAILED)
  @OnEvent(AuditEventEnum.SECURITY_ALERT)
  async handleAuditEvent(payload: AuditEventPayload): Promise<void> {
    await this.auditLogService.record(payload);
  }
}

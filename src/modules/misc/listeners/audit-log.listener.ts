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
  // NEW — cross-checked against AuditEventEnum's own comments pointing
  // at UserService/AuthService methods. USER_DEACTIVATED already existed
  // above (self-deactivation); these are the admin-initiated user-lifecycle
  // and session actions that had no listener at all.
  @OnEvent(AuditEventEnum.USER_DEACTIVATED_BY_ADMIN)
  @OnEvent(AuditEventEnum.USER_REACTIVATED)
  @OnEvent(AuditEventEnum.USER_SESSIONS_REVOKED)
  @OnEvent(AuditEventEnum.USER_UNLOCKED)
  // NEW — role/permission grants on a user (distinct from ROLE_*/PERMISSION_*
  // below, which are about the Role/Permission records themselves).
  @OnEvent(AuditEventEnum.USER_ROLE_ASSIGNED)
  @OnEvent(AuditEventEnum.USER_ROLE_REVOKED)
  // NEW — discreet-mode passcode change, sibling to the enable/disable
  // events already bound above.
  @OnEvent(AuditEventEnum.DISCREET_MODE_PASSCODE_CHANGED)
  @OnEvent(AuditEventEnum.REPORT_CREATED)
  @OnEvent(AuditEventEnum.REPORT_UPDATED)
  @OnEvent(AuditEventEnum.REPORT_STATUS_CHANGED)
  @OnEvent(AuditEventEnum.REPORT_ASSIGNED)
  @OnEvent(AuditEventEnum.REPORT_ESCALATED)
  @OnEvent(AuditEventEnum.REPORT_CLOSED)
  @OnEvent(AuditEventEnum.REPORT_REJECTED)
  // Cross-checked against every emitAudit() call actually made in
  // ReportService; these 8 actions were emitted but had no matching
  // @OnEvent() here, so auditLogService.record() was never called for
  // them and the rows silently never existed. In particular this broke
  // ReportService.getHistory(), which queries auditLog by
  // entity: 'Report' — the per-report timeline was missing every
  // "opened," "media downloaded," "more info requested/responded,"
  // "unassigned," and "withdrawn" entry.
  @OnEvent(AuditEventEnum.REPORT_OPENED)
  @OnEvent(AuditEventEnum.REPORTER_INFORMATION_OPENED)
  @OnEvent(AuditEventEnum.REPORT_MEDIA_DOWNLOADED)
  @OnEvent(AuditEventEnum.REPORT_MORE_INFORMATION_REQUESTED)
  @OnEvent(AuditEventEnum.REPORT_INFORMATION_RESPONDED)
  @OnEvent(AuditEventEnum.REPORT_UNASSIGNED)
  @OnEvent(AuditEventEnum.REPORT_WITHDRAWN)
  @OnEvent(AuditEventEnum.USER_AUTO_FLAGGED)
  @OnEvent(AuditEventEnum.POST_CREATED)
  @OnEvent(AuditEventEnum.POST_UPDATED)
  // Cross-checked against every emitAudit() call in PostService;
  // deleteMyPost() emits this but there was no matching @OnEvent()
  // here, so it was silently dropped.
  @OnEvent(AuditEventEnum.POST_DELETED)
  @OnEvent(AuditEventEnum.POST_APPROVED)
  @OnEvent(AuditEventEnum.POST_REJECTED)
  @OnEvent(AuditEventEnum.POST_PUBLISHED)
  @OnEvent(AuditEventEnum.POST_UNPUBLISHED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_CREATED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_UPDATED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_APPROVED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_REJECTED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_FOUND)
  // NEW — MissingPerson actions not yet reviewed against the service file,
  // but already present (and unbound) in the enum: info-request, redaction,
  // reward review, deletion, and media download on a missing-person case.
  @OnEvent(AuditEventEnum.MISSING_PERSON_MORE_INFO_REQUESTED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_REDACTED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_REWARD_REVIEWED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_DELETED)
  @OnEvent(AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED)
  @OnEvent(AuditEventEnum.INFORMATION_SUBMITTED)
  @OnEvent(AuditEventEnum.INFORMATION_REVIEWED)
  @OnEvent(AuditEventEnum.INFORMATION_REJECTED)
  // NEW — same InformationSubmission module, not yet reviewed against
  // the service file: under-review transition and submission deletion.
  @OnEvent(AuditEventEnum.INFORMATION_UNDER_REVIEW)
  @OnEvent(AuditEventEnum.INFORMATION_SUBMISSION_DELETED)
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
  // NEW — admin-registration lifecycle, referenced by the enum's own
  // comments as AuthService.promoteUserInitiate() and related methods.
  @OnEvent(AuditEventEnum.ADMIN_REGISTERED)
  @OnEvent(AuditEventEnum.ADMIN_REGISTRATION_RESENT)
  @OnEvent(AuditEventEnum.ADMIN_REGISTRATION_CANCELLED)
  @OnEvent(AuditEventEnum.ADMIN_EMAIL_CHANGE_INITIATED)
  @OnEvent(AuditEventEnum.ADMIN_EMAIL_CHANGE_VERIFIED)
  @OnEvent(AuditEventEnum.USER_PROMOTION_INITIATED)
  @OnEvent(AuditEventEnum.USER_PROMOTION_RESENT)
  // NEW — role/permission record management (distinct from USER_ROLE_*
  // above, which is about assigning a role to a user), referenced by the
  // enum's comment pointing at PermissionService.assignToRole().
  @OnEvent(AuditEventEnum.ROLE_CREATED)
  @OnEvent(AuditEventEnum.ROLE_UPDATED)
  @OnEvent(AuditEventEnum.ROLE_DELETED)
  @OnEvent(AuditEventEnum.PERMISSION_ASSIGNED)
  @OnEvent(AuditEventEnum.PERMISSION_REVOKED)
  async handleAuditEvent(payload: AuditEventPayload): Promise<void> {
    await this.auditLogService.record(payload);
  }
}
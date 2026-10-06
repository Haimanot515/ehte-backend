import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';

import { RolesEnum } from '../enums/roles.enum';
import { PermissionsEnum } from '../enums/permissions.enum';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class PermissionsSeeder {
  private readonly logger = new Logger(PermissionsSeeder.name);

  constructor(private readonly prisma: PrismaService) {}

  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (attempt === MAX_ATTEMPTS) {
          break;
        }

        const delayMs = BASE_DELAY_MS * attempt;

        this.logger.warn(
          `${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delayMs}ms. ` +
            `This is expected if the database is waking from a suspended state. ` +
            `Error: ${(error as Error).message}`,
        );

        await sleep(delayMs);
      }
    }

    this.logger.error(`${label} failed after ${MAX_ATTEMPTS} attempts. Giving up.`);
    throw lastError;
  }

  async run(): Promise<void> {
    const permissions = Object.values(PermissionsEnum);

    // One round trip for all permissions instead of one upsert each. Rows that
    // already exist are left untouched, same as the old `update: {}`.
    await this.withRetry('Seed permissions', () =>
      this.prisma.permission.createMany({
        data: permissions.map((name) => ({ name })),
        skipDuplicates: true,
      }),
    );

    const roles = await this.withRetry('Look up ADMIN, SUPER_ADMIN and SYSTEM roles', () =>
      this.prisma.role.findMany({
        where: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN, RolesEnum.SYSTEM] } },
        select: { id: true, name: true },
      }),
    );

    const adminRole = roles.find((role) => role.name === RolesEnum.ADMIN);
    const superAdminRole = roles.find((role) => role.name === RolesEnum.SUPER_ADMIN);
    const systemRole = roles.find((role) => role.name === RolesEnum.SYSTEM);

    if (!adminRole) {
      throw new Error(
        `Required role "${RolesEnum.ADMIN}" was not found. Ensure RolesSeeder runs before PermissionsSeeder.`,
      );
    }

    if (!superAdminRole) {
      throw new Error(
        `Required role "${RolesEnum.SUPER_ADMIN}" was not found. Ensure RolesSeeder runs before PermissionsSeeder.`,
      );
    }

    if (!systemRole) {
      throw new Error(
        `Required role "${RolesEnum.SYSTEM}" was not found. Ensure RolesSeeder runs before PermissionsSeeder.`,
      );
    }

    // Admin gets operational permissions only; sensitive/system ones stay SUPER_ADMIN-only.
    const adminPermissions: PermissionsEnum[] = [
      PermissionsEnum.REPORT_READ,
      PermissionsEnum.REPORT_REVIEW,
      PermissionsEnum.REPORT_UPDATE_STATUS,
      PermissionsEnum.REPORT_REQUEST_INFO,
      PermissionsEnum.REPORT_ASSIGN,
      PermissionsEnum.REPORT_ESCALATE,
      PermissionsEnum.REPORT_CLOSE,
      PermissionsEnum.REPORT_EVIDENCE_READ,
      PermissionsEnum.REPORT_TRIAGE,
      PermissionsEnum.REPORT_EVIDENCE_MANAGE,
      PermissionsEnum.REPORT_LOCATION_READ,
      PermissionsEnum.REPORT_LOCATION_UPDATE,
      PermissionsEnum.REPORT_EMAIL_REPLY,
      // REPORT_AUDIT_READ, REPORT_DELETE, REPORT_EXPORT, REPORT_REVEAL_REPORTER,
      // REPORT_SENSITIVITY_MANAGE: SUPER_ADMIN-only.

      PermissionsEnum.POST_READ,
      PermissionsEnum.POST_REVIEW,
      PermissionsEnum.POST_APPROVE,
      PermissionsEnum.POST_REJECT,
      PermissionsEnum.POST_REQUEST_CHANGES,
      PermissionsEnum.POST_PUBLISH,
      PermissionsEnum.POST_UNPUBLISH,
      PermissionsEnum.POST_CREATE_OFFICIAL,
      PermissionsEnum.POST_DELETE,
      PermissionsEnum.POST_FLAG_REVIEW,
      PermissionsEnum.POST_TAKEDOWN,
      PermissionsEnum.POST_APPEAL_DECIDE,

      PermissionsEnum.MISSING_PERSON_READ,
      PermissionsEnum.MISSING_PERSON_REVIEW,
      PermissionsEnum.MISSING_PERSON_APPROVE,
      PermissionsEnum.MISSING_PERSON_REJECT,
      PermissionsEnum.MISSING_PERSON_UPDATE,
      PermissionsEnum.MISSING_PERSON_INFO_READ,
      PermissionsEnum.MISSING_PERSON_INFO_REVIEW,
      PermissionsEnum.MISSING_PERSON_PUBLISH,
      PermissionsEnum.MISSING_PERSON_UNPUBLISH,
      PermissionsEnum.MISSING_PERSON_DELETE,
      PermissionsEnum.MISSING_PERSON_REDACT,

      PermissionsEnum.PROFILE_READ,
      PermissionsEnum.PROFILE_CREATE,
      PermissionsEnum.PROFILE_UPDATE,
      PermissionsEnum.PROFILE_REVIEW,
      PermissionsEnum.PROFILE_APPROVE,
      PermissionsEnum.PROFILE_PUBLISH,
      PermissionsEnum.PROFILE_UNPUBLISH,
      PermissionsEnum.PROFILE_CONSENT_MANAGE,
      // PROFILE_DELETE, PROFILE_CHILD_SAFETY_REVIEW, PROFILE_BANK_DETAILS_MANAGE: SUPER_ADMIN-only.

      PermissionsEnum.SUPPORT_READ,
      PermissionsEnum.SUPPORT_REVIEW,

      PermissionsEnum.USER_ROLE_ASSIGN,
      // USER_PROMOTE: SUPER_ADMIN-only.

      PermissionsEnum.NOTIFICATION_READ,
      PermissionsEnum.NOTIFICATION_MANAGE,
      // NOTIFICATION_BROADCAST_SEND, NOTIFICATION_USER_DATA_EXPORT/_ERASE: SUPER_ADMIN-only.

      PermissionsEnum.AUDIT_LOG_READ,
      // AUDIT_LOG_EXPORT/PURGE/ANONYMIZE/VERIFY_INTEGRITY, AUDIT_ALERT_MANAGE: SUPER_ADMIN-only.

      PermissionsEnum.DASHBOARD_READ,

      PermissionsEnum.MEDIA_UPLOAD,
      PermissionsEnum.MEDIA_DELETE,

      PermissionsEnum.APP_ACCESS_QR_READ,
    ];

    // Deliberately empty — no automated/service use case defined yet; add when there's a real one.
    const systemPermissions: PermissionsEnum[] = [];

    // USER gets nothing here — this module is admin-only; USER-level auth lives elsewhere.

    const stored = await this.withRetry('Load permission ids', () =>
      this.prisma.permission.findMany({
        where: { name: { in: permissions } },
        select: { id: true, name: true },
      }),
    );
    const idByName = new Map(stored.map((permission) => [permission.name, permission.id]));

    const idsFor = (names: PermissionsEnum[]): string[] =>
      names.map((name) => {
        const id = idByName.get(name);
        if (!id) {
          throw new Error(`Permission "${name}" was not found after seeding.`);
        }
        return id;
      });

    const grants = [
      { label: 'ADMIN', roleId: adminRole.id, names: adminPermissions },
      { label: 'SYSTEM', roleId: systemRole.id, names: systemPermissions },
      { label: 'SUPER_ADMIN', roleId: superAdminRole.id, names: permissions },
    ];

    for (const grant of grants) {
      const permissionIds = idsFor(grant.names);

      if (permissionIds.length === 0) {
        continue;
      }

      await this.withRetry(`Assign permissions to ${grant.label}`, () =>
        this.prisma.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId: grant.roleId, permissionId })),
          skipDuplicates: true,
        }),
      );
    }
  }
}

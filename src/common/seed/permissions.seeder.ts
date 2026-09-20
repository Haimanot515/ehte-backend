import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';

import { RolesEnum } from '../enums/roles.enum';
import { PermissionsEnum } from '../enums/permissions.enum';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class PermissionsSeeder implements OnApplicationBootstrap {
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

  async onApplicationBootstrap(): Promise<void> {
    const permissions = Object.values(PermissionsEnum);

    for (const name of permissions) {
      await this.withRetry(`Seed permission "${name}"`, () =>
        this.prisma.permission.upsert({
          where: { name },
          create: { name },
          update: {},
        }),
      );
    }

    const adminRole = await this.withRetry('Look up ADMIN role', () =>
      this.prisma.role.findUnique({ where: { name: RolesEnum.ADMIN } }),
    );

    const superAdminRole = await this.withRetry('Look up SUPER_ADMIN role', () =>
      this.prisma.role.findUnique({ where: { name: RolesEnum.SUPER_ADMIN } }),
    );

    const systemRole = await this.withRetry('Look up SYSTEM role', () =>
      this.prisma.role.findUnique({ where: { name: RolesEnum.SYSTEM } }),
    );

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

      PermissionsEnum.POST_READ,
      PermissionsEnum.POST_REVIEW,
      PermissionsEnum.POST_APPROVE,
      PermissionsEnum.POST_REJECT,
      PermissionsEnum.POST_REQUEST_CHANGES,
      PermissionsEnum.POST_PUBLISH,
      PermissionsEnum.POST_UNPUBLISH,
      PermissionsEnum.POST_CREATE_OFFICIAL,
      PermissionsEnum.POST_DELETE,

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
    ];

    // Deliberately empty — no automated/service use case defined yet; add when there's a real one.
    const systemPermissions: PermissionsEnum[] = [];

    // USER gets nothing here — this module is admin-only; USER-level auth lives elsewhere.

    for (const permissionName of adminPermissions) {
      const permission = await this.prisma.permission.findUnique({
        where: { name: permissionName },
      });

      if (!permission) {
        throw new Error(`Permission "${permissionName}" was not found after seeding.`);
      }

      await this.withRetry(`Assign "${permissionName}" to ADMIN`, () =>
        this.prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: { roleId: adminRole.id, permissionId: permission.id },
          },
          create: { roleId: adminRole.id, permissionId: permission.id },
          update: {},
        }),
      );
    }

    for (const permissionName of systemPermissions) {
      const permission = await this.prisma.permission.findUnique({
        where: { name: permissionName },
      });

      if (!permission) {
        throw new Error(`Permission "${permissionName}" was not found after seeding.`);
      }

      await this.withRetry(`Assign "${permissionName}" to SYSTEM`, () =>
        this.prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: { roleId: systemRole.id, permissionId: permission.id },
          },
          create: { roleId: systemRole.id, permissionId: permission.id },
          update: {},
        }),
      );
    }

    for (const permissionName of permissions) {
      const permission = await this.prisma.permission.findUnique({
        where: { name: permissionName },
      });

      if (!permission) {
        throw new Error(`Permission "${permissionName}" was not found after seeding.`);
      }

      await this.withRetry(`Assign "${permissionName}" to SUPER_ADMIN`, () =>
        this.prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: { roleId: superAdminRole.id, permissionId: permission.id },
          },
          create: { roleId: superAdminRole.id, permissionId: permission.id },
          update: {},
        }),
      );
    }
  }
}
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';

import { RolesEnum } from '../enums/roles.enum';
import { PermissionsEnum } from '../enums/permissions.enum';

@Injectable()
export class PermissionsSeeder implements OnApplicationBootstrap {
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    const permissions = Object.values(PermissionsEnum);

    // Seed all permissions
    for (const name of permissions) {
      await this.prisma.permission.upsert({
        where: {
          name,
        },
        create: {
          name,
        },
        update: {},
      });
    }

    const adminRole = await this.prisma.role.findUnique({
      where: {
        name: RolesEnum.ADMIN,
      },
    });

    const superAdminRole = await this.prisma.role.findUnique({
      where: {
        name: RolesEnum.SUPER_ADMIN,
      },
    });

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

    /*
     * ADMIN permissions
     *
     * Admin receives operational permissions only.
     * Sensitive/system-management permissions remain SUPER_ADMIN-only.
     */
    const adminPermissions: PermissionsEnum[] = [
      // Reports
      PermissionsEnum.REPORT_READ,
      PermissionsEnum.REPORT_REVIEW,
      PermissionsEnum.REPORT_UPDATE_STATUS,
      PermissionsEnum.REPORT_REQUEST_INFO,
      PermissionsEnum.REPORT_ASSIGN,
      PermissionsEnum.REPORT_ESCALATE,
      PermissionsEnum.REPORT_CLOSE,
      PermissionsEnum.REPORT_EVIDENCE_READ,

      // Posts
      PermissionsEnum.POST_READ,
      PermissionsEnum.POST_REVIEW,
      PermissionsEnum.POST_APPROVE,
      PermissionsEnum.POST_REJECT,
      PermissionsEnum.POST_REQUEST_CHANGES,
      PermissionsEnum.POST_PUBLISH,
      PermissionsEnum.POST_UNPUBLISH,
      PermissionsEnum.POST_CREATE_OFFICIAL,

      // Missing persons
      PermissionsEnum.MISSING_PERSON_READ,
      PermissionsEnum.MISSING_PERSON_REVIEW,
      PermissionsEnum.MISSING_PERSON_APPROVE,
      PermissionsEnum.MISSING_PERSON_REJECT,
      PermissionsEnum.MISSING_PERSON_UPDATE,
      PermissionsEnum.MISSING_PERSON_INFO_READ,
      PermissionsEnum.MISSING_PERSON_INFO_REVIEW,
      PermissionsEnum.MISSING_PERSON_PUBLISH,
      PermissionsEnum.MISSING_PERSON_UNPUBLISH,

      // Victim / survivor profiles
      PermissionsEnum.PROFILE_READ,
      PermissionsEnum.PROFILE_CREATE,
      PermissionsEnum.PROFILE_UPDATE,
      PermissionsEnum.PROFILE_REVIEW,
      PermissionsEnum.PROFILE_APPROVE,
      PermissionsEnum.PROFILE_PUBLISH,
      PermissionsEnum.PROFILE_UNPUBLISH,

      // Support
      PermissionsEnum.SUPPORT_READ,
      PermissionsEnum.SUPPORT_REVIEW,

      // Notifications
      PermissionsEnum.NOTIFICATION_READ,
      PermissionsEnum.NOTIFICATION_MANAGE,

      // Audit
      PermissionsEnum.AUDIT_LOG_READ,

      // Dashboard
      PermissionsEnum.DASHBOARD_READ,

      // Media
      PermissionsEnum.MEDIA_UPLOAD,
      PermissionsEnum.MEDIA_DELETE,
    ];

    /*
     * Assign ADMIN permissions
     */
    for (const permissionName of adminPermissions) {
      const permission = await this.prisma.permission.findUnique({
        where: {
          name: permissionName,
        },
      });

      if (!permission) {
        throw new Error(`Permission "${permissionName}" was not found after seeding.`);
      }

      await this.prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: adminRole.id,
            permissionId: permission.id,
          },
        },
        create: {
          roleId: adminRole.id,
          permissionId: permission.id,
        },
        update: {},
      });
    }

    /*
     * SUPER_ADMIN receives all permissions.
     */
    for (const permissionName of permissions) {
      const permission = await this.prisma.permission.findUnique({
        where: {
          name: permissionName,
        },
      });

      if (!permission) {
        throw new Error(`Permission "${permissionName}" was not found after seeding.`);
      }

      await this.prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: superAdminRole.id,
            permissionId: permission.id,
          },
        },
        create: {
          roleId: superAdminRole.id,
          permissionId: permission.id,
        },
        update: {},
      });
    }
  }
}

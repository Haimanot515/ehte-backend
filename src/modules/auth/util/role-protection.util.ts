import { RolesEnum } from 'src/common/enums/roles.enum';

// Roles that can never be renamed or deleted (see RoleService).
export const PROTECTED_ROLE_NAMES: string[] = [
  RolesEnum.SUPER_ADMIN,
  RolesEnum.ADMIN,
  RolesEnum.SYSTEM,
];

// Roles whose permission set can never be changed through the API.
// SUPER_ADMIN must never be stripped (lock-out risk); SYSTEM is internal.
// ADMIN is protected from rename/delete but its permissions stay editable.
export const PERMISSION_LOCKED_ROLE_NAMES: string[] = [RolesEnum.SUPER_ADMIN, RolesEnum.SYSTEM];

// Roles that can never be handed out through admin registration.
export const NON_INVITABLE_ROLE_NAMES: string[] = [RolesEnum.USER, RolesEnum.SYSTEM];

export function isProtectedRole(role: { name: string; isProtected?: boolean }): boolean {
  return role.isProtected === true || PROTECTED_ROLE_NAMES.includes(role.name);
}

export function isPermissionLockedRole(role: { name: string }): boolean {
  return PERMISSION_LOCKED_ROLE_NAMES.includes(role.name);
}

// A "staff" account is any account holding a role other than USER / SYSTEM.
// Replaces the old hard-coded [ADMIN, SUPER_ADMIN] check so that custom roles
// (e.g. CONTENT_MODERATOR) created via POST /roles can use the email-based
// admin login and admin password flows.
export function hasStaffRole(roles: string[]): boolean {
  return roles.some((name) => name !== RolesEnum.USER && name !== RolesEnum.SYSTEM);
}

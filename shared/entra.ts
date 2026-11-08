// Microsoft Entra ID configured in the app: settings, connection test and directory (Graph) DTOs.
import type { Role } from './model';

/** Who may still sign in with e-mail + password while Microsoft sign-in is active. */
export const LOCAL_LOGIN_MODES = ['all', 'admins', 'off'] as const;
export type LocalLoginMode = (typeof LOCAL_LOGIN_MODES)[number];

export const ENTRA_CREDENTIALS = ['secret', 'managedIdentity'] as const;
export type EntraCredential = (typeof ENTRA_CREDENTIALS)[number];

/** Microsoft Graph application permissions (app-only, read) needed for the directory features. */
export const GRAPH_APP_PERMISSIONS = [
  { permission: 'User.Read.All', purpose: 'search users, read a user before adding them to the CMDB' },
  { permission: 'GroupMember.Read.All', purpose: 'search groups, list members, group memberships at sign-in' },
  { permission: 'Application.Read.All', purpose: 'show who is assigned to the app roles of the enterprise application' },
] as const;

/** Fields that can be fixed by environment variables (then read-only in the app). */
export const ENTRA_FIELDS = ['tenantId', 'clientId', 'credential', 'clientSecret', 'managedIdentityClientId', 'requireAppRole'] as const;
export type EntraField = (typeof ENTRA_FIELDS)[number];

export interface EntraConnectionCheck {
  at: string;
  tenantName: string | null;
  grantedPermissions: string[];
}

export interface EntraLoginCheck {
  at: string;
  ok: boolean;
  /** CMDB user who ran the test sign-in */
  userId: string;
  userName: string;
  /** Microsoft account used */
  account: string | null;
  /** Role this account gets at sign-in (must be admin to allow activation) */
  role: Role | null;
  message: string | null;
}

export interface EntraSettingsDto {
  /** env = AUTH_MODE=entra (all values from environment variables, nothing editable) */
  source: 'env' | 'database';
  authMode: 'entra' | 'local' | 'dev';
  /** Fields set by environment variables (read-only) */
  locked: Partial<Record<EntraField, boolean>>;
  tenantId: string;
  clientId: string;
  credential: EntraCredential;
  managedIdentityClientId: string;
  clientSecretSet: boolean;
  clientSecretSetAt: string | null;
  requireAppRole: boolean;
  /** Tenant, client ID and credential are complete */
  configured: boolean;
  /** Microsoft sign-in is active */
  enabled: boolean;
  /** Effective local sign-in (AUTH_MODE=local only) */
  localLogin: LocalLoginMode;
  /** LOCAL_LOGIN_EMERGENCY=true overrides the local sign-in setting for administrators */
  emergencyLocalLogin: boolean;
  redirectUris: string[];
  connection: EntraConnectionCheck | null;
  login: EntraLoginCheck | null;
  /** The current user may activate Microsoft sign-in now */
  canActivate: boolean;
  activationBlockers: string[];
  /** Active administrators linked to a Microsoft account */
  entraAdminCount: number;
  /** Active administrators with a local password */
  localAdminCount: number;
  updatedAt: string | null;
}

export interface EntraSettingsInput {
  tenantId?: string;
  clientId?: string;
  credential?: EntraCredential;
  managedIdentityClientId?: string;
  /** undefined/'' = keep, null = remove */
  clientSecret?: string | null;
  requireAppRole?: boolean;
}

export interface EntraTestResult {
  ok: boolean;
  tenantName?: string | null;
  grantedPermissions?: string[];
  missingPermissions?: string[];
  error?: string;
  hint?: string;
}

export interface DirectoryUser {
  id: string;
  displayName: string;
  userPrincipalName: string | null;
  mail: string | null;
  jobTitle: string | null;
  department: string | null;
  accountEnabled: boolean | null;
  /** Matching CMDB account (by Microsoft account or e-mail) */
  cmdbUserId: string | null;
  cmdbRole: Role | null;
}

export interface DirectoryGroup {
  id: string;
  displayName: string;
  description: string | null;
  mail: string | null;
  securityEnabled: boolean | null;
  mappedRole: Role | null;
}

export interface DirectoryPage<T> {
  items: T[];
  /** Opaque continuation token for the next page (null = no more results) */
  next: string | null;
}

export interface GroupRoleMapping {
  groupId: string;
  displayName: string;
  role: Role;
  plantScope: string[];
  updatedAt: string;
}

export interface AppRoleAssignmentDto {
  principalId: string;
  principalType: 'User' | 'Group' | 'ServicePrincipal' | string;
  principalDisplayName: string;
  appRoleValue: string | null;
  role: Role | null;
  createdDateTime: string | null;
}

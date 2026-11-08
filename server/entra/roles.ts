import type { Pool } from 'pg';
import { ROLES, type Role, type RoleSource } from '../../shared/model';
import { log } from '../lib/log';
import { explainEntraError } from './errors';
import type { EntraService } from './service';
import type { EntraRuntime } from './settings';

/** Highest privilege first (admin > editor > operator > viewer). */
export function highestRole(roles: Role[]): Role | null {
  return ROLES.find((r) => roles.includes(r)) ?? null;
}

export interface GroupRoleResult {
  role: Role | null;
  /** Plant scope from the mappings that grant the role ([] = all plants) */
  scope: string[];
  groupNames: string[];
  /** Group memberships could not be read (Graph not reachable / permission missing) */
  failed: boolean;
}

/**
 * Role from the Entra group mappings. Memberships are read with Graph (/users/{oid}/transitiveMemberOf),
 * not from the "groups" claim (which is cut off for users with many groups). No Graph call without mappings.
 * Several matching groups: the highest role wins; the plant scope is the union of the scopes of the groups
 * granting that role – a group without plant restriction means all plants.
 */
export async function groupRoleFor(pool: Pool, entra: EntraService, rt: EntraRuntime, oid: string): Promise<GroupRoleResult> {
  const { rows: mappings } = await pool.query<{ group_id: string; display_name: string; role: Role; plant_scope: string[] }>(
    'SELECT group_id, display_name, role, plant_scope FROM entra_group_role',
  );
  if (!mappings.length) return { role: null, scope: [], groupNames: [], failed: false };

  let groupIds: string[];
  try {
    groupIds = await entra.userGroupIds(rt, oid);
  } catch (err) {
    log.warn('entra: group memberships could not be read at sign-in', { code: explainEntraError(err, 'GroupMember.Read.All').code });
    return { role: null, scope: [], groupNames: [], failed: true };
  }
  const member = new Set(groupIds.map((g) => g.toLowerCase()));
  const matching = mappings.filter((m) => member.has(m.group_id.toLowerCase()));
  const role = highestRole(matching.map((m) => m.role));
  if (!role) return { role: null, scope: [], groupNames: [], failed: false };
  const granting = matching.filter((m) => m.role === role);
  const unrestricted = granting.some((m) => !m.plant_scope?.length);
  return {
    role,
    scope: unrestricted ? [] : [...new Set(granting.flatMap((m) => m.plant_scope))],
    groupNames: granting.map((m) => m.display_name),
    failed: false,
  };
}

/**
 * The role a Microsoft sign-in results in (also used by the test sign-in before activation):
 * app role from the token > Entra group mapping > role set in the CMDB (pre-provisioned / local account) > DEFAULT_ROLE.
 * Bootstrap administrators are always admin.
 */
export function decideRole(input: {
  appRole: Role | null;
  groupRole: Role | null;
  existing: { role: Role; role_source: RoleSource } | null;
  defaultRole: Role;
  isBootstrapAdmin: boolean;
}): { role: Role; source: RoleSource } {
  let result: { role: Role; source: RoleSource };
  if (input.appRole) result = { role: input.appRole, source: 'entra' };
  else if (input.groupRole) result = { role: input.groupRole, source: 'group' };
  else if (input.existing?.role_source === 'local') result = { role: input.existing.role, source: 'local' };
  // new user, or the app role / group membership was removed
  else result = { role: input.defaultRole, source: 'local' };
  if (input.isBootstrapAdmin) result = { ...result, role: 'admin' };
  return result;
}

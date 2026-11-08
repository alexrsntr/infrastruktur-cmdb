import type { Pool } from 'pg';
import type { Config } from '../config';
import { GRAPH_APP_PERMISSIONS, type EntraConnectionCheck, type EntraTestResult } from '../../shared/entra';
import { log } from '../lib/log';
import { msalClientFactory, tokenAppRoles, type EntraClient, type EntraClientFactory } from './client';
import { explainEntraError } from './errors';
import { GRAPH_SCOPE, GraphClient, encodeNext, decodeNext, type FetchLike, type GraphPage } from './graph';
import { EntraSettingsStore, type EntraRuntime } from './settings';

export interface EntraDeps {
  /** MSAL replacement (tests) */
  clientFactory?: EntraClientFactory;
  /** fetch replacement for Microsoft Graph (tests) */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface GraphUser {
  id: string;
  displayName: string;
  userPrincipalName: string | null;
  mail: string | null;
  jobTitle?: string | null;
  department?: string | null;
  accountEnabled?: boolean | null;
}

export interface GraphGroup {
  id: string;
  displayName: string;
  description: string | null;
  mail: string | null;
  securityEnabled: boolean | null;
}

const USER_SELECT = 'id,displayName,userPrincipalName,mail,jobTitle,department,accountEnabled';
const GROUP_SELECT = 'id,displayName,description,mail,securityEnabled';

/** Small TTL cache for Graph results (per instance). */
class TtlCache {
  private entries = new Map<string, { until: number; value: unknown }>();
  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.until > Date.now()) return hit.value as T;
    const value = await load();
    this.entries.set(key, { until: Date.now() + ttlMs, value });
    if (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
  clear() {
    this.entries.clear();
  }
}

/** Escapes a term for Graph $search ("displayName:term"); quotes and backslashes are not allowed inside. */
const searchTerm = (q: string) => q.replace(/["\\]/g, ' ').trim().slice(0, 100);

export class EntraService {
  readonly settings: EntraSettingsStore;
  private readonly factory: EntraClientFactory;
  private client_: { key: string; client: EntraClient } | null = null;
  private readonly cache = new TtlCache();

  constructor(
    pool: Pool,
    private readonly config: Config,
    private readonly deps: EntraDeps = {},
  ) {
    this.settings = new EntraSettingsStore(pool, config);
    this.factory = deps.clientFactory ?? msalClientFactory;
  }

  runtime(): Promise<EntraRuntime> {
    return this.settings.runtime();
  }

  /** MSAL client for the current configuration – created lazily and replaced when the configuration changes. */
  client(rt: EntraRuntime): EntraClient {
    if (this.client_?.key !== rt.clientKey) {
      this.client_ = {
        key: rt.clientKey,
        client: this.factory({
          tenantId: rt.tenantId,
          clientId: rt.clientId,
          credential: rt.credential,
          clientSecret: rt.clientSecret,
          managedIdentityClientId: rt.managedIdentityClientId,
        }),
      };
      this.cache.clear();
    }
    return this.client_.client;
  }

  private graph(rt: EntraRuntime): GraphClient {
    const client = this.client(rt);
    return new GraphClient(() => client.acquireAppToken(GRAPH_SCOPE), this.deps.fetch, this.deps.sleep);
  }

  // ------------------------------------------------------------------ connection test

  async testConnection(rt: EntraRuntime): Promise<{ result: EntraTestResult; check: EntraConnectionCheck | null; code: string }> {
    try {
      const token = await this.client(rt).acquireAppToken(GRAPH_SCOPE);
      const granted = tokenAppRoles(token);
      const org = await new GraphClient(async () => token, this.deps.fetch, this.deps.sleep).get<GraphPage<{ id: string; displayName: string }>>(
        '/organization?$select=id,displayName',
      );
      const tenantName = org.value[0]?.displayName ?? null;
      const required = GRAPH_APP_PERMISSIONS.map((p) => p.permission as string);
      // Directory.Read.All covers all three read permissions
      const missing = granted.includes('Directory.Read.All') ? [] : required.filter((p) => !granted.includes(p));
      const check: EntraConnectionCheck = { at: new Date().toISOString(), tenantName, grantedPermissions: granted.filter((g) => required.includes(g) || g === 'Directory.Read.All') };
      return {
        result: {
          ok: true,
          tenantName,
          grantedPermissions: check.grantedPermissions,
          missingPermissions: missing,
          hint: missing.length
            ? `Sign-in works. For the directory features add the application permission(s) ${missing.join(', ')} for Microsoft Graph and grant admin consent.`
            : undefined,
        },
        check,
        code: 'ok',
      };
    } catch (err) {
      const e = explainEntraError(err);
      log.warn('entra: connection test failed', { code: e.code });
      return { result: { ok: false, error: e.error, hint: e.hint }, check: null, code: e.code };
    }
  }

  // ------------------------------------------------------------------ directory (read-only)

  private key(rt: EntraRuntime, ...parts: string[]) {
    return [rt.clientKey, ...parts].join('|');
  }

  async searchUsers(rt: EntraRuntime, q: string, next?: string): Promise<{ items: GraphUser[]; next: string | null }> {
    const term = searchTerm(q);
    const path = next
      ? decodeNext(next)
      : term
        ? `/users?$search=${encodeURIComponent(`"displayName:${term}" OR "userPrincipalName:${term}" OR "mail:${term}"`)}&$select=${USER_SELECT}&$top=25&$count=true`
        : `/users?$select=${USER_SELECT}&$top=25`;
    return this.cache.get(this.key(rt, 'users', path), 60_000, async () => {
      const res = await this.graph(rt).get<GraphPage<GraphUser>>(path, { eventual: true });
      return { items: res.value, next: encodeNext(res['@odata.nextLink']) };
    });
  }

  async getUser(rt: EntraRuntime, id: string): Promise<GraphUser> {
    return this.cache.get(this.key(rt, 'user', id), 60_000, () => this.graph(rt).get<GraphUser>(`/users/${encodeURIComponent(id)}?$select=${USER_SELECT}`));
  }

  async searchGroups(rt: EntraRuntime, q: string, next?: string): Promise<{ items: GraphGroup[]; next: string | null }> {
    const term = searchTerm(q);
    const path = next
      ? decodeNext(next)
      : term
        ? `/groups?$search=${encodeURIComponent(`"displayName:${term}" OR "mail:${term}"`)}&$select=${GROUP_SELECT}&$top=25&$count=true`
        : `/groups?$select=${GROUP_SELECT}&$top=25`;
    return this.cache.get(this.key(rt, 'groups', path), 60_000, async () => {
      const res = await this.graph(rt).get<GraphPage<GraphGroup>>(path, { eventual: true });
      return { items: res.value, next: encodeNext(res['@odata.nextLink']) };
    });
  }

  /** Users in a group, including nested groups (same semantics as the role mapping at sign-in). */
  async groupMembers(rt: EntraRuntime, groupId: string, next?: string): Promise<{ items: GraphUser[]; next: string | null }> {
    const path = next ? decodeNext(next) : `/groups/${encodeURIComponent(groupId)}/transitiveMembers/microsoft.graph.user?$select=${USER_SELECT}&$top=50`;
    return this.cache.get(this.key(rt, 'members', path), 60_000, async () => {
      const res = await this.graph(rt).get<GraphPage<GraphUser>>(path, { eventual: true });
      return { items: res.value, next: encodeNext(res['@odata.nextLink']) };
    });
  }

  /** IDs of all groups the user is a member of (transitive) – used at sign-in, cached for 60 s. */
  async userGroupIds(rt: EntraRuntime, oid: string): Promise<string[]> {
    return this.cache.get(this.key(rt, 'memberOf', oid), 60_000, async () => {
      const groups = await this.graph(rt).all<{ id: string }>(`/users/${encodeURIComponent(oid)}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=999`, {
        maxPages: 10,
      });
      return groups.map((g) => g.id);
    });
  }

  /** Users and groups assigned to app roles of the enterprise application (service principal of the app registration). */
  async appRoleAssignments(rt: EntraRuntime): Promise<
    { principalId: string; principalType: string; principalDisplayName: string; appRoleValue: string | null; createdDateTime: string | null }[]
  > {
    return this.cache.get(this.key(rt, 'appRoleAssignedTo'), 60_000, async () => {
      const graph = this.graph(rt);
      const sp = await graph.get<{ id: string; appRoles: { id: string; value: string | null }[] }>(
        `/servicePrincipals(appId='${encodeURIComponent(rt.clientId)}')?$select=id,appRoles`,
      );
      const roles = new Map(sp.appRoles.map((r) => [r.id, r.value]));
      const assignments = await graph.all<{ principalId: string; principalType: string; principalDisplayName: string; appRoleId: string; createdDateTime: string | null }>(
        `/servicePrincipals/${encodeURIComponent(sp.id)}/appRoleAssignedTo?$top=100`,
        { maxPages: 10 },
      );
      return assignments.map((a) => ({
        principalId: a.principalId,
        principalType: a.principalType,
        principalDisplayName: a.principalDisplayName,
        appRoleValue: roles.get(a.appRoleId) ?? null,
        createdDateTime: a.createdDateTime,
      }));
    });
  }
}

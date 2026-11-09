import request from 'supertest';
import type { Express } from 'express';
import { expect } from 'vitest';
import type { EntraClientConfig, EntraClientFactory } from '../server/entra/client';
import type { FetchLike } from '../server/entra/graph';
import type { EntraDeps } from '../server/entra/service';

/**
 * Fake MSAL + Microsoft Graph for tests – no network. The tests decide which identity the next sign-in returns,
 * which permissions the app-only token carries, group memberships and Graph errors.
 */

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const CLIENT = '22222222-2222-4222-8222-222222222222';
export const SECRET = 'super-secret-value~do-not-leak';

export interface FakeUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
  mail?: string | null;
}

export interface FakeGroup {
  id: string;
  displayName: string;
  members: string[];
}

export function fakeJwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none', typ: 'JWT' })}.${b(payload)}.sig`;
}

export function createFakeEntra() {
  const state = {
    /** claims of the next sign-in (oid, tid, preferred_username, name, roles) */
    nextIdentity: null as Record<string, unknown> | null,
    appTokenRoles: ['User.Read.All', 'GroupMember.Read.All', 'Application.Read.All'] as string[],
    tokenError: null as Error | null,
    graphError: null as { status: number; code: string; path?: string } | null,
    throttleOnce: false,
    /** Microsoft Graph not reachable (network error), the token endpoint still works */
    graphUnreachable: false,
    users: [] as FakeUser[],
    groups: [] as FakeGroup[],
    /** service principal app role assignments */
    assignments: [] as { principalId: string; principalType: string; principalDisplayName: string; value: string }[],
    nonces: new Map<string, string>(),
    configs: [] as EntraClientConfig[],
    graphCalls: [] as string[],
  };

  const clientFactory: EntraClientFactory = (cfg) => {
    state.configs.push(cfg);
    return {
      getAuthCodeUrl: async (r) => {
        state.nonces.set(r.state, r.nonce);
        return `https://login.example.test/${cfg.tenantId}/authorize?client_id=${cfg.clientId}&state=${r.state}`;
      },
      // the tests pass the state as authorization code
      acquireTokenByCode: async (r) => {
        if (!state.nextIdentity) throw new Error('no identity prepared');
        const nonce = state.nonces.get(r.code);
        // like MSAL 7: an ID token with a nonce is only accepted together with the nonce of the request
        if (nonce && r.nonce !== nonce) {
          throw Object.assign(new Error('nonce_mismatch: The nonce in the ID token does not match the nonce of the request.'), {
            name: 'ClientAuthError',
            errorCode: 'nonce_mismatch',
          });
        }
        return { idTokenClaims: { tid: TENANT, ...state.nextIdentity, nonce } };
      },
      acquireAppToken: async () => {
        if (state.tokenError) throw state.tokenError;
        return fakeJwt({ tid: TENANT, roles: state.appTokenRoles });
      },
    };
  };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const fetch: FetchLike = async (url, init) => {
    state.graphCalls.push(url);
    if (state.graphUnreachable) {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND graph.microsoft.com'), { code: 'ENOTFOUND' }) });
    }
    // permissions of the app-only token, as Microsoft Graph checks them
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const roles: string[] = JSON.parse(Buffer.from(auth.replace(/^Bearer /, '').split('.')[1] ?? '', 'base64url').toString() || '{}').roles ?? [];
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/v1\.0/, ''));
    if (state.throttleOnce) {
      state.throttleOnce = false;
      return json(429, { error: { code: 'TooManyRequests', message: 'throttled' } }, { 'retry-after': '0' });
    }
    if (state.graphError && (!state.graphError.path || path.startsWith(state.graphError.path))) {
      return json(state.graphError.status, { error: { code: state.graphError.code, message: 'Insufficient privileges to complete the operation.' } });
    }
    const search = (u.searchParams.get('$search') ?? '').toLowerCase();
    const term = search.match(/displayname:([^"]*)"/)?.[1]?.trim() ?? '';
    const user = (x: FakeUser) => ({ ...x, mail: x.mail ?? null, jobTitle: null, department: null, accountEnabled: true });

    if (path === '/organization') {
      // needs Organization.Read.All or Directory.Read.All – not part of the permissions the CMDB asks for
      if (!roles.some((r) => r === 'Organization.Read.All' || r === 'Directory.Read.All')) {
        return json(403, { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } });
      }
      return json(200, { value: [{ id: TENANT, displayName: 'Example Corp' }] });
    }
    if (path === '/users') return json(200, { value: state.users.filter((x) => !term || x.displayName.toLowerCase().includes(term)).map(user) });
    let m = path.match(/^\/users\/([^/]+)\/transitiveMemberOf\/microsoft\.graph\.group$/);
    if (m) return json(200, { value: state.groups.filter((g) => g.members.includes(m![1])).map((g) => ({ id: g.id })) });
    m = path.match(/^\/users\/([^/]+)$/);
    if (m) {
      const found = state.users.find((x) => x.id === m![1]);
      return found ? json(200, user(found)) : json(404, { error: { code: 'Request_ResourceNotFound', message: 'not found' } });
    }
    if (path === '/groups') {
      return json(200, {
        value: state.groups
          .filter((g) => !term || g.displayName.toLowerCase().includes(term))
          .map((g) => ({ id: g.id, displayName: g.displayName, description: null, mail: null, securityEnabled: true })),
      });
    }
    m = path.match(/^\/groups\/([^/]+)\/transitiveMembers\/microsoft\.graph\.user$/);
    if (m) {
      const g = state.groups.find((x) => x.id === m![1]);
      return json(200, { value: state.users.filter((x) => g?.members.includes(x.id)).map(user) });
    }
    if (path.startsWith("/servicePrincipals(appId='")) {
      return json(200, { id: 'sp-1', appRoles: [...new Set(state.assignments.map((a) => a.value))].map((v) => ({ id: `role-${v}`, value: v })) });
    }
    if (path === '/servicePrincipals/sp-1/appRoleAssignedTo') {
      return json(200, {
        value: state.assignments.map((a) => ({ principalId: a.principalId, principalType: a.principalType, principalDisplayName: a.principalDisplayName, appRoleId: `role-${a.value}`, createdDateTime: null })),
      });
    }
    return json(404, { error: { code: 'NotFound', message: `fake graph: ${path}` } });
  };

  const deps: EntraDeps = { clientFactory, fetch, sleep: async () => undefined };
  /** for setupTestApp({ deps }) */
  const appDeps = { entra: deps };
  return { state, deps, appDeps };
}

/** Runs a Microsoft sign-in (or the test sign-in) through the fake: start → callback. Returns the callback response. */
export async function microsoftSignIn(agent: ReturnType<typeof request.agent>, startPath = '/auth/login') {
  const start = await agent.get(startPath).expect(302);
  const location = start.headers.location as string;
  expect(location).toMatch(/^https:\/\/login\.example\.test\//);
  const stateParam = new URL(location).searchParams.get('state')!;
  return agent.get(`/auth/callback?code=${stateParam}&state=${stateParam}`);
}

export async function csrfOf(agent: ReturnType<typeof request.agent>): Promise<string> {
  return (await agent.get('/api/me').expect(200)).body.csrfToken as string;
}

export function api(agent: ReturnType<typeof request.agent>, csrf: string) {
  return {
    get: (url: string) => agent.get(url),
    put: (url: string, body?: object) => agent.put(url).set('x-csrf-token', csrf).send(body ?? {}),
    post: (url: string, body?: object) => agent.post(url).set('x-csrf-token', csrf).send(body ?? {}),
    del: (url: string) => agent.delete(url).set('x-csrf-token', csrf),
  };
}

export type ExpressApp = Express;

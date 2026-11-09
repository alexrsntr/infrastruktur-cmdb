import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { setupTestApp } from './helpers';
import { CLIENT, SECRET, TENANT, api, createFakeEntra, csrfOf } from './fakeEntra';
import { createFakeIdentityPlatform } from './fakeIdentityPlatform';
import { createMsalClient } from '../server/entra/client';
import { log } from '../server/lib/log';

/**
 * Microsoft sign-in with the real MSAL library – only its HTTP layer is replaced. Regression test for the test sign-in
 * that failed with "auth: callback failed" / code "unknown": MSAL 7 rejects an ID token with a nonce (ClientAuthError
 * nonce_mismatch) unless the nonce of the authorization request is passed to acquireTokenByCode.
 */

let app: Express;
let pool: Pool;
const idp = createFakeIdentityPlatform();
const graph = createFakeEntra();

const ADMIN = { display_name: 'Ada Admin', email: 'ada@example.com', password: 'admin password 1' };
/** cloud-only account like "cld…": UPN in preferred_username, no e-mail claim, app role CMDB.Admin */
const CLD = { oid: 'cccccccc-0000-4000-8000-00000000c1d0', upn: 'cld.test@contoso4.onmicrosoft.com', name: 'CLD Test', roles: ['CMDB.Admin'] };
const SETTINGS_URL = '/admin/settings?tab=entra';

let adminAgent: ReturnType<typeof request.agent>;
let admin: ReturnType<typeof api>;

/** browser: start the sign-in in the app → Microsoft sign-in page → back to the app's callback */
async function signIn(agent: ReturnType<typeof request.agent>, startPath: string, claims: Record<string, unknown>, opts: { nonce?: string } = {}) {
  const start = await agent.get(startPath).expect(302);
  const { code, state } = idp.signIn(start.headers.location as string, claims, opts);
  return agent.get(`/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&session_state=fake`);
}

const cldClaims = () => ({ oid: CLD.oid, preferred_username: CLD.upn, name: CLD.name, roles: CLD.roles });

beforeAll(async () => {
  ({ app, pool } = await setupTestApp({
    authMode: 'local',
    deps: { entra: { clientFactory: (cfg) => createMsalClient(cfg, { networkClient: idp.network }), fetch: graph.deps.fetch, sleep: async () => undefined } },
  }));
  adminAgent = request.agent(app);
  await adminAgent.post('/auth/setup').send(ADMIN).expect(201);
  admin = api(adminAgent, await csrfOf(adminAgent));
  await admin.put('/api/settings/entra', { tenantId: TENANT, clientId: CLIENT, credential: 'secret', clientSecret: SECRET }).expect(200);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe('MSAL (real library, fake identity platform)', () => {
  it('rejects the ID token without the nonce of the request and accepts it with the nonce', async () => {
    const client = createMsalClient({ tenantId: TENANT, clientId: CLIENT, credential: 'secret', clientSecret: SECRET, managedIdentityClientId: '' }, { networkClient: idp.network });
    const redirectUri = 'http://localhost:5173/auth/callback';
    const scopes = ['openid', 'profile', 'email'];
    const flow = async () => {
      const codeVerifier = randomBytes(32).toString('base64url');
      const url = await client.getAuthCodeUrl({
        redirectUri,
        scopes,
        state: randomBytes(16).toString('base64url'),
        nonce: randomBytes(16).toString('base64url'),
        codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      });
      return { codeVerifier, nonce: new URL(url).searchParams.get('nonce')!, code: idp.signIn(url, cldClaims()).code };
    };

    // what the app did before the fix: no nonce → MSAL 7 refuses the response
    const before = await flow();
    const err = await client
      .acquireTokenByCode({ code: before.code, codeVerifier: before.codeVerifier, redirectUri, scopes, nonce: undefined as unknown as string })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ClientAuthError', errorCode: 'nonce_mismatch' });

    const after = await flow();
    const result = await client.acquireTokenByCode({ code: after.code, codeVerifier: after.codeVerifier, redirectUri, scopes, nonce: after.nonce });
    expect(result.idTokenClaims).toMatchObject({ oid: CLD.oid, preferred_username: CLD.upn, tid: TENANT, nonce: after.nonce, roles: CLD.roles });
    expect(result.idTokenClaims.email).toBeUndefined();
  });
});

describe('Test sign-in and sign-in with Microsoft through MSAL', () => {
  it('tests the connection with the client credentials flow', async () => {
    const res = await admin.post('/api/settings/entra/test').expect(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(idp.requests.some((r) => r.method === 'POST' && r.url.includes(`/${TENANT}/oauth2/v2.0/token`))).toBe(true);
  });

  it('explains a response that belongs to another sign-in request (nonce) and logs it without secrets', async () => {
    const errors = vi.spyOn(log, 'error');
    const cb = await signIn(adminAgent, '/auth/entra/test-login', cldClaims(), { nonce: 'nonce-of-another-request' });
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe(SETTINGS_URL);

    const s = (await admin.get('/api/settings/entra').expect(200)).body;
    expect(s.login).toMatchObject({ ok: false });
    expect(s.login.message).toMatch(/does not belong to this sign-in request \(nonce\)/);

    const call = errors.mock.calls.find(([msg]) => msg === 'auth: callback failed');
    expect(call?.[1]).toMatchObject({ code: 'msal-nonce_mismatch', purpose: 'test', name: 'ClientAuthError', errorCode: 'nonce_mismatch' });
    expect(call?.[1]?.correlationId).toBeTruthy();
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain(CLD.upn);
    expect(logged).not.toContain('nonce-of-another-request');
    expect(logged).not.toContain('fake-code');
    expect(logged).not.toContain(SECRET);
  });

  it('accepts the test sign-in of a cloud-only account (UPN, no e-mail claim, app role) and links it', async () => {
    const errors = vi.spyOn(log, 'error');
    const cb = await signIn(adminAgent, '/auth/entra/test-login', cldClaims());
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe(SETTINGS_URL);
    expect(errors).not.toHaveBeenCalled();

    const s = (await admin.get('/api/settings/entra').expect(200)).body;
    expect(s.login).toMatchObject({ ok: true, role: 'admin', account: CLD.upn, userName: ADMIN.display_name });
    expect(s.canActivate).toBe(true);

    // linked in the real schema; the password account keeps its e-mail address
    const { rows } = await pool.query('SELECT oid, tenant_id, email FROM app_user WHERE email = $1', [ADMIN.email]);
    expect(rows[0]).toMatchObject({ oid: CLD.oid, tenant_id: TENANT, email: ADMIN.email });
    // the audit log records the result
    const audit = await pool.query(`SELECT changes FROM audit_log WHERE action = 'settings.entra-test-login' ORDER BY id DESC LIMIT 1`);
    expect(audit.rows[0].changes).toMatchObject({ result: 'ok', role: 'admin' });
    // the administrator is still signed in with the password session
    expect((await admin.get('/api/me').expect(200)).body.user.email).toBe(ADMIN.email);
  });

  it('signs in with Microsoft after activation', async () => {
    await admin.post('/api/settings/entra/activate').expect(200);
    const agent = request.agent(app);
    const cb = await signIn(agent, '/auth/login', cldClaims());
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');
    const me = (await agent.get('/api/me').expect(200)).body;
    // the linked administrator account (display name from Microsoft Entra ID, e-mail address of the password account)
    expect(me.user).toMatchObject({ displayName: CLD.name, role: 'admin', roleSource: 'entra' });
    const { rows } = await pool.query('SELECT count(*)::int AS n, min(email) AS email FROM app_user WHERE oid = $1', [CLD.oid]);
    expect(rows[0]).toEqual({ n: 1, email: ADMIN.email });
  });

  it('signs in a new cloud-only account with its UPN as e-mail address', async () => {
    const agent = request.agent(app);
    const oid = 'cccccccc-0000-4000-8000-00000000c1d1';
    const cb = await signIn(agent, '/auth/login', { oid, preferred_username: 'cld.editor@contoso4.onmicrosoft.com', name: 'CLD Editor', roles: ['CMDB.Editor'] });
    expect(cb.headers.location).toBe('/');
    expect((await agent.get('/api/me').expect(200)).body.user).toMatchObject({ role: 'editor', roleSource: 'entra' });
    const { rows } = await pool.query('SELECT email, display_name FROM app_user WHERE oid = $1', [oid]);
    expect(rows[0]).toMatchObject({ email: 'cld.editor@contoso4.onmicrosoft.com', display_name: 'CLD Editor' });
  });
});

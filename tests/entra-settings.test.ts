import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { setupTestApp } from './helpers';
import { CLIENT, SECRET, TENANT, api, createFakeEntra, csrfOf, microsoftSignIn } from './fakeEntra';

/** AUTH_MODE=local: Microsoft Entra ID configured and activated in the app (no environment variables). */

let app: Express;
let pool: Pool;
const fake = createFakeEntra();

const ADMIN = { display_name: 'Ada Admin', email: 'ada@example.com', password: 'admin password 1' };
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';

let admin: ReturnType<typeof api>;
let adminAgent: ReturnType<typeof request.agent>;
let editor: ReturnType<typeof api>;

async function localSignIn(email: string, password: string) {
  const agent = request.agent(app);
  await agent.post('/auth/local-login').send({ email, password }).expect(200);
  return { agent, client: api(agent, await csrfOf(agent)) };
}

beforeAll(async () => {
  ({ app, pool } = await setupTestApp({ authMode: 'local', deps: fake.appDeps }));
  adminAgent = request.agent(app);
  await adminAgent.post('/auth/setup').send(ADMIN).expect(201);
  admin = api(adminAgent, await csrfOf(adminAgent));
  await admin.post('/api/users', { email: 'ed@example.com', display_name: 'Ed Editor', role: 'editor', password: 'editor password 1' }).expect(201);
  editor = (await localSignIn('ed@example.com', 'editor password 1')).client;
});

afterAll(async () => {
  await pool.end();
});

describe('Microsoft Entra ID settings (AUTH_MODE=local)', () => {
  it('starts with password sign-in only', async () => {
    const cfg = (await request(app).get('/api/public-config').expect(200)).body;
    expect(cfg).toMatchObject({ authMode: 'local', entraLogin: false, localLogin: 'all' });
    // without an active configuration /auth/login leads to the login page, not to Microsoft
    const res = await request(app).get('/auth/login').expect(302);
    expect(res.headers.location).toMatch(/^\/login/);
  });

  it('is for administrators only', async () => {
    await editor.get('/api/settings/entra').expect(403);
    await editor.put('/api/settings/entra', { tenantId: TENANT }).expect(403);
    await editor.post('/api/settings/entra/test').expect(403);
    await editor.post('/api/settings/entra/activate').expect(403);
    await editor.put('/api/settings/entra/local-login', { mode: 'off' }).expect(403);
    await editor.get('/api/entra/users?q=a').expect(403);
    await editor.get('/api/entra/group-roles').expect(403);
    await editor.put(`/api/entra/group-roles/${TENANT}`, { display_name: 'x', role: 'admin' }).expect(403);
    await request(app).get('/api/settings/entra').expect(401);
  });

  it('validates input and never returns the client secret', async () => {
    const initial = (await admin.get('/api/settings/entra').expect(200)).body;
    expect(initial).toMatchObject({ source: 'database', configured: false, enabled: false, canActivate: false, clientSecretSet: false });

    const bad = await admin.put('/api/settings/entra', { tenantId: 'contoso.onmicrosoft.com' }).expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/GUID/);

    const saved = await admin.put('/api/settings/entra', { tenantId: TENANT.toUpperCase(), clientId: CLIENT, credential: 'secret', clientSecret: SECRET }).expect(200);
    expect(saved.body).toMatchObject({ tenantId: TENANT, clientId: CLIENT, configured: true, clientSecretSet: true });
    expect(saved.body.clientSecretSetAt).toBeTruthy();
    expect(saved.body.redirectUris).toEqual(['http://localhost:5173/auth/callback', 'http://localhost:5173/']);

    const everything = [JSON.stringify(saved.body), JSON.stringify((await admin.get('/api/settings/entra').expect(200)).body)].join();
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('clientSecretEnc');

    // stored encrypted
    const { rows } = await pool.query(`SELECT value::text AS v FROM app_setting WHERE key = 'entra'`);
    expect(rows[0].v).not.toContain(SECRET);
    expect(rows[0].v).toMatch(/"clientSecretEnc":\s*"v1:/);

    // audit log without the secret
    const auditLog = await admin.get('/api/audit?q=Entra').expect(200);
    expect(JSON.stringify(auditLog.body)).not.toContain(SECRET);
    expect(JSON.stringify(auditLog.body)).toContain('"clientSecret":"changed"');

    // empty secret keeps the stored one
    await admin.put('/api/settings/entra', { clientSecret: '' }).expect(200);
    expect((await admin.get('/api/settings/entra').expect(200)).body.clientSecretSet).toBe(true);
  });

  it('cannot be activated before the checks', async () => {
    const res = await admin.post('/api/settings/entra/activate').expect(409);
    expect(res.body.error).toMatch(/Test connection/);
  });

  it('tests the connection and explains errors', async () => {
    fake.state.tokenError = Object.assign(new Error('AADSTS7000215: Invalid client secret provided.'), { errorCode: 'invalid_client' });
    let res = await admin.post('/api/settings/entra/test').expect(200);
    expect(res.body).toMatchObject({ ok: false });
    expect(res.body.error).toMatch(/client secret is not valid/i);

    fake.state.tokenError = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND login.microsoftonline.com'), { code: 'ENOTFOUND' }) });
    res = await admin.post('/api/settings/entra/test').expect(200);
    expect(res.body.error).toMatch(/could not be reached/);
    expect(res.body.hint).toMatch(/login\.microsoftonline\.com.*graph\.microsoft\.com/);

    fake.state.tokenError = null;
    fake.state.appTokenRoles = [];
    res = await admin.post('/api/settings/entra/test').expect(200);
    expect(res.body).toMatchObject({ ok: true, tenantName: 'Example Corp' });
    expect(res.body.missingPermissions).toEqual(['User.Read.All', 'GroupMember.Read.All', 'Application.Read.All']);

    fake.state.appTokenRoles = ['User.Read.All', 'GroupMember.Read.All', 'Application.Read.All'];
    res = await admin.post('/api/settings/entra/test').expect(200);
    expect(res.body).toMatchObject({ ok: true, tenantName: 'Example Corp', missingPermissions: [] });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    // the fake MSAL client was built from the stored configuration
    expect(fake.state.configs.at(-1)).toMatchObject({ tenantId: TENANT, clientId: CLIENT, credential: 'secret', clientSecret: SECRET });

    const s = (await admin.get('/api/settings/entra').expect(200)).body;
    expect(s.connection).toMatchObject({ tenantName: 'Example Corp' });
    expect(s.canActivate).toBe(false);
    expect(s.activationBlockers.join(' ')).toMatch(/Test sign-in/);
  });

  it('requires a test sign-in that results in the administrator role', async () => {
    // Microsoft account with the app role Viewer → would lose admin rights → not accepted
    fake.state.nextIdentity = { oid: ADMIN_OID, preferred_username: 'ada.admin@corp.example', name: 'Ada (Microsoft)', roles: ['CMDB.Viewer'] };
    let cb = await microsoftSignIn(adminAgent, '/auth/entra/test-login');
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/admin/settings?tab=entra');
    let s = (await admin.get('/api/settings/entra').expect(200)).body;
    expect(s.login).toMatchObject({ ok: false, role: 'viewer', account: 'ada.admin@corp.example' });
    expect(s.login.message).toMatch(/viewer/);
    expect(s.canActivate).toBe(false);
    expect((await pool.query('SELECT oid FROM app_user WHERE email = $1', [ADMIN.email])).rows[0].oid).toBeNull();

    // no app role: the CMDB role of the administrator applies → admin, the Microsoft account is linked
    fake.state.nextIdentity = { oid: ADMIN_OID, preferred_username: 'ada.admin@corp.example', name: 'Ada (Microsoft)' };
    cb = await microsoftSignIn(adminAgent, '/auth/entra/test-login');
    expect(cb.headers.location).toBe('/admin/settings?tab=entra');
    s = (await admin.get('/api/settings/entra').expect(200)).body;
    expect(s.login).toMatchObject({ ok: true, role: 'admin', userName: ADMIN.display_name });
    expect(s.canActivate).toBe(true);
    expect((await pool.query('SELECT oid FROM app_user WHERE email = $1', [ADMIN.email])).rows[0].oid).toBe(ADMIN_OID);
    // the administrator stays signed in with the local session
    expect((await admin.get('/api/me').expect(200)).body.user.email).toBe(ADMIN.email);
  });

  it('must be activated by the administrator who tested the sign-in', async () => {
    await admin.post('/api/users', { email: 'bob@example.com', display_name: 'Bob Admin', role: 'admin', password: 'second admin 1' }).expect(201);
    const bob = (await localSignIn('bob@example.com', 'second admin 1')).client;
    const s = (await bob.get('/api/settings/entra').expect(200)).body;
    expect(s.canActivate).toBe(false);
    expect(s.activationBlockers.join(' ')).toMatch(/Ada Admin/);
    await bob.post('/api/settings/entra/activate').expect(409);
  });

  it('activates Microsoft sign-in without restart', async () => {
    const res = await admin.post('/api/settings/entra/activate').expect(200);
    expect(res.body).toMatchObject({ enabled: true, localLogin: 'all' });
    const cfg = (await request(app).get('/api/public-config').expect(200)).body;
    expect(cfg).toMatchObject({ entraLogin: true, localLogin: 'all' });

    // real sign-in with the linked Microsoft account
    const agent = request.agent(app);
    fake.state.nextIdentity = { oid: ADMIN_OID, preferred_username: 'ada.admin@corp.example', name: 'Ada (Microsoft)' };
    const cb = await microsoftSignIn(agent);
    expect(cb.headers.location).toBe('/');
    const me = (await agent.get('/api/me').expect(200)).body;
    expect(me.user).toMatchObject({ role: 'admin', roleSource: 'local' });
    const out = await agent.post('/auth/logout').expect(200);
    expect(out.body.logoutUrl).toContain(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`);

    // password users are signed out locally only
    const local = (await localSignIn('ed@example.com', 'editor password 1')).agent;
    expect((await local.post('/auth/logout').expect(200)).body.logoutUrl).toBe('/');
  });

  it('rejects sign-ins from another tenant', async () => {
    fake.state.nextIdentity = { oid: 'bbbbbbbb-0000-4000-8000-000000000009', tid: '99999999-9999-4999-8999-999999999999', preferred_username: 'x@other.example', name: 'Other' };
    const cb = await microsoftSignIn(request.agent(app));
    expect(cb.status).toBe(403);
  });

  it('protects the active configuration', async () => {
    const res = await admin.put('/api/settings/entra', { tenantId: '33333333-3333-4333-8333-333333333333' }).expect(409);
    expect(res.body.error).toMatch(/Deactivate/);
    await admin.put('/api/settings/entra', { clientSecret: null }).expect(409);
    // rotating the secret is possible while active; the connection test is requested again
    const rotated = await admin.put('/api/settings/entra', { clientSecret: 'new secret value' }).expect(200);
    expect(rotated.body).toMatchObject({ enabled: true, connection: null });
    expect(rotated.body.login).toMatchObject({ ok: true });
  });

  it('restricts password sign-in to administrators or turns it off', async () => {
    await admin.put('/api/settings/entra/local-login', { mode: 'admins' }).expect(200);
    expect((await request(app).get('/api/public-config').expect(200)).body.localLogin).toBe('admins');
    const denied = await request(app).post('/auth/local-login').send({ email: 'ed@example.com', password: 'editor password 1' }).expect(403);
    expect(denied.body.error).toMatch(/Only administrators/);
    await request(app).post('/auth/local-login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);

    await admin.put('/api/settings/entra/local-login', { mode: 'off' }).expect(200);
    expect((await request(app).get('/api/public-config').expect(200)).body.localLogin).toBe('off');
    await request(app).post('/auth/local-login').send({ email: ADMIN.email, password: ADMIN.password }).expect(403);
    expect((await request(app).get('/auth/setup').expect(200)).body).toEqual({ needsSetup: false });
  });

  it('does not allow turning password sign-in off without an administrator linked to Microsoft', async () => {
    await admin.put('/api/settings/entra/local-login', { mode: 'all' }).expect(200);
    await pool.query(`UPDATE app_user SET oid = NULL WHERE email = $1`, [ADMIN.email]);
    const res = await admin.put('/api/settings/entra/local-login', { mode: 'off' }).expect(409);
    expect(res.body.error).toMatch(/lock yourself out/);
    await pool.query(`UPDATE app_user SET oid = $2 WHERE email = $1`, [ADMIN.email, ADMIN_OID]);
  });

  it('can only be deactivated while an administrator can still sign in with a password', async () => {
    const saved = await pool.query(`SELECT id, password_hash FROM app_user WHERE role = 'admin' AND password_hash IS NOT NULL`);
    await pool.query(`UPDATE app_user SET password_hash = NULL WHERE role = 'admin'`);
    const res = await admin.post('/api/settings/entra/deactivate').expect(409);
    expect(res.body.error).toMatch(/password/);
    for (const r of saved.rows) await pool.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [r.id, r.password_hash]);

    const off = await admin.post('/api/settings/entra/deactivate').expect(200);
    expect(off.body).toMatchObject({ enabled: false, localLogin: 'all' });
    expect((await request(app).get('/api/public-config').expect(200)).body).toMatchObject({ entraLogin: false, localLogin: 'all' });
    // Microsoft sign-in is refused again
    fake.state.nextIdentity = { oid: ADMIN_OID, preferred_username: 'ada.admin@corp.example', name: 'Ada' };
    expect((await request(app).get('/auth/login').expect(302)).headers.location).toMatch(/^\/login/);
  });

  it('builds a new MSAL client when the configuration changes (no restart)', async () => {
    const before = fake.state.configs.length;
    await admin.put('/api/settings/entra', { clientId: '44444444-4444-4444-8444-444444444444' }).expect(200);
    const s = (await admin.get('/api/settings/entra').expect(200)).body;
    expect(s).toMatchObject({ clientId: '44444444-4444-4444-8444-444444444444', connection: null, login: null, canActivate: false });
    await admin.post('/api/settings/entra/test').expect(200);
    expect(fake.state.configs.length).toBe(before + 1);
    expect(fake.state.configs.at(-1)!.clientId).toBe('44444444-4444-4444-8444-444444444444');
  });
});

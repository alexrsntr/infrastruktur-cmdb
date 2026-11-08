import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../server/config';
import { encryptSecret } from '../server/lib/secrets';
import { decideRole, highestRole } from '../server/entra/roles';
import { setupTestApp } from './helpers';
import { CLIENT, SECRET, TENANT, api, createFakeEntra, csrfOf, microsoftSignIn } from './fakeEntra';

/** Role at Microsoft sign-in: app role > group mapping > role set in the CMDB > DEFAULT_ROLE; directory features. */

let app: Express;
let pool: Pool;
let config: Config;
const fake = createFakeEntra();
let admin: ReturnType<typeof api>;
let plants: { id: string; code: string }[];

const G_OPS = 'a0000000-0000-4000-8000-0000000000a1';
const G_EDIT = 'a0000000-0000-4000-8000-0000000000a2';
const U = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function signInAs(identity: Record<string, unknown>) {
  fake.state.nextIdentity = identity;
  const agent = request.agent(app);
  const cb = await microsoftSignIn(agent);
  return { agent, cb };
}

async function writeSettings(patch: Record<string, unknown> = {}) {
  const value = {
    tenantId: TENANT,
    clientId: CLIENT,
    credential: 'secret',
    clientSecretEnc: encryptSecret(config, SECRET),
    clientSecretSetAt: new Date().toISOString(),
    managedIdentityClientId: '',
    requireAppRole: false,
    enabled: true,
    localLogin: 'all',
    checks: null,
    ...patch,
  };
  await pool.query(
    `INSERT INTO app_setting (key, value) VALUES ('entra', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(value)],
  );
}

beforeAll(async () => {
  ({ app, pool, config } = await setupTestApp({ authMode: 'local', deps: fake.appDeps }));
  // activated configuration written directly (the activation checks are covered in entra-settings.test.ts)
  await writeSettings();
  const agent = request.agent(app);
  await agent.post('/auth/setup').send({ display_name: 'Ada Admin', email: 'ada@example.com', password: 'admin password 1' }).expect(201);
  admin = api(agent, await csrfOf(agent));
  plants = (await admin.get('/api/plants').expect(200)).body;
  fake.state.users = [
    { id: U(1), displayName: 'Lena Local', userPrincipalName: 'lena@example.com' },
    { id: U(2), displayName: 'Otto Operator', userPrincipalName: 'otto@example.com' },
    { id: U(3), displayName: 'Nina New', userPrincipalName: 'nina@example.com', mail: 'nina.new@example.com' },
  ];
  fake.state.groups = [
    { id: G_OPS, displayName: 'SG-CMDB-Operators-MUC', members: [U(2), U(5), U(6), U(7)] },
    { id: G_EDIT, displayName: 'SG-CMDB-Editors', members: [U(6)] },
  ];
});

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  fake.state.graphError = null;
  fake.state.throttleOnce = false;
});

describe('role rules', () => {
  it('picks the highest role and follows app role > group > CMDB role > default', () => {
    expect(highestRole(['viewer', 'editor', 'operator'])).toBe('editor');
    expect(highestRole([])).toBeNull();
    const base = { defaultRole: 'viewer' as const, isBootstrapAdmin: false };
    expect(decideRole({ ...base, appRole: 'viewer', groupRole: 'admin', existing: null })).toEqual({ role: 'viewer', source: 'entra' });
    expect(decideRole({ ...base, appRole: null, groupRole: 'operator', existing: { role: 'admin', role_source: 'local' } })).toEqual({ role: 'operator', source: 'group' });
    expect(decideRole({ ...base, appRole: null, groupRole: null, existing: { role: 'editor', role_source: 'local' } })).toEqual({ role: 'editor', source: 'local' });
    expect(decideRole({ ...base, appRole: null, groupRole: null, existing: { role: 'editor', role_source: 'group' } })).toEqual({ role: 'viewer', source: 'local' });
    expect(decideRole({ ...base, appRole: null, groupRole: null, existing: null })).toEqual({ role: 'viewer', source: 'local' });
    expect(decideRole({ ...base, isBootstrapAdmin: true, appRole: 'viewer', groupRole: null, existing: null }).role).toBe('admin');
  });
});

describe('Microsoft sign-in', () => {
  it('gives new users without app role or group the default role – without asking Graph when no group is mapped', async () => {
    fake.state.graphCalls = [];
    const { agent, cb } = await signInAs({ oid: U(9), preferred_username: 'vic@example.com', name: 'Vic Viewer' });
    expect(cb.headers.location).toBe('/');
    expect((await agent.get('/api/me').expect(200)).body.user).toMatchObject({ role: 'viewer', roleSource: 'local' });
    expect(fake.state.graphCalls).toEqual([]);
  });

  it('uses the app role from the token', async () => {
    const { agent } = await signInAs({ oid: U(10), preferred_username: 'erin@example.com', name: 'Erin', roles: ['CMDB.Operator', 'CMDB.Editor'] });
    expect((await agent.get('/api/me').expect(200)).body.user).toMatchObject({ role: 'editor', roleSource: 'entra' });
  });

  it('links an existing local account by e-mail and keeps role, plant scope and history', async () => {
    const ham = plants.find((p) => p.code === 'HAM')!;
    const created = (
      await admin.post('/api/users', { email: 'lena@example.com', display_name: 'Lena Local', role: 'editor', plant_scope: [ham.id], password: 'lena password 1' }).expect(201)
    ).body;
    const { agent } = await signInAs({ oid: U(1), preferred_username: 'Lena@Example.com', name: 'Lena (Microsoft)' });
    const me = (await agent.get('/api/me').expect(200)).body.user;
    expect(me).toMatchObject({ id: created.id, role: 'editor', roleSource: 'local', plantScope: [ham.id] });
    const { rows } = await pool.query('SELECT oid, email FROM app_user WHERE id = $1', [created.id]);
    expect(rows[0]).toEqual({ oid: U(1), email: 'lena@example.com' });
    const history = await admin.get(`/api/audit?userId=${created.id}`).expect(200);
    expect(history.body.items.some((e: { action: string }) => e.action === 'login')).toBe(true);
  });

  it('maps Entra groups to roles and plant scopes (read with Graph, not from the token)', async () => {
    const muc = plants.find((p) => p.code === 'MUC')!;
    await admin.put(`/api/entra/group-roles/${G_OPS}`, { display_name: 'SG-CMDB-Operators-MUC', role: 'operator', plant_scope: [muc.id] }).expect(200);
    await admin.put(`/api/entra/group-roles/${G_EDIT}`, { display_name: 'SG-CMDB-Editors', role: 'editor', plant_scope: [] }).expect(200);
    const mappings = (await admin.get('/api/entra/group-roles').expect(200)).body;
    expect(mappings.map((m: { role: string }) => m.role).sort()).toEqual(['editor', 'operator']);

    fake.state.graphCalls = [];
    const otto = (await signInAs({ oid: U(2), preferred_username: 'otto@example.com', name: 'Otto', groups: [G_EDIT] })).agent;
    expect((await otto.get('/api/me').expect(200)).body.user).toMatchObject({ role: 'operator', roleSource: 'group', plantScope: [muc.id] });
    // memberships come from Graph, the "groups" claim is ignored
    expect(fake.state.graphCalls.some((u) => u.includes(`/users/${U(2)}/transitiveMemberOf/microsoft.graph.group`))).toBe(true);

    // member of both groups: the highest role wins, its scope applies (all plants)
    const both = (await signInAs({ oid: U(6), preferred_username: 'both@example.com', name: 'Both' })).agent;
    expect((await both.get('/api/me').expect(200)).body.user).toMatchObject({ role: 'editor', roleSource: 'group', plantScope: [] });

    // an app role in the token wins over the group mapping
    const viaToken = (await signInAs({ oid: U(6), preferred_username: 'both@example.com', name: 'Both', roles: ['CMDB.Viewer'] })).agent;
    expect((await viaToken.get('/api/me').expect(200)).body.user).toMatchObject({ role: 'viewer', roleSource: 'entra' });

    // role and scope of group-managed users cannot be changed in the CMDB
    const users = (await admin.get('/api/users').expect(200)).body as { id: string; email: string; role_detail: string | null }[];
    const ottoRow = users.find((u) => u.email === 'otto@example.com')!;
    expect(ottoRow.role_detail).toBe('SG-CMDB-Operators-MUC');
    const res = await admin.put(`/api/users/${ottoRow.id}`, { role: 'admin', plant_scope: [], active: true }).expect(400);
    expect(res.body.error).toMatch(/group mapping/);
  });

  it('counts a group role as role when "only users with an app role" is on', async () => {
    await admin.put('/api/settings/entra', { requireAppRole: true }).expect(200);
    const rejected = await signInAs({ oid: U(11), preferred_username: 'nobody@example.com', name: 'Nobody' });
    expect(rejected.cb.status).toBe(403);
    expect(rejected.cb.text).toMatch(/not been assigned a role/);
    const ok = await signInAs({ oid: U(5), preferred_username: 'grace@example.com', name: 'Grace' });
    expect(ok.cb.headers.location).toBe('/');
    expect((await ok.agent.get('/api/me').expect(200)).body.user).toMatchObject({ role: 'operator', roleSource: 'group' });
    await admin.put('/api/settings/entra', { requireAppRole: false }).expect(200);
  });

  it('refuses the sign-in if group memberships cannot be read (fail closed), unless the token has an app role', async () => {
    // a user whose memberships are not cached yet (results are cached for 60 s)
    fake.state.graphError = { status: 403, code: 'Authorization_RequestDenied', path: '/users/' };
    const denied = await signInAs({ oid: U(7), preferred_username: 'olaf@example.com', name: 'Olaf' });
    expect(denied.cb.status).toBe(403);
    expect(denied.cb.text).toMatch(/could not be checked/);
    const withAppRole = await signInAs({ oid: U(12), preferred_username: 'ann@example.com', name: 'Ann', roles: ['CMDB.Editor'] });
    expect(withAppRole.cb.headers.location).toBe('/');
  });
});

describe('Entra directory (Graph, read-only)', () => {
  it('searches users and shows which ones are in the CMDB', async () => {
    const res = await admin.get('/api/entra/users?q=Lena').expect(200);
    expect(res.body.items).toEqual([expect.objectContaining({ id: U(1), displayName: 'Lena Local', cmdbRole: 'editor' })]);
    const search = fake.state.graphCalls.findLast((u) => u.includes('/users?'))!;
    expect(decodeURIComponent(search)).toContain('$search="displayName:Lena"');
  });

  it('retries when Graph throttles the request', async () => {
    fake.state.throttleOnce = true;
    const res = await admin.get('/api/entra/groups?q=Operators').expect(200);
    expect(res.body.items).toEqual([expect.objectContaining({ id: G_OPS, mappedRole: 'operator' })]);
  });

  it('lists group members', async () => {
    const res = await admin.get(`/api/entra/groups/${G_OPS}/members`).expect(200);
    expect(res.body.items.map((u: { id: string }) => u.id)).toEqual([U(2)]);
    await admin.get('/api/entra/groups/not-a-guid/members').expect(400);
  });

  it('adds an Entra user to the CMDB before the first sign-in', async () => {
    const cgn = plants.find((p) => p.code === 'CGN')!;
    await admin.post(`/api/entra/users/${U(3)}/provision`, { role: 'editor', plant_scope: [cgn.id] }).expect(201);
    await admin.post(`/api/entra/users/${U(3)}/provision`, { role: 'editor' }).expect(409);
    const { agent } = await signInAs({ oid: U(3), preferred_username: 'nina@example.com', name: 'Nina New' });
    expect((await agent.get('/api/me').expect(200)).body.user).toMatchObject({ role: 'editor', roleSource: 'local', plantScope: [cgn.id] });
  });

  it('says which permission is missing when Graph denies access', async () => {
    fake.state.graphError = { status: 403, code: 'Authorization_RequestDenied', path: '/servicePrincipals' };
    const res = await admin.get('/api/entra/app-role-assignments').expect(502);
    expect(res.body.error).toMatch(/Application\.Read\.All/);
    expect(res.body.error).toMatch(/admin consent/);
  });

  it('shows app role assignments of the enterprise application', async () => {
    fake.state.assignments = [
      { principalId: G_EDIT, principalType: 'Group', principalDisplayName: 'SG-CMDB-Editors', value: 'CMDB.Editor' },
      { principalId: U(1), principalType: 'User', principalDisplayName: 'Lena Local', value: 'CMDB.Admin' },
    ];
    const res = await admin.get('/api/entra/app-role-assignments').expect(200);
    expect(res.body).toEqual([
      expect.objectContaining({ principalType: 'Group', appRoleValue: 'CMDB.Editor', role: 'editor' }),
      expect.objectContaining({ principalType: 'User', appRoleValue: 'CMDB.Admin', role: 'admin' }),
    ]);
  });

  it('removes a group mapping', async () => {
    await admin.del(`/api/entra/group-roles/${G_EDIT}`).expect(204);
    await admin.del(`/api/entra/group-roles/${G_EDIT}`).expect(404);
  });
});

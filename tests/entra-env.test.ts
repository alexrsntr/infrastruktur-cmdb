import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../server/config';
import { encryptSecret } from '../server/lib/secrets';
import { setupTestApp } from './helpers';
import { CLIENT, TENANT, api, createFakeEntra, csrfOf, microsoftSignIn } from './fakeEntra';

/** Environment variables win over the configuration in the app; AUTH_MODE=entra behaves exactly as before. */

const ENV_SECRET = 'env-secret-value~never-returned';

describe('AUTH_MODE=entra (configured by environment variables)', () => {
  let app: Express;
  let pool: Pool;
  const fake = createFakeEntra();

  beforeAll(async () => {
    ({ app, pool } = await setupTestApp({
      authMode: 'entra',
      env: { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: ENV_SECRET, BOOTSTRAP_ADMINS: 'boss@example.com' },
      deps: fake.appDeps,
    }));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('offers only the Microsoft sign-in, without activation in the app', async () => {
    expect((await request(app).get('/api/public-config').expect(200)).body).toMatchObject({ authMode: 'entra', entraLogin: true, localLogin: 'none' });
    await request(app).post('/auth/local-login').send({ email: 'x@example.com', password: 'whatever pass' }).expect(404);
    await request(app).get('/auth/setup').expect(404);
  });

  it('signs in with the environment configuration (bootstrap admin, default role)', async () => {
    fake.state.nextIdentity = { oid: 'e0000000-0000-4000-8000-000000000001', preferred_username: 'boss@example.com', name: 'Boss' };
    const bossAgent = request.agent(app);
    expect((await microsoftSignIn(bossAgent)).headers.location).toBe('/');
    expect((await bossAgent.get('/api/me').expect(200)).body.user).toMatchObject({ role: 'admin' });
    expect(fake.state.configs.at(-1)).toMatchObject({ tenantId: TENANT, clientId: CLIENT, credential: 'secret', clientSecret: ENV_SECRET });

    fake.state.nextIdentity = { oid: 'e0000000-0000-4000-8000-000000000002', preferred_username: 'vera@example.com', name: 'Vera' };
    const vera = request.agent(app);
    await microsoftSignIn(vera);
    expect((await vera.get('/api/me').expect(200)).body.user).toMatchObject({ role: 'viewer', roleSource: 'local' });
    // every logout goes through Microsoft, as before
    expect((await vera.post('/auth/logout').expect(200)).body.logoutUrl).toContain(`login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`);

    // settings are read-only and never show the secret
    const boss = api(bossAgent, await csrfOf(bossAgent));
    const s = (await boss.get('/api/settings/entra').expect(200)).body;
    expect(s).toMatchObject({ source: 'env', enabled: true, configured: true, clientSecretSet: true, tenantId: TENANT, clientId: CLIENT });
    expect(s.locked).toMatchObject({ tenantId: true, clientId: true, clientSecret: true, credential: true, requireAppRole: true });
    expect(JSON.stringify(s)).not.toContain(ENV_SECRET);
    await boss.put('/api/settings/entra', { clientId: '55555555-5555-4555-8555-555555555555' }).expect(409);
    await boss.post('/api/settings/entra/deactivate').expect(409);
    await boss.put('/api/settings/entra/local-login', { mode: 'off' }).expect(400);
  });
});

describe('AUTH_MODE=local with some ENTRA_* variables set', () => {
  let app: Express;
  let pool: Pool;
  let config: Config;
  const fake = createFakeEntra();
  let admin: ReturnType<typeof api>;

  beforeAll(async () => {
    ({ app, pool, config } = await setupTestApp({ authMode: 'local', env: { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_SECRET: ENV_SECRET }, deps: fake.appDeps }));
    // values stored in the app – the tenant and the secret must be overridden by the environment
    await pool.query(`INSERT INTO app_setting (key, value) VALUES ('entra', $1)`, [
      JSON.stringify({ tenantId: '66666666-6666-4666-8666-666666666666', clientId: CLIENT, credential: 'secret', clientSecretEnc: encryptSecret(config, 'db secret value'), enabled: false }),
    ]);
    const agent = request.agent(app);
    await agent.post('/auth/setup').send({ display_name: 'Ada Admin', email: 'ada@example.com', password: 'admin password 1' }).expect(201);
    admin = api(agent, await csrfOf(agent));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('shows environment values read-only and uses them', async () => {
    const s = (await admin.get('/api/settings/entra').expect(200)).body;
    expect(s).toMatchObject({ source: 'database', tenantId: TENANT, clientId: CLIENT, configured: true, enabled: false });
    expect(s.locked).toMatchObject({ tenantId: true, clientSecret: true, clientId: false, requireAppRole: false });
    expect(s.clientSecretSetAt).toBeNull();
    await admin.post('/api/settings/entra/test').expect(200);
    expect(fake.state.configs.at(-1)).toMatchObject({ tenantId: TENANT, clientSecret: ENV_SECRET });
  });

  it('does not change values that are set by environment variables', async () => {
    const res = await admin.put('/api/settings/entra', { tenantId: '77777777-7777-4777-8777-777777777777' }).expect(400);
    expect(res.body.error).toMatch(/ENTRA_TENANT_ID/);
    await admin.put('/api/settings/entra', { clientSecret: 'another secret' }).expect(400);
    // other fields can still be changed in the app
    await admin.put('/api/settings/entra', { requireAppRole: true }).expect(200);
    expect((await admin.get('/api/settings/entra').expect(200)).body).toMatchObject({ tenantId: TENANT, requireAppRole: true });
  });
});

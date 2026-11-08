import pg from 'pg';
import request from 'supertest';
import type { Express } from 'express';
import { loadConfig } from '../server/config';
import { createPool } from '../server/db/pool';
import { migrate } from '../server/db/migrate';
import { seed } from '../server/db/seed';
import { createApp, type AppDeps } from '../server/app';

export async function setupTestApp(opts: { authMode?: 'dev' | 'local' | 'entra'; env?: Record<string, string>; deps?: AppDeps } = {}) {
  process.env.NODE_ENV = 'test';
  process.env.AUTH_MODE = opts.authMode ?? 'dev';
  process.env.DB_AUTH = 'password';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://cmdb:cmdb@localhost:5432/cmdb_test';
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123';
  // extra variables only for this configuration (e.g. ENTRA_*), removed again afterwards
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const config = loadConfig();
  for (const k of Object.keys(opts.env ?? {})) delete process.env[k];

  // Fresh schema for every test file
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await admin.end();

  const pool = createPool(config);
  await migrate(pool);
  await seed(pool);
  // tests never talk to Microsoft: without a fake, building an MSAL client fails loudly
  const deps: AppDeps = {
    ...opts.deps,
    entra: {
      clientFactory: () => {
        throw new Error('Test without fake MSAL client (pass deps: { entra: createFakeEntra().deps })');
      },
      fetch: async () => {
        throw new Error('Test without fake Microsoft Graph');
      },
      ...opts.deps?.entra,
    },
  };
  const app = createApp(pool, config, deps);
  return { app, pool, config };
}

export type Persona = 'admin' | 'editor' | 'operator' | 'viewer';

export interface Session {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  get: (url: string) => request.Test;
  post: (url: string, body?: object) => request.Test;
  put: (url: string, body?: object) => request.Test;
  patch: (url: string, body?: object) => request.Test;
  del: (url: string) => request.Test;
}

export async function login(app: Express, persona: Persona): Promise<Session> {
  const agent = request.agent(app);
  await agent.get(`/auth/dev-login?persona=${persona}`).expect(302);
  const me = await agent.get('/api/me').expect(200);
  const csrf = me.body.csrfToken as string;
  return {
    agent,
    csrf,
    get: (url) => agent.get(url),
    post: (url, body) => agent.post(url).set('x-csrf-token', csrf).send(body ?? {}),
    put: (url, body) => agent.put(url).set('x-csrf-token', csrf).send(body ?? {}),
    patch: (url, body) => agent.patch(url).set('x-csrf-token', csrf).send(body ?? {}),
    del: (url) => agent.delete(url).set('x-csrf-token', csrf),
  };
}

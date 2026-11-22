import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { setupTestApp } from './helpers';
import { LocalAccountError, setLocalPassword } from '../server/auth/localAccounts';

/** `cli.ts set-password`: the way back in when nobody can sign in any more. */

let app: Express;
let pool: Pool;

const ADMIN = { display_name: 'Ada Admin', email: 'ada.admin@example.local', password: 'correct horse battery' };
const NEW_PASSWORD = 'brand new password 42';

const login = (email: string, password: string) => request(app).post('/auth/local-login').send({ email, password });

beforeAll(async () => {
  ({ app, pool } = await setupTestApp({ authMode: 'local' }));
});

afterAll(async () => {
  await pool.end();
});

describe('set-password on the command line', () => {
  it('sets a new password, signs the account out everywhere and writes an audit entry', async () => {
    const agent = request.agent(app);
    await agent.post('/auth/setup').send(ADMIN).expect(201);
    await agent.get('/api/me').expect(200);

    // the e-mail address is case-insensitive, like at the sign-in
    const result = await setLocalPassword(pool, '  ADA.Admin@example.local ', NEW_PASSWORD);
    expect(result).toMatchObject({ displayName: ADMIN.display_name, email: ADMIN.email, role: 'admin', active: true });

    await agent.get('/api/me').expect(401);
    await login(ADMIN.email, ADMIN.password).expect(401);
    await login(ADMIN.email, NEW_PASSWORD).expect(200);

    const { rows } = await pool.query(`SELECT user_id, entity_id, entity_label, changes FROM audit_log WHERE action = 'user.password' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]).toMatchObject({ user_id: null, entity_id: result.id, entity_label: ADMIN.display_name, changes: { password: 'set on the command line' } });
  });

  it('refuses short passwords and unknown accounts without changing anything', async () => {
    const before = await pool.query(`SELECT password_hash FROM app_user WHERE email = $1`, [ADMIN.email]);
    const audits = await pool.query(`SELECT count(*) AS n FROM audit_log WHERE action = 'user.password'`);

    await expect(setLocalPassword(pool, ADMIN.email, 'too short')).rejects.toBeInstanceOf(LocalAccountError);
    await expect(setLocalPassword(pool, 'nobody@example.local', NEW_PASSWORD)).rejects.toThrow(/no account/);
    await expect(setLocalPassword(pool, '   ', NEW_PASSWORD)).rejects.toBeInstanceOf(LocalAccountError);

    const after = await pool.query(`SELECT password_hash FROM app_user WHERE email = $1`, [ADMIN.email]);
    expect(after.rows[0].password_hash).toBe(before.rows[0].password_hash);
    expect((await pool.query(`SELECT count(*) AS n FROM audit_log WHERE action = 'user.password'`)).rows[0].n).toBe(audits.rows[0].n);
    await login(ADMIN.email, NEW_PASSWORD).expect(200);
  });

  it('also works for an account that has never had a password', async () => {
    const admin = request.agent(app);
    await admin.post('/auth/local-login').send({ email: ADMIN.email, password: NEW_PASSWORD }).expect(200);
    const csrf = (await admin.get('/api/me').expect(200)).body.csrfToken as string;
    await admin
      .post('/api/users')
      .set('x-csrf-token', csrf)
      .send({ email: 'vic@example.local', display_name: 'Vic Viewer', role: 'viewer' })
      .expect(201);
    await login('vic@example.local', NEW_PASSWORD).expect(401);

    const result = await setLocalPassword(pool, 'vic@example.local', NEW_PASSWORD);
    expect(result).toMatchObject({ role: 'viewer', active: true });
    await login('vic@example.local', NEW_PASSWORD).expect(200);
  });
});

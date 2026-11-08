import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { setupTestApp } from './helpers';

let app: Express;
let pool: Pool;

const ADMIN = { display_name: 'Ada Admin', email: 'ada.admin@example.local', password: 'correct horse battery' };

async function signIn(email: string, password: string) {
  const agent = request.agent(app);
  await agent.post('/auth/local-login').send({ email, password }).expect(200);
  const me = await agent.get('/api/me').expect(200);
  const csrf = me.body.csrfToken as string;
  return {
    agent,
    me: me.body,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => agent.post(url).set('x-csrf-token', csrf).send(body ?? {}),
    put: (url: string, body?: object) => agent.put(url).set('x-csrf-token', csrf).send(body ?? {}),
  };
}

beforeAll(async () => {
  ({ app, pool } = await setupTestApp({ authMode: 'local' }));
});

afterAll(async () => {
  await pool.end();
});

describe('local accounts (AUTH_MODE=local)', () => {
  it('exposes the auth mode and offers the first-run setup', async () => {
    const cfg = await request(app).get('/api/public-config').expect(200);
    expect(cfg.body.authMode).toBe('local');
    const setup = await request(app).get('/auth/setup').expect(200);
    expect(setup.body).toEqual({ needsSetup: true });
    await request(app).get('/auth/dev-login?persona=admin').expect(404);
  });

  it('creates the first administrator exactly once', async () => {
    await request(app).post('/auth/setup').send({ ...ADMIN, password: 'short' }).expect(400);

    const agent = request.agent(app);
    await agent.post('/auth/setup').send(ADMIN).expect(201);
    const me = await agent.get('/api/me').expect(200);
    expect(me.body.user).toMatchObject({ displayName: ADMIN.display_name, email: ADMIN.email, role: 'admin' });

    expect((await request(app).get('/auth/setup').expect(200)).body).toEqual({ needsSetup: false });
    await request(app).post('/auth/setup').send({ ...ADMIN, email: 'intruder@example.local' }).expect(409);
  });

  it('signs in with the correct password only', async () => {
    const wrong = await request(app).post('/auth/local-login').send({ email: ADMIN.email, password: 'wrong password!' }).expect(401);
    expect(wrong.body.error).toMatch(/incorrect/);
    await request(app).post('/auth/local-login').send({ email: 'nobody@example.local', password: ADMIN.password }).expect(401);
    // e-mail address is case-insensitive
    const s = await signIn('ADA.Admin@example.local', ADMIN.password);
    expect(s.me.user.role).toBe('admin');
  });

  it('lets administrators create users with a password and never returns hashes', async () => {
    const admin = await signIn(ADMIN.email, ADMIN.password);
    await admin.post('/api/users', { email: 'ed@example.local', display_name: 'Ed Editor', role: 'editor', password: 'too short' }).expect(400);
    const created = await admin
      .post('/api/users', { email: 'ed@example.local', display_name: 'Ed Editor', role: 'editor', password: 'editor password 1' })
      .expect(201);
    expect(created.body).toMatchObject({ email: 'ed@example.local', role: 'editor', has_password: true });
    expect(created.body.password_hash).toBeUndefined();

    const list = await admin.get('/api/users').expect(200);
    expect(JSON.stringify(list.body)).not.toContain('scrypt$');
    const exported = await admin.get('/api/export/users?format=json').expect(200);
    expect(exported.text).not.toContain('scrypt$');
    expect(exported.text).not.toContain('password_hash');

    const ed = await signIn('ed@example.local', 'editor password 1');
    expect(ed.me.user).toMatchObject({ role: 'editor', displayName: 'Ed Editor' });
    await ed.get('/api/users').expect(403);
  });

  it('lets users change their own password', async () => {
    const ed = await signIn('ed@example.local', 'editor password 1');
    await ed.post('/api/me/password', { current_password: 'not my password', new_password: 'editor password 2' }).expect(400);
    await ed.post('/api/me/password', { current_password: 'editor password 1', new_password: 'short' }).expect(400);
    await ed.post('/api/me/password', { current_password: 'editor password 1', new_password: 'editor password 2' }).expect(200);
    await ed.get('/api/me').expect(200); // the current session stays signed in

    await request(app).post('/auth/local-login').send({ email: 'ed@example.local', password: 'editor password 1' }).expect(401);
    await signIn('ed@example.local', 'editor password 2');
  });

  it('signs a user out when an administrator resets the password, and blocks deactivated users', async () => {
    const admin = await signIn(ADMIN.email, ADMIN.password);
    const ed = await signIn('ed@example.local', 'editor password 2');
    const id = ed.me.user.id as string;

    await admin.put(`/api/users/${id}/password`, { password: 'reset by admin 1' }).expect(200);
    await ed.get('/api/me').expect(401);
    await signIn('ed@example.local', 'reset by admin 1');

    await admin.put(`/api/users/${id}`, { role: 'editor', plant_scope: [], active: false }).expect(200);
    await request(app).post('/auth/local-login').send({ email: 'ed@example.local', password: 'reset by admin 1' }).expect(403);
  });

  it('rate-limits repeated failed sign-ins', async () => {
    let status = 0;
    for (let i = 0; i < 12 && status !== 429; i++) {
      status = (await request(app).post('/auth/local-login').send({ email: ADMIN.email, password: `guess number ${i}` })).status;
    }
    expect(status).toBe(429);
  });
});

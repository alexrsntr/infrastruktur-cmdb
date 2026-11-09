import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../server/config';
import { dispatchWebhooks, MAX_ATTEMPTS, type FetchLike } from '../server/services/webhooks';
import { login, setupTestApp, type Session } from './helpers';

let app: Express;
let pool: Pool;
let config: Config;
let admin: Session;
let editor: Session;
let viewer: Session;
let muc: { id: string };
let ber: { id: string };

/** Fake webhook receiver: records requests, answers with the next queued status (default 200) */
const received: { url: string; headers: Record<string, string>; body: string }[] = [];
const answers: number[] = [];
const fakeFetch: FetchLike = async (url, init) => {
  received.push({ url, headers: init.headers, body: init.body });
  const status = answers.shift() ?? 200;
  return { status, text: async () => (status >= 400 ? 'nope' : 'ok') };
};

beforeAll(async () => {
  ({ app, pool, config } = await setupTestApp({ deps: { webhookFetch: fakeFetch } }));
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  const plants = (await viewer.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
  ber = plants.find((p) => p.code !== 'MUC')!;
});

afterAll(async () => {
  await pool.end();
});

const bearer = (token: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${token}`),
  post: (url: string, body?: object) => request(app).post(url).set('authorization', `Bearer ${token}`).send(body ?? {}),
  put: (url: string, body?: object) => request(app).put(url).set('authorization', `Bearer ${token}`).send(body ?? {}),
});

describe('API tokens', () => {
  let token: string;
  let tokenId: string;

  it('only administrators create tokens; the token is shown once', async () => {
    await editor.post('/api/settings/api-tokens', { name: 'Zabbix', role: 'operator' }).expect(403);
    const res = (await admin.post('/api/settings/api-tokens', { name: 'Inventory sync', role: 'editor', plant_scope: [muc.id], expires_in_days: 30 }).expect(201)).body;
    expect(res.token).toMatch(/^cmdb_[A-Za-z0-9_-]{40,}$/);
    expect(res).toMatchObject({ name: 'Inventory sync', role: 'editor', plant_scope: [muc.id] });
    expect(res.token.startsWith(res.token_prefix)).toBe(true);
    token = res.token;
    tokenId = res.id;
    const list = (await admin.get('/api/settings/api-tokens').expect(200)).body;
    expect(list[0]).not.toHaveProperty('token');
    expect(JSON.stringify(list)).not.toContain(token);
    await admin.post('/api/settings/api-tokens', { name: 'inventory sync', role: 'viewer' }).expect(409);
    // service users are not listed as people
    expect((await admin.get('/api/users').expect(200)).body.map((u: { display_name: string }) => u.display_name)).not.toContain('API: Inventory sync');
  });

  it('authenticates without session and CSRF token, with the role and plant scope of the token', async () => {
    const api = bearer(token);
    const created = (await api.post('/api/assets', { type: 'switch', name: 'api-sw01', plant_id: muc.id }).expect(201)).body;
    expect(created.name).toBe('api-sw01');
    await api.post('/api/assets', { type: 'switch', name: 'api-sw02', plant_id: ber.id }).expect(403);
    const list = (await api.get('/api/assets?pageSize=500').expect(200)).body.items as { plant_id: string }[];
    expect(list.every((a) => a.plant_id === muc.id)).toBe(true);
    // an editor token cannot manage settings, and no token can create tokens
    await api.get('/api/settings/api-tokens').expect(403);
    const history = (await viewer.get(`/api/history?entityType=asset&entityId=${created.id}`).expect(200)).body;
    expect(history[0].user_name).toBe('API: Inventory sync');
    const tokens = (await admin.get('/api/settings/api-tokens').expect(200)).body;
    expect(tokens.find((t: { id: string }) => t.id === tokenId).last_used_at).not.toBeNull();
  });

  it('rejects unknown, malformed and revoked tokens', async () => {
    await bearer('cmdb_wrong').get('/api/assets').expect(401);
    await bearer('something-else').get('/api/assets').expect(401);
    await admin.del(`/api/settings/api-tokens/${tokenId}`).expect(204);
    await bearer(token).get('/api/assets').expect(401);
    const adminToken = (await admin.post('/api/settings/api-tokens', { name: 'Admin automation', role: 'admin' }).expect(201)).body.token;
    await bearer(adminToken).post('/api/settings/api-tokens', { name: 'Sneaky', role: 'admin' }).expect(403);
    await pool.query(`UPDATE api_token SET expires_at = now() - interval '1 minute' WHERE name = 'Admin automation'`);
    await bearer(adminToken).get('/api/assets').expect(401);
  });
});

describe('webhooks', () => {
  let hookId: string;
  let secret: string;

  it('delivers signed events from the outbox, in the same transaction as the change', async () => {
    await editor.post('/api/assets', { type: 'switch', name: 'wh-before', plant_id: muc.id }).expect(201);
    expect((await pool.query('SELECT count(*)::int AS n FROM event_outbox')).rows[0].n).toBe(0); // no webhook yet → nothing stored

    await admin.post('/api/settings/webhooks', { name: 'Bad', url: 'ftp://example.com', events: ['*'] }).expect(400);
    const hook = (await admin.post('/api/settings/webhooks', { name: 'ITSM', url: 'https://itsm.example.com/hook', events: ['asset.create', 'asset.monitoring'] }).expect(201)).body;
    hookId = hook.id;
    secret = hook.secret;
    expect(secret).toMatch(/^whsec_/);
    expect((await admin.get('/api/settings/webhooks').expect(200)).body[0]).not.toHaveProperty('secret');

    const sw = (await editor.post('/api/assets', { type: 'switch', name: 'wh-sw01', plant_id: muc.id }).expect(201)).body;
    await editor.put(`/api/assets/${sw.id}`, { type: 'switch', name: 'wh-sw01', plant_id: muc.id, model: 'X' }).expect(200); // asset.update – not subscribed
    // a failing request inside a transaction leaves no event behind
    await editor.post('/api/assets', { type: 'switch', name: 'wh-sw01', plant_id: muc.id }).expect(409);

    const r = await dispatchWebhooks(pool, config, fakeFetch);
    expect(r).toMatchObject({ fannedOut: 1, delivered: 1 });
    expect(received).toHaveLength(1);
    const req = received[0];
    expect(req.url).toBe('https://itsm.example.com/hook');
    expect(req.headers['x-cmdb-event']).toBe('asset.create');
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${req.headers['x-cmdb-timestamp']}.${req.body}`).digest('hex')}`;
    expect(req.headers['x-cmdb-signature']).toBe(expected);
    expect(JSON.parse(req.body)).toMatchObject({ event: 'asset.create', entity_id: sw.id, entity_label: 'wh-sw01', user: expect.any(String) });
  });

  it('retries with back-off and gives up after the last attempt', async () => {
    received.length = 0;
    const sw = (await editor.post('/api/assets', { type: 'switch', name: 'wh-sw02', plant_id: muc.id }).expect(201)).body;
    answers.push(500, 503);
    let now = new Date();
    await dispatchWebhooks(pool, config, fakeFetch, now);
    let d = (await admin.get(`/api/settings/webhooks/${hookId}/deliveries`).expect(200)).body[0];
    expect(d).toMatchObject({ status: 'pending', attempts: 1, response_status: 500 });
    // not due yet
    await dispatchWebhooks(pool, config, fakeFetch, new Date(now.getTime() + 10_000));
    expect(received).toHaveLength(1);
    now = new Date(now.getTime() + 31_000);
    await dispatchWebhooks(pool, config, fakeFetch, now);
    expect(received).toHaveLength(2);
    now = new Date(now.getTime() + 61_000);
    await dispatchWebhooks(pool, config, fakeFetch, now);
    d = (await admin.get(`/api/settings/webhooks/${hookId}/deliveries`).expect(200)).body[0];
    expect(d).toMatchObject({ status: 'ok', attempts: 3 });
    expect(JSON.parse(received[2].body).entity_id).toBe(sw.id);

    // permanent failure
    await editor.post('/api/assets', { type: 'switch', name: 'wh-sw03', plant_id: muc.id }).expect(201);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      answers.push(500);
      now = new Date(now.getTime() + 3_600_000);
      await dispatchWebhooks(pool, config, fakeFetch, now);
    }
    d = (await admin.get(`/api/settings/webhooks/${hookId}/deliveries`).expect(200)).body[0];
    expect(d).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect((await admin.get('/api/settings/webhooks').expect(200)).body[0]).toMatchObject({ failed: 1 });
    await admin.post(`/api/settings/webhooks/${hookId}/deliveries/${d.id}/retry`).expect(204);
    await dispatchWebhooks(pool, config, fakeFetch, now);
    expect((await admin.get(`/api/settings/webhooks/${hookId}/deliveries`).expect(200)).body[0]).toMatchObject({ status: 'ok' });
  });

  it('sends a test ping and can rotate the secret', async () => {
    received.length = 0;
    const res = (await admin.post(`/api/settings/webhooks/${hookId}/test`).expect(200)).body;
    expect(res).toEqual({ ok: true, status: 200, error: null });
    expect(received[0].headers['x-cmdb-event']).toBe('ping');
    const rotated = (await admin.post(`/api/settings/webhooks/${hookId}/secret`).expect(200)).body.secret;
    expect(rotated).not.toBe(secret);
  });
});

describe('external references and monitoring', () => {
  it('links tickets to devices and finds devices by ticket', async () => {
    const sw = (await editor.post('/api/assets', { type: 'switch', name: 'ref-sw01', plant_id: muc.id }).expect(201)).body;
    const operator = await login(app, 'operator');
    await operator.post(`/api/assets/${sw.id}/refs`, { system: 'Jira', ref: 'NET-42', url: 'https://jira.example.com/browse/NET-42', title: 'Replace PSU', status: 'Open' }).expect(201);
    await operator.post(`/api/assets/${sw.id}/refs`, { system: 'jira', ref: 'net-42', title: 'Replace PSU', status: 'Done' }).expect(201); // upsert
    await operator.post(`/api/assets/${sw.id}/refs`, { system: 'Jira', ref: 'X', url: 'javascript:alert(1)' }).expect(400);
    await viewer.post(`/api/assets/${sw.id}/refs`, { system: 'Jira', ref: 'NET-43' }).expect(403);
    const refs = (await viewer.get(`/api/assets/${sw.id}/refs`).expect(200)).body;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ system: 'Jira', ref: 'NET-42', status: 'Done' });
    const found = (await viewer.get('/api/refs?system=JIRA&ref=NET-42').expect(200)).body;
    expect(found.map((x: { asset_name: string }) => x.asset_name)).toEqual(['ref-sw01']);
    await operator.del(`/api/refs/${refs[0].id}`).expect(204);
  });

  it('accepts monitoring results per device and in bulk (by id, name or IP)', async () => {
    const a = (await editor.post('/api/assets', { type: 'switch', name: 'mon-a', plant_id: muc.id, ip_address: '10.99.0.1' }).expect(201)).body;
    const b = (await editor.post('/api/assets', { type: 'switch', name: 'mon-b', plant_id: muc.id, fqdn: 'mon-b.example.local' }).expect(201)).body;
    const token = (await admin.post('/api/settings/api-tokens', { name: 'Zabbix', role: 'operator' }).expect(201)).body.token;
    const api = bearer(token);
    await api.put(`/api/assets/${a.id}/monitoring`, { status: 'down', message: 'ICMP timeout' }).expect(204);
    let detail = (await viewer.get(`/api/assets/${a.id}`).expect(200)).body;
    expect(detail).toMatchObject({ monitoring_status: 'down', monitoring_message: 'ICMP timeout', monitoring_source: 'Zabbix', last_seen_at: null });

    const res = (
      await api
        .post('/api/monitoring', {
          source: 'zabbix-prod',
          items: [
            { ip: '10.99.0.1', status: 'up' },
            { name: 'MON-B.example.local', status: 'warning', message: 'CPU 92 %' },
            { name: 'does-not-exist', status: 'up' },
          ],
        })
        .expect(200)
    ).body;
    expect(res).toEqual({ updated: 2, unmatched: ['does-not-exist'], ambiguous: [] });
    detail = (await viewer.get(`/api/assets/${a.id}`).expect(200)).body;
    expect(detail).toMatchObject({ monitoring_status: 'up', monitoring_source: 'zabbix-prod' });
    expect(detail.last_seen_at).not.toBeNull();
    expect((await viewer.get(`/api/assets/${b.id}`).expect(200)).body.monitoring_status).toBe('warning');

    // only changes are written to the history
    await api.put(`/api/assets/${a.id}/monitoring`, { status: 'up' }).expect(204);
    const history = (await viewer.get(`/api/history?entityType=asset&entityId=${a.id}`).expect(200)).body.filter((h: { action: string }) => h.action === 'monitoring');
    expect(history).toHaveLength(2);
    await bearer(token).put(`/api/assets/${a.id}`, { type: 'switch', name: 'mon-a' }).expect(403); // operator token
  });
});

describe('event filters', () => {
  it('match entity events and actions on any object', async () => {
    const { eventMatches } = await import('../shared/integrations');
    expect(eventMatches(['*'], 'asset.create')).toBe(true);
    expect(eventMatches(['asset.*'], 'asset.port.connect')).toBe(true);
    expect(eventMatches(['asset.update'], 'asset.create')).toBe(false);
    expect(eventMatches(['activity.*'], 'asset.activity.add')).toBe(true);
    expect(eventMatches(['activity.*'], 'plant.activity.update')).toBe(true);
    expect(eventMatches(['activity.*'], 'asset.update')).toBe(false);
    expect(eventMatches(['plant.*'], 'asset.create')).toBe(false);
  });
});

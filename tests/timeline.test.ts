import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';

let app: Express;
let pool: Pool;
let editor: Session;
let operator: Session;
let viewer: Session;

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  editor = await login(app, 'editor');
  operator = await login(app, 'operator');
  viewer = await login(app, 'viewer');
});

afterAll(async () => {
  await pool.end();
});

describe('activity log', () => {
  it('merges notes, activities and changes of a device, newest first', async () => {
    const sw = (await editor.get('/api/assets?q=muc-core-sw01').expect(200)).body.items[0];
    await editor.put(`/api/assets/${sw.id}`, { ...sw, model: 'Catalyst 9500-48Y4C (refurbished)' }).expect(200);
    await operator.post('/api/notes', { entity_type: 'asset', entity_id: sw.id, body: 'Fan noise checked – OK' }).expect(201);
    await operator.post('/api/activities', { entity_type: 'asset', entity_id: sw.id, kind: 'maintenance', status: 'done', title: 'Replaced PSU 2' }).expect(201);

    const log = (await viewer.get(`/api/timeline?entityType=asset&entityId=${sw.id}`).expect(200)).body;
    expect(log.slice(0, 3).map((e: { kind: string }) => e.kind)).toEqual(['activity', 'note', 'change']);
    expect(log[0]).toMatchObject({ title: 'Replaced PSU 2', activity_kind: 'maintenance', activity_status: 'done', user_name: expect.stringMatching(/Olga/) });
    expect(log[1].body).toBe('Fan noise checked – OK');
    expect(log[2].changes.model.to).toContain('refurbished');
    // no duplicate audit rows for the note/activity
    expect(log.filter((e: { action: string | null }) => e.action === 'note.add' || e.action === 'activity.add')).toEqual([]);
  });

  it('shows the last activity in device lists', async () => {
    const list = (await viewer.get('/api/assets?q=muc-core-sw01').expect(200)).body.items[0];
    expect(list.last_activity).toBe('Maintenance: Replaced PSU 2');
    expect(list.last_activity_by).toMatch(/Olga/);
    const sorted = (await viewer.get('/api/assets?sort=last_activity&order=desc&pageSize=1').expect(200)).body.items[0];
    expect(sorted.name).toBe('muc-core-sw01');
  });

  it('provides a scoped global feed', async () => {
    const all = (await viewer.get('/api/timeline?limit=10').expect(200)).body;
    expect(all[0]).toMatchObject({ kind: 'activity', entity_type: 'asset', entity_label: 'muc-core-sw01' });
    const hamAsset = (await editor.get('/api/assets?q=ham-core-sw01').expect(200)).body.items[0];
    await editor.post('/api/notes', { entity_type: 'asset', entity_id: hamAsset.id, body: 'HAM only' }).expect(201);
    const muc = (await operator.get('/api/timeline?limit=50').expect(200)).body;
    expect(muc.some((e: { body: string | null }) => e.body === 'HAM only')).toBe(false);
    await operator.get(`/api/timeline?entityType=asset&entityId=${hamAsset.id}`).expect(403);
  });
});

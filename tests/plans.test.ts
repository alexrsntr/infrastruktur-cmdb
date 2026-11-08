import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';
import { drawFloorPlan, OFFICE_LAYOUT } from '../server/db/floorplan';

let app: Express;
let pool: Pool;
let admin: Session;
let editor: Session;
let operator: Session;
let viewer: Session;
let muc: { id: string };
let ham: { id: string };
let mucPlan: string;
let hamPlan: string;
let photo: string;

/** Creates an image attachment directly in the database (independent of the upload route). */
async function createImage(entityType: string, entityId: string, plantId: string | null, opts: { isPlan: boolean; title: string }) {
  const png = drawFloorPlan(400, 250, OFFICE_LAYOUT.slice(0, 2));
  const key = `${plantId ?? 'global'}/${crypto.randomUUID()}/site.png`;
  await pool.query('INSERT INTO file_blob (storage_key, data) VALUES ($1, $2)', [key, png]);
  const { rows } = await pool.query(
    `INSERT INTO attachment (entity_type, entity_id, plant_id, file_name, content_type, size_bytes, sha256, storage_key, category, title, image_width, image_height, is_plan)
     VALUES ($1,$2,$3,'site.png','image/png',$4,$5,$6,'plan',$7,400,250,$8) RETURNING id`,
    [entityType, entityId, plantId, png.length, crypto.createHash('sha256').update(png).digest('hex'), key, opts.title, opts.isPlan],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  operator = await login(app, 'operator');
  viewer = await login(app, 'viewer');
  const plants = (await admin.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
  ham = plants.find((p) => p.code === 'HAM')!;
  mucPlan = await createImage('plant', muc.id, muc.id, { isPlan: true, title: 'Aerial view MUC' });
  hamPlan = await createImage('plant', ham.id, ham.id, { isPlan: true, title: 'Site plan HAM' });
  photo = await createImage('plant', muc.id, muc.id, { isPlan: false, title: 'Just a photo' });
});

afterAll(async () => {
  await pool.end();
});

describe('plans & markers', () => {
  let apId: string;
  let markerId: string;

  it('lists the plans of a plant (only images flagged as plan)', async () => {
    const res = await viewer.get(`/api/plans?plantId=${muc.id}`).expect(200);
    const ids = res.body.map((p: { id: string }) => p.id);
    expect(ids).toContain(mucPlan);
    expect(ids).not.toContain(photo); // a normal photo is not a plan
    expect(ids).not.toContain(hamPlan);
    const mine = res.body.find((p: { id: string }) => p.id === mucPlan);
    expect(mine).toMatchObject({ title: 'Aerial view MUC', entity_type: 'plant', marker_count: 0, image_width: 400 });
    expect(mine.entity_label).toContain('MUC');
    // the demo seed ships a site plan with buildings, outdoor APs and labels
    const seeded = res.body.find((p: { title: string }) => p.title === 'Site plan Munich (demo)');
    expect(seeded.marker_count).toBe(8);
  });

  it('places devices, buildings and labels on a plan', async () => {
    apId = (await editor.get(`/api/assets?plantId=${muc.id}&type=access_point&pageSize=1`).expect(200)).body.items[0].id;
    const plant = (await editor.get(`/api/plants/${muc.id}`).expect(200)).body;
    const ap = await editor.post(`/api/plans/${mucPlan}/markers`, { asset_id: apId, x: 0.25, y: 0.5 }).expect(201);
    markerId = ap.body.id;
    expect(ap.body).toMatchObject({ asset_id: apId, asset_type: 'access_point', x: 0.25, y: 0.5 });
    await editor.post(`/api/plans/${mucPlan}/markers`, { building_id: plant.buildings[0].id, x: 0.6, y: 0.4 }).expect(201);
    await editor.post(`/api/plans/${mucPlan}/markers`, { label: 'Gate 2', x: 0.9, y: 0.9 }).expect(201);

    const detail = (await viewer.get(`/api/plans/${mucPlan}`).expect(200)).body;
    expect(detail.markers).toHaveLength(3);
    expect(detail.markers.map((m: { building_name: string | null; label: string | null; asset_name: string | null }) => m.asset_name ?? m.building_name ?? m.label)).toContain('Gate 2');
  });

  it('validates markers', async () => {
    await editor.post(`/api/plans/${mucPlan}/markers`, { asset_id: apId, x: 0.1, y: 0.1 }).expect(409); // already on this plan
    await editor.post(`/api/plans/${mucPlan}/markers`, { x: 0.1, y: 0.1 }).expect(400);
    await editor.post(`/api/plans/${mucPlan}/markers`, { label: 'x', building_id: null, asset_id: apId, x: 0.1, y: 0.1 }).expect(400);
    await editor.post(`/api/plans/${mucPlan}/markers`, { label: 'x', x: 1.5, y: 0.1 }).expect(400);
    const hamAp = (await admin.get(`/api/assets?plantId=${ham.id}&type=access_point&pageSize=1`).expect(200)).body.items[0].id;
    const other = await editor.post(`/api/plans/${mucPlan}/markers`, { asset_id: hamAp, x: 0.1, y: 0.1 }).expect(400);
    expect(other.body.error).toMatch(/another plant/);
    await editor.post(`/api/plans/${photo}/markers`, { label: 'x', x: 0.1, y: 0.1 }).expect(404); // not a plan
  });

  it('moves and removes markers; only editors may change them', async () => {
    await operator.patch(`/api/plan-markers/${markerId}`, { x: 0.3, y: 0.3 }).expect(403);
    await viewer.post(`/api/plans/${mucPlan}/markers`, { label: 'nope', x: 0.5, y: 0.5 }).expect(403);
    const moved = await editor.patch(`/api/plan-markers/${markerId}`, { x: 0.3, y: 0.35 }).expect(200);
    expect(moved.body).toMatchObject({ x: 0.3, y: 0.35 });
    const history = (await viewer.get(`/api/history?entityType=asset&entityId=${apId}`).expect(200)).body;
    expect(history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['plan.marker.add', 'plan.marker.move']));

    const label = (await viewer.get(`/api/plans/${mucPlan}`).expect(200)).body.markers.find((m: { label: string | null }) => m.label);
    const renamed = await editor.patch(`/api/plan-markers/${label.id}`, { x: label.x, y: label.y, label: 'Gate 2 (trucks)' }).expect(200);
    expect(renamed.body.label).toBe('Gate 2 (trucks)');
    await editor.patch(`/api/plan-markers/${markerId}`, { x: 0.3, y: 0.35, label: 'not allowed' }).expect(400);
  });

  it('shows the plans a device is on', async () => {
    const res = await viewer.get(`/api/assets/${apId}/plans`).expect(200);
    expect(res.body).toEqual([expect.objectContaining({ id: mucPlan, title: 'Aerial view MUC' })]);
  });

  it('respects plant scope', async () => {
    const list = (await operator.get('/api/plans').expect(200)).body;
    expect(list.every((p: { plant_id: string }) => p.plant_id === muc.id)).toBe(true);
    expect(list.map((p: { id: string }) => p.id)).toContain(mucPlan);
    await operator.get(`/api/plans/${hamPlan}`).expect(403);
    await operator.get(`/api/plans/${mucPlan}`).expect(200);
  });

  it('removes markers when the device is deleted', async () => {
    const tmp = (await editor.post('/api/assets', { type: 'access_point', name: 'muc-ap-plan-tmp', plant_id: muc.id }).expect(201)).body;
    await editor.post(`/api/plans/${mucPlan}/markers`, { asset_id: tmp.id, x: 0.7, y: 0.7 }).expect(201);
    await editor.del(`/api/assets/${tmp.id}`).expect(204);
    const detail = (await viewer.get(`/api/plans/${mucPlan}`).expect(200)).body;
    expect(detail.markers.some((m: { asset_id: string }) => m.asset_id === tmp.id)).toBe(false);
    const del = (await viewer.get(`/api/plans/${mucPlan}`).expect(200)).body.markers.find((m: { label: string | null }) => m.label);
    await editor.del(`/api/plan-markers/${del.id}`).expect(204);
    expect((await viewer.get(`/api/plans/${mucPlan}`).expect(200)).body.markers).toHaveLength(2);
  });
});

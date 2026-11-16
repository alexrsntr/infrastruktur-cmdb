import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';

/** Local administrators: only their plants, change existing entries, never add or delete. */
let app: Express;
let pool: Pool;
let admin: Session;
let local: Session;
let muc: { id: string };
let ham: { id: string };

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  admin = await login(app, 'admin');
  local = await login(app, 'local');
  const plants = (await admin.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
  ham = plants.find((p) => p.code === 'HAM')!;
});

afterAll(async () => {
  await pool.end();
});

describe('local administrator', () => {
  it('has the role, edit permissions and sees only the assigned plant', async () => {
    const me = (await local.get('/api/me').expect(200)).body;
    expect(me.user.role).toBe('local_admin');
    expect(me.user.plantScope).toEqual([muc.id]);
    expect(me.permissions).toEqual(expect.arrayContaining(['asset.edit', 'location.edit', 'note.write', 'asset.status']));
    expect(me.permissions).not.toContain('asset.write');
    expect(me.permissions).not.toContain('asset.delete');
    expect(me.permissions).not.toContain('location.write');
    expect(me.permissions).not.toContain('scorecard.manage');

    const plants = (await local.get('/api/plants').expect(200)).body as { code: string }[];
    expect(plants.map((p) => p.code)).toEqual(['MUC']);
    await local.get(`/api/plants/${ham.id}`).expect(403);
  });

  it('changes existing devices, plants and buildings of the plant', async () => {
    const list = (await local.get(`/api/assets?plantId=${muc.id}&pageSize=1`).expect(200)).body;
    const asset = (await local.get(`/api/assets/${list.items[0].id}`).expect(200)).body;
    const changed = (await local.put(`/api/assets/${asset.id}`, { ...asset, description: 'Checked by the local IT' }).expect(200)).body;
    expect(changed.description).toBe('Checked by the local IT');

    const plant = (await local.get(`/api/plants/${muc.id}`).expect(200)).body;
    await local.put(`/api/plants/${muc.id}`, { ...plant, contact: 'Lars Local Admin' }).expect(200);
    const b = plant.buildings[0];
    await local.put(`/api/buildings/${b.id}`, { plant_id: muc.id, code: b.code, name: b.name, description: 'Updated locally' }).expect(200);
  });

  it('cannot add or delete anything', async () => {
    await local.post('/api/assets', { type: 'switch', name: 'muc-sw-new', plant_id: muc.id }).expect(403);
    await local.post('/api/buildings', { plant_id: muc.id, code: 'NEW', name: 'New hall' }).expect(403);
    await local.post('/api/plants', { code: 'NEW', name: 'New plant' }).expect(403);
    await local.post('/api/applications', { name: 'New app', plant_id: muc.id }).expect(403);
    const list = (await local.get(`/api/assets?plantId=${muc.id}&pageSize=1`).expect(200)).body;
    await local.del(`/api/assets/${list.items[0].id}`).expect(403);
    const plant = (await local.get(`/api/plants/${muc.id}`).expect(200)).body;
    await local.del(`/api/buildings/${plant.buildings[0].id}`).expect(403);
  });

  it('cannot change entries of other plants', async () => {
    const list = (await admin.get(`/api/assets?plantId=${ham.id}&pageSize=1`).expect(200)).body;
    const asset = (await admin.get(`/api/assets/${list.items[0].id}`).expect(200)).body;
    const res = await local.put(`/api/assets/${asset.id}`, { ...asset, description: 'not mine' });
    expect([403, 404]).toContain(res.status);
  });

  it('needs at least one plant – without one it sees nothing', async () => {
    const res = await admin.post('/api/users', { email: 'nina.local@example.local', display_name: 'Nina Local', role: 'local_admin', plant_scope: [] }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/at least one plant/);
    const created = (await admin.post('/api/users', { email: 'nina.local@example.local', display_name: 'Nina Local', role: 'local_admin', plant_scope: [ham.id] }).expect(201)).body;
    await admin.put(`/api/users/${created.id}`, { role: 'local_admin', plant_scope: [], active: true }).expect(400);

    // even if the scope gets lost (e.g. set directly in the database), an empty scope never means "all plants"
    const me = (await local.get('/api/me').expect(200)).body;
    await pool.query(`UPDATE app_user SET plant_scope = '{}' WHERE id = $1`, [me.user.id]);
    expect((await local.get('/api/plants').expect(200)).body).toEqual([]);
    expect((await local.get('/api/assets').expect(200)).body.total).toBe(0);
    await pool.query(`UPDATE app_user SET plant_scope = $2::uuid[] WHERE id = $1`, [me.user.id, [muc.id]]);
  });
});

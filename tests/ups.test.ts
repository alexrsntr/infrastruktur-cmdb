import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';

let app: Express;
let pool: Pool;
let editor: Session;
let viewer: Session;
let muc: { id: string };

const find = async (s: Session, name: string) =>
  (await s.get(`/api/assets?q=${encodeURIComponent(name)}`).expect(200)).body.items.find((a: { name: string }) => a.name === name);

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  editor = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  const plants = (await viewer.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
});

afterAll(async () => {
  await pool.end();
});

describe('UPS (uninterruptible power supply)', () => {
  it('is seeded at the bottom of the server rack and powers the core switch and the hosts', async () => {
    const ups = await find(viewer, 'muc-ups01');
    expect(ups).toMatchObject({ type: 'ups', rack_u: 1, rack_height_u: 4, plant_code: 'MUC' });
    const detail = (await viewer.get(`/api/assets/${ups.id}`).expect(200)).body;
    expect(detail.attributes).toMatchObject({ capacity_va: 6000, topology: 'Online (double conversion)', phases: '1-phase' });
    const powers = detail.relations.filter((r: { relation: string; direction: string }) => r.relation === 'powered_by' && r.direction === 'in');
    expect(powers.map((r: { other_name: string }) => r.other_name)).toEqual(expect.arrayContaining(['muc-core-sw01', 'muc-esx01', 'muc-esx04']));
    expect(powers).toHaveLength(5);

    const list = (await viewer.get(`/api/assets?type=ups&plantId=${muc.id}`).expect(200)).body;
    expect(list.items.every((a: { type: string }) => a.type === 'ups')).toBe(true);
  });

  it('can be created, mounted in a rack and linked with "powered by"', async () => {
    const created = (
      await editor
        .post('/api/assets', {
          type: 'ups',
          name: 'muc-ups-test',
          plant_id: muc.id,
          manufacturer: 'Eaton',
          model: '9PX 3000i RT2U',
          attributes: { form_factor: 'Rack', capacity_va: 3000, capacity_w: 3000, battery_replace_due: '2029-06-30' },
        })
        .expect(201)
    ).body;
    expect(created).toMatchObject({ type: 'ups', name: 'muc-ups-test' });
    expect(created.attributes).toMatchObject({ capacity_va: 3000, battery_replace_due: '2029-06-30' });

    const server = await find(viewer, 'muc-esx02');
    const rel = await editor.post('/api/relations', { source_id: server.id, target_id: created.id, relation: 'powered_by' }).expect(201);
    const detail = (await viewer.get(`/api/assets/${server.id}`).expect(200)).body;
    expect(detail.relations).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'powered_by', direction: 'out', other_name: 'muc-ups-test' })]));
    await editor.del(`/api/relations/${rel.body.id}`).expect(204);
  });

  it('is part of exports and can be imported', async () => {
    const exported = await viewer.get('/api/export/assets?format=json&type=ups').expect(200);
    const rows = JSON.parse(exported.text);
    const data = Array.isArray(rows) ? rows : rows.data ?? rows.items ?? Object.values(rows)[0];
    expect(JSON.stringify(data)).toContain('muc-ups01');

    const csv = ['Type;Name;Plant;Building;Capacity (VA);Phases;Battery replacement due', 'UPS;muc-ups-import;MUC;DC;1500;1-phase;31.12.2028'].join('\n');
    const res = await editor.agent
      .post('/api/import/assets?dryRun=false')
      .set('x-csrf-token', editor.csrf)
      .attach('file', Buffer.from(csv), 'ups.csv')
      .expect(200);
    expect(res.body).toMatchObject({ created: 1 });
    expect(res.body.errors).toEqual([]);
    const imported = await find(viewer, 'muc-ups-import');
    const detail = (await viewer.get(`/api/assets/${imported.id}`).expect(200)).body;
    expect(detail).toMatchObject({ type: 'ups', building_code: 'DC' });
    expect(detail.attributes).toMatchObject({ capacity_va: 1500, phases: '1-phase', battery_replace_due: '2028-12-31' });
  });
});

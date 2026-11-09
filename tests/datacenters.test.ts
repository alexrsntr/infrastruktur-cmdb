import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { DatacenterDetail, DatacenterSummary } from '../shared/datacenters';
import { login, setupTestApp, type Session } from './helpers';

let app: Express;
let pool: Pool;
let admin: Session;
let editor: Session;
let operator: Session;
let viewer: Session;
let muc: { id: string };
let ham: { id: string };
let mucBuildings: { id: string; code: string }[];
let hamBuildings: { id: string; code: string }[];
let seeded: DatacenterSummary;

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  operator = await login(app, 'operator');
  viewer = await login(app, 'viewer');
  const plants = (await admin.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
  ham = plants.find((p) => p.code === 'HAM')!;
  mucBuildings = (await admin.get(`/api/plants/${muc.id}`).expect(200)).body.buildings;
  hamBuildings = (await admin.get(`/api/plants/${ham.id}`).expect(200)).body.buildings;
});

afterAll(async () => {
  await pool.end();
});

const bld = (list: { id: string; code: string }[], code: string) => list.find((b) => b.code === code)!.id;

describe('data centers', () => {
  it('lists the seeded stretched data center with its two sites', async () => {
    const res = await viewer.get(`/api/datacenters?plantId=${muc.id}`).expect(200);
    expect(res.body).toHaveLength(1);
    seeded = res.body[0];
    expect(seeded).toMatchObject({ name: 'DC Munich', kind: 'stretched', plant_code: 'MUC', link_count: 2 });
    expect(seeded.sites.map((s) => [s.name, s.role, s.building_code, s.room, s.rack_count])).toEqual([
      ['Site A', 'primary', 'DC', 'Server room', 2],
      ['Site B', 'secondary', 'B01', 'Server room 2', 2],
    ]);
    // R01 (core) + R02 (4 hosts + UPS) in site A, R11 (core 2) + R12 (2 hosts) in site B
    expect(seeded.sites.map((s) => s.device_count)).toEqual([6, 3]);
  });

  it('returns the diagram data: racks, devices, cross-site connections and the stretched cluster', async () => {
    const d = (await viewer.get(`/api/datacenters/${seeded.id}`).expect(200)).body as DatacenterDetail;
    const [a, b] = d.sites;
    expect(a.racks.map((r) => r.name)).toEqual(['R01', 'R02']);
    expect(b.racks.map((r) => r.name)).toEqual(['R11', 'R12']);
    const names = (site: typeof a) => site.racks.flatMap((r) => r.devices.map((x) => x.name));
    expect(names(a)).toEqual(expect.arrayContaining(['muc-core-sw01', 'muc-esx01', 'muc-esx04']));
    expect(names(b)).toEqual(expect.arrayContaining(['muc-core-sw02', 'muc-esx05', 'muc-esx06']));

    const all = d.sites.flatMap((s) => s.racks.flatMap((r) => r.devices));
    const id = (n: string) => all.find((x) => x.name === n)!.id;
    const cross = d.connections.filter((c) => c.source_site_id !== c.target_site_id);
    expect(cross).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: 'connected_to', source_id: id('muc-core-sw01'), target_id: id('muc-core-sw02'), source_port: 'Hu1/0/49', source_site_id: a.id, target_site_id: b.id }),
        expect.objectContaining({ relation: 'redundant_with', source_id: id('muc-core-sw01'), target_id: id('muc-core-sw02') }),
      ]),
    );
    // uplinks inside a site are included too
    expect(d.connections.some((c) => c.source_id === id('muc-esx05') && c.target_id === id('muc-core-sw02'))).toBe(true);

    const cl = d.clusters.find((c) => c.name === 'MUC-CL01')!;
    expect(cl.stretched).toBe(true);
    expect(cl.sites[a.id]).toHaveLength(4);
    expect(cl.sites[b.id]).toHaveLength(2);
    expect(d.links.map((l) => l.label).sort()).toEqual(['Trunk North', 'Trunk South']);
  });

  let createdId: string;

  it('creates, updates and deletes data centers (editors only)', async () => {
    const body = {
      plant_id: muc.id,
      name: 'DC Halls',
      kind: 'stretched',
      description: 'OT server rooms',
      sites: [
        { name: 'Hall 1', role: 'primary', building_id: bld(mucBuildings, 'H1'), room: 'IT cabinet hall' },
        { name: 'Hall 2', role: 'secondary', building_id: bld(mucBuildings, 'H2'), room: 'IT cabinet hall' },
        { name: 'Witness', role: 'witness', building_id: bld(mucBuildings, 'B01') },
      ],
    };
    await operator.post('/api/datacenters', body).expect(403);
    await viewer.post('/api/datacenters', body).expect(403);
    const created = (await editor.post('/api/datacenters', body).expect(201)).body as DatacenterDetail;
    createdId = created.id;
    expect(created.sites.map((s) => s.name)).toEqual(['Hall 1', 'Hall 2', 'Witness']);
    expect(created.sites[0].racks.map((r) => r.name)).toEqual(['FD-HALL']);
    await editor.post('/api/datacenters', { ...body, name: 'dc halls' }).expect(409);

    // update keeps sites that are sent with their id (so links survive) and drops the others
    const link = await editor
      .post(`/api/datacenters/${createdId}/links`, { site_a_id: created.sites[0].id, site_b_id: created.sites[1].id, kind: 'fiber', label: 'Hall trunk', capacity: '12× OM4', length_m: 95 })
      .expect(201);
    const updated = (
      await editor
        .put(`/api/datacenters/${createdId}`, {
          ...body,
          name: 'DC Production halls',
          sites: [
            { id: created.sites[0].id, name: 'Hall 1', role: 'primary', building_id: bld(mucBuildings, 'H1'), room: 'IT cabinet hall' },
            { id: created.sites[1].id, name: 'Hall 2 (new name)', role: 'secondary', building_id: bld(mucBuildings, 'H2'), room: 'IT cabinet hall' },
          ],
        })
        .expect(200)
    ).body as DatacenterDetail;
    expect(updated.name).toBe('DC Production halls');
    expect(updated.sites.map((s) => s.name)).toEqual(['Hall 1', 'Hall 2 (new name)']);
    expect(updated.links.map((l) => l.id)).toEqual([link.body.id]);

    const history = await pool.query(`SELECT action FROM audit_log WHERE entity_type = 'datacenter' AND entity_id = $1 ORDER BY id`, [createdId]);
    expect(history.rows.map((r) => r.action)).toEqual(['create', 'datacenter.link.add', 'update']);
  });

  it('validates sites', async () => {
    const base = { plant_id: muc.id, name: 'Invalid', kind: 'stretched' };
    const other = await editor
      .post('/api/datacenters', {
        ...base,
        sites: [
          { name: 'A', role: 'primary', building_id: bld(mucBuildings, 'DC') },
          { name: 'B', role: 'secondary', building_id: bld(hamBuildings, 'DC') },
        ],
      })
      .expect(400);
    expect(other.body.error).toMatch(/another plant/);
    await editor
      .post('/api/datacenters', {
        ...base,
        sites: [
          { name: 'A', role: 'primary', building_id: bld(mucBuildings, 'DC') },
          { name: 'B', role: 'secondary', building_id: bld(mucBuildings, 'B01') },
          { name: 'W1', role: 'witness', building_id: bld(mucBuildings, 'H1') },
          { name: 'W2', role: 'witness', building_id: bld(mucBuildings, 'H2') },
        ],
      })
      .expect(400);
    await editor
      .post('/api/datacenters', { ...base, sites: [{ name: 'A', role: 'primary', building_id: bld(mucBuildings, 'DC') }] })
      .expect(400); // stretched needs two main sites
    await editor
      .post('/api/datacenters', {
        ...base,
        kind: 'single',
        sites: [
          { name: 'A', role: 'primary', building_id: bld(mucBuildings, 'DC') },
          { name: 'B', role: 'secondary', building_id: bld(mucBuildings, 'B01') },
        ],
      })
      .expect(400);
    await editor
      .post('/api/datacenters', { ...base, kind: 'single', name: 'DC single', sites: [{ name: 'Main', role: 'primary', building_id: bld(mucBuildings, 'DC') }] })
      .expect(201);
  });

  it('manages site links', async () => {
    const d = (await viewer.get(`/api/datacenters/${createdId}`).expect(200)).body as DatacenterDetail;
    const [a, b] = d.sites;
    await editor.post(`/api/datacenters/${createdId}/links`, { site_a_id: a.id, site_b_id: a.id, label: 'loop' }).expect(400);
    await editor.post(`/api/datacenters/${createdId}/links`, { site_a_id: a.id, site_b_id: seeded.sites[0].id, label: 'foreign' }).expect(400);
    const link = d.links[0];
    await operator.put(`/api/datacenter-links/${link.id}`, { site_a_id: a.id, site_b_id: b.id, label: 'x' }).expect(403);
    const res = await editor.put(`/api/datacenter-links/${link.id}`, { site_a_id: a.id, site_b_id: b.id, kind: 'wan', label: 'Hall trunk (rerouted)', length_m: 120 }).expect(200);
    expect(res.body).toMatchObject({ kind: 'wan', label: 'Hall trunk (rerouted)', length_m: 120 });
    await editor.del(`/api/datacenter-links/${link.id}`).expect(204);
    expect((await viewer.get(`/api/datacenters/${createdId}`).expect(200)).body.links).toEqual([]);
  });

  it('respects plant scope', async () => {
    const hamDc = (
      await admin
        .post('/api/datacenters', { plant_id: ham.id, name: 'DC Hamburg', kind: 'single', sites: [{ name: 'Main', role: 'primary', building_id: bld(hamBuildings, 'DC') }] })
        .expect(201)
    ).body;
    await operator.get(`/api/datacenters/${hamDc.id}`).expect(403);
    const visible = (await operator.get('/api/datacenters').expect(200)).body as DatacenterSummary[];
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((d) => d.plant_code === 'MUC')).toBe(true);
    await editor.post('/api/datacenters', { plant_id: ham.id, name: 'x', kind: 'single', sites: [{ name: 'M', role: 'primary', building_id: bld(hamBuildings, 'B01') }] }).expect(201);
  });

  it('exports data centers', async () => {
    const csv = await viewer.get('/api/export/datacenters?format=csv').expect(200);
    expect(csv.text).toContain('DC Munich');
    expect(csv.text).toContain('Server room 2');
    const full = await viewer.get(`/api/export/full?format=json&plantId=${muc.id}`).expect(200);
    const sheet = JSON.parse(full.text).data['Data centers'];
    expect(sheet.some((r: { site: string; datacenter: string }) => r.datacenter === 'DC Munich' && r.site === 'Site B')).toBe(true);
  });

  it('removes the site when its building is deleted and deletes data centers', async () => {
    const b = (await editor.post('/api/buildings', { plant_id: muc.id, code: 'TMP', name: 'Temporary container' }).expect(201)).body;
    const dc = (
      await editor
        .post('/api/datacenters', {
          plant_id: muc.id,
          name: 'DC Temporary',
          kind: 'stretched',
          sites: [
            { name: 'A', role: 'primary', building_id: bld(mucBuildings, 'DC'), room: 'Server room' },
            { name: 'B', role: 'secondary', building_id: b.id },
          ],
        })
        .expect(201)
    ).body as DatacenterDetail;
    await editor.del(`/api/buildings/${b.id}`).expect(204);
    const after = (await viewer.get(`/api/datacenters/${dc.id}`).expect(200)).body as DatacenterDetail;
    expect(after.sites.map((s) => s.name)).toEqual(['A']);

    await viewer.del(`/api/datacenters/${dc.id}`).expect(403);
    await editor.del(`/api/datacenters/${dc.id}`).expect(204);
    await viewer.get(`/api/datacenters/${dc.id}`).expect(404);
  });

  it('creates a data center in one step: only a building is needed, a new one can be entered by name', async () => {
    // only the building – name, kind and site name are filled in
    const simple = (await editor.post('/api/datacenters', { plant_id: ham.id, sites: [{ role: 'primary', building_id: bld(hamBuildings, 'DC') }] }).expect(201)).body as DatacenterDetail;
    expect(simple).toMatchObject({ name: 'HAM data center', kind: 'single' });
    expect(simple.sites.map((s) => s.name)).toEqual(['Server room']);
    const second = (await editor.post('/api/datacenters', { plant_id: ham.id, sites: [{ role: 'primary', building_id: bld(hamBuildings, 'DC'), room: 'Room 2' }] }).expect(201)).body;
    expect(second.name).toBe('HAM data center 2');

    // a new building by name: created with a code made from its name, audited, and reused instead of duplicated
    const stretched = (
      await editor
        .post('/api/datacenters', {
          plant_id: ham.id,
          kind: 'stretched',
          sites: [
            { role: 'primary', building_id: bld(hamBuildings, 'DC'), room: 'Room 3' },
            { role: 'secondary', new_building_name: 'Backup Container 2', room: 'IT' },
          ],
        })
        .expect(201)
    ).body as DatacenterDetail;
    expect(stretched.sites.map((s) => s.name)).toEqual(['Site A', 'Site B']);
    const created = (await viewer.get(`/api/plants/${ham.id}`).expect(200)).body.buildings.find((b: { name: string }) => b.name === 'Backup Container 2');
    expect(created).toMatchObject({ code: 'BC2' });
    expect(stretched.sites[1].building_id).toBe(created.id);
    const audit = await pool.query(`SELECT 1 FROM audit_log WHERE entity_type = 'building' AND entity_id = $1 AND action = 'create'`, [created.id]);
    expect(audit.rowCount).toBe(1);
    const again = (await editor.post('/api/datacenters', { plant_id: ham.id, sites: [{ role: 'primary', new_building_name: 'backup container 2', room: 'Other' }] }).expect(201)).body;
    expect(again.sites[0].building_id).toBe(created.id);

    // exactly one of building / new building per site
    await editor.post('/api/datacenters', { plant_id: ham.id, sites: [{ role: 'primary' }] }).expect(400);
    await editor.post('/api/datacenters', { plant_id: ham.id, sites: [{ role: 'primary', building_id: bld(hamBuildings, 'DC'), new_building_name: 'X' }] }).expect(400);
    // operators cannot create buildings this way
    await operator.post('/api/datacenters', { plant_id: muc.id, sites: [{ role: 'primary', new_building_name: 'Sneaky' }] }).expect(403);
  });

  it('generates the building code when it is left empty', async () => {
    const b = (await editor.post('/api/buildings', { plant_id: ham.id, name: 'Production hall 7' }).expect(201)).body;
    expect(b.code).toBe('PH7');
    const b2 = (await editor.post('/api/buildings', { plant_id: ham.id, name: 'Production hall 7 annex' }).expect(201)).body;
    expect(b2.code).toBe('PH7A');
    const b3 = (await editor.post('/api/buildings', { plant_id: ham.id, name: 'Production hall 7' }).expect(201)).body;
    expect(b3.code).toBe('PH72');
    // editing without a code keeps the code
    const edited = (await editor.put(`/api/buildings/${b.id}`, { plant_id: ham.id, name: 'Production hall seven' }).expect(200)).body;
    expect(edited.code).toBe('PH7');
  });
});

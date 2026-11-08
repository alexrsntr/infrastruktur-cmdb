import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
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

function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
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
});

afterAll(async () => {
  await pool.end();
});

describe('basics & authentication', () => {
  it('serves health and public config without login', async () => {
    await request(app).get('/healthz').expect(200);
    await request(app).get('/readyz').expect(200);
    const cfg = await request(app).get('/api/public-config').expect(200);
    expect(cfg.body.authMode).toBe('dev');
  });

  it('rejects anonymous API access', async () => {
    await request(app).get('/api/me').expect(401);
    await request(app).get('/api/assets').expect(401);
  });

  it('returns the current user with permissions', async () => {
    const me = await viewer.get('/api/me').expect(200);
    expect(me.body.user.role).toBe('viewer');
    expect(me.body.permissions).toContain('export');
    expect(me.body.permissions).not.toContain('asset.write');
  });

  it('requires a CSRF token for state changing requests', async () => {
    await editor.agent.post('/api/notes').send({}).expect(403);
    await editor.agent.post('/api/notes').set('x-csrf-token', 'wrong').send({}).expect(403);
  });
});

describe('locations', () => {
  it('lists plants with counts', async () => {
    const res = await viewer.get('/api/plants').expect(200);
    expect(res.body.length).toBe(6);
    expect(res.body[0]).toHaveProperty('asset_count');
  });

  it('returns plant detail with buildings and building detail with floors', async () => {
    const plant = await viewer.get(`/api/plants/${muc.id}`).expect(200);
    expect(plant.body.buildings.length).toBeGreaterThan(2);
    const building = await viewer.get(`/api/buildings/${plant.body.buildings[0].id}`).expect(200);
    expect(building.body.floors.length).toBeGreaterThan(0);
    expect(building.body.floors[0].has_plan).toBe(true);
  });

  it('lets editors create buildings & floors, upload a floor plan and blocks viewers', async () => {
    await viewer.post('/api/buildings', { plant_id: muc.id, code: 'X1', name: 'Nope' }).expect(403);
    const b = await editor.post('/api/buildings', { plant_id: muc.id, code: 'LAG', name: 'Warehouse' }).expect(201);
    await editor.post('/api/buildings', { plant_id: muc.id, code: 'lag', name: 'Duplicate' }).expect(409);
    const f = await editor.post('/api/floors', { building_id: b.body.id, name: 'Ground floor', level: 0 }).expect(201);
    const png = drawFloorPlan(320, 200, OFFICE_LAYOUT.slice(0, 1));
    const up = await editor.agent
      .put(`/api/floors/${f.body.id}/plan`)
      .set('x-csrf-token', editor.csrf)
      .attach('file', png, 'plan.png')
      .expect(200);
    expect(up.body).toMatchObject({ has_plan: true, plan_width: 320, plan_height: 200 });
    const img = await viewer.get(`/api/floors/${f.body.id}/plan`).buffer(true).parse(binary).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    await editor.agent
      .put(`/api/floors/${f.body.id}/plan`)
      .set('x-csrf-token', editor.csrf)
      .attach('file', Buffer.from('<svg onload="alert(1)"></svg>'), 'evil.svg')
      .expect(400);
  });

  it('only admins may delete plants and plants with assets cannot be deleted', async () => {
    await editor.del(`/api/plants/${ham.id}`).expect(403);
    const res = await admin.del(`/api/plants/${ham.id}`).expect(400);
    expect(res.body.error).toMatch(/still has/);
  });
});

describe('assets', () => {
  let assetId: string;

  it('filters and paginates assets', async () => {
    const all = await viewer.get('/api/assets?pageSize=5').expect(200);
    expect(all.body.items.length).toBe(5);
    expect(all.body.total).toBeGreaterThan(100);
    const switches = await viewer.get(`/api/assets?type=switch&plantId=${muc.id}`).expect(200);
    expect(switches.body.items.every((a: { type: string; plant_id: string }) => a.type === 'switch' && a.plant_id === muc.id)).toBe(true);
    const search = await viewer.get('/api/assets?q=muc-core').expect(200);
    expect(search.body.items[0].name).toBe('muc-core-sw01');
    await viewer.get('/api/assets?type=toaster').expect(400);
  });

  it('creates an asset and derives plant/building from the floor', async () => {
    const plant = await editor.get(`/api/plants/${muc.id}`).expect(200);
    const building = await editor.get(`/api/buildings/${plant.body.buildings[0].id}`).expect(200);
    const floor = building.body.floors[0];
    const res = await editor
      .post('/api/assets', {
        type: 'access_point',
        name: 'muc-ap-test-001',
        floor_id: floor.id,
        map_x: 0.5,
        map_y: 0.25,
        ip_address: '10.10.20.250',
        mac_address: 'aa:bb:cc:dd:ee:ff',
        tags: ['test', 'test'],
        attributes: { wifi_standard: 'Wi-Fi 7 (be)', unknown_field: 'dropped' },
      })
      .expect(201);
    assetId = res.body.id;
    expect(res.body.plant_id).toBe(muc.id);
    expect(res.body.building_id).toBe(building.body.id);
    expect(res.body.tags).toEqual(['test']);
    expect(res.body.attributes).toEqual({ wifi_standard: 'Wi-Fi 7 (be)' });
  });

  it('validates input', async () => {
    const res = await editor.post('/api/assets', { type: 'switch', name: '', ip_address: '999.1.1.1' }).expect(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['name', 'ip_address']));
    await editor.post('/api/assets', { type: 'access_point', name: 'MUC-AP-TEST-001' }).expect(409);
  });

  it('updates an asset and records a field level history', async () => {
    const current = (await editor.get(`/api/assets/${assetId}`).expect(200)).body;
    await editor.put(`/api/assets/${assetId}`, { ...current, model: 'CW9178I', status: 'maintenance' }).expect(200);
    const history = await viewer.get(`/api/history?entityType=asset&entityId=${assetId}`).expect(200);
    expect(history.body[0].action).toBe('update');
    expect(history.body[0].changes.model).toEqual({ from: null, to: 'CW9178I' });
    expect(history.body[0].changes.status).toEqual({ from: 'active', to: 'maintenance' });
  });

  it('lets operators change the status but not edit master data', async () => {
    const mucAsset = (await operator.get(`/api/assets?plantId=${muc.id}&type=switch&pageSize=1`).expect(200)).body.items[0];
    await operator.patch(`/api/assets/${mucAsset.id}/status`, { status: 'maintenance' }).expect(200);
    await operator.put(`/api/assets/${mucAsset.id}`, { ...mucAsset }).expect(403);
    await operator.post('/api/assets', { type: 'switch', name: 'x' }).expect(403);
    await viewer.patch(`/api/assets/${mucAsset.id}/status`, { status: 'active' }).expect(403);
  });

  it('manages relations', async () => {
    const core = (await editor.get('/api/assets?q=muc-core-sw01').expect(200)).body.items[0];
    const rel = await editor.post('/api/relations', { source_id: assetId, target_id: core.id, relation: 'uplink', source_port: 'eth0', target_port: 'Gi1/0/48' }).expect(201);
    await editor.post('/api/relations', { source_id: assetId, target_id: core.id, relation: 'uplink' }).expect(409);
    const detail = await viewer.get(`/api/assets/${assetId}`).expect(200);
    expect(detail.body.relations).toEqual([expect.objectContaining({ relation: 'uplink', direction: 'out', other_name: 'muc-core-sw01', remote_port: 'Gi1/0/48' })]);
    const coreDetail = await viewer.get(`/api/assets/${core.id}`).expect(200);
    expect(coreDetail.body.relations.some((r: { other_id: string; direction: string }) => r.other_id === assetId && r.direction === 'in')).toBe(true);
    await editor.del(`/api/relations/${rel.body.id}`).expect(204);
  });

  it('moves an asset on the floor plan', async () => {
    const asset = (await editor.get(`/api/assets/${assetId}`).expect(200)).body;
    const moved = await editor.patch(`/api/assets/${assetId}/position`, { floor_id: asset.floor_id, map_x: 0.1, map_y: 0.9 }).expect(200);
    expect(moved.body).toMatchObject({ map_x: 0.1, map_y: 0.9 });
    const removed = await editor.patch(`/api/assets/${assetId}/position`, { floor_id: asset.floor_id, map_x: null, map_y: null }).expect(200);
    expect(removed.body).toMatchObject({ floor_id: asset.floor_id, map_x: null });
  });

  it('deletes an asset with its notes and activities', async () => {
    await editor.post('/api/notes', { entity_type: 'asset', entity_id: assetId, body: 'temp' }).expect(201);
    await viewer.del(`/api/assets/${assetId}`).expect(403);
    await editor.del(`/api/assets/${assetId}`).expect(204);
    await viewer.get(`/api/assets/${assetId}`).expect(404);
    const notes = await pool.query('SELECT count(*) AS n FROM note WHERE entity_id = $1', [assetId]);
    expect(notes.rows[0].n).toBe(0);
  });
});

describe('plant scope (operator restricted to MUC)', () => {
  it('only shows plants and assets in scope', async () => {
    const plants = await operator.get('/api/plants').expect(200);
    expect(plants.body.map((p: { code: string }) => p.code)).toEqual(['MUC']);
    const assets = await operator.get('/api/assets?pageSize=1000').expect(200);
    expect(assets.body.items.every((a: { plant_code: string }) => a.plant_code === 'MUC')).toBe(true);
    await operator.get(`/api/plants/${ham.id}`).expect(403);
    const hamAsset = (await admin.get(`/api/assets?plantId=${ham.id}&pageSize=1`).expect(200)).body.items[0];
    await operator.get(`/api/assets/${hamAsset.id}`).expect(403);
    await operator.post('/api/notes', { entity_type: 'asset', entity_id: hamAsset.id, body: 'x' }).expect(403);
    const search = await operator.get('/api/search?q=ham-').expect(200);
    expect(search.body).toEqual([]);
  });

  it('scopes exports', async () => {
    const res = await operator.get('/api/export/assets?format=json').expect(200);
    const data = JSON.parse(res.text);
    expect(data.data.Assets.every((a: { plant_code: string }) => a.plant_code === 'MUC')).toBe(true);
  });
});

describe('notes & activities', () => {
  it('lets operators write notes; only the author or an admin may edit them', async () => {
    const note = await operator.post('/api/notes', { entity_type: 'plant', entity_id: muc.id, body: 'Rack R03 key is at the gate.' }).expect(201);
    expect(note.body.created_by_name).toMatch(/Olga/);
    await editor.put(`/api/notes/${note.body.id}`, { body: 'hijack' }).expect(403);
    await operator.put(`/api/notes/${note.body.id}`, { body: 'Rack R03 key is at the gate (box 4).', pinned: true }).expect(200);
    await viewer.post('/api/notes', { entity_type: 'plant', entity_id: muc.id, body: 'nope' }).expect(403);
    await admin.del(`/api/notes/${note.body.id}`).expect(204);
  });

  it('tracks activity lifecycle', async () => {
    const act = await operator
      .post('/api/activities', { entity_type: 'plant', entity_id: muc.id, kind: 'incident', title: 'WLAN outage hall 1', due_date: '2030-01-01' })
      .expect(201);
    expect(act.body).toMatchObject({ status: 'open', plant_id: muc.id, entity_label: expect.stringContaining('MUC') });
    const done = await operator.put(`/api/activities/${act.body.id}`, { kind: 'incident', status: 'done', title: 'WLAN outage hall 1', due_date: '2030-01-01' }).expect(200);
    expect(done.body.completed_at).not.toBeNull();
    const list = await viewer.get(`/api/activities?plantId=${muc.id}&kind=incident`).expect(200);
    expect(list.body.items.some((a: { id: string }) => a.id === act.body.id)).toBe(true);
  });
});

describe('exports', () => {
  it('exports assets as CSV with formula injection protection', async () => {
    const editorAsset = await editor.post('/api/assets', { type: 'vm', name: 'csv-test-vm', description: '=HYPERLINK("http://evil")' }).expect(201);
    const res = await viewer.get('/api/export/assets?format=csv&type=vm&q=csv-test').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="Virtual_Machines_/);
    expect(res.text).toContain('vCPU');
    expect(res.text).toContain(`"'=HYPERLINK`);
    await editor.del(`/api/assets/${editorAsset.body.id}`).expect(204);
  });

  it('exports a full workbook with one sheet per entity', async () => {
    const res = await viewer.get('/api/export/full?format=xlsx').buffer(true).parse(binary).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(['Plants', 'Buildings', 'Floors', 'All assets', 'Switches', 'Access Points', 'Servers', 'Virtual Machines', 'Relations', 'Activities', 'Notes']));
    expect(names).not.toContain('Users');
    expect(wb.getWorksheet('Switches')!.getRow(1).values).toEqual(expect.arrayContaining(['Name', 'Ports', 'Mgmt VLAN']));
  });

  it('exports plant dossier, asset dossier and admin datasets', async () => {
    await viewer.get(`/api/export/full?format=json&plantId=${muc.id}`).expect(200);
    const asset = (await viewer.get('/api/assets?pageSize=1').expect(200)).body.items[0];
    const dossier = await viewer.get(`/api/export/asset/${asset.id}?format=json`).expect(200);
    expect(JSON.parse(dossier.text).data).toHaveProperty('History');
    for (const ds of ['plants', 'buildings', 'floors', 'relations', 'notes', 'activities']) {
      await viewer.get(`/api/export/${ds}?format=csv`).expect(200);
    }
    await viewer.get('/api/export/audit?format=csv').expect(403);
    await viewer.get('/api/export/users?format=csv').expect(403);
    await admin.get('/api/export/audit?format=xlsx').expect(200);
    await admin.get('/api/export/users?format=xlsx').expect(200);
  });

  it('audits exports', async () => {
    const log = await admin.get('/api/audit?action=export&pageSize=5').expect(200);
    expect(log.body.total).toBeGreaterThan(0);
  });
});

describe('import', () => {
  const csv = [
    'Type;Name;Status;Plant;Building;Floor;IP address;Ports;PoE;Warranty end;Tags',
    'Switch;muc-imp-sw01;Active;MUC;B01;Ground floor;10.10.0.200;24;yes;31.12.2029;import, test',
    'switch;muc-core-sw01;active;MUC;DC;;10.10.0.1;48;no;;core',
    'Toaster;bad;;;;;;;;;',
    'Switch;muc-imp-sw02;;XXX;;;;;;;',
  ].join('\n');

  it('performs a dry run without changing data', async () => {
    const res = await editor.agent
      .post('/api/import/assets?dryRun=true')
      .set('x-csrf-token', editor.csrf)
      .attach('file', Buffer.from(csv), 'assets.csv')
      .expect(200);
    expect(res.body).toMatchObject({ dryRun: true, total: 4, created: 1 });
    expect(res.body.errors.map((e: { row: number }) => e.row)).toEqual([4, 5]);
    await viewer.get('/api/assets?q=muc-imp-sw01').expect(200).then((r) => expect(r.body.total).toBe(0));
  });

  it('imports and updates assets', async () => {
    const res = await editor.agent
      .post('/api/import/assets?dryRun=false')
      .set('x-csrf-token', editor.csrf)
      .attach('file', Buffer.from(csv), 'assets.csv')
      .expect(200);
    expect(res.body.created).toBe(1);
    const created = (await viewer.get('/api/assets?q=muc-imp-sw01').expect(200)).body.items[0];
    expect(created).toMatchObject({ plant_code: 'MUC', building_code: 'B01', floor_name: 'Ground floor', warranty_end: '2029-12-31', tags: ['import', 'test'] });
    expect(created.attributes).toEqual({ port_count: 24, poe: true });
  });

  it('round-trips an Excel export through the import without changes', async () => {
    const exported = await editor.get(`/api/export/assets?format=xlsx&plantId=${muc.id}`).buffer(true).parse(binary).expect(200);
    const res = await editor.agent
      .post('/api/import/assets?dryRun=true')
      .set('x-csrf-token', editor.csrf)
      .attach('file', exported.body as Buffer, 'roundtrip.xlsx')
      .expect(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.total).toBeGreaterThan(30);
    expect(res.body).toMatchObject({ created: 0, updated: 0, skipped: res.body.total });
  });

  it('is forbidden for operators', async () => {
    await operator.agent.post('/api/import/assets').set('x-csrf-token', operator.csrf).attach('file', Buffer.from(csv), 'a.csv').expect(403);
  });
});

describe('administration', () => {
  it('manages users, scopes and deactivation', async () => {
    await editor.get('/api/users').expect(403);
    const users = (await admin.get('/api/users').expect(200)).body as { id: string; role: string; email: string }[];
    const viewerUser = users.find((u) => u.email === 'viktor.viewer@example.local')!;
    await admin.put(`/api/users/${viewerUser.id}`, { role: 'viewer', plant_scope: [ham.id], active: true }).expect(200);
    const plants = await viewer.get('/api/plants').expect(200);
    expect(plants.body.map((p: { code: string }) => p.code)).toEqual(['HAM']);
    await admin.put(`/api/users/${viewerUser.id}`, { role: 'viewer', plant_scope: [], active: false }).expect(200);
    await viewer.get('/api/me').expect(401);
    const self = users.find((u) => u.role === 'admin')!;
    await admin.put(`/api/users/${self.id}`, { role: 'viewer', plant_scope: [], active: true }).expect(400);
  });

  it('pre-provisions users by e-mail', async () => {
    const res = await admin.post('/api/users', { email: 'New.Person@example.local', display_name: 'New Person', role: 'editor' }).expect(201);
    expect(res.body.email).toBe('new.person@example.local');
    await admin.post('/api/users', { email: 'new.person@example.local', display_name: 'Dup', role: 'viewer' }).expect(400);
  });

  it('provides a filterable audit log for admins only', async () => {
    await editor.get('/api/audit').expect(403);
    const res = await admin.get('/api/audit?entityType=asset&action=update').expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
  });
});

describe('dashboard & search', () => {
  it('returns dashboard aggregates', async () => {
    const res = await editor.get('/api/dashboard').expect(200);
    expect(res.body.totals.plants).toBe(6);
    expect(res.body.byType.length).toBe(4);
    expect(res.body.warrantyExpiring.length).toBeGreaterThan(0);
  });

  it('searches across plants, buildings and assets', async () => {
    const res = await editor.get('/api/search?q=esx01').expect(200);
    expect(res.body[0]).toMatchObject({ kind: 'asset', assetType: 'server' });
    const p = await editor.get('/api/search?q=Prag').expect(200);
    expect(p.body[0].kind).toBe('plant');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type request from 'supertest';
import { login, setupTestApp, type Session } from './helpers';

let app: Express;
let pool: Pool;
let admin: Session;
let editor: Session;
let operator: Session;
let viewer: Session;
let muc: { id: string };
let ham: { id: string };
let dc: { id: string; floors: { id: string; name: string }[] };
let b01: { id: string; floors: { id: string; name: string }[] };

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
  const plant = (await admin.get(`/api/plants/${muc.id}`).expect(200)).body;
  dc = (await admin.get(`/api/buildings/${plant.buildings.find((b: { code: string }) => b.code === 'DC').id}`).expect(200)).body;
  b01 = (await admin.get(`/api/buildings/${plant.buildings.find((b: { code: string }) => b.code === 'B01').id}`).expect(200)).body;
});

afterAll(async () => {
  await pool.end();
});

describe('racks', () => {
  let rackId: string;

  it('lists seeded racks with usage per building', async () => {
    const res = await viewer.get(`/api/racks?buildingId=${dc.id}`).expect(200);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['R01', 'R02']);
    const r02 = res.body.find((r: { name: string }) => r.name === 'R02');
    expect(r02).toMatchObject({ height_u: 42, plant_code: 'MUC', asset_count: 5 }); // 4 hosts + UPS
    expect(r02.used_u).toBe(4 * 2 + 1 + 1 + 1 + 4); // 4 hosts × 2U + panel + cable mgmt + KVM shelf + UPS 4U
  });

  it('returns a rack with its devices and items', async () => {
    const list = (await viewer.get(`/api/racks?buildingId=${dc.id}`).expect(200)).body;
    const r01 = (await viewer.get(`/api/racks/${list[0].id}`).expect(200)).body;
    expect(r01.assets).toEqual([expect.objectContaining({ name: 'muc-core-sw01', rack_u: 38, rack_height_u: 1 })]);
    expect(r01.items.map((i: { kind: string }) => i.kind)).toEqual(expect.arrayContaining(['patch_panel', 'cable_management', 'pdu']));
  });

  it('lets editors create racks; operators and viewers cannot', async () => {
    await operator.post('/api/racks', { building_id: b01.id, name: 'X' }).expect(403);
    await viewer.post('/api/racks', { building_id: b01.id, name: 'X' }).expect(403);
    const res = await editor.post('/api/racks', { building_id: b01.id, floor_id: b01.floors[0].id, name: 'R-TEST', room: 'E.12', height_u: 12 }).expect(201);
    rackId = res.body.id;
    expect(res.body).toMatchObject({ name: 'R-TEST', height_u: 12, used_u: 0, building_name: 'Administration', floor_name: b01.floors[0].name });
    await editor.post('/api/racks', { building_id: b01.id, name: 'r-test' }).expect(409);
    await editor.post('/api/racks', { building_id: b01.id, floor_id: dc.floors[0].id, name: 'wrong floor' }).expect(400);
  });

  it('mounts devices, rejects overlaps and out-of-range positions', async () => {
    const sw = (await editor.post('/api/assets', { type: 'switch', name: 'muc-rack-test-sw', building_id: b01.id }).expect(201)).body;
    const srv = (await editor.post('/api/assets', { type: 'server', name: 'muc-rack-test-srv', building_id: b01.id }).expect(201)).body;
    const vm = (await editor.post('/api/assets', { type: 'vm', name: 'muc-rack-test-vm', plant_id: muc.id }).expect(201)).body;

    const mounted = await editor.patch(`/api/assets/${sw.id}/rack`, { rack_id: rackId, rack_u: 10, rack_height_u: 1 }).expect(200);
    expect(mounted.body).toMatchObject({ rack_id: rackId, rack_u: 10, floor_id: b01.floors[0].id, building_id: b01.id });

    const overlap = await editor.patch(`/api/assets/${srv.id}/rack`, { rack_id: rackId, rack_u: 9, rack_height_u: 2 }).expect(409);
    expect(overlap.body.error).toMatch(/U9–U10 .* occupied by muc-rack-test-sw/);
    await editor.patch(`/api/assets/${srv.id}/rack`, { rack_id: rackId, rack_u: 12, rack_height_u: 2 }).expect(400); // 12–13 > 12U
    await editor.patch(`/api/assets/${srv.id}/rack`, { rack_id: rackId, rack_u: 7, rack_height_u: 2 }).expect(200);
    await editor.patch(`/api/assets/${vm.id}/rack`, { rack_id: rackId, rack_u: 1 }).expect(400);
    await operator.patch(`/api/assets/${srv.id}/rack`, { rack_id: rackId, rack_u: 1 }).expect(403);

    // moving within the rack excludes the device itself from the overlap check
    await editor.patch(`/api/assets/${srv.id}/rack`, { rack_id: rackId, rack_u: 6, rack_height_u: 2 }).expect(200);

    const detail = (await viewer.get(`/api/assets/${sw.id}`).expect(200)).body;
    expect(detail).toMatchObject({ rack_name: 'R-TEST', rack_u: 10, rack_height_u: 1 });
    const history = (await viewer.get(`/api/history?entityType=asset&entityId=${srv.id}`).expect(200)).body;
    expect(history[0].changes.rack_u).toEqual({ from: 7, to: 6 });
  });

  it('validates the rack position when saving an asset via the form', async () => {
    const asset = (await editor.get('/api/assets?q=muc-rack-test-srv').expect(200)).body.items[0];
    const res = await editor.put(`/api/assets/${asset.id}`, { ...asset, rack_u: 10, rack_height_u: 1 }).expect(409);
    expect(res.body.error).toMatch(/occupied/);
    await editor.put(`/api/assets/${asset.id}`, { ...asset, rack_u: 3, rack_height_u: 2 }).expect(200);
  });

  it('manages rack items that also block units', async () => {
    const item = await editor.post(`/api/racks/${rackId}/items`, { kind: 'patch_panel', label: 'Panel 1–24', position_u: 12 }).expect(201);
    await editor.post(`/api/racks/${rackId}/items`, { kind: 'shelf', label: 'Shelf', position_u: 10 }).expect(409);
    await editor.put(`/api/rack-items/${item.body.id}`, { kind: 'patch_panel', label: 'Panel A 1–24', position_u: 11 }).expect(200);
    const sw = (await editor.get('/api/assets?q=muc-rack-test-sw').expect(200)).body.items[0];
    await editor.patch(`/api/assets/${sw.id}/rack`, { rack_id: rackId, rack_u: 11 }).expect(409);
    await operator.del(`/api/rack-items/${item.body.id}`).expect(403);
    const rack = (await viewer.get(`/api/racks/${rackId}`).expect(200)).body;
    expect(rack.used_u).toBe(1 + 2 + 1);
  });

  it('cannot shrink a rack below its content', async () => {
    const rack = (await viewer.get(`/api/racks/${rackId}`).expect(200)).body;
    const res = await editor.put(`/api/racks/${rackId}`, { ...rack, height_u: 8 }).expect(400);
    expect(res.body.error).toMatch(/U11/);
    await editor.put(`/api/racks/${rackId}`, { ...rack, height_u: 16, numbering: 'top_down' }).expect(200);
  });

  it('supports notes, activities and history on racks', async () => {
    await operator.post('/api/notes', { entity_type: 'rack', entity_id: rackId, body: 'Key in the reception safe' }).expect(201);
    await operator.post('/api/activities', { entity_type: 'rack', entity_id: rackId, kind: 'inspection', title: 'Check fans' }).expect(201);
    const history = (await viewer.get(`/api/history?entityType=rack&entityId=${rackId}`).expect(200)).body;
    expect(history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['create', 'update', 'rack.item.add']));
  });

  it('exports racks, rack contents and a single rack elevation', async () => {
    const csv = await viewer.get(`/api/export/racks?format=csv&buildingId=${dc.id}`).expect(200);
    expect(csv.text).toContain('Height (U)');
    const contents = await viewer.get(`/api/export/rack-contents?format=json&rackId=${rackId}`).expect(200);
    const rows = JSON.parse(contents.text).data['Rack contents'];
    expect(rows.map((r: { units: string }) => r.units)).toEqual(['11', '10', '3-4']);

    const xlsx = await viewer.get(`/api/export/rack/${rackId}?format=xlsx`).buffer(true).parse(binary).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as unknown as ArrayBuffer);
    const elevation = wb.getWorksheet('Elevation')!;
    expect(elevation.rowCount).toBe(17); // header + 16 U
    // top-down numbering: physical U11 is printed as U6 on a 16U rack
    const values = elevation.getSheetValues().slice(2).map((r) => (r as unknown[]).slice(1, 3));
    expect(values).toContainEqual(['U6', 'Panel A 1–24']);
    expect(values).toContainEqual(['U13', 'muc-rack-test-srv']); // physical U4 = top of the 2U server
    expect(values).toContainEqual(['U14', '↑ muc-rack-test-srv']);

    const full = await viewer.get('/api/export/full?format=json').expect(200);
    expect(Object.keys(JSON.parse(full.text).data)).toEqual(expect.arrayContaining(['Racks', 'Rack contents']));
  });

  it('imports devices into racks by rack name and unit', async () => {
    const csv = [
      'Type;Name;Plant;Building;Rack;Rack unit',
      'Server;muc-imp-rack-srv;MUC;B01;R-TEST;1-2',
      'Server;muc-imp-rack-bad;MUC;B01;R-NOPE;5',
      'Server;muc-imp-rack-clash;MUC;B01;R-TEST;U3',
    ].join('\n');
    const res = await editor.agent.post('/api/import/assets?dryRun=false').set('x-csrf-token', editor.csrf).attach('file', Buffer.from(csv), 'r.csv').expect(200);
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toEqual([
      { row: 3, message: expect.stringMatching(/Unknown rack "R-NOPE"/) },
      { row: 4, message: expect.stringMatching(/occupied/) },
    ]);
    const a = (await viewer.get('/api/assets?q=muc-imp-rack-srv').expect(200)).body.items[0];
    expect(a).toMatchObject({ rack_name: 'R-TEST', rack_u: 1, rack_height_u: 2 });
  });

  it('respects plant scope', async () => {
    const hamRacks = (await admin.get(`/api/racks?plantId=${ham.id}`).expect(200)).body;
    expect(hamRacks.length).toBeGreaterThan(0);
    await operator.get(`/api/racks/${hamRacks[0].id}`).expect(403);
    const visible = (await operator.get('/api/racks').expect(200)).body;
    expect(visible.every((r: { plant_code: string }) => r.plant_code === 'MUC')).toBe(true);
  });

  it('unmounts devices when a rack is deleted', async () => {
    await viewer.del(`/api/racks/${rackId}`).expect(403);
    await editor.del(`/api/racks/${rackId}`).expect(204);
    const sw = (await viewer.get('/api/assets?q=muc-rack-test-sw').expect(200)).body.items[0];
    expect(sw).toMatchObject({ rack_id: null, rack_u: null, building_id: b01.id });
    const notes = await pool.query(`SELECT count(*) AS n FROM note WHERE entity_type = 'rack' AND entity_id = $1`, [rackId]);
    expect(notes.rows[0].n).toBe(0);
  });
});

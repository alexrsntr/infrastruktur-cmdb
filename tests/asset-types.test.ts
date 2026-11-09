import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { ASSET_TYPES, ASSET_TYPE_KEYS } from '../shared/model';
import { login, setupTestApp, type Session } from './helpers';

let app: Express;
let pool: Pool;
let admin: Session;
let editor: Session;
let viewer: Session;
let muc: { id: string };

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  const plants = (await viewer.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
});

afterAll(async () => {
  await pool.end();
});

describe('device types', () => {
  it('every type has a unique slug and short label and can be stored', async () => {
    expect(new Set(ASSET_TYPE_KEYS.map((t) => ASSET_TYPES[t].slug)).size).toBe(ASSET_TYPE_KEYS.length);
    expect(new Set(ASSET_TYPE_KEYS.map((t) => ASSET_TYPES[t].short)).size).toBe(ASSET_TYPE_KEYS.length);
    for (const type of ASSET_TYPE_KEYS) {
      const res = await editor.post('/api/assets', { type, name: `muc-${type}-t1`, plant_id: muc.id }).expect(201);
      expect(res.body.type).toBe(type);
    }
  });

  it('keeps type specific fields of the new types and drops unknown ones', async () => {
    const fw = (
      await editor
        .post('/api/assets', {
          type: 'firewall',
          name: 'muc-fw-ha1',
          plant_id: muc.id,
          attributes: { ha_mode: 'Active / passive', throughput_gbps: '10', vpn: 'yes', license_end: '31.12.2027', port_count: 48 },
        })
        .expect(201)
    ).body;
    expect(fw.attributes).toEqual({ ha_mode: 'Active / passive', throughput_gbps: 10, vpn: true, license_end: '2027-12-31' });

    const plc = (await editor.post('/api/assets', { type: 'ot_device', name: 'muc-l3-plc01', plant_id: muc.id, attributes: { kind: 'PLC', fieldbus: 'PROFINET', machine: 'Press line 3' } }).expect(201)).body;
    expect(plc.attributes).toEqual({ kind: 'PLC', fieldbus: 'PROFINET', machine: 'Press line 3' });
  });

  it('virtual machines cannot be mounted in a rack, PDUs can', async () => {
    const rack = (await viewer.get(`/api/racks?plantId=${muc.id}`).expect(200)).body[0];
    await editor.post('/api/assets', { type: 'vm', name: 'muc-vm-rack', plant_id: muc.id, rack_id: rack.id, rack_u: 40 }).expect(400);
    const detail = (await viewer.get(`/api/racks/${rack.id}`).expect(200)).body as { height_u: number; assets: { rack_u: number; rack_height_u: number }[]; items: { position_u: number; height_u: number }[] };
    const used = new Set<number>();
    for (const x of [...detail.assets.map((a) => [a.rack_u, a.rack_height_u]), ...detail.items.map((i) => [i.position_u, i.height_u])])
      for (let u = x[0]; u < x[0] + x[1]; u++) used.add(u);
    const free = Array.from({ length: detail.height_u }, (_, i) => i + 1).find((u) => !used.has(u))!;
    const pdu = await editor.post('/api/assets', { type: 'pdu', name: 'muc-pdu-rack', rack_id: rack.id, rack_u: free, attributes: { kind: 'Switched', max_current_a: 16 } }).expect(201);
    expect(pdu.body).toMatchObject({ rack_id: rack.id, rack_u: free, plant_id: muc.id });
  });

  it('administrators hide types and add own fields; values are kept in attributes', async () => {
    await editor.put('/api/settings/asset-types', { hidden: ['printer'] }).expect(403);
    const saved = (
      await admin
        .put('/api/settings/asset-types', {
          hidden: ['printer', 'camera'],
          customFields: {
            switch: [
              { label: 'Contract number', type: 'text' },
              { label: 'Power draw', type: 'number', unit: 'W' },
              { label: 'Zone', type: 'select', options: ['Office', 'OT', 'Office'] },
            ],
          },
        })
        .expect(200)
    ).body;
    expect(saved.hidden).toEqual(['printer', 'camera']);
    expect(saved.customFields.switch).toEqual([
      { key: 'custom_contract_number', label: 'Contract number', type: 'text' },
      { key: 'custom_power_draw', label: 'Power draw', type: 'number', unit: 'W' },
      { key: 'custom_zone', label: 'Zone', type: 'select', options: ['Office', 'OT'] },
    ]);
    // everyone can read the settings (forms need them)
    expect((await viewer.get('/api/asset-types').expect(200)).body).toEqual(saved);

    const sw = (
      await editor
        .post('/api/assets', { type: 'switch', name: 'muc-sw-custom', plant_id: muc.id, attributes: { port_count: 24, custom_contract_number: 'C-4711', custom_power_draw: '85,5', custom_unknown: 'x' } })
        .expect(201)
    ).body;
    expect(sw.attributes).toEqual({ port_count: 24, custom_contract_number: 'C-4711', custom_power_draw: 85.5 });

    // stable keys when the fields are saved again, renamed fields keep their key
    const again = (
      await admin
        .put('/api/settings/asset-types', { hidden: ['printer', 'camera'], customFields: { switch: [{ ...saved.customFields.switch[0], label: 'Contract no.' }] } })
        .expect(200)
    ).body;
    expect(again.customFields.switch).toEqual([{ key: 'custom_contract_number', label: 'Contract no.', type: 'text' }]);

    // hidden types: existing devices stay, new ones can still be created through the API (hiding is a UI choice)
    await editor.post('/api/assets', { type: 'printer', name: 'muc-prn-t2', plant_id: muc.id }).expect(201);
    const audit = (await admin.get('/api/audit?q=Device%20types').expect(200)).body;
    expect(JSON.stringify(audit)).toContain('Device types');
  });

  it('rejects invalid settings', async () => {
    await admin.put('/api/settings/asset-types', { hidden: ASSET_TYPE_KEYS }).expect(400);
    await admin.put('/api/settings/asset-types', { hidden: ['toaster'] }).expect(400);
    await admin.put('/api/settings/asset-types', { customFields: { switch: [{ label: 'List', type: 'select', options: [] }] } }).expect(400);
    await admin.put('/api/settings/asset-types', { customFields: { toaster: [{ label: 'X', type: 'text' }] } }).expect(400);
  });

  it('exports and imports administrator fields', async () => {
    await admin.put('/api/settings/asset-types', { customFields: { switch: [{ key: 'custom_contract_number', label: 'Contract number', type: 'text' }] } }).expect(200);
    const csv = ['Type;Name;Plant;Contract number;Ports', 'Switch;muc-imp-custom;MUC;C-0815;8'].join('\n');
    const res = await editor.agent
      .post('/api/import/assets?dryRun=false')
      .set('x-csrf-token', editor.csrf)
      .attach('file', Buffer.from(csv), 'assets.csv')
      .expect(200);
    expect(res.body).toMatchObject({ created: 1, errors: [] });
    const created = (await viewer.get('/api/assets?q=muc-imp-custom').expect(200)).body.items[0];
    expect(created.attributes).toEqual({ port_count: 8, custom_contract_number: 'C-0815' });

    const exported = await viewer.get('/api/export/assets?type=switch&format=csv').expect(200);
    expect(exported.text.split('\n')[0]).toContain('Contract number');
  });
});

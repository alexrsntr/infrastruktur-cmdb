import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';

let app: Express;
let pool: Pool;
let admin: Session;
let editor: Session;
let viewer: Session;
let muc: { id: string };

const find = async (name: string) => (await viewer.get(`/api/assets?q=${encodeURIComponent(name)}`).expect(200)).body.items.find((a: { name: string }) => a.name === name) as { id: string };
const make = async (name: string, type = 'switch') => (await editor.post('/api/assets', { type, name, plant_id: muc.id }).expect(201)).body as { id: string };
const relate = (source: string, target: string, relation: string) => editor.post('/api/relations', { source_id: source, target_id: target, relation }).expect(201);

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  muc = ((await viewer.get('/api/plants').expect(200)).body as { id: string; code: string }[]).find((p) => p.code === 'MUC')!;
});

afterAll(async () => {
  await pool.end();
});

describe('impact analysis', () => {
  it('follows uplink, runs_on, powered_by and depends_on transitively, cycles included', async () => {
    const ups = await make('imp-ups', 'ups');
    const core = await make('imp-core');
    const access = await make('imp-access');
    const ap = await make('imp-ap', 'access_point');
    const host = await make('imp-host', 'server');
    const vm = await make('imp-vm', 'vm');
    const peer = await make('imp-peer');
    await relate(core.id, ups.id, 'powered_by');
    await relate(host.id, ups.id, 'powered_by');
    await relate(access.id, core.id, 'uplink');
    await relate(ap.id, access.id, 'uplink');
    await relate(vm.id, host.id, 'runs_on');
    await relate(core.id, peer.id, 'redundant_with');
    await relate(peer.id, core.id, 'connected_to'); // not a dependency
    await relate(ups.id, ap.id, 'depends_on'); // a (silly) cycle must not loop forever

    const appRes = (await editor.post('/api/applications', { name: 'Imp ERP', criticality: 'critical', plant_id: muc.id }).expect(201)).body;
    await editor.post(`/api/applications/${appRes.id}/assets`, { asset_id: vm.id, role: 'App server' }).expect(204);

    const impact = (await viewer.get(`/api/assets/${ups.id}/impact`).expect(200)).body;
    const byName = Object.fromEntries(impact.affected.map((a: { name: string; depth: number; via_name: string; relation: string }) => [a.name, [a.depth, a.via_name, a.relation]]));
    expect(byName).toEqual({
      'imp-core': [1, 'imp-ups', 'powered_by'],
      'imp-host': [1, 'imp-ups', 'powered_by'],
      'imp-access': [2, 'imp-core', 'uplink'],
      'imp-vm': [2, 'imp-host', 'runs_on'],
      'imp-ap': [3, 'imp-access', 'uplink'],
    });
    expect(impact.applications).toEqual([expect.objectContaining({ name: 'Imp ERP', assets: ['imp-vm'] })]);

    const coreImpact = (await viewer.get(`/api/assets/${core.id}/impact`).expect(200)).body;
    // through the cycle (UPS depends on the AP) everything fails
    expect(coreImpact.affected.map((a: { name: string }) => a.name).sort()).toEqual(['imp-access', 'imp-ap', 'imp-host', 'imp-ups', 'imp-vm']);
    expect(coreImpact.redundant).toEqual([{ id: peer.id, name: 'imp-peer' }]);

    // the application needs the VM, the host and the UPS (and everything the UPS "depends on" in this cycle)
    const detail = (await viewer.get(`/api/applications/${appRes.id}`).expect(200)).body;
    expect(detail.assets).toEqual([expect.objectContaining({ name: 'imp-vm', role: 'App server' })]);
    expect(detail.dependencies.slice(0, 2).map((d: { name: string; for_name: string }) => [d.name, d.for_name])).toEqual([
      ['imp-host', 'imp-vm'],
      ['imp-ups', 'imp-vm'],
    ]);
  });

  it('finds the seeded applications of a host', async () => {
    const host = await find('muc-esx01');
    const impact = (await viewer.get(`/api/assets/${host.id}/impact`).expect(200)).body;
    expect(impact.affected.length).toBeGreaterThan(0);
    expect(impact.affected.filter((a: { depth: number }) => a.depth === 1).every((a: { relation: string; type: string }) => a.relation === 'runs_on' && a.type === 'vm')).toBe(true);
    expect(impact.applications.length).toBeGreaterThan(0);
  });
});

describe('applications', () => {
  it('lists, filters, updates and deletes applications with audit trail', async () => {
    const list = (await viewer.get('/api/applications').expect(200)).body as { name: string; asset_count: number }[];
    expect(list.map((a) => a.name)).toEqual(expect.arrayContaining(['Active Directory', 'SAP ERP', 'MES MUC']));
    expect(list.find((a) => a.name === 'Active Directory')!.asset_count).toBe(6);

    const created = (await editor.post('/api/applications', { name: 'Ticketing', owner: 'Service Desk', url: 'https://tickets.example.com' }).expect(201)).body;
    await editor.post('/api/applications', { name: 'ticketing' }).expect(409);
    await editor.post('/api/applications', { name: 'Bad link', url: 'javascript:alert(1)' }).expect(400);
    await viewer.post('/api/applications', { name: 'Nope' }).expect(403);
    await editor.put(`/api/applications/${created.id}`, { name: 'Ticketing', owner: 'Service Desk', criticality: 'high', url: 'https://tickets.example.com' }).expect(200);

    const host = await find('muc-esx02');
    await editor.post(`/api/applications/${created.id}/assets`, { asset_id: host.id }).expect(204);
    expect((await viewer.get(`/api/applications?assetId=${host.id}`).expect(200)).body.map((a: { name: string }) => a.name)).toContain('Ticketing');
    await editor.del(`/api/applications/${created.id}/assets/${host.id}`).expect(204);

    const history = (await viewer.get(`/api/applications/${created.id}/history`).expect(200)).body.map((h: { action: string }) => h.action);
    expect(history).toEqual(expect.arrayContaining(['create', 'update', 'application.link', 'application.unlink']));
    await editor.del(`/api/applications/${created.id}`).expect(204);
    await viewer.get(`/api/applications/${created.id}`).expect(404);
    expect(admin).toBeTruthy();
  });

  it('hides applications of other plants from scoped users', async () => {
    const other = ((await viewer.get('/api/plants').expect(200)).body as { id: string; code: string }[]).find((p) => p.code !== 'MUC')!;
    await login(app, 'operator');
    const users = (await admin.get('/api/users').expect(200)).body as { id: string; display_name: string; role: string }[];
    const scopedUser = users.find((u) => u.role === 'operator')!;
    await admin.put(`/api/users/${scopedUser.id}`, { role: 'operator', plant_scope: [muc.id], active: true }).expect(200);
    const operator = await login(app, 'operator');
    const names = (await operator.get('/api/applications').expect(200)).body.map((a: { name: string }) => a.name);
    expect(names).toContain('MES MUC');
    expect(names).toContain('SAP ERP'); // central applications are visible to everyone
    const foreign = (await admin.get(`/api/applications?plantId=${other.id}`).expect(200)).body[0];
    await operator.get(`/api/applications/${foreign.id}`).expect(404);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { expandPortNames } from '../shared/network';
import { ipv4Hosts } from '../server/routes/network';
import { login, setupTestApp, type Session } from './helpers';

let app: Express;
let pool: Pool;
let editor: Session;
let viewer: Session;
let operator: Session;
let muc: { id: string };
let ber: { id: string };

const create = async (name: string, extra: Record<string, unknown> = {}) =>
  (await editor.post('/api/assets', { type: 'switch', name, plant_id: muc.id, ...extra }).expect(201)).body as { id: string; name: string };

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  editor = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  operator = await login(app, 'operator');
  const plants = (await viewer.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
  ber = plants.find((p) => p.code !== 'MUC')!;
});

afterAll(async () => {
  await pool.end();
});

describe('helpers', () => {
  it('expands port ranges', () => {
    expect(expandPortNames('Gi1/0/1-3, Te1/1/1-2; Mgmt0')).toEqual(['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3', 'Te1/1/1', 'Te1/1/2', 'Mgmt0']);
    expect(expandPortNames('port08-10')).toEqual(['port08', 'port09', 'port10']);
    expect(() => expandPortNames('Gi1/0/5-1')).toThrow();
    expect(() => expandPortNames('x1-9999')).toThrow();
  });

  it('computes IPv4 host ranges', () => {
    expect(ipv4Hosts('10.0.0.0/24')).toMatchObject({ size: 254 });
    expect(ipv4Hosts('10.0.0.0/31')).toMatchObject({ size: 2 });
    expect(ipv4Hosts('10.0.0.7/32')).toMatchObject({ size: 1 });
    expect(ipv4Hosts('2001:db8::/64')).toBeNull();
  });
});

describe('ports and cables', () => {
  let sw1: { id: string };
  let sw2: { id: string };
  let sw3: { id: string };

  it('creates ports in bulk, in natural order', async () => {
    sw1 = await create('net-sw1');
    sw2 = await create('net-sw2');
    sw3 = await create('net-sw3');
    const ports = (await editor.post(`/api/assets/${sw1.id}/ports`, { names: 'Gi1/0/1-12, Te1/1/1-2', kind: 'ethernet', untagged_vlan: 10 }).expect(201)).body;
    expect(ports.map((p: { name: string }) => p.name)).toEqual([...Array.from({ length: 12 }, (_, i) => `Gi1/0/${i + 1}`), 'Te1/1/1', 'Te1/1/2']);
    await editor.post(`/api/assets/${sw1.id}/ports`, { names: 'gi1/0/3' }).expect(409);
    await editor.post(`/api/assets/${sw1.id}/ports`, { names: 'X1, x1' }).expect(400);
    await operator.post(`/api/assets/${sw1.id}/ports`, { names: 'Gi9' }).expect(403);
    await editor.post(`/api/assets/${sw2.id}/ports`, { names: 'Te1/1/1-2' }).expect(201);
    await editor.post(`/api/assets/${sw3.id}/ports`, { names: 'Te1/1/1' }).expect(201);
  });

  const port = async (assetId: string, name: string) =>
    ((await viewer.get(`/api/assets/${assetId}/ports`).expect(200)).body as { id: string; name: string; connected_port_id: string | null; cable_label: string | null; peer_asset_name: string | null; peer_port_name: string | null }[]).find(
      (p) => p.name === name,
    )!;

  it('connects two ports symmetrically with one cable label', async () => {
    const a = await port(sw1.id, 'Te1/1/1');
    const b = await port(sw2.id, 'Te1/1/1');
    const res = (await editor.post(`/api/ports/${a.id}/connect`, { port_id: b.id, cable_label: 'K-0001' }).expect(200)).body;
    expect(res).toMatchObject({ connected_port_id: b.id, cable_label: 'K-0001', peer_asset_name: 'net-sw2', peer_port_name: 'Te1/1/1' });
    expect(await port(sw2.id, 'Te1/1/1')).toMatchObject({ connected_port_id: a.id, cable_label: 'K-0001', peer_asset_name: 'net-sw1' });

    // renaming the cable on one end renames it on both
    await editor.put(`/api/ports/${b.id}`, { name: 'Te1/1/1', kind: 'sfp', speed: '10G', cable_label: 'K-0002', tagged_vlans: [20, 10, 20] }).expect(200);
    expect(await port(sw1.id, 'Te1/1/1')).toMatchObject({ cable_label: 'K-0002' });
    const updated = await port(sw2.id, 'Te1/1/1');
    expect(updated).toMatchObject({ kind: 'sfp', speed: '10G', tagged_vlans: [10, 20] });

    const cables = (await viewer.get('/api/cables?label=k-0002').expect(200)).body;
    expect(cables.map((c: { asset_name: string }) => c.asset_name).sort()).toEqual(['net-sw1', 'net-sw2']);
  });

  it('replaces an existing connection and frees the old partner', async () => {
    const a = await port(sw1.id, 'Te1/1/1');
    const c = await port(sw3.id, 'Te1/1/1');
    await editor.post(`/api/ports/${c.id}/connect`, { port_id: a.id, cable_label: 'K-0003' }).expect(200);
    expect(await port(sw2.id, 'Te1/1/1')).toMatchObject({ connected_port_id: null, cable_label: null });
    expect(await port(sw1.id, 'Te1/1/1')).toMatchObject({ connected_port_id: c.id, cable_label: 'K-0003' });
  });

  it('rejects connecting a port to itself or to a port of the same device', async () => {
    const a = await port(sw1.id, 'Gi1/0/1');
    const b = await port(sw1.id, 'Gi1/0/2');
    await editor.post(`/api/ports/${a.id}/connect`, { port_id: a.id }).expect(400);
    await editor.post(`/api/ports/${a.id}/connect`, { port_id: b.id }).expect(400);
  });

  it('disconnects both ends, and deleting a device frees the far end', async () => {
    const a = await port(sw1.id, 'Te1/1/1');
    await editor.post(`/api/ports/${a.id}/disconnect`).expect(204);
    expect(await port(sw3.id, 'Te1/1/1')).toMatchObject({ connected_port_id: null });

    const b = await port(sw1.id, 'Te1/1/2');
    const c = await port(sw2.id, 'Te1/1/2');
    await editor.post(`/api/ports/${b.id}/connect`, { port_id: c.id }).expect(200);
    await editor.del(`/api/assets/${sw2.id}`).expect(204);
    expect(await port(sw1.id, 'Te1/1/2')).toMatchObject({ connected_port_id: null });

    const history = (await viewer.get(`/api/history?entityType=asset&entityId=${sw1.id}`).expect(200)).body.map((h: { action: string }) => h.action);
    expect(history).toEqual(expect.arrayContaining(['port.add', 'port.connect', 'port.disconnect']));
  });

  it('seeds ports and cables from the documented uplinks', async () => {
    const core = (await viewer.get('/api/assets?q=muc-core-sw01').expect(200)).body.items[0];
    const ports = (await viewer.get(`/api/assets/${core.id}/ports`).expect(200)).body;
    expect(ports.length).toBeGreaterThan(3);
    expect(ports.every((p: { connected_port_id: string | null; cable_label: string }) => p.connected_port_id && p.cable_label.startsWith('MUC-C'))).toBe(true);
  });
});

describe('VLANs and subnets (IPAM)', () => {
  let vlanId: string;
  let subnetId: string;

  it('manages VLANs per plant', async () => {
    const v = (await editor.post('/api/vlans', { plant_id: muc.id, vid: 333, name: 'Lab' }).expect(201)).body;
    vlanId = v.id;
    await editor.post('/api/vlans', { plant_id: muc.id, vid: 333, name: 'Again' }).expect(409);
    await editor.post('/api/vlans', { plant_id: ber.id, vid: 333, name: 'Lab elsewhere' }).expect(201);
    await editor.post('/api/vlans', { plant_id: muc.id, vid: 5000, name: 'Too big' }).expect(400);
    await viewer.post('/api/vlans', { plant_id: muc.id, vid: 334, name: 'Nope' }).expect(403);
    await editor.put(`/api/vlans/${v.id}`, { vid: 333, name: 'Lab network' }).expect(200);
  });

  it('normalises networks, checks the gateway and counts used addresses', async () => {
    await editor.post('/api/subnets', { plant_id: muc.id, cidr: '172.30.5.0/24', name: 'Lab', gateway: '172.30.6.1' }).expect(400);
    await editor.post('/api/subnets', { plant_id: muc.id, cidr: 'not-a-network', name: 'Lab' }).expect(400);
    await editor.post('/api/subnets', { plant_id: ber.id, cidr: '172.30.5.0/24', name: 'Lab', vlan_id: vlanId }).expect(400); // VLAN of another plant
    const s = (await editor.post('/api/subnets', { plant_id: muc.id, cidr: '172.30.5.77/24', name: 'Lab', gateway: '172.30.5.1', vlan_id: vlanId }).expect(201)).body;
    subnetId = s.id;
    expect(s).toMatchObject({ cidr: '172.30.5.0/24', gateway: '172.30.5.1', vlan_vid: 333, size: 254, used: 0, duplicates: 0 });
    await editor.post('/api/subnets', { plant_id: muc.id, cidr: '172.30.5.0/24', name: 'Twice' }).expect(409);

    await create('lab-a', { ip_address: '172.30.5.10' });
    await create('lab-b', { ip_address: '172.30.5.11/24' });
    await create('lab-c', { ip_address: '172.30.5.11' }); // duplicate
    await create('lab-d', { ip_address: '172.30.5.12', status: 'retired' }); // retired devices free their address
    await (async () => {
      const other = (await editor.post('/api/assets', { type: 'switch', name: 'lab-other-plant', plant_id: ber.id, ip_address: '172.30.5.13' }).expect(201)).body;
      return other;
    })();

    const detail = (await viewer.get(`/api/subnets/${subnetId}`).expect(200)).body;
    expect(detail).toMatchObject({ used: 2, duplicates: 1, nextFree: '172.30.5.2' });
    expect(detail.addresses.map((a: { ip: string; asset_name: string; duplicate: boolean }) => [a.ip, a.asset_name, a.duplicate])).toEqual([
      ['172.30.5.10', 'lab-a', false],
      ['172.30.5.11', 'lab-b', true],
      ['172.30.5.11', 'lab-c', true],
    ]);
    expect(detail.free).toEqual([
      { from: '172.30.5.2', to: '172.30.5.9', count: 8 },
      { from: '172.30.5.12', to: '172.30.5.254', count: 243 },
    ]);
  });

  it('shows the plant network with duplicates and addresses outside of any subnet', async () => {
    await create('lab-stray', { ip_address: '192.0.2.50' });
    const net = (await viewer.get(`/api/plants/${muc.id}/network`).expect(200)).body;
    expect(net.vlans.map((v: { vid: number }) => v.vid)).toEqual(expect.arrayContaining([10, 20, 100, 333]));
    expect(net.subnets.find((s: { cidr: string }) => s.cidr === '172.30.5.0/24')).toMatchObject({ used: 2, duplicates: 1 });
    expect(net.duplicates).toEqual([{ ip: '172.30.5.11', assets: expect.arrayContaining([expect.objectContaining({ name: 'lab-b' }), expect.objectContaining({ name: 'lab-c' })]) }]);
    expect(net.unassigned.map((a: { name: string }) => a.name)).toContain('lab-stray');
    expect(net.connections).toBeGreaterThan(5);

    const dups = (await viewer.get('/api/ipam/duplicates').expect(200)).body;
    expect(dups.map((d: { ip: string }) => d.ip)).toEqual(['172.30.5.11']);
  });

  it('deleting a VLAN keeps the subnet', async () => {
    await editor.del(`/api/vlans/${vlanId}`).expect(204);
    expect((await viewer.get(`/api/subnets/${subnetId}`).expect(200)).body).toMatchObject({ vlan_id: null });
    await editor.del(`/api/subnets/${subnetId}`).expect(204);
    await viewer.get(`/api/subnets/${subnetId}`).expect(404);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { qualityScore } from '../shared/quality';
import { login, setupTestApp, type Session } from './helpers';

let app: Express;
let pool: Pool;
let editor: Session;
let viewer: Session;
let muc: { id: string };
let building: { id: string };

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  editor = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  muc = ((await viewer.get('/api/plants').expect(200)).body as { id: string; code: string }[]).find((p) => p.code === 'MUC')!;
  building = (await viewer.get('/api/buildings').expect(200)).body.find((b: { plant_id: string }) => b.plant_id === muc.id);
});

afterAll(async () => {
  await pool.end();
});

const complete = {
  type: 'switch',
  plant_id: muc?.id,
  manufacturer: 'Cisco',
  model: 'C9300',
  owner: 'Network Team',
  warranty_end: '2030-01-01',
  support_end: '2031-01-01',
};

describe('data quality', () => {
  it('scores a device by its gaps', async () => {
    const full = (await editor.post('/api/assets', { ...complete, plant_id: muc.id, building_id: building.id, name: 'dq-full', serial_number: 'DQ-1', ip_address: '10.250.0.1', mac_address: '00:11:22:33:44:01' }).expect(201)).body;
    expect((await viewer.get(`/api/assets/${full.id}/quality`).expect(200)).body).toEqual({ score: 100, issues: [] });

    const bare = (await editor.post('/api/assets', { type: 'switch', name: 'dq-bare', plant_id: muc.id }).expect(201)).body;
    const q = (await viewer.get(`/api/assets/${bare.id}/quality`).expect(200)).body;
    expect(q.issues.sort()).toEqual(['missing_ip', 'missing_lifecycle', 'missing_location', 'missing_model', 'missing_owner', 'missing_serial', 'missing_warranty']);
    expect(q.score).toBe(qualityScore(q.issues));
    expect(q.score).toBe(100 - 15 - 15 - 10 - 10 - 10 - 10 - 5);

    // a VM needs no serial number, building or warranty
    const vm = (await editor.post('/api/assets', { type: 'vm', name: 'dq-vm', plant_id: muc.id, ip_address: '10.250.0.9', owner: 'Server Team' }).expect(201)).body;
    expect((await viewer.get(`/api/assets/${vm.id}/quality`).expect(200)).body).toEqual({ score: 100, issues: [] });
  });

  it('finds duplicates of serial number, MAC and IP address', async () => {
    const base = { ...complete, plant_id: muc.id, building_id: building.id };
    await editor.post('/api/assets', { ...base, name: 'dq-dup1', serial_number: 'dup-sn', mac_address: 'aa:bb:cc:00:00:01', ip_address: '10.250.1.1' }).expect(201);
    const b = (await editor.post('/api/assets', { ...base, name: 'dq-dup2', serial_number: 'DUP-SN', mac_address: 'AA-BB-CC-00-00-01', ip_address: '10.250.1.1/24' }).expect(201)).body;
    const q = (await viewer.get(`/api/assets/${b.id}/quality`).expect(200)).body;
    expect(q.issues).toEqual(['duplicate_serial', 'duplicate_mac', 'duplicate_ip']);

    const report = (await viewer.get(`/api/data-quality?plantId=${muc.id}`).expect(200)).body;
    expect(report.duplicates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'serial', value: 'dup-sn' }),
        expect.objectContaining({ kind: 'mac', value: 'aabbcc000001' }),
        expect.objectContaining({ kind: 'ip', value: '10.250.1.1' }),
      ]),
    );
    expect(report.counts.duplicate_serial).toBe(2);
    expect(report.total).toBeGreaterThan(10);
    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThan(100);
    // worst first
    const scores = report.assets.map((a: { score: number }) => a.score);
    expect([...scores].sort((x, y) => x - y)).toEqual(scores);

    // retired devices are not checked
    await editor.patch(`/api/assets/${b.id}/status`, { status: 'retired' }).expect(200);
    expect((await viewer.get(`/api/assets/${b.id}/quality`).expect(200)).body.issues).toEqual([]);
  });

  it('filters the device list by gap', async () => {
    const list = (await viewer.get(`/api/assets?issue=missing_owner&plantId=${muc.id}&pageSize=500`).expect(200)).body.items.map((a: { name: string }) => a.name);
    expect(list).toContain('dq-bare');
    expect(list).not.toContain('dq-full');
    await viewer.get('/api/assets?issue=nope').expect(400);
  });
});

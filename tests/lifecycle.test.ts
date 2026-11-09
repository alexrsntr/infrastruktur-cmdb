import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';

let app: Express;
let pool: Pool;
let editor: Session;
let viewer: Session;
let muc: { id: string };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  editor = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  const plants = (await viewer.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
  // a clean slate for the counts below
  await pool.query('UPDATE asset SET warranty_end = NULL, support_end = NULL, end_of_life = NULL, last_seen_at = NULL');
});

afterAll(async () => {
  await pool.end();
});

describe('lifecycle and "Needs attention"', () => {
  let ids: Record<string, string> = {};

  it('stores support end, end of life and the support contract', async () => {
    const make = async (name: string, extra: Record<string, unknown>) =>
      (await editor.post('/api/assets', { type: 'switch', name, plant_id: muc.id, ...extra }).expect(201)).body;
    const a = await make('lc-warranty-soon', { warranty_end: day(30), support_contract: 'SmartNet 8x5xNBD' });
    const b = await make('lc-warranty-gone', { warranty_end: day(-10) });
    const c = await make('lc-support-soon', { support_end: day(60), end_of_life: day(800) });
    const d = await make('lc-support-gone', { support_end: day(-1) });
    const e = await make('lc-eol', { end_of_life: day(100) });
    const f = await make('lc-retired', { end_of_life: day(-100), status: 'retired' });
    const g = await make('lc-fine', { warranty_end: day(400), support_end: day(900), end_of_life: day(2000) });
    ids = { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id, f: f.id, g: g.id };
    expect(a).toMatchObject({ warranty_end: day(30), support_contract: 'SmartNet 8x5xNBD' });
    expect(c).toMatchObject({ support_end: day(60), end_of_life: day(800) });
    await pool.query(`UPDATE asset SET last_seen_at = now() - interval '40 days' WHERE id = $1`, [g.id]);
  });

  it('counts the reasons and lists the most urgent devices first (retired devices excluded)', async () => {
    const res = (await viewer.get(`/api/attention?plantId=${muc.id}&limit=50`).expect(200)).body;
    expect(res.counts).toEqual({ warranty_expiring: 1, warranty_expired: 1, support_ending: 1, support_ended: 1, eol: 1, not_seen: 1 });
    expect(res.total).toBe(6);
    const names = res.items.map((i: { name: string }) => i.name);
    expect(names).not.toContain('lc-retired');
    // sorted by the most urgent date: not seen 40 days ago, warranty ended 10 days ago, support ended yesterday …
    expect(names.slice(0, 3)).toEqual(['lc-fine', 'lc-warranty-gone', 'lc-support-gone']);
    expect(res.items.find((i: { name: string }) => i.name === 'lc-fine').kinds).toEqual(['not_seen']);
  });

  it('filters the device list by reason', async () => {
    const list = async (attention: string) =>
      (await viewer.get(`/api/assets?attention=${attention}&pageSize=100`).expect(200)).body.items.map((a: { name: string }) => a.name).sort();
    expect(await list('warranty_expiring')).toEqual(['lc-warranty-soon']);
    expect(await list('support_ending,support_ended')).toEqual(['lc-support-gone', 'lc-support-soon']);
    expect(await list('eol')).toEqual(['lc-eol']);
    expect(await list('not_seen')).toEqual(['lc-fine']);
    await viewer.get('/api/assets?attention=nonsense').expect(400);
  });

  it('exports and imports the lifecycle columns', async () => {
    const exported = await viewer.get('/api/export/assets?q=lc-support-soon&format=csv').expect(200);
    const [header] = exported.text.replace(/^﻿/, '').split(/\r?\n/);
    expect(header).toContain('Support end');
    expect(header).toContain('End of life');
    const csv = ['Type;Name;Plant;Support end;End of life;Support contract', `Switch;lc-import;MUC;31.12.2030;30.06.2032;Vendor 24x7`].join('\n');
    const res = await editor.agent.post('/api/import/assets?dryRun=false').set('x-csrf-token', editor.csrf).attach('file', Buffer.from(csv), 'lc.csv').expect(200);
    expect(res.body).toMatchObject({ created: 1, errors: [] });
    const created = (await viewer.get('/api/assets?q=lc-import').expect(200)).body.items[0];
    expect(created).toMatchObject({ support_end: '2030-12-31', end_of_life: '2032-06-30', support_contract: 'Vendor 24x7' });
  });

  it('can be limited to one plant', async () => {
    const other = (await viewer.get('/api/plants').expect(200)).body.find((p: { code: string }) => p.code !== 'MUC');
    const res = (await viewer.get(`/api/attention?plantId=${other.id}`).expect(200)).body;
    expect(res.total).toBe(0);
  });
});

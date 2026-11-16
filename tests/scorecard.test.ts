import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';
import type { Scorecard, ScorecardSummary, WanLine } from '../shared/scorecard';

let app: Express;
let pool: Pool;
let admin: Session;
let editor: Session;
let local: Session;
let viewer: Session;
let muc: { id: string };
let ham: { id: string };

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  local = await login(app, 'local');
  viewer = await login(app, 'viewer');
  const plants = (await admin.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
  ham = plants.find((p) => p.code === 'HAM')!;
});

afterAll(async () => {
  await pool.end();
});

describe('plant scorecard', () => {
  it('is empty at first and only administrators can create it', async () => {
    const empty = (await viewer.get(`/api/plants/${muc.id}/scorecard`).expect(200)).body as Scorecard;
    expect(empty).toMatchObject({ items: [], average: null, points: 0, max_points: 0 });
    const body = { items: [{ category: 'WAN', score: 5, comment: null }] };
    await editor.put(`/api/plants/${muc.id}/scorecard`, body).expect(403);
    await local.put(`/api/plants/${muc.id}/scorecard`, body).expect(403);
    await viewer.put(`/api/plants/${muc.id}/scorecard`, body).expect(403);
  });

  it('rates every area with 1–5 points and sums them up', async () => {
    const card = (
      await admin
        .put(`/api/plants/${muc.id}/scorecard`, {
          items: [
            { category: 'WAN', score: 5, comment: 'MPLS + LIA, both lines redundant' },
            { category: 'Switches', score: 3, comment: 'Two access switches out of support' },
            { category: 'Racks', score: 4 },
            { category: 'Documentation', score: null },
          ],
        })
        .expect(200)
    ).body as Scorecard;
    expect(card.items.map((i) => [i.category, i.score])).toEqual([
      ['WAN', 5],
      ['Switches', 3],
      ['Racks', 4],
      ['Documentation', null],
    ]);
    expect(card).toMatchObject({ points: 12, max_points: 15, average: 4, rated: 3, updated_by_name: 'Anna Admin' });

    // everyone with access to the plant sees it – local administrators too, but not outside their plants
    expect(((await local.get(`/api/plants/${muc.id}/scorecard`).expect(200)).body as Scorecard).items).toHaveLength(4);
    await local.get(`/api/plants/${ham.id}/scorecard`).expect(403);

    const summaries = (await viewer.get('/api/scorecards').expect(200)).body as ScorecardSummary[];
    expect(summaries.find((s) => s.plant_id === muc.id)).toMatchObject({ points: 12, max_points: 15, average: 4, areas: 4 });
    const localSummaries = (await local.get('/api/scorecards').expect(200)).body as ScorecardSummary[];
    expect(localSummaries.every((s) => s.plant_id === muc.id)).toBe(true);
  });

  it('changes, renames and removes areas and writes the change log', async () => {
    const card = (
      await admin
        .put(`/api/plants/${muc.id}/scorecard`, {
          items: [
            { category: 'Switches', score: 4, comment: 'Replaced' },
            { category: 'WAN', score: 5, comment: 'MPLS + LIA, both lines redundant' },
            { category: 'Cabling', score: 2 },
          ],
        })
        .expect(200)
    ).body as Scorecard;
    expect(card.items.map((i) => i.category)).toEqual(['Switches', 'WAN', 'Cabling']);
    expect(card.average).toBe(3.7);

    const { rows } = await pool.query(`SELECT action, changes FROM audit_log WHERE entity_type = 'plant' AND entity_id = $1 AND action LIKE 'scorecard.%' ORDER BY id`, [muc.id]);
    expect(rows.map((r) => r.action)).toEqual(['scorecard.create', 'scorecard.update']);
    expect(rows[1].changes.Switches).toEqual({ from: '3/5 – Two access switches out of support', to: '4/5 – Replaced' });
    expect(rows[1].changes.Racks).toEqual({ from: '4/5', to: null });
    expect(rows[1].changes.WAN).toBeUndefined();

    await admin.put(`/api/plants/${muc.id}/scorecard`, { items: [{ category: 'WAN', score: 5 }, { category: 'wan', score: 4 }] }).expect(400);
    await admin.put(`/api/plants/${muc.id}/scorecard`, { items: [{ category: 'WAN', score: 6 }] }).expect(400);
  });

  it('can be deleted by administrators only', async () => {
    await editor.del(`/api/plants/${muc.id}/scorecard`).expect(403);
    await admin.del(`/api/plants/${muc.id}/scorecard`).expect(204);
    expect(((await viewer.get(`/api/plants/${muc.id}/scorecard`).expect(200)).body as Scorecard).items).toEqual([]);
  });
});

describe('WAN lines', () => {
  let line: WanLine;

  it('are added by editors and listed per plant', async () => {
    const body = { plant_id: muc.id, name: 'First line', technology: 'MPLS', provider: 'IntraSelect FixConnect', bandwidth: 'Ethernet' };
    await local.post('/api/wan-lines', body).expect(403);
    await viewer.post('/api/wan-lines', body).expect(403);
    line = (await editor.post('/api/wan-lines', body).expect(201)).body;
    await editor.post('/api/wan-lines', { plant_id: muc.id, name: 'Third line', technology: 'LIA (Internet)', provider: 'Claro', bandwidth: '100 Mbit', contract_end: '2027-06-30' }).expect(201);
    const lines = (await viewer.get(`/api/plants/${muc.id}/wan-lines`).expect(200)).body as WanLine[];
    expect(lines.map((l) => [l.name, l.technology, l.provider, l.bandwidth])).toEqual([
      ['First line', 'MPLS', 'IntraSelect FixConnect', 'Ethernet'],
      ['Third line', 'LIA (Internet)', 'Claro', '100 Mbit'],
    ]);
    expect(lines[1].contract_end).toBe('2027-06-30');
    await local.get(`/api/plants/${ham.id}/wan-lines`).expect(403);
  });

  it('are changed by local administrators, removed by editors only', async () => {
    const changed = (await local.put(`/api/wan-lines/${line.id}`, { ...line, bandwidth: '1 Gbit' }).expect(200)).body as WanLine;
    expect(changed.bandwidth).toBe('1 Gbit');
    await local.del(`/api/wan-lines/${line.id}`).expect(403);
    await editor.del(`/api/wan-lines/${line.id}`).expect(204);
    const { rows } = await pool.query(`SELECT action FROM audit_log WHERE entity_type = 'plant' AND entity_id = $1 AND action LIKE 'wan.%' ORDER BY id`, [muc.id]);
    expect(rows.map((r) => r.action)).toEqual(['wan.add', 'wan.add', 'wan.update', 'wan.remove']);
  });
});

import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { MAX_SCORECARD_AREAS, summarizeScores, type Scorecard, type ScorecardItem, type ScorecardSummary, type WanLine } from '../../shared/scorecard';
import { requirePermission } from '../auth/context';
import { withTransaction, type DbClient } from '../db/pool';
import { audit, diff, snapshot } from '../lib/audit';
import { badRequest, notFound, parse, requireUuid, SqlBuilder } from '../lib/http';
import { optDate, optText, reqText } from '../lib/schemas';
import { applyScope, assertPlantAccess } from '../lib/scope';

const scorecardSchema = z.object({
  items: z
    .array(
      z.object({
        category: reqText(80),
        score: z.number().int().min(1).max(5).nullish().transform((v) => v ?? null),
        comment: optText(2000),
      }),
    )
    .max(MAX_SCORECARD_AREAS),
});

const wanLineSchema = z.object({
  plant_id: z.string().uuid(),
  name: reqText(100),
  technology: optText(100),
  provider: optText(200),
  bandwidth: optText(100),
  circuit_id: optText(200),
  contract_end: optDate,
  note: optText(2000),
  position: z.number().int().min(0).max(1000).optional(),
});

async function plantLabel(db: DbClient, plantId: string): Promise<string> {
  const { rows } = await db.query<{ label: string }>(`SELECT code || ' – ' || name AS label FROM plant WHERE id = $1`, [plantId]);
  if (!rows[0]) throw notFound('Plant');
  return rows[0].label;
}

export async function loadScorecard(db: DbClient, plantId: string): Promise<Scorecard> {
  const { rows } = await db.query<ScorecardItem>(
    `SELECT s.id, s.category, s.score, s.comment, s.position, s.updated_at, u.display_name AS updated_by_name
     FROM plant_score s LEFT JOIN app_user u ON u.id = s.updated_by
     WHERE s.plant_id = $1 ORDER BY s.position, lower(s.category)`,
    [plantId],
  );
  const latest = rows.reduce<ScorecardItem | null>((a, b) => (!a || new Date(b.updated_at) > new Date(a.updated_at) ? b : a), null);
  return {
    plant_id: plantId,
    items: rows,
    ...summarizeScores(rows.map((r) => r.score)),
    updated_at: latest?.updated_at ?? null,
    updated_by_name: latest?.updated_by_name ?? null,
  };
}

const WAN_SELECT = `id, plant_id, name, technology, provider, bandwidth, circuit_id, contract_end::text AS contract_end, note, position, created_at, updated_at`;

async function loadWanLine(db: DbClient, id: string): Promise<WanLine> {
  const { rows } = await db.query<WanLine>(`SELECT ${WAN_SELECT} FROM wan_line WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound('WAN line');
  return rows[0];
}

/** Scorecards of the plants (rated by administrators) and the WAN lines of a plant. */
export function scorecardsRouter(pool: Pool): Router {
  const r = Router();

  // ---------------------------------------------------------------- scorecard
  r.get('/plants/:id/scorecard', async (req, res) => {
    const plantId = requireUuid(req.params.id);
    assertPlantAccess(req.user!, plantId);
    await plantLabel(pool, plantId);
    res.json(await loadScorecard(pool, plantId));
  });

  /** Create or change the scorecard: the list of areas replaces the stored one (administrators only). */
  r.put('/plants/:id/scorecard', requirePermission('scorecard.manage'), async (req, res) => {
    const plantId = requireUuid(req.params.id);
    const input = parse(scorecardSchema, req.body);
    const seen = new Set<string>();
    for (const item of input.items) {
      const key = item.category.toLowerCase();
      if (seen.has(key)) throw badRequest(`The area "${item.category}" appears twice`);
      seen.add(key);
    }
    const card = await withTransaction(pool, async (db) => {
      const label = await plantLabel(db, plantId);
      const before = await loadScorecard(db, plantId);
      const byCategory = new Map(before.items.map((i) => [i.category.toLowerCase(), i]));
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const text = (i: { score: number | null; comment: string | null } | undefined) =>
        i ? [i.score != null ? `${i.score}/5` : 'not rated', i.comment].filter(Boolean).join(' – ') : null;

      await db.query('DELETE FROM plant_score WHERE plant_id = $1 AND NOT (lower(category) = ANY($2::text[]))', [plantId, [...seen]]);
      for (const [position, item] of input.items.entries()) {
        const old = byCategory.get(item.category.toLowerCase());
        const unchanged = old && old.score === item.score && (old.comment ?? null) === item.comment && old.category === item.category;
        if (old) {
          await db.query(
            unchanged
              ? 'UPDATE plant_score SET position = $2 WHERE id = $1'
              : 'UPDATE plant_score SET category = $3, score = $4, comment = $5, position = $2, updated_by = $6, updated_at = now() WHERE id = $1',
            unchanged ? [old.id, position] : [old.id, position, item.category, item.score, item.comment, req.user!.id],
          );
        } else {
          await db.query('INSERT INTO plant_score (plant_id, category, score, comment, position, updated_by) VALUES ($1,$2,$3,$4,$5,$6)', [
            plantId,
            item.category,
            item.score,
            item.comment,
            position,
            req.user!.id,
          ]);
        }
        if (!unchanged) changes[item.category] = { from: text(old), to: text(item) };
      }
      for (const old of before.items) if (!seen.has(old.category.toLowerCase())) changes[old.category] = { from: text(old), to: null };

      const after = await loadScorecard(db, plantId);
      if (Object.keys(changes).length) {
        if (after.average !== before.average) changes['Average'] = { from: before.average, to: after.average };
        await audit(db, req, { action: before.items.length ? 'scorecard.update' : 'scorecard.create', entityType: 'plant', entityId: plantId, entityLabel: label, plantId, changes });
      }
      return after;
    });
    res.json(card);
  });

  r.delete('/plants/:id/scorecard', requirePermission('scorecard.manage'), async (req, res) => {
    const plantId = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const label = await plantLabel(db, plantId);
      const { rowCount } = await db.query('DELETE FROM plant_score WHERE plant_id = $1', [plantId]);
      if (rowCount) await audit(db, req, { action: 'scorecard.delete', entityType: 'plant', entityId: plantId, entityLabel: label, plantId, changes: { areas: rowCount } });
    });
    res.status(204).end();
  });

  /** Total score of every visible plant (plant list) */
  r.get('/scorecards', async (req, res) => {
    const sql = new SqlBuilder();
    applyScope(sql, req.user!, 's.plant_id');
    const { rows } = await pool.query<{ plant_id: string; scores: (number | null)[]; updated_at: string }>(
      `SELECT s.plant_id, array_agg(s.score) AS scores, max(s.updated_at) AS updated_at
       FROM plant_score s ${sql.whereSql()} GROUP BY s.plant_id`,
      sql.params,
    );
    const body: ScorecardSummary[] = rows.map((r) => ({ plant_id: r.plant_id, ...summarizeScores(r.scores), areas: r.scores.length, updated_at: r.updated_at }));
    res.json(body);
  });

  // ---------------------------------------------------------------- WAN lines
  r.get('/plants/:id/wan-lines', async (req, res) => {
    const plantId = requireUuid(req.params.id);
    assertPlantAccess(req.user!, plantId);
    const { rows } = await pool.query(`SELECT ${WAN_SELECT} FROM wan_line WHERE plant_id = $1 ORDER BY position, created_at`, [plantId]);
    res.json(rows);
  });

  r.post('/wan-lines', requirePermission('asset.write'), async (req, res) => {
    const input = parse(wanLineSchema, req.body);
    assertPlantAccess(req.user!, input.plant_id);
    const line = await withTransaction(pool, async (db) => {
      const label = await plantLabel(db, input.plant_id);
      const position = input.position ?? (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM wan_line WHERE plant_id = $1', [input.plant_id])).rows[0].n;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO wan_line (plant_id, name, technology, provider, bandwidth, circuit_id, contract_end, note, position, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
        [input.plant_id, input.name, input.technology, input.provider, input.bandwidth, input.circuit_id, input.contract_end, input.note, position, req.user!.id],
      );
      const created = await loadWanLine(db, rows[0].id);
      await audit(db, req, { action: 'wan.add', entityType: 'plant', entityId: input.plant_id, entityLabel: label, plantId: input.plant_id, changes: { line: created.name, ...snapshot({ technology: created.technology, provider: created.provider, bandwidth: created.bandwidth }) } });
      return created;
    });
    res.status(201).json(line);
  });

  r.put('/wan-lines/:id', requirePermission('asset.edit'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(wanLineSchema, req.body);
    const line = await withTransaction(pool, async (db) => {
      const before = await loadWanLine(db, id);
      assertPlantAccess(req.user!, before.plant_id);
      if (input.plant_id !== before.plant_id) throw badRequest('A WAN line cannot be moved to another plant');
      await db.query(
        `UPDATE wan_line SET name=$2, technology=$3, provider=$4, bandwidth=$5, circuit_id=$6, contract_end=$7, note=$8, position=COALESCE($9, position),
           updated_by=$10, updated_at=now() WHERE id=$1`,
        [id, input.name, input.technology, input.provider, input.bandwidth, input.circuit_id, input.contract_end, input.note, input.position ?? null, req.user!.id],
      );
      const after = await loadWanLine(db, id);
      const changes = diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
      delete changes.position;
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'wan.update', entityType: 'plant', entityId: before.plant_id, entityLabel: await plantLabel(db, before.plant_id), plantId: before.plant_id, changes: { line: after.name, ...changes } });
      return after;
    });
    res.json(line);
  });

  r.delete('/wan-lines/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const before = await loadWanLine(db, id);
      assertPlantAccess(req.user!, before.plant_id);
      await db.query('DELETE FROM wan_line WHERE id = $1', [id]);
      await audit(db, req, { action: 'wan.remove', entityType: 'plant', entityId: before.plant_id, entityLabel: await plantLabel(db, before.plant_id), plantId: before.plant_id, changes: { line: before.name } });
    });
    res.status(204).end();
  });

  return r;
}

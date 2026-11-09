import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { APP_STATUSES, type Application, type ApplicationDetail } from '../../shared/applications';
import { CRITICALITIES, type CurrentUser } from '../../shared/model';
import { requirePermission } from '../auth/context';
import { withTransaction, type DbClient } from '../db/pool';
import { audit, diff, snapshot } from '../lib/audit';
import { conflict, likePattern, notFound, parse, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { optText, optUuid, reqText } from '../lib/schemas';
import { assertPlantAccess, hasPlantAccess, isUnscoped } from '../lib/scope';
import { impactOf, walkDependencies } from '../services/impact';

const applicationSchema = z.object({
  name: reqText(200),
  status: z.enum(APP_STATUSES).default('production'),
  criticality: z.enum(CRITICALITIES).default('medium'),
  plant_id: optUuid,
  owner: optText(200),
  url: optText(500).refine((v) => !v || /^https?:\/\//i.test(v), 'The link must start with http:// or https://'),
  description: optText(8000),
});

const linkSchema = z.object({ asset_id: z.string().uuid(), role: optText(100) });

const APP_SELECT = `ap.id, ap.name, ap.status, ap.criticality, ap.plant_id, p.code AS plant_code, p.name AS plant_name, ap.owner, ap.url, ap.description,
  ap.created_at, ap.updated_at, (SELECT count(*) FROM application_asset aa WHERE aa.application_id = ap.id) AS asset_count`;
const APP_FROM = `FROM application ap LEFT JOIN plant p ON p.id = ap.plant_id`;

/** Applications without a plant (central services) are visible to everyone, the others only within the plant scope. */
function scopeApps(sql: SqlBuilder, user: CurrentUser) {
  if (isUnscoped(user)) return;
  sql.and(`(ap.plant_id IS NULL OR ap.plant_id = ANY(${sql.p(user.plantScope)}::uuid[]))`);
}

async function loadApp(db: DbClient, user: CurrentUser, id: string): Promise<Application> {
  const { rows } = await db.query(`SELECT ${APP_SELECT} ${APP_FROM} WHERE ap.id = $1`, [id]);
  const app = rows[0];
  if (!app || (app.plant_id && !hasPlantAccess(user, app.plant_id))) throw notFound('Application');
  return app;
}

const uniqueName = (e: { code?: string }, name: string) => {
  if (e.code === '23505') throw conflict(`An application named "${name}" already exists`);
  throw e;
};

export function applicationsRouter(pool: Pool): Router {
  const r = Router();

  r.get('/applications', async (req, res) => {
    const sql = new SqlBuilder();
    scopeApps(sql, req.user!);
    const q = queryString(req.query.q);
    if (q) sql.and(`(ap.name ILIKE ${sql.p(likePattern(q))} OR ap.owner ILIKE $${sql.params.length} OR ap.description ILIKE $${sql.params.length})`);
    const plantId = queryString(req.query.plantId);
    if (plantId) sql.and(`ap.plant_id = ${sql.p(requireUuid(plantId, 'plantId'))}`);
    const assetId = queryString(req.query.assetId);
    if (assetId) sql.and(`EXISTS (SELECT 1 FROM application_asset aa WHERE aa.application_id = ap.id AND aa.asset_id = ${sql.p(requireUuid(assetId, 'assetId'))})`);
    const { rows } = await pool.query(
      `SELECT ${APP_SELECT} ${APP_FROM} ${sql.whereSql()}
       ORDER BY array_position(ARRAY['critical','high','medium','low'], ap.criticality), lower(ap.name)`,
      sql.params,
    );
    res.json(rows);
  });

  r.get('/applications/:id', async (req, res) => {
    const user = req.user!;
    const app = await loadApp(pool, user, requireUuid(req.params.id));
    const { rows: assets } = await pool.query(
      `SELECT a.id AS asset_id, a.name, a.type, a.status, a.criticality, p.code AS plant_code, a.ip_address, aa.role, a.plant_id
       FROM application_asset aa JOIN asset a ON a.id = aa.asset_id LEFT JOIN plant p ON p.id = a.plant_id
       WHERE aa.application_id = $1 ORDER BY a.name`,
      [app.id],
    );
    const visible = assets.filter((a) => hasPlantAccess(user, a.plant_id));
    const deps = await walkDependencies(pool, assets.map((a) => a.asset_id), 'dependencies');
    const names = new Map(assets.map((a) => [a.asset_id, a.name]));
    const body: ApplicationDetail = {
      ...app,
      assets: visible.map(({ plant_id: _p, ...a }) => a),
      dependencies: deps
        .filter((d) => hasPlantAccess(user, d.plant_id))
        .map(({ plant_id: _p, start_id, ...d }) => ({ ...d, for_name: names.get(start_id) ?? '' })),
    };
    res.json(body);
  });

  r.post('/applications', requirePermission('asset.write'), async (req, res) => {
    const input = parse(applicationSchema, req.body);
    assertPlantAccess(req.user!, input.plant_id);
    const row = await withTransaction(pool, async (db) => {
      const { rows } = await db
        .query(
          `INSERT INTO application (name, status, criticality, plant_id, owner, url, description, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
          [input.name, input.status, input.criticality, input.plant_id, input.owner, input.url, input.description, req.user!.id],
        )
        .catch((e) => uniqueName(e, input.name));
      const created = await loadApp(db, req.user!, rows[0].id);
      await audit(db, req, { action: 'create', entityType: 'application', entityId: created.id, entityLabel: created.name, plantId: created.plant_id, changes: snapshot(input) });
      return created;
    });
    res.status(201).json(row);
  });

  r.put('/applications/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(applicationSchema, req.body);
    const row = await withTransaction(pool, async (db) => {
      const before = await loadApp(db, req.user!, id);
      assertPlantAccess(req.user!, before.plant_id);
      assertPlantAccess(req.user!, input.plant_id);
      await db
        .query(
          `UPDATE application SET name=$2, status=$3, criticality=$4, plant_id=$5, owner=$6, url=$7, description=$8, updated_by=$9, updated_at=now() WHERE id=$1`,
          [id, input.name, input.status, input.criticality, input.plant_id, input.owner, input.url, input.description, req.user!.id],
        )
        .catch((e) => uniqueName(e, input.name));
      const after = await loadApp(db, req.user!, id);
      const changes = diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
      delete changes.asset_count;
      if (Object.keys(changes).length) await audit(db, req, { action: 'update', entityType: 'application', entityId: id, entityLabel: after.name, plantId: after.plant_id, changes });
      return after;
    });
    res.json(row);
  });

  r.delete('/applications/:id', requirePermission('asset.delete'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const before = await loadApp(db, req.user!, id);
      assertPlantAccess(req.user!, before.plant_id);
      await db.query('DELETE FROM application WHERE id = $1', [id]);
      await audit(db, req, { action: 'delete', entityType: 'application', entityId: id, entityLabel: before.name, plantId: before.plant_id, changes: { name: before.name } });
    });
    res.status(204).end();
  });

  r.post('/applications/:id/assets', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(linkSchema, req.body);
    await withTransaction(pool, async (db) => {
      const app = await loadApp(db, req.user!, id);
      assertPlantAccess(req.user!, app.plant_id);
      const { rows } = await db.query('SELECT id, name, plant_id FROM asset WHERE id = $1', [input.asset_id]);
      if (!rows[0]) throw notFound('Asset');
      assertPlantAccess(req.user!, rows[0].plant_id);
      await db.query(
        `INSERT INTO application_asset (application_id, asset_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (application_id, asset_id) DO UPDATE SET role = EXCLUDED.role`,
        [id, input.asset_id, input.role],
      );
      await audit(db, req, { action: 'application.link', entityType: 'application', entityId: id, entityLabel: app.name, plantId: app.plant_id, changes: { device: rows[0].name, role: input.role } });
      await audit(db, req, { action: 'application.link', entityType: 'asset', entityId: rows[0].id, entityLabel: rows[0].name, plantId: rows[0].plant_id, changes: { application: app.name, role: input.role } });
    });
    res.status(204).end();
  });

  r.delete('/applications/:id/assets/:assetId', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const assetId = requireUuid(req.params.assetId);
    await withTransaction(pool, async (db) => {
      const app = await loadApp(db, req.user!, id);
      assertPlantAccess(req.user!, app.plant_id);
      const { rows } = await db.query('SELECT a.id, a.name, a.plant_id FROM application_asset aa JOIN asset a ON a.id = aa.asset_id WHERE aa.application_id = $1 AND aa.asset_id = $2', [id, assetId]);
      if (!rows[0]) throw notFound('Link');
      assertPlantAccess(req.user!, rows[0].plant_id);
      await db.query('DELETE FROM application_asset WHERE application_id = $1 AND asset_id = $2', [id, assetId]);
      await audit(db, req, { action: 'application.unlink', entityType: 'application', entityId: id, entityLabel: app.name, plantId: app.plant_id, changes: { device: rows[0].name } });
      await audit(db, req, { action: 'application.unlink', entityType: 'asset', entityId: rows[0].id, entityLabel: rows[0].name, plantId: rows[0].plant_id, changes: { application: app.name } });
    });
    res.status(204).end();
  });

  r.get('/applications/:id/history', async (req, res) => {
    const app = await loadApp(pool, req.user!, requireUuid(req.params.id));
    const { rows } = await pool.query(
      `SELECT id::text, at, user_id, user_name, action, entity_type, entity_id, entity_label, changes, NULL AS ip
       FROM audit_log WHERE entity_type = 'application' AND entity_id = $1 ORDER BY at DESC LIMIT 200`,
      [app.id],
    );
    res.json(rows);
  });

  /** "If this device fails" */
  r.get('/assets/:id/impact', async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query('SELECT plant_id FROM asset WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Asset');
    assertPlantAccess(req.user!, rows[0].plant_id);
    res.json(await impactOf(pool, req.user!, id));
  });

  return r;
}

import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { CurrentUser } from '../../shared/model';
import { requirePermission } from '../auth/context';
import { withTransaction, type DbClient } from '../db/pool';
import { audit } from '../lib/audit';
import { badRequest, notFound, parse, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { optUuid } from '../lib/schemas';
import { applyScope, assertPlantAccess, resolveEntity } from '../lib/scope';
import { ENTITY_LABEL_SQL } from './journal';

/**
 * Plans = image attachments flagged `is_plan` (site plans, aerial photos, hall pictures …).
 * Devices, buildings or free labels are placed on them as markers with normalised coordinates.
 */

const PLAN_SELECT = `
  a.id, a.entity_type, a.entity_id, ${ENTITY_LABEL_SQL('a')} AS entity_label, a.plant_id, a.file_name, a.content_type, a.size_bytes,
  a.category, a.title, a.description, a.image_width, a.image_height, a.is_plan, a.created_by, u.display_name AS created_by_name,
  a.created_at, a.updated_at, (SELECT count(*) FROM plan_marker m WHERE m.attachment_id = a.id) AS marker_count`;
const PLAN_FROM = `FROM attachment a LEFT JOIN app_user u ON u.id = a.created_by`;

const MARKER_SELECT = `
  m.id, m.attachment_id, m.asset_id, m.building_id, m.label, m.x, m.y,
  s.name AS asset_name, s.type AS asset_type, s.status AS asset_status, s.ip_address AS asset_ip, s.model AS asset_model,
  b.name AS building_name, b.code AS building_code`;
const MARKER_FROM = `FROM plan_marker m LEFT JOIN asset s ON s.id = m.asset_id LEFT JOIN building b ON b.id = m.building_id`;

const markerSchema = z
  .object({
    asset_id: optUuid,
    building_id: optUuid,
    label: z
      .string()
      .trim()
      .max(80)
      .nullish()
      .transform((v) => (v ? v : null)),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .refine((m) => [m.asset_id, m.building_id, m.label].filter(Boolean).length === 1, 'A marker needs exactly one of: device, building or label');

const markerUpdateSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  label: z
    .string()
    .trim()
    .max(80)
    .nullish()
    .transform((v) => (v ? v : null)),
});

async function loadPlan(db: DbClient, id: string, user: CurrentUser) {
  const { rows } = await db.query(`SELECT ${PLAN_SELECT} ${PLAN_FROM} WHERE a.id = $1`, [id]);
  const plan = rows[0];
  if (!plan || !plan.is_plan) throw notFound('Plan');
  assertPlantAccess(user, plan.plant_id);
  return plan;
}

async function loadMarker(db: DbClient, id: string) {
  const { rows } = await db.query(`SELECT ${MARKER_SELECT}, a.plant_id AS plan_plant_id, a.entity_type AS plan_entity_type, a.entity_id AS plan_entity_id,
      COALESCE(a.title, a.file_name) AS plan_title
    ${MARKER_FROM} JOIN attachment a ON a.id = m.attachment_id WHERE m.id = $1`, [id]);
  if (!rows[0]) throw notFound('Marker');
  return rows[0];
}

function markerLabel(m: { asset_name?: string | null; building_name?: string | null; label?: string | null }) {
  return m.asset_name ?? m.building_name ?? m.label ?? 'marker';
}

/** Audit marker changes on the device (so it shows in its history) or else on the object owning the plan */
async function auditMarker(db: DbClient, req: Parameters<typeof audit>[1], action: string, plan: { entity_type: string; entity_id: string; plant_id: string | null; title: string }, marker: { asset_id?: string | null; asset_name?: string | null; building_name?: string | null; label?: string | null }, extra?: Record<string, unknown>) {
  const changes = { plan: plan.title, marker: markerLabel(marker), ...extra };
  if (marker.asset_id) {
    await audit(db, req, { action, entityType: 'asset', entityId: marker.asset_id, entityLabel: marker.asset_name ?? null, plantId: plan.plant_id, changes });
  } else {
    const ref = await resolveEntity(db, plan.entity_type as never, plan.entity_id).catch(() => null);
    await audit(db, req, { action, entityType: plan.entity_type, entityId: plan.entity_id, entityLabel: ref?.label ?? null, plantId: plan.plant_id, changes });
  }
}

export function plansRouter(pool: Pool): Router {
  const r = Router();

  /** Plans of a plant (all objects in it) or of a single object */
  r.get('/plans', async (req, res) => {
    const sql = new SqlBuilder();
    sql.and('a.is_plan');
    applyScope(sql, req.user!, 'a.plant_id');
    const plantId = queryString(req.query.plantId);
    const entityType = queryString(req.query.entityType);
    const entityId = queryString(req.query.entityId);
    if (plantId) sql.and(`a.plant_id = ${sql.p(requireUuid(plantId, 'plantId'))}`);
    if (entityType) sql.and(`a.entity_type = ${sql.p(entityType)}`);
    if (entityId) sql.and(`a.entity_id = ${sql.p(requireUuid(entityId, 'entityId'))}`);
    const { rows } = await pool.query(
      `SELECT ${PLAN_SELECT} ${PLAN_FROM} ${sql.whereSql()}
       ORDER BY CASE a.entity_type WHEN 'plant' THEN 0 WHEN 'building' THEN 1 ELSE 2 END, COALESCE(a.title, a.file_name)`,
      sql.params,
    );
    res.json(rows);
  });

  r.get('/plans/:id', async (req, res) => {
    const id = requireUuid(req.params.id);
    const plan = await loadPlan(pool, id, req.user!);
    const { rows } = await pool.query(`SELECT ${MARKER_SELECT} ${MARKER_FROM} WHERE m.attachment_id = $1 ORDER BY m.created_at`, [id]);
    res.json({ ...plan, markers: rows });
  });

  r.post('/plans/:id/markers', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(markerSchema, req.body);
    const marker = await withTransaction(pool, async (db) => {
      const plan = await loadPlan(db, id, req.user!);
      const title = plan.title ?? plan.file_name;
      if (input.asset_id) {
        const { rows } = await db.query('SELECT id, name, plant_id FROM asset WHERE id = $1', [input.asset_id]);
        if (!rows[0]) throw badRequest('Device does not exist');
        assertPlantAccess(req.user!, rows[0].plant_id);
        if (plan.plant_id && rows[0].plant_id !== plan.plant_id) throw badRequest(`${rows[0].name} belongs to another plant`);
      }
      if (input.building_id) {
        const { rows } = await db.query('SELECT id, name, plant_id FROM building WHERE id = $1', [input.building_id]);
        if (!rows[0]) throw badRequest('Building does not exist');
        if (plan.plant_id && rows[0].plant_id !== plan.plant_id) throw badRequest(`${rows[0].name} belongs to another plant`);
      }
      const { rows } = await db.query(
        `INSERT INTO plan_marker (attachment_id, asset_id, building_id, label, x, y, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [id, input.asset_id, input.building_id, input.label, input.x, input.y, req.user!.id],
      );
      const full = await loadMarker(db, rows[0].id);
      await auditMarker(db, req, 'plan.marker.add', { ...plan, title }, full);
      return full;
    });
    res.status(201).json(marker);
  });

  r.patch('/plan-markers/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(markerUpdateSchema, req.body);
    const marker = await withTransaction(pool, async (db) => {
      const before = await loadMarker(db, id);
      assertPlantAccess(req.user!, before.plan_plant_id);
      if (input.label && !before.label) throw badRequest('Only free text markers have a label');
      await db.query('UPDATE plan_marker SET x = $2, y = $3, label = COALESCE($4, label), updated_at = now() WHERE id = $1', [id, input.x, input.y, before.label ? input.label : null]);
      const after = await loadMarker(db, id);
      await auditMarker(
        db,
        req,
        'plan.marker.move',
        { entity_type: before.plan_entity_type, entity_id: before.plan_entity_id, plant_id: before.plan_plant_id, title: before.plan_title },
        after,
        before.label && after.label !== before.label ? { label: { from: before.label, to: after.label } } : undefined,
      );
      return after;
    });
    res.json(marker);
  });

  r.delete('/plan-markers/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const m = await loadMarker(db, id);
      assertPlantAccess(req.user!, m.plan_plant_id);
      await db.query('DELETE FROM plan_marker WHERE id = $1', [id]);
      await auditMarker(db, req, 'plan.marker.remove', { entity_type: m.plan_entity_type, entity_id: m.plan_entity_id, plant_id: m.plan_plant_id, title: m.plan_title }, m);
    });
    res.status(204).end();
  });

  /** Plans on which a device is shown (asset page) */
  r.get('/assets/:id/plans', async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows: assets } = await pool.query('SELECT plant_id FROM asset WHERE id = $1', [id]);
    if (!assets[0]) throw notFound('Asset');
    assertPlantAccess(req.user!, assets[0].plant_id);
    const { rows } = await pool.query(
      `SELECT m.id AS marker_id, a.id, COALESCE(a.title, a.file_name) AS title, a.entity_type, ${ENTITY_LABEL_SQL('a')} AS entity_label
       FROM plan_marker m JOIN attachment a ON a.id = m.attachment_id WHERE m.asset_id = $1 ORDER BY 3`,
      [id],
    );
    res.json(rows);
  });

  return r;
}

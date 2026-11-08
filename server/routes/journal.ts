import { Router } from 'express';
import type { Pool } from 'pg';
import { ACTIVITY_KINDS, ACTIVITY_STATUSES, ENTITY_TYPES, can, type EntityType } from '../../shared/model';
import { requirePermission } from '../auth/context';
import { audit, diff } from '../lib/audit';
import { badRequest, clampInt, forbidden, isUuid, likePattern, notFound, parse, queryList, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { activitySchema, activityUpdateSchema, noteSchema, noteUpdateSchema } from '../lib/schemas';
import { applyScope, assertPlantAccess, isUnscoped, resolveEntityWithAccess } from '../lib/scope';
import type { CurrentUser } from '../../shared/model';

/** SQL expression producing a readable label for the entity a note/activity is attached to */
export const ENTITY_LABEL_SQL = (alias: string) => `
  CASE ${alias}.entity_type
    WHEN 'plant' THEN (SELECT x.code || ' – ' || x.name FROM plant x WHERE x.id = ${alias}.entity_id)
    WHEN 'building' THEN (SELECT x.name FROM building x WHERE x.id = ${alias}.entity_id)
    WHEN 'floor' THEN (SELECT b.name || ' / ' || x.name FROM floor x JOIN building b ON b.id = x.building_id WHERE x.id = ${alias}.entity_id)
    WHEN 'rack' THEN (SELECT b.name || ' / ' || x.name FROM rack x JOIN building b ON b.id = x.building_id WHERE x.id = ${alias}.entity_id)
    WHEN 'asset' THEN (SELECT x.name FROM asset x WHERE x.id = ${alias}.entity_id)
  END`;

function entityFilter(sql: SqlBuilder, query: Record<string, unknown>, alias: string) {
  const entityType = queryString(query.entityType);
  const entityId = queryString(query.entityId);
  if (entityType) {
    if (!ENTITY_TYPES.includes(entityType as EntityType)) throw badRequest('Invalid entityType');
    sql.and(`${alias}.entity_type = ${sql.p(entityType)}`);
  }
  if (entityId) sql.and(`${alias}.entity_id = ${sql.p(requireUuid(entityId, 'entityId'))}`);
  const plantId = queryString(query.plantId);
  if (plantId) sql.and(`${alias}.plant_id = ${sql.p(requireUuid(plantId, 'plantId'))}`);
}

export function buildActivityQuery(user: CurrentUser, query: Record<string, unknown>) {
  const sql = new SqlBuilder();
  applyScope(sql, user, 'act.plant_id');
  entityFilter(sql, query, 'act');
  const statuses = queryList(query.status);
  const kinds = queryList(query.kind);
  for (const s of statuses) if (!ACTIVITY_STATUSES.includes(s as never)) throw badRequest(`Unknown status "${s}"`);
  for (const k of kinds) if (!ACTIVITY_KINDS.includes(k as never)) throw badRequest(`Unknown kind "${k}"`);
  if (statuses.length) sql.and(`act.status = ANY(${sql.p(statuses)}::text[])`);
  if (kinds.length) sql.and(`act.kind = ANY(${sql.p(kinds)}::text[])`);
  if (queryString(query.open) === 'true') sql.and(`act.status IN ('planned','open','in_progress')`);
  if (queryString(query.overdue) === 'true') sql.and(`act.status IN ('planned','open','in_progress') AND act.due_date < CURRENT_DATE`);
  const q = queryString(query.q);
  if (q) {
    const like = sql.p(likePattern(q));
    sql.and(`(act.title ILIKE ${like} OR act.description ILIKE ${like} OR act.assignee ILIKE ${like})`);
  }
  return sql;
}

export const ACTIVITY_SELECT = `
  act.id, act.entity_type, act.entity_id, ${ENTITY_LABEL_SQL('act')} AS entity_label, act.plant_id, p.name AS plant_name,
  act.kind, act.status, act.title, act.description, act.assignee, act.due_date, act.completed_at,
  act.created_by, u.display_name AS created_by_name, act.created_at, act.updated_at`;
export const ACTIVITY_FROM = `FROM activity act LEFT JOIN plant p ON p.id = act.plant_id LEFT JOIN app_user u ON u.id = act.created_by`;
export const ACTIVITY_ORDER = `ORDER BY CASE WHEN act.status IN ('done','cancelled') THEN 1 ELSE 0 END, act.due_date ASC NULLS LAST, act.created_at DESC`;

export const NOTE_SELECT = `
  n.id, n.entity_type, n.entity_id, ${ENTITY_LABEL_SQL('n')} AS entity_label, n.plant_id, n.body, n.pinned,
  n.created_by, u.display_name AS created_by_name, n.created_at, n.updated_at`;
export const NOTE_FROM = `FROM note n LEFT JOIN app_user u ON u.id = n.created_by`;

export function journalRouter(pool: Pool): Router {
  const r = Router();

  // ----------------------------------------------------------------- notes
  r.get('/notes', async (req, res) => {
    const sql = new SqlBuilder();
    applyScope(sql, req.user!, 'n.plant_id');
    entityFilter(sql, req.query, 'n');
    const q = queryString(req.query.q);
    if (q) sql.and(`n.body ILIKE ${sql.p(likePattern(q))}`);
    const limit = clampInt(req.query.limit, 200, 1, 1000);
    const { rows } = await pool.query(
      `SELECT ${NOTE_SELECT} ${NOTE_FROM} ${sql.whereSql()} ORDER BY n.pinned DESC, n.created_at DESC LIMIT ${limit}`,
      sql.params,
    );
    res.json(rows);
  });

  r.post('/notes', requirePermission('note.write'), async (req, res) => {
    const input = parse(noteSchema, req.body);
    const ref = await resolveEntityWithAccess(pool, req.user!, input.entity_type, input.entity_id);
    const { rows } = await pool.query(
      `INSERT INTO note (entity_type, entity_id, plant_id, body, pinned, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.entity_type, input.entity_id, ref.plantId, input.body, input.pinned, req.user!.id],
    );
    await audit(pool, req, { action: 'note.add', entityType: input.entity_type, entityId: input.entity_id, entityLabel: ref.label, plantId: ref.plantId, changes: { note: input.body.slice(0, 200) } });
    const full = await pool.query(`SELECT ${NOTE_SELECT} ${NOTE_FROM} WHERE n.id = $1`, [rows[0].id]);
    res.status(201).json(full.rows[0]);
  });

  async function loadNote(id: string, user: CurrentUser) {
    const { rows } = await pool.query('SELECT * FROM note WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Note');
    assertPlantAccess(user, rows[0].plant_id);
    // Authors may change their own notes; administrators may change any note
    if (rows[0].created_by !== user.id && !can(user.role, 'user.manage')) throw forbidden('Only the author or an administrator can change this note');
    return rows[0];
  }

  r.put('/notes/:id', requirePermission('note.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(noteUpdateSchema, req.body);
    const before = await loadNote(id, req.user!);
    await pool.query('UPDATE note SET body = $2, pinned = $3, updated_at = now() WHERE id = $1', [id, input.body, input.pinned]);
    const ref = await resolveEntityWithAccess(pool, req.user!, before.entity_type, before.entity_id).catch(() => null);
    await audit(pool, req, { action: 'note.update', entityType: before.entity_type, entityId: before.entity_id, entityLabel: ref?.label, plantId: before.plant_id, changes: diff({ body: before.body, pinned: before.pinned }, input) });
    const full = await pool.query(`SELECT ${NOTE_SELECT} ${NOTE_FROM} WHERE n.id = $1`, [id]);
    res.json(full.rows[0]);
  });

  r.delete('/notes/:id', requirePermission('note.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const before = await loadNote(id, req.user!);
    await pool.query('DELETE FROM note WHERE id = $1', [id]);
    await audit(pool, req, { action: 'note.delete', entityType: before.entity_type, entityId: before.entity_id, plantId: before.plant_id, changes: { note: String(before.body).slice(0, 200) } });
    res.status(204).end();
  });

  // ------------------------------------------------------------ activities
  r.get('/activities', async (req, res) => {
    const sql = buildActivityQuery(req.user!, req.query);
    const pageSize = clampInt(req.query.pageSize, 100, 1, 1000);
    const page = clampInt(req.query.page, 1, 1, 100000);
    const [items, total] = await Promise.all([
      pool.query(`SELECT ${ACTIVITY_SELECT} ${ACTIVITY_FROM} ${sql.whereSql()} ${ACTIVITY_ORDER} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, sql.params),
      pool.query(`SELECT count(*) AS n FROM activity act ${sql.whereSql()}`, sql.params),
    ]);
    res.json({ items: items.rows, total: total.rows[0].n });
  });

  r.post('/activities', requirePermission('activity.write'), async (req, res) => {
    const input = parse(activitySchema, req.body);
    const ref = await resolveEntityWithAccess(pool, req.user!, input.entity_type, input.entity_id);
    const { rows } = await pool.query(
      `INSERT INTO activity (entity_type, entity_id, plant_id, kind, status, title, description, assignee, due_date, completed_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $5 = 'done' THEN now() END, $10) RETURNING id`,
      [input.entity_type, input.entity_id, ref.plantId, input.kind, input.status, input.title, input.description, input.assignee, input.due_date, req.user!.id],
    );
    await audit(pool, req, { action: 'activity.add', entityType: input.entity_type, entityId: input.entity_id, entityLabel: ref.label, plantId: ref.plantId, changes: { kind: input.kind, title: input.title, status: input.status } });
    const full = await pool.query(`SELECT ${ACTIVITY_SELECT} ${ACTIVITY_FROM} WHERE act.id = $1`, [rows[0].id]);
    res.status(201).json(full.rows[0]);
  });

  r.put('/activities/:id', requirePermission('activity.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(activityUpdateSchema, req.body);
    const { rows: beforeRows } = await pool.query('SELECT * FROM activity WHERE id = $1', [id]);
    const before = beforeRows[0];
    if (!before) throw notFound('Activity');
    assertPlantAccess(req.user!, before.plant_id);
    await pool.query(
      `UPDATE activity SET kind=$2, status=$3, title=$4, description=$5, assignee=$6, due_date=$7, updated_at=now(),
         completed_at = CASE WHEN $3 = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END
       WHERE id = $1`,
      [id, input.kind, input.status, input.title, input.description, input.assignee, input.due_date],
    );
    const changes = diff(before, input);
    if (Object.keys(changes).length)
      await audit(pool, req, { action: 'activity.update', entityType: before.entity_type, entityId: before.entity_id, entityLabel: input.title, plantId: before.plant_id, changes });
    const full = await pool.query(`SELECT ${ACTIVITY_SELECT} ${ACTIVITY_FROM} WHERE act.id = $1`, [id]);
    res.json(full.rows[0]);
  });

  r.delete('/activities/:id', requirePermission('activity.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query('SELECT * FROM activity WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Activity');
    assertPlantAccess(req.user!, rows[0].plant_id);
    if (rows[0].created_by !== req.user!.id && !can(req.user!.role, 'asset.delete'))
      throw forbidden('Only the author, editors or administrators can delete this activity');
    await pool.query('DELETE FROM activity WHERE id = $1', [id]);
    await audit(pool, req, { action: 'activity.delete', entityType: rows[0].entity_type, entityId: rows[0].entity_id, entityLabel: rows[0].title, plantId: rows[0].plant_id, changes: { title: rows[0].title } });
    res.status(204).end();
  });

  // --------------------------------------------------------------- timeline
  /**
   * Activity log: notes, activities, changes, files and plan placements of one object in one list
   * (newest first). Without entityType/entityId: recent activity across all plants the user may see.
   */
  r.get('/timeline', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const entityType = queryString(req.query.entityType);
    const entityId = queryString(req.query.entityId);
    const HIDDEN = `('note.add','note.update','note.delete','activity.add','activity.delete','login','logout','export','seed','settings.update','user.update','user.create','import')`;
    const AUDIT_KIND = `CASE WHEN l.action LIKE 'attachment.%' THEN 'file' WHEN l.action LIKE 'plan.marker.%' THEN 'placement' ELSE 'change' END`;

    if (entityType || entityId) {
      if (!entityType || !ENTITY_TYPES.includes(entityType as EntityType) || !isUuid(entityId)) throw badRequest('entityType and entityId are required');
      await resolveEntityWithAccess(pool, req.user!, entityType as EntityType, entityId);
      const { rows } = await pool.query(
        `SELECT * FROM (
           SELECT 'note' AS kind, n.id::text AS id, n.created_at AS at, n.created_by AS user_id, u.display_name AS user_name, NULL AS action,
                  NULL AS title, n.body, NULL AS activity_kind, NULL AS activity_status, NULL::date AS due_date, n.pinned, NULL::jsonb AS changes
           FROM note n LEFT JOIN app_user u ON u.id = n.created_by WHERE n.entity_type = $1 AND n.entity_id = $2
           UNION ALL
           SELECT 'activity', act.id::text, act.created_at, act.created_by, u.display_name, NULL, act.title, act.description, act.kind, act.status, act.due_date, false, NULL
           FROM activity act LEFT JOIN app_user u ON u.id = act.created_by WHERE act.entity_type = $1 AND act.entity_id = $2
           UNION ALL
           SELECT ${AUDIT_KIND}, 'a' || l.id, l.at, l.user_id, l.user_name, l.action, NULL, NULL, NULL, NULL, NULL, false, l.changes
           FROM audit_log l WHERE l.entity_type = $1 AND l.entity_id = $2 AND l.action NOT IN ${HIDDEN}
         ) t ORDER BY at DESC LIMIT ${limit}`,
        [entityType, entityId],
      );
      return res.json(rows);
    }

    // Global feed for the home page
    const ns = new SqlBuilder();
    applyScope(ns, req.user!, 'n.plant_id');
    const as = new SqlBuilder();
    as.params = ns.params; // share the parameter list
    applyScope(as, req.user!, 'act.plant_id');
    const ls = new SqlBuilder();
    ls.params = ns.params;
    applyScope(ls, req.user!, 'l.plant_id');
    if (!isUnscoped(req.user!)) ls.and('l.plant_id IS NOT NULL');
    const and = (b: SqlBuilder) => (b.where.length ? `AND ${b.where.join(' AND ')}` : '');
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT 'note' AS kind, n.id::text AS id, n.created_at AS at, n.created_by AS user_id, u.display_name AS user_name, NULL AS action,
                NULL AS title, n.body, NULL AS activity_kind, NULL AS activity_status, NULL::date AS due_date, n.pinned, NULL::jsonb AS changes,
                n.entity_type, n.entity_id::text, ${ENTITY_LABEL_SQL('n')} AS entity_label
         FROM note n LEFT JOIN app_user u ON u.id = n.created_by WHERE true ${and(ns)}
         UNION ALL
         SELECT 'activity', act.id::text, act.created_at, act.created_by, u.display_name, NULL, act.title, act.description, act.kind, act.status, act.due_date, false, NULL,
                act.entity_type, act.entity_id::text, ${ENTITY_LABEL_SQL('act')}
         FROM activity act LEFT JOIN app_user u ON u.id = act.created_by WHERE true ${and(as)}
         UNION ALL
         SELECT ${AUDIT_KIND}, 'a' || l.id, l.at, l.user_id, l.user_name, l.action, NULL, NULL, NULL, NULL, NULL, false, l.changes,
                l.entity_type, l.entity_id::text, l.entity_label
         FROM audit_log l WHERE l.action NOT IN ${HIDDEN} AND l.entity_type IN ('plant','building','floor','rack','asset') ${and(ls)}
       ) t ORDER BY at DESC LIMIT ${limit}`,
      ns.params,
    );
    res.json(rows);
  });

  // --------------------------------------------------------------- history
  r.get('/history', async (req, res) => {
    const entityType = queryString(req.query.entityType);
    const entityId = queryString(req.query.entityId);
    if (!entityType || !ENTITY_TYPES.includes(entityType as EntityType) || !isUuid(entityId)) throw badRequest('entityType and entityId are required');
    await resolveEntityWithAccess(pool, req.user!, entityType as EntityType, entityId);
    const limit = clampInt(req.query.limit, 200, 1, 1000);
    const { rows } = await pool.query(
      `SELECT id::text, at, user_id, user_name, action, entity_type, entity_id, entity_label, changes, NULL AS ip
       FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY at DESC LIMIT ${limit}`,
      [entityType, entityId],
    );
    res.json(rows);
  });

  return r;
}

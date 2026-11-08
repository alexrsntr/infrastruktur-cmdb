import { Router } from 'express';
import type { Pool } from 'pg';
import { requirePermission } from '../auth/context';
import { audit, diff } from '../lib/audit';
import { badRequest, clampInt, likePattern, notFound, parse, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { userCreateSchema, userUpdateSchema } from '../lib/schemas';

export function buildAuditQuery(query: Record<string, unknown>) {
  const sql = new SqlBuilder();
  const action = queryString(query.action);
  const entityType = queryString(query.entityType);
  const userId = queryString(query.userId);
  const plantId = queryString(query.plantId);
  const from = queryString(query.from);
  const to = queryString(query.to);
  const q = queryString(query.q);
  if (action) sql.and(`l.action = ${sql.p(action)}`);
  if (entityType) sql.and(`l.entity_type = ${sql.p(entityType)}`);
  if (userId) sql.and(`l.user_id = ${sql.p(requireUuid(userId, 'userId'))}`);
  if (plantId) sql.and(`l.plant_id = ${sql.p(requireUuid(plantId, 'plantId'))}`);
  if (from) sql.and(`l.at >= ${sql.p(from)}::timestamptz`);
  if (to) sql.and(`l.at < (${sql.p(to)}::date + 1)`);
  if (q) {
    const like = sql.p(likePattern(q));
    sql.and(`(l.entity_label ILIKE ${like} OR l.user_name ILIKE ${like} OR l.changes::text ILIKE ${like})`);
  }
  return sql;
}

export const AUDIT_SELECT = `l.id::text, l.at, l.user_id, l.user_name, l.action, l.entity_type, l.entity_id, l.entity_label, l.changes, l.ip`;

export function adminRouter(pool: Pool): Router {
  const r = Router();

  // -------------------------------------------------------------- users
  r.get('/users', requirePermission('user.manage'), async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, oid, email, display_name, role, role_source, plant_scope, active, last_login_at, created_at
       FROM app_user ORDER BY active DESC, display_name`,
    );
    res.json(rows);
  });

  r.post('/users', requirePermission('user.manage'), async (req, res) => {
    const input = parse(userCreateSchema, req.body);
    const exists = await pool.query('SELECT 1 FROM app_user WHERE lower(email) = $1', [input.email]);
    if (exists.rows[0]) throw badRequest('A user with this e-mail address already exists');
    const { rows } = await pool.query(
      `INSERT INTO app_user (email, display_name, role, role_source, plant_scope) VALUES ($1,$2,$3,'local',$4::uuid[])
       RETURNING id, oid, email, display_name, role, role_source, plant_scope, active, last_login_at, created_at`,
      [input.email, input.display_name, input.role, input.plant_scope],
    );
    await audit(pool, req, { action: 'user.create', entityType: 'user', entityId: rows[0].id, entityLabel: input.display_name, changes: { email: input.email, role: input.role, plant_scope: input.plant_scope } });
    res.status(201).json(rows[0]);
  });

  r.put('/users/:id', requirePermission('user.manage'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(userUpdateSchema, req.body);
    const { rows: beforeRows } = await pool.query('SELECT * FROM app_user WHERE id = $1', [id]);
    const before = beforeRows[0];
    if (!before) throw notFound('User');
    if (id === req.user!.id && (input.role !== 'admin' || !input.active)) throw badRequest('You cannot remove your own administrator access');
    // A role managed by an Entra app role assignment would be overwritten at the next login – keep it read-only here.
    const role = before.role_source === 'entra' ? before.role : input.role;
    if (before.role_source === 'entra' && input.role !== before.role)
      throw badRequest('This role is assigned via an Entra ID app role. Change the assignment in Entra ID (Enterprise applications).');
    const { rows } = await pool.query(
      `UPDATE app_user SET role = $2, plant_scope = $3::uuid[], active = $4, updated_at = now() WHERE id = $1
       RETURNING id, oid, email, display_name, role, role_source, plant_scope, active, last_login_at, created_at`,
      [id, role, input.plant_scope, input.active],
    );
    if (!input.active) await pool.query(`DELETE FROM user_session WHERE sess->>'userId' = $1`, [id]);
    const changes = diff({ role: before.role, plant_scope: before.plant_scope, active: before.active }, { role, plant_scope: input.plant_scope, active: input.active });
    if (Object.keys(changes).length)
      await audit(pool, req, { action: 'user.update', entityType: 'user', entityId: id, entityLabel: before.display_name, changes });
    res.json(rows[0]);
  });

  // -------------------------------------------------------------- audit log
  r.get('/audit', requirePermission('audit.read'), async (req, res) => {
    const sql = buildAuditQuery(req.query);
    const pageSize = clampInt(req.query.pageSize, 100, 1, 1000);
    const page = clampInt(req.query.page, 1, 1, 100000);
    const [items, total] = await Promise.all([
      pool.query(`SELECT ${AUDIT_SELECT} FROM audit_log l ${sql.whereSql()} ORDER BY l.at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, sql.params),
      pool.query(`SELECT count(*) AS n FROM audit_log l ${sql.whereSql()}`, sql.params),
    ]);
    res.json({ items: items.rows, total: total.rows[0].n });
  });

  r.get('/audit/actions', requirePermission('audit.read'), async (_req, res) => {
    const { rows } = await pool.query('SELECT DISTINCT action FROM audit_log ORDER BY action');
    res.json(rows.map((x) => x.action));
  });

  return r;
}

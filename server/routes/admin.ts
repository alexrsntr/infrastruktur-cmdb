import { Router } from 'express';
import type { Pool } from 'pg';
import { requirePermission } from '../auth/context';
import { audit, diff } from '../lib/audit';
import { badRequest, clampInt, likePattern, notFound, parse, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { ownPasswordSchema, userCreateSchema, userPasswordSchema, userUpdateSchema } from '../lib/schemas';
import { hashPassword, verifyPassword } from '../auth/password';

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

const USER_COLUMNS = 'id, oid, email, display_name, role, role_source, role_detail, plant_scope, active, last_login_at, created_at, (password_hash IS NOT NULL) AS has_password';

export function adminRouter(pool: Pool): Router {
  const r = Router();

  // -------------------------------------------------------------- users
  r.get('/users', requirePermission('user.manage'), async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT ${USER_COLUMNS} FROM app_user ORDER BY active DESC, display_name`,
    );
    res.json(rows);
  });

  r.post('/users', requirePermission('user.manage'), async (req, res) => {
    const input = parse(userCreateSchema, req.body);
    const exists = await pool.query('SELECT 1 FROM app_user WHERE lower(email) = $1', [input.email]);
    if (exists.rows[0]) throw badRequest('A user with this e-mail address already exists');
    const { rows } = await pool.query(
      `INSERT INTO app_user (email, display_name, role, role_source, plant_scope, password_hash, password_changed_at)
       VALUES ($1,$2,$3,'local',$4::uuid[],$5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)
       RETURNING ${USER_COLUMNS}`,
      [input.email, input.display_name, input.role, input.plant_scope, input.password ? await hashPassword(input.password) : null],
    );
    await audit(pool, req, { action: 'user.create', entityType: 'user', entityId: rows[0].id, entityLabel: input.display_name, changes: { email: input.email, role: input.role, plant_scope: input.plant_scope, password_set: !!input.password } });
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
    const role = before.role_source === 'local' ? input.role : before.role;
    if (before.role_source === 'entra' && input.role !== before.role)
      throw badRequest('This role is assigned via an Entra ID app role. Change the assignment in Entra ID (Enterprise applications).');
    // Role and plant scope of group-managed users follow the Entra group mapping (updated at every sign-in).
    const sameScope = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
    if (before.role_source === 'group' && (input.role !== before.role || !sameScope(input.plant_scope, before.plant_scope ?? [])))
      throw badRequest(`Role and plant scope come from the Entra group mapping (${before.role_detail ?? 'group'}). Change the mapping under Users & permissions → Microsoft Entra ID.`);
    const plantScope = before.role_source === 'group' ? (before.plant_scope ?? []) : input.plant_scope;
    const { rows } = await pool.query(
      `UPDATE app_user SET role = $2, plant_scope = $3::uuid[], active = $4, updated_at = now() WHERE id = $1
       RETURNING ${USER_COLUMNS}`,
      [id, role, plantScope, input.active],
    );
    if (!input.active) await pool.query(`DELETE FROM user_session WHERE sess->>'userId' = $1`, [id]);
    const changes = diff({ role: before.role, plant_scope: before.plant_scope, active: before.active }, { role, plant_scope: plantScope, active: input.active });
    if (Object.keys(changes).length)
      await audit(pool, req, { action: 'user.update', entityType: 'user', entityId: id, entityLabel: before.display_name, changes });
    res.json(rows[0]);
  });

  /** Set or reset the password of a local account (AUTH_MODE=local); signs the user out everywhere. */
  r.put('/users/:id/password', requirePermission('user.manage'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(userPasswordSchema, req.body);
    const { rows } = await pool.query<{ display_name: string }>(
      'UPDATE app_user SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1 RETURNING display_name',
      [id, await hashPassword(input.password)],
    );
    if (!rows[0]) throw notFound('User');
    if (id !== req.user!.id) await pool.query(`DELETE FROM user_session WHERE sess->>'userId' = $1`, [id]);
    await audit(pool, req, { action: 'user.password', entityType: 'user', entityId: id, entityLabel: rows[0].display_name, changes: { password: 'set by administrator' } });
    res.json({ ok: true });
  });

  /** Every signed-in user with a local account can change their own password. */
  r.post('/me/password', async (req, res) => {
    const input = parse(ownPasswordSchema, req.body);
    const { rows } = await pool.query<{ password_hash: string | null }>('SELECT password_hash FROM app_user WHERE id = $1', [req.user!.id]);
    if (!rows[0]?.password_hash) throw badRequest('Your account signs in with Microsoft Entra ID and has no password here.');
    if (!(await verifyPassword(input.current_password, rows[0].password_hash))) throw badRequest('The current password is incorrect.');
    await pool.query('UPDATE app_user SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1', [
      req.user!.id,
      await hashPassword(input.new_password),
    ]);
    // sign out all other sessions of this user
    await pool.query(`DELETE FROM user_session WHERE sess->>'userId' = $1 AND sid <> $2`, [req.user!.id, req.sessionID]);
    await audit(pool, req, { action: 'user.password', entityType: 'user', entityId: req.user!.id, entityLabel: req.user!.displayName, changes: { password: 'changed by user' } });
    res.json({ ok: true });
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

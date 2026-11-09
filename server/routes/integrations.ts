import crypto from 'node:crypto';
import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { MONITORING_STATUSES, type ApiTokenCreated, type ApiTokenDto, type WebhookDto } from '../../shared/integrations';
import { ROLES } from '../../shared/model';
import type { Config } from '../config';
import { API_TOKEN_PREFIX, hashApiToken, requirePermission, requireSession } from '../auth/context';
import { withTransaction, type DbClient } from '../db/pool';
import { audit, diff } from '../lib/audit';
import { badRequest, clampInt, conflict, notFound, parse, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { optText, reqText } from '../lib/schemas';
import { applyScope, assertPlantAccess } from '../lib/scope';
import { decryptSecret, encryptSecret } from '../lib/secrets';
import { postWebhook, type FetchLike } from '../services/webhooks';

const tokenSchema = z.object({
  name: reqText(100),
  role: z.enum(ROLES),
  plant_scope: z.array(z.string().uuid()).max(500).default([]),
  expires_in_days: z.number().int().min(1).max(3650).nullish(),
});

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Enter a full http:// or https:// address');

const eventPattern = z.string().trim().regex(/^(\*|[a-z_]+(\.[a-z_.]+)?(\.\*)?)$/, 'Invalid event filter');

const webhookSchema = z.object({
  name: reqText(100),
  url: httpUrl,
  events: z.array(eventPattern).min(1).max(30),
  active: z.boolean().default(true),
});

const refSchema = z.object({
  system: reqText(50),
  ref: reqText(200),
  url: optText(2000).refine((v) => !v || /^https?:\/\//i.test(v), 'The link must start with http:// or https://'),
  title: optText(300),
  status: optText(50),
});

const monitoringSchema = z.object({
  status: z.enum(MONITORING_STATUSES),
  message: optText(500),
  source: optText(50),
});

const bulkMonitoringSchema = z.object({
  source: optText(50),
  items: z
    .array(
      z
        .object({
          id: z.string().uuid().optional(),
          name: z.string().trim().max(200).optional(),
          ip: z.string().trim().max(64).optional(),
          status: z.enum(MONITORING_STATUSES),
          message: optText(500),
        })
        .refine((i) => i.id || i.name || i.ip, 'Each item needs id, name or ip'),
    )
    .min(1)
    .max(2000),
});

const TOKEN_SELECT = `t.id, t.name, u.role, u.plant_scope, t.token_prefix, t.expires_at, t.last_used_at, t.last_used_ip, t.revoked_at, t.created_at,
  cu.display_name AS created_by_name`;
const TOKEN_FROM = `FROM api_token t JOIN app_user u ON u.id = t.user_id LEFT JOIN app_user cu ON cu.id = t.created_by`;

const WEBHOOK_SELECT = `w.id, w.name, w.url, w.events, w.active, w.last_delivery_at, w.last_status, w.created_at,
  (SELECT count(*) FROM webhook_delivery d WHERE d.webhook_id = w.id AND d.status = 'pending') AS pending,
  (SELECT count(*) FROM webhook_delivery d WHERE d.webhook_id = w.id AND d.status = 'failed') AS failed`;

const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;

async function loadAssetForAccess(db: DbClient, user: Express.Request['user'], id: string) {
  const { rows } = await db.query('SELECT id, name, plant_id, monitoring_status FROM asset WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Asset');
  assertPlantAccess(user!, rows[0].plant_id);
  return rows[0];
}

/** Stores a monitoring result; audit entry (and webhook event) only when the status changes */
async function applyMonitoring(db: DbClient, req: Parameters<typeof audit>[1], asset: { id: string; name: string; plant_id: string | null; monitoring_status: string | null }, status: string, message: string | null, source: string | null) {
  await db.query(
    `UPDATE asset SET monitoring_status = $2, monitoring_message = $3, monitoring_source = $4, monitoring_checked_at = now(),
            last_seen_at = CASE WHEN $2 IN ('up','warning') THEN now() ELSE last_seen_at END
     WHERE id = $1`,
    [asset.id, status, message, source],
  );
  if (asset.monitoring_status !== status)
    await audit(db, req, { action: 'monitoring', entityType: 'asset', entityId: asset.id, entityLabel: asset.name, plantId: asset.plant_id, changes: { monitoring: { from: asset.monitoring_status, to: status }, message, source } });
}

export function integrationsRouter(pool: Pool, config: Config, deps: { fetch?: FetchLike } = {}): Router {
  const r = Router();
  const fetchImpl = deps.fetch ?? (fetch as unknown as FetchLike);

  // ---------------------------------------------------------------- API tokens (administrators, signed in)
  const admin = [requireSession, requirePermission('settings.manage')];

  r.get('/settings/api-tokens', ...admin, async (_req, res) => {
    const { rows } = await pool.query<ApiTokenDto>(`SELECT ${TOKEN_SELECT} ${TOKEN_FROM} ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC`);
    res.json(rows);
  });

  r.post('/settings/api-tokens', ...admin, async (req, res) => {
    const input = parse(tokenSchema, req.body);
    const token = `${API_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    const created = await withTransaction(pool, async (db) => {
      const exists = await db.query('SELECT 1 FROM api_token WHERE lower(name) = lower($1) AND revoked_at IS NULL', [input.name]);
      if (exists.rows[0]) throw conflict(`An active token named "${input.name}" already exists`);
      const { rows: users } = await db.query(
        `INSERT INTO app_user (display_name, role, role_source, plant_scope, is_service) VALUES ($1, $2, 'local', $3::uuid[], true) RETURNING id`,
        [`API: ${input.name}`, input.role, input.role === 'admin' ? [] : input.plant_scope],
      );
      const { rows } = await db.query(
        `INSERT INTO api_token (user_id, name, token_hash, token_prefix, expires_at, created_by)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END, $6) RETURNING id`,
        [users[0].id, input.name, hashApiToken(token), token.slice(0, API_TOKEN_PREFIX.length + 6), input.expires_in_days ?? null, req.user!.id],
      );
      await audit(db, req, { action: 'token.create', entityType: 'settings', entityLabel: 'API tokens', changes: { name: input.name, role: input.role, plant_scope: input.plant_scope, expires_in_days: input.expires_in_days ?? null } });
      return (await db.query<ApiTokenDto>(`SELECT ${TOKEN_SELECT} ${TOKEN_FROM} WHERE t.id = $1`, [rows[0].id])).rows[0];
    });
    const body: ApiTokenCreated = { ...created, token };
    res.status(201).json(body);
  });

  r.delete('/settings/api-tokens/:id', ...admin, async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const { rows } = await db.query('SELECT id, name, user_id, revoked_at FROM api_token WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw notFound('API token');
      if (rows[0].revoked_at) return;
      await db.query('UPDATE api_token SET revoked_at = now() WHERE id = $1', [id]);
      await db.query('UPDATE app_user SET active = false WHERE id = $1', [rows[0].user_id]);
      await audit(db, req, { action: 'token.revoke', entityType: 'settings', entityLabel: 'API tokens', changes: { name: rows[0].name } });
    });
    res.status(204).end();
  });

  // ---------------------------------------------------------------- webhooks
  r.get('/settings/webhooks', ...admin, async (_req, res) => {
    const { rows } = await pool.query<WebhookDto>(`SELECT ${WEBHOOK_SELECT} FROM webhook w ORDER BY w.name`);
    res.json(rows);
  });

  r.post('/settings/webhooks', ...admin, async (req, res) => {
    const input = parse(webhookSchema, req.body);
    const secret = newSecret();
    const { rows } = await pool.query(
      `INSERT INTO webhook (name, url, secret_enc, events, active, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.name, input.url, encryptSecret(config, secret), [...new Set(input.events)], input.active, req.user!.id],
    );
    await audit(pool, req, { action: 'webhook.create', entityType: 'settings', entityLabel: 'Webhooks', changes: { name: input.name, url: input.url, events: input.events } });
    const hook = (await pool.query(`SELECT ${WEBHOOK_SELECT} FROM webhook w WHERE w.id = $1`, [rows[0].id])).rows[0];
    res.status(201).json({ ...hook, secret });
  });

  r.put('/settings/webhooks/:id', ...admin, async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(webhookSchema, req.body);
    const before = (await pool.query('SELECT name, url, events, active FROM webhook WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound('Webhook');
    await pool.query('UPDATE webhook SET name=$2, url=$3, events=$4, active=$5, updated_at=now() WHERE id=$1', [id, input.name, input.url, [...new Set(input.events)], input.active]);
    const changes = diff(before, input as unknown as Record<string, unknown>);
    if (Object.keys(changes).length) await audit(pool, req, { action: 'webhook.update', entityType: 'settings', entityLabel: 'Webhooks', changes: { webhook: input.name, ...changes } });
    res.json((await pool.query(`SELECT ${WEBHOOK_SELECT} FROM webhook w WHERE w.id = $1`, [id])).rows[0]);
  });

  r.post('/settings/webhooks/:id/secret', ...admin, async (req, res) => {
    const id = requireUuid(req.params.id);
    const secret = newSecret();
    const { rows } = await pool.query('UPDATE webhook SET secret_enc = $2, updated_at = now() WHERE id = $1 RETURNING name', [id, encryptSecret(config, secret)]);
    if (!rows[0]) throw notFound('Webhook');
    await audit(pool, req, { action: 'webhook.secret', entityType: 'settings', entityLabel: 'Webhooks', changes: { webhook: rows[0].name } });
    res.json({ secret });
  });

  r.delete('/settings/webhooks/:id', ...admin, async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query('DELETE FROM webhook WHERE id = $1 RETURNING name', [id]);
    if (!rows[0]) throw notFound('Webhook');
    await audit(pool, req, { action: 'webhook.delete', entityType: 'settings', entityLabel: 'Webhooks', changes: { webhook: rows[0].name } });
    res.status(204).end();
  });

  /** Sends a "ping" event right away and reports the answer */
  r.post('/settings/webhooks/:id/test', ...admin, async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query('SELECT name, url, secret_enc FROM webhook WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Webhook');
    const secret = decryptSecret(config, rows[0].secret_enc);
    if (!secret) throw badRequest('The signing secret cannot be decrypted – create a new secret');
    const deliveryId = `test-${Date.now()}`;
    const body = JSON.stringify({ event: 'ping', action: 'ping', at: new Date().toISOString(), user: req.user!.displayName, delivery_id: deliveryId });
    const result = await postWebhook(fetchImpl, { url: rows[0].url, secret }, 'ping', deliveryId, body);
    await pool.query('UPDATE webhook SET last_delivery_at = now(), last_status = $2 WHERE id = $1', [id, result.error ?? `HTTP ${result.status}`]);
    res.json({ ok: !result.error, status: result.status, error: result.error });
  });

  r.get('/settings/webhooks/:id/deliveries', ...admin, async (req, res) => {
    const id = requireUuid(req.params.id);
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const { rows } = await pool.query(
      `SELECT d.id::text, e.event, d.status, d.attempts, d.response_status, d.last_error, d.created_at, d.delivered_at, d.next_attempt_at
       FROM webhook_delivery d JOIN event_outbox e ON e.id = d.event_id WHERE d.webhook_id = $1 ORDER BY d.id DESC LIMIT ${limit}`,
      [id],
    );
    res.json(rows);
  });

  r.post('/settings/webhooks/:id/deliveries/:deliveryId/retry', ...admin, async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rowCount } = await pool.query(
      `UPDATE webhook_delivery SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE webhook_id = $1 AND id = $2::bigint AND status = 'failed'`,
      [id, String(req.params.deliveryId).replace(/\D/g, '') || '0'],
    );
    if (!rowCount) throw notFound('Failed delivery');
    res.status(204).end();
  });

  // ---------------------------------------------------------------- external references (tickets, monitoring links …)
  r.get('/assets/:id/refs', async (req, res) => {
    const asset = await loadAssetForAccess(pool, req.user, requireUuid(req.params.id));
    const { rows } = await pool.query('SELECT * FROM asset_external_ref WHERE asset_id = $1 ORDER BY lower(system), created_at DESC', [asset.id]);
    res.json(rows);
  });

  /** Which devices does a ticket / external object refer to? */
  r.get('/refs', async (req, res) => {
    const sql = new SqlBuilder();
    applyScope(sql, req.user!, 'a.plant_id');
    const system = queryString(req.query.system);
    const ref = queryString(req.query.ref);
    if (!system && !ref) throw badRequest('system or ref is required');
    if (system) sql.and(`lower(x.system) = lower(${sql.p(system)})`);
    if (ref) sql.and(`lower(x.ref) = lower(${sql.p(ref)})`);
    const { rows } = await pool.query(
      `SELECT x.*, a.name AS asset_name, a.type AS asset_type FROM asset_external_ref x JOIN asset a ON a.id = x.asset_id ${sql.whereSql()} ORDER BY a.name LIMIT 500`,
      sql.params,
    );
    res.json(rows);
  });

  r.post('/assets/:id/refs', requirePermission('note.write'), async (req, res) => {
    const input = parse(refSchema, req.body);
    const row = await withTransaction(pool, async (db) => {
      const asset = await loadAssetForAccess(db, req.user, requireUuid(req.params.id));
      const { rows } = await db.query(
        `INSERT INTO asset_external_ref (asset_id, system, ref, url, title, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (asset_id, lower(system), lower(ref)) DO UPDATE SET url = EXCLUDED.url, title = EXCLUDED.title, status = EXCLUDED.status, updated_at = now()
         RETURNING *`,
        [asset.id, input.system, input.ref, input.url, input.title, input.status, req.user!.id],
      );
      await audit(db, req, { action: 'ref.add', entityType: 'asset', entityId: asset.id, entityLabel: asset.name, plantId: asset.plant_id, changes: { system: input.system, ref: input.ref, title: input.title, status: input.status } });
      return rows[0];
    });
    res.status(201).json(row);
  });

  r.delete('/refs/:id', requirePermission('note.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const { rows } = await db.query('SELECT * FROM asset_external_ref WHERE id = $1', [id]);
      if (!rows[0]) throw notFound('Reference');
      const asset = await loadAssetForAccess(db, req.user, rows[0].asset_id);
      await db.query('DELETE FROM asset_external_ref WHERE id = $1', [id]);
      await audit(db, req, { action: 'ref.remove', entityType: 'asset', entityId: asset.id, entityLabel: asset.name, plantId: asset.plant_id, changes: { system: rows[0].system, ref: rows[0].ref } });
    });
    res.status(204).end();
  });

  // ---------------------------------------------------------------- monitoring status
  r.put('/assets/:id/monitoring', requirePermission('asset.status'), async (req, res) => {
    const input = parse(monitoringSchema, req.body);
    await withTransaction(pool, async (db) => {
      const asset = await loadAssetForAccess(db, req.user, requireUuid(req.params.id));
      await applyMonitoring(db, req, asset, input.status, input.message, input.source ?? req.apiToken?.name ?? null);
    });
    res.status(204).end();
  });

  /** Many results at once, matched by id, name or IP address (e.g. from Zabbix, PRTG, Checkmk) */
  r.post('/monitoring', requirePermission('asset.status'), async (req, res) => {
    const input = parse(bulkMonitoringSchema, req.body);
    const source = input.source ?? req.apiToken?.name ?? null;
    const result = { updated: 0, unmatched: [] as string[], ambiguous: [] as string[] };
    await withTransaction(pool, async (db) => {
      for (const item of input.items) {
        const key = item.id ?? item.name ?? item.ip!;
        const sql = new SqlBuilder();
        applyScope(sql, req.user!, 'plant_id');
        if (item.id) sql.and(`id = ${sql.p(item.id)}`);
        else if (item.name) sql.and(`(lower(name) = lower(${sql.p(item.name)}) OR lower(fqdn) = lower($${sql.params.length}))`);
        else sql.and(`cmdb_inet(ip_address) = cmdb_inet(${sql.p(item.ip)})`);
        sql.and(`status <> 'retired'`);
        const { rows } = await db.query(`SELECT id, name, plant_id, monitoring_status FROM asset ${sql.whereSql()} LIMIT 2`, sql.params);
        if (!rows.length) result.unmatched.push(key);
        else if (rows.length > 1) result.ambiguous.push(key);
        else {
          await applyMonitoring(db, req, rows[0], item.status, item.message, source);
          result.updated++;
        }
      }
    });
    res.json(result);
  });

  return r;
}

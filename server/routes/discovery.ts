import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ASSET_TYPE_KEYS, type AssetType, type CurrentUser } from '../../shared/model';
import { DISCOVERY_STATES, SNMP_AUTH_PROTOCOLS, SNMP_LEVELS, SNMP_PRIV_PROTOCOLS, type DiscoveredData, type DiscoverySecrets, type DiscoverySource } from '../../shared/discovery';
import type { Config } from '../config';
import { requirePermission } from '../auth/context';
import { withTransaction, type DbClient } from '../db/pool';
import { audit, diff, snapshot } from '../lib/audit';
import { badRequest, clampInt, conflict, likePattern, notFound, parse, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { assetSchema, optUuid, reqText } from '../lib/schemas';
import { assertPlantAccess, isUnscoped } from '../lib/scope';
import { encryptSecret } from '../lib/secrets';
import { insertAsset, resolveAssetLocation } from '../services/assets';
import { cleanAttributes, loadAssetTypeSettings } from '../services/assetTypes';
import { expandTargets } from '../discovery/snmp';
import { applyNeighbors, applyToAsset, runDiscovery, secretsOf, type DiscoveryDeps } from '../discovery/service';

const snmpConfigSchema = z.object({
  targets: z
    .string()
    .trim()
    .min(1, 'Enter at least one address or network')
    .max(4000)
    .superRefine((v, ctx) => {
      try {
        expandTargets(v);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: (e as Error).message });
      }
    }),
  version: z.enum(['2c', '3']).default('2c'),
  port: z.number().int().min(1).max(65535).default(161),
  timeoutMs: z.number().int().min(200).max(20000).default(1500),
  retries: z.number().int().min(0).max(5).default(1),
  user: z.string().trim().max(100).optional(),
  level: z.enum(SNMP_LEVELS).optional(),
  authProtocol: z.enum(SNMP_AUTH_PROTOCOLS).optional(),
  privProtocol: z.enum(SNMP_PRIV_PROTOCOLS).optional(),
});

const adConfigSchema = z.object({
  url: z
    .string()
    .trim()
    .regex(/^ldaps?:\/\/[^\s/]+(:\d+)?\/?$/i, 'Expected ldaps://dc01.example.local:636 (or ldap://…)'),
  baseDn: reqText(500),
  bindDn: reqText(500),
  serversOnly: z.boolean().default(true),
  tlsInsecure: z.boolean().default(false),
});

const secretValue = z.string().max(500).nullish();
const sourceSchema = z.object({
  name: reqText(100),
  kind: z.enum(['snmp', 'ad']),
  enabled: z.boolean().default(true),
  plant_id: optUuid,
  schedule_hours: z.number().int().min(0).max(720).default(24),
  config: z.record(z.string(), z.unknown()),
  /** undefined = keep, "" or null = remove, text = replace */
  secrets: z.object({ community: secretValue, authKey: secretValue, privKey: secretValue, bindPassword: secretValue }).default({}),
});

const SOURCE_SELECT = `s.id, s.name, s.kind, s.enabled, s.plant_id, p.code AS plant_code, s.schedule_hours, s.config, s.secrets_enc, s.last_run_at, s.last_status, s.created_at,
  (SELECT count(*) FROM discovery_item i WHERE i.source_id = s.id AND i.state = 'new') AS new_items`;
const SOURCE_FROM = `FROM discovery_source s LEFT JOIN plant p ON p.id = s.plant_id`;

export function sourceDto(config: Config, row: Record<string, unknown>): DiscoverySource {
  const { secrets_enc: enc, ...rest } = row;
  let set: (keyof DiscoverySecrets)[] = [];
  try {
    set = (Object.entries(secretsOf(config, enc as string | null)) as [keyof DiscoverySecrets, string][]).filter(([, v]) => v).map(([k]) => k);
  } catch {
    set = [];
  }
  return { ...(rest as unknown as DiscoverySource), secrets_set: set };
}

const ITEM_SELECT = `i.id, i.source_id, s.name AS source_name, s.kind AS source_kind, s.plant_id, i.key, i.state, i.asset_id, a.name AS asset_name, i.matched_by, i.data, i.first_seen, i.last_seen`;
const ITEM_FROM = `FROM discovery_item i JOIN discovery_source s ON s.id = i.source_id LEFT JOIN asset a ON a.id = i.asset_id`;

/** Scoped users only see items of sources assigned to their plants */
function scopeItems(sql: SqlBuilder, user: CurrentUser) {
  if (isUnscoped(user)) return;
  sql.and(`s.plant_id = ANY(${sql.p(user.plantScope)}::uuid[])`);
}

async function loadItem(db: DbClient, user: CurrentUser, id: string) {
  const sql = new SqlBuilder();
  sql.and(`i.id = ${sql.p(id)}`);
  scopeItems(sql, user);
  const { rows } = await db.query(`SELECT ${ITEM_SELECT}, s.name AS src_name ${ITEM_FROM} ${sql.whereSql()} FOR UPDATE OF i`, sql.params);
  if (!rows[0]) throw notFound('Discovered device');
  return rows[0] as { id: string; source_name: string; plant_id: string | null; state: string; asset_id: string | null; data: DiscoveredData };
}

export function discoveryRouter(pool: Pool, config: Config, deps: DiscoveryDeps = {}): Router {
  const r = Router();
  const admin = requirePermission('settings.manage');

  // ---------------------------------------------------------------- sources
  r.get('/discovery/sources', admin, async (_req, res) => {
    const { rows } = await pool.query(`SELECT ${SOURCE_SELECT} ${SOURCE_FROM} ORDER BY lower(s.name)`);
    res.json(rows.map((x) => sourceDto(config, x)));
  });

  const saveSource = async (req: Request, id: string | null) => {
    const input = parse(sourceSchema, req.body);
    const cfg = input.kind === 'snmp' ? parse(snmpConfigSchema, input.config) : parse(adConfigSchema, input.config);
    if (input.kind === 'snmp' && (cfg as z.infer<typeof snmpConfigSchema>).version === '3' && !(cfg as z.infer<typeof snmpConfigSchema>).user)
      throw badRequest('SNMPv3 needs a user name');
    return withTransaction(pool, async (db) => {
      let before: Record<string, unknown> | null = null;
      let secrets: DiscoverySecrets = {};
      if (id) {
        const { rows } = await db.query('SELECT * FROM discovery_source WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) throw notFound('Discovery source');
        if (rows[0].kind !== input.kind) throw badRequest('The kind of a source cannot be changed');
        before = rows[0];
        secrets = secretsOf(config, rows[0].secrets_enc as string | null);
      }
      for (const [k, v] of Object.entries(input.secrets) as [keyof DiscoverySecrets, string | null | undefined][]) {
        if (v === undefined) continue;
        if (v) secrets[k] = v;
        else delete secrets[k];
      }
      const enc = Object.keys(secrets).length ? encryptSecret(config, JSON.stringify(secrets)) : null;
      const values = [input.name, input.kind, input.enabled, input.plant_id, input.schedule_hours, JSON.stringify(cfg), enc];
      const { rows } = await db
        .query(
          id
            ? `UPDATE discovery_source SET name=$1, kind=$2, enabled=$3, plant_id=$4, schedule_hours=$5, config=$6, secrets_enc=$7, updated_at=now() WHERE id=$8 RETURNING id`
            : `INSERT INTO discovery_source (name, kind, enabled, plant_id, schedule_hours, config, secrets_enc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          id ? [...values, id] : values,
        )
        .catch((e) => {
          if (e.code === '23505') throw conflict(`A discovery source named "${input.name}" already exists`);
          throw e;
        });
      const after = { name: input.name, enabled: input.enabled, plant_id: input.plant_id, schedule_hours: input.schedule_hours, config: cfg };
      const changes = before ? diff({ name: before.name, enabled: before.enabled, plant_id: before.plant_id, schedule_hours: before.schedule_hours, config: before.config }, after) : snapshot(after);
      const secretChanges = Object.entries(input.secrets).filter(([, v]) => v !== undefined).map(([k]) => k);
      if (Object.keys(changes).length || secretChanges.length)
        await audit(db, req, { action: id ? 'source.update' : 'source.create', entityType: 'settings', entityLabel: 'Discovery', changes: { source: input.name, ...changes, ...(secretChanges.length ? { credentials: secretChanges.join(', ') } : {}) } });
      const { rows: out } = await db.query(`SELECT ${SOURCE_SELECT} ${SOURCE_FROM} WHERE s.id = $1`, [rows[0].id]);
      return sourceDto(config, out[0]);
    });
  };

  r.post('/discovery/sources', admin, async (req, res) => {
    res.status(201).json(await saveSource(req, null));
  });

  r.put('/discovery/sources/:id', admin, async (req, res) => {
    res.json(await saveSource(req, requireUuid(req.params.id)));
  });

  r.delete('/discovery/sources/:id', admin, async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query('DELETE FROM discovery_source WHERE id = $1 RETURNING name', [id]);
    if (!rows[0]) throw notFound('Discovery source');
    await audit(pool, req, { action: 'source.delete', entityType: 'settings', entityLabel: 'Discovery', changes: { source: rows[0].name } });
    res.status(204).end();
  });

  /** Starts a run; ?wait=true waits for the result (otherwise it runs in the background) */
  r.post('/discovery/sources/:id/run', admin, async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query(`SELECT 1 FROM discovery_run WHERE source_id = $1 AND status = 'running' AND started_at > now() - interval '6 hours'`, [id]);
    if (rows.length) throw conflict('This source is already running');
    const exists = await pool.query('SELECT name FROM discovery_source WHERE id = $1', [id]);
    if (!exists.rows[0]) throw notFound('Discovery source');
    const run = runDiscovery(pool, config, id, 'manual', deps);
    if (queryString(req.query.wait) === 'true') return res.json(await run);
    run.catch(() => undefined);
    res.status(202).json({ started: true });
  });

  r.get('/discovery/runs', admin, async (req, res) => {
    const sql = new SqlBuilder();
    const sourceId = queryString(req.query.sourceId);
    if (sourceId) sql.and(`r.source_id = ${sql.p(requireUuid(sourceId, 'sourceId'))}`);
    const limit = clampInt(req.query.limit, 30, 1, 500);
    const { rows } = await pool.query(
      `SELECT r.id, r.source_id, s.name AS source_name, r.trigger, r.status, r.started_at, r.finished_at, r.scanned, r.found, r.new_items, r.updated_assets, r.error
       FROM discovery_run r JOIN discovery_source s ON s.id = r.source_id ${sql.whereSql()} ORDER BY r.started_at DESC LIMIT ${limit}`,
      sql.params,
    );
    res.json(rows);
  });

  // ---------------------------------------------------------------- inbox
  r.get('/discovery/items', requirePermission('asset.write'), async (req, res) => {
    const sql = new SqlBuilder();
    scopeItems(sql, req.user!);
    const state = queryString(req.query.state) ?? 'new';
    if (!DISCOVERY_STATES.includes(state as never)) throw badRequest('Invalid state');
    sql.and(`i.state = ${sql.p(state)}`);
    const sourceId = queryString(req.query.sourceId);
    if (sourceId) sql.and(`i.source_id = ${sql.p(requireUuid(sourceId, 'sourceId'))}`);
    const q = queryString(req.query.q);
    if (q) sql.and(`(i.data::text ILIKE ${sql.p(likePattern(q))} OR a.name ILIKE $${sql.params.length})`);
    const limit = clampInt(req.query.limit, 200, 1, 2000);
    const { rows } = await pool.query(`SELECT ${ITEM_SELECT} ${ITEM_FROM} ${sql.whereSql()} ORDER BY i.last_seen DESC, i.data->>'name' LIMIT ${limit}`, sql.params);
    const counts = new SqlBuilder();
    scopeItems(counts, req.user!);
    const { rows: c } = await pool.query(`SELECT i.state, count(*)::int AS n ${ITEM_FROM} ${counts.whereSql()} GROUP BY i.state`, counts.params);
    res.json({ items: rows, counts: Object.fromEntries(DISCOVERY_STATES.map((s) => [s, c.find((x) => x.state === s)?.n ?? 0])) });
  });

  /** Creates a device from a discovered one (type, name and location can be adjusted) */
  r.post('/discovery/items/:id/create', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const opts = parse(
      z.object({
        type: z.enum(ASSET_TYPE_KEYS as [AssetType, ...AssetType[]]).optional(),
        name: z.string().trim().min(1).max(200).optional(),
        plant_id: optUuid,
        building_id: optUuid,
      }),
      req.body ?? {},
    );
    const asset = await withTransaction(pool, async (db) => {
      const item = await loadItem(db, req.user!, id);
      if (item.state === 'linked' && item.asset_id) throw conflict('Already linked with a device');
      const d = item.data;
      const input = parse(assetSchema, {
        type: opts.type ?? d.type,
        name: opts.name ?? d.name ?? d.fqdn ?? d.ip ?? 'discovered-device',
        status: 'active',
        plant_id: opts.plant_id ?? (opts.building_id ? null : item.plant_id),
        building_id: opts.building_id ?? null,
        manufacturer: d.manufacturer ?? null,
        model: d.model ?? null,
        serial_number: d.serial ?? null,
        ip_address: d.ip ?? null,
        mac_address: d.mac && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(d.mac) ? d.mac : null,
        fqdn: d.fqdn ?? null,
        os: d.os ?? d.firmware ?? null,
        description: d.location ? `Location (SNMP): ${d.location}` : null,
        attributes: d.firmware ? { firmware: d.firmware } : {},
      });
      input.attributes = cleanAttributes(input.type, input.attributes, await loadAssetTypeSettings(db));
      const loc = await resolveAssetLocation(db, input);
      assertPlantAccess(req.user!, loc.plant_id);
      const created = await insertAsset(db, input, loc, req.user!.id);
      await audit(db, req, { action: 'create', entityType: 'asset', entityId: created.id, entityLabel: created.name, plantId: created.plant_id, changes: { ...snapshot(created), _source: `discovery: ${item.source_name}` } });
      await db.query(`UPDATE discovery_item SET state = 'linked', asset_id = $2, matched_by = 'created' WHERE id = $1`, [id, created.id]);
      await applyToAsset(db, created.id, d, item.source_name);
      await applyNeighbors(db, created.id, d, item.source_name);
      return created;
    });
    res.status(201).json(asset);
  });

  r.post('/discovery/items/:id/link', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const { asset_id: assetId } = parse(z.object({ asset_id: z.string().uuid() }), req.body);
    await withTransaction(pool, async (db) => {
      const item = await loadItem(db, req.user!, id);
      const { rows } = await db.query('SELECT id, name, plant_id FROM asset WHERE id = $1', [assetId]);
      if (!rows[0]) throw notFound('Asset');
      assertPlantAccess(req.user!, rows[0].plant_id);
      await db.query(`UPDATE discovery_item SET state = 'linked', asset_id = $2, matched_by = 'manual' WHERE id = $1`, [id, assetId]);
      await applyToAsset(db, assetId, item.data, item.source_name);
      await applyNeighbors(db, assetId, item.data, item.source_name);
      await audit(db, req, { action: 'discovery.link', entityType: 'asset', entityId: assetId, entityLabel: rows[0].name, plantId: rows[0].plant_id, changes: { source: item.source_name, discovered: item.data.name ?? item.data.ip } });
    });
    res.status(204).end();
  });

  r.post('/discovery/items/:id/ignore', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      await loadItem(db, req.user!, id);
      await db.query(`UPDATE discovery_item SET state = 'ignored', asset_id = NULL, matched_by = NULL WHERE id = $1`, [id]);
    });
    res.status(204).end();
  });

  /** Back to the inbox (ignored or wrongly linked items) */
  r.post('/discovery/items/:id/reset', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      await loadItem(db, req.user!, id);
      await db.query(`UPDATE discovery_item SET state = 'new', asset_id = NULL, matched_by = NULL WHERE id = $1`, [id]);
    });
    res.status(204).end();
  });

  /** Discovery data of a device (device page) */
  r.get('/assets/:id/discovery', async (req, res) => {
    const assetId = requireUuid(req.params.id);
    const { rows: a } = await pool.query('SELECT plant_id FROM asset WHERE id = $1', [assetId]);
    if (!a[0]) throw notFound('Asset');
    assertPlantAccess(req.user!, a[0].plant_id);
    const { rows } = await pool.query(`SELECT ${ITEM_SELECT} ${ITEM_FROM} WHERE i.asset_id = $1 ORDER BY i.last_seen DESC`, [assetId]);
    res.json(rows);
  });

  return r;
}

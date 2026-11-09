import type { Pool } from 'pg';
import { ASSET_TYPES, type AssetType, type FieldDef } from '../../shared/model';
import type { AdConfig, DiscoveredData, DiscoveryRun, DiscoverySecrets, SnmpConfig } from '../../shared/discovery';
import type { Config } from '../config';
import { withTransaction, type DbClient } from '../db/pool';
import { audit } from '../lib/audit';
import { decryptSecret } from '../lib/secrets';
import { log } from '../lib/log';
import { collectAd, type LdapFactory } from './ad';
import { openSession, sweep } from './snmp';

export interface DiscoveryDeps {
  /** SNMP session factory (tests) */
  openSnmp?: typeof openSession;
  ldapFactory?: LdapFactory;
}

interface SourceRow {
  id: string;
  name: string;
  kind: 'snmp' | 'ad';
  plant_id: string | null;
  config: SnmpConfig | AdConfig;
  secrets_enc: string | null;
}

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const macHex = (mac: string | null | undefined) => (mac ? mac.toLowerCase().replace(/[^0-9a-f]/g, '') : '');

export function secretsOf(config: Config, enc: string | null): DiscoverySecrets {
  if (!enc) return {};
  const plain = decryptSecret(config, enc);
  if (!plain) throw new Error('The stored credentials cannot be decrypted (SETTINGS_ENCRYPTION_KEY changed?) – enter them again');
  return JSON.parse(plain) as DiscoverySecrets;
}

/** Stable identity of a discovered device within one source */
export function itemKey(d: DiscoveredData & { key?: string }): string {
  if (d.key) return d.key;
  if (d.serial) return `sn:${d.serial.toLowerCase()}`;
  if (d.mac && MAC_RE.test(d.mac)) return `mac:${macHex(d.mac)}`;
  return `ip:${d.ip ?? d.name}`;
}

// ---------------------------------------------------------------------------- matching

interface Match {
  id: string;
  by: 'serial' | 'mac' | 'name' | 'ip';
}

/** Serial number → MAC address → host name → IP address; the first criterion with exactly one device wins. */
export async function matchAsset(db: DbClient, d: DiscoveredData, plantId: string | null): Promise<Match | null> {
  const tries: [Match['by'], string, unknown[]][] = [];
  if (d.serial) tries.push(['serial', `lower(a.serial_number) = lower($1)`, [d.serial]]);
  if (d.mac && macHex(d.mac).length === 12) tries.push(['mac', `lower(regexp_replace(a.mac_address, '[^0-9a-fA-F]', '', 'g')) = $1`, [macHex(d.mac)]]);
  const host = (d.fqdn ?? d.name ?? '').toLowerCase();
  const short = host.split('.')[0];
  if (short) tries.push(['name', `(lower(a.name) = $1 OR lower(a.fqdn) = $2 OR split_part(lower(a.fqdn), '.', 1) = $1)`, [short, host]]);
  if (d.ip) tries.push(['ip', `cmdb_inet(a.ip_address) = cmdb_inet($1)`, [d.ip]]);
  for (const [by, where, params] of tries) {
    const { rows } = await db.query<{ id: string; plant_id: string | null }>(`SELECT a.id, a.plant_id FROM asset a WHERE ${where} AND a.status <> 'retired' LIMIT 5`, params);
    if (rows.length === 1) return { id: rows[0].id, by };
    if (rows.length > 1 && plantId) {
      const same = rows.filter((r) => r.plant_id === plantId);
      if (same.length === 1) return { id: same[0].id, by };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------- applying data

/** Fills only empty fields of the device, updates "last seen" and adds missing ports. Returns true when something changed. */
export async function applyToAsset(db: DbClient, assetId: string, d: DiscoveredData, sourceName: string): Promise<boolean> {
  const { rows } = await db.query('SELECT * FROM asset WHERE id = $1 FOR UPDATE', [assetId]);
  const a = rows[0];
  if (!a) return false;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const fill = (col: string, value: string | null | undefined, valid = true) => {
    if (value && valid && (a[col] === null || a[col] === '')) changes[col] = { from: null, to: value.slice(0, 200) };
  };
  fill('serial_number', d.serial);
  fill('manufacturer', d.manufacturer);
  fill('model', d.model);
  fill('mac_address', d.mac, !!d.mac && MAC_RE.test(d.mac));
  fill('fqdn', d.fqdn);
  fill('os', d.os ?? d.firmware);
  fill('ip_address', d.ip, !!d.ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(d.ip));
  const attrs = { ...(a.attributes ?? {}) };
  const fields = ASSET_TYPES[a.type as AssetType]?.fields as readonly FieldDef[] | undefined;
  if (d.firmware && fields?.some((f) => f.key === 'firmware') && !attrs.firmware) {
    attrs.firmware = d.firmware;
    changes['attributes.firmware'] = { from: null, to: d.firmware };
  }
  const sets = Object.keys(changes)
    .filter((k) => !k.startsWith('attributes.'))
    .map((k, i) => `${k} = $${i + 3}`);
  const values = Object.keys(changes)
    .filter((k) => !k.startsWith('attributes.'))
    .map((k) => changes[k].to);
  const seen = d.last_logon ?? new Date().toISOString();
  await db.query(
    `UPDATE asset SET ${sets.length ? `${sets.join(', ')}, ` : ''}attributes = $2::jsonb,
            last_seen_at = GREATEST(last_seen_at, $${values.length + 3}::timestamptz)
            ${Object.keys(changes).length ? ', updated_at = now()' : ''}
     WHERE id = $1`,
    [assetId, JSON.stringify(attrs), ...values, seen],
  );
  if (Object.keys(changes).length)
    await audit(db, null, { action: 'update', entityType: 'asset', entityId: assetId, entityLabel: a.name, plantId: a.plant_id, changes: { ...changes, _source: `discovery: ${sourceName}` } });

  // ports: add missing ones, fill empty details
  if (d.ports?.length) {
    const { rows: existing } = await db.query<{ id: string; name: string; description: string | null; mac_address: string | null; speed: string | null }>(
      'SELECT id, name, description, mac_address, speed FROM asset_port WHERE asset_id = $1',
      [assetId],
    );
    const byName = new Map(existing.map((p) => [p.name.toLowerCase(), p]));
    let position = existing.length;
    const added: string[] = [];
    for (const p of d.ports.slice(0, 1024)) {
      const cur = byName.get(p.name.toLowerCase());
      if (!cur) {
        await db.query(
          `INSERT INTO asset_port (asset_id, name, position, kind, speed, description, mac_address, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'discovery') ON CONFLICT DO NOTHING`,
          [assetId, p.name.slice(0, 64), ++position, /^(te|tw|hu|fo|xe|et|25|40|100)/i.test(p.name) ? 'sfp' : 'ethernet', p.speed ?? null, p.description ?? null, p.mac ?? null],
        );
        added.push(p.name);
      } else if ((!cur.description && p.description) || (!cur.mac_address && p.mac) || (!cur.speed && p.speed)) {
        await db.query(
          'UPDATE asset_port SET description = COALESCE(description, $2), mac_address = COALESCE(mac_address, $3), speed = COALESCE(speed, $4), updated_at = now() WHERE id = $1',
          [cur.id, p.description ?? null, p.mac ?? null, p.speed ?? null],
        );
      }
    }
    if (added.length)
      await audit(db, null, {
        action: 'port.add',
        entityType: 'asset',
        entityId: assetId,
        entityLabel: a.name,
        plantId: a.plant_id,
        changes: { ports: added.length > 6 ? `${added[0]} … ${added[added.length - 1]} (${added.length})` : added.join(', '), _source: `discovery: ${sourceName}` },
      });
  }
  return Object.keys(changes).length > 0;
}

/** LLDP neighbours → "connected to" relations and port connections (only where nothing is documented yet) */
export async function applyNeighbors(db: DbClient, assetId: string, d: DiscoveredData, sourceName: string): Promise<number> {
  let created = 0;
  for (const n of d.neighbors ?? []) {
    const name = (n.remote_name ?? '').toLowerCase().split('.')[0];
    const mac = n.remote_chassis && MAC_RE.test(n.remote_chassis) ? macHex(n.remote_chassis) : '';
    if (!name && !mac) continue;
    const { rows: peers } = await db.query<{ id: string; name: string; plant_id: string | null }>(
      `SELECT a.id, a.name, a.plant_id FROM asset a
       WHERE a.id <> $3 AND a.status <> 'retired' AND (
         ($1 <> '' AND (lower(a.name) = $1 OR split_part(lower(a.fqdn), '.', 1) = $1))
         OR ($2 <> '' AND lower(regexp_replace(a.mac_address, '[^0-9a-fA-F]', '', 'g')) = $2)
         OR ($2 <> '' AND EXISTS (SELECT 1 FROM discovery_item i WHERE i.asset_id = a.id AND i.key = 'mac:' || $2))
       ) LIMIT 2`,
      [name, mac, assetId],
    );
    if (peers.length !== 1) continue;
    const peer = peers[0];
    const { rows: rel } = await db.query('SELECT 1 FROM asset_relation WHERE (source_id = $1 AND target_id = $2) OR (source_id = $2 AND target_id = $1) LIMIT 1', [assetId, peer.id]);
    if (!rel.length) {
      await db.query(
        `INSERT INTO asset_relation (source_id, target_id, relation, source_port, target_port, note) VALUES ($1,$2,'connected_to',$3,$4,$5)`,
        [assetId, peer.id, n.local_port?.slice(0, 50) ?? null, n.remote_port?.slice(0, 50) ?? null, `LLDP (${sourceName})`],
      );
      const { rows: self } = await db.query('SELECT name, plant_id FROM asset WHERE id = $1', [assetId]);
      await audit(db, null, { action: 'relation.add', entityType: 'asset', entityId: assetId, entityLabel: self[0]?.name, plantId: self[0]?.plant_id, changes: { relation: 'connected_to', target: peer.name, source_port: n.local_port, target_port: n.remote_port, _source: `discovery: ${sourceName}` } });
      created++;
    }
    // cable between the two ports, when both ports are documented and free
    if (n.local_port && n.remote_port) {
      const { rows: ports } = await db.query<{ id: string; asset_id: string; connected_port_id: string | null }>(
        `SELECT id, asset_id, connected_port_id FROM asset_port
         WHERE (asset_id = $1 AND lower(name) = lower($2)) OR (asset_id = $3 AND lower(name) = lower($4))`,
        [assetId, n.local_port, peer.id, n.remote_port],
      );
      const a = ports.find((p) => p.asset_id === assetId);
      const b = ports.find((p) => p.asset_id === peer.id);
      if (a && b && !a.connected_port_id && !b.connected_port_id) {
        await db.query('UPDATE asset_port SET connected_port_id = $2, updated_at = now() WHERE id = $1', [a.id, b.id]);
        await db.query('UPDATE asset_port SET connected_port_id = $2, updated_at = now() WHERE id = $1', [b.id, a.id]);
      }
    }
  }
  return created;
}

// ---------------------------------------------------------------------------- run

async function collect(config: Config, source: SourceRow, deps: DiscoveryDeps): Promise<{ scanned: number; found: (DiscoveredData & { key?: string })[] }> {
  const secrets = secretsOf(config, source.secrets_enc);
  if (source.kind === 'snmp') return sweep(source.config as SnmpConfig, secrets, { open: deps.openSnmp });
  return collectAd(source.config as AdConfig, secrets, deps.ldapFactory);
}

/** Runs one source: collect, store the items, match and update devices. */
export async function runDiscovery(pool: Pool, config: Config, sourceId: string, trigger: 'manual' | 'schedule', deps: DiscoveryDeps = {}): Promise<DiscoveryRun> {
  const { rows: src } = await pool.query<SourceRow>('SELECT id, name, kind, plant_id, config, secrets_enc FROM discovery_source WHERE id = $1', [sourceId]);
  const source = src[0];
  if (!source) throw new Error('Discovery source not found');
  const { rows: runs } = await pool.query<{ id: string }>(`INSERT INTO discovery_run (source_id, trigger) VALUES ($1, $2) RETURNING id`, [sourceId, trigger]);
  const runId = runs[0].id;
  const stats = { scanned: 0, found: 0, new_items: 0, updated_assets: 0 };
  let error: string | null = null;
  try {
    const result = await collect(config, source, deps);
    stats.scanned = result.scanned;
    stats.found = result.found.length;
    await withTransaction(pool, async (db) => {
      const linked: { assetId: string; data: DiscoveredData }[] = [];
      for (const d of result.found) {
        const key = itemKey(d);
        const { key: _k, ...data } = d as DiscoveredData & { key?: string };
        const { rows } = await db.query<{ id: string; state: string; asset_id: string | null; inserted: boolean }>(
          `INSERT INTO discovery_item (source_id, key, data) VALUES ($1, $2, $3)
           ON CONFLICT (source_id, key) DO UPDATE SET data = EXCLUDED.data, last_seen = now()
           RETURNING id, state, asset_id, (xmax = 0) AS inserted`,
          [sourceId, key.slice(0, 300), JSON.stringify(data)],
        );
        const item = rows[0];
        if (item.state === 'ignored') continue;
        let assetId = item.state === 'linked' ? item.asset_id : null;
        if (!assetId) {
          const match = await matchAsset(db, data, source.plant_id);
          if (match) {
            assetId = match.id;
            await db.query(`UPDATE discovery_item SET state = 'linked', asset_id = $2, matched_by = $3 WHERE id = $1`, [item.id, match.id, match.by]);
          } else {
            if (item.state !== 'new' || item.asset_id) await db.query(`UPDATE discovery_item SET state = 'new', asset_id = NULL, matched_by = NULL WHERE id = $1`, [item.id]);
            if (item.inserted) stats.new_items++;
          }
        }
        if (assetId) {
          if (await applyToAsset(db, assetId, data, source.name)) stats.updated_assets++;
          linked.push({ assetId, data });
        }
      }
      // neighbours only after all devices of this run are linked
      for (const l of linked) await applyNeighbors(db, l.assetId, l.data, source.name);
    });
  } catch (err) {
    error = (err as Error).message;
    log.warn('discovery: run failed', { source: source.name, error });
  }
  const status = error ? 'error' : 'ok';
  const { rows: done } = await pool.query<DiscoveryRun>(
    `UPDATE discovery_run SET status = $2, finished_at = now(), scanned = $3, found = $4, new_items = $5, updated_assets = $6, error = $7
     WHERE id = $1 RETURNING id, source_id, trigger, status, started_at, finished_at, scanned, found, new_items, updated_assets, error`,
    [runId, status, stats.scanned, stats.found, stats.new_items, stats.updated_assets, error],
  );
  const summary = error ? `Failed: ${error}` : `${stats.found} found, ${stats.new_items} new, ${stats.updated_assets} updated`;
  await pool.query('UPDATE discovery_source SET last_run_at = now(), last_status = $2 WHERE id = $1', [sourceId, summary.slice(0, 500)]);
  await audit(pool, null, { action: 'run', entityType: 'discovery', entityId: sourceId, entityLabel: source.name, changes: { trigger, status, ...stats, error } });
  return done[0];
}

// ---------------------------------------------------------------------------- schedule

const LOCK_ID = 727_005;

/** Runs every source whose interval has passed. Only one instance does this at a time. */
export async function runDueSources(pool: Pool, config: Config, deps: DiscoveryDeps = {}): Promise<number> {
  const lock = await pool.connect();
  try {
    const { rows } = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!rows[0].ok) return 0;
    try {
      // runs that never finished (instance restarted)
      await pool.query(`UPDATE discovery_run SET status = 'error', finished_at = now(), error = 'Interrupted' WHERE status = 'running' AND started_at < now() - interval '6 hours'`);
      const { rows: due } = await pool.query<{ id: string }>(
        `SELECT s.id FROM discovery_source s
         WHERE s.enabled AND s.schedule_hours > 0
           AND (s.last_run_at IS NULL OR s.last_run_at + make_interval(hours => s.schedule_hours) <= now())
           AND NOT EXISTS (SELECT 1 FROM discovery_run r WHERE r.source_id = s.id AND r.status = 'running')
         ORDER BY s.last_run_at NULLS FIRST`,
      );
      for (const s of due) await runDiscovery(pool, config, s.id, 'schedule', deps);
      return due.length;
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    }
  } finally {
    lock.release();
  }
}

export function startDiscoveryScheduler(pool: Pool, config: Config): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueSources(pool, config);
    } catch (err) {
      log.error('discovery: scheduler failed', { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, 5 * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

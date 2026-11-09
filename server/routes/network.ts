import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { CurrentUser } from '../../shared/model';
import { PORT_KINDS, PORT_MODES, expandPortNames, type AssetPort, type DuplicateIp, type PlantNetwork, type Subnet, type SubnetDetail } from '../../shared/network';
import { requirePermission } from '../auth/context';
import { withTransaction, type DbClient } from '../db/pool';
import { audit, diff, snapshot } from '../lib/audit';
import { badRequest, conflict, notFound, parse, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { optText, reqText } from '../lib/schemas';
import { applyScope, assertPlantAccess, hasPlantAccess } from '../lib/scope';

// ---------------------------------------------------------------------------- IPv4 helpers

export function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** First and last usable host of an IPv4 network (null for IPv6) */
export function ipv4Hosts(cidr: string): { first: number; last: number; size: number } | null {
  const [addr, bits] = cidr.split('/');
  const base = ipv4ToInt(addr);
  const prefix = Number(bits ?? 32);
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const total = 2 ** (32 - prefix);
  const network = base - (base % total);
  if (prefix >= 31) return { first: network, last: network + total - 1, size: total };
  return { first: network + 1, last: network + total - 2, size: total - 2 };
}

// ---------------------------------------------------------------------------- schemas

const vlanSchema = z.object({
  plant_id: z.string().uuid(),
  vid: z.number().int().min(1).max(4094),
  name: reqText(100),
  description: optText(1000),
});

const IPV4_CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const IPV6_CIDR = /^[0-9a-f:]+\/\d{1,3}$/i;

const subnetSchema = z.object({
  plant_id: z.string().uuid(),
  cidr: z
    .string()
    .trim()
    .refine((v) => IPV4_CIDR.test(v) || IPV6_CIDR.test(v), 'Expected a network such as 10.10.20.0/24'),
  name: reqText(100),
  vlan_id: z
    .string()
    .uuid()
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  gateway: optText(64),
  dhcp_range: optText(200),
  description: optText(2000),
});

const vlanList = z
  .array(z.number().int().min(1).max(4094))
  .max(4094)
  .nullish()
  .transform((v) => [...new Set(v ?? [])].sort((a, b) => a - b));

const portFields = {
  kind: z.enum(PORT_KINDS).default('ethernet'),
  speed: optText(30),
  description: optText(500),
  enabled: z.boolean().default(true),
  mode: z
    .enum(PORT_MODES)
    .nullish()
    .transform((v) => v ?? null),
  untagged_vlan: z
    .number()
    .int()
    .min(1)
    .max(4094)
    .nullish()
    .transform((v) => v ?? null),
  tagged_vlans: vlanList,
  mac_address: optText(32),
  cable_label: optText(100),
};

const portCreateSchema = z.object({
  /** "Gi1/0/1-48, Te1/1/1-4" */
  names: z.string().trim().min(1, 'Required').max(2000),
  ...portFields,
});

const portUpdateSchema = z.object({ name: reqText(64), ...portFields });

const connectSchema = z.object({
  port_id: z.string().uuid(),
  cable_label: optText(100),
});

// ---------------------------------------------------------------------------- queries

export const PORT_SELECT = `
  ap.id, ap.asset_id, ap.name, ap.position, ap.kind, ap.speed, ap.description, ap.enabled, ap.mode, ap.untagged_vlan, ap.tagged_vlans,
  ap.mac_address, ap.cable_label, ap.source, ap.connected_port_id,
  pp.name AS peer_port_name, pa.id AS peer_asset_id, pa.name AS peer_asset_name, pa.type AS peer_asset_type, pa.status AS peer_asset_status,
  pa.plant_id AS peer_plant_id`;
export const PORT_FROM = `
  FROM asset_port ap
  LEFT JOIN asset_port pp ON pp.id = ap.connected_port_id
  LEFT JOIN asset pa ON pa.id = pp.asset_id`;

/** Natural order: Gi1/0/2 before Gi1/0/10 */
const PORT_ORDER = `ORDER BY ap.position, regexp_replace(lower(ap.name), '\\d+', '', 'g'), (substring(ap.name from '(\\d+)\\D*$'))::int NULLS FIRST, ap.name`;

function maskPeer(user: CurrentUser, row: Record<string, unknown>): AssetPort {
  const { peer_plant_id: peerPlant, ...rest } = row;
  if (rest.peer_asset_id && !hasPlantAccess(user, peerPlant as string | null)) {
    return { ...(rest as unknown as AssetPort), peer_asset_id: null, peer_asset_name: 'Device in another plant', peer_port_name: null };
  }
  return rest as unknown as AssetPort;
}

export async function loadPorts(db: DbClient, user: CurrentUser, assetId: string): Promise<AssetPort[]> {
  const { rows } = await db.query(`SELECT ${PORT_SELECT} ${PORT_FROM} WHERE ap.asset_id = $1 ${PORT_ORDER}`, [assetId]);
  return rows.map((r) => maskPeer(user, r));
}

async function assetForWrite(db: DbClient, user: CurrentUser, assetId: string) {
  const { rows } = await db.query<{ id: string; name: string; plant_id: string | null }>('SELECT id, name, plant_id FROM asset WHERE id = $1', [assetId]);
  if (!rows[0]) throw notFound('Asset');
  assertPlantAccess(user, rows[0].plant_id);
  return rows[0];
}

async function portForWrite(db: DbClient, user: CurrentUser, portId: string) {
  const { rows } = await db.query(
    `SELECT ap.*, a.name AS asset_name, a.plant_id FROM asset_port ap JOIN asset a ON a.id = ap.asset_id WHERE ap.id = $1 FOR UPDATE OF ap`,
    [portId],
  );
  if (!rows[0]) throw notFound('Port');
  assertPlantAccess(user, rows[0].plant_id);
  return rows[0];
}

const ASSET_IN_SUBNET = `cmdb_inet(a.ip_address) <<= s.cidr AND (a.plant_id = s.plant_id OR a.plant_id IS NULL) AND a.status <> 'retired'`;

const SUBNET_SELECT = `
  s.id, s.plant_id, p.code AS plant_code, s.cidr::text AS cidr, s.name, s.vlan_id, v.vid AS vlan_vid, v.name AS vlan_name,
  host(s.gateway) AS gateway, s.dhcp_range, s.description,
  (SELECT count(DISTINCT cmdb_inet(a.ip_address)) FROM asset a WHERE ${ASSET_IN_SUBNET}) AS used,
  (SELECT count(*) FROM (SELECT 1 FROM asset a WHERE ${ASSET_IN_SUBNET} GROUP BY cmdb_inet(a.ip_address) HAVING count(*) > 1) d) AS duplicates`;
const SUBNET_FROM = `FROM subnet s JOIN plant p ON p.id = s.plant_id LEFT JOIN vlan v ON v.id = s.vlan_id`;

function withSize<T extends { cidr: string }>(row: T): T & { size: number | null } {
  return { ...row, size: ipv4Hosts(row.cidr)?.size ?? null };
}

async function loadSubnet(db: DbClient, id: string): Promise<Subnet> {
  const { rows } = await db.query(`SELECT ${SUBNET_SELECT} ${SUBNET_FROM} WHERE s.id = $1`, [id]);
  if (!rows[0]) throw notFound('Subnet');
  return withSize(rows[0]);
}

async function checkVlan(db: DbClient, vlanId: string | null, plantId: string) {
  if (!vlanId) return;
  const { rows } = await db.query('SELECT plant_id FROM vlan WHERE id = $1', [vlanId]);
  if (!rows[0]) throw badRequest('VLAN does not exist');
  if (rows[0].plant_id !== plantId) throw badRequest('The VLAN belongs to another plant');
}

async function normaliseSubnet(db: DbClient, input: z.infer<typeof subnetSchema>) {
  // "10.10.20.5/24" → "10.10.20.0/24"; invalid input → 400
  const { rows } = await db
    .query<{ cidr: string; in_net: boolean | null; gw: string | null }>(
      `SELECT network($1::inet)::cidr::text AS cidr, CASE WHEN $2::text IS NULL THEN NULL ELSE $2::inet <<= network($1::inet) END AS in_net,
              CASE WHEN $2::text IS NULL THEN NULL ELSE host($2::inet) END AS gw`,
      [input.cidr, input.gateway],
    )
    .catch(() => {
      throw badRequest('Invalid network or gateway address');
    });
  if (input.gateway && !rows[0].in_net) throw badRequest(`The gateway ${input.gateway} is not inside ${rows[0].cidr}`);
  return { ...input, cidr: rows[0].cidr, gateway: rows[0].gw };
}

export function networkRouter(pool: Pool): Router {
  const r = Router();

  // ---------------------------------------------------------------- overview of a plant
  r.get('/plants/:id/network', async (req, res) => {
    const plantId = requireUuid(req.params.id);
    assertPlantAccess(req.user!, plantId);
    const [vlans, subnets, dups, unassigned, connections] = await Promise.all([
      pool.query(
        `SELECT v.id, v.plant_id, v.vid, v.name, v.description,
                (SELECT count(*) FROM subnet s WHERE s.vlan_id = v.id) AS subnet_count,
                (SELECT count(*) FROM asset_port ap JOIN asset a ON a.id = ap.asset_id
                  WHERE a.plant_id = v.plant_id AND (ap.untagged_vlan = v.vid OR v.vid = ANY(ap.tagged_vlans))) AS port_count
         FROM vlan v WHERE v.plant_id = $1 ORDER BY v.vid`,
        [plantId],
      ),
      pool.query(`SELECT ${SUBNET_SELECT} ${SUBNET_FROM} WHERE s.plant_id = $1 ORDER BY s.cidr`, [plantId]),
      pool.query(
        `SELECT host(cmdb_inet(a.ip_address)) AS ip,
                json_agg(json_build_object('id', a.id, 'name', a.name, 'type', a.type, 'plant_code', p.code) ORDER BY a.name) AS assets
         FROM asset a LEFT JOIN plant p ON p.id = a.plant_id
         WHERE a.plant_id = $1 AND a.status <> 'retired' AND cmdb_inet(a.ip_address) IS NOT NULL
         GROUP BY cmdb_inet(a.ip_address) HAVING count(*) > 1 ORDER BY cmdb_inet(a.ip_address)`,
        [plantId],
      ),
      pool.query(
        `SELECT a.id, a.name, a.type, a.ip_address FROM asset a
         WHERE a.plant_id = $1 AND a.status <> 'retired' AND cmdb_inet(a.ip_address) IS NOT NULL
           AND EXISTS (SELECT 1 FROM subnet s WHERE s.plant_id = $1)
           AND NOT EXISTS (SELECT 1 FROM subnet s WHERE s.plant_id = $1 AND cmdb_inet(a.ip_address) <<= s.cidr)
         ORDER BY cmdb_inet(a.ip_address) LIMIT 200`,
        [plantId],
      ),
      pool.query(
        `SELECT count(*) AS n FROM asset_port ap JOIN asset a ON a.id = ap.asset_id
         WHERE a.plant_id = $1 AND ap.connected_port_id IS NOT NULL`,
        [plantId],
      ),
    ]);
    const body: PlantNetwork = {
      vlans: vlans.rows,
      subnets: subnets.rows.map(withSize),
      duplicates: dups.rows as DuplicateIp[],
      unassigned: unassigned.rows,
      // every cable is counted at both ends
      connections: Math.ceil(Number(connections.rows[0].n) / 2),
    };
    res.json(body);
  });

  /** IP addresses documented on more than one device (within the plants the user can see) */
  r.get('/ipam/duplicates', async (req, res) => {
    const sql = new SqlBuilder();
    applyScope(sql, req.user!, 'a.plant_id');
    sql.and(`a.status <> 'retired'`);
    sql.and('cmdb_inet(a.ip_address) IS NOT NULL');
    const { rows } = await pool.query(
      `SELECT host(cmdb_inet(a.ip_address)) AS ip,
              json_agg(json_build_object('id', a.id, 'name', a.name, 'type', a.type, 'plant_code', p.code) ORDER BY a.name) AS assets
       FROM asset a LEFT JOIN plant p ON p.id = a.plant_id ${sql.whereSql()}
       GROUP BY a.plant_id, cmdb_inet(a.ip_address) HAVING count(*) > 1 ORDER BY 1`,
      sql.params,
    );
    res.json(rows as DuplicateIp[]);
  });

  // ---------------------------------------------------------------- VLANs
  r.get('/vlans', async (req, res) => {
    const sql = new SqlBuilder();
    applyScope(sql, req.user!, 'v.plant_id');
    const plantId = queryString(req.query.plantId);
    if (plantId) sql.and(`v.plant_id = ${sql.p(requireUuid(plantId, 'plantId'))}`);
    const { rows } = await pool.query(`SELECT v.id, v.plant_id, v.vid, v.name, v.description FROM vlan v ${sql.whereSql()} ORDER BY v.vid`, sql.params);
    res.json(rows);
  });

  r.post('/vlans', requirePermission('asset.write'), async (req, res) => {
    const input = parse(vlanSchema, req.body);
    assertPlantAccess(req.user!, input.plant_id);
    const row = await withTransaction(pool, async (db) => {
      const { rows } = await db
        .query('INSERT INTO vlan (plant_id, vid, name, description) VALUES ($1,$2,$3,$4) RETURNING *', [input.plant_id, input.vid, input.name, input.description])
        .catch((e) => {
          if (e.code === '23505') throw conflict(`VLAN ${input.vid} already exists in this plant`);
          throw e;
        });
      await audit(db, req, { action: 'create', entityType: 'vlan', entityId: rows[0].id, entityLabel: `VLAN ${input.vid} ${input.name}`, plantId: input.plant_id, changes: snapshot(rows[0]) });
      return rows[0];
    });
    res.status(201).json(row);
  });

  r.put('/vlans/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(vlanSchema.omit({ plant_id: true }), req.body);
    const row = await withTransaction(pool, async (db) => {
      const before = (await db.query('SELECT * FROM vlan WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound('VLAN');
      assertPlantAccess(req.user!, before.plant_id);
      const { rows } = await db
        .query('UPDATE vlan SET vid = $2, name = $3, description = $4, updated_at = now() WHERE id = $1 RETURNING *', [id, input.vid, input.name, input.description])
        .catch((e) => {
          if (e.code === '23505') throw conflict(`VLAN ${input.vid} already exists in this plant`);
          throw e;
        });
      const changes = diff(before, rows[0]);
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'update', entityType: 'vlan', entityId: id, entityLabel: `VLAN ${input.vid} ${input.name}`, plantId: before.plant_id, changes });
      return rows[0];
    });
    res.json(row);
  });

  r.delete('/vlans/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const before = (await db.query('SELECT * FROM vlan WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound('VLAN');
      assertPlantAccess(req.user!, before.plant_id);
      await db.query('DELETE FROM vlan WHERE id = $1', [id]);
      await audit(db, req, { action: 'delete', entityType: 'vlan', entityId: id, entityLabel: `VLAN ${before.vid} ${before.name}`, plantId: before.plant_id, changes: snapshot(before) });
    });
    res.status(204).end();
  });

  // ---------------------------------------------------------------- subnets (IPAM)
  r.get('/subnets', async (req, res) => {
    const sql = new SqlBuilder();
    applyScope(sql, req.user!, 's.plant_id');
    const plantId = queryString(req.query.plantId);
    if (plantId) sql.and(`s.plant_id = ${sql.p(requireUuid(plantId, 'plantId'))}`);
    const { rows } = await pool.query(`SELECT ${SUBNET_SELECT} ${SUBNET_FROM} ${sql.whereSql()} ORDER BY p.code, s.cidr`, sql.params);
    res.json(rows.map(withSize));
  });

  r.get('/subnets/:id', async (req, res) => {
    const id = requireUuid(req.params.id);
    const subnet = await loadSubnet(pool, id);
    assertPlantAccess(req.user!, subnet.plant_id);
    const { rows } = await pool.query(
      `SELECT host(cmdb_inet(a.ip_address)) AS ip, a.id AS asset_id, a.name AS asset_name, a.type AS asset_type, a.status AS asset_status,
              count(*) OVER (PARTITION BY cmdb_inet(a.ip_address)) > 1 AS duplicate
       FROM subnet s JOIN asset a ON ${ASSET_IN_SUBNET}
       WHERE s.id = $1 ORDER BY cmdb_inet(a.ip_address), a.name`,
      [id],
    );
    const hosts = ipv4Hosts(subnet.cidr);
    const free: SubnetDetail['free'] = [];
    let nextFree: string | null = null;
    if (hosts && hosts.size <= 65_536) {
      const taken = new Set<number>(rows.map((x) => ipv4ToInt(x.ip)).filter((n): n is number => n !== null));
      const gw = subnet.gateway ? ipv4ToInt(subnet.gateway) : null;
      if (gw !== null) taken.add(gw);
      let start: number | null = null;
      for (let n = hosts.first; n <= hosts.last + 1; n++) {
        const isFree = n <= hosts.last && !taken.has(n);
        if (isFree && start === null) start = n;
        if (!isFree && start !== null) {
          if (free.length < 100) free.push({ from: intToIpv4(start), to: intToIpv4(n - 1), count: n - start });
          nextFree ??= intToIpv4(start);
          start = null;
        }
      }
    }
    const body: SubnetDetail = { ...subnet, addresses: rows, free, nextFree };
    res.json(body);
  });

  r.post('/subnets', requirePermission('asset.write'), async (req, res) => {
    const parsed = parse(subnetSchema, req.body);
    assertPlantAccess(req.user!, parsed.plant_id);
    const row = await withTransaction(pool, async (db) => {
      const input = await normaliseSubnet(db, parsed);
      await checkVlan(db, input.vlan_id, input.plant_id);
      const { rows } = await db
        .query(
          `INSERT INTO subnet (plant_id, cidr, name, vlan_id, gateway, dhcp_range, description) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [input.plant_id, input.cidr, input.name, input.vlan_id, input.gateway, input.dhcp_range, input.description],
        )
        .catch((e) => {
          if (e.code === '23505') throw conflict(`The subnet ${input.cidr} already exists in this plant`);
          throw e;
        });
      const created = await loadSubnet(db, rows[0].id);
      await audit(db, req, { action: 'create', entityType: 'subnet', entityId: created.id, entityLabel: `${created.cidr} ${created.name}`, plantId: created.plant_id, changes: snapshot({ cidr: created.cidr, name: created.name, gateway: created.gateway, vlan: created.vlan_vid }) });
      return created;
    });
    res.status(201).json(row);
  });

  r.put('/subnets/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const row = await withTransaction(pool, async (db) => {
      const before = await loadSubnet(db, id);
      assertPlantAccess(req.user!, before.plant_id);
      const input = await normaliseSubnet(db, parse(subnetSchema, { ...req.body, plant_id: before.plant_id }));
      await checkVlan(db, input.vlan_id, before.plant_id);
      await db
        .query(`UPDATE subnet SET cidr = $2, name = $3, vlan_id = $4, gateway = $5, dhcp_range = $6, description = $7, updated_at = now() WHERE id = $1`, [
          id,
          input.cidr,
          input.name,
          input.vlan_id,
          input.gateway,
          input.dhcp_range,
          input.description,
        ])
        .catch((e) => {
          if (e.code === '23505') throw conflict(`The subnet ${input.cidr} already exists in this plant`);
          throw e;
        });
      const after = await loadSubnet(db, id);
      const pick = (s: Subnet) => ({ cidr: s.cidr, name: s.name, vlan: s.vlan_vid, gateway: s.gateway, dhcp_range: s.dhcp_range, description: s.description });
      const changes = diff(pick(before), pick(after));
      if (Object.keys(changes).length) await audit(db, req, { action: 'update', entityType: 'subnet', entityId: id, entityLabel: `${after.cidr} ${after.name}`, plantId: after.plant_id, changes });
      return after;
    });
    res.json(row);
  });

  r.delete('/subnets/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const before = await loadSubnet(db, id);
      assertPlantAccess(req.user!, before.plant_id);
      await db.query('DELETE FROM subnet WHERE id = $1', [id]);
      await audit(db, req, { action: 'delete', entityType: 'subnet', entityId: id, entityLabel: `${before.cidr} ${before.name}`, plantId: before.plant_id, changes: { cidr: before.cidr, name: before.name } });
    });
    res.status(204).end();
  });

  // ---------------------------------------------------------------- ports
  r.get('/assets/:id/ports', async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query('SELECT plant_id FROM asset WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Asset');
    assertPlantAccess(req.user!, rows[0].plant_id);
    res.json(await loadPorts(pool, req.user!, id));
  });

  r.post('/assets/:id/ports', requirePermission('asset.write'), async (req, res) => {
    const assetId = requireUuid(req.params.id);
    const input = parse(portCreateSchema, req.body);
    let names: string[];
    try {
      names = expandPortNames(input.names);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (!names.length) throw badRequest('Enter at least one port name');
    if (names.some((n) => n.length > 64)) throw badRequest('Port names can have at most 64 characters');
    const lower = names.map((n) => n.toLowerCase());
    if (new Set(lower).size !== lower.length) throw badRequest('The same port name is listed twice');
    const ports = await withTransaction(pool, async (db) => {
      const asset = await assetForWrite(db, req.user!, assetId);
      const existing = await db.query<{ name: string }>('SELECT name FROM asset_port WHERE asset_id = $1 AND lower(name) = ANY($2::text[])', [assetId, lower]);
      if (existing.rows.length) throw conflict(`Port(s) already exist: ${existing.rows.map((x) => x.name).join(', ')}`);
      const { rows: pos } = await db.query<{ n: number }>('SELECT COALESCE(max(position), 0) AS n FROM asset_port WHERE asset_id = $1', [assetId]);
      let position = Number(pos[0].n);
      for (const name of names) {
        await db.query(
          `INSERT INTO asset_port (asset_id, name, position, kind, speed, description, enabled, mode, untagged_vlan, tagged_vlans, mac_address, cable_label)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [assetId, name, ++position, input.kind, input.speed, input.description, input.enabled, input.mode, input.untagged_vlan, input.tagged_vlans, input.mac_address, names.length === 1 ? input.cable_label : null],
        );
      }
      await audit(db, req, {
        action: 'port.add',
        entityType: 'asset',
        entityId: assetId,
        entityLabel: asset.name,
        plantId: asset.plant_id,
        changes: { ports: names.length > 6 ? `${names[0]} … ${names[names.length - 1]} (${names.length})` : names.join(', ') },
      });
      return loadPorts(db, req.user!, assetId);
    });
    res.status(201).json(ports);
  });

  r.put('/ports/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(portUpdateSchema, req.body);
    const port = await withTransaction(pool, async (db) => {
      const before = await portForWrite(db, req.user!, id);
      const { rows } = await db
        .query(
          `UPDATE asset_port SET name=$2, kind=$3, speed=$4, description=$5, enabled=$6, mode=$7, untagged_vlan=$8, tagged_vlans=$9, mac_address=$10,
                  cable_label=$11, updated_at=now() WHERE id = $1 RETURNING *`,
          [id, input.name, input.kind, input.speed, input.description, input.enabled, input.mode, input.untagged_vlan, input.tagged_vlans, input.mac_address, input.cable_label],
        )
        .catch((e) => {
          if (e.code === '23505') throw conflict(`Port ${input.name} already exists on this device`);
          throw e;
        });
      // one cable, one label: keep both ends in sync
      if (before.connected_port_id && before.cable_label !== input.cable_label)
        await db.query('UPDATE asset_port SET cable_label = $2, updated_at = now() WHERE id = $1', [before.connected_port_id, input.cable_label]);
      const changes = diff(before, rows[0]);
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'port.update', entityType: 'asset', entityId: before.asset_id, entityLabel: before.asset_name, plantId: before.plant_id, changes: { port: input.name, ...changes } });
      return (await db.query(`SELECT ${PORT_SELECT} ${PORT_FROM} WHERE ap.id = $1`, [id])).rows[0];
    });
    res.json(maskPeer(req.user!, port));
  });

  r.delete('/ports/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const before = await portForWrite(db, req.user!, id);
      await db.query('DELETE FROM asset_port WHERE id = $1', [id]);
      await audit(db, req, { action: 'port.remove', entityType: 'asset', entityId: before.asset_id, entityLabel: before.asset_name, plantId: before.plant_id, changes: { port: before.name } });
    });
    res.status(204).end();
  });

  /** Connects two ports with a cable. Existing connections of both ports are replaced. */
  r.post('/ports/:id/connect', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(connectSchema, req.body);
    if (input.port_id === id) throw badRequest('A port cannot be connected to itself');
    const port = await withTransaction(pool, async (db) => {
      // lock in a stable order to avoid deadlocks between two simultaneous connects
      const [first, second] = [id, input.port_id].sort();
      const p1 = await portForWrite(db, req.user!, first);
      const p2 = await portForWrite(db, req.user!, second);
      const a = p1.id === id ? p1 : p2;
      const b = p1.id === id ? p2 : p1;
      if (a.asset_id === b.asset_id) throw badRequest('Both ports belong to the same device');
      const replaced = [a.connected_port_id, b.connected_port_id].filter((x) => x && x !== a.id && x !== b.id);
      await db.query('UPDATE asset_port SET connected_port_id = NULL, cable_label = NULL, updated_at = now() WHERE id = ANY($1::uuid[])', [replaced]);
      await db.query('UPDATE asset_port SET connected_port_id = NULL WHERE id = ANY($1::uuid[])', [[a.id, b.id]]);
      await db.query('UPDATE asset_port SET connected_port_id = $2, cable_label = $3, updated_at = now() WHERE id = $1', [a.id, b.id, input.cable_label]);
      await db.query('UPDATE asset_port SET connected_port_id = $2, cable_label = $3, updated_at = now() WHERE id = $1', [b.id, a.id, input.cable_label]);
      const changes = { port: a.name, to: `${b.asset_name} ${b.name}`, cable: input.cable_label };
      await audit(db, req, { action: 'port.connect', entityType: 'asset', entityId: a.asset_id, entityLabel: a.asset_name, plantId: a.plant_id, changes });
      await audit(db, req, { action: 'port.connect', entityType: 'asset', entityId: b.asset_id, entityLabel: b.asset_name, plantId: b.plant_id, changes: { port: b.name, to: `${a.asset_name} ${a.name}`, cable: input.cable_label } });
      return (await db.query(`SELECT ${PORT_SELECT} ${PORT_FROM} WHERE ap.id = $1`, [id])).rows[0];
    });
    res.json(maskPeer(req.user!, port));
  });

  r.post('/ports/:id/disconnect', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const a = await portForWrite(db, req.user!, id);
      if (!a.connected_port_id) return;
      const b = await portForWrite(db, req.user!, a.connected_port_id);
      await db.query('UPDATE asset_port SET connected_port_id = NULL, cable_label = NULL, updated_at = now() WHERE id = ANY($1::uuid[])', [[a.id, b.id]]);
      await audit(db, req, { action: 'port.disconnect', entityType: 'asset', entityId: a.asset_id, entityLabel: a.asset_name, plantId: a.plant_id, changes: { port: a.name, from: `${b.asset_name} ${b.name}` } });
      await audit(db, req, { action: 'port.disconnect', entityType: 'asset', entityId: b.asset_id, entityLabel: b.asset_name, plantId: b.plant_id, changes: { port: b.name, from: `${a.asset_name} ${a.name}` } });
    });
    res.status(204).end();
  });

  /** Find a cable by its label */
  r.get('/cables', async (req, res) => {
    const label = queryString(req.query.label);
    if (!label) throw badRequest('label is required');
    const sql = new SqlBuilder();
    applyScope(sql, req.user!, 'a.plant_id');
    sql.and(`lower(ap.cable_label) = lower(${sql.p(label)})`);
    const { rows } = await pool.query(
      `SELECT ${PORT_SELECT}, a.name AS asset_name, a.type AS asset_type FROM asset_port ap JOIN asset a ON a.id = ap.asset_id
       LEFT JOIN asset_port pp ON pp.id = ap.connected_port_id LEFT JOIN asset pa ON pa.id = pp.asset_id ${sql.whereSql()} ORDER BY a.name, ap.name`,
      sql.params,
    );
    res.json(rows.map((x) => ({ ...maskPeer(req.user!, x), asset_name: x.asset_name, asset_type: x.asset_type })));
  });

  return r;
}

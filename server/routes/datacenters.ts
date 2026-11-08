import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { CurrentUser } from '../../shared/model';
import { DATACENTER_KINDS, DC_LINK_KINDS, DC_SITE_ROLES } from '../../shared/datacenters';
import { requirePermission } from '../auth/context';
import { withTransaction, type DbClient } from '../db/pool';
import { audit, diff, snapshot } from '../lib/audit';
import { badRequest, notFound, parse, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { optText, reqText } from '../lib/schemas';
import { applyScope, assertPlantAccess, isUnscoped } from '../lib/scope';

/**
 * Data centers: one or more server rooms (sites) of a plant that work as one data center.
 * A stretched data center spans two buildings (site A / site B) and optionally a witness site.
 */

// ---------------------------------------------------------------- schemas

const siteSchema = z.object({
  id: z
    .string()
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
  name: reqText(60),
  role: z.enum(DC_SITE_ROLES),
  building_id: z.string().uuid(),
  room: optText(100),
});

const datacenterSchema = z
  .object({
    plant_id: z.string().uuid(),
    name: reqText(100),
    kind: z.enum(DATACENTER_KINDS).default('stretched'),
    description: optText(4000),
    sites: z.array(siteSchema).min(1, 'At least one site is required').max(3, 'At most three sites'),
  })
  .superRefine((dc, ctx) => {
    const witnesses = dc.sites.filter((s) => s.role === 'witness').length;
    const main = dc.sites.length - witnesses;
    if (witnesses > 1) ctx.addIssue({ code: 'custom', path: ['sites'], message: 'Only one witness site is allowed' });
    if (dc.kind === 'single' && (dc.sites.length !== 1 || witnesses)) {
      ctx.addIssue({ code: 'custom', path: ['sites'], message: 'A single-site data center has exactly one site' });
    }
    if (dc.kind === 'stretched' && main !== 2) {
      ctx.addIssue({ code: 'custom', path: ['sites'], message: 'A stretched data center has two main sites (plus an optional witness)' });
    }
    const keys = dc.sites.map((s) => `${s.building_id}|${(s.room ?? '').trim().toLowerCase()}`);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['sites'], message: 'Each site must be a different building or room' });
  });
export type DatacenterBody = z.infer<typeof datacenterSchema>;

const linkSchema = z
  .object({
    site_a_id: z.string().uuid(),
    site_b_id: z.string().uuid(),
    kind: z.enum(DC_LINK_KINDS).default('fiber'),
    label: reqText(100),
    capacity: optText(100),
    length_m: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .nullish()
      .transform((v) => v ?? null),
    note: optText(500),
  })
  .refine((l) => l.site_a_id !== l.site_b_id, { message: 'A link connects two different sites', path: ['site_b_id'] });

// ------------------------------------------------------------------ SQL

/** Racks of a site: racks in the site's building, restricted to the room when one is set */
const SITE_RACK_MATCH = `r.building_id = s.building_id AND (s.room IS NULL OR lower(btrim(coalesce(r.room, ''))) = lower(btrim(s.room)))`;

const SITE_SELECT = `
  s.id, s.datacenter_id, s.name, s.role, s.building_id, b.name AS building_name, b.code AS building_code, s.room, s.position,
  (SELECT count(*) FROM rack r WHERE ${SITE_RACK_MATCH}) AS rack_count,
  (SELECT count(*) FROM asset a JOIN rack r ON r.id = a.rack_id WHERE ${SITE_RACK_MATCH}) AS device_count`;
const SITE_FROM = `FROM datacenter_site s JOIN building b ON b.id = s.building_id`;

const DC_SELECT = `
  d.id, d.plant_id, p.code AS plant_code, p.name AS plant_name, d.name, d.kind, d.description, d.created_at, d.updated_at,
  (SELECT count(*) FROM datacenter_link l WHERE l.datacenter_id = d.id) AS link_count`;
const DC_FROM = `FROM datacenter d JOIN plant p ON p.id = d.plant_id`;

// --------------------------------------------------------------- loaders

export async function loadDatacenterSummaries(db: DbClient, user: CurrentUser, plantId?: string) {
  const sql = new SqlBuilder();
  applyScope(sql, user, 'd.plant_id');
  if (plantId) sql.and(`d.plant_id = ${sql.p(plantId)}`);
  const { rows } = await db.query(`SELECT ${DC_SELECT} ${DC_FROM} ${sql.whereSql()} ORDER BY p.code, lower(d.name)`, sql.params);
  if (!rows.length) return [];
  const sites = await db.query(`SELECT ${SITE_SELECT} ${SITE_FROM} WHERE s.datacenter_id = ANY($1::uuid[]) ORDER BY s.position, s.name`, [rows.map((r) => r.id)]);
  return rows.map((d) => ({ ...d, sites: sites.rows.filter((s) => s.datacenter_id === d.id) }));
}

async function loadDatacenter(db: DbClient, id: string, user: CurrentUser) {
  const { rows } = await db.query(`SELECT ${DC_SELECT} ${DC_FROM} WHERE d.id = $1`, [id]);
  if (!rows[0]) throw notFound('Data center');
  assertPlantAccess(user, rows[0].plant_id);
  return rows[0];
}

async function loadDetail(db: DbClient, id: string, user: CurrentUser) {
  const dc = await loadDatacenter(db, id, user);
  const { rows: sites } = await db.query(`SELECT ${SITE_SELECT} ${SITE_FROM} WHERE s.datacenter_id = $1 ORDER BY s.position, s.name`, [id]);

  // Racks per site (a rack may match only one site of a data center – the first by position wins)
  const { rows: racks } = await db.query(
    `SELECT DISTINCT ON (r.id) s.id AS site_id, r.id, r.name, r.height_u,
            (SELECT COALESCE(sum(a.rack_height_u), 0) FROM asset a WHERE a.rack_id = r.id AND a.rack_u IS NOT NULL)
              + (SELECT COALESCE(sum(i.height_u), 0) FROM rack_item i WHERE i.rack_id = r.id) AS used_u
     FROM datacenter_site s JOIN rack r ON ${SITE_RACK_MATCH}
     WHERE s.datacenter_id = $1
     ORDER BY r.id, s.position`,
    [id],
  );
  const rackIds = racks.map((r) => r.id);
  const { rows: devices } = await db.query(
    `SELECT a.id, a.name, a.type, a.status, a.model, a.ip_address, a.rack_id, a.rack_u, a.rack_height_u,
            a.attributes->>'cluster' AS cluster, a.attributes->>'role' AS role
     FROM asset a WHERE a.rack_id = ANY($1::uuid[])
     ORDER BY a.rack_u DESC NULLS LAST, a.name`,
    [rackIds],
  );
  // Switches/servers documented in the site's room but not mounted in a rack
  const { rows: loose } = await db.query(
    `SELECT s.id AS site_id, a.id, a.name, a.type, a.status, a.model, a.ip_address, NULL::uuid AS rack_id, NULL::int AS rack_u, a.rack_height_u,
            a.attributes->>'cluster' AS cluster, a.attributes->>'role' AS role
     FROM datacenter_site s JOIN asset a
       ON a.building_id = s.building_id AND a.rack_id IS NULL AND a.type IN ('switch','server')
      AND s.room IS NOT NULL AND lower(btrim(coalesce(a.room, ''))) = lower(btrim(s.room))
     WHERE s.datacenter_id = $1 ORDER BY a.name`,
    [id],
  );

  const deviceSite = new Map<string, string>();
  const strip = ({ rack_id: _r, site_id: _s, ...d }: Record<string, unknown>) => d;
  const siteDetails = sites.map((s) => {
    const siteRacks = racks
      .filter((r) => r.site_id === s.id)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((r) => {
        const rackDevices = devices.filter((d) => d.rack_id === r.id);
        for (const d of rackDevices) deviceSite.set(d.id, s.id);
        return { id: r.id, name: r.name, height_u: r.height_u, used_u: r.used_u, devices: rackDevices.map(strip) };
      });
    const siteLoose = loose.filter((d) => d.site_id === s.id && !deviceSite.has(d.id));
    for (const d of siteLoose) deviceSite.set(d.id, s.id);
    if (siteLoose.length) siteRacks.push({ id: null, name: 'Not in a rack', height_u: null, used_u: null, devices: siteLoose.map(strip) });
    return { ...s, racks: siteRacks };
  });

  const ids = [...deviceSite.keys()];
  const { rows: relations } = await db.query(
    `SELECT id, relation, source_id, target_id, source_port, target_port FROM asset_relation
     WHERE source_id = ANY($1::uuid[]) AND target_id = ANY($1::uuid[]) ORDER BY relation, created_at`,
    [ids],
  );
  const connections = relations.map((r) => ({ ...r, source_site_id: deviceSite.get(r.source_id)!, target_site_id: deviceSite.get(r.target_id)! }));

  // Clusters (from the "cluster" attribute of servers), stretched when members sit in two or more sites
  const clusterMap = new Map<string, Record<string, string[]>>();
  for (const s of siteDetails) {
    for (const rack of s.racks) {
      for (const d of rack.devices as { id: string; type: string; cluster: string | null }[]) {
        if (d.type !== 'server' || !d.cluster) continue;
        const entry = clusterMap.get(d.cluster) ?? {};
        (entry[s.id] ??= []).push(d.id);
        clusterMap.set(d.cluster, entry);
      }
    }
  }
  const clusters = [...clusterMap.entries()]
    .map(([name, bySite]) => ({ name, sites: bySite, stretched: Object.keys(bySite).length >= 2 }))
    .sort((a, b) => Number(b.stretched) - Number(a.stretched) || a.name.localeCompare(b.name));

  const { rows: links } = await db.query(
    `SELECT id, datacenter_id, site_a_id, site_b_id, kind, label, capacity, length_m, note FROM datacenter_link WHERE datacenter_id = $1 ORDER BY lower(label)`,
    [id],
  );
  return { ...dc, sites: siteDetails, links, connections, clusters };
}

async function checkBuildings(db: DbClient, plantId: string, sites: DatacenterBody['sites']) {
  const ids = [...new Set(sites.map((s) => s.building_id))];
  const { rows } = await db.query<{ id: string; plant_id: string; name: string }>('SELECT id, plant_id, name FROM building WHERE id = ANY($1::uuid[])', [ids]);
  for (const id of ids) {
    const b = rows.find((r) => r.id === id);
    if (!b) throw badRequest('Building does not exist');
    if (b.plant_id !== plantId) throw badRequest(`Building ${b.name} belongs to another plant`);
  }
}

function dcLabel(dc: { name: string; plant_code?: string }) {
  return dc.plant_code ? `${dc.plant_code} / ${dc.name}` : dc.name;
}

// ---------------------------------------------------------------- router

export function datacentersRouter(pool: Pool): Router {
  const r = Router();

  r.get('/datacenters', async (req, res) => {
    const plantId = queryString(req.query.plantId);
    res.json(await loadDatacenterSummaries(pool, req.user!, plantId ? requireUuid(plantId, 'plantId') : undefined));
  });

  r.get('/datacenters/:id', async (req, res) => {
    res.json(await loadDetail(pool, requireUuid(req.params.id), req.user!));
  });

  r.post('/datacenters', requirePermission('location.write'), async (req, res) => {
    const input = parse(datacenterSchema, req.body);
    assertPlantAccess(req.user!, input.plant_id);
    const id = await withTransaction(pool, async (db) => {
      const plant = await db.query('SELECT code FROM plant WHERE id = $1', [input.plant_id]);
      if (!plant.rows[0]) throw badRequest('Plant does not exist');
      await checkBuildings(db, input.plant_id, input.sites);
      const { rows } = await db.query(
        `INSERT INTO datacenter (plant_id, name, kind, description, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
        [input.plant_id, input.name, input.kind, input.description, req.user!.id],
      );
      const dcId = rows[0].id as string;
      for (const [i, s] of input.sites.entries()) {
        await db.query('INSERT INTO datacenter_site (datacenter_id, name, role, building_id, room, position) VALUES ($1,$2,$3,$4,$5,$6)', [dcId, s.name, s.role, s.building_id, s.room, i]);
      }
      await audit(db, req, {
        action: 'create',
        entityType: 'datacenter',
        entityId: dcId,
        entityLabel: dcLabel({ name: input.name, plant_code: plant.rows[0].code }),
        plantId: input.plant_id,
        changes: { ...snapshot(rows[0]), sites: input.sites.map((s) => `${s.name} (${s.role})`) },
      });
      return dcId;
    });
    res.status(201).json(await loadDetail(pool, id, req.user!));
  });

  r.put('/datacenters/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(datacenterSchema, req.body);
    await withTransaction(pool, async (db) => {
      const before = await loadDatacenter(db, id, req.user!);
      if (input.plant_id !== before.plant_id) throw badRequest('A data center cannot be moved to another plant');
      await checkBuildings(db, input.plant_id, input.sites);
      const { rows: beforeSites } = await db.query('SELECT id, name, role, building_id, room FROM datacenter_site WHERE datacenter_id = $1 ORDER BY position', [id]);
      for (const s of input.sites) {
        if (s.id && !beforeSites.some((b) => b.id === s.id)) throw badRequest('Site does not belong to this data center');
      }
      const { rows } = await db.query(
        `UPDATE datacenter SET name=$2, kind=$3, description=$4, updated_by=$5, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.name, input.kind, input.description, req.user!.id],
      );
      // Replace the site list: keep sites that come back with their id (so links stay), add new ones, drop the rest
      const keep = input.sites.filter((s) => s.id).map((s) => s.id!);
      await db.query('DELETE FROM datacenter_site WHERE datacenter_id = $1 AND NOT (id = ANY($2::uuid[]))', [id, keep]);
      for (const [i, s] of input.sites.entries()) {
        if (s.id) {
          await db.query('UPDATE datacenter_site SET name=$2, role=$3, building_id=$4, room=$5, position=$6 WHERE id=$1', [s.id, s.name, s.role, s.building_id, s.room, i]);
        } else {
          await db.query('INSERT INTO datacenter_site (datacenter_id, name, role, building_id, room, position) VALUES ($1,$2,$3,$4,$5,$6)', [id, s.name, s.role, s.building_id, s.room, i]);
        }
      }
      const changes: Record<string, unknown> = diff(before, rows[0]);
      const siteText = (list: { name: string; role: string; room: string | null }[]) => list.map((s) => `${s.name} (${s.role}${s.room ? `, ${s.room}` : ''})`).join('; ');
      if (siteText(beforeSites) !== siteText(input.sites)) changes.sites = { from: siteText(beforeSites), to: siteText(input.sites) };
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'update', entityType: 'datacenter', entityId: id, entityLabel: dcLabel({ name: input.name, plant_code: before.plant_code }), plantId: before.plant_id, changes });
    });
    res.json(await loadDetail(pool, id, req.user!));
  });

  r.delete('/datacenters/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const dc = await loadDatacenter(db, id, req.user!);
      await db.query('DELETE FROM datacenter WHERE id = $1', [id]);
      await audit(db, req, { action: 'delete', entityType: 'datacenter', entityId: id, entityLabel: dcLabel(dc), plantId: dc.plant_id, changes: { name: dc.name, kind: dc.kind } });
    });
    res.status(204).end();
  });

  // ----------------------------------------------------------------- links
  async function checkLinkSites(db: DbClient, dcId: string, siteA: string, siteB: string) {
    const { rows } = await db.query('SELECT id FROM datacenter_site WHERE datacenter_id = $1 AND id = ANY($2::uuid[])', [dcId, [siteA, siteB]]);
    if (rows.length !== 2) throw badRequest('Both sites must belong to this data center');
  }

  r.post('/datacenters/:id/links', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(linkSchema, req.body);
    const link = await withTransaction(pool, async (db) => {
      const dc = await loadDatacenter(db, id, req.user!);
      await checkLinkSites(db, id, input.site_a_id, input.site_b_id);
      const { rows } = await db.query(
        `INSERT INTO datacenter_link (datacenter_id, site_a_id, site_b_id, kind, label, capacity, length_m, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, input.site_a_id, input.site_b_id, input.kind, input.label, input.capacity, input.length_m, input.note],
      );
      await audit(db, req, { action: 'datacenter.link.add', entityType: 'datacenter', entityId: id, entityLabel: dcLabel(dc), plantId: dc.plant_id, changes: { link: input.label, kind: input.kind, capacity: input.capacity, length_m: input.length_m } });
      return rows[0];
    });
    res.status(201).json(link);
  });

  async function loadLink(db: DbClient, id: string) {
    const { rows } = await db.query('SELECT * FROM datacenter_link WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Link');
    return rows[0];
  }

  r.put('/datacenter-links/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(linkSchema, req.body);
    const link = await withTransaction(pool, async (db) => {
      const before = await loadLink(db, id);
      const dc = await loadDatacenter(db, before.datacenter_id, req.user!);
      await checkLinkSites(db, before.datacenter_id, input.site_a_id, input.site_b_id);
      const { rows } = await db.query(
        `UPDATE datacenter_link SET site_a_id=$2, site_b_id=$3, kind=$4, label=$5, capacity=$6, length_m=$7, note=$8, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.site_a_id, input.site_b_id, input.kind, input.label, input.capacity, input.length_m, input.note],
      );
      const changes = diff(before, rows[0]);
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'datacenter.link.update', entityType: 'datacenter', entityId: dc.id, entityLabel: dcLabel(dc), plantId: dc.plant_id, changes: { link: input.label, ...changes } });
      return rows[0];
    });
    res.json(link);
  });

  r.delete('/datacenter-links/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const before = await loadLink(db, id);
      const dc = await loadDatacenter(db, before.datacenter_id, req.user!);
      await db.query('DELETE FROM datacenter_link WHERE id = $1', [id]);
      await audit(db, req, { action: 'datacenter.link.remove', entityType: 'datacenter', entityId: dc.id, entityLabel: dcLabel(dc), plantId: dc.plant_id, changes: { link: before.label } });
    });
    res.status(204).end();
  });

  return r;
}

/** Rows for exports: one row per site */
export async function loadDatacenterExportRows(db: DbClient, user: CurrentUser, plantId?: string) {
  const dcs = await loadDatacenterSummaries(db, user, plantId);
  return dcs.flatMap((d) =>
    d.sites.map((s: Record<string, unknown>) => ({
      datacenter: d.name,
      kind: d.kind,
      plant_code: d.plant_code,
      plant_name: d.plant_name,
      site: s.name,
      role: s.role,
      building_code: s.building_code,
      building_name: s.building_name,
      room: s.room,
      rack_count: s.rack_count,
      device_count: s.device_count,
      link_count: d.link_count,
    })),
  );
}

export { isUnscoped };

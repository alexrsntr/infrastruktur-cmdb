import type { CurrentUser } from '../../shared/model';
import { ASSET_STATUSES, ASSET_TYPE_KEYS, CRITICALITIES } from '../../shared/model';
import type { DbClient } from '../db/pool';
import { badRequest, isUuid, likePattern, queryList, queryString, SqlBuilder } from '../lib/http';
import { applyScope } from '../lib/scope';
import type { AssetInput } from '../lib/schemas';
import { assertRackSlot } from './racks';

export const ASSET_SELECT = `
  a.id, a.type, a.name, a.status, a.criticality, a.plant_id, a.building_id, a.floor_id,
  p.name AS plant_name, p.code AS plant_code, b.name AS building_name, b.code AS building_code, f.name AS floor_name,
  a.room, a.rack_id, rk.name AS rack_name, a.rack_u, a.rack_height_u, a.map_x, a.map_y, a.manufacturer, a.model, a.serial_number, a.asset_tag,
  a.ip_address, a.mac_address, a.fqdn, a.os, a.owner, a.cost_center, a.purchase_date, a.warranty_end,
  a.description, a.tags, a.attributes, a.created_at, a.updated_at,
  cu.display_name AS created_by_name, uu.display_name AS updated_by_name,
  la.at AS last_activity_at, la.user_name AS last_activity_by, la.text AS last_activity`;

export const ASSET_FROM = `
  FROM asset a
  LEFT JOIN plant p ON p.id = a.plant_id
  LEFT JOIN building b ON b.id = a.building_id
  LEFT JOIN floor f ON f.id = a.floor_id
  LEFT JOIN rack rk ON rk.id = a.rack_id
  LEFT JOIN app_user cu ON cu.id = a.created_by
  LEFT JOIN app_user uu ON uu.id = a.updated_by
  LEFT JOIN LATERAL (
    SELECT l.at, l.user_name,
      CASE l.action
        WHEN 'note.add' THEN 'Note: ' || (l.changes->>'note')
        WHEN 'activity.add' THEN initcap(l.changes->>'kind') || ': ' || (l.changes->>'title')
        WHEN 'activity.update' THEN 'Activity updated: ' || COALESCE(l.entity_label, '')
        WHEN 'create' THEN 'Added to the CMDB'
        WHEN 'update' THEN 'Changed ' || COALESCE((SELECT string_agg(replace(k, '_', ' '), ', ')
                                                   FROM (SELECT k FROM jsonb_object_keys(l.changes) AS k WHERE k NOT LIKE '\\_%' LIMIT 3) x), 'data')
        WHEN 'attachment.add' THEN 'File added: ' || (l.changes->>'file')
        WHEN 'relation.add' THEN 'Connection added'
        WHEN 'relation.remove' THEN 'Connection removed'
        WHEN 'plan.marker.add' THEN 'Placed on ' || (l.changes->>'plan')
        ELSE replace(l.action, '.', ' ')
      END AS text
    FROM audit_log l
    WHERE l.entity_type = 'asset' AND l.entity_id = a.id AND l.action <> 'export'
    ORDER BY l.at DESC LIMIT 1
  ) la ON true`;

const SORTABLE: Record<string, string> = {
  name: 'lower(a.name)',
  type: 'a.type',
  status: 'a.status',
  criticality: `array_position(ARRAY['low','medium','high','critical'], a.criticality)`,
  plant_name: 'p.name',
  building_name: 'b.name',
  ip_address: 'a.ip_address',
  model: 'a.model',
  manufacturer: 'a.manufacturer',
  serial_number: 'a.serial_number',
  warranty_end: 'a.warranty_end',
  updated_at: 'a.updated_at',
  last_activity: 'la.at',
  created_at: 'a.created_at',
};

export interface AssetFilters {
  types: string[];
  statuses: string[];
  criticalities: string[];
  plantId?: string;
  buildingId?: string;
  floorId?: string;
  q?: string;
  tag?: string;
  warrantyBefore?: string;
  placed?: 'yes' | 'no';
  sort: string;
  order: 'asc' | 'desc';
}

export function parseAssetFilters(query: Record<string, unknown>): AssetFilters {
  const types = queryList(query.type);
  const statuses = queryList(query.status);
  const criticalities = queryList(query.criticality);
  for (const t of types) if (!ASSET_TYPE_KEYS.includes(t as never)) throw badRequest(`Unknown asset type "${t}"`);
  for (const s of statuses) if (!ASSET_STATUSES.includes(s as never)) throw badRequest(`Unknown status "${s}"`);
  for (const c of criticalities) if (!CRITICALITIES.includes(c as never)) throw badRequest(`Unknown criticality "${c}"`);
  const plantId = queryString(query.plantId);
  const buildingId = queryString(query.buildingId);
  const floorId = queryString(query.floorId);
  for (const [k, v] of Object.entries({ plantId, buildingId, floorId })) if (v && !isUuid(v)) throw badRequest(`Invalid ${k}`);
  const sort = queryString(query.sort) ?? 'name';
  const warrantyBefore = queryString(query.warrantyBefore);
  if (warrantyBefore && !/^\d{4}-\d{2}-\d{2}$/.test(warrantyBefore)) throw badRequest('Invalid warrantyBefore');
  const placed = queryString(query.placed);
  return {
    types,
    statuses,
    criticalities,
    plantId,
    buildingId,
    floorId,
    q: queryString(query.q),
    tag: queryString(query.tag),
    warrantyBefore,
    placed: placed === 'yes' || placed === 'no' ? placed : undefined,
    sort: SORTABLE[sort] ? sort : 'name',
    order: queryString(query.order)?.toLowerCase().startsWith('desc') ? 'desc' : 'asc',
  };
}

export function buildAssetQuery(user: CurrentUser, f: AssetFilters): { sql: SqlBuilder; orderBy: string } {
  const sql = new SqlBuilder();
  applyScope(sql, user, 'a.plant_id');
  if (f.types.length) sql.and(`a.type = ANY(${sql.p(f.types)}::text[])`);
  if (f.statuses.length) sql.and(`a.status = ANY(${sql.p(f.statuses)}::text[])`);
  if (f.criticalities.length) sql.and(`a.criticality = ANY(${sql.p(f.criticalities)}::text[])`);
  if (f.plantId) sql.and(`a.plant_id = ${sql.p(f.plantId)}`);
  if (f.buildingId) sql.and(`a.building_id = ${sql.p(f.buildingId)}`);
  if (f.floorId) sql.and(`a.floor_id = ${sql.p(f.floorId)}`);
  if (f.tag) sql.and(`${sql.p(f.tag)} = ANY(a.tags)`);
  if (f.warrantyBefore) sql.and(`a.warranty_end IS NOT NULL AND a.warranty_end <= ${sql.p(f.warrantyBefore)}`);
  if (f.placed === 'yes') sql.and('a.map_x IS NOT NULL');
  if (f.placed === 'no') sql.and('a.map_x IS NULL');
  if (f.q) {
    const like = sql.p(likePattern(f.q));
    sql.and(
      `(a.name ILIKE ${like} OR a.ip_address ILIKE ${like} OR a.serial_number ILIKE ${like} OR a.asset_tag ILIKE ${like}
        OR a.mac_address ILIKE ${like} OR a.fqdn ILIKE ${like} OR a.model ILIKE ${like} OR a.manufacturer ILIKE ${like}
        OR a.description ILIKE ${like} OR a.room ILIKE ${like} OR a.owner ILIKE ${like} OR a.attributes::text ILIKE ${like}
        OR array_to_string(a.tags, ' ') ILIKE ${like})`,
    );
  }
  const orderBy = `ORDER BY ${SORTABLE[f.sort]} ${f.order === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, lower(a.name) ASC`;
  return { sql, orderBy };
}

export interface ResolvedLocation {
  plant_id: string | null;
  building_id: string | null;
  floor_id: string | null;
  map_x: number | null;
  map_y: number | null;
  rack_id: string | null;
  rack_u: number | null;
  rack_height_u: number;
}

export interface LocationInput {
  type?: string;
  plant_id: string | null;
  building_id: string | null;
  floor_id: string | null;
  map_x: number | null;
  map_y: number | null;
  rack_id?: string | null;
  rack_u?: number | null;
  rack_height_u?: number | null;
}

/**
 * Derives a consistent plant → building → floor (→ rack) chain from the most specific location given
 * and validates the rack position. `assetId` is the asset being changed (excluded from the slot check).
 */
export async function resolveAssetLocation(db: DbClient, input: LocationInput, assetId?: string | null): Promise<ResolvedLocation> {
  let { plant_id, building_id, floor_id } = input;
  let rack: { id: string; name: string; building_id: string; floor_id: string | null } | null = null;

  if (input.rack_id) {
    if (input.type === 'vm') throw badRequest('Virtual machines cannot be mounted in a rack');
    const { rows } = await db.query('SELECT id, name, building_id, floor_id FROM rack WHERE id = $1', [input.rack_id]);
    rack = rows[0] ?? null;
    if (!rack) throw badRequest('Rack does not exist');
    if (building_id && building_id !== rack.building_id) throw badRequest(`Rack ${rack.name} is in another building`);
    building_id = rack.building_id;
    if (rack.floor_id) {
      if (floor_id && floor_id !== rack.floor_id) throw badRequest(`Rack ${rack.name} is on another floor`);
      floor_id = rack.floor_id;
    }
  }

  if (floor_id) {
    const { rows } = await db.query<{ building_id: string; plant_id: string }>(
      'SELECT f.building_id, b.plant_id FROM floor f JOIN building b ON b.id = f.building_id WHERE f.id = $1',
      [floor_id],
    );
    if (!rows[0]) throw badRequest('Floor does not exist');
    if (building_id && building_id !== rows[0].building_id) throw badRequest('Floor does not belong to the selected building');
    building_id = rows[0].building_id;
    if (plant_id && plant_id !== rows[0].plant_id) throw badRequest('Building does not belong to the selected plant');
    plant_id = rows[0].plant_id;
  } else if (building_id) {
    const { rows } = await db.query<{ plant_id: string }>('SELECT plant_id FROM building WHERE id = $1', [building_id]);
    if (!rows[0]) throw badRequest('Building does not exist');
    if (plant_id && plant_id !== rows[0].plant_id) throw badRequest('Building does not belong to the selected plant');
    plant_id = rows[0].plant_id;
  } else if (plant_id) {
    const { rows } = await db.query('SELECT 1 FROM plant WHERE id = $1', [plant_id]);
    if (!rows[0]) throw badRequest('Plant does not exist');
  }

  const rackU = rack ? (input.rack_u ?? null) : null;
  const rackHeight = rack ? (input.rack_height_u ?? 1) : 1;
  if (rack && rackU) await assertRackSlot(db, rack.id, rackU, rackHeight, { assetId });

  const placed = !!floor_id && input.map_x !== null && input.map_y !== null;
  return {
    plant_id: plant_id ?? null,
    building_id: building_id ?? null,
    floor_id: floor_id ?? null,
    map_x: placed ? input.map_x : null,
    map_y: placed ? input.map_y : null,
    rack_id: rack?.id ?? null,
    rack_u: rackU,
    rack_height_u: rackHeight,
  };
}

export const ASSET_WRITE_COLUMNS = [
  'type', 'name', 'status', 'criticality', 'plant_id', 'building_id', 'floor_id', 'room', 'rack_id', 'rack_u', 'rack_height_u', 'map_x', 'map_y',
  'manufacturer', 'model', 'serial_number', 'asset_tag', 'ip_address', 'mac_address', 'fqdn', 'os', 'owner', 'cost_center',
  'purchase_date', 'warranty_end', 'description', 'tags', 'attributes',
] as const;

export function assetValues(input: AssetInput, loc: ResolvedLocation): unknown[] {
  const merged: Record<string, unknown> = { ...input, ...loc, attributes: JSON.stringify(input.attributes) };
  return ASSET_WRITE_COLUMNS.map((c) => (c === 'tags' ? (merged.tags ?? []) : (merged[c] ?? null)));
}

export async function insertAsset(db: DbClient, input: AssetInput, loc: ResolvedLocation, userId: string) {
  const values = assetValues(input, loc);
  const cols = [...ASSET_WRITE_COLUMNS, 'created_by', 'updated_by'];
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const { rows } = await db.query(
    `INSERT INTO asset (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    [...values, userId, userId],
  );
  return rows[0];
}

export async function updateAsset(db: DbClient, id: string, input: AssetInput, loc: ResolvedLocation, userId: string) {
  const values = assetValues(input, loc);
  const sets = ASSET_WRITE_COLUMNS.map((c, i) => `${c} = $${i + 2}`);
  const { rows } = await db.query(
    `UPDATE asset SET ${sets.join(', ')}, updated_by = $${ASSET_WRITE_COLUMNS.length + 2}, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, ...values, userId],
  );
  return rows[0];
}

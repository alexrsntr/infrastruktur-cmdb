import { Router } from 'express';
import type { Pool } from 'pg';
import { formatRackUnits, type CurrentUser } from '../../shared/model';
import { requirePermission } from '../auth/context';
import { withTransaction, type DbClient } from '../db/pool';
import { audit, diff, snapshot } from '../lib/audit';
import { badRequest, notFound, parse, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { rackItemSchema, rackMountSchema, rackSchema } from '../lib/schemas';
import { applyScope, assertPlantAccess } from '../lib/scope';
import { assertRackSlot } from '../services/racks';
import { deleteAttachmentsFor, purgeBlobs } from '../services/attachments';
import { resolveAssetLocation } from '../services/assets';

export const RACK_SELECT = `
  r.id, r.building_id, b.name AS building_name, b.code AS building_code, b.plant_id, p.code AS plant_code, p.name AS plant_name,
  r.floor_id, f.name AS floor_name, r.name, r.room, r.height_u, r.numbering, r.manufacturer, r.model, r.description,
  r.created_at, r.updated_at,
  (SELECT COALESCE(sum(a.rack_height_u), 0) FROM asset a WHERE a.rack_id = r.id AND a.rack_u IS NOT NULL)
    + (SELECT COALESCE(sum(i.height_u), 0) FROM rack_item i WHERE i.rack_id = r.id) AS used_u,
  (SELECT count(*) FROM asset a WHERE a.rack_id = r.id) AS asset_count`;
export const RACK_FROM = `FROM rack r JOIN building b ON b.id = r.building_id JOIN plant p ON p.id = b.plant_id LEFT JOIN floor f ON f.id = r.floor_id`;

async function loadRack(db: DbClient, id: string) {
  const { rows } = await db.query(`SELECT ${RACK_SELECT} ${RACK_FROM} WHERE r.id = $1`, [id]);
  if (!rows[0]) throw notFound('Rack');
  return rows[0];
}

export async function loadRackDetail(db: DbClient, id: string) {
  const rack = await loadRack(db, id);
  const assets = await db.query(
    `SELECT id, name, type, status, criticality, rack_u, rack_height_u, manufacturer, model, ip_address, serial_number
     FROM asset WHERE rack_id = $1 ORDER BY rack_u DESC NULLS LAST, name`,
    [id],
  );
  const items = await db.query(
    'SELECT id, rack_id, kind, label, position_u, height_u, note FROM rack_item WHERE rack_id = $1 ORDER BY position_u DESC',
    [id],
  );
  return { ...rack, assets: assets.rows, items: items.rows };
}

async function checkFloor(db: DbClient, floorId: string | null, buildingId: string) {
  if (!floorId) return;
  const { rows } = await db.query('SELECT building_id FROM floor WHERE id = $1', [floorId]);
  if (!rows[0]) throw badRequest('Floor does not exist');
  if (rows[0].building_id !== buildingId) throw badRequest('Floor does not belong to the building');
}

async function rackForWrite(db: DbClient, rackId: string, user: CurrentUser) {
  const rack = await loadRack(db, rackId);
  assertPlantAccess(user, rack.plant_id);
  return rack;
}

export function racksRouter(pool: Pool): Router {
  const r = Router();

  // ------------------------------------------------------------------ racks
  r.get('/racks', async (req, res) => {
    const sql = new SqlBuilder();
    applyScope(sql, req.user!, 'b.plant_id');
    const buildingId = queryString(req.query.buildingId);
    const plantId = queryString(req.query.plantId);
    if (buildingId) sql.and(`r.building_id = ${sql.p(requireUuid(buildingId, 'buildingId'))}`);
    if (plantId) sql.and(`b.plant_id = ${sql.p(requireUuid(plantId, 'plantId'))}`);
    const { rows } = await pool.query(`SELECT ${RACK_SELECT} ${RACK_FROM} ${sql.whereSql()} ORDER BY p.code, b.code, lower(r.name)`, sql.params);
    if (queryString(req.query.include) === 'contents' && rows.length) {
      // Elevations of many racks at once (building "Racks" tab)
      const ids = rows.map((x) => x.id);
      const assets = await pool.query(
        `SELECT id, rack_id, name, type, status, criticality, rack_u, rack_height_u, manufacturer, model, ip_address, serial_number
         FROM asset WHERE rack_id = ANY($1::uuid[])`,
        [ids],
      );
      const items = await pool.query('SELECT id, rack_id, kind, label, position_u, height_u, note FROM rack_item WHERE rack_id = ANY($1::uuid[])', [ids]);
      for (const rack of rows) {
        rack.assets = assets.rows.filter((a) => a.rack_id === rack.id);
        rack.items = items.rows.filter((i) => i.rack_id === rack.id);
      }
    }
    res.json(rows);
  });

  r.get('/racks/:id', async (req, res) => {
    const id = requireUuid(req.params.id);
    const rack = await loadRackDetail(pool, id);
    assertPlantAccess(req.user!, rack.plant_id);
    res.json(rack);
  });

  r.post('/racks', requirePermission('location.write'), async (req, res) => {
    const input = parse(rackSchema, req.body);
    const b = await pool.query('SELECT plant_id, name FROM building WHERE id = $1', [input.building_id]);
    if (!b.rows[0]) throw notFound('Building');
    assertPlantAccess(req.user!, b.rows[0].plant_id);
    await checkFloor(pool, input.floor_id, input.building_id);
    const rack = await withTransaction(pool, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO rack (building_id, floor_id, name, room, height_u, numbering, manufacturer, model, description, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
        [input.building_id, input.floor_id, input.name, input.room, input.height_u, input.numbering, input.manufacturer, input.model, input.description, req.user!.id],
      );
      await audit(db, req, { action: 'create', entityType: 'rack', entityId: rows[0].id, entityLabel: `${b.rows[0].name} / ${input.name}`, plantId: b.rows[0].plant_id, changes: snapshot(rows[0]) });
      return loadRack(db, rows[0].id);
    });
    res.status(201).json(rack);
  });

  r.put('/racks/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(rackSchema, req.body);
    const rack = await withTransaction(pool, async (db) => {
      const before = await rackForWrite(db, id, req.user!);
      if (input.building_id !== before.building_id) throw badRequest('A rack cannot be moved to another building. Create a new rack instead.');
      await checkFloor(db, input.floor_id, input.building_id);
      const top = await db.query(
        `SELECT GREATEST(
           (SELECT max(rack_u + rack_height_u - 1) FROM asset WHERE rack_id = $1),
           (SELECT max(position_u + height_u - 1) FROM rack_item WHERE rack_id = $1)) AS top`,
        [id],
      );
      if (top.rows[0].top && top.rows[0].top > input.height_u)
        throw badRequest(`The rack content reaches up to U${top.rows[0].top}; the height cannot be reduced below that.`);
      const { rows } = await db.query(
        `UPDATE rack SET floor_id=$2, name=$3, room=$4, height_u=$5, numbering=$6, manufacturer=$7, model=$8, description=$9,
           updated_by=$10, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.floor_id, input.name, input.room, input.height_u, input.numbering, input.manufacturer, input.model, input.description, req.user!.id],
      );
      if (input.floor_id && input.floor_id !== before.floor_id) {
        // devices in the rack move with it
        await db.query(
          'UPDATE asset SET floor_id = $2, map_x = NULL, map_y = NULL, updated_at = now() WHERE rack_id = $1 AND floor_id IS DISTINCT FROM $2',
          [id, input.floor_id],
        );
      }
      const changes = diff(before, rows[0]);
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'update', entityType: 'rack', entityId: id, entityLabel: `${before.building_name} / ${input.name}`, plantId: before.plant_id, changes });
      return loadRack(db, id);
    });
    res.json(rack);
  });

  r.delete('/racks/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const keys: string[] = [];
    await withTransaction(pool, async (db) => {
      const rack = await rackForWrite(db, id, req.user!);
      keys.push(...(await deleteAttachmentsFor(db, 'rack', [id])));
      const unmounted = await db.query<{ id: string; name: string }>(
        'UPDATE asset SET rack_id = NULL, rack_u = NULL, rack_height_u = 1, updated_at = now() WHERE rack_id = $1 RETURNING id, name',
        [id],
      );
      for (const a of unmounted.rows)
        await audit(db, req, { action: 'update', entityType: 'asset', entityId: a.id, entityLabel: a.name, plantId: rack.plant_id, changes: { rack: { from: rack.name, to: null } } });
      await db.query(`DELETE FROM note WHERE entity_type = 'rack' AND entity_id = $1`, [id]);
      await db.query(`DELETE FROM activity WHERE entity_type = 'rack' AND entity_id = $1`, [id]);
      await db.query('DELETE FROM rack WHERE id = $1', [id]);
      await audit(db, req, {
        action: 'delete',
        entityType: 'rack',
        entityId: id,
        entityLabel: `${rack.building_name} / ${rack.name}`,
        plantId: rack.plant_id,
        changes: { name: rack.name, height_u: rack.height_u, unmounted: unmounted.rows.map((a) => a.name) },
      });
    });
    await purgeBlobs(pool, keys);
    res.status(204).end();
  });

  // ------------------------------------------------------------- rack items
  r.post('/racks/:id/items', requirePermission('location.write'), async (req, res) => {
    const rackId = requireUuid(req.params.id);
    const input = parse(rackItemSchema, req.body);
    const item = await withTransaction(pool, async (db) => {
      const rack = await rackForWrite(db, rackId, req.user!);
      await assertRackSlot(db, rackId, input.position_u, input.height_u);
      const { rows } = await db.query(
        `INSERT INTO rack_item (rack_id, kind, label, position_u, height_u, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [rackId, input.kind, input.label, input.position_u, input.height_u, input.note],
      );
      await audit(db, req, {
        action: 'rack.item.add',
        entityType: 'rack',
        entityId: rackId,
        entityLabel: `${rack.building_name} / ${rack.name}`,
        plantId: rack.plant_id,
        changes: { item: input.label, kind: input.kind, units: formatRackUnits(input.position_u, input.height_u) },
      });
      return rows[0];
    });
    res.status(201).json(item);
  });

  r.put('/rack-items/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(rackItemSchema, req.body);
    const item = await withTransaction(pool, async (db) => {
      const { rows: before } = await db.query('SELECT * FROM rack_item WHERE id = $1 FOR UPDATE', [id]);
      if (!before[0]) throw notFound('Rack item');
      const rack = await rackForWrite(db, before[0].rack_id, req.user!);
      await assertRackSlot(db, rack.id, input.position_u, input.height_u, { itemId: id });
      const { rows } = await db.query(
        `UPDATE rack_item SET kind=$2, label=$3, position_u=$4, height_u=$5, note=$6, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.kind, input.label, input.position_u, input.height_u, input.note],
      );
      const changes = diff(before[0], rows[0]);
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'rack.item.update', entityType: 'rack', entityId: rack.id, entityLabel: `${rack.building_name} / ${rack.name}`, plantId: rack.plant_id, changes: { item: input.label, ...changes } });
      return rows[0];
    });
    res.json(item);
  });

  r.delete('/rack-items/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const { rows } = await db.query('SELECT * FROM rack_item WHERE id = $1', [id]);
      if (!rows[0]) throw notFound('Rack item');
      const rack = await rackForWrite(db, rows[0].rack_id, req.user!);
      await db.query('DELETE FROM rack_item WHERE id = $1', [id]);
      await audit(db, req, {
        action: 'rack.item.remove',
        entityType: 'rack',
        entityId: rack.id,
        entityLabel: `${rack.building_name} / ${rack.name}`,
        plantId: rack.plant_id,
        changes: { item: rows[0].label, units: formatRackUnits(rows[0].position_u, rows[0].height_u) },
      });
    });
    res.status(204).end();
  });

  // ------------------------------------------------- mount / move / unmount
  r.patch('/assets/:id/rack', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(rackMountSchema, req.body);
    const row = await withTransaction(pool, async (db) => {
      const { rows } = await db.query('SELECT * FROM asset WHERE id = $1 FOR UPDATE', [id]);
      const before = rows[0];
      if (!before) throw notFound('Asset');
      assertPlantAccess(req.user!, before.plant_id);

      let target: { building_id: string; floor_id: string | null } | null = null;
      if (input.rack_id) {
        const t = await db.query('SELECT building_id, floor_id FROM rack WHERE id = $1', [input.rack_id]);
        if (!t.rows[0]) throw badRequest('Rack does not exist');
        target = t.rows[0];
      }
      // Mounting moves the device into the rack's building (and floor); the plan position is kept only on the same floor
      const sameBuilding = !target || target.building_id === before.building_id;
      const floorId = target ? (target.floor_id ?? (sameBuilding ? before.floor_id : null)) : before.floor_id;
      const keepPosition = floorId === before.floor_id;
      const loc = await resolveAssetLocation(
        db,
        {
          type: before.type,
          plant_id: target && !sameBuilding ? null : before.plant_id,
          building_id: target ? target.building_id : before.building_id,
          floor_id: floorId,
          map_x: keepPosition ? before.map_x : null,
          map_y: keepPosition ? before.map_y : null,
          rack_id: input.rack_id,
          rack_u: input.rack_u,
          rack_height_u: input.rack_height_u,
        },
        id,
      );
      assertPlantAccess(req.user!, loc.plant_id);
      const { rows: updated } = await db.query(
        `UPDATE asset SET plant_id=$2, building_id=$3, floor_id=$4, map_x=$5, map_y=$6, rack_id=$7, rack_u=$8, rack_height_u=$9,
           updated_by=$10, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, loc.plant_id, loc.building_id, loc.floor_id, loc.map_x, loc.map_y, loc.rack_id, loc.rack_u, loc.rack_height_u, req.user!.id],
      );
      const changes = diff(before, updated[0]);
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'update', entityType: 'asset', entityId: id, entityLabel: before.name, plantId: updated[0].plant_id, changes });
      return updated[0];
    });
    res.json(row);
  });

  return r;
}

import { Router } from 'express';
import type { Pool } from 'pg';
import { requirePermission } from '../auth/context';
import { withTransaction } from '../db/pool';
import { audit, diff, snapshot } from '../lib/audit';
import { badRequest, clampInt, notFound, parse, requireUuid, SqlBuilder } from '../lib/http';
import { assetSchema, assetStatusSchema, positionSchema, relationSchema } from '../lib/schemas';
import { applyScope, assertPlantAccess } from '../lib/scope';
import {
  ASSET_FROM,
  ASSET_SELECT,
  buildAssetQuery,
  insertAsset,
  parseAssetFilters,
  resolveAssetLocation,
  updateAsset,
} from '../services/assets';
import { deleteAttachmentsFor, purgeBlobs } from '../services/attachments';
import { cleanAttributes, loadAssetTypeSettings } from '../services/assetTypes';

export function assetsRouter(pool: Pool): Router {
  const r = Router();

  r.get('/assets', async (req, res) => {
    const filters = parseAssetFilters(req.query);
    const { sql, orderBy } = buildAssetQuery(req.user!, filters);
    const pageSize = clampInt(req.query.pageSize, 50, 1, 1000);
    const page = clampInt(req.query.page, 1, 1, 100000);
    const [items, total] = await Promise.all([
      pool.query(
        `SELECT ${ASSET_SELECT} ${ASSET_FROM} ${sql.whereSql()} ${orderBy} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        sql.params,
      ),
      pool.query(`SELECT count(*) AS n FROM asset a LEFT JOIN plant p ON p.id = a.plant_id ${sql.whereSql()}`, sql.params),
    ]);
    res.json({ items: items.rows, total: total.rows[0].n });
  });

  /** Lightweight list for pickers (relations, placement) */
  r.get('/assets/options', async (req, res) => {
    const filters = parseAssetFilters(req.query);
    const { sql, orderBy } = buildAssetQuery(req.user!, filters);
    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.type, a.status, a.building_id, a.floor_id, a.map_x, a.map_y, a.ip_address, p.code AS plant_code,
              a.rack_id, rk.name AS rack_name, a.rack_u, a.rack_height_u, b.name AS building_name
       FROM asset a LEFT JOIN plant p ON p.id = a.plant_id LEFT JOIN building b ON b.id = a.building_id
       LEFT JOIN rack rk ON rk.id = a.rack_id ${sql.whereSql()} ${orderBy} LIMIT 200`,
      sql.params,
    );
    res.json(rows);
  });

  r.get('/assets/:id', async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query(`SELECT ${ASSET_SELECT} ${ASSET_FROM} WHERE a.id = $1`, [id]);
    if (!rows[0]) throw notFound('Asset');
    assertPlantAccess(req.user!, rows[0].plant_id);

    const scope = new SqlBuilder();
    scope.p(id);
    applyScope(scope, req.user!, 'a.plant_id');
    const scopeSql = scope.where.length ? `AND ${scope.where.join(' AND ')}` : '';
    const relations = await pool.query(
      `SELECT r.id, r.relation, 'out' AS direction, a.id AS other_id, a.name AS other_name, a.type AS other_type,
              a.status AS other_status, r.source_port AS local_port, r.target_port AS remote_port, r.note
         FROM asset_relation r JOIN asset a ON a.id = r.target_id WHERE r.source_id = $1 ${scopeSql}
       UNION ALL
       SELECT r.id, r.relation, 'in' AS direction, a.id, a.name, a.type, a.status, r.target_port, r.source_port, r.note
         FROM asset_relation r JOIN asset a ON a.id = r.source_id WHERE r.target_id = $1 ${scopeSql}
       ORDER BY relation, other_name`,
      scope.params,
    );
    res.json({ ...rows[0], relations: relations.rows });
  });

  r.post('/assets', requirePermission('asset.write'), async (req, res) => {
    const input = parse(assetSchema, req.body);
    const row = await withTransaction(pool, async (db) => {
      input.attributes = cleanAttributes(input.type, input.attributes, await loadAssetTypeSettings(db));
      const loc = await resolveAssetLocation(db, input);
      assertPlantAccess(req.user!, loc.plant_id);
      const created = await insertAsset(db, input, loc, req.user!.id);
      await audit(db, req, { action: 'create', entityType: 'asset', entityId: created.id, entityLabel: created.name, plantId: created.plant_id, changes: snapshot(created) });
      return created;
    });
    res.status(201).json(row);
  });

  r.put('/assets/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(assetSchema, req.body);
    const row = await withTransaction(pool, async (db) => {
      input.attributes = cleanAttributes(input.type, input.attributes, await loadAssetTypeSettings(db));
      const before = await db.query('SELECT * FROM asset WHERE id = $1 FOR UPDATE', [id]);
      if (!before.rows[0]) throw notFound('Asset');
      assertPlantAccess(req.user!, before.rows[0].plant_id);
      if (before.rows[0].type !== input.type) {
        const rel = await db.query('SELECT count(*) AS n FROM asset_relation WHERE source_id = $1 OR target_id = $1', [id]);
        if (rel.rows[0].n > 0) throw badRequest('The asset type cannot be changed while relations exist');
      }
      const loc = await resolveAssetLocation(db, input, id);
      assertPlantAccess(req.user!, loc.plant_id);
      const updated = await updateAsset(db, id, input, loc, req.user!.id);
      const changes = diff(before.rows[0], updated);
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'update', entityType: 'asset', entityId: id, entityLabel: updated.name, plantId: updated.plant_id, changes });
      return updated;
    });
    res.json(row);
  });

  r.patch('/assets/:id/status', requirePermission('asset.status'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const { status } = parse(assetStatusSchema, req.body);
    const row = await withTransaction(pool, async (db) => {
      const before = await db.query('SELECT id, name, status, plant_id FROM asset WHERE id = $1 FOR UPDATE', [id]);
      if (!before.rows[0]) throw notFound('Asset');
      assertPlantAccess(req.user!, before.rows[0].plant_id);
      const { rows } = await db.query('UPDATE asset SET status = $2, updated_by = $3, updated_at = now() WHERE id = $1 RETURNING *', [id, status, req.user!.id]);
      if (before.rows[0].status !== status)
        await audit(db, req, { action: 'update', entityType: 'asset', entityId: id, entityLabel: rows[0].name, plantId: rows[0].plant_id, changes: { status: { from: before.rows[0].status, to: status } } });
      return rows[0];
    });
    res.json(row);
  });

  r.patch('/assets/:id/position', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(positionSchema, req.body);
    const row = await withTransaction(pool, async (db) => {
      const before = await db.query('SELECT * FROM asset WHERE id = $1 FOR UPDATE', [id]);
      if (!before.rows[0]) throw notFound('Asset');
      assertPlantAccess(req.user!, before.rows[0].plant_id);
      const b = before.rows[0];
      const loc = await resolveAssetLocation(
        db,
        {
          type: b.type,
          plant_id: input.floor_id ? null : b.plant_id,
          building_id: input.floor_id ? null : b.building_id,
          floor_id: input.floor_id,
          map_x: input.map_x,
          map_y: input.map_y,
          rack_id: b.rack_id,
          rack_u: b.rack_u,
          rack_height_u: b.rack_height_u,
        },
        id,
      );
      assertPlantAccess(req.user!, loc.plant_id);
      const { rows } = await db.query(
        `UPDATE asset SET plant_id=$2, building_id=$3, floor_id=$4, map_x=$5, map_y=$6, updated_by=$7, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, loc.plant_id, loc.building_id, loc.floor_id, loc.map_x, loc.map_y, req.user!.id],
      );
      const changes = diff(before.rows[0], rows[0]);
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'update', entityType: 'asset', entityId: id, entityLabel: rows[0].name, plantId: rows[0].plant_id, changes });
      return rows[0];
    });
    res.json(row);
  });

  r.delete('/assets/:id', requirePermission('asset.delete'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const keys: string[] = [];
    await withTransaction(pool, async (db) => {
      const { rows } = await db.query('SELECT * FROM asset WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw notFound('Asset');
      assertPlantAccess(req.user!, rows[0].plant_id);
      keys.push(...(await deleteAttachmentsFor(db, 'asset', [id])));
      await db.query(`DELETE FROM note WHERE entity_type = 'asset' AND entity_id = $1`, [id]);
      await db.query(`DELETE FROM activity WHERE entity_type = 'asset' AND entity_id = $1`, [id]);
      await db.query('DELETE FROM asset WHERE id = $1', [id]);
      await audit(db, req, { action: 'delete', entityType: 'asset', entityId: id, entityLabel: rows[0].name, plantId: rows[0].plant_id, changes: snapshot(rows[0]) });
    });
    await purgeBlobs(pool, keys);
    res.status(204).end();
  });

  // ------------------------------------------------------------- relations
  r.post('/relations', requirePermission('asset.write'), async (req, res) => {
    const input = parse(relationSchema, req.body);
    if (input.source_id === input.target_id) throw badRequest('An asset cannot be related to itself');
    const row = await withTransaction(pool, async (db) => {
      const { rows: ends } = await db.query<{ id: string; name: string; plant_id: string | null }>(
        'SELECT id, name, plant_id FROM asset WHERE id = ANY($1::uuid[])',
        [[input.source_id, input.target_id]],
      );
      const source = ends.find((a) => a.id === input.source_id);
      const target = ends.find((a) => a.id === input.target_id);
      if (!source || !target) throw notFound('Asset');
      assertPlantAccess(req.user!, source.plant_id);
      assertPlantAccess(req.user!, target.plant_id);
      const { rows } = await db.query(
        `INSERT INTO asset_relation (source_id, target_id, relation, source_port, target_port, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [input.source_id, input.target_id, input.relation, input.source_port, input.target_port, input.note, req.user!.id],
      );
      const changes = { relation: input.relation, target: target.name, source_port: input.source_port, target_port: input.target_port };
      await audit(db, req, { action: 'relation.add', entityType: 'asset', entityId: source.id, entityLabel: source.name, plantId: source.plant_id, changes });
      await audit(db, req, { action: 'relation.add', entityType: 'asset', entityId: target.id, entityLabel: target.name, plantId: target.plant_id, changes: { ...changes, target: undefined, source: source.name } });
      return rows[0];
    });
    res.status(201).json(row);
  });

  r.delete('/relations/:id', requirePermission('asset.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const { rows } = await db.query(
        `SELECT r.*, s.name AS source_name, s.plant_id AS source_plant, t.name AS target_name, t.plant_id AS target_plant
         FROM asset_relation r JOIN asset s ON s.id = r.source_id JOIN asset t ON t.id = r.target_id WHERE r.id = $1`,
        [id],
      );
      const rel = rows[0];
      if (!rel) throw notFound('Relation');
      assertPlantAccess(req.user!, rel.source_plant);
      assertPlantAccess(req.user!, rel.target_plant);
      await db.query('DELETE FROM asset_relation WHERE id = $1', [id]);
      await audit(db, req, { action: 'relation.remove', entityType: 'asset', entityId: rel.source_id, entityLabel: rel.source_name, plantId: rel.source_plant, changes: { relation: rel.relation, target: rel.target_name } });
      await audit(db, req, { action: 'relation.remove', entityType: 'asset', entityId: rel.target_id, entityLabel: rel.target_name, plantId: rel.target_plant, changes: { relation: rel.relation, source: rel.source_name } });
    });
    res.status(204).end();
  });

  return r;
}

import { Router } from 'express';
import multer from 'multer';
import type { Pool } from 'pg';
import { assertCan, requirePermission } from '../auth/context';
import { withTransaction, type DbClient } from '../db/pool';
import { audit, diff, snapshot } from '../lib/audit';
import { badRequest, forbidden, notFound, parse, requireUuid, SqlBuilder } from '../lib/http';
import { buildingSchema, floorSchema, plantSchema } from '../lib/schemas';
import { applyScope, assertPlantAccess, isUnscoped } from '../lib/scope';
import { readImageSize } from '../lib/image';
import { deleteAttachmentsFor, deleteAttachmentsForPlant, purgeBlobs } from '../services/attachments';
import type { EntityType } from '../../shared/model';

const PLANT_COLUMNS = `p.id, p.code, p.name, p.country, p.city, p.address, p.latitude, p.longitude, p.timezone, p.contact,
  p.description, p.created_at, p.updated_at`;
const BUILDING_COLUMNS = `b.id, b.plant_id, b.code, b.name, b.description, b.latitude, b.longitude, b.created_at, b.updated_at`;
const FLOOR_COLUMNS = `f.id, f.building_id, f.name, f.level, (f.plan_image IS NOT NULL) AS has_plan, f.plan_width, f.plan_height,
  f.plan_updated_at`;

/** Deletes notes, activities and file attachments of the objects; returns storage keys to purge after commit. */
async function deleteAttachments(db: DbClient, entityType: EntityType, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  await db.query('DELETE FROM note WHERE entity_type = $1 AND entity_id = ANY($2::uuid[])', [entityType, ids]);
  await db.query('DELETE FROM activity WHERE entity_type = $1 AND entity_id = ANY($2::uuid[])', [entityType, ids]);
  return deleteAttachmentsFor(db, entityType, ids);
}

export function locationsRouter(pool: Pool): Router {
  const r = Router();

  // ---------------------------------------------------------------- plants
  r.get('/plants', async (req, res) => {
    const sql = new SqlBuilder();
    applyScope(sql, req.user!, 'p.id');
    const { rows } = await pool.query(
      `SELECT ${PLANT_COLUMNS},
         (SELECT count(*) FROM building b WHERE b.plant_id = p.id) AS building_count,
         (SELECT count(*) FROM asset a WHERE a.plant_id = p.id) AS asset_count,
         (SELECT COALESCE(jsonb_object_agg(t.type, t.n), '{}'::jsonb)
            FROM (SELECT a.type, count(*) AS n FROM asset a WHERE a.plant_id = p.id GROUP BY a.type) t) AS asset_counts
       FROM plant p ${sql.whereSql()} ORDER BY p.name`,
      sql.params,
    );
    res.json(rows);
  });

  r.get('/plants/:id', async (req, res) => {
    const id = requireUuid(req.params.id);
    assertPlantAccess(req.user!, id);
    const { rows } = await pool.query(
      `SELECT ${PLANT_COLUMNS},
         (SELECT count(*) FROM asset a WHERE a.plant_id = p.id) AS asset_count,
         (SELECT COALESCE(jsonb_object_agg(t.type, t.n), '{}'::jsonb)
            FROM (SELECT a.type, count(*) AS n FROM asset a WHERE a.plant_id = p.id GROUP BY a.type) t) AS asset_counts
       FROM plant p WHERE p.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('Plant');
    const buildings = await pool.query(
      `SELECT ${BUILDING_COLUMNS},
         (SELECT count(*) FROM floor f WHERE f.building_id = b.id) AS floor_count,
         (SELECT count(*) FROM asset a WHERE a.building_id = b.id) AS asset_count
       FROM building b WHERE b.plant_id = $1 ORDER BY b.code`,
      [id],
    );
    res.json({ ...rows[0], buildings: buildings.rows });
  });

  r.post('/plants', requirePermission('location.write'), async (req, res) => {
    if (!isUnscoped(req.user!)) throw forbidden('Only users without plant restriction can create plants');
    const input = parse(plantSchema, req.body);
    const row = await withTransaction(pool, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO plant (code, name, country, city, address, latitude, longitude, timezone, contact, description, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
        [input.code, input.name, input.country, input.city, input.address, input.latitude, input.longitude, input.timezone,
          input.contact, input.description, req.user!.id],
      );
      await audit(db, req, { action: 'create', entityType: 'plant', entityId: rows[0].id, entityLabel: `${input.code} – ${input.name}`, plantId: rows[0].id, changes: snapshot(rows[0]) });
      return rows[0];
    });
    res.status(201).json(row);
  });

  r.put('/plants/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    assertPlantAccess(req.user!, id);
    const input = parse(plantSchema, req.body);
    const row = await withTransaction(pool, async (db) => {
      const before = await db.query('SELECT * FROM plant WHERE id = $1 FOR UPDATE', [id]);
      if (!before.rows[0]) throw notFound('Plant');
      const { rows } = await db.query(
        `UPDATE plant SET code=$2, name=$3, country=$4, city=$5, address=$6, latitude=$7, longitude=$8, timezone=$9, contact=$10,
           description=$11, updated_by=$12, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.code, input.name, input.country, input.city, input.address, input.latitude, input.longitude, input.timezone,
          input.contact, input.description, req.user!.id],
      );
      const changes = diff(before.rows[0], rows[0]);
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'update', entityType: 'plant', entityId: id, entityLabel: `${input.code} – ${input.name}`, plantId: id, changes });
      return rows[0];
    });
    res.json(row);
  });

  r.delete('/plants/:id', requirePermission('location.delete'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const keys: string[] = [];
    await withTransaction(pool, async (db) => {
      const { rows } = await db.query('SELECT * FROM plant WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw notFound('Plant');
      const assets = await db.query('SELECT count(*) AS n FROM asset WHERE plant_id = $1', [id]);
      if (assets.rows[0].n > 0)
        throw badRequest(`The plant still has ${assets.rows[0].n} assets. Move or delete them before deleting the plant.`);
      const buildings = await db.query<{ id: string }>('SELECT id FROM building WHERE plant_id = $1', [id]);
      const floors = await db.query<{ id: string }>('SELECT f.id FROM floor f JOIN building b ON b.id = f.building_id WHERE b.plant_id = $1', [id]);
      const racks = await db.query<{ id: string }>('SELECT r.id FROM rack r JOIN building b ON b.id = r.building_id WHERE b.plant_id = $1', [id]);
      keys.push(...(await deleteAttachments(db, 'rack', racks.rows.map((x) => x.id))));
      keys.push(...(await deleteAttachments(db, 'floor', floors.rows.map((x) => x.id))));
      keys.push(...(await deleteAttachments(db, 'building', buildings.rows.map((x) => x.id))));
      keys.push(...(await deleteAttachments(db, 'plant', [id])));
      keys.push(...(await deleteAttachmentsForPlant(db, id)));
      await db.query('DELETE FROM plant WHERE id = $1', [id]);
      await audit(db, req, { action: 'delete', entityType: 'plant', entityId: id, entityLabel: `${rows[0].code} – ${rows[0].name}`, changes: snapshot(rows[0]) });
    });
    await purgeBlobs(pool, keys);
    res.status(204).end();
  });

  // ------------------------------------------------------------- buildings
  r.get('/buildings', async (req, res) => {
    const sql = new SqlBuilder();
    applyScope(sql, req.user!, 'b.plant_id');
    if (typeof req.query.plantId === 'string') sql.and(`b.plant_id = ${sql.p(requireUuid(req.query.plantId, 'plantId'))}`);
    const { rows } = await pool.query(
      `SELECT ${BUILDING_COLUMNS}, p.name AS plant_name, p.code AS plant_code,
         (SELECT count(*) FROM floor f WHERE f.building_id = b.id) AS floor_count,
         (SELECT count(*) FROM asset a WHERE a.building_id = b.id) AS asset_count
       FROM building b JOIN plant p ON p.id = b.plant_id ${sql.whereSql()} ORDER BY p.name, b.code`,
      sql.params,
    );
    res.json(rows);
  });

  r.get('/buildings/:id', async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query(
      `SELECT ${BUILDING_COLUMNS}, p.name AS plant_name, p.code AS plant_code,
         (SELECT count(*) FROM asset a WHERE a.building_id = b.id) AS asset_count
       FROM building b JOIN plant p ON p.id = b.plant_id WHERE b.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('Building');
    assertPlantAccess(req.user!, rows[0].plant_id);
    const floors = await pool.query(
      `SELECT ${FLOOR_COLUMNS}, (SELECT count(*) FROM asset a WHERE a.floor_id = f.id) AS asset_count
       FROM floor f WHERE f.building_id = $1 ORDER BY f.level, f.name`,
      [id],
    );
    res.json({ ...rows[0], floors: floors.rows });
  });

  r.post('/buildings', requirePermission('location.write'), async (req, res) => {
    const input = parse(buildingSchema, req.body);
    assertPlantAccess(req.user!, input.plant_id);
    const row = await withTransaction(pool, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO building (plant_id, code, name, description, latitude, longitude, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
        [input.plant_id, input.code, input.name, input.description, input.latitude, input.longitude, req.user!.id],
      );
      await audit(db, req, { action: 'create', entityType: 'building', entityId: rows[0].id, entityLabel: input.name, plantId: input.plant_id, changes: snapshot(rows[0]) });
      return rows[0];
    });
    res.status(201).json(row);
  });

  r.put('/buildings/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(buildingSchema, req.body);
    const row = await withTransaction(pool, async (db) => {
      const before = await db.query('SELECT * FROM building WHERE id = $1 FOR UPDATE', [id]);
      if (!before.rows[0]) throw notFound('Building');
      assertPlantAccess(req.user!, before.rows[0].plant_id);
      assertPlantAccess(req.user!, input.plant_id);
      const { rows } = await db.query(
        `UPDATE building SET plant_id=$2, code=$3, name=$4, description=$5, latitude=$6, longitude=$7, updated_by=$8, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, input.plant_id, input.code, input.name, input.description, input.latitude, input.longitude, req.user!.id],
      );
      if (before.rows[0].plant_id !== input.plant_id) {
        // Keep denormalised plant references of contained assets/notes/activities consistent
        await db.query('UPDATE asset SET plant_id = $2, updated_at = now() WHERE building_id = $1', [id, input.plant_id]);
      }
      const changes = diff(before.rows[0], rows[0]);
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'update', entityType: 'building', entityId: id, entityLabel: input.name, plantId: input.plant_id, changes });
      return rows[0];
    });
    res.json(row);
  });

  r.delete('/buildings/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const keys: string[] = [];
    await withTransaction(pool, async (db) => {
      const { rows } = await db.query('SELECT * FROM building WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw notFound('Building');
      assertPlantAccess(req.user!, rows[0].plant_id);
      const floors = await db.query<{ id: string }>('SELECT id FROM floor WHERE building_id = $1', [id]);
      const racks = await db.query<{ id: string }>('SELECT id FROM rack WHERE building_id = $1', [id]);
      keys.push(...(await deleteAttachments(db, 'rack', racks.rows.map((x) => x.id))));
      keys.push(...(await deleteAttachments(db, 'floor', floors.rows.map((x) => x.id))));
      keys.push(...(await deleteAttachments(db, 'building', [id])));
      // Assets stay in the plant but lose their building/floor/rack/position
      await db.query(
        'UPDATE asset SET building_id = NULL, floor_id = NULL, rack_id = NULL, rack_u = NULL, rack_height_u = 1, map_x = NULL, map_y = NULL, updated_at = now() WHERE building_id = $1',
        [id],
      );
      await db.query('DELETE FROM building WHERE id = $1', [id]);
      await audit(db, req, { action: 'delete', entityType: 'building', entityId: id, entityLabel: rows[0].name, plantId: rows[0].plant_id, changes: snapshot(rows[0]) });
    });
    await purgeBlobs(pool, keys);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- floors
  async function loadFloorPlant(db: { query: Pool['query'] }, floorId: string) {
    const { rows } = await db.query<{ id: string; name: string; building_id: string; plant_id: string; building_name: string }>(
      `SELECT f.id, f.name, f.building_id, b.plant_id, b.name AS building_name FROM floor f JOIN building b ON b.id = f.building_id WHERE f.id = $1`,
      [floorId],
    );
    if (!rows[0]) throw notFound('Floor');
    return rows[0];
  }

  r.post('/floors', requirePermission('location.write'), async (req, res) => {
    const input = parse(floorSchema, req.body);
    const b = await pool.query('SELECT plant_id, name FROM building WHERE id = $1', [input.building_id]);
    if (!b.rows[0]) throw notFound('Building');
    assertPlantAccess(req.user!, b.rows[0].plant_id);
    const row = await withTransaction(pool, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO floor (building_id, name, level) VALUES ($1,$2,$3)
         RETURNING id, building_id, name, level, false AS has_plan, plan_width, plan_height, plan_updated_at`,
        [input.building_id, input.name, input.level],
      );
      await audit(db, req, { action: 'create', entityType: 'floor', entityId: rows[0].id, entityLabel: `${b.rows[0].name} / ${input.name}`, plantId: b.rows[0].plant_id, changes: { name: input.name, level: input.level } });
      return rows[0];
    });
    res.status(201).json(row);
  });

  r.put('/floors/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const floor = await loadFloorPlant(pool, id);
    assertPlantAccess(req.user!, floor.plant_id);
    const input = parse(floorSchema.omit({ building_id: true }), req.body);
    const row = await withTransaction(pool, async (db) => {
      const before = await db.query('SELECT name, level FROM floor WHERE id = $1', [id]);
      const { rows } = await db.query(
        `UPDATE floor SET name=$2, level=$3, updated_at=now() WHERE id=$1
         RETURNING id, building_id, name, level, (plan_image IS NOT NULL) AS has_plan, plan_width, plan_height, plan_updated_at`,
        [id, input.name, input.level],
      );
      const changes = diff(before.rows[0], { name: input.name, level: input.level });
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'update', entityType: 'floor', entityId: id, entityLabel: `${floor.building_name} / ${input.name}`, plantId: floor.plant_id, changes });
      return rows[0];
    });
    res.json(row);
  });

  r.delete('/floors/:id', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const floor = await loadFloorPlant(pool, id);
    assertPlantAccess(req.user!, floor.plant_id);
    const keys: string[] = [];
    await withTransaction(pool, async (db) => {
      keys.push(...(await deleteAttachments(db, 'floor', [id])));
      await db.query('UPDATE asset SET floor_id = NULL, map_x = NULL, map_y = NULL, updated_at = now() WHERE floor_id = $1', [id]);
      await db.query('DELETE FROM floor WHERE id = $1', [id]);
      await audit(db, req, { action: 'delete', entityType: 'floor', entityId: id, entityLabel: `${floor.building_name} / ${floor.name}`, plantId: floor.plant_id });
    });
    await purgeBlobs(pool, keys);
    res.status(204).end();
  });

  // ----------------------------------------------------------- floor plans
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

  r.get('/floors/:id/plan', async (req, res) => {
    const id = requireUuid(req.params.id);
    const floor = await loadFloorPlant(pool, id);
    assertPlantAccess(req.user!, floor.plant_id);
    const { rows } = await pool.query('SELECT plan_image, plan_mime, plan_updated_at FROM floor WHERE id = $1', [id]);
    if (!rows[0]?.plan_image) throw notFound('Floor plan');
    res.setHeader('Content-Type', rows[0].plan_mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(rows[0].plan_image);
  });

  r.put('/floors/:id/plan', requirePermission('location.write'), upload.single('file'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const floor = await loadFloorPlant(pool, id);
    assertPlantAccess(req.user!, floor.plant_id);
    if (!req.file) throw badRequest('No file uploaded (field "file")');
    const info = readImageSize(req.file.buffer);
    if (!info) throw badRequest('Unsupported image. Please upload a PNG, JPEG or WebP file.');
    const { rows } = await pool.query(
      `UPDATE floor SET plan_image=$2, plan_mime=$3, plan_width=$4, plan_height=$5, plan_updated_at=now(), updated_at=now() WHERE id=$1
       RETURNING id, building_id, name, level, true AS has_plan, plan_width, plan_height, plan_updated_at`,
      [id, req.file.buffer, info.mime, info.width, info.height],
    );
    await audit(pool, req, { action: 'update', entityType: 'floor', entityId: id, entityLabel: `${floor.building_name} / ${floor.name}`, plantId: floor.plant_id, changes: { floor_plan: { from: null, to: `${req.file.originalname} (${info.width}×${info.height})` } } });
    res.json(rows[0]);
  });

  r.delete('/floors/:id/plan', requirePermission('location.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const floor = await loadFloorPlant(pool, id);
    assertPlantAccess(req.user!, floor.plant_id);
    assertCan(req.user, 'location.write');
    await pool.query(
      `UPDATE floor SET plan_image=NULL, plan_mime=NULL, plan_width=NULL, plan_height=NULL, plan_updated_at=now(), updated_at=now() WHERE id=$1`,
      [id],
    );
    await audit(pool, req, { action: 'update', entityType: 'floor', entityId: id, entityLabel: `${floor.building_name} / ${floor.name}`, plantId: floor.plant_id, changes: { floor_plan: { from: 'image', to: null } } });
    res.status(204).end();
  });

  return r;
}

import { Router, type Request } from 'express';
import archiver from 'archiver';
import type { Pool } from 'pg';
import { ASSET_TYPE_KEYS, ASSET_TYPES, RACK_ITEM_KIND_META, can, formatRackUnits, type AssetType, type CurrentUser } from '../../shared/model';
import { requirePermission } from '../auth/context';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { applyScope, assertPlantAccess, resolveEntityWithAccess } from '../lib/scope';
import { ASSET_FROM, ASSET_SELECT, buildAssetQuery, parseAssetFilters } from '../services/assets';
import {
  ACTIVITY_COLUMNS,
  AUDIT_COLUMNS,
  BUILDING_COLUMNS,
  FLOOR_COLUMNS,
  NOTE_COLUMNS,
  PLANT_COLUMNS,
  RACK_COLUMNS,
  RACK_CONTENT_COLUMNS,
  RELATION_COLUMNS,
  USER_COLUMNS,
  assetColumns,
  exportFilename,
  sendExport,
  type Column,
  type ExportFormat,
  type Sheet,
} from '../services/tabular';
import { ACTIVITY_FROM, ACTIVITY_ORDER, ACTIVITY_SELECT, buildActivityQuery, NOTE_FROM, NOTE_SELECT } from './journal';
import { AUDIT_SELECT, buildAuditQuery } from './admin';
import { RACK_FROM, RACK_SELECT, loadRackDetail } from './racks';
import { loadDatacenterExportRows } from './datacenters';
import { DATACENTER_KIND_META, DC_SITE_ROLE_META, type DatacenterKind, type DcSiteRole } from '../../shared/datacenters';
import { ATTACHMENT_CATEGORY_META, formatBytes, type AttachmentCategory } from '../../shared/attachments';
import { ENTITY_TYPES, type EntityType } from '../../shared/model';
import { ATTACHMENT_FROM, ATTACHMENT_PLANT_SQL, ATTACHMENT_SELECT, attachmentContext } from '../services/attachments';
import { log } from '../lib/log';

/** One row per data center site */
const DATACENTER_COLUMNS: Column[] = [
  { key: 'datacenter', header: 'Data center', width: 22 },
  { key: 'kind', header: 'Type', width: 12, get: (r) => DATACENTER_KIND_META[r.kind as DatacenterKind]?.label ?? r.kind },
  { key: 'plant_code', header: 'Plant', width: 9 },
  { key: 'plant_name', header: 'Plant name', width: 22 },
  { key: 'site', header: 'Site', width: 12 },
  { key: 'role', header: 'Role', width: 11, get: (r) => DC_SITE_ROLE_META[r.role as DcSiteRole]?.label ?? r.role },
  { key: 'building_code', header: 'Building', width: 10 },
  { key: 'building_name', header: 'Building name', width: 20 },
  { key: 'room', header: 'Room', width: 16 },
  { key: 'rack_count', header: 'Racks', width: 8 },
  { key: 'device_count', header: 'Devices', width: 9 },
  { key: 'link_count', header: 'Site links', width: 10 },
];

function formatOf(req: Request, allowed: ExportFormat[] = ['csv', 'xlsx', 'json']): ExportFormat {
  const f = (queryString(req.query.format) ?? 'xlsx').toLowerCase() as ExportFormat;
  if (!allowed.includes(f)) throw badRequest(`format must be one of ${allowed.join(', ')}`);
  return f;
}

function delimiterOf(req: Request): string {
  const sep = queryString(req.query.sep);
  if (sep === 'comma' || sep === ',') return ',';
  if (sep === 'tab') return '\t';
  return ';';
}

// --------------------------------------------------------------- loaders

async function loadPlants(pool: Pool, user: CurrentUser, plantId?: string) {
  const sql = new SqlBuilder();
  applyScope(sql, user, 'p.id');
  if (plantId) sql.and(`p.id = ${sql.p(plantId)}`);
  const { rows } = await pool.query(
    `SELECT p.*, (SELECT count(*) FROM building b WHERE b.plant_id = p.id) AS building_count,
            (SELECT count(*) FROM asset a WHERE a.plant_id = p.id) AS asset_count
     FROM plant p ${sql.whereSql()} ORDER BY p.name`,
    sql.params,
  );
  return rows;
}

async function loadBuildings(pool: Pool, user: CurrentUser, plantId?: string) {
  const sql = new SqlBuilder();
  applyScope(sql, user, 'b.plant_id');
  if (plantId) sql.and(`b.plant_id = ${sql.p(plantId)}`);
  const { rows } = await pool.query(
    `SELECT b.*, p.code AS plant_code, p.name AS plant_name,
            (SELECT count(*) FROM floor f WHERE f.building_id = b.id) AS floor_count,
            (SELECT count(*) FROM asset a WHERE a.building_id = b.id) AS asset_count
     FROM building b JOIN plant p ON p.id = b.plant_id ${sql.whereSql()} ORDER BY p.name, b.code`,
    sql.params,
  );
  return rows;
}

async function loadFloors(pool: Pool, user: CurrentUser, plantId?: string, buildingId?: string) {
  const sql = new SqlBuilder();
  applyScope(sql, user, 'b.plant_id');
  if (plantId) sql.and(`b.plant_id = ${sql.p(plantId)}`);
  if (buildingId) sql.and(`b.id = ${sql.p(buildingId)}`);
  const { rows } = await pool.query(
    `SELECT f.id, f.name, f.level, (f.plan_image IS NOT NULL) AS has_plan, b.name AS building_name, p.code AS plant_code,
            (SELECT count(*) FROM asset a WHERE a.floor_id = f.id) AS asset_count
     FROM floor f JOIN building b ON b.id = f.building_id JOIN plant p ON p.id = b.plant_id ${sql.whereSql()}
     ORDER BY p.code, b.code, f.level`,
    sql.params,
  );
  return rows;
}

async function loadAssets(pool: Pool, user: CurrentUser, query: Record<string, unknown>) {
  const filters = parseAssetFilters(query);
  const { sql, orderBy } = buildAssetQuery(user, filters);
  const { rows } = await pool.query(`SELECT ${ASSET_SELECT} ${ASSET_FROM} ${sql.whereSql()} ${orderBy}`, sql.params);
  return { rows, types: filters.types as AssetType[] };
}

async function loadRelations(pool: Pool, user: CurrentUser, plantId?: string, assetId?: string) {
  const sql = new SqlBuilder();
  applyScope(sql, user, 's.plant_id');
  applyScope(sql, user, 't.plant_id');
  if (plantId) sql.and(`(s.plant_id = ${sql.p(plantId)} OR t.plant_id = ${sql.p(plantId)})`);
  if (assetId) sql.and(`(r.source_id = ${sql.p(assetId)} OR r.target_id = ${sql.p(assetId)})`);
  const { rows } = await pool.query(
    `SELECT r.*, s.name AS source_name, s.type AS source_type, t.name AS target_name, t.type AS target_type
     FROM asset_relation r JOIN asset s ON s.id = r.source_id JOIN asset t ON t.id = r.target_id ${sql.whereSql()}
     ORDER BY s.name, r.relation`,
    sql.params,
  );
  return rows;
}

async function loadNotes(pool: Pool, user: CurrentUser, query: Record<string, unknown>) {
  const sql = new SqlBuilder();
  applyScope(sql, user, 'n.plant_id');
  const plantId = queryString(query.plantId);
  const entityType = queryString(query.entityType);
  const entityId = queryString(query.entityId);
  if (plantId) sql.and(`n.plant_id = ${sql.p(requireUuid(plantId, 'plantId'))}`);
  if (entityType) sql.and(`n.entity_type = ${sql.p(entityType)}`);
  if (entityId) sql.and(`n.entity_id = ${sql.p(requireUuid(entityId, 'entityId'))}`);
  const { rows } = await pool.query(`SELECT ${NOTE_SELECT} ${NOTE_FROM} ${sql.whereSql()} ORDER BY n.created_at DESC`, sql.params);
  return rows;
}

async function loadActivities(pool: Pool, user: CurrentUser, query: Record<string, unknown>) {
  const sql = buildActivityQuery(user, query);
  const { rows } = await pool.query(`SELECT ${ACTIVITY_SELECT} ${ACTIVITY_FROM} ${sql.whereSql()} ${ACTIVITY_ORDER}`, sql.params);
  return rows;
}

async function loadUsers(pool: Pool) {
  const { rows } = await pool.query(
    `SELECT u.*, (SELECT array_agg(p.code ORDER BY p.code) FROM plant p WHERE p.id = ANY(u.plant_scope)) AS plant_scope_codes
     FROM app_user u ORDER BY u.display_name`,
  );
  return rows;
}

async function loadRacks(pool: Pool, user: CurrentUser, f: { plantId?: string; buildingId?: string; rackId?: string } = {}) {
  const sql = new SqlBuilder();
  applyScope(sql, user, 'b.plant_id');
  if (f.plantId) sql.and(`b.plant_id = ${sql.p(f.plantId)}`);
  if (f.buildingId) sql.and(`r.building_id = ${sql.p(f.buildingId)}`);
  if (f.rackId) sql.and(`r.id = ${sql.p(f.rackId)}`);
  const { rows } = await pool.query(`SELECT ${RACK_SELECT} ${RACK_FROM} ${sql.whereSql()} ORDER BY p.code, b.code, lower(r.name)`, sql.params);
  return rows;
}

async function loadRackContents(pool: Pool, user: CurrentUser, f: { plantId?: string; buildingId?: string; rackId?: string } = {}) {
  const sql = new SqlBuilder();
  applyScope(sql, user, 'b.plant_id');
  if (f.plantId) sql.and(`b.plant_id = ${sql.p(f.plantId)}`);
  if (f.buildingId) sql.and(`r.building_id = ${sql.p(f.buildingId)}`);
  if (f.rackId) sql.and(`r.id = ${sql.p(f.rackId)}`);
  const where = sql.where.length ? `AND ${sql.where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT p.code AS plant_code, b.name AS building_name, r.name AS rack_name, 'asset' AS source, a.type AS kind, a.name AS label,
              a.status, a.model, a.serial_number, a.ip_address, NULL::text AS note, a.rack_u AS u, a.rack_height_u AS height
       FROM asset a JOIN rack r ON r.id = a.rack_id JOIN building b ON b.id = r.building_id JOIN plant p ON p.id = b.plant_id
       WHERE true ${where}
       UNION ALL
       SELECT p.code, b.name, r.name, 'item', i.kind, i.label, NULL, NULL, NULL, NULL, i.note, i.position_u, i.height_u
       FROM rack_item i JOIN rack r ON r.id = i.rack_id JOIN building b ON b.id = r.building_id JOIN plant p ON p.id = b.plant_id
       WHERE true ${where}
     ) x ORDER BY plant_code, building_name, rack_name, u DESC NULLS LAST, label`,
    sql.params,
  );
  return rows.map((r) => ({ ...r, units: r.u ? formatRackUnits(r.u, r.height) : 'not positioned', u_top: r.u ? r.u + r.height - 1 : null }));
}

function assetSheets(rows: Record<string, unknown>[], perType: boolean): Sheet[] {
  const sheets: Sheet[] = [{ name: 'All assets', columns: assetColumns([]), rows }];
  if (perType) {
    for (const t of ASSET_TYPE_KEYS) {
      const subset = rows.filter((r) => r.type === t);
      sheets.push({ name: ASSET_TYPES[t].plural, columns: assetColumns([t]), rows: subset });
    }
  }
  return sheets;
}

// ---------------------------------------------------------------- router

// ------------------------------------------------------------- attachments

const ENTITY_TYPE_LABEL: Record<EntityType, string> = { plant: 'Plant', building: 'Building', floor: 'Floor', rack: 'Rack', asset: 'Asset' };

function attachmentColumns(baseUrl: string): Column[] {
  return [
    { key: 'entity_type', header: 'Object type', width: 12, get: (r) => ENTITY_TYPE_LABEL[r.entity_type as EntityType] ?? r.entity_type },
    { key: 'entity_label', header: 'Object', width: 26 },
    { key: 'file_name', header: 'File name', width: 30 },
    { key: 'title', header: 'Title', width: 24 },
    { key: 'category', header: 'Category', width: 18, get: (r) => ATTACHMENT_CATEGORY_META[r.category as AttachmentCategory]?.label ?? r.category },
    { key: 'content_type', header: 'Type', width: 18 },
    { key: 'size', header: 'Size', width: 10, get: (r) => formatBytes(Number(r.size_bytes)) },
    { key: 'is_plan', header: 'Plan', width: 7, get: (r) => (r.is_plan ? 'yes' : 'no') },
    { key: 'description', header: 'Description', width: 30 },
    { key: 'created_by_name', header: 'Uploaded by', width: 20 },
    { key: 'created_at', header: 'Uploaded at', width: 20, get: (r) => (r.created_at instanceof Date ? r.created_at.toISOString().replace('T', ' ').slice(0, 19) : r.created_at) },
    { key: 'url', header: 'Download URL', width: 60, get: (r) => `${baseUrl}/api/attachments/${r.id}/file?download=1` },
  ];
}

interface AttachmentFilter {
  plantId?: string;
  entityType?: EntityType;
  entityId?: string;
}

function attachmentFilter(query: Record<string, unknown>): AttachmentFilter {
  const plantId = queryString(query.plantId);
  const entityType = queryString(query.entityType);
  const entityId = queryString(query.entityId);
  if (entityType && !ENTITY_TYPES.includes(entityType as EntityType)) throw badRequest('Invalid entityType');
  return {
    plantId: plantId ? requireUuid(plantId, 'plantId') : undefined,
    entityType: entityType as EntityType | undefined,
    entityId: entityId ? requireUuid(entityId, 'entityId') : undefined,
  };
}

async function loadAttachmentList(pool: Pool, user: CurrentUser, f: AttachmentFilter) {
  const sql = new SqlBuilder();
  const plantExpr = `(${ATTACHMENT_PLANT_SQL('att')})`;
  applyScope(sql, user, plantExpr);
  if (f.plantId) sql.and(`${plantExpr} = ${sql.p(f.plantId)}`);
  if (f.entityType) sql.and(`att.entity_type = ${sql.p(f.entityType)}`);
  if (f.entityId) sql.and(`att.entity_id = ${sql.p(f.entityId)}`);
  const { rows } = await pool.query(
    `SELECT ${ATTACHMENT_SELECT}, att.storage_key ${ATTACHMENT_FROM} ${sql.whereSql()} ORDER BY att.entity_type, att.entity_id, att.created_at`,
    sql.params,
  );
  return rows;
}

function zipSafe(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || '_';
}

export function exportsRouter(pool: Pool): Router {
  const r = Router();
  r.use(requirePermission('export'));

  const done = async (req: Request, dataset: string, format: string, count: number, extra?: Record<string, unknown>) =>
    audit(pool, req, { action: 'export', entityType: dataset, changes: { format, rows: count, filters: { ...req.query, format: undefined }, ...extra } });

  r.get('/export/assets', async (req, res) => {
    const format = formatOf(req);
    const { rows, types } = await loadAssets(pool, req.user!, req.query);
    const title = types.length === 1 ? ASSET_TYPES[types[0]].plural : 'Assets';
    await done(req, 'assets', format, rows.length);
    await sendExport(res, format, title, [{ name: title, columns: assetColumns(types), rows }], {
      title: `CMDB export – ${title}`,
      user: req.user!.displayName,
      delimiter: delimiterOf(req),
    });
  });

  r.get('/export/plants', async (req, res) => {
    const format = formatOf(req);
    const rows = await loadPlants(pool, req.user!);
    await done(req, 'plants', format, rows.length);
    await sendExport(res, format, 'Plants', [{ name: 'Plants', columns: PLANT_COLUMNS, rows }], { title: 'CMDB export – Plants', user: req.user!.displayName, delimiter: delimiterOf(req) });
  });

  r.get('/export/buildings', async (req, res) => {
    const format = formatOf(req);
    const plantId = queryString(req.query.plantId);
    const rows = await loadBuildings(pool, req.user!, plantId ? requireUuid(plantId, 'plantId') : undefined);
    await done(req, 'buildings', format, rows.length);
    await sendExport(res, format, 'Buildings', [{ name: 'Buildings', columns: BUILDING_COLUMNS, rows }], { title: 'CMDB export – Buildings', user: req.user!.displayName, delimiter: delimiterOf(req) });
  });

  r.get('/export/floors', async (req, res) => {
    const format = formatOf(req);
    const plantId = queryString(req.query.plantId);
    const buildingId = queryString(req.query.buildingId);
    const rows = await loadFloors(pool, req.user!, plantId ? requireUuid(plantId) : undefined, buildingId ? requireUuid(buildingId) : undefined);
    await done(req, 'floors', format, rows.length);
    await sendExport(res, format, 'Floors', [{ name: 'Floors', columns: FLOOR_COLUMNS, rows }], { title: 'CMDB export – Floors', user: req.user!.displayName, delimiter: delimiterOf(req) });
  });

  r.get('/export/relations', async (req, res) => {
    const format = formatOf(req);
    const plantId = queryString(req.query.plantId);
    const rows = await loadRelations(pool, req.user!, plantId ? requireUuid(plantId) : undefined);
    await done(req, 'relations', format, rows.length);
    await sendExport(res, format, 'Relations', [{ name: 'Relations', columns: RELATION_COLUMNS, rows }], { title: 'CMDB export – Relations', user: req.user!.displayName, delimiter: delimiterOf(req) });
  });

  r.get('/export/notes', async (req, res) => {
    const format = formatOf(req);
    const rows = await loadNotes(pool, req.user!, req.query);
    await done(req, 'notes', format, rows.length);
    await sendExport(res, format, 'Notes', [{ name: 'Notes', columns: NOTE_COLUMNS, rows }], { title: 'CMDB export – Notes', user: req.user!.displayName, delimiter: delimiterOf(req) });
  });

  r.get('/export/activities', async (req, res) => {
    const format = formatOf(req);
    const rows = await loadActivities(pool, req.user!, req.query);
    await done(req, 'activities', format, rows.length);
    await sendExport(res, format, 'Activities', [{ name: 'Activities', columns: ACTIVITY_COLUMNS, rows }], { title: 'CMDB export – Activities', user: req.user!.displayName, delimiter: delimiterOf(req) });
  });

  r.get('/export/audit', requirePermission('audit.read'), async (req, res) => {
    const format = formatOf(req);
    const sql = buildAuditQuery(req.query);
    const { rows } = await pool.query(`SELECT ${AUDIT_SELECT} FROM audit_log l ${sql.whereSql()} ORDER BY l.at DESC LIMIT 100000`, sql.params);
    await done(req, 'audit', format, rows.length);
    await sendExport(res, format, 'Audit_log', [{ name: 'Audit log', columns: AUDIT_COLUMNS, rows }], { title: 'CMDB export – Audit log', user: req.user!.displayName, delimiter: delimiterOf(req) });
  });

  r.get('/export/users', requirePermission('user.manage'), async (req, res) => {
    const format = formatOf(req);
    const rows = await loadUsers(pool);
    await done(req, 'users', format, rows.length);
    await sendExport(res, format, 'Users', [{ name: 'Users', columns: USER_COLUMNS, rows }], { title: 'CMDB export – Users', user: req.user!.displayName, delimiter: delimiterOf(req) });
  });

  r.get('/export/datacenters', async (req, res) => {
    const format = formatOf(req);
    const plantId = queryString(req.query.plantId);
    const rows = await loadDatacenterExportRows(pool, req.user!, plantId ? requireUuid(plantId, 'plantId') : undefined);
    await done(req, 'datacenters', format, rows.length);
    await sendExport(res, format, 'Data_centers', [{ name: 'Data centers', columns: DATACENTER_COLUMNS, rows }], { title: 'CMDB export – Data centers', user: req.user!.displayName, delimiter: delimiterOf(req) });
  });

  r.get('/export/racks', async (req, res) => {
    const format = formatOf(req);
    const plantId = queryString(req.query.plantId);
    const buildingId = queryString(req.query.buildingId);
    const rows = await loadRacks(pool, req.user!, { plantId: plantId ? requireUuid(plantId) : undefined, buildingId: buildingId ? requireUuid(buildingId) : undefined });
    await done(req, 'racks', format, rows.length);
    await sendExport(res, format, 'Racks', [{ name: 'Racks', columns: RACK_COLUMNS, rows }], { title: 'CMDB export – Racks', user: req.user!.displayName, delimiter: delimiterOf(req) });
  });

  r.get('/export/rack-contents', async (req, res) => {
    const format = formatOf(req);
    const plantId = queryString(req.query.plantId);
    const buildingId = queryString(req.query.buildingId);
    const rackId = queryString(req.query.rackId);
    const rows = await loadRackContents(pool, req.user!, {
      plantId: plantId ? requireUuid(plantId) : undefined,
      buildingId: buildingId ? requireUuid(buildingId) : undefined,
      rackId: rackId ? requireUuid(rackId) : undefined,
    });
    await done(req, 'rack-contents', format, rows.length);
    await sendExport(res, format, 'Rack_contents', [{ name: 'Rack contents', columns: RACK_CONTENT_COLUMNS, rows }], { title: 'CMDB export – Rack contents', user: req.user!.displayName, delimiter: delimiterOf(req) });
  });

  /** One rack: details, unit-by-unit elevation (as printed on a rack door) and contents */
  r.get('/export/rack/:id', async (req, res) => {
    const format = formatOf(req, ['xlsx', 'json']);
    const id = requireUuid(req.params.id);
    const rack = await loadRackDetail(pool, id);
    assertPlantAccess(req.user!, rack.plant_id);
    const occupants: { u: number; height: number; label: string; kind: string }[] = [
      ...rack.assets.filter((a: { rack_u: number | null }) => a.rack_u).map((a: { rack_u: number; rack_height_u: number; name: string; type: AssetType }) => ({ u: a.rack_u, height: a.rack_height_u, label: a.name, kind: ASSET_TYPES[a.type]?.label ?? a.type })),
      ...rack.items.map((i: { position_u: number; height_u: number; label: string; kind: keyof typeof RACK_ITEM_KIND_META }) => ({ u: i.position_u, height: i.height_u, label: i.label, kind: RACK_ITEM_KIND_META[i.kind]?.label ?? i.kind })),
    ];
    const units = Array.from({ length: rack.height_u }, (_, k) => rack.height_u - k).map((u) => {
      const o = occupants.filter((x) => u >= x.u && u <= x.u + x.height - 1);
      const display = rack.numbering === 'top_down' ? rack.height_u - u + 1 : u;
      return { unit: `U${display}`, content: o.map((x) => (u === x.u + x.height - 1 ? x.label : `↑ ${x.label}`)).join(' / ') || null, kind: o.map((x) => x.kind).join(' / ') || null };
    });
    const details = [
      ['Plant', `${rack.plant_code} – ${rack.plant_name}`], ['Building', rack.building_name], ['Floor', rack.floor_name], ['Room', rack.room],
      ['Rack', rack.name], ['Height (U)', rack.height_u], ['Used (U)', rack.used_u], ['Free (U)', rack.height_u - rack.used_u],
      ['Manufacturer', rack.manufacturer], ['Model', rack.model], ['Description', rack.description],
    ].map(([field, value]) => ({ field, value }));
    const contents = await loadRackContents(pool, req.user!, { rackId: id });
    await done(req, 'rack', format, contents.length, { rack: rack.name });
    await sendExport(
      res,
      format,
      `Rack_${rack.building_code}_${rack.name}`,
      [
        { name: 'Rack', columns: [{ key: 'field', header: 'Field', width: 16 }, { key: 'value', header: 'Value', width: 40 }], rows: format === 'json' ? [rack] : details },
        { name: 'Elevation', columns: [{ key: 'unit', header: 'Unit', width: 8 }, { key: 'content', header: 'Content', width: 40 }, { key: 'kind', header: 'Kind', width: 18 }], rows: units },
        { name: 'Contents', columns: RACK_CONTENT_COLUMNS, rows: contents },
      ],
      { title: `Rack ${rack.building_name} / ${rack.name}`, user: req.user!.displayName },
    );
  });

  r.get('/export/attachments', async (req, res) => {
    const format = formatOf(req);
    const rows = await loadAttachmentList(pool, req.user!, attachmentFilter(req.query));
    await done(req, 'attachments', format, rows.length);
    const columns = attachmentColumns(attachmentContext(pool).config.baseUrl);
    await sendExport(res, format, 'Attachments', [{ name: 'Attachments', columns, rows: rows.map(({ storage_key: _k, sha256: _s, ...r }) => r) }], {
      title: 'CMDB export – Attachments',
      user: req.user!.displayName,
      delimiter: delimiterOf(req),
    });
  });

  /** All files of one object (entityType + entityId) or of a whole plant (plantId) as ZIP, one folder per object */
  r.get('/export/files.zip', async (req, res) => {
    const f = attachmentFilter(req.query);
    if (!f.plantId && !(f.entityType && f.entityId)) throw badRequest('Give entityType and entityId, or plantId');
    if (f.plantId) assertPlantAccess(req.user!, f.plantId);
    const rows = await loadAttachmentList(pool, req.user!, f);
    if (f.entityType && f.entityId && !rows.length) {
      // still verify access to the object so a scoped user gets 403 instead of an empty archive
      await resolveEntityWithAccess(pool, req.user!, f.entityType, f.entityId);
    }
    await done(req, 'files', 'zip', rows.length, { files: rows.length });
    const { storage } = attachmentContext(pool);
    const label = f.plantId ? `Files_plant` : `Files_${zipSafe(rows[0]?.entity_label ?? f.entityType ?? 'object')}`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(label, 'zip' as ExportFormat)}"`);
    res.setHeader('Cache-Control', 'no-store');

    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('warning', (err) => log.warn('export: zip warning', { error: err.message }));
    zip.on('error', (err) => {
      log.error('export: zip failed', { error: err.message });
      res.destroy(err);
    });
    zip.pipe(res);
    const used = new Set<string>();
    for (const row of rows) {
      const folder = zipSafe(`${ENTITY_TYPE_LABEL[row.entity_type as EntityType]} ${row.entity_label ?? row.entity_id}`);
      const dot = row.file_name.lastIndexOf('.');
      const stem = zipSafe(dot > 0 ? row.file_name.slice(0, dot) : row.file_name);
      const ext = dot > 0 ? zipSafe(row.file_name.slice(dot)) : '';
      let name = `${folder}/${stem}${ext}`;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${folder}/${stem} (${i})${ext}`;
      used.add(name.toLowerCase());
      try {
        zip.append(await storage.get(row.storage_key), { name, date: new Date(row.created_at) });
      } catch (err) {
        log.error('export: file missing in storage', { id: row.id, error: (err as Error).message });
        zip.append(`The file "${row.file_name}" could not be read from the storage.`, { name: `${name}.MISSING.txt` });
      }
    }
    await zip.finalize();
  });

  /** Complete workbook (everything the user may see). With ?plantId= it becomes a plant dossier. */
  r.get('/export/full', async (req, res) => {
    const format = formatOf(req, ['xlsx', 'json']);
    const user = req.user!;
    const plantParam = queryString(req.query.plantId);
    const plantId = plantParam ? requireUuid(plantParam, 'plantId') : undefined;
    if (plantId) assertPlantAccess(user, plantId);

    const plants = await loadPlants(pool, user, plantId);
    if (plantId && !plants[0]) throw notFound('Plant');
    const [buildings, floors, racks, rackContents, assets, relations, notes, activities] = await Promise.all([
      loadBuildings(pool, user, plantId),
      loadFloors(pool, user, plantId),
      loadRacks(pool, user, { plantId }),
      loadRackContents(pool, user, { plantId }),
      loadAssets(pool, user, plantId ? { plantId } : {}),
      loadRelations(pool, user, plantId),
      loadNotes(pool, user, plantId ? { plantId } : {}),
      loadActivities(pool, user, plantId ? { plantId } : {}),
    ]);
    const sheets: Sheet[] = [
      { name: plantId ? 'Plant' : 'Plants', columns: PLANT_COLUMNS, rows: plants },
      { name: 'Buildings', columns: BUILDING_COLUMNS, rows: buildings },
      { name: 'Floors', columns: FLOOR_COLUMNS, rows: floors },
      { name: 'Racks', columns: RACK_COLUMNS, rows: racks },
      { name: 'Rack contents', columns: RACK_CONTENT_COLUMNS, rows: rackContents },
      { name: 'Data centers', columns: DATACENTER_COLUMNS, rows: await loadDatacenterExportRows(pool, user, plantId) },
      ...assetSheets(assets.rows, true),
      { name: 'Relations', columns: RELATION_COLUMNS, rows: relations },
      { name: 'Activities', columns: ACTIVITY_COLUMNS, rows: activities },
      { name: 'Notes', columns: NOTE_COLUMNS, rows: notes },
      { name: 'Attachments', columns: attachmentColumns(attachmentContext(pool).config.baseUrl), rows: await loadAttachmentList(pool, user, { plantId }) },
    ];
    if (!plantId && can(user.role, 'user.manage')) sheets.push({ name: 'Users', columns: USER_COLUMNS, rows: await loadUsers(pool) });

    const base = plantId ? `Plant_${plants[0].code}` : 'CMDB_full_export';
    await done(req, plantId ? 'plant-dossier' : 'full', format, assets.rows.length);
    await sendExport(res, format, base, sheets, { title: plantId ? `Plant dossier ${plants[0].code}` : 'CMDB full export', user: user.displayName });
  });

  /** Single asset dossier: master data, relations, notes, activities, change history */
  r.get('/export/asset/:id', async (req, res) => {
    const format = formatOf(req, ['xlsx', 'json']);
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query(`SELECT ${ASSET_SELECT} ${ASSET_FROM} WHERE a.id = $1`, [id]);
    const asset = rows[0];
    if (!asset) throw notFound('Asset');
    if (!req.user) throw forbidden();
    assertPlantAccess(req.user, asset.plant_id);
    const [relations, notes, activities, history] = await Promise.all([
      loadRelations(pool, req.user, undefined, id),
      loadNotes(pool, req.user, { entityType: 'asset', entityId: id }),
      loadActivities(pool, req.user, { entityType: 'asset', entityId: id }),
      pool.query(`SELECT ${AUDIT_SELECT} FROM audit_log l WHERE l.entity_type = 'asset' AND l.entity_id = $1 ORDER BY l.at DESC`, [id]),
    ]);
    const cols = assetColumns([asset.type]);
    const details = cols.map((c) => ({ field: c.header, value: c.get ? c.get(asset) : asset[c.key] }));
    await done(req, 'asset-dossier', format, 1, { asset: asset.name });
    await sendExport(
      res,
      format,
      `Asset_${asset.name}`,
      [
        { name: 'Details', columns: [{ key: 'field', header: 'Field', width: 22 }, { key: 'value', header: 'Value', width: 50 }], rows: format === 'json' ? [asset] : details },
        { name: 'Relations', columns: RELATION_COLUMNS, rows: relations },
        { name: 'Activities', columns: ACTIVITY_COLUMNS, rows: activities },
        { name: 'Notes', columns: NOTE_COLUMNS, rows: notes },
        {
          name: 'Attachments',
          columns: attachmentColumns(attachmentContext(pool).config.baseUrl),
          rows: await loadAttachmentList(pool, req.user, { entityType: 'asset', entityId: id }),
        },
        { name: 'History', columns: AUDIT_COLUMNS.filter((c) => c.key !== 'ip'), rows: history.rows },
      ],
      { title: `Asset dossier ${asset.name}`, user: req.user.displayName },
    );
  });

  return r;
}

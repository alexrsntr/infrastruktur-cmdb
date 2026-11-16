import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import type { Pool, PoolClient } from 'pg';
import {
  ASSET_STATUS_META,
  ASSET_TYPES,
  ASSET_TYPE_KEYS,
  CRITICALITY_META,
  type AssetType,
  type AssetTypeSettings,
  type ImportReport,
} from '../../shared/model';
import { requirePermission } from '../auth/context';
import { audit, diff, snapshot } from '../lib/audit';
import { badRequest, isUuid, queryString } from '../lib/http';
import { assetSchema, plantSchema } from '../lib/schemas';
import { hasPlantAccess, isUnscoped } from '../lib/scope';
import { insertAsset, resolveAssetLocation, updateAsset } from '../services/assets';
import { attributeFields, assetColumns, PLANT_COLUMNS } from '../services/tabular';
import { cleanAttributes, loadAssetTypeSettings } from '../services/assetTypes';

const MAX_ROWS = 10_000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

type RawRow = Record<string, unknown>;

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-/().]+/g, '');

/** Maps spreadsheet headers (export headers or field keys) to internal keys. */
function headerMap(settings: AssetTypeSettings): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of assetColumns([], settings)) {
    map.set(norm(c.header), c.key);
    map.set(norm(c.key), c.key);
  }
  for (const f of attributeFields([], settings)) {
    map.set(norm(f.label), `attr:${f.key}`);
    if (f.unit) map.set(norm(`${f.label} (${f.unit})`), `attr:${f.key}`);
    map.set(norm(f.key), `attr:${f.key}`);
  }
  // Common aliases
  map.set('hostname', 'name');
  map.set('ip', 'ip_address');
  map.set('mac', 'mac_address');
  map.set('serial', 'serial_number');
  map.set('plantcode', 'plant_code');
  map.set('buildingcode', 'building_code');
  map.set('os', 'os');
  map.set('rack', 'rack_name');
  map.set('he', 'rack_unit');
  map.set('u', 'rack_unit');
  return map;
}

function cellToValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellToValue(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return (v as { text: string }).text;
    if ('error' in v) return null;
  }
  return v;
}

/** Rows of the file plus its column headers (also those of columns that are empty in every row) */
async function readRows(file: Express.Multer.File): Promise<{ rows: RawRow[]; columns: string[] }> {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('The workbook contains no worksheet');
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => (headers[col] = String(cellToValue(cell.value) ?? '').trim()));
    const rows: RawRow[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj: RawRow = {};
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        if (headers[col]) obj[headers[col]] = cellToValue(cell.value);
      });
      rows.push(obj);
    });
    return { rows, columns: headers.filter(Boolean) };
  }
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const text = file.buffer.toString('utf8').replace(/^﻿/, '');
    const parsed = Papa.parse<RawRow>(text, { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() });
    if (parsed.errors.length && !parsed.data.length) throw badRequest(`CSV could not be parsed: ${parsed.errors[0].message}`);
    return { rows: parsed.data, columns: parsed.meta.fields ?? [] };
  }
  throw badRequest('Unsupported file type. Upload an .xlsx or .csv file.');
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function toDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const de = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (de) return `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}`;
  return s; // let validation report it
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function byLabelOrKey<T extends string>(value: string | null, metaMap: Record<T, { label: string }>): T | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  return (Object.keys(metaMap) as T[]).find((k) => k.toLowerCase() === v || metaMap[k].label.toLowerCase() === v);
}

interface Lookups {
  plants: Map<string, string>; // code/name (lc) -> id
  buildings: Map<string, string>; // plantId|code (lc) -> id
  floors: Map<string, string>; // buildingId|name (lc) -> id
  racks: Map<string, string>; // buildingId|name (lc) -> id
}

async function loadLookups(db: PoolClient): Promise<Lookups> {
  // Sequential on purpose: a single client must not run queries concurrently
  const p = await db.query<{ id: string; code: string; name: string }>('SELECT id, code, name FROM plant');
  const b = await db.query<{ id: string; plant_id: string; code: string; name: string }>('SELECT id, plant_id, code, name FROM building');
  const f = await db.query<{ id: string; building_id: string; name: string }>('SELECT id, building_id, name FROM floor');
  const plants = new Map<string, string>();
  for (const r of p.rows) {
    plants.set(r.name.toLowerCase(), r.id);
    plants.set(r.code.toLowerCase(), r.id);
  }
  const buildings = new Map<string, string>();
  for (const r of b.rows) {
    buildings.set(`${r.plant_id}|${r.name.toLowerCase()}`, r.id);
    buildings.set(`${r.plant_id}|${r.code.toLowerCase()}`, r.id);
  }
  const floors = new Map<string, string>();
  for (const r of f.rows) floors.set(`${r.building_id}|${r.name.toLowerCase()}`, r.id);
  const rk = await db.query<{ id: string; building_id: string; name: string }>('SELECT id, building_id, name FROM rack');
  const racks = new Map<string, string>();
  for (const r of rk.rows) racks.set(`${r.building_id}|${r.name.toLowerCase()}`, r.id);
  return { plants, buildings, floors, racks };
}

function mapRow(raw: RawRow, headers: Map<string, string>, lookups: Lookups, defaultType?: AssetType) {
  const v: Record<string, unknown> = {};
  const attributes: Record<string, unknown> = {};
  for (const [header, value] of Object.entries(raw)) {
    const key = headers.get(norm(header));
    if (!key) continue;
    if (key.startsWith('attr:')) attributes[key.slice(5)] = value;
    else v[key] = value;
  }

  const typeRaw = str(v.type);
  const type = typeRaw
    ? ASSET_TYPE_KEYS.find((k) => k === typeRaw.toLowerCase() || ASSET_TYPES[k].label.toLowerCase() === typeRaw.toLowerCase() || ASSET_TYPES[k].plural.toLowerCase() === typeRaw.toLowerCase())
    : defaultType;
  if (!type) throw new Error(typeRaw ? `Unknown type "${typeRaw}"` : 'Column "Type" is missing');

  const plantKey = str(v.plant_code) ?? str(v.plant_name);
  const plantId = plantKey ? lookups.plants.get(plantKey.toLowerCase()) : null;
  if (plantKey && !plantId) throw new Error(`Unknown plant "${plantKey}"`);
  const buildingKey = str(v.building_code) ?? str(v.building_name);
  let buildingId: string | null = null;
  if (buildingKey) {
    if (!plantId) throw new Error('A building requires a plant');
    buildingId = lookups.buildings.get(`${plantId}|${buildingKey.toLowerCase()}`) ?? null;
    if (!buildingId) throw new Error(`Unknown building "${buildingKey}" in plant "${plantKey}"`);
  }
  const floorKey = str(v.floor_name);
  let floorId: string | null = null;
  if (floorKey) {
    if (!buildingId) throw new Error('A floor requires a building');
    floorId = lookups.floors.get(`${buildingId}|${floorKey.toLowerCase()}`) ?? null;
    if (!floorId) throw new Error(`Unknown floor "${floorKey}"`);
  }

  const rackKey = str(v.rack_name);
  let rackId: string | null = null;
  if (rackKey) {
    if (!buildingId) throw new Error('A rack requires a building');
    rackId = lookups.racks.get(`${buildingId}|${rackKey.toLowerCase()}`) ?? null;
    if (!rackId) throw new Error(`Unknown rack "${rackKey}" in building "${buildingKey}" – create the rack first`);
  }
  const unitRaw = str(v.rack_unit);
  let rackU: number | null = null;
  let rackHeight = 1;
  if (unitRaw) {
    const m = unitRaw.match(/^U?\s*(\d+)(?:\s*[-–]\s*U?\s*(\d+))?$/i);
    if (!m) throw new Error(`Invalid rack unit "${unitRaw}" (use e.g. 12 or 12-13)`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    rackU = Math.min(a, b);
    rackHeight = Math.abs(b - a) + 1;
    if (!rackId) throw new Error('A rack unit requires a rack');
  }

  const statusRaw = str(v.status);
  const critRaw = str(v.criticality);
  const status = byLabelOrKey(statusRaw, ASSET_STATUS_META);
  const criticality = byLabelOrKey(critRaw, CRITICALITY_META);
  if (statusRaw && !status) throw new Error(`Unknown status "${statusRaw}"`);
  if (critRaw && !criticality) throw new Error(`Unknown criticality "${critRaw}"`);

  const id = str(v.id);
  return {
    id: id && isUuid(id) ? id : null,
    input: {
      type,
      name: str(v.name) ?? '',
      status: status ?? 'active',
      criticality: criticality ?? 'medium',
      plant_id: plantId,
      building_id: buildingId,
      floor_id: floorId,
      room: str(v.room),
      rack_id: rackId,
      rack_u: rackU,
      rack_height_u: rackHeight,
      map_x: toNumber(v.map_x),
      map_y: toNumber(v.map_y),
      manufacturer: str(v.manufacturer),
      model: str(v.model),
      serial_number: str(v.serial_number),
      asset_tag: str(v.asset_tag),
      ip_address: str(v.ip_address),
      mac_address: str(v.mac_address),
      fqdn: str(v.fqdn),
      os: str(v.os),
      owner: str(v.owner),
      cost_center: str(v.cost_center),
      purchase_date: toDate(v.purchase_date),
      warranty_end: toDate(v.warranty_end),
      support_end: toDate(v.support_end),
      end_of_life: toDate(v.end_of_life),
      support_contract: str(v.support_contract),
      description: str(v.description),
      tags: (str(v.tags) ?? '').split(/[,;]/).map((t) => t.trim()).filter(Boolean),
      attributes,
    },
  };
}

/** Asset fields that are filled from exactly one column with the same key */
const PLAIN_FIELDS = [
  'name', 'status', 'criticality', 'room', 'manufacturer', 'model', 'serial_number', 'asset_tag', 'ip_address', 'mac_address', 'fqdn', 'os',
  'owner', 'cost_center', 'purchase_date', 'warranty_end', 'support_end', 'end_of_life', 'support_contract', 'description', 'tags',
] as const;

/**
 * An import changes only what the file contains: for an existing asset every field whose column is missing
 * in the file keeps its current value. A column that is there counts, also with an empty cell (= clear the value).
 * Without this a file with a few columns (e.g. Type, Name, Owner) would reset everything else of the asset.
 * Location levels are only carried over while the level above is unchanged (another building → not the old floor or rack).
 */
function keepMissingColumns(input: Record<string, unknown>, existing: Record<string, unknown>, present: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const field of PLAIN_FIELDS) if (!present.has(field)) out[field] = existing[field];

  if (!present.has('plant_code') && !present.has('plant_name')) out.plant_id = existing.plant_id;
  if (!present.has('building_code') && !present.has('building_name')) out.building_id = out.plant_id === existing.plant_id ? existing.building_id : null;
  const sameBuilding = out.building_id === existing.building_id;
  if (!present.has('floor_name')) out.floor_id = sameBuilding ? existing.floor_id : null;
  if (!present.has('rack_name')) out.rack_id = sameBuilding ? existing.rack_id : null;
  if (!present.has('rack_unit')) {
    const sameRack = out.rack_id === existing.rack_id;
    out.rack_u = sameRack ? existing.rack_u : null;
    out.rack_height_u = sameRack ? existing.rack_height_u : 1;
  }
  for (const axis of ['map_x', 'map_y']) if (!present.has(axis)) out[axis] = out.floor_id === existing.floor_id ? existing[axis] : null;

  const attributes: Record<string, unknown> = { ...((existing.attributes as Record<string, unknown> | null) ?? {}) };
  for (const key of present) if (key.startsWith('attr:')) delete attributes[key.slice(5)];
  out.attributes = { ...attributes, ...(input.attributes as Record<string, unknown>) };
  return out;
}

// ---------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------

const PLANT_FIELDS = ['code', 'name', 'country', 'city', 'address', 'latitude', 'longitude', 'timezone', 'contact', 'description'] as const;
type PlantField = (typeof PLANT_FIELDS)[number];

/** Plant export headers, field keys and common aliases → field */
function plantHeaderMap(): Map<string, PlantField | 'id'> {
  const map = new Map<string, PlantField | 'id'>();
  for (const c of PLANT_COLUMNS) {
    if (c.key === 'id' || (PLANT_FIELDS as readonly string[]).includes(c.key)) {
      map.set(norm(c.header), c.key as PlantField | 'id');
      map.set(norm(c.key), c.key as PlantField | 'id');
    }
  }
  const aliases: Record<string, PlantField> = {
    plant: 'code',
    plantcode: 'code',
    site: 'code',
    sitecode: 'code',
    plantname: 'name',
    sitename: 'name',
    street: 'address',
    location: 'city',
    town: 'city',
    lat: 'latitude',
    lng: 'longitude',
    lon: 'longitude',
    tz: 'timezone',
    contactperson: 'contact',
    responsible: 'contact',
    notes: 'description',
    note: 'description',
  };
  for (const [k, v] of Object.entries(aliases)) if (!map.has(k)) map.set(k, v);
  return map;
}

/** Plant fields of one row; a field whose column is missing keeps the value of an existing plant. */
function mapPlantRow(raw: RawRow, headers: Map<string, PlantField | 'id'>): { id: string | null; values: Partial<Record<PlantField, unknown>> } {
  const values: Partial<Record<PlantField, unknown>> = {};
  let id: string | null = null;
  for (const [header, value] of Object.entries(raw)) {
    const key = headers.get(norm(header));
    if (!key) continue;
    if (key === 'id') {
      const s = str(value);
      id = s && isUuid(s) ? s : null;
    } else if (key === 'latitude' || key === 'longitude') {
      const s = str(value);
      const n = toNumber(value);
      if (s && n === null) throw new Error(`Invalid ${key} "${s}"`);
      values[key] = n;
    } else values[key] = str(value);
  }
  return { id, values };
}

export function importsRouter(pool: Pool): Router {
  const r = Router();

  r.post('/import/assets', requirePermission('import'), upload.single('file'), async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded (field "file")');
    const dryRun = queryString(req.query.dryRun) !== 'false';
    const defaultTypeParam = queryString(req.query.type);
    const defaultType = ASSET_TYPE_KEYS.find((k) => k === defaultTypeParam);
    const { rows, columns } = await readRows(req.file);
    if (rows.length > MAX_ROWS) throw badRequest(`Too many rows (${rows.length}). The limit is ${MAX_ROWS} per file.`);

    const report: ImportReport = { dryRun, total: rows.length, created: 0, updated: 0, skipped: 0, errors: [] };
    const settings = await loadAssetTypeSettings(pool);
    const headers = headerMap(settings);
    // internal keys of the columns this file has (see keepMissingColumns)
    const present = new Set(columns.map((c) => headers.get(norm(c))).filter((k): k is string => !!k));
    const user = req.user!;
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const lookups = await loadLookups(db);
      for (let i = 0; i < rows.length; i++) {
        const rowNumber = i + 2; // header is row 1
        await db.query('SAVEPOINT row_sp');
        try {
          const mapped = mapRow(rows[i], headers, lookups, defaultType);
          let existing = null;
          if (mapped.id) existing = (await db.query('SELECT * FROM asset WHERE id = $1 FOR UPDATE', [mapped.id])).rows[0];
          if (!existing && mapped.input.name)
            existing = (await db.query('SELECT * FROM asset WHERE type = $1 AND lower(name) = lower($2) FOR UPDATE', [mapped.input.type, mapped.input.name])).rows[0];
          const parsed = assetSchema.safeParse(existing ? keepMissingColumns(mapped.input, existing, present) : mapped.input);
          if (!parsed.success) throw new Error(parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; '));
          const input = { ...parsed.data, attributes: cleanAttributes(parsed.data.type, parsed.data.attributes, settings) };
          const loc = await resolveAssetLocation(db, input, existing?.id);
          if (!hasPlantAccess(user, loc.plant_id)) throw new Error('Plant is outside of your plant scope');

          if (existing) {
            if (!hasPlantAccess(user, existing.plant_id)) throw new Error('Existing asset is outside of your plant scope');
            if (existing.type !== input.type) throw new Error('The type of an existing asset cannot be changed by import');
            const updated = await updateAsset(db, existing.id, input, loc, user.id);
            const changes = diff(existing, updated);
            if (Object.keys(changes).length) {
              report.updated++;
              await audit(db, req, { action: 'update', entityType: 'asset', entityId: existing.id, entityLabel: updated.name, plantId: updated.plant_id, changes: { ...changes, _source: 'import' } });
            } else report.skipped++;
          } else {
            const created = await insertAsset(db, input, loc, user.id);
            report.created++;
            await audit(db, req, { action: 'create', entityType: 'asset', entityId: created.id, entityLabel: created.name, plantId: created.plant_id, changes: { ...snapshot(created), _source: 'import' } });
          }
          await db.query('RELEASE SAVEPOINT row_sp');
        } catch (err) {
          await db.query('ROLLBACK TO SAVEPOINT row_sp');
          const e = err as { message: string; code?: string };
          const message = e.code === '23505' ? 'Duplicate name for this asset type' : e.message;
          report.errors.push({ row: rowNumber, message });
        }
      }
      if (dryRun) {
        await db.query('ROLLBACK');
      } else {
        await audit(db, req, { action: 'import', entityType: 'assets', changes: { file: req.file.originalname, created: report.created, updated: report.updated, errors: report.errors.length } });
        await db.query('COMMIT');
      }
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      db.release();
    }
    res.json(report);
  });

  /**
   * Plants from Excel / CSV: matched by ID, otherwise by code, and updated; other rows create new plants
   * (only users without plant restriction may create plants, like in the UI).
   */
  r.post('/import/plants', requirePermission('import'), upload.single('file'), async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded (field "file")');
    const dryRun = queryString(req.query.dryRun) !== 'false';
    const { rows } = await readRows(req.file);
    if (rows.length > MAX_ROWS) throw badRequest(`Too many rows (${rows.length}). The limit is ${MAX_ROWS} per file.`);
    const headers = plantHeaderMap();
    const report: ImportReport = { dryRun, total: rows.length, created: 0, updated: 0, skipped: 0, errors: [] };
    const user = req.user!;
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const seenCodes = new Map<string, number>();
      for (let i = 0; i < rows.length; i++) {
        const rowNumber = i + 2;
        await db.query('SAVEPOINT row_sp');
        try {
          const { id, values } = mapPlantRow(rows[i], headers);
          const code = typeof values.code === 'string' ? values.code : null;
          if (code) {
            const earlier = seenCodes.get(code.toLowerCase());
            if (earlier) throw new Error(`The code "${code}" appears again (row ${earlier})`);
            seenCodes.set(code.toLowerCase(), rowNumber);
          }
          let existing = null;
          if (id) existing = (await db.query('SELECT * FROM plant WHERE id = $1 FOR UPDATE', [id])).rows[0];
          if (!existing && code) existing = (await db.query('SELECT * FROM plant WHERE lower(code) = lower($1) FOR UPDATE', [code])).rows[0];
          const merged: Record<string, unknown> = existing ? { ...Object.fromEntries(PLANT_FIELDS.map((f) => [f, existing[f]])), ...values } : values;
          const missing = (['code', 'name'] as const).filter((f) => !merged[f]);
          if (missing.length) throw new Error(`${missing.map((f) => (f === 'code' ? 'Code' : 'Name')).join(' and ')} missing`);
          const parsed = plantSchema.safeParse(merged);
          if (!parsed.success) throw new Error(parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message === 'Required' ? 'missing' : x.message}`).join('; '));
          const input = parsed.data;

          if (existing) {
            if (!hasPlantAccess(user, existing.id)) throw new Error('This plant is outside of your plant scope');
            const { rows: after } = await db.query(
              `UPDATE plant SET code=$2, name=$3, country=$4, city=$5, address=$6, latitude=$7, longitude=$8, timezone=$9, contact=$10,
                 description=$11, updated_by=$12, updated_at=now() WHERE id=$1 RETURNING *`,
              [existing.id, input.code, input.name, input.country, input.city, input.address, input.latitude, input.longitude, input.timezone, input.contact, input.description, user.id],
            );
            const changes = diff(existing, after[0]);
            if (Object.keys(changes).length) {
              report.updated++;
              await audit(db, req, { action: 'update', entityType: 'plant', entityId: existing.id, entityLabel: `${input.code} – ${input.name}`, plantId: existing.id, changes: { ...changes, _source: 'import' } });
            } else report.skipped++;
          } else {
            if (!isUnscoped(user)) throw new Error('New plants can only be created by users without plant restriction');
            const { rows: created } = await db.query(
              `INSERT INTO plant (code, name, country, city, address, latitude, longitude, timezone, contact, description, created_by, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
              [input.code, input.name, input.country, input.city, input.address, input.latitude, input.longitude, input.timezone, input.contact, input.description, user.id],
            );
            report.created++;
            await audit(db, req, { action: 'create', entityType: 'plant', entityId: created[0].id, entityLabel: `${input.code} – ${input.name}`, plantId: created[0].id, changes: { ...snapshot(created[0]), _source: 'import' } });
          }
          await db.query('RELEASE SAVEPOINT row_sp');
        } catch (err) {
          await db.query('ROLLBACK TO SAVEPOINT row_sp');
          const e = err as { message: string; code?: string };
          report.errors.push({ row: rowNumber, message: e.code === '23505' ? 'A plant with this code already exists' : e.message });
        }
      }
      if (dryRun) await db.query('ROLLBACK');
      else {
        await audit(db, req, { action: 'import', entityType: 'plants', changes: { file: req.file.originalname, created: report.created, updated: report.updated, errors: report.errors.length } });
        await db.query('COMMIT');
      }
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      db.release();
    }
    res.json(report);
  });

  return r;
}

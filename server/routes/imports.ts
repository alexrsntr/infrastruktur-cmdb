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
  type ImportReport,
} from '../../shared/model';
import { requirePermission } from '../auth/context';
import { audit, diff, snapshot } from '../lib/audit';
import { badRequest, isUuid, queryString } from '../lib/http';
import { assetSchema } from '../lib/schemas';
import { hasPlantAccess } from '../lib/scope';
import { insertAsset, resolveAssetLocation, updateAsset } from '../services/assets';
import { attributeFields, assetColumns } from '../services/tabular';

const MAX_ROWS = 10_000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

type RawRow = Record<string, unknown>;

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-/().]+/g, '');

/** Maps spreadsheet headers (export headers or field keys) to internal keys. */
function headerMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of assetColumns([])) {
    map.set(norm(c.header), c.key);
    map.set(norm(c.key), c.key);
  }
  for (const f of attributeFields([])) {
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

async function readRows(file: Express.Multer.File): Promise<RawRow[]> {
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
    return rows;
  }
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const text = file.buffer.toString('utf8').replace(/^﻿/, '');
    const parsed = Papa.parse<RawRow>(text, { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() });
    if (parsed.errors.length && !parsed.data.length) throw badRequest(`CSV could not be parsed: ${parsed.errors[0].message}`);
    return parsed.data;
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
      description: str(v.description),
      tags: (str(v.tags) ?? '').split(/[,;]/).map((t) => t.trim()).filter(Boolean),
      attributes,
    },
  };
}

export function importsRouter(pool: Pool): Router {
  const r = Router();

  r.post('/import/assets', requirePermission('import'), upload.single('file'), async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded (field "file")');
    const dryRun = queryString(req.query.dryRun) !== 'false';
    const defaultTypeParam = queryString(req.query.type);
    const defaultType = ASSET_TYPE_KEYS.find((k) => k === defaultTypeParam);
    const rows = await readRows(req.file);
    if (rows.length > MAX_ROWS) throw badRequest(`Too many rows (${rows.length}). The limit is ${MAX_ROWS} per file.`);

    const report: ImportReport = { dryRun, total: rows.length, created: 0, updated: 0, skipped: 0, errors: [] };
    const headers = headerMap();
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
          const parsed = assetSchema.safeParse(mapped.input);
          if (!parsed.success) throw new Error(parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; '));
          const input = parsed.data;
          let existing = null;
          if (mapped.id) existing = (await db.query('SELECT * FROM asset WHERE id = $1 FOR UPDATE', [mapped.id])).rows[0];
          if (!existing) existing = (await db.query('SELECT * FROM asset WHERE type = $1 AND lower(name) = lower($2) FOR UPDATE', [input.type, input.name])).rows[0];
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

  return r;
}

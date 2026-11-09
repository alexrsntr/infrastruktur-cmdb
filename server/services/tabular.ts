import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import type { Response } from 'express';
import {
  ACTIVITY_KIND_META,
  ACTIVITY_STATUS_META,
  ASSET_STATUS_META,
  ASSET_TYPES,
  ASSET_TYPE_KEYS,
  CRITICALITY_META,
  assetTypeFields,
  type AssetTypeSettings,
  RELATION_TYPES,
  RACK_ITEM_KIND_META,
  ROLE_META,
  formatRackUnits,
  type AssetType,
  type FieldDef,
} from '../../shared/model';

export interface Column {
  key: string;
  header: string;
  width?: number;
  get?: (row: Record<string, unknown>) => unknown;
}

export interface Sheet {
  name: string;
  columns: Column[];
  rows: Record<string, unknown>[];
}

export type ExportFormat = 'csv' | 'xlsx' | 'json';

const fmtDateTime = (v: unknown) => (v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 19) : v ?? null);
const meta = (m: Record<string, { label: string }>) => (v: unknown) => (typeof v === 'string' && m[v] ? m[v].label : v ?? null);

// ---------------------------------------------------------------------------
// Column definitions (headers double as import headers)
// ---------------------------------------------------------------------------

export const PLANT_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', width: 38 },
  { key: 'code', header: 'Code', width: 10 },
  { key: 'name', header: 'Name', width: 28 },
  { key: 'country', header: 'Country', width: 16 },
  { key: 'city', header: 'City', width: 18 },
  { key: 'address', header: 'Address', width: 32 },
  { key: 'latitude', header: 'Latitude', width: 11 },
  { key: 'longitude', header: 'Longitude', width: 11 },
  { key: 'timezone', header: 'Time zone', width: 16 },
  { key: 'contact', header: 'Contact', width: 24 },
  { key: 'building_count', header: 'Buildings', width: 10 },
  { key: 'asset_count', header: 'Assets', width: 10 },
  { key: 'description', header: 'Description', width: 40 },
  { key: 'updated_at', header: 'Last change', width: 20, get: (r) => fmtDateTime(r.updated_at) },
];

export const BUILDING_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', width: 38 },
  { key: 'plant_code', header: 'Plant', width: 10 },
  { key: 'plant_name', header: 'Plant name', width: 24 },
  { key: 'code', header: 'Code', width: 10 },
  { key: 'name', header: 'Name', width: 28 },
  { key: 'floor_count', header: 'Floors', width: 8 },
  { key: 'asset_count', header: 'Assets', width: 8 },
  { key: 'latitude', header: 'Latitude', width: 11 },
  { key: 'longitude', header: 'Longitude', width: 11 },
  { key: 'description', header: 'Description', width: 40 },
  { key: 'updated_at', header: 'Last change', width: 20, get: (r) => fmtDateTime(r.updated_at) },
];

export const FLOOR_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', width: 38 },
  { key: 'plant_code', header: 'Plant', width: 10 },
  { key: 'building_name', header: 'Building', width: 24 },
  { key: 'name', header: 'Floor', width: 16 },
  { key: 'level', header: 'Level', width: 8 },
  { key: 'has_plan', header: 'Floor plan', width: 10, get: (r) => (r.has_plan ? 'yes' : 'no') },
  { key: 'asset_count', header: 'Assets', width: 8 },
];

const ASSET_BASE_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', width: 38 },
  { key: 'type', header: 'Type', width: 16, get: (r) => ASSET_TYPES[r.type as AssetType]?.label ?? r.type },
  { key: 'name', header: 'Name', width: 26 },
  { key: 'status', header: 'Status', width: 13, get: (r) => meta(ASSET_STATUS_META)(r.status) },
  { key: 'criticality', header: 'Criticality', width: 11, get: (r) => meta(CRITICALITY_META)(r.criticality) },
  { key: 'plant_code', header: 'Plant', width: 9 },
  { key: 'plant_name', header: 'Plant name', width: 22 },
  { key: 'building_code', header: 'Building', width: 12 },
  { key: 'building_name', header: 'Building name', width: 20 },
  { key: 'floor_name', header: 'Floor', width: 12 },
  { key: 'room', header: 'Room', width: 12 },
  { key: 'rack_name', header: 'Rack', width: 10 },
  { key: 'rack_unit', header: 'Rack unit', width: 9, get: (r) => formatRackUnits(r.rack_u as number | null, (r.rack_height_u as number) ?? 1) || null },
  { key: 'manufacturer', header: 'Manufacturer', width: 16 },
  { key: 'model', header: 'Model', width: 22 },
  { key: 'serial_number', header: 'Serial number', width: 18 },
  { key: 'asset_tag', header: 'Asset tag', width: 14 },
  { key: 'ip_address', header: 'IP address', width: 16 },
  { key: 'mac_address', header: 'MAC address', width: 18 },
  { key: 'fqdn', header: 'FQDN', width: 28 },
  { key: 'os', header: 'OS / firmware', width: 20 },
  { key: 'owner', header: 'Owner', width: 18 },
  { key: 'cost_center', header: 'Cost center', width: 12 },
  { key: 'purchase_date', header: 'Purchase date', width: 13 },
  { key: 'warranty_end', header: 'Warranty end', width: 13 },
  { key: 'support_end', header: 'Support end', width: 13 },
  { key: 'end_of_life', header: 'End of life', width: 13 },
  { key: 'support_contract', header: 'Support contract', width: 20 },
  { key: 'tags', header: 'Tags', width: 20, get: (r) => (Array.isArray(r.tags) ? r.tags.join(', ') : r.tags ?? null) },
  { key: 'description', header: 'Description', width: 40 },
];

const ASSET_TRAILING_COLUMNS: Column[] = [
  { key: 'map_x', header: 'Plan X', width: 8 },
  { key: 'map_y', header: 'Plan Y', width: 8 },
  { key: 'last_seen_at', header: 'Last seen', width: 20, get: (r) => fmtDateTime(r.last_seen_at) },
  { key: 'updated_at', header: 'Last change', width: 20, get: (r) => fmtDateTime(r.updated_at) },
  { key: 'updated_by_name', header: 'Changed by', width: 20 },
];

/** Attribute field definitions for one or several asset types (deduplicated by key). */
export function attributeFields(types: AssetType[], settings?: AssetTypeSettings | null): FieldDef[] {
  const seen = new Map<string, FieldDef>();
  for (const t of types.length ? types : ASSET_TYPE_KEYS) {
    for (const f of assetTypeFields(t, settings)) if (!seen.has(f.key)) seen.set(f.key, f);
  }
  return [...seen.values()];
}

export function assetColumns(types: AssetType[], settings?: AssetTypeSettings | null): Column[] {
  const attrs: Column[] = attributeFields(types, settings).map((f) => ({
    key: `attr:${f.key}`,
    header: f.unit ? `${f.label} (${f.unit})` : f.label,
    width: 14,
    get: (r) => {
      const v = (r.attributes as Record<string, unknown> | null)?.[f.key];
      if (typeof v === 'boolean') return v ? 'yes' : 'no';
      return v ?? null;
    },
  }));
  return [...ASSET_BASE_COLUMNS, ...attrs, ...ASSET_TRAILING_COLUMNS];
}

export const RACK_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', width: 38 },
  { key: 'plant_code', header: 'Plant', width: 9 },
  { key: 'building_code', header: 'Building', width: 10 },
  { key: 'building_name', header: 'Building name', width: 20 },
  { key: 'floor_name', header: 'Floor', width: 14 },
  { key: 'room', header: 'Room', width: 14 },
  { key: 'name', header: 'Rack', width: 12 },
  { key: 'height_u', header: 'Height (U)', width: 10 },
  { key: 'used_u', header: 'Used (U)', width: 9 },
  { key: 'free_u', header: 'Free (U)', width: 9, get: (r) => Number(r.height_u) - Number(r.used_u ?? 0) },
  { key: 'asset_count', header: 'Devices', width: 9 },
  { key: 'numbering', header: 'Numbering', width: 11, get: (r) => (r.numbering === 'top_down' ? 'top → down' : 'bottom → up') },
  { key: 'manufacturer', header: 'Manufacturer', width: 14 },
  { key: 'model', header: 'Model', width: 16 },
  { key: 'description', header: 'Description', width: 30 },
];

/** One row per occupied position (devices and other rack equipment) */
export const RACK_CONTENT_COLUMNS: Column[] = [
  { key: 'plant_code', header: 'Plant', width: 9 },
  { key: 'building_name', header: 'Building', width: 18 },
  { key: 'rack_name', header: 'Rack', width: 12 },
  { key: 'units', header: 'Units', width: 9 },
  { key: 'u_top', header: 'Top U', width: 7 },
  { key: 'height', header: 'Height (U)', width: 10 },
  { key: 'kind', header: 'Kind', width: 16, get: (r) => (r.source === 'asset' ? (ASSET_TYPES[r.kind as AssetType]?.label ?? r.kind) : (RACK_ITEM_KIND_META[r.kind as keyof typeof RACK_ITEM_KIND_META]?.label ?? r.kind)) },
  { key: 'label', header: 'Name / label', width: 26 },
  { key: 'status', header: 'Status', width: 12, get: (r) => meta(ASSET_STATUS_META)(r.status) },
  { key: 'model', header: 'Model', width: 20 },
  { key: 'serial_number', header: 'Serial number', width: 16 },
  { key: 'ip_address', header: 'IP address', width: 15 },
  { key: 'note', header: 'Note', width: 26 },
];

export const RELATION_COLUMNS: Column[] = [
  { key: 'source_type', header: 'Source type', width: 14, get: (r) => ASSET_TYPES[r.source_type as AssetType]?.label ?? r.source_type },
  { key: 'source_name', header: 'Source', width: 24 },
  { key: 'source_port', header: 'Source port', width: 12 },
  { key: 'relation', header: 'Relation', width: 16, get: (r) => RELATION_TYPES[r.relation as keyof typeof RELATION_TYPES]?.label ?? r.relation },
  { key: 'target_type', header: 'Target type', width: 14, get: (r) => ASSET_TYPES[r.target_type as AssetType]?.label ?? r.target_type },
  { key: 'target_name', header: 'Target', width: 24 },
  { key: 'target_port', header: 'Target port', width: 12 },
  { key: 'note', header: 'Note', width: 30 },
];

export const NOTE_COLUMNS: Column[] = [
  { key: 'created_at', header: 'Created', width: 20, get: (r) => fmtDateTime(r.created_at) },
  { key: 'created_by_name', header: 'Author', width: 20 },
  { key: 'entity_type', header: 'Object type', width: 12 },
  { key: 'entity_label', header: 'Object', width: 26 },
  { key: 'pinned', header: 'Pinned', width: 8, get: (r) => (r.pinned ? 'yes' : 'no') },
  { key: 'body', header: 'Note', width: 60 },
];

export const ACTIVITY_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', width: 38 },
  { key: 'plant_name', header: 'Plant', width: 20 },
  { key: 'entity_type', header: 'Object type', width: 12 },
  { key: 'entity_label', header: 'Object', width: 24 },
  { key: 'kind', header: 'Kind', width: 13, get: (r) => meta(ACTIVITY_KIND_META)(r.kind) },
  { key: 'status', header: 'Status', width: 12, get: (r) => meta(ACTIVITY_STATUS_META)(r.status) },
  { key: 'title', header: 'Title', width: 34 },
  { key: 'assignee', header: 'Assignee', width: 18 },
  { key: 'due_date', header: 'Due', width: 12 },
  { key: 'completed_at', header: 'Completed', width: 20, get: (r) => fmtDateTime(r.completed_at) },
  { key: 'created_by_name', header: 'Created by', width: 18 },
  { key: 'created_at', header: 'Created', width: 20, get: (r) => fmtDateTime(r.created_at) },
  { key: 'description', header: 'Description', width: 50 },
];

export const AUDIT_COLUMNS: Column[] = [
  { key: 'at', header: 'Time (UTC)', width: 20, get: (r) => fmtDateTime(r.at) },
  { key: 'user_name', header: 'User', width: 22 },
  { key: 'action', header: 'Action', width: 16 },
  { key: 'entity_type', header: 'Object type', width: 12 },
  { key: 'entity_label', header: 'Object', width: 26 },
  { key: 'changes', header: 'Changes', width: 80, get: (r) => (r.changes ? JSON.stringify(r.changes) : null) },
  { key: 'ip', header: 'IP', width: 16 },
];

export const USER_COLUMNS: Column[] = [
  { key: 'display_name', header: 'Name', width: 24 },
  { key: 'email', header: 'E-mail', width: 30 },
  { key: 'role', header: 'Role', width: 14, get: (r) => meta(ROLE_META)(r.role) },
  { key: 'role_source', header: 'Role source', width: 12 },
  { key: 'plant_scope_codes', header: 'Plant scope', width: 20, get: (r) => (Array.isArray(r.plant_scope_codes) && r.plant_scope_codes.length ? r.plant_scope_codes.join(', ') : 'all') },
  { key: 'active', header: 'Active', width: 8, get: (r) => (r.active ? 'yes' : 'no') },
  { key: 'last_login_at', header: 'Last login', width: 20, get: (r) => fmtDateTime(r.last_login_at) },
];

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function cellValue(col: Column, row: Record<string, unknown>): unknown {
  const v = col.get ? col.get(row) : row[col.key];
  if (v instanceof Date) return v.toISOString();
  return v ?? null;
}

/** Neutralise spreadsheet formula injection in CSV output */
function csvSafe(v: unknown): unknown {
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) return `'${v}`;
  return v;
}

export function toCsv(sheet: Sheet, delimiter = ';'): string {
  const data = sheet.rows.map((row) => sheet.columns.map((c) => csvSafe(cellValue(c, row))));
  return '﻿' + Papa.unparse({ fields: sheet.columns.map((c) => c.header), data }, { delimiter, newline: '\r\n' });
}

export async function toXlsx(sheets: Sheet[], meta: { title: string; user: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.user;
  wb.created = new Date();
  wb.title = meta.title;
  const used = new Set<string>();
  for (const sheet of sheets) {
    let name = sheet.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
    while (used.has(name)) name = name.slice(0, 28) + ' ' + used.size;
    used.add(name);
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = sheet.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16 }));
    for (const row of sheet.rows) ws.addRow(sheet.columns.map((c) => cellValue(c, row)));
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
    header.alignment = { vertical: 'middle' };
    header.height = 20;
    if (sheet.columns.length) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rows.length + 1), column: sheet.columns.length } };
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toJson(sheets: Sheet[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const sheet of sheets) out[sheet.name] = sheet.rows;
  return out;
}

export function exportFilename(base: string, format: ExportFormat): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${base.replace(/[^a-z0-9_-]+/gi, '_')}_${stamp}.${format}`;
}

export async function sendExport(res: Response, format: ExportFormat, base: string, sheets: Sheet[], meta: { title: string; user: string; delimiter?: string }) {
  const filename = exportFilename(base, format);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  if (format === 'csv') {
    if (sheets.length !== 1) throw new Error('CSV export supports exactly one sheet');
    res.type('text/csv; charset=utf-8').send(toCsv(sheets[0], meta.delimiter));
  } else if (format === 'xlsx') {
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await toXlsx(sheets, meta));
  } else {
    res.type('application/json').send(JSON.stringify({ exportedAt: new Date().toISOString(), exportedBy: meta.user, title: meta.title, data: toJson(sheets) }, null, 2));
  }
}

import { z } from 'zod';
import {
  ASSET_TYPES,
  ASSET_TYPE_KEYS,
  EMPTY_ASSET_TYPE_SETTINGS,
  assetTypeFields,
  customFieldKey,
  type AssetType,
  type AssetTypeSettings,
  type FieldDef,
} from '../../shared/model';
import type { DbClient } from '../db/pool';
import { badRequest } from '../lib/http';
import { readSetting } from './mailer';

/**
 * Administrator settings for device types (app_setting "asset_types"):
 * hidden types and additional fields per type. Values of additional fields are stored in asset.attributes.
 */
export const ASSET_TYPES_KEY = 'asset_types';

export async function loadAssetTypeSettings(db: DbClient): Promise<AssetTypeSettings> {
  const row = await readSetting<Partial<AssetTypeSettings>>(db, ASSET_TYPES_KEY);
  const v = row?.value ?? {};
  return {
    hidden: (v.hidden ?? []).filter((t) => ASSET_TYPE_KEYS.includes(t)),
    customFields: Object.fromEntries(
      Object.entries(v.customFields ?? {}).filter(([t, f]) => ASSET_TYPE_KEYS.includes(t as AssetType) && Array.isArray(f) && f.length),
    ),
  };
}

const fieldSchema = z.object({
  key: z.string().trim().max(60).optional(),
  label: z.string().trim().min(1, 'Required').max(60),
  type: z.enum(['text', 'number', 'boolean', 'select', 'date']),
  options: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  unit: z.string().trim().max(20).optional(),
  placeholder: z.string().trim().max(100).optional(),
});

export const assetTypeSettingsSchema = z.object({
  hidden: z.array(z.enum(ASSET_TYPE_KEYS as [AssetType, ...AssetType[]])).default([]),
  customFields: z.record(z.string(), z.array(fieldSchema).max(30)).default({}),
});

/** Validates the settings and assigns stable keys ("custom_…") to new fields. */
export function normaliseAssetTypeSettings(input: z.infer<typeof assetTypeSettingsSchema>): AssetTypeSettings {
  const hidden = [...new Set(input.hidden)];
  if (hidden.length >= ASSET_TYPE_KEYS.length) throw badRequest('At least one device type must stay available');
  const customFields: Partial<Record<AssetType, FieldDef[]>> = {};
  for (const [type, fields] of Object.entries(input.customFields)) {
    if (!ASSET_TYPE_KEYS.includes(type as AssetType)) throw badRequest(`Unknown device type "${type}"`);
    const t = type as AssetType;
    const builtIn = new Set<string>((ASSET_TYPES[t].fields as readonly FieldDef[]).map((f) => f.key));
    const used = new Set<string>();
    const out: FieldDef[] = [];
    for (const f of fields) {
      let key = f.key && /^custom_[a-z0-9_]{1,40}$/.test(f.key) ? f.key : customFieldKey(f.label);
      if (builtIn.has(key)) throw badRequest(`Field "${f.label}" already exists for ${ASSET_TYPES[t].plural}`);
      // two new fields with the same label: number them
      for (let i = 2; used.has(key); i++) key = `${customFieldKey(f.label)}_${i}`;
      used.add(key);
      const options = f.type === 'select' ? [...new Set(f.options ?? [])] : undefined;
      if (f.type === 'select' && !options?.length) throw badRequest(`Field "${f.label}": a list needs at least one option`);
      out.push({
        key,
        label: f.label,
        type: f.type,
        ...(options ? { options } : {}),
        ...(f.unit && f.type === 'number' ? { unit: f.unit } : {}),
        ...(f.placeholder && f.type === 'text' ? { placeholder: f.placeholder } : {}),
      });
    }
    if (out.length) customFields[t] = out;
  }
  return { hidden, customFields };
}

/** Keep only attributes defined for the asset type (built-in and administrator fields) and coerce them to the declared field type. */
export function cleanAttributes(type: AssetType, attrs: Record<string, unknown>, settings: AssetTypeSettings = EMPTY_ASSET_TYPE_SETTINGS): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of assetTypeFields(type, settings)) {
    const raw = attrs[field.key];
    if (raw === undefined || raw === null || raw === '') continue;
    switch (field.type) {
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
        if (Number.isFinite(n)) out[field.key] = n;
        break;
      }
      case 'boolean':
        out[field.key] = typeof raw === 'boolean' ? raw : ['true', '1', 'yes', 'ja', 'x'].includes(String(raw).toLowerCase());
        break;
      case 'date': {
        // stored as YYYY-MM-DD; accepts ISO dates, DD.MM.YYYY (German Excel) and Date objects (Excel import)
        if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
          out[field.key] = raw.toISOString().slice(0, 10);
          break;
        }
        const s = String(raw).trim();
        const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        const de = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        out[field.key] = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : de ? `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}` : s.slice(0, 500);
        break;
      }
      default:
        out[field.key] = String(raw).trim().slice(0, 500);
    }
  }
  return out;
}

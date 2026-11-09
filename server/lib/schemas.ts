import { z } from 'zod';
import {
  ACTIVITY_KINDS,
  ACTIVITY_STATUSES,
  ASSET_STATUSES,
  ASSET_TYPE_KEYS,
  CRITICALITIES,
  ENTITY_TYPES,
  RACK_ITEM_KINDS,
  RELATION_TYPE_KEYS,
  ROLES,
  type AssetType,
  assetTypeFields,
} from '../../shared/model';

export const optText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const reqText = (max = 200) => z.string().trim().min(1, 'Required').max(max);

export const optNumber = (min = -Infinity, max = Infinity) =>
  z
    .number()
    .min(min)
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? null : v));

export const optDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected date YYYY-MM-DD')
  .nullish()
  .or(z.literal(''))
  .transform((v) => (v ? v : null));

export const optUuid = z
  .string()
  .uuid()
  .nullish()
  .or(z.literal(''))
  .transform((v) => (v ? v : null));

export const plantSchema = z.object({
  code: reqText(20),
  name: reqText(200),
  country: optText(100),
  city: optText(100),
  address: optText(300),
  latitude: optNumber(-90, 90),
  longitude: optNumber(-180, 180),
  timezone: optText(64),
  contact: optText(300),
  description: optText(4000),
});
export type PlantInput = z.infer<typeof plantSchema>;

export const buildingSchema = z.object({
  plant_id: z.string().uuid(),
  /** optional – generated from the name when empty */
  code: optText(30),
  name: reqText(200),
  description: optText(4000),
  latitude: optNumber(-90, 90),
  longitude: optNumber(-180, 180),
});
export type BuildingInput = z.infer<typeof buildingSchema>;

export const floorSchema = z.object({
  building_id: z.string().uuid(),
  name: reqText(100),
  level: z.number().int().min(-20).max(200).default(0),
});

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/\d{1,2})?$/;
const IPV6 = /^[0-9a-f:]+(\/\d{1,3})?$/i;
const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^([0-9a-f]{4}\.){2}[0-9a-f]{4}$/i;

export const assetSchema = z
  .object({
    type: z.enum(ASSET_TYPE_KEYS as [AssetType, ...AssetType[]]),
    name: reqText(200),
    status: z.enum(ASSET_STATUSES).default('active'),
    criticality: z.enum(CRITICALITIES).default('medium'),
    plant_id: optUuid,
    building_id: optUuid,
    floor_id: optUuid,
    room: optText(100),
    rack_id: optUuid,
    rack_u: z
      .number()
      .int()
      .min(1)
      .max(60)
      .nullish()
      .transform((v) => v ?? null),
    rack_height_u: z
      .number()
      .int()
      .min(1)
      .max(20)
      .nullish()
      .transform((v) => v ?? 1),
    map_x: optNumber(0, 1),
    map_y: optNumber(0, 1),
    manufacturer: optText(100),
    model: optText(200),
    serial_number: optText(100),
    asset_tag: optText(100),
    ip_address: optText(64).refine((v) => !v || IPV4.test(v) || (v.includes(':') && IPV6.test(v)), 'Invalid IP address'),
    mac_address: optText(32).refine((v) => !v || MAC.test(v), 'Invalid MAC address'),
    fqdn: optText(255),
    os: optText(200),
    owner: optText(200),
    cost_center: optText(50),
    purchase_date: optDate,
    warranty_end: optDate,
    description: optText(8000),
    tags: z
      .array(z.string().trim().min(1).max(50))
      .max(30)
      .nullish()
      .transform((v) => [...new Set(v ?? [])]),
    attributes: z.record(z.string(), z.unknown()).nullish().transform((v) => v ?? {}),
  })
  .transform((a) => ({ ...a, attributes: cleanAttributes(a.type, a.attributes) }));
export type AssetInput = z.infer<typeof assetSchema>;

/** Keep only attributes defined for the asset type and coerce them to the declared field type. */
export function cleanAttributes(type: AssetType, attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of assetTypeFields(type)) {
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

export const assetStatusSchema = z.object({ status: z.enum(ASSET_STATUSES) });

export const positionSchema = z.object({
  floor_id: optUuid,
  map_x: optNumber(0, 1),
  map_y: optNumber(0, 1),
});

export const relationSchema = z.object({
  source_id: z.string().uuid(),
  target_id: z.string().uuid(),
  relation: z.enum(RELATION_TYPE_KEYS as [string, ...string[]]),
  source_port: optText(50),
  target_port: optText(50),
  note: optText(500),
});

export const noteSchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.string().uuid(),
  body: z.string().trim().min(1, 'Required').max(20000),
  pinned: z.boolean().default(false),
});

export const noteUpdateSchema = z.object({
  body: z.string().trim().min(1, 'Required').max(20000),
  pinned: z.boolean().default(false),
});

export const activitySchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.string().uuid(),
  kind: z.enum(ACTIVITY_KINDS),
  status: z.enum(ACTIVITY_STATUSES).default('open'),
  title: reqText(300),
  description: optText(20000),
  assignee: optText(200),
  due_date: optDate,
});

export const activityUpdateSchema = activitySchema.omit({ entity_type: true, entity_id: true });

export const userUpdateSchema = z.object({
  role: z.enum(ROLES),
  plant_scope: z.array(z.string().uuid()).max(500).default([]),
  active: z.boolean().default(true),
});

export const userCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  display_name: reqText(200),
  role: z.enum(ROLES),
  plant_scope: z.array(z.string().uuid()).max(500).default([]),
  /** Initial password for local accounts (AUTH_MODE=local) */
  password: z.string().min(10, 'The password must have at least 10 characters').max(200).optional(),
});

export const userPasswordSchema = z.object({
  password: z.string().min(10, 'The password must have at least 10 characters').max(200),
});

export const ownPasswordSchema = z.object({
  current_password: z.string().max(200),
  new_password: z.string().min(10, 'The new password must have at least 10 characters').max(200),
});

export const rackSchema = z.object({
  building_id: z.string().uuid(),
  floor_id: optUuid,
  name: reqText(50),
  room: optText(100),
  height_u: z.number().int().min(1).max(60).default(42),
  numbering: z.enum(['bottom_up', 'top_down']).default('bottom_up'),
  manufacturer: optText(100),
  model: optText(100),
  description: optText(4000),
});

export const rackItemSchema = z.object({
  kind: z.enum(RACK_ITEM_KINDS),
  label: reqText(100),
  position_u: z.number().int().min(1).max(60),
  height_u: z.number().int().min(1).max(20).default(1),
  note: optText(500),
});

export const rackMountSchema = z.object({
  rack_id: optUuid,
  rack_u: z
    .number()
    .int()
    .min(1)
    .max(60)
    .nullish()
    .transform((v) => v ?? null),
  rack_height_u: z.number().int().min(1).max(20).default(1),
});

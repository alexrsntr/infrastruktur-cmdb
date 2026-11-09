import { NO_IP_TYPES, QUALITY_ISSUES, VIRTUAL_TYPES, type QualityIssue } from '../../shared/quality';

const list = (t: string[]) => t.map((x) => `'${x}'`).join(',');
const PHYSICAL = `a.type NOT IN (${list(VIRTUAL_TYPES)})`;
const blank = (col: string) => `NULLIF(btrim(${col}), '') IS NULL`;
const MAC = `lower(regexp_replace(a.mac_address, '[^0-9a-fA-F]', '', 'g'))`;

/** SQL condition (asset alias "a") per data quality issue; retired devices are never checked */
export const QUALITY_SQL: Record<QualityIssue, string> = {
  duplicate_serial: `NOT ${blank('a.serial_number')} AND EXISTS (SELECT 1 FROM asset o WHERE o.id <> a.id AND o.status <> 'retired' AND lower(o.serial_number) = lower(a.serial_number))`,
  duplicate_mac: `NOT ${blank('a.mac_address')} AND EXISTS (SELECT 1 FROM asset o WHERE o.id <> a.id AND o.status <> 'retired' AND lower(regexp_replace(o.mac_address, '[^0-9a-fA-F]', '', 'g')) = ${MAC})`,
  duplicate_ip: `cmdb_inet(a.ip_address) IS NOT NULL AND EXISTS (SELECT 1 FROM asset o WHERE o.id <> a.id AND o.status <> 'retired' AND o.plant_id IS NOT DISTINCT FROM a.plant_id AND cmdb_inet(o.ip_address) = cmdb_inet(a.ip_address))`,
  missing_serial: `${PHYSICAL} AND ${blank('a.serial_number')}`,
  missing_location: `CASE WHEN ${PHYSICAL} THEN a.building_id IS NULL ELSE a.plant_id IS NULL END`,
  missing_model: `${blank('a.model')} AND ${PHYSICAL}`,
  missing_ip: `a.type NOT IN (${list(NO_IP_TYPES)}) AND ${blank('a.ip_address')}`,
  missing_warranty: `${PHYSICAL} AND a.warranty_end IS NULL`,
  missing_owner: blank('a.owner'),
  missing_lifecycle: `${PHYSICAL} AND a.support_end IS NULL AND a.end_of_life IS NULL`,
};

/** SELECT list: issues as text[] of the device */
export const QUALITY_ISSUES_SQL = `ARRAY_REMOVE(ARRAY[${QUALITY_ISSUES.map((k) => `CASE WHEN ${QUALITY_SQL[k]} THEN '${k}' END`).join(', ')}], NULL)`;

// Data quality: rules, weights and the score per device. Shared by API and web client.

import type { AssetType } from './model';

export const QUALITY_ISSUES = [
  'duplicate_serial',
  'duplicate_mac',
  'duplicate_ip',
  'missing_serial',
  'missing_location',
  'missing_model',
  'missing_ip',
  'missing_warranty',
  'missing_owner',
  'missing_lifecycle',
] as const;
export type QualityIssue = (typeof QUALITY_ISSUES)[number];

export const QUALITY_META: Record<QualityIssue, { label: string; hint: string; weight: number }> = {
  duplicate_serial: { label: 'Serial number used twice', hint: 'Another device has the same serial number – probably a duplicate entry', weight: 25 },
  duplicate_mac: { label: 'MAC address used twice', hint: 'Another device has the same MAC address', weight: 20 },
  duplicate_ip: { label: 'IP address used twice', hint: 'Another device in the same plant has the same IP address', weight: 20 },
  missing_serial: { label: 'No serial number', hint: 'Needed for warranty and support cases and for matching discovered devices', weight: 15 },
  missing_location: { label: 'No location', hint: 'Physical devices need a building (virtual machines a plant)', weight: 15 },
  missing_model: { label: 'No manufacturer / model', hint: 'Manufacturer and model identify spare parts and support', weight: 10 },
  missing_ip: { label: 'No IP address', hint: 'Network-connected devices should have their management address', weight: 10 },
  missing_warranty: { label: 'No warranty date', hint: 'Without it the CMDB cannot warn before the warranty ends', weight: 10 },
  missing_owner: { label: 'No responsible person / team', hint: 'Who to call when something is wrong', weight: 10 },
  missing_lifecycle: { label: 'No support / end-of-life date', hint: 'Plan replacements before vendor support ends', weight: 5 },
};

/** Types without serial number, warranty and location (virtual) */
export const VIRTUAL_TYPES: AssetType[] = ['vm'];
/** Types that are usually not managed over IP */
export const NO_IP_TYPES: AssetType[] = ['pdu', 'other'];

export function qualityScore(issues: QualityIssue[]): number {
  return Math.max(0, 100 - issues.reduce((s, i) => s + QUALITY_META[i].weight, 0));
}

export interface QualityAsset {
  id: string;
  name: string;
  type: AssetType;
  plant_code: string | null;
  score: number;
  issues: QualityIssue[];
}

export interface QualityReport {
  /** average score of all devices (0–100) */
  score: number;
  total: number;
  /** devices without any issue */
  complete: number;
  counts: Record<QualityIssue, number>;
  /** worst devices first */
  assets: QualityAsset[];
  duplicates: { kind: 'serial' | 'mac' | 'ip'; value: string; assets: { id: string; name: string; type: AssetType; plant_code: string | null }[] }[];
}

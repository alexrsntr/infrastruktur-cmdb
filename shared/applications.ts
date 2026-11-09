// Applications / IT services and the impact analysis ("If this device fails"). Shared by API and web client.

import type { AssetStatus, AssetType, Criticality, RelationType } from './model';

export const APP_STATUSES = ['planned', 'production', 'test', 'retired'] as const;
export type AppStatus = (typeof APP_STATUSES)[number];
export const APP_STATUS_META: Record<AppStatus, { label: string; color: string }> = {
  planned: { label: 'Planned', color: 'default' },
  production: { label: 'Production', color: 'success' },
  test: { label: 'Test', color: 'blue' },
  retired: { label: 'Retired', color: 'default' },
};

/**
 * Relations along which a failure spreads: the source depends on the target
 * (an access point on its uplink switch, a VM on its host, a server on its UPS …).
 */
export const IMPACT_RELATIONS: RelationType[] = ['uplink', 'runs_on', 'powered_by', 'depends_on'];

export interface Application {
  id: string;
  name: string;
  status: AppStatus;
  criticality: Criticality;
  plant_id: string | null;
  plant_code?: string | null;
  plant_name?: string | null;
  owner: string | null;
  url: string | null;
  description: string | null;
  asset_count?: number;
  created_at: string;
  updated_at: string;
}

export interface ApplicationAsset {
  asset_id: string;
  name: string;
  type: AssetType;
  status: AssetStatus;
  criticality: Criticality;
  plant_code: string | null;
  ip_address: string | null;
  role: string | null;
}

export interface ImpactAsset {
  id: string;
  name: string;
  type: AssetType;
  status: AssetStatus;
  criticality: Criticality;
  plant_code: string | null;
  /** 1 = depends directly on the device */
  depth: number;
  /** relation over which it is affected and the device it hangs on */
  relation: RelationType;
  via_id: string;
  via_name: string;
}

export interface ImpactApplication {
  id: string;
  name: string;
  status: AppStatus;
  criticality: Criticality;
  /** devices of the application that fail */
  assets: string[];
}

export interface ImpactResult {
  /** Devices that stop working (directly or indirectly) when this one fails */
  affected: ImpactAsset[];
  applications: ImpactApplication[];
  /** Redundancy partners of the device – the real impact may be lower */
  redundant: { id: string; name: string }[];
}

export interface ApplicationDetail extends Application {
  assets: ApplicationAsset[];
  /** Infrastructure the application needs (devices its devices depend on, transitively) */
  dependencies: (ImpactAsset & { for_name: string })[];
}

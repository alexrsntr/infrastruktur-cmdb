// Data centers (single or stretched across buildings) – shared between API and UI.
import type { AssetStatus, AssetType, RelationType } from './model';

export const DATACENTER_KINDS = ['single', 'stretched'] as const;
export type DatacenterKind = (typeof DATACENTER_KINDS)[number];
export const DATACENTER_KIND_META: Record<DatacenterKind, { label: string; description: string }> = {
  single: { label: 'Single site', description: 'One server room in one building' },
  stretched: { label: 'Stretched', description: 'Two server rooms in different buildings that work as one data center' },
};

export const DC_SITE_ROLES = ['primary', 'secondary', 'witness'] as const;
export type DcSiteRole = (typeof DC_SITE_ROLES)[number];
export const DC_SITE_ROLE_META: Record<DcSiteRole, { label: string; color: string }> = {
  primary: { label: 'Primary', color: 'blue' },
  secondary: { label: 'Secondary', color: 'cyan' },
  witness: { label: 'Witness', color: 'default' },
};

export const DC_LINK_KINDS = ['fiber', 'copper', 'wan', 'other'] as const;
export type DcLinkKind = (typeof DC_LINK_KINDS)[number];
export const DC_LINK_KIND_META: Record<DcLinkKind, { label: string; color: string }> = {
  fiber: { label: 'Fibre', color: '#d48806' },
  copper: { label: 'Copper', color: '#8c6d3f' },
  wan: { label: 'WAN / leased line', color: '#722ed1' },
  other: { label: 'Other', color: '#8c96a3' },
};

export interface DatacenterSiteSummary {
  id: string;
  name: string;
  role: DcSiteRole;
  building_id: string;
  building_name: string;
  building_code: string;
  room: string | null;
  position: number;
  rack_count: number;
  device_count: number;
}

export interface DatacenterSummary {
  id: string;
  plant_id: string;
  plant_code: string;
  plant_name: string;
  name: string;
  kind: DatacenterKind;
  description: string | null;
  created_at: string;
  updated_at: string;
  sites: DatacenterSiteSummary[];
  link_count: number;
}

export interface DcDevice {
  id: string;
  name: string;
  type: AssetType;
  status: AssetStatus;
  model: string | null;
  ip_address: string | null;
  rack_u: number | null;
  rack_height_u: number;
  cluster: string | null;
  role: string | null;
}

export interface DcRack {
  /** null for the pseudo group "not in a rack" */
  id: string | null;
  name: string;
  height_u: number | null;
  used_u: number | null;
  devices: DcDevice[];
}

export interface DatacenterSiteDetail extends DatacenterSiteSummary {
  racks: DcRack[];
}

export interface DatacenterLink {
  id: string;
  datacenter_id: string;
  site_a_id: string;
  site_b_id: string;
  kind: DcLinkKind;
  label: string;
  capacity: string | null;
  length_m: number | null;
  note: string | null;
}

export interface DatacenterConnection {
  id: string;
  relation: RelationType;
  source_id: string;
  target_id: string;
  source_port: string | null;
  target_port: string | null;
  source_site_id: string;
  target_site_id: string;
}

export interface DatacenterCluster {
  name: string;
  stretched: boolean;
  /** site id → device ids */
  sites: Record<string, string[]>;
}

export interface DatacenterDetail extends Omit<DatacenterSummary, 'sites'> {
  sites: DatacenterSiteDetail[];
  links: DatacenterLink[];
  connections: DatacenterConnection[];
  clusters: DatacenterCluster[];
}

export interface DatacenterSiteInput {
  id?: string | null;
  /** optional – "Server room", "Site A", "Site B" or "Witness" by default */
  name?: string | null;
  role: DcSiteRole;
  /** an existing building … */
  building_id?: string | null;
  /** … or the name of a new building, created together with the data center */
  new_building_name?: string | null;
  room?: string | null;
}

export interface DatacenterInput {
  plant_id: string;
  /** optional – "<plant code> data center" by default */
  name?: string | null;
  kind: DatacenterKind;
  description?: string | null;
  sites: DatacenterSiteInput[];
}

export interface DatacenterLinkInput {
  site_a_id: string;
  site_b_id: string;
  kind: DcLinkKind;
  label: string;
  capacity?: string | null;
  length_m?: number | null;
  note?: string | null;
}

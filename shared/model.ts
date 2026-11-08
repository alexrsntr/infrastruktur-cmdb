// Shared domain model used by both the API server and the web client.
// Keep this file free of runtime dependencies.

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

export const ROLES = ['admin', 'editor', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_META: Record<Role, { label: string; description: string; entraAppRole: string; color: string }> = {
  admin: {
    label: 'Administrator',
    description: 'Full access including user management, deletion of locations and the global audit log.',
    entraAppRole: 'CMDB.Admin',
    color: 'red',
  },
  editor: {
    label: 'Editor',
    description: 'Create, change and delete infrastructure, buildings, floors and floor plans. Import data.',
    entraAppRole: 'CMDB.Editor',
    color: 'blue',
  },
  operator: {
    label: 'Operator',
    description: 'Read access plus notes, activities and asset status changes (e.g. on-site technicians).',
    entraAppRole: 'CMDB.Operator',
    color: 'green',
  },
  viewer: {
    label: 'Viewer',
    description: 'Read-only access and exports.',
    entraAppRole: 'CMDB.Viewer',
    color: 'default',
  },
};

export const PERMISSIONS = [
  'read',
  'export',
  'note.write',
  'activity.write',
  'asset.status',
  'asset.write',
  'asset.delete',
  'location.write',
  'location.delete',
  'import',
  'audit.read',
  'user.manage',
  'settings.manage',
  'attachment.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = ['read', 'export'];
const OPERATOR: Permission[] = [...VIEWER, 'note.write', 'activity.write', 'asset.status', 'attachment.write'];
const EDITOR: Permission[] = [...OPERATOR, 'asset.write', 'asset.delete', 'location.write', 'import'];
const ADMIN: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ADMIN,
  editor: EDITOR,
  operator: OPERATOR,
  viewer: VIEWER,
};

export function can(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function roleFromEntraAppRoles(appRoles: string[] | undefined): Role | null {
  if (!appRoles?.length) return null;
  // Highest privilege wins
  for (const role of ROLES) {
    if (appRoles.includes(ROLE_META[role].entraAppRole)) return role;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Asset types (CI classes)
// ---------------------------------------------------------------------------

export type FieldType = 'text' | 'number' | 'boolean' | 'select' | 'date';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  unit?: string;
  placeholder?: string;
}

export interface AssetTypeDef {
  label: string;
  plural: string;
  slug: string; // URL segment
  /** Whether the asset is physical (has a location / can be placed on a floor plan) */
  physical: boolean;
  color: string;
  fields: FieldDef[];
}

export const ASSET_TYPES = {
  switch: {
    label: 'Switch',
    plural: 'Switches',
    slug: 'switches',
    physical: true,
    color: '#1677ff',
    fields: [
      { key: 'port_count', label: 'Ports', type: 'number' },
      { key: 'uplink_ports', label: 'Uplink ports', type: 'text', placeholder: 'e.g. 4x SFP+ 10G' },
      { key: 'poe', label: 'PoE', type: 'boolean' },
      { key: 'layer', label: 'Layer', type: 'select', options: ['L2', 'L3'] },
      { key: 'role', label: 'Network role', type: 'select', options: ['Core', 'Distribution', 'Access', 'Industrial / OT'] },
      { key: 'stack', label: 'Stack / chassis', type: 'text' },
      { key: 'mgmt_vlan', label: 'Mgmt VLAN', type: 'number' },
      { key: 'firmware', label: 'Firmware', type: 'text' },
    ],
  },
  access_point: {
    label: 'Access Point',
    plural: 'Access Points',
    slug: 'access-points',
    physical: true,
    color: '#13a8a8',
    fields: [
      { key: 'controller', label: 'Controller / cloud', type: 'text' },
      { key: 'ssids', label: 'SSIDs', type: 'text' },
      { key: 'wifi_standard', label: 'Wi-Fi standard', type: 'select', options: ['Wi-Fi 5 (ac)', 'Wi-Fi 6 (ax)', 'Wi-Fi 6E', 'Wi-Fi 7 (be)'] },
      { key: 'mounting', label: 'Mounting', type: 'select', options: ['Ceiling', 'Wall', 'Outdoor', 'Hall / high-bay'] },
      { key: 'channel', label: 'Channel', type: 'text' },
      { key: 'poe_class', label: 'PoE class', type: 'text' },
      { key: 'firmware', label: 'Firmware', type: 'text' },
    ],
  },
  server: {
    label: 'Server',
    plural: 'Servers',
    slug: 'servers',
    physical: true,
    color: '#722ed1',
    fields: [
      { key: 'form_factor', label: 'Form factor', type: 'select', options: ['Rack', 'Tower', 'Blade', 'Edge / Industrial PC'] },
      { key: 'cpu', label: 'CPU', type: 'text' },
      { key: 'cores', label: 'Cores', type: 'number' },
      { key: 'ram_gb', label: 'RAM', type: 'number', unit: 'GB' },
      { key: 'storage_tb', label: 'Storage', type: 'number', unit: 'TB' },
      { key: 'hypervisor', label: 'Hypervisor', type: 'select', options: ['None', 'VMware ESXi', 'Hyper-V', 'Proxmox', 'Nutanix AHV', 'Other'] },
      { key: 'cluster', label: 'Cluster', type: 'text' },
      { key: 'oob_ip', label: 'iDRAC / iLO IP', type: 'text' },
    ],
  },
  ups: {
    label: 'UPS',
    plural: 'UPS',
    slug: 'ups',
    physical: true,
    color: '#c41d7f',
    fields: [
      // the first six fields are offered when adding a device
      { key: 'form_factor', label: 'Form factor', type: 'select', options: ['Rack', 'Tower', 'Wall / DIN rail'] },
      { key: 'capacity_va', label: 'Capacity', type: 'number', unit: 'VA' },
      { key: 'capacity_w', label: 'Real power', type: 'number', unit: 'W' },
      { key: 'battery_replace_due', label: 'Battery replacement due', type: 'date' },
      { key: 'runtime_min', label: 'Runtime at current load', type: 'number', unit: 'min' },
      { key: 'phases', label: 'Phases', type: 'select', options: ['1-phase', '3-phase'] },
      { key: 'topology', label: 'Topology', type: 'select', options: ['Online (double conversion)', 'Line-interactive', 'Offline / standby'] },
      { key: 'battery_type', label: 'Battery type', type: 'text', placeholder: 'e.g. VRLA, Li-ion' },
      { key: 'battery_installed', label: 'Batteries installed', type: 'date' },
      { key: 'outlets', label: 'Outlets', type: 'text', placeholder: 'e.g. 6x C13, 2x C19' },
      { key: 'network_card', label: 'Network management card', type: 'text', placeholder: 'e.g. NMC 3, SNMP v3' },
      { key: 'firmware', label: 'Firmware', type: 'text' },
    ],
  },
  vm: {
    label: 'Virtual Machine',
    plural: 'Virtual Machines',
    slug: 'vms',
    physical: false,
    color: '#fa8c16',
    fields: [
      { key: 'vcpu', label: 'vCPU', type: 'number' },
      { key: 'ram_gb', label: 'RAM', type: 'number', unit: 'GB' },
      { key: 'disk_gb', label: 'Disk', type: 'number', unit: 'GB' },
      { key: 'cluster', label: 'Cluster / host group', type: 'text' },
      { key: 'environment', label: 'Environment', type: 'select', options: ['Production', 'Test', 'Development', 'Disaster recovery'] },
      { key: 'application', label: 'Application / service', type: 'text' },
      { key: 'backup', label: 'Backup enabled', type: 'boolean' },
    ],
  },
} as const satisfies Record<string, AssetTypeDef>;

export type AssetType = keyof typeof ASSET_TYPES;
export const ASSET_TYPE_KEYS = Object.keys(ASSET_TYPES) as AssetType[];

export function assetTypeBySlug(slug: string | undefined): AssetType | undefined {
  return ASSET_TYPE_KEYS.find((k) => ASSET_TYPES[k].slug === slug);
}

/** Type name inside a sentence: "switch", "access point" – acronyms such as "UPS" stay upper case. */
export function assetTypeNoun(type: AssetType): string {
  const { label } = ASSET_TYPES[type];
  return label === label.toUpperCase() ? label : label.toLowerCase();
}

export function assetTypeFields(type: AssetType): readonly FieldDef[] {
  return ASSET_TYPES[type].fields;
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const ASSET_STATUSES = ['planned', 'active', 'maintenance', 'defective', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_STATUS_META: Record<AssetStatus, { label: string; color: string }> = {
  planned: { label: 'Planned', color: 'default' },
  active: { label: 'Active', color: 'success' },
  maintenance: { label: 'Maintenance', color: 'warning' },
  defective: { label: 'Defective', color: 'error' },
  retired: { label: 'Retired', color: 'default' },
};

export const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Criticality = (typeof CRITICALITIES)[number];
export const CRITICALITY_META: Record<Criticality, { label: string; color: string }> = {
  low: { label: 'Low', color: 'default' },
  medium: { label: 'Medium', color: 'blue' },
  high: { label: 'High', color: 'orange' },
  critical: { label: 'Critical', color: 'red' },
};

export const RELATION_TYPES = {
  uplink: { label: 'Uplink to', inverse: 'Downlink from' },
  runs_on: { label: 'Runs on', inverse: 'Hosts' },
  connected_to: { label: 'Connected to', inverse: 'Connected to' },
  depends_on: { label: 'Depends on', inverse: 'Required by' },
  redundant_with: { label: 'Redundant with', inverse: 'Redundant with' },
  powered_by: { label: 'Powered by', inverse: 'Powers' },
} as const;
export type RelationType = keyof typeof RELATION_TYPES;
export const RELATION_TYPE_KEYS = Object.keys(RELATION_TYPES) as RelationType[];

export const ACTIVITY_KINDS = ['maintenance', 'incident', 'change', 'installation', 'inspection', 'replacement', 'other'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_KIND_META: Record<ActivityKind, { label: string; color: string }> = {
  maintenance: { label: 'Maintenance', color: 'gold' },
  incident: { label: 'Incident', color: 'red' },
  change: { label: 'Change', color: 'blue' },
  installation: { label: 'Installation', color: 'green' },
  inspection: { label: 'Inspection', color: 'cyan' },
  replacement: { label: 'Replacement', color: 'purple' },
  other: { label: 'Other', color: 'default' },
};

export const ACTIVITY_STATUSES = ['planned', 'open', 'in_progress', 'done', 'cancelled'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export const ACTIVITY_STATUS_META: Record<ActivityStatus, { label: string; color: string }> = {
  planned: { label: 'Planned', color: 'default' },
  open: { label: 'Open', color: 'blue' },
  in_progress: { label: 'In progress', color: 'processing' },
  done: { label: 'Done', color: 'success' },
  cancelled: { label: 'Cancelled', color: 'default' },
};

export const ENTITY_TYPES = ['plant', 'building', 'floor', 'rack', 'asset'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------

export interface CurrentUser {
  id: string;
  displayName: string;
  email: string | null;
  role: Role;
  roleSource: 'entra' | 'local';
  plantScope: string[]; // empty = all plants
}

export interface AppConfig {
  brandName: string;
  appName: string;
  primaryColor: string;
  mapTileUrl: string;
  mapTileAttribution: string;
  authMode: 'entra' | 'local' | 'dev';
}

export interface MeResponse {
  user: CurrentUser;
  permissions: Permission[];
  csrfToken: string;
  config: AppConfig;
}

export interface Plant {
  id: string;
  code: string;
  name: string;
  country: string | null;
  city: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  contact: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  building_count?: number;
  asset_count?: number;
  asset_counts?: Partial<Record<AssetType, number>>;
}

export interface Building {
  id: string;
  plant_id: string;
  plant_name?: string;
  plant_code?: string;
  code: string;
  name: string;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  updated_at: string;
  floor_count?: number;
  asset_count?: number;
  floors?: Floor[];
}

export interface Floor {
  id: string;
  building_id: string;
  name: string;
  level: number;
  has_plan: boolean;
  plan_width: number | null;
  plan_height: number | null;
  plan_updated_at: string | null;
  asset_count?: number;
}

export interface Asset {
  id: string;
  type: AssetType;
  name: string;
  status: AssetStatus;
  criticality: Criticality;
  plant_id: string | null;
  building_id: string | null;
  floor_id: string | null;
  plant_name?: string | null;
  plant_code?: string | null;
  building_name?: string | null;
  building_code?: string | null;
  floor_name?: string | null;
  room: string | null;
  rack_id: string | null;
  rack_name?: string | null;
  /** Lowest occupied height unit (U) */
  rack_u: number | null;
  rack_height_u: number;
  map_x: number | null;
  map_y: number | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  ip_address: string | null;
  mac_address: string | null;
  fqdn: string | null;
  os: string | null;
  owner: string | null;
  cost_center: string | null;
  purchase_date: string | null;
  warranty_end: string | null;
  description: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by_name?: string | null;
  updated_by_name?: string | null;
  last_activity_at?: string | null;
  last_activity_by?: string | null;
  last_activity?: string | null;
}

export interface AssetRelation {
  id: string;
  relation: RelationType;
  direction: 'out' | 'in';
  other_id: string;
  other_name: string;
  other_type: AssetType;
  other_status: AssetStatus;
  local_port: string | null;
  remote_port: string | null;
  note: string | null;
}

export interface AssetDetail extends Asset {
  relations: AssetRelation[];
}

export interface Note {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  entity_label?: string | null;
  plant_id: string | null;
  body: string;
  pinned: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Activity {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  entity_label?: string | null;
  plant_id: string | null;
  plant_name?: string | null;
  kind: ActivityKind;
  status: ActivityStatus;
  title: string;
  description: string | null;
  assignee: string | null;
  due_date: string | null;
  completed_at: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_label: string | null;
  changes: Record<string, unknown> | null;
  ip: string | null;
}

export interface AppUser {
  id: string;
  oid: string | null;
  email: string | null;
  display_name: string;
  role: Role;
  role_source: 'entra' | 'local';
  plant_scope: string[];
  active: boolean;
  last_login_at: string | null;
  created_at: string;
  /** Local account with a password (AUTH_MODE=local) */
  has_password: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface SearchResult {
  kind: 'plant' | 'building' | 'asset';
  id: string;
  title: string;
  subtitle: string | null;
  assetType?: AssetType;
}

export interface DashboardData {
  totals: { plants: number; buildings: number; assets: number; openActivities: number };
  byType: { type: AssetType; count: number }[];
  byStatus: { status: AssetStatus; count: number }[];
  byPlant: { plant_id: string; plant_name: string; plant_code: string; count: number }[];
  warrantyExpiring: Pick<Asset, 'id' | 'name' | 'type' | 'warranty_end' | 'plant_name'>[];
  upcomingActivities: Activity[];
  recentChanges: AuditEntry[];
}

export interface ImportReport {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
}

// ---------------------------------------------------------------------------
// Racks
// ---------------------------------------------------------------------------

export const RACK_ITEM_KINDS = ['patch_panel', 'cable_management', 'ups', 'pdu', 'shelf', 'blank', 'other'] as const;
export type RackItemKind = (typeof RACK_ITEM_KINDS)[number];
export const RACK_ITEM_KIND_META: Record<RackItemKind, { label: string }> = {
  patch_panel: { label: 'Patch panel' },
  cable_management: { label: 'Cable management' },
  ups: { label: 'UPS' },
  pdu: { label: 'PDU' },
  shelf: { label: 'Shelf' },
  blank: { label: 'Blank panel' },
  other: { label: 'Other' },
};

export interface Rack {
  id: string;
  building_id: string;
  building_name?: string;
  building_code?: string;
  plant_id?: string;
  plant_code?: string;
  plant_name?: string;
  floor_id: string | null;
  floor_name?: string | null;
  name: string;
  room: string | null;
  height_u: number;
  numbering: 'bottom_up' | 'top_down';
  manufacturer: string | null;
  model: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  used_u?: number;
  asset_count?: number;
}

export interface RackItem {
  id: string;
  rack_id: string;
  kind: RackItemKind;
  label: string;
  position_u: number;
  height_u: number;
  note: string | null;
}

export type RackAsset = Pick<
  Asset,
  'id' | 'name' | 'type' | 'status' | 'criticality' | 'rack_u' | 'rack_height_u' | 'manufacturer' | 'model' | 'ip_address' | 'serial_number'
>;

export interface RackDetail extends Rack {
  assets: RackAsset[];
  items: RackItem[];
}

/** "12" or "40-41" */
export function formatRackUnits(u: number | null | undefined, height = 1): string {
  if (!u) return '';
  return height > 1 ? `${u}-${u + height - 1}` : String(u);
}

// ---------------------------------------------------------------------------
// Activity log (timeline)
// ---------------------------------------------------------------------------

export type TimelineKind = 'note' | 'activity' | 'change' | 'file' | 'placement';

export interface TimelineItem {
  kind: TimelineKind;
  id: string;
  at: string;
  user_id: string | null;
  user_name: string | null;
  action: string | null;
  title: string | null;
  body: string | null;
  activity_kind: ActivityKind | null;
  activity_status: ActivityStatus | null;
  due_date: string | null;
  pinned: boolean;
  changes: Record<string, unknown> | null;
  /** global feed only */
  entity_type?: string | null;
  entity_id?: string | null;
  entity_label?: string | null;
}

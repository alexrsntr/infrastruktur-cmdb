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

export const ASSET_CATEGORIES = {
  network: { label: 'Network' },
  compute: { label: 'Compute & storage' },
  power: { label: 'Power' },
  ot: { label: 'Production (OT)' },
  endpoint: { label: 'Endpoints' },
  other: { label: 'Other' },
} as const;
export type AssetCategory = keyof typeof ASSET_CATEGORIES;

export interface AssetTypeDef {
  label: string;
  plural: string;
  slug: string; // URL segment
  /** Short label for map markers ("SW", "AP" …) */
  short: string;
  category: AssetCategory;
  /** One line shown when choosing the type in the "Add device" wizard */
  hint: string;
  /** Example host name (placeholder in forms) */
  example: string;
  /** Whether the asset is physical (has a location / can be placed on a floor plan / mounted in a rack) */
  physical: boolean;
  /** Typical height in a rack (U) */
  rackHeight: number;
  color: string;
  fields: FieldDef[];
}

export const ASSET_TYPES = {
  switch: {
    label: 'Switch',
    plural: 'Switches',
    slug: 'switches',
    short: 'SW',
    category: 'network',
    hint: 'Network switch in a rack or cabinet',
    example: 'muc-b01-sw03',
    rackHeight: 1,
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
  router: {
    label: 'Router',
    plural: 'Routers',
    slug: 'routers',
    short: 'RT',
    category: 'network',
    hint: 'WAN / internet router or layer-3 gateway',
    example: 'muc-rt01',
    physical: true,
    rackHeight: 1,
    color: '#2f54eb',
    fields: [
      { key: 'router_role', label: 'Router role', type: 'select', options: ['WAN edge', 'Internet', 'Core', 'Branch', 'Industrial / cellular'] },
      { key: 'wan_links', label: 'WAN links', type: 'text', placeholder: 'e.g. MPLS 100M, Internet 1G' },
      { key: 'carrier', label: 'Carrier / circuit ID', type: 'text' },
      { key: 'routing', label: 'Routing protocols', type: 'text', placeholder: 'e.g. BGP, OSPF' },
      { key: 'interfaces', label: 'Interfaces', type: 'text' },
      { key: 'firmware', label: 'Firmware', type: 'text' },
    ],
  },
  firewall: {
    label: 'Firewall',
    plural: 'Firewalls',
    slug: 'firewalls',
    short: 'FW',
    category: 'network',
    hint: 'Firewall or security gateway, e.g. between office and production network',
    example: 'muc-fw01',
    physical: true,
    rackHeight: 1,
    color: '#cf1322',
    fields: [
      { key: 'ha_mode', label: 'High availability', type: 'select', options: ['Standalone', 'Active / passive', 'Active / active', 'Cluster'] },
      { key: 'ha_peer', label: 'HA peer', type: 'text' },
      { key: 'throughput_gbps', label: 'Throughput', type: 'number', unit: 'Gbit/s' },
      { key: 'zones', label: 'Zones / segments', type: 'text', placeholder: 'e.g. Office, OT, DMZ' },
      { key: 'vpn', label: 'VPN termination', type: 'boolean' },
      { key: 'firmware', label: 'Firmware', type: 'text' },
      { key: 'management', label: 'Central management', type: 'text', placeholder: 'e.g. FortiManager, Panorama' },
      { key: 'license_end', label: 'Security license until', type: 'date' },
    ],
  },
  access_point: {
    label: 'Access Point',
    plural: 'Access Points',
    slug: 'access-points',
    short: 'AP',
    category: 'network',
    hint: 'Wi-Fi access point on a ceiling or wall',
    example: 'muc-ap-042',
    rackHeight: 1,
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
  wlan_controller: {
    label: 'WLAN Controller',
    plural: 'WLAN Controllers',
    slug: 'wlan-controllers',
    short: 'WLC',
    category: 'network',
    hint: 'Controller or gateway that manages the access points',
    example: 'muc-wlc01',
    physical: true,
    rackHeight: 1,
    color: '#08979c',
    fields: [
      { key: 'deployment', label: 'Deployment', type: 'select', options: ['Appliance', 'Virtual', 'Cloud'] },
      { key: 'licensed_aps', label: 'Licensed APs', type: 'number' },
      { key: 'max_aps', label: 'Max. APs', type: 'number' },
      { key: 'ha_peer', label: 'HA peer', type: 'text' },
      { key: 'ssids', label: 'SSIDs', type: 'text' },
      { key: 'firmware', label: 'Firmware', type: 'text' },
    ],
  },
  server: {
    label: 'Server',
    plural: 'Servers',
    slug: 'servers',
    short: 'SRV',
    category: 'compute',
    hint: 'Physical server or hypervisor host',
    example: 'muc-srv-backup01',
    rackHeight: 2,
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
  storage: {
    label: 'Storage',
    plural: 'Storage',
    slug: 'storage',
    short: 'STO',
    category: 'compute',
    hint: 'SAN, NAS, backup appliance or tape library',
    example: 'muc-nas01',
    physical: true,
    rackHeight: 2,
    color: '#531dab',
    fields: [
      { key: 'kind', label: 'Kind', type: 'select', options: ['SAN', 'NAS', 'Hyper-converged', 'Backup appliance', 'Tape library'] },
      { key: 'raw_tb', label: 'Raw capacity', type: 'number', unit: 'TB' },
      { key: 'usable_tb', label: 'Usable capacity', type: 'number', unit: 'TB' },
      { key: 'protocols', label: 'Protocols', type: 'text', placeholder: 'e.g. iSCSI, NFS, SMB, FC' },
      { key: 'raid', label: 'RAID / protection', type: 'text' },
      { key: 'controllers', label: 'Controllers', type: 'number' },
      { key: 'firmware', label: 'Firmware', type: 'text' },
    ],
  },
  vm: {
    label: 'Virtual Machine',
    plural: 'Virtual Machines',
    slug: 'vms',
    short: 'VM',
    category: 'compute',
    hint: 'Virtual machine on a host or cluster',
    example: 'muc-app10',
    rackHeight: 1,
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
  ups: {
    label: 'UPS',
    plural: 'UPS',
    slug: 'ups',
    short: 'UPS',
    category: 'power',
    hint: 'Emergency power (UPS) in a rack or room',
    example: 'muc-ups02',
    rackHeight: 2,
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
  pdu: {
    label: 'PDU',
    plural: 'PDUs',
    slug: 'pdus',
    short: 'PDU',
    category: 'power',
    hint: 'Power distribution unit in a rack (basic, metered or switched)',
    example: 'muc-pdu-r01a',
    physical: true,
    rackHeight: 1,
    color: '#d4380d',
    fields: [
      { key: 'kind', label: 'Kind', type: 'select', options: ['Basic', 'Metered', 'Switched', 'Metered + switched', 'Transfer switch (ATS)'] },
      { key: 'phases', label: 'Phases', type: 'select', options: ['1-phase', '3-phase'] },
      { key: 'max_current_a', label: 'Max. current', type: 'number', unit: 'A' },
      { key: 'input_plug', label: 'Input plug', type: 'text', placeholder: 'e.g. CEE 32 A 5-pin' },
      { key: 'outlets', label: 'Outlets', type: 'text', placeholder: 'e.g. 20x C13, 4x C19' },
      { key: 'feed', label: 'Power feed', type: 'select', options: ['A', 'B', 'A + B'] },
      { key: 'firmware', label: 'Firmware', type: 'text' },
    ],
  },
  ot_device: {
    label: 'OT Device',
    plural: 'OT Devices',
    slug: 'ot-devices',
    short: 'OT',
    category: 'ot',
    hint: 'PLC, industrial PC, HMI panel or other machine controller',
    example: 'muc-l3-plc01',
    physical: true,
    rackHeight: 1,
    color: '#7c6f00',
    fields: [
      { key: 'kind', label: 'Kind', type: 'select', options: ['PLC', 'Industrial PC', 'HMI / panel', 'Drive / inverter', 'Robot controller', 'Remote I/O / gateway', 'Other'] },
      { key: 'machine', label: 'Machine / line', type: 'text', placeholder: 'e.g. Press line 3' },
      { key: 'fieldbus', label: 'Fieldbus / protocol', type: 'select', options: ['PROFINET', 'EtherNet/IP', 'Modbus TCP', 'EtherCAT', 'OPC UA', 'PROFIBUS', 'Other'] },
      { key: 'program_version', label: 'Program version', type: 'text' },
      { key: 'firmware', label: 'Firmware', type: 'text' },
      { key: 'maintainer', label: 'Maintained by', type: 'text', placeholder: 'e.g. machine builder, plant engineering' },
      { key: 'remote_access', label: 'Remote access', type: 'text', placeholder: 'e.g. vendor VPN box' },
    ],
  },
  printer: {
    label: 'Printer',
    plural: 'Printers',
    slug: 'printers',
    short: 'PRN',
    category: 'endpoint',
    hint: 'Office, label or multifunction printer',
    example: 'muc-prn-b01-01',
    physical: true,
    rackHeight: 1,
    color: '#5b8c00',
    fields: [
      { key: 'kind', label: 'Kind', type: 'select', options: ['Laser', 'Inkjet', 'Multifunction', 'Label printer', 'Plotter'] },
      { key: 'color', label: 'Colour', type: 'boolean' },
      { key: 'queue', label: 'Print queue', type: 'text', placeholder: 'e.g. \\\\printsrv\\B01-OG1' },
      { key: 'print_server', label: 'Print server', type: 'text' },
      { key: 'firmware', label: 'Firmware', type: 'text' },
    ],
  },
  camera: {
    label: 'Camera',
    plural: 'Cameras',
    slug: 'cameras',
    short: 'CAM',
    category: 'endpoint',
    hint: 'IP / security camera or industrial vision camera',
    example: 'muc-cam-gate01',
    physical: true,
    rackHeight: 1,
    color: '#ad6800',
    fields: [
      { key: 'kind', label: 'Kind', type: 'select', options: ['Fixed / bullet', 'Dome', 'PTZ', 'Thermal', 'Machine vision'] },
      { key: 'resolution', label: 'Resolution', type: 'text', placeholder: 'e.g. 4 MP' },
      { key: 'recorder', label: 'Recorder / VMS', type: 'text' },
      { key: 'retention_days', label: 'Retention', type: 'number', unit: 'days' },
      { key: 'poe', label: 'PoE', type: 'boolean' },
      { key: 'firmware', label: 'Firmware', type: 'text' },
    ],
  },
  other: {
    label: 'Other Device',
    plural: 'Other Devices',
    slug: 'other',
    short: 'DEV',
    category: 'other',
    hint: 'Anything else with a network connection or a place in a rack',
    example: 'muc-dev01',
    physical: true,
    rackHeight: 1,
    color: '#595959',
    fields: [
      { key: 'kind', label: 'Kind', type: 'text', placeholder: 'e.g. Time server, KVM switch, media converter' },
      { key: 'firmware', label: 'Firmware', type: 'text' },
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

/** Built-in fields of a type plus the fields an administrator added (settings "Device types"). */
export function assetTypeFields(type: AssetType, settings?: AssetTypeSettings | null): readonly FieldDef[] {
  const custom = settings?.customFields?.[type] ?? [];
  return custom.length ? [...ASSET_TYPES[type].fields, ...custom] : ASSET_TYPES[type].fields;
}

/** Administrator settings for device types (app_setting "asset_types") */
export interface AssetTypeSettings {
  /** Types not offered when adding devices (existing devices stay visible) */
  hidden: AssetType[];
  /** Additional fields per type; values are stored in asset.attributes */
  customFields: Partial<Record<AssetType, FieldDef[]>>;
}

export const EMPTY_ASSET_TYPE_SETTINGS: AssetTypeSettings = { hidden: [], customFields: {} };

/** Key for an administrator-defined field: "custom_" + label in snake case */
export function customFieldKey(label: string): string {
  const base = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `custom_${base || 'field'}`;
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
  roleSource: RoleSource;
  plantScope: string[]; // empty = all plants
}

/** Where a user's role comes from: Entra app role (token), Entra group mapping or set in the CMDB */
export type RoleSource = 'entra' | 'group' | 'local';

export interface AppConfig {
  brandName: string;
  appName: string;
  primaryColor: string;
  mapTileUrl: string;
  mapTileAttribution: string;
  authMode: 'entra' | 'local' | 'dev';
  /** "Sign in with Microsoft" is offered */
  entraLogin: boolean;
  /** Password sign-in: all users, administrators only, off; none = not available (AUTH_MODE entra/dev) */
  localLogin: 'all' | 'admins' | 'off' | 'none';
}

export interface MeResponse {
  user: CurrentUser;
  permissions: Permission[];
  csrfToken: string;
  config: AppConfig;
  /** signed in with the CMDB password (not with Microsoft) and allowed to use it – shows "Change password" */
  canChangePassword: boolean;
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
  /** End of vendor support (security updates) */
  support_end: string | null;
  /** End of life: the device should be replaced by then */
  end_of_life: string | null;
  /** Support / maintenance contract (number, vendor, level) */
  support_contract: string | null;
  /** Last time the device was seen on the network (discovery, monitoring, API) */
  last_seen_at: string | null;
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
  role_source: RoleSource;
  /** e.g. the Entra group(s) a role comes from */
  role_detail: string | null;
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

// ---------------------------------------------------------------------------
// Needs attention (lifecycle)
// ---------------------------------------------------------------------------

/** Look-ahead windows for "Needs attention" (days) */
export const ATTENTION_DAYS = { warranty: 90, support: 180, eol: 365, notSeen: 30 } as const;

export const ATTENTION_KINDS = ['warranty_expiring', 'warranty_expired', 'support_ending', 'support_ended', 'eol', 'not_seen'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export const ATTENTION_META: Record<AttentionKind, { label: string; description: string; color: string }> = {
  warranty_expiring: { label: 'Warranty ends soon', description: `Warranty ends within ${ATTENTION_DAYS.warranty} days`, color: 'orange' },
  warranty_expired: { label: 'Warranty expired', description: 'Warranty has ended', color: 'red' },
  support_ending: { label: 'Support ends soon', description: `Vendor support ends within ${ATTENTION_DAYS.support} days`, color: 'orange' },
  support_ended: { label: 'Out of support', description: 'Vendor support has ended – no more security updates', color: 'red' },
  eol: { label: 'End of life', description: `End of life reached or within ${ATTENTION_DAYS.eol} days – plan the replacement`, color: 'volcano' },
  not_seen: { label: 'Not seen lately', description: `Not seen on the network for more than ${ATTENTION_DAYS.notSeen} days`, color: 'purple' },
};

export interface AttentionItem extends Pick<Asset, 'id' | 'name' | 'type' | 'status' | 'criticality' | 'plant_code' | 'warranty_end' | 'support_end' | 'end_of_life' | 'last_seen_at'> {
  kinds: AttentionKind[];
  /** Most urgent date of the reasons (for sorting) */
  due: string | null;
}

export interface AttentionData {
  counts: Record<AttentionKind, number>;
  /** Devices with at least one reason, most urgent first */
  total: number;
  items: AttentionItem[];
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

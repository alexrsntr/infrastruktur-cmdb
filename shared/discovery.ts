// Auto-discovery: SNMP sweeps and Active Directory. Shared by API and web client.

import type { AssetType } from './model';

export const DISCOVERY_KINDS = ['snmp', 'ad'] as const;
export type DiscoveryKind = (typeof DISCOVERY_KINDS)[number];
export const DISCOVERY_KIND_META: Record<DiscoveryKind, { label: string; description: string }> = {
  snmp: { label: 'SNMP network scan', description: 'Switches, routers, firewalls, WLAN controllers, UPS … with serial number, model, firmware, ports and LLDP neighbours' },
  ad: { label: 'Active Directory', description: 'Computer objects (by default only servers) with operating system and last logon' },
};

export const SNMP_AUTH_PROTOCOLS = ['md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512'] as const;
export const SNMP_PRIV_PROTOCOLS = ['des', 'aes', 'aes256b', 'aes256r'] as const;
export const SNMP_LEVELS = ['noAuthNoPriv', 'authNoPriv', 'authPriv'] as const;

export interface SnmpConfig {
  /** "10.10.0.0/24, 10.10.1.5, 10.10.2.10-10.10.2.20" */
  targets: string;
  version: '2c' | '3';
  port: number;
  timeoutMs: number;
  retries: number;
  /** SNMPv3 */
  user?: string;
  level?: (typeof SNMP_LEVELS)[number];
  authProtocol?: (typeof SNMP_AUTH_PROTOCOLS)[number];
  privProtocol?: (typeof SNMP_PRIV_PROTOCOLS)[number];
}

export interface AdConfig {
  /** ldaps://dc01.example.local:636 */
  url: string;
  baseDn: string;
  bindDn: string;
  /** Only computers with a server operating system */
  serversOnly: boolean;
  /** Accept self-signed / internal CA certificates without checking (not recommended) */
  tlsInsecure: boolean;
}

/** Stored encrypted; the API only says whether a value is set */
export interface DiscoverySecrets {
  community?: string;
  authKey?: string;
  privKey?: string;
  bindPassword?: string;
}

export interface DiscoverySource {
  id: string;
  name: string;
  kind: DiscoveryKind;
  enabled: boolean;
  /** Plant for devices created from this source (can be changed per device) */
  plant_id: string | null;
  plant_code?: string | null;
  /** 0 = only manually */
  schedule_hours: number;
  config: SnmpConfig | AdConfig;
  /** which secrets are stored */
  secrets_set: (keyof DiscoverySecrets)[];
  last_run_at: string | null;
  last_status: string | null;
  new_items: number;
  created_at: string;
}

export interface DiscoveryRun {
  id: string;
  source_id: string;
  source_name?: string;
  trigger: 'manual' | 'schedule';
  status: 'running' | 'ok' | 'error';
  started_at: string;
  finished_at: string | null;
  scanned: number;
  found: number;
  new_items: number;
  updated_assets: number;
  error: string | null;
}

export interface DiscoveredPort {
  name: string;
  description?: string | null;
  mac?: string | null;
  speed?: string | null;
}

export interface DiscoveredNeighbor {
  local_port: string | null;
  remote_name: string | null;
  remote_port: string | null;
  remote_chassis: string | null;
}

/** What a source found about one device */
export interface DiscoveredData {
  name: string | null;
  fqdn?: string | null;
  ip?: string | null;
  mac?: string | null;
  serial?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  firmware?: string | null;
  os?: string | null;
  description?: string | null;
  location?: string | null;
  type: AssetType;
  sys_object_id?: string | null;
  ports?: DiscoveredPort[];
  neighbors?: DiscoveredNeighbor[];
  /** AD: last logon (ISO) */
  last_logon?: string | null;
}

export const DISCOVERY_STATES = ['new', 'linked', 'ignored'] as const;
export type DiscoveryState = (typeof DISCOVERY_STATES)[number];

export interface DiscoveryItem {
  id: string;
  source_id: string;
  source_name: string;
  source_kind: DiscoveryKind;
  plant_id: string | null;
  key: string;
  state: DiscoveryState;
  asset_id: string | null;
  asset_name: string | null;
  /** how the device was matched: serial, mac, name, ip */
  matched_by: string | null;
  data: DiscoveredData;
  first_seen: string;
  last_seen: string;
}

/** IANA enterprise numbers (sysObjectID 1.3.6.1.4.1.<n>) of common vendors */
export const SNMP_VENDORS: Record<number, string> = {
  9: 'Cisco',
  11: 'HPE',
  171: 'D-Link',
  232: 'HPE',
  311: 'Microsoft',
  318: 'APC',
  534: 'Eaton',
  674: 'Dell',
  1916: 'Extreme Networks',
  1991: 'Extreme Networks',
  2011: 'Huawei',
  2636: 'Juniper',
  4329: 'Siemens',
  4526: 'Netgear',
  6486: 'Alcatel-Lucent',
  6876: 'VMware',
  8072: 'Net-SNMP',
  11863: 'TP-Link',
  12356: 'Fortinet',
  14179: 'Cisco (WLC)',
  14823: 'Aruba',
  14988: 'MikroTik',
  25053: 'Ruckus',
  25461: 'Palo Alto Networks',
  29671: 'Cisco Meraki',
  41112: 'Ubiquiti',
  47196: 'HPE Aruba',
};

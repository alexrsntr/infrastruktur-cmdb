// Network documentation: ports, VLANs and IP subnets (IPAM). Shared by API and web client.

import type { AssetStatus, AssetType } from './model';

export const PORT_KINDS = ['ethernet', 'sfp', 'mgmt', 'console', 'wifi', 'other'] as const;
export type PortKind = (typeof PORT_KINDS)[number];
export const PORT_KIND_META: Record<PortKind, { label: string }> = {
  ethernet: { label: 'Ethernet (RJ45)' },
  sfp: { label: 'SFP / fibre' },
  mgmt: { label: 'Management' },
  console: { label: 'Console' },
  wifi: { label: 'Wi-Fi radio' },
  other: { label: 'Other' },
};

export const PORT_MODES = ['access', 'trunk'] as const;
export type PortMode = (typeof PORT_MODES)[number];

export interface AssetPort {
  id: string;
  asset_id: string;
  name: string;
  position: number;
  kind: PortKind;
  speed: string | null;
  description: string | null;
  enabled: boolean;
  mode: PortMode | null;
  untagged_vlan: number | null;
  tagged_vlans: number[];
  mac_address: string | null;
  cable_label: string | null;
  /** manual | discovery */
  source: string;
  connected_port_id: string | null;
  /** The other end of the cable */
  peer_port_name: string | null;
  peer_asset_id: string | null;
  peer_asset_name: string | null;
  peer_asset_type: AssetType | null;
  peer_asset_status: AssetStatus | null;
}

export interface Vlan {
  id: string;
  plant_id: string;
  vid: number;
  name: string;
  description: string | null;
  subnet_count?: number;
  port_count?: number;
}

export interface Subnet {
  id: string;
  plant_id: string;
  plant_code?: string;
  cidr: string;
  name: string;
  vlan_id: string | null;
  vlan_vid?: number | null;
  vlan_name?: string | null;
  gateway: string | null;
  dhcp_range: string | null;
  description: string | null;
  /** Usable host addresses (IPv4; null for very large / IPv6 networks) */
  size: number | null;
  used: number;
  duplicates: number;
}

export interface SubnetAddress {
  ip: string;
  asset_id: string;
  asset_name: string;
  asset_type: AssetType;
  asset_status: AssetStatus;
  /** the same address is documented on more than one device */
  duplicate: boolean;
}

export interface SubnetDetail extends Subnet {
  addresses: SubnetAddress[];
  /** Free address ranges (IPv4 only), e.g. { from: '10.1.0.20', to: '10.1.0.99', count: 80 } */
  free: { from: string; to: string; count: number }[];
  /** First free address (not network, broadcast or gateway) */
  nextFree: string | null;
}

export interface DuplicateIp {
  ip: string;
  assets: { id: string; name: string; type: AssetType; plant_code: string | null }[];
}

export interface PlantNetwork {
  vlans: Vlan[];
  subnets: Subnet[];
  duplicates: DuplicateIp[];
  /** Devices whose IP address is in none of the plant's subnets */
  unassigned: { id: string; name: string; type: AssetType; ip_address: string }[];
  connections: number;
}

/**
 * Expands "Gi1/0/1-48" into Gi1/0/1 … Gi1/0/48 (only the last number may be a range).
 * Several names can be separated by commas: "Te1/1/1-4, Mgmt0".
 */
export function expandPortNames(input: string, max = 512): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[,;\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(.*?)(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const [, prefix, a, b] = m;
      const from = Number(a);
      const to = Number(b);
      if (to < from) throw new Error(`Invalid range "${part}"`);
      if (to - from + 1 + out.length > max) throw new Error(`At most ${max} ports at once`);
      for (let i = from; i <= to; i++) out.push(`${prefix}${String(i).padStart(a.startsWith('0') ? a.length : 0, '0')}`);
    } else {
      out.push(part);
    }
    if (out.length > max) throw new Error(`At most ${max} ports at once`);
  }
  return out;
}

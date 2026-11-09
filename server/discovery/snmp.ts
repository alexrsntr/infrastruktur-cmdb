import snmpLib from 'net-snmp';
import type { AssetType } from '../../shared/model';
import { SNMP_VENDORS, type DiscoveredData, type DiscoveredNeighbor, type DiscoveredPort, type DiscoverySecrets, type SnmpConfig } from '../../shared/discovery';
import { intToIpv4, ipv4ToInt } from '../routes/network';

// net-snmp's type definitions do not match its runtime exports everywhere – use it untyped
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const snmp = snmpLib as any;

export const MAX_TARGETS = 4096;

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',
  // ENTITY-MIB entPhysicalEntry
  entPhysical: '1.3.6.1.2.1.47.1.1.1.1',
  // IF-MIB
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifType: '1.3.6.1.2.1.2.2.1.3',
  ifPhysAddress: '1.3.6.1.2.1.2.2.1.6',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias: '1.3.6.1.2.1.31.1.1.1.18',
  // LLDP-MIB
  lldpLocChassisId: '1.0.8802.1.1.2.1.3.2.0',
  lldpLocPortId: '1.0.8802.1.1.2.1.3.7.1.3',
  lldpLocPortDesc: '1.0.8802.1.1.2.1.3.7.1.4',
  lldpRem: '1.0.8802.1.1.2.1.4.1.1',
} as const;

/** ethernetCsmacd, fastEther, gigabitEthernet, 10G … – the physical ports worth documenting */
const PHYSICAL_IF_TYPES = new Set([6, 62, 69, 117]);

// ---------------------------------------------------------------------------- targets

/** "10.0.0.0/24, 10.0.1.5, 10.0.2.10-10.0.2.20, 10.0.3.1-50" → list of IPv4 addresses */
export function expandTargets(spec: string, max = MAX_TARGETS): string[] {
  const out = new Set<string>();
  const add = (n: number) => {
    out.add(intToIpv4(n));
    if (out.size > max) throw new Error(`More than ${max} addresses – split the range into several sources`);
  };
  for (const raw of spec.split(/[\s,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/))) {
      const base = ipv4ToInt(m[1]);
      const prefix = Number(m[2]);
      if (base === null || prefix < 8 || prefix > 32) throw new Error(`Invalid network "${part}" (prefix /8 … /32)`);
      const size = 2 ** (32 - prefix);
      if (size > max + 2) throw new Error(`"${part}" has more than ${max} addresses – use a smaller network`);
      const net = base - (base % size);
      const [first, last] = prefix >= 31 ? [net, net + size - 1] : [net + 1, net + size - 2];
      for (let n = first; n <= last; n++) add(n);
    } else if ((m = part.match(/^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+|\d{1,3})$/))) {
      const from = ipv4ToInt(m[1]);
      const to = m[2].includes('.') ? ipv4ToInt(m[2]) : from === null ? null : from - (from % 256) + Number(m[2]);
      if (from === null || to === null || to < from) throw new Error(`Invalid range "${part}"`);
      if (to - from + 1 > max) throw new Error(`"${part}" has more than ${max} addresses`);
      for (let n = from; n <= to; n++) add(n);
    } else if (ipv4ToInt(part) !== null) {
      add(ipv4ToInt(part)!);
    } else {
      throw new Error(`"${part}" is not an IPv4 address, range or network`);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------- value helpers

function isPrintable(buf: Buffer): boolean {
  return buf.length > 0 && [...buf].every((b) => (b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d);
}

export function formatMac(buf: Buffer): string | null {
  if (buf.length !== 6 || buf.every((b) => b === 0)) return null;
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(':');
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) {
    if (!v.length) return null;
    if (!isPrintable(v)) return formatMac(v) ?? v.toString('hex');
    const s = v.toString('utf8').replace(/\0+$/, '').trim();
    return s || null;
  }
  const s = String(v).trim();
  return s || null;
}

/** LLDP chassis/port ids: MAC addresses arrive as 6 raw bytes */
function idText(v: unknown): string | null {
  if (Buffer.isBuffer(v) && v.length === 6 && !isPrintable(v)) return formatMac(v);
  return text(v);
}

// ---------------------------------------------------------------------------- session

export interface SnmpSessionLike {
  get(oids: string[]): Promise<Record<string, unknown>>;
  walk(oid: string): Promise<{ oid: string; value: unknown }[]>;
  close(): void;
}

export function openSession(host: string, cfg: SnmpConfig, secrets: DiscoverySecrets): SnmpSessionLike {
  const options = { port: cfg.port || 161, timeout: cfg.timeoutMs || 1500, retries: cfg.retries ?? 1, backoff: 1, idBitsSize: 32 };
  let session: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (cfg.version === '3') {
    const level = snmp.SecurityLevel[cfg.level ?? 'authPriv'];
    const user: Record<string, unknown> = { name: cfg.user ?? '', level };
    if (level >= snmp.SecurityLevel.authNoPriv) {
      user.authProtocol = snmp.AuthProtocols[cfg.authProtocol ?? 'sha'];
      user.authKey = secrets.authKey ?? '';
    }
    if (level === snmp.SecurityLevel.authPriv) {
      user.privProtocol = snmp.PrivProtocols[cfg.privProtocol ?? 'aes'];
      user.privKey = secrets.privKey ?? '';
    }
    session = snmp.createV3Session(host, user, { ...options, version: snmp.Version3 });
  } else {
    session = snmp.createSession(host, secrets.community || 'public', { ...options, version: snmp.Version2c });
  }
  session.on?.('error', () => undefined);
  return {
    get: (oids) =>
      new Promise((resolve, reject) => {
        session.get(oids, (err: Error | null, varbinds: { oid: string; value: unknown }[]) => {
          if (err) return reject(err);
          const out: Record<string, unknown> = {};
          for (const vb of varbinds ?? []) if (!snmp.isVarbindError(vb)) out[vb.oid] = vb.value;
          resolve(out);
        });
      }),
    walk: (oid) =>
      new Promise((resolve) => {
        const rows: { oid: string; value: unknown }[] = [];
        session.subtree(
          oid,
          20,
          (varbinds: { oid: string; value: unknown }[]) => {
            for (const vb of varbinds) if (!snmp.isVarbindError(vb)) rows.push({ oid: vb.oid, value: vb.value });
          },
          // a device that does not know the table (or times out on it) simply has no rows
          () => resolve(rows),
        );
      }),
    close: () => {
      try {
        session.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** column number → index → value, for a table walked below `entryOid` */
function columns(rows: { oid: string; value: unknown }[], entryOid: string): Map<number, Map<string, unknown>> {
  const out = new Map<number, Map<string, unknown>>();
  const prefix = `${entryOid}.`;
  for (const r of rows) {
    if (!r.oid.startsWith(prefix)) continue;
    const rest = r.oid.slice(prefix.length);
    const dot = rest.indexOf('.');
    if (dot < 0) continue;
    const col = Number(rest.slice(0, dot));
    const idx = rest.slice(dot + 1);
    if (!out.has(col)) out.set(col, new Map());
    out.get(col)!.set(idx, r.value);
  }
  return out;
}

function columnOf(rows: { oid: string; value: unknown }[], columnOid: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const prefix = `${columnOid}.`;
  for (const r of rows) if (r.oid.startsWith(prefix)) out.set(r.oid.slice(prefix.length), r.value);
  return out;
}

// ---------------------------------------------------------------------------- classification

export function vendorOf(sysObjectId: string | null): string | null {
  const m = sysObjectId?.match(/^1\.3\.6\.1\.4\.1\.(\d+)/);
  return m ? (SNMP_VENDORS[Number(m[1])] ?? null) : null;
}

/** Best guess of the device type from vendor, sysDescr and model */
export function guessType(vendor: string | null, descr: string, model: string | null): AssetType {
  const s = `${descr} ${model ?? ''}`.toLowerCase();
  if (/\b(ups|smart-ups|symmetra|galaxy|uninterruptible)\b/.test(s) || vendor === 'APC' || vendor === 'Eaton') return /\bpdu\b|rack pdu|epdu/.test(s) ? 'pdu' : 'ups';
  if (/\bpdu\b|rack pdu/.test(s)) return 'pdu';
  if (/mobility controller|wireless lan controller|wlc|wireless controller|mobility master|gateway 7\d{3}|\b7\d{3} controller|arubaos \(model: [79]\d{3}|aruba ?[79]\d{3}\b/.test(s)) return 'wlan_controller';
  if (/access point|\bap-?\d|instant on ap|\biap\b/.test(s)) return 'access_point';
  if (vendor === 'Fortinet' || vendor === 'Palo Alto Networks' || /firewall|fortigate|pan-os|asa\b|sophos|checkpoint/.test(s)) return 'firewall';
  if (/\brouter\b|isr\d|asr\d|ios xr|mikrotik routeros/.test(s)) return 'router';
  if (/switch|exos|extremexos|switch engine|voss|fabric engine|aruba ?os-?cx|procurve|arubaos-switch|catalyst|nexus|comware|scalance x/.test(s)) return 'switch';
  if (/printer|laserjet|jetdirect|kyocera|ricoh|lexmark|zebra/.test(s)) return 'printer';
  if (/camera|axis|hikvision|bosch dinion|mobotix/.test(s)) return 'camera';
  if (/simatic|s7-\d|plc|scalance m|hmi/.test(s)) return 'ot_device';
  if (/windows|linux|vmware esxi|server/.test(s)) return 'server';
  if (vendor && ['Extreme Networks', 'HPE', 'HPE Aruba', 'Aruba', 'Cisco', 'Juniper', 'Alcatel-Lucent', 'Huawei', 'Netgear', 'D-Link', 'TP-Link'].includes(vendor)) return 'switch';
  return 'other';
}

/** "ExtremeXOS (X465-48P) version 31.7.1.4 …" → firmware version */
function firmwareFromDescr(descr: string): string | null {
  const m = descr.match(/\b(?:version|ver\.?|firmware|revision|release)[\s:]*v?([0-9][\w.()-]*)/i) ?? descr.match(/\b(\d+\.\d+(?:\.\d+){1,3}[\w.-]*)\b/);
  return m ? m[1].replace(/[,;]$/, '') : null;
}

// ---------------------------------------------------------------------------- collection

/** Asks one host; null when it does not answer SNMP (or the credentials are wrong) */
export async function probeHost(session: SnmpSessionLike, ip: string): Promise<DiscoveredData | null> {
  let sys: Record<string, unknown>;
  try {
    sys = await session.get([OID.sysDescr, OID.sysObjectID, OID.sysName, OID.sysLocation]);
  } catch {
    return null;
  }
  if (!Object.keys(sys).length) return null;
  const descr = text(sys[OID.sysDescr]) ?? '';
  const sysObjectId = text(sys[OID.sysObjectID]);
  const sysName = text(sys[OID.sysName]);

  // ENTITY-MIB: the chassis (class 3) carries serial number, model and firmware; stacks have several
  const ent = columns(await session.walk(OID.entPhysical), OID.entPhysical);
  const cls = ent.get(5) ?? new Map();
  let chassisIdx: string | undefined = [...cls.entries()].find(([, v]) => Number(v) === 3)?.[0];
  if (!chassisIdx) chassisIdx = [...(ent.get(11) ?? new Map()).entries()].find(([, v]) => text(v))?.[0];
  const entVal = (col: number) => (chassisIdx ? text(ent.get(col)?.get(chassisIdx)) : null);
  const serial = entVal(11);
  const model = entVal(13) ?? entVal(7) ?? entVal(2);
  const firmware = entVal(10) ?? entVal(9) ?? firmwareFromDescr(descr);
  const mfg = entVal(12);

  // IF-MIB: physical ports
  const ifRows = await Promise.all([session.walk(OID.ifName), session.walk(OID.ifDescr), session.walk(OID.ifType), session.walk(OID.ifPhysAddress), session.walk(OID.ifHighSpeed), session.walk(OID.ifAlias)]);
  const [ifName, ifDescr, ifType, ifMac, ifSpeed, ifAlias] = [
    columnOf(ifRows[0], OID.ifName),
    columnOf(ifRows[1], OID.ifDescr),
    columnOf(ifRows[2], OID.ifType),
    columnOf(ifRows[3], OID.ifPhysAddress),
    columnOf(ifRows[4], OID.ifHighSpeed),
    columnOf(ifRows[5], OID.ifAlias),
  ];
  const ports: DiscoveredPort[] = [];
  for (const [idx, t] of ifType) {
    if (!PHYSICAL_IF_TYPES.has(Number(t))) continue;
    const name = text(ifName.get(idx)) ?? text(ifDescr.get(idx));
    if (!name) continue;
    const mbit = Number(ifSpeed.get(idx) ?? 0);
    ports.push({
      name,
      description: text(ifAlias.get(idx)),
      mac: Buffer.isBuffer(ifMac.get(idx)) ? formatMac(ifMac.get(idx) as Buffer) : null,
      speed: mbit >= 1000 ? `${mbit / 1000}G` : mbit > 0 ? `${mbit}M` : null,
    });
  }

  // LLDP: neighbours (index timeMark.localPortNum.remIndex)
  const loc = await session.get([OID.lldpLocChassisId]).catch(() => ({}) as Record<string, unknown>);
  const locPortId = columnOf(await session.walk(OID.lldpLocPortId), OID.lldpLocPortId);
  const locPortDesc = columnOf(await session.walk(OID.lldpLocPortDesc), OID.lldpLocPortDesc);
  const rem = columns(await session.walk(OID.lldpRem), OID.lldpRem);
  const neighbors: DiscoveredNeighbor[] = [];
  const portNames = new Set(ports.map((p) => p.name.toLowerCase()));
  for (const [idx, chassis] of rem.get(5) ?? new Map()) {
    const localNum = idx.split('.')[1];
    // prefer the local port id when it is an interface name we know, else its description
    const locId = idText(locPortId.get(localNum));
    const locDesc = text(locPortDesc.get(localNum));
    const localPort = [locId, locDesc].find((n) => n && portNames.has(n.toLowerCase())) ?? locDesc ?? locId;
    neighbors.push({
      local_port: localPort,
      remote_chassis: idText(chassis),
      remote_port: idText(rem.get(7)?.get(idx)) ?? text(rem.get(8)?.get(idx)),
      remote_name: text(rem.get(9)?.get(idx)),
    });
  }

  const vendor = mfg ?? vendorOf(sysObjectId);
  const chassisMac = idText(loc[OID.lldpLocChassisId]);
  return {
    name: sysName ? sysName.split('.')[0] : null,
    fqdn: sysName && sysName.includes('.') ? sysName : null,
    ip,
    mac: chassisMac && /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(chassisMac) ? chassisMac : (ports.find((p) => p.mac)?.mac ?? null),
    serial,
    manufacturer: vendor,
    model,
    firmware,
    os: null,
    description: descr || null,
    location: text(sys[OID.sysLocation]),
    type: guessType(vendorOf(sysObjectId) ?? vendor, descr, model),
    sys_object_id: sysObjectId,
    ports,
    neighbors,
  };
}

/** Sweeps all targets with limited parallelism */
export async function sweep(
  cfg: SnmpConfig,
  secrets: DiscoverySecrets,
  opts: { concurrency?: number; open?: typeof openSession } = {},
): Promise<{ scanned: number; found: DiscoveredData[] }> {
  const targets = expandTargets(cfg.targets);
  const open = opts.open ?? openSession;
  const found: DiscoveredData[] = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const ip = targets[next++];
      const session = open(ip, cfg, secrets);
      try {
        const data = await probeHost(session, ip);
        if (data) found.push(data);
      } finally {
        session.close();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 32, targets.length) }, worker));
  return { scanned: targets.length, found };
}

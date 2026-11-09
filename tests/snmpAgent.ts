// A real SNMP agent (net-snmp) on 127.0.0.x and a random UDP port, simulating a switch for the discovery tests.
import snmpLib from 'net-snmp';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const snmp = snmpLib as any;

export interface FakeDevice {
  address: string;
  community: string;
  v3User?: { name: string; authKey: string; privKey: string };
  sysDescr: string;
  sysObjectID: string;
  sysName: string;
  sysLocation?: string;
  chassis?: { serial: string; model: string; software: string; mfg: string };
  chassisMac: Buffer;
  ports: { index: number; name: string; mac: Buffer; speedMbit: number; alias?: string }[];
  /** LLDP neighbours: local port number refers to ports[].index */
  neighbors?: { localPort: number; chassis: Buffer; portId: string; sysName: string }[];
}

const RO = snmp.MaxAccess['read-only'];
const NA = snmp.MaxAccess['not-accessible'];
const T = snmp.ObjectType;

export async function startFakeAgent(dev: FakeDevice, port: number): Promise<{ close: () => void }> {
  const agent = await new Promise<any>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const a = snmp.createAgent({ port, address: dev.address, disableAuthorization: false, accessControlModelType: snmp.AccessControlModelType.None }, (err: Error | null) => {
      if (err) reject(err);
    });
    a.listener?.sockets ? resolve(a) : setTimeout(() => resolve(a), 50);
  });
  const auth = agent.getAuthorizer();
  auth.addCommunity(dev.community);
  if (dev.v3User)
    auth.addUser({
      name: dev.v3User.name,
      level: snmp.SecurityLevel.authPriv,
      authProtocol: snmp.AuthProtocols.sha,
      authKey: dev.v3User.authKey,
      privProtocol: snmp.PrivProtocols.aes,
      privKey: dev.v3User.privKey,
    });
  const mib = agent.getMib();
  const scalar = (name: string, oid: string, type: number, value: unknown) => {
    mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: RO });
    mib.setScalarValue(name, value);
  };
  scalar('sysDescr', '1.3.6.1.2.1.1.1', T.OctetString, dev.sysDescr);
  scalar('sysObjectID', '1.3.6.1.2.1.1.2', T.OID, dev.sysObjectID);
  scalar('sysName', '1.3.6.1.2.1.1.5', T.OctetString, dev.sysName);
  scalar('sysLocation', '1.3.6.1.2.1.1.6', T.OctetString, dev.sysLocation ?? '');
  scalar('lldpLocChassisId', '1.0.8802.1.1.2.1.3.2', T.OctetString, dev.chassisMac);

  const table = (name: string, oid: string, cols: [number, string, number, number][], index: string[]) =>
    mib.registerProvider({
      name,
      type: snmp.MibProviderType.Table,
      oid,
      maxAccess: NA,
      tableColumns: cols.map(([number, n, type, maxAccess]) => ({ number, name: n, type, maxAccess })),
      tableIndex: index.map((columnName) => ({ columnName })),
    });

  if (dev.chassis) {
    table(
      'entPhysicalTable',
      '1.3.6.1.2.1.47.1.1.1.1',
      [
        [1, 'entPhysicalIndex', T.Integer, NA],
        [2, 'entPhysicalDescr', T.OctetString, RO],
        [5, 'entPhysicalClass', T.Integer, RO],
        [10, 'entPhysicalSoftwareRev', T.OctetString, RO],
        [11, 'entPhysicalSerialNum', T.OctetString, RO],
        [12, 'entPhysicalMfgName', T.OctetString, RO],
        [13, 'entPhysicalModelName', T.OctetString, RO],
      ],
      ['entPhysicalIndex'],
    );
    // a power supply first (class 6), then the chassis (class 3)
    mib.addTableRow('entPhysicalTable', [1, 'PSU 1', 6, '', 'PSU-0001', dev.chassis.mfg, 'PSU']);
    mib.addTableRow('entPhysicalTable', [2, 'Chassis', 3, dev.chassis.software, dev.chassis.serial, dev.chassis.mfg, dev.chassis.model]);
  }

  table(
    'ifTable',
    '1.3.6.1.2.1.2.2.1',
    [
      [1, 'ifIndex', T.Integer, NA],
      [2, 'ifDescr', T.OctetString, RO],
      [3, 'ifType', T.Integer, RO],
      [6, 'ifPhysAddress', T.OctetString, RO],
    ],
    ['ifIndex'],
  );
  table(
    'ifXTable',
    '1.3.6.1.2.1.31.1.1.1',
    [
      [1, 'ifName', T.OctetString, RO],
      [15, 'ifHighSpeed', T.Gauge, RO],
      [18, 'ifAlias', T.OctetString, RO],
      [99, 'ifXIndex', T.Integer, NA],
    ],
    ['ifXIndex'],
  );
  for (const p of dev.ports) {
    mib.addTableRow('ifTable', [p.index, `Port ${p.name}`, 6, p.mac]);
    mib.addTableRow('ifXTable', [p.name, p.speedMbit, p.alias ?? '', p.index]);
  }
  // a VLAN interface that must not become a port
  mib.addTableRow('ifTable', [5000, 'VLAN 10', 136, Buffer.alloc(6)]);
  mib.addTableRow('ifXTable', ['vlan10', 0, '', 5000]);

  table(
    'lldpLocPortTable',
    '1.0.8802.1.1.2.1.3.7.1',
    [
      [1, 'lldpLocPortNum', T.Integer, NA],
      [3, 'lldpLocPortId', T.OctetString, RO],
      [4, 'lldpLocPortDesc', T.OctetString, RO],
    ],
    ['lldpLocPortNum'],
  );
  for (const p of dev.ports) mib.addTableRow('lldpLocPortTable', [p.index, p.name, `Port ${p.name}`]);
  table(
    'lldpRemTable',
    '1.0.8802.1.1.2.1.4.1.1',
    [
      [1, 'lldpRemTimeMark', T.TimeTicks, NA],
      [2, 'lldpRemLocalPortNum', T.Integer, NA],
      [3, 'lldpRemIndex', T.Integer, NA],
      [5, 'lldpRemChassisId', T.OctetString, RO],
      [7, 'lldpRemPortId', T.OctetString, RO],
      [9, 'lldpRemSysName', T.OctetString, RO],
    ],
    ['lldpRemTimeMark', 'lldpRemLocalPortNum', 'lldpRemIndex'],
  );
  (dev.neighbors ?? []).forEach((n, i) => mib.addTableRow('lldpRemTable', [0, n.localPort, i + 1, n.chassis, n.portId, n.sysName]));

  return { close: () => agent.close() };
}

export const mac = (s: string) => Buffer.from(s.split(':').map((x) => parseInt(x, 16)));

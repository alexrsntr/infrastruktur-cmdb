import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../server/config';
import { expandTargets, guessType, vendorOf } from '../server/discovery/snmp';
import { adFilter, fileTimeToIso, type LdapClientLike } from '../server/discovery/ad';
import { runDueSources } from '../server/discovery/service';
import { login, setupTestApp, type Session } from './helpers';
import { mac, startFakeAgent } from './snmpAgent';

let app: Express;
let pool: Pool;
let config: Config;
let admin: Session;
let editor: Session;
let viewer: Session;
let muc: { id: string };
const agents: { close: () => void }[] = [];
const port = 20000 + Math.floor(Math.random() * 30000);

/** Fake Active Directory */
const ldapCalls: { bind?: [string, string]; filter?: string; base?: string } = {};
const fakeLdap = (): LdapClientLike => ({
  bind: async (dn, pw) => {
    ldapCalls.bind = [dn, pw];
    if (pw !== 'secret-pw') throw new Error('Invalid credentials');
  },
  search: async (base, opts) => {
    ldapCalls.base = base;
    ldapCalls.filter = opts.filter;
    return {
      searchEntries: [
        // FILETIME 134000000000000000 ≈ 2025-08-22
        { cn: 'MUC-ESX01', dNSHostName: 'muc-esx01.example.local', operatingSystem: 'Windows Server 2022 Datacenter', operatingSystemVersion: '10.0 (20348)', objectGUID: Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex'), lastLogonTimestamp: '134000000000000000' },
        { cn: 'MUC-NEWSRV01', dNSHostName: 'muc-newsrv01.example.local', operatingSystem: 'Windows Server 2025 Standard', objectGUID: Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', 'hex') },
      ],
    };
  },
  unbind: async () => undefined,
});

beforeAll(async () => {
  ({ app, pool, config } = await setupTestApp({ deps: { discovery: { ldapFactory: fakeLdap } } }));
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  muc = ((await viewer.get('/api/plants').expect(200)).body as { id: string; code: string }[]).find((p) => p.code === 'MUC')!;

  // Extreme Networks switch (new to the CMDB) and an HPE Aruba CX switch (already documented, without serial number)
  agents.push(
    await startFakeAgent(
      {
        address: '127.0.0.11',
        community: 'cmdb-ro',
        v3User: { name: 'cmdbscan', authKey: 'auth-secret-1', privKey: 'priv-secret-1' },
        sysDescr: 'ExtremeXOS (X465-48P) version 31.7.1.4 31.7.1.4-patch1-2 by release-manager',
        sysObjectID: '1.3.6.1.4.1.1916.2.400',
        sysName: 'muc-ext-sw01.example.local',
        sysLocation: 'B01 floor distributor',
        chassis: { serial: 'EXT2219K-0042', model: 'X465-48P', software: '31.7.1.4', mfg: 'Extreme Networks' },
        chassisMac: mac('00:04:96:aa:bb:01'),
        ports: [
          { index: 1001, name: '1:1', mac: mac('00:04:96:aa:bb:11'), speedMbit: 1000 },
          { index: 1002, name: '1:2', mac: mac('00:04:96:aa:bb:12'), speedMbit: 10000, alias: 'uplink core' },
        ],
        neighbors: [{ localPort: 1002, chassis: mac('94:60:d5:00:00:01'), portId: '1/1/1', sysName: 'muc-aruba-sw01' }],
      },
      port,
    ),
  );
  agents.push(
    await startFakeAgent(
      {
        address: '127.0.0.12',
        community: 'cmdb-ro',
        sysDescr: 'Aruba JL659A 6300M 48SR5 CL6 PoE 4SFP56 Swch FL.10.11.1010',
        sysObjectID: '1.3.6.1.4.1.47196.4.1.1.1.300',
        sysName: 'muc-aruba-sw01',
        chassis: { serial: 'SG0ABC1234', model: 'JL659A', software: 'FL.10.11.1010', mfg: 'Aruba' },
        chassisMac: mac('94:60:d5:00:00:01'),
        ports: [{ index: 1, name: '1/1/1', mac: mac('94:60:d5:00:00:11'), speedMbit: 10000 }],
        neighbors: [{ localPort: 1, chassis: mac('00:04:96:aa:bb:01'), portId: '1:2', sysName: 'muc-ext-sw01.example.local' }],
      },
      port,
    ),
  );
});

afterAll(async () => {
  for (const a of agents) a.close();
  await pool.end();
});

describe('helpers', () => {
  it('expands targets', () => {
    expect(expandTargets('10.0.0.0/30, 10.0.1.5; 10.0.2.10-12 10.0.3.1-10.0.3.2')).toEqual(['10.0.0.1', '10.0.0.2', '10.0.1.5', '10.0.2.10', '10.0.2.11', '10.0.2.12', '10.0.3.1', '10.0.3.2']);
    expect(expandTargets('10.0.0.0/24')).toHaveLength(254);
    expect(() => expandTargets('10.0.0.0/16')).toThrow(/more than/);
    expect(() => expandTargets('switch01')).toThrow(/not an IPv4/);
  });

  it('recognises vendors and device types', () => {
    expect(vendorOf('1.3.6.1.4.1.1916.2.400')).toBe('Extreme Networks');
    expect(vendorOf('1.3.6.1.4.1.47196.4.1.1.1.300')).toBe('HPE Aruba');
    expect(vendorOf('1.3.6.1.4.1.14823.1.1.32')).toBe('Aruba');
    expect(vendorOf('1.3.6.1.4.1.11.2.3.7.11.181')).toBe('HPE');
    expect(guessType('Extreme Networks', 'ExtremeXOS (X465-48P) version 31.7', 'X465-48P')).toBe('switch');
    expect(guessType('Aruba', 'ArubaOS (MODEL: 7210), Version 8.10', 'Aruba7210')).toBe('wlan_controller');
    expect(guessType('HPE', 'HP J9772A 2530-48G-PoEP Switch, revision YA.16.10', null)).toBe('switch');
    expect(guessType('APC', 'APC Web/SNMP Management Card (MB:v4.1.0 PF:v6.8.2)', 'Smart-UPS 3000')).toBe('ups');
    expect(guessType('Fortinet', 'FortiGate-100F v7.4.4', null)).toBe('firewall');
  });

  it('reads Active Directory values', () => {
    expect(fileTimeToIso('134000000000000000')).toMatch(/^2025-/);
    expect(fileTimeToIso('0')).toBeNull();
    expect(adFilter({ url: '', baseDn: '', bindDn: '', serversOnly: true, tlsInsecure: false })).toContain('(operatingSystem=*Server*)');
    expect(adFilter({ url: '', baseDn: '', bindDn: '', serversOnly: false, tlsInsecure: false })).not.toContain('Server');
  });
});

describe('SNMP discovery', () => {
  let sourceId: string;
  let aruba: { id: string };

  it('only administrators manage sources; credentials are stored encrypted and never returned', async () => {
    aruba = (await editor.post('/api/assets', { type: 'switch', name: 'muc-aruba-sw01', plant_id: muc.id, model: 'Aruba 6300M' }).expect(201)).body;
    const body = {
      name: 'MUC network',
      kind: 'snmp',
      plant_id: muc.id,
      schedule_hours: 24,
      config: { targets: '127.0.0.10-13', version: '2c', port, timeoutMs: 400, retries: 0 },
      secrets: { community: 'cmdb-ro' },
    };
    await editor.post('/api/discovery/sources', body).expect(403);
    await admin.post('/api/discovery/sources', { ...body, config: { ...body.config, targets: '10.0.0.0/8' } }).expect(400);
    const src = (await admin.post('/api/discovery/sources', body).expect(201)).body;
    sourceId = src.id;
    expect(src.secrets_set).toEqual(['community']);
    expect(JSON.stringify(src)).not.toContain('cmdb-ro');
    const stored = (await pool.query('SELECT secrets_enc FROM discovery_source WHERE id = $1', [src.id])).rows[0].secrets_enc;
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain('cmdb-ro');
  });

  it('sweeps the range, matches existing devices and fills only empty fields', async () => {
    const run = (await admin.post(`/api/discovery/sources/${sourceId}/run?wait=true`).expect(200)).body;
    expect(run).toMatchObject({ status: 'ok', scanned: 4, found: 2, new_items: 1, updated_assets: 1 });

    const sw = (await viewer.get(`/api/assets/${aruba.id}`).expect(200)).body;
    expect(sw).toMatchObject({ serial_number: 'SG0ABC1234', manufacturer: 'Aruba', model: 'Aruba 6300M', mac_address: '94:60:d5:00:00:01', ip_address: '127.0.0.12', os: 'FL.10.11.1010' });
    expect(sw.attributes.firmware).toBe('FL.10.11.1010');
    expect(sw.last_seen_at).not.toBeNull();
    const ports = (await viewer.get(`/api/assets/${aruba.id}/ports`).expect(200)).body;
    expect(ports.map((p: { name: string; source: string }) => [p.name, p.source])).toEqual([['1/1/1', 'discovery']]);

    const inbox = (await editor.get('/api/discovery/items?state=new').expect(200)).body;
    expect(inbox.counts).toEqual({ new: 1, linked: 1, ignored: 0 });
    expect(inbox.items[0].data).toMatchObject({ name: 'muc-ext-sw01', fqdn: 'muc-ext-sw01.example.local', serial: 'EXT2219K-0042', model: 'X465-48P', manufacturer: 'Extreme Networks', type: 'switch' });
    const linked = (await editor.get('/api/discovery/items?state=linked').expect(200)).body.items[0];
    expect(linked).toMatchObject({ asset_id: aruba.id, matched_by: 'name' });
  });

  it('creates a device from the inbox and documents the LLDP neighbourship', async () => {
    const item = (await editor.get('/api/discovery/items?state=new').expect(200)).body.items[0];
    const created = (await editor.post(`/api/discovery/items/${item.id}/create`, {}).expect(201)).body;
    expect(created).toMatchObject({ name: 'muc-ext-sw01', type: 'switch', plant_id: muc.id, serial_number: 'EXT2219K-0042', fqdn: 'muc-ext-sw01.example.local' });
    await editor.post(`/api/discovery/items/${item.id}/create`, {}).expect(409);

    const detail = (await viewer.get(`/api/assets/${created.id}`).expect(200)).body;
    expect(detail.relations).toEqual([expect.objectContaining({ relation: 'connected_to', other_name: 'muc-aruba-sw01', local_port: '1:2', remote_port: '1/1/1' })]);
    const ports = (await viewer.get(`/api/assets/${created.id}/ports`).expect(200)).body as { name: string; peer_asset_name: string | null; peer_port_name: string | null; description: string | null }[];
    expect(ports.map((p) => p.name)).toEqual(['1:1', '1:2']);
    expect(ports[1]).toMatchObject({ description: 'uplink core', peer_asset_name: 'muc-aruba-sw01', peer_port_name: '1/1/1' });
  });

  it('a second run updates "last seen" and creates nothing twice', async () => {
    await pool.query('UPDATE asset SET last_seen_at = NULL');
    const run = (await admin.post(`/api/discovery/sources/${sourceId}/run?wait=true`).expect(200)).body;
    expect(run).toMatchObject({ status: 'ok', found: 2, new_items: 0, updated_assets: 0 });
    const rels = (await pool.query(`SELECT count(*)::int AS n FROM asset_relation WHERE relation = 'connected_to' AND note LIKE 'LLDP%'`)).rows[0].n;
    expect(rels).toBe(1);
    const seen = (await pool.query(`SELECT count(*)::int AS n FROM asset WHERE last_seen_at IS NOT NULL`)).rows[0].n;
    expect(seen).toBe(2);
    const runs = (await admin.get(`/api/discovery/runs?sourceId=${sourceId}`).expect(200)).body;
    expect(runs).toHaveLength(2);
  });

  it('works with SNMPv3 (authPriv) and reports wrong credentials as nothing found', async () => {
    const v3 = (
      await admin
        .post('/api/discovery/sources', {
          name: 'MUC v3',
          kind: 'snmp',
          plant_id: muc.id,
          schedule_hours: 0,
          config: { targets: '127.0.0.11', version: '3', port, timeoutMs: 800, retries: 0, user: 'cmdbscan', level: 'authPriv', authProtocol: 'sha', privProtocol: 'aes' },
          secrets: { authKey: 'auth-secret-1', privKey: 'priv-secret-1' },
        })
        .expect(201)
    ).body;
    expect(v3.secrets_set.sort()).toEqual(['authKey', 'privKey']);
    const run = (await admin.post(`/api/discovery/sources/${v3.id}/run?wait=true`).expect(200)).body;
    expect(run).toMatchObject({ status: 'ok', found: 1 });
    // the v3 item is matched by serial number with the device created above
    const items = (await editor.get(`/api/discovery/items?state=linked&sourceId=${v3.id}`).expect(200)).body.items;
    expect(items[0]).toMatchObject({ matched_by: 'serial', asset_name: 'muc-ext-sw01' });

    // keeping the stored secret when it is not sent again, replacing it when it is
    await admin.put(`/api/discovery/sources/${v3.id}`, { name: 'MUC v3', kind: 'snmp', plant_id: muc.id, schedule_hours: 0, config: { targets: '127.0.0.11', version: '3', port, timeoutMs: 800, retries: 0, user: 'cmdbscan', level: 'authPriv', authProtocol: 'sha', privProtocol: 'aes' }, secrets: { privKey: 'wrong-priv-key' } }).expect(200);
    const bad = (await admin.post(`/api/discovery/sources/${v3.id}/run?wait=true`).expect(200)).body;
    expect(bad).toMatchObject({ status: 'ok', found: 0 });
  });

  it('ignoring keeps an item out of the inbox on the next runs', async () => {
    const extra = (await admin.post('/api/discovery/sources', { name: 'Single', kind: 'snmp', plant_id: muc.id, schedule_hours: 0, config: { targets: '127.0.0.11', port, timeoutMs: 400, retries: 0 }, secrets: { community: 'cmdb-ro' } }).expect(201)).body;
    // make the device unknown again
    await pool.query(`UPDATE asset SET serial_number = NULL, mac_address = NULL, fqdn = NULL, ip_address = NULL, name = 'renamed-ext' WHERE name = 'muc-ext-sw01'`);
    await admin.post(`/api/discovery/sources/${extra.id}/run?wait=true`).expect(200);
    const item = (await editor.get(`/api/discovery/items?state=new&sourceId=${extra.id}`).expect(200)).body.items[0];
    await editor.post(`/api/discovery/items/${item.id}/ignore`).expect(204);
    await admin.post(`/api/discovery/sources/${extra.id}/run?wait=true`).expect(200);
    expect((await editor.get(`/api/discovery/items?state=new&sourceId=${extra.id}`).expect(200)).body.items).toHaveLength(0);
    // and linking by hand
    const renamed = (await viewer.get('/api/assets?q=renamed-ext').expect(200)).body.items[0];
    await editor.post(`/api/discovery/items/${item.id}/reset`).expect(204);
    await editor.post(`/api/discovery/items/${item.id}/link`, { asset_id: renamed.id }).expect(204);
    expect((await viewer.get(`/api/assets/${renamed.id}`).expect(200)).body.serial_number).toBe('EXT2219K-0042');
  });
});

describe('Active Directory discovery', () => {
  it('reads server computer objects, matches by host name and records the last logon', async () => {
    const src = (
      await admin
        .post('/api/discovery/sources', {
          name: 'AD example.local',
          kind: 'ad',
          plant_id: muc.id,
          schedule_hours: 24,
          config: { url: 'ldaps://dc01.example.local:636', baseDn: 'DC=example,DC=local', bindDn: 'CN=svc-cmdb,OU=Service,DC=example,DC=local', serversOnly: true },
          secrets: { bindPassword: 'secret-pw' },
        })
        .expect(201)
    ).body;
    await admin.post('/api/discovery/sources', { name: 'Bad AD', kind: 'ad', config: { url: 'http://dc01', baseDn: 'x', bindDn: 'y' } }).expect(400);
    const run = (await admin.post(`/api/discovery/sources/${src.id}/run?wait=true`).expect(200)).body;
    expect(run).toMatchObject({ status: 'ok', found: 2, new_items: 1, updated_assets: 0 }); // nothing empty to fill on the seeded host
    expect(ldapCalls).toMatchObject({ bind: ['CN=svc-cmdb,OU=Service,DC=example,DC=local', 'secret-pw'], base: 'DC=example,DC=local' });

    const esx = (await viewer.get('/api/assets?q=muc-esx01').expect(200)).body.items[0];
    // the seeded host already has an OS and an FQDN – kept as they are
    expect(esx.os).toBe('VMware ESXi 8.0 U3');
    expect(esx.last_seen_at).not.toBeNull();
    const item = (await editor.get(`/api/discovery/items?state=new&sourceId=${src.id}`).expect(200)).body.items[0];
    expect(item.key).toBe('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
    expect(item.data).toMatchObject({ name: 'muc-newsrv01', fqdn: 'muc-newsrv01.example.local', os: 'Windows Server 2025 Standard', type: 'server' });

    // wrong password → run fails with a readable message
    await admin.put(`/api/discovery/sources/${src.id}`, { name: 'AD example.local', kind: 'ad', plant_id: muc.id, schedule_hours: 24, config: { url: 'ldaps://dc01.example.local:636', baseDn: 'DC=example,DC=local', bindDn: 'CN=svc-cmdb,OU=Service,DC=example,DC=local', serversOnly: true }, secrets: { bindPassword: 'nope' } }).expect(200);
    const failed = (await admin.post(`/api/discovery/sources/${src.id}/run?wait=true`).expect(200)).body;
    expect(failed).toMatchObject({ status: 'error', error: 'Invalid credentials' });
    const sources = (await admin.get('/api/discovery/sources').expect(200)).body;
    expect(sources.find((s: { id: string }) => s.id === src.id).last_status).toContain('Invalid credentials');
  });

  it('the scheduler runs due sources only', async () => {
    await pool.query(`UPDATE discovery_source SET last_run_at = now() - interval '25 hours' WHERE name = 'MUC network'`);
    await pool.query(`UPDATE discovery_source SET last_run_at = now() WHERE name <> 'MUC network'`);
    const ran = await runDueSources(pool, config, {});
    expect(ran).toBe(1);
    expect(await runDueSources(pool, config, {})).toBe(0);
  });
});

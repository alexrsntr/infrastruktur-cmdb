import { Client } from 'ldapts';
import type { AdConfig, DiscoveredData, DiscoverySecrets } from '../../shared/discovery';

/** The part of an LDAP client the AD collector needs (tests pass a fake) */
export interface LdapClientLike {
  bind(dn: string, password: string): Promise<void>;
  search(base: string, options: { scope: 'sub'; filter: string; attributes: string[]; explicitBufferAttributes: string[]; paged: boolean }): Promise<{ searchEntries: Record<string, unknown>[] }>;
  unbind(): Promise<void>;
}

export type LdapFactory = (cfg: AdConfig) => LdapClientLike;

export const defaultLdapFactory: LdapFactory = (cfg) =>
  new Client({
    url: cfg.url,
    timeout: 30_000,
    connectTimeout: 10_000,
    tlsOptions: cfg.url.startsWith('ldaps:') ? { rejectUnauthorized: !cfg.tlsInsecure } : undefined,
  }) as unknown as LdapClientLike;

const ATTRIBUTES = ['cn', 'dNSHostName', 'operatingSystem', 'operatingSystemVersion', 'description', 'objectGUID', 'lastLogonTimestamp', 'userAccountControl', 'distinguishedName'];

/** Windows FILETIME (100 ns since 1601) → ISO date */
export function fileTimeToIso(v: unknown): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined || s === null || s === '' || s === '0') return null;
  try {
    const ms = Number(BigInt(String(s)) / 10_000n) - 11_644_473_600_000;
    return ms > 0 ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

function first(v: unknown): string | null {
  const x = Array.isArray(v) ? v[0] : v;
  if (x === undefined || x === null) return null;
  if (Buffer.isBuffer(x)) return x.toString('hex');
  const s = String(x).trim();
  return s || null;
}

export function adFilter(cfg: AdConfig): string {
  // only enabled computer accounts (bit 2 of userAccountControl = disabled)
  const base = '(objectCategory=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2))';
  return cfg.serversOnly ? `(&${base}(operatingSystem=*Server*))` : `(&${base})`;
}

export async function collectAd(cfg: AdConfig, secrets: DiscoverySecrets, factory: LdapFactory = defaultLdapFactory): Promise<{ scanned: number; found: (DiscoveredData & { key: string })[] }> {
  const client = factory(cfg);
  try {
    await client.bind(cfg.bindDn, secrets.bindPassword ?? '');
    const { searchEntries } = await client.search(cfg.baseDn, { scope: 'sub', filter: adFilter(cfg), attributes: ATTRIBUTES, explicitBufferAttributes: ['objectGUID'], paged: true });
    const found = searchEntries.map((e) => {
      const cn = first(e.cn);
      const fqdn = first(e.dNSHostName);
      const os = [first(e.operatingSystem), first(e.operatingSystemVersion)].filter(Boolean).join(' ') || null;
      return {
        key: first(e.objectGUID) ?? first(e.distinguishedName) ?? (cn ?? '').toLowerCase(),
        name: (cn ?? fqdn?.split('.')[0] ?? '').toLowerCase() || null,
        fqdn: fqdn?.toLowerCase() ?? null,
        os,
        description: first(e.description) ?? first(e.distinguishedName),
        type: 'server' as const,
        last_logon: fileTimeToIso(e.lastLogonTimestamp),
      };
    });
    return { scanned: searchEntries.length, found: found.filter((f) => f.name) };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

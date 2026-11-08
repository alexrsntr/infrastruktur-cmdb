import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from '../config';
import { decryptSecret } from '../lib/secrets';
import { readSetting, writeSetting } from '../services/mailer';
import {
  ENTRA_FIELDS,
  type EntraConnectionCheck,
  type EntraCredential,
  type EntraField,
  type EntraLoginCheck,
  type LocalLoginMode,
} from '../../shared/entra';

/**
 * Microsoft Entra ID configuration: stored in app_setting (key "entra", client secret encrypted with lib/secrets)
 * and merged with environment variables. Environment variables always win:
 * - AUTH_MODE=entra (e.g. Terraform): everything comes from ENTRA_* – exactly the behaviour before this feature.
 * - AUTH_MODE=local/dev: each ENTRA_* variable that is set overrides (and locks) the value configured in the app.
 */

export const ENTRA_KEY = 'entra';

export interface StoredEntraSettings {
  tenantId: string;
  clientId: string;
  credential: EntraCredential;
  clientSecretEnc: string | null;
  clientSecretSetAt: string | null;
  managedIdentityClientId: string;
  requireAppRole: boolean;
  /** Microsoft sign-in activated by an administrator */
  enabled: boolean;
  localLogin: LocalLoginMode;
  /** Results of "Test connection" and the test sign-in – only valid for the configuration they were made with */
  checks: { fingerprint: string; connection: EntraConnectionCheck | null; login: EntraLoginCheck | null } | null;
}

export const EMPTY_ENTRA: StoredEntraSettings = {
  tenantId: '',
  clientId: '',
  credential: 'secret',
  clientSecretEnc: null,
  clientSecretSetAt: null,
  managedIdentityClientId: '',
  requireAppRole: false,
  enabled: false,
  localLogin: 'all',
  checks: null,
};

/** The configuration in effect right now (server side only – contains the decrypted client secret). */
export interface EntraRuntime {
  source: 'env' | 'database';
  tenantId: string;
  clientId: string;
  credential: EntraCredential;
  clientSecret: string;
  managedIdentityClientId: string;
  requireAppRole: boolean;
  /** Tenant, application and credential are complete */
  configured: boolean;
  /** Microsoft sign-in is active */
  enabled: boolean;
  /** Password sign-in (AUTH_MODE=local); 'none' for AUTH_MODE entra/dev. LOCAL_LOGIN_EMERGENCY is not applied here. */
  localLogin: LocalLoginMode | 'none';
  locked: Partial<Record<EntraField, boolean>>;
  /** Identifies tenant + application + credential type; the checks before activation are tied to it */
  fingerprint: string;
  /** Identifies the MSAL client (includes the secret) */
  clientKey: string;
  stored: StoredEntraSettings;
  updatedAt: string | null;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function entraFingerprint(v: { tenantId: string; clientId: string; credential: EntraCredential; managedIdentityClientId: string }): string {
  return sha([v.tenantId.toLowerCase(), v.clientId.toLowerCase(), v.credential, v.credential === 'managedIdentity' ? v.managedIdentityClientId.toLowerCase() : ''].join('|'));
}

export function resolveEntra(config: Config, stored: StoredEntraSettings, updatedAt: string | null): EntraRuntime {
  if (config.authMode === 'entra') {
    const values = {
      tenantId: config.entra.tenantId,
      clientId: config.entra.clientId,
      credential: (config.entra.useManagedIdentity ? 'managedIdentity' : 'secret') as EntraCredential,
      managedIdentityClientId: config.managedIdentityClientId,
    };
    const fingerprint = entraFingerprint(values);
    return {
      source: 'env',
      ...values,
      clientSecret: config.entra.clientSecret,
      requireAppRole: config.entra.requireAppRole,
      configured: true,
      enabled: true,
      localLogin: 'none',
      locked: Object.fromEntries(ENTRA_FIELDS.map((f) => [f, true])),
      fingerprint,
      clientKey: `${fingerprint}|${sha(config.entra.clientSecret)}`,
      stored,
      updatedAt,
    };
  }

  const env = config.entraEnv;
  const tenantId = env.tenantId ? config.entra.tenantId : stored.tenantId;
  const clientId = env.clientId ? config.entra.clientId : stored.clientId;
  const credential: EntraCredential = env.credential ? (config.entra.useManagedIdentity ? 'managedIdentity' : 'secret') : stored.credential;
  const managedIdentityClientId = env.managedIdentityClientId ? config.managedIdentityClientId : stored.managedIdentityClientId;
  const clientSecret = env.clientSecret ? config.entra.clientSecret : (decryptSecret(config, stored.clientSecretEnc) ?? '');
  const requireAppRole = env.requireAppRole ? config.entra.requireAppRole : stored.requireAppRole;
  const configured = !!tenantId && !!clientId && (credential === 'managedIdentity' || !!clientSecret);
  const enabled = stored.enabled && configured;
  const fingerprint = entraFingerprint({ tenantId, clientId, credential, managedIdentityClientId });
  return {
    source: 'database',
    tenantId,
    clientId,
    credential,
    clientSecret,
    managedIdentityClientId,
    requireAppRole,
    configured,
    enabled,
    localLogin: config.authMode === 'local' ? (enabled ? stored.localLogin : 'all') : 'none',
    locked: {
      tenantId: env.tenantId,
      clientId: env.clientId,
      credential: env.credential,
      clientSecret: env.clientSecret,
      managedIdentityClientId: env.managedIdentityClientId,
      requireAppRole: env.requireAppRole,
    },
    fingerprint,
    clientKey: `${fingerprint}|${sha(clientSecret)}`,
    stored,
    updatedAt,
  };
}

/** Password sign-in actually allowed, including the LOCAL_LOGIN_EMERGENCY break-glass switch. */
export function effectiveLocalLogin(config: Config, rt: EntraRuntime): LocalLoginMode | 'none' {
  if (rt.localLogin === 'off' && config.localLoginEmergency) return 'admins';
  return rt.localLogin;
}

/** Loads and caches the configuration (10 s per instance, invalidated on every change made by this instance). */
export class EntraSettingsStore {
  private cached: { at: number; value: EntraRuntime } | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly config: Config,
    private readonly ttlMs = 10_000,
  ) {}

  async load(): Promise<{ stored: StoredEntraSettings; updatedAt: string | null }> {
    const row = await readSetting<Partial<StoredEntraSettings>>(this.pool, ENTRA_KEY);
    return { stored: { ...EMPTY_ENTRA, ...(row?.value ?? {}) }, updatedAt: row?.updatedAt ?? null };
  }

  async runtime(): Promise<EntraRuntime> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.value;
    const { stored, updatedAt } = await this.load();
    const value = resolveEntra(this.config, stored, updatedAt);
    this.cached = { at: Date.now(), value };
    return value;
  }

  async save(stored: StoredEntraSettings, userId: string | null): Promise<EntraRuntime> {
    await writeSetting(this.pool, ENTRA_KEY, stored, userId);
    this.invalidate();
    return this.runtime();
  }

  invalidate() {
    this.cached = null;
  }
}

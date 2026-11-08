import { ROLES, type Role } from '../shared/model';

function str(name: string, fallback = ''): string {
  // Empty values fall back to the default (e.g. an unquoted "#color" in a .env file is parsed as a comment)
  return process.env[name]?.trim() || fallback;
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

export interface Config {
  env: string;
  isProduction: boolean;
  port: number;
  baseUrl: string;
  /** Production behind HTTPS (APP_BASE_URL starts with https://): secure cookies, HSTS, upgrade-insecure-requests */
  httpsOnly: boolean;
  sessionSecret: string;
  /** entra = Microsoft Entra ID SSO · local = e-mail + password accounts · dev = persona picker (development) */
  authMode: 'entra' | 'local' | 'dev';
  entra: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    useManagedIdentity: boolean;
    requireAppRole: boolean;
  };
  defaultRole: Role;
  bootstrapAdmins: string[];
  db: {
    auth: 'password' | 'entra';
    connectionString: string;
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean;
    migrateOnStart: boolean;
    poolMax: number;
  };
  managedIdentityClientId: string;
  /** Key for encrypting secrets stored in app settings (e.g. SMTP password). Falls back to SESSION_SECRET. */
  settingsEncryptionKey: string;
  /** Run the in-process scheduler for e-mail notifications */
  notificationsScheduler: boolean;
  /** Where attachment files are stored */
  storage: {
    driver: 'database' | 'azure-blob';
    accountUrl: string;
    container: string;
    connectionString: string;
    maxUploadMb: number;
  };
  ui: {
    brandName: string;
    appName: string;
    primaryColor: string;
    mapTileUrl: string;
    mapTileAttribution: string;
  };
}

export function loadConfig(): Config {
  const env = str('NODE_ENV', 'development');
  const isProduction = env === 'production';
  const authMode = str('AUTH_MODE', isProduction ? 'entra' : 'dev') as Config['authMode'];
  const defaultRole = str('DEFAULT_ROLE', 'viewer') as Role;
  const sessionSecret = str('SESSION_SECRET', isProduction ? '' : 'dev-only-insecure-session-secret');
  const baseUrl = str('APP_BASE_URL', 'http://localhost:5173').replace(/\/$/, '');

  const config: Config = {
    env,
    isProduction,
    port: int('PORT', 3000),
    baseUrl,
    httpsOnly: isProduction && baseUrl.startsWith('https://'),
    sessionSecret,
    authMode,
    entra: {
      tenantId: str('ENTRA_TENANT_ID'),
      clientId: str('ENTRA_CLIENT_ID'),
      clientSecret: str('ENTRA_CLIENT_SECRET'),
      useManagedIdentity: bool('ENTRA_USE_MANAGED_IDENTITY'),
      requireAppRole: bool('ENTRA_REQUIRE_APP_ROLE'),
    },
    defaultRole,
    bootstrapAdmins: str('BOOTSTRAP_ADMINS')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    db: {
      auth: str('DB_AUTH', 'password') as Config['db']['auth'],
      connectionString: str('DATABASE_URL'),
      host: str('PGHOST', 'localhost'),
      port: int('PGPORT', 5432),
      database: str('PGDATABASE', 'cmdb'),
      user: str('PGUSER', 'cmdb'),
      password: str('PGPASSWORD'),
      ssl: ['require', 'verify-full', 'verify-ca'].includes(str('PGSSLMODE', 'disable')),
      migrateOnStart: bool('DB_MIGRATE_ON_START', true),
      poolMax: int('DB_POOL_MAX', 10),
    },
    managedIdentityClientId: str('AZURE_CLIENT_ID'),
    settingsEncryptionKey: str('SETTINGS_ENCRYPTION_KEY'),
    notificationsScheduler: bool('NOTIFICATIONS_SCHEDULER', env !== 'test'),
    storage: {
      driver: str('STORAGE_DRIVER', 'database') as Config['storage']['driver'],
      accountUrl: str('AZURE_STORAGE_ACCOUNT_URL').replace(/\/$/, ''),
      container: str('AZURE_STORAGE_CONTAINER', 'attachments'),
      connectionString: str('AZURE_STORAGE_CONNECTION_STRING'),
      maxUploadMb: int('ATTACHMENT_MAX_MB', 50),
    },
    ui: {
      brandName: str('BRAND_NAME', 'Infrastruktur'),
      appName: str('APP_NAME', 'IT CMDB'),
      primaryColor: str('BRAND_PRIMARY_COLOR', '#2563eb'),
      mapTileUrl: str('MAP_TILE_URL', 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'),
      mapTileAttribution: str('MAP_TILE_ATTRIBUTION', '&copy; OpenStreetMap contributors'),
    },
  };

  validate(config);
  return config;
}

function validate(c: Config) {
  const errors: string[] = [];
  if (!['entra', 'local', 'dev'].includes(c.authMode)) errors.push(`AUTH_MODE must be "entra", "local" or "dev" (got "${c.authMode}")`);
  if (c.isProduction && c.authMode === 'dev') errors.push('AUTH_MODE=dev is not allowed when NODE_ENV=production');
  if (!c.sessionSecret || (c.isProduction && c.sessionSecret.length < 32))
    errors.push('SESSION_SECRET must be set (at least 32 characters in production)');
  if (!ROLES.includes(c.defaultRole)) errors.push(`DEFAULT_ROLE must be one of ${ROLES.join(', ')}`);
  if (!['password', 'entra'].includes(c.db.auth)) errors.push('DB_AUTH must be "password" or "entra"');
  if (!['database', 'azure-blob'].includes(c.storage.driver)) errors.push('STORAGE_DRIVER must be "database" or "azure-blob"');
  if (c.storage.driver === 'azure-blob' && !c.storage.accountUrl && !c.storage.connectionString)
    errors.push('STORAGE_DRIVER=azure-blob requires AZURE_STORAGE_ACCOUNT_URL (managed identity) or AZURE_STORAGE_CONNECTION_STRING');
  if (c.storage.maxUploadMb < 1 || c.storage.maxUploadMb > 500) errors.push('ATTACHMENT_MAX_MB must be between 1 and 500');
  if (c.authMode === 'entra') {
    if (!c.entra.tenantId) errors.push('ENTRA_TENANT_ID is required when AUTH_MODE=entra');
    if (!c.entra.clientId) errors.push('ENTRA_CLIENT_ID is required when AUTH_MODE=entra');
    if (!c.entra.clientSecret && !c.entra.useManagedIdentity)
      errors.push('Set ENTRA_CLIENT_SECRET or ENTRA_USE_MANAGED_IDENTITY=true when AUTH_MODE=entra');
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n - ${errors.join('\n - ')}`);
  }
}

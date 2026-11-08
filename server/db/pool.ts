import pg from 'pg';
import { DefaultAzureCredential, ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import type { Config } from '../config';
import { log } from '../lib/log';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Dates (avoids TZ shifts)
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC -> number
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// BIGINT (count(*)) -> number
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const POSTGRES_AAD_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

/**
 * Builds a password provider that returns a Microsoft Entra access token for
 * Azure Database for PostgreSQL (Flexible Server). Tokens are cached and
 * refreshed 5 minutes before expiry; node-postgres calls this function for
 * every new physical connection, so long-running pools keep working.
 */
export function entraTokenProvider(managedIdentityClientId?: string): () => Promise<string> {
  const credential: TokenCredential =
    process.env.WEBSITE_INSTANCE_ID || process.env.IDENTITY_ENDPOINT
      ? new ManagedIdentityCredential(managedIdentityClientId ? { clientId: managedIdentityClientId } : undefined)
      : new DefaultAzureCredential(managedIdentityClientId ? { managedIdentityClientId } : undefined);

  let cached: { token: string; expiresOn: number } | null = null;
  return async () => {
    const now = Date.now();
    if (cached && cached.expiresOn - now > 5 * 60 * 1000) return cached.token;
    const result = await credential.getToken(POSTGRES_AAD_SCOPE);
    if (!result) throw new Error('Could not acquire Entra access token for PostgreSQL');
    cached = { token: result.token, expiresOn: result.expiresOnTimestamp };
    log.info('db: acquired Entra access token for PostgreSQL', { expiresOn: new Date(result.expiresOnTimestamp).toISOString() });
    return result.token;
  };
}

export function createPool(config: Config): pg.Pool {
  const { db } = config;
  const poolConfig: pg.PoolConfig = {
    max: db.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    application_name: 'infrastruktur-cmdb',
  };

  if (db.connectionString) {
    poolConfig.connectionString = db.connectionString;
  } else {
    poolConfig.host = db.host;
    poolConfig.port = db.port;
    poolConfig.database = db.database;
    poolConfig.user = db.user;
  }

  if (db.auth === 'entra') {
    poolConfig.password = entraTokenProvider(config.managedIdentityClientId || undefined);
  } else if (db.password) {
    poolConfig.password = db.password;
  }

  if (db.ssl || db.auth === 'entra') {
    poolConfig.ssl = { rejectUnauthorized: true };
  }

  const pool = new pg.Pool(poolConfig);
  pool.on('error', (err) => log.error('db: idle client error', { error: err.message }));
  return pool;
}

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

import type pg from 'pg';
import { migrations } from './migrations';
import { log } from '../lib/log';

const LOCK_ID = 727_001; // arbitrary, app specific advisory lock id

export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // Serialise migrations across multiple app instances (App Service scale-out)
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        id          text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migration');
    const done = new Set(rows.map((r) => r.id));

    for (const m of migrations) {
      if (done.has(m.id)) continue;
      log.info(`db: applying migration ${m.id}`);
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migration (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        applied.push(m.id);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${m.id} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}

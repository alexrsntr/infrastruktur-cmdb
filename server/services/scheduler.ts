import type { Pool } from 'pg';
import type { Config } from '../config';
import { log } from '../lib/log';
import { loadWarrantySettings, localParts, runWarrantyJob } from './warrantyNotifications';

/**
 * In-process scheduler for the daily warranty digest.
 *
 * Safe with several App Service instances: a PostgreSQL advisory lock lets only one
 * instance check at a time, the "already ran today" check is done in the database, and
 * notification_log rows are claimed with ON CONFLICT DO NOTHING.
 */

const LOCK_ID = 727_002;
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_CHECK_MS = 30 * 1000;
const MAX_ATTEMPTS_PER_DAY = 3;

export async function checkAndRun(pool: Pool, config: Config, now: Date = new Date()): Promise<'ran' | 'not-due' | 'locked' | 'disabled'> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
    if (!rows[0].locked) return 'locked';
    try {
      const { settings } = await loadWarrantySettings(client);
      if (!settings.enabled) return 'disabled';
      const { date, hour } = localParts(settings.timezone, now);
      if (hour < settings.sendHour) return 'not-due';
      const { rows: today } = await client.query<{ ok: number; failed: number }>(
        `SELECT count(*) FILTER (WHERE status = 'ok') AS ok, count(*) FILTER (WHERE status IN ('error','skipped')) AS failed
         FROM notification_run WHERE kind = 'warranty' AND trigger = 'schedule' AND local_date = $1`,
        [date],
      );
      if (today[0].ok > 0 || today[0].failed >= MAX_ATTEMPTS_PER_DAY) return 'not-due';
      await runWarrantyJob(pool, config, { trigger: 'schedule', now });
      return 'ran';
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

export function startScheduler(pool: Pool, config: Config): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await checkAndRun(pool, config);
    } catch (err) {
      log.error('scheduler: check failed', { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, FIRST_CHECK_MS);
  const interval = setInterval(tick, CHECK_INTERVAL_MS);
  first.unref();
  interval.unref();
  log.info('scheduler: started (warranty notifications)');
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}

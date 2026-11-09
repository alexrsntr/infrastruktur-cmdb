import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { eventMatches } from '../../shared/integrations';
import type { Config } from '../config';
import { decryptSecret } from '../lib/secrets';
import { log } from '../lib/log';

/**
 * Webhook dispatcher. Events are written to event_outbox together with the audit entry (same transaction);
 * this job fans them out to the matching webhooks and delivers them with retries.
 *
 * Every request carries
 *   X-CMDB-Event: asset.update
 *   X-CMDB-Delivery: <delivery id>
 *   X-CMDB-Timestamp: <unix seconds>
 *   X-CMDB-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
 */

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text: () => Promise<string> }>;

const LOCK_ID = 727_004;
export const MAX_ATTEMPTS = 6;
const TIMEOUT_MS = 10_000;
const BATCH = 25;

/** Wait before attempt n+1: 30 s, 1 min, 2 min, 4 min, 8 min … */
export function retryDelaySeconds(attempts: number): number {
  return 30 * 2 ** Math.max(0, attempts - 1);
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export interface DispatchResult {
  fannedOut: number;
  delivered: number;
  failed: number;
  retried: number;
}

async function fanOut(pool: Pool, now: Date): Promise<number> {
  const client = await pool.connect();
  let created = 0;
  try {
    await client.query('BEGIN');
    const { rows: events } = await client.query<{ id: string; event: string }>(
      'SELECT id, event FROM event_outbox WHERE NOT fanned_out ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED',
    );
    if (events.length) {
      const { rows: hooks } = await client.query<{ id: string; events: string[] }>('SELECT id, events FROM webhook WHERE active');
      for (const e of events) {
        for (const h of hooks) {
          if (!eventMatches(h.events, e.event)) continue;
          await client.query('INSERT INTO webhook_delivery (webhook_id, event_id, next_attempt_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [h.id, e.id, now]);
          created++;
        }
      }
      await client.query('UPDATE event_outbox SET fanned_out = true WHERE id = ANY($1::bigint[])', [events.map((e) => e.id)]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return created;
}

/** Sends one request; returns the HTTP status (0 = network error) and an error text */
export async function postWebhook(
  fetchImpl: FetchLike,
  hook: { url: string; secret: string },
  event: string,
  deliveryId: string,
  body: string,
): Promise<{ status: number; error: string | null }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'infrastruktur-cmdb-webhook',
        'x-cmdb-event': event,
        'x-cmdb-delivery': deliveryId,
        'x-cmdb-timestamp': String(timestamp),
        'x-cmdb-signature': signPayload(hook.secret, timestamp, body),
      },
      body,
      signal: controller.signal,
    });
    if (res.status >= 200 && res.status < 300) return { status: res.status, error: null };
    const text = (await res.text().catch(() => '')).slice(0, 300);
    return { status: res.status, error: `HTTP ${res.status}${text ? `: ${text}` : ''}` };
  } catch (err) {
    const e = err as Error;
    return { status: 0, error: e.name === 'AbortError' ? `No answer within ${TIMEOUT_MS / 1000} s` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function deliverDue(pool: Pool, config: Config, fetchImpl: FetchLike, now: Date): Promise<Omit<DispatchResult, 'fannedOut'>> {
  const out = { delivered: 0, failed: 0, retried: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT d.id::text, d.attempts, d.webhook_id, e.event, e.payload, w.url, w.secret_enc
       FROM webhook_delivery d JOIN event_outbox e ON e.id = d.event_id JOIN webhook w ON w.id = d.webhook_id
       WHERE d.status = 'pending' AND d.next_attempt_at <= $1 AND w.active
       ORDER BY d.id LIMIT ${BATCH} FOR UPDATE OF d SKIP LOCKED`,
      [now],
    );
    for (const d of rows) {
      const secret = decryptSecret(config, d.secret_enc);
      const body = JSON.stringify({ ...d.payload, delivery_id: d.id });
      const result = secret
        ? await postWebhook(fetchImpl, { url: d.url, secret }, d.event, d.id, body)
        : { status: 0, error: 'The signing secret cannot be decrypted (SETTINGS_ENCRYPTION_KEY changed?) – save the webhook again' };
      const attempts = d.attempts + 1;
      if (!result.error) {
        out.delivered++;
        await client.query(`UPDATE webhook_delivery SET status='ok', attempts=$2, response_status=$3, last_error=NULL, delivered_at=$4 WHERE id=$1`, [d.id, attempts, result.status, now]);
      } else if (attempts >= MAX_ATTEMPTS) {
        out.failed++;
        await client.query(`UPDATE webhook_delivery SET status='failed', attempts=$2, response_status=$3, last_error=$4 WHERE id=$1`, [d.id, attempts, result.status || null, result.error]);
      } else {
        out.retried++;
        await client.query(
          `UPDATE webhook_delivery SET attempts=$2, response_status=$3, last_error=$4, next_attempt_at = $5::timestamptz + make_interval(secs => $6) WHERE id=$1`,
          [d.id, attempts, result.status || null, result.error, now, retryDelaySeconds(attempts)],
        );
      }
      await client.query(`UPDATE webhook SET last_delivery_at = $2, last_status = $3 WHERE id = $1`, [d.webhook_id, now, result.error ?? `HTTP ${result.status}`]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return out;
}

/** One dispatcher round (also used by tests). Only one instance works at a time (advisory lock). */
export async function dispatchWebhooks(pool: Pool, config: Config, fetchImpl: FetchLike = fetch as unknown as FetchLike, now = new Date()): Promise<DispatchResult | 'locked'> {
  const lock = await pool.connect();
  try {
    const { rows } = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!rows[0].ok) return 'locked';
    try {
      const fannedOut = await fanOut(pool, now);
      const res = await deliverDue(pool, config, fetchImpl, now);
      // housekeeping: keep two weeks of history
      await pool.query(`DELETE FROM event_outbox WHERE fanned_out AND created_at < now() - interval '14 days'`);
      return { fannedOut, ...res };
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    }
  } finally {
    lock.release();
  }
}

export function startWebhookDispatcher(pool: Pool, config: Config, intervalMs = 5000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await dispatchWebhooks(pool, config);
      if (r !== 'locked' && (r.failed || r.retried)) log.warn('webhooks: delivery problems', { ...r });
    } catch (err) {
      log.error('webhooks: dispatcher failed', { error: (err as Error).message });
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

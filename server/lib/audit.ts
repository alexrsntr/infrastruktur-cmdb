import type { Request } from 'express';
import type { DbClient } from '../db/pool';
import { log } from './log';

export interface AuditInput {
  action: string; // create | update | delete | login | logout | export | import | ...
  entityType?: string | null;
  entityId?: string | null;
  entityLabel?: string | null;
  plantId?: string | null;
  changes?: Record<string, unknown> | null;
}

const IGNORED_FIELDS = new Set(['updated_at', 'created_at', 'updated_by', 'created_by', 'plan_image']);

function normalise(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v === undefined || v === '') return null;
  return v;
}

/** Field-level diff between two row snapshots: { field: { from, to } } */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key) || key.endsWith('_name') || key.endsWith('_count')) continue;
    if (!(key in after)) continue;
    const a = normalise(before[key]);
    const b = normalise(after[key]);
    if (key === 'attributes' && a && b && typeof a === 'object' && typeof b === 'object') {
      const nested = diff(a as Record<string, unknown>, b as Record<string, unknown>);
      for (const [k, v] of Object.entries(nested)) out[`attributes.${k}`] = v;
      continue;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = { from: a, to: b };
  }
  return out;
}

export function snapshot(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (IGNORED_FIELDS.has(k) || v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === 'attributes' && typeof v === 'object' && Object.keys(v as object).length === 0) continue;
    out[k] = normalise(v);
  }
  return out;
}

export async function audit(db: DbClient, req: Request | null, input: AuditInput) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, user_name, action, entity_type, entity_id, entity_label, plant_id, changes, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        req?.user?.id ?? null,
        req?.user?.displayName ?? null,
        input.action,
        input.entityType ?? null,
        input.entityId ?? null,
        input.entityLabel ?? null,
        input.plantId ?? null,
        input.changes ? JSON.stringify(input.changes) : null,
        req ? clientIp(req) : null,
      ],
    );
    await enqueueEvent(db, req, input);
  } catch (err) {
    // Inside a transaction the error must propagate so the whole change is rolled back
    if ('release' in db) throw err;
    log.error('audit: failed to write audit entry', { error: (err as Error).message });
  }
}

/** Actions that are not sent to webhooks */
const NO_EVENT = new Set(['login', 'logout', 'export', 'login.failed', 'seed', 'settings.test-mail']);

/** Webhook event name, e.g. "asset.create", "asset.port.connect", "application.update" */
export function eventName(input: AuditInput): string {
  return input.entityType ? `${input.entityType}.${input.action}` : input.action;
}

/**
 * Transactional outbox: the event is stored in the same transaction as the change and the audit entry,
 * the webhook dispatcher delivers it later. Nothing is written while no webhook is active.
 */
async function enqueueEvent(db: DbClient, req: Request | null, input: AuditInput) {
  if (NO_EVENT.has(input.action) || input.entityType === 'settings' || input.entityType === 'user') return;
  const payload = {
    event: eventName(input),
    action: input.action,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    entity_label: input.entityLabel ?? null,
    plant_id: input.plantId ?? null,
    changes: input.changes ?? null,
    user: req?.user?.displayName ?? null,
    at: new Date().toISOString(),
  };
  await db.query(
    `INSERT INTO event_outbox (event, payload) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM webhook WHERE active)`,
    [payload.event, JSON.stringify(payload)],
  );
}

export function clientIp(req: Request): string | null {
  // App Service forwards the client address in X-Forwarded-For; express "trust proxy" resolves req.ip
  const ip = req.ip ?? null;
  // (App Service appends the port to IPv4 addresses, e.g. "203.0.113.7:51234")
  return ip ? ip.replace(/^::ffff:/, '').replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, '$1') : null;
}

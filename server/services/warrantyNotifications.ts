import type { Pool, PoolClient } from 'pg';
import { ASSET_TYPES } from '../../shared/model';
import {
  DEFAULT_WARRANTY_SETTINGS,
  type NotificationRun,
  type RunResult,
  type WarrantyDueItem,
  type WarrantyNotificationSettings,
  type WarrantyPreview,
} from '../../shared/notifications';
import type { Config } from '../config';
import type { DbClient } from '../db/pool';
import { log } from '../lib/log';
import { describeMailError, escapeHtml, isSmtpConfigured, loadSmtpSettings, readSetting, sendMail } from './mailer';

export const WARRANTY_KEY = 'notifications.warranty';
const KIND = 'warranty';

export async function loadWarrantySettings(db: DbClient): Promise<{ settings: WarrantyNotificationSettings; updatedAt: string | null }> {
  const row = await readSetting<Partial<WarrantyNotificationSettings>>(db, WARRANTY_KEY);
  return { settings: { ...DEFAULT_WARRANTY_SETTINGS, ...(row?.value ?? {}) }, updatedAt: row?.updatedAt ?? null };
}

// ---------------------------------------------------------------------------
// Time zone helpers
// ---------------------------------------------------------------------------

/** Local calendar date (YYYY-MM-DD) and hour for an instant in an IANA time zone */
export function localParts(timezone: string, at: Date = new Date()): { date: string; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Approximate next scheduled send time (first full hour at which the local hour equals sendHour). */
export function nextRunAt(settings: WarrantyNotificationSettings, doneToday: boolean, now: Date = new Date()): string | null {
  if (!settings.enabled) return null;
  const today = localParts(settings.timezone, now).date;
  const t = new Date(now);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i <= 50; i++) {
    const p = localParts(settings.timezone, t);
    if (p.hour === settings.sendHour && t.getTime() >= now.getTime() - 3600_000 && !(doneToday && p.date === today)) {
      return (t.getTime() < now.getTime() ? now : t).toISOString();
    }
    t.setUTCHours(t.getUTCHours() + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Due items & routing
// ---------------------------------------------------------------------------

interface DueRow extends Omit<WarrantyDueItem, 'thresholds'> {
  sent: number[];
}

/** Assets whose warranty reaches a configured threshold that has not been notified yet. */
export async function computeDue(db: DbClient, settings: WarrantyNotificationSettings, today: string): Promise<WarrantyDueItem[]> {
  const thresholds = [...new Set(settings.thresholds)].filter((t) => t > 0).sort((a, b) => b - a);
  const maxDays = Math.max(0, ...thresholds);
  if (!thresholds.length && !settings.includeExpired) return [];
  const { rows } = await db.query<DueRow>(
    `SELECT a.id, a.name, a.type, a.status, a.plant_id, p.code AS plant_code, p.name AS plant_name, b.name AS building_name,
            a.manufacturer, a.model, a.serial_number, a.warranty_end::text AS warranty_end,
            (a.warranty_end - $1::date) AS days_left,
            ARRAY(SELECT l.threshold_days FROM notification_log l
                  WHERE l.kind = $2 AND l.asset_id = a.id AND l.warranty_end = a.warranty_end) AS sent
     FROM asset a
     LEFT JOIN plant p ON p.id = a.plant_id
     LEFT JOIN building b ON b.id = a.building_id
     WHERE a.warranty_end IS NOT NULL
       AND NOT (a.status = ANY($3::text[]))
       AND a.warranty_end - $1::date <= $4
       AND ($5 OR a.warranty_end - $1::date > 0)
     ORDER BY a.warranty_end, a.name`,
    [today, KIND, settings.excludeStatuses ?? [], maxDays, settings.includeExpired],
  );
  const items: WarrantyDueItem[] = [];
  for (const r of rows) {
    const applicable = thresholds.filter((t) => r.days_left <= t);
    if (settings.includeExpired && r.days_left <= 0) applicable.push(0);
    const pending = applicable.filter((t) => !r.sent.includes(t));
    if (!pending.length) continue;
    const { sent: _sent, ...rest } = r;
    items.push({ ...rest, thresholds: pending });
  }
  return items;
}

/** Maps each recipient (case-insensitive) to the items they receive. */
export function routeItems(items: WarrantyDueItem[], settings: WarrantyNotificationSettings) {
  const byEmail = new Map<string, { email: string; items: WarrantyDueItem[] }>();
  const add = (email: string, item: WarrantyDueItem) => {
    const key = email.trim().toLowerCase();
    if (!key) return;
    let entry = byEmail.get(key);
    if (!entry) byEmail.set(key, (entry = { email: email.trim(), items: [] }));
    if (!entry.items.includes(item)) entry.items.push(item);
  };
  const routed = new Set<WarrantyDueItem>();
  for (const item of items) {
    for (const email of settings.recipients) {
      add(email, item);
      routed.add(item);
    }
    for (const email of (item.plant_id && settings.plantRecipients[item.plant_id]) || []) {
      add(email, item);
      routed.add(item);
    }
  }
  return { recipients: [...byEmail.values()], routed };
}

export async function previewWarranty(db: DbClient, now: Date = new Date()): Promise<WarrantyPreview> {
  const { settings } = await loadWarrantySettings(db);
  const today = localParts(settings.timezone, now).date;
  const items = await computeDue(db, settings, today);
  const { recipients, routed } = routeItems(items, settings);
  return {
    today,
    items,
    recipients: recipients.map((r) => ({ email: r.email, count: r.items.length })),
    unrouted: items.length - routed.size,
  };
}

// ---------------------------------------------------------------------------
// E-mail rendering
// ---------------------------------------------------------------------------

function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

function daysText(days: number): string {
  if (days < 0) return `expired ${-days} day${days === -1 ? '' : 's'} ago`;
  if (days === 0) return 'expires today';
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function renderWarrantyMail(items: WarrantyDueItem[], opts: { appName: string; brandName: string; baseUrl: string }) {
  const expired = items.filter((i) => i.days_left <= 0).length;
  const plants = [...new Set(items.map((i) => i.plant_code).filter(Boolean))] as string[];
  const n = items.length;
  const what = expired === n ? (n === 1 ? 'warranty expired' : 'warranties expired') : expired ? (n === 1 ? 'warranty expiring' : 'warranties expiring or expired') : n === 1 ? 'warranty expiring' : 'warranties expiring';
  const subject = `[${opts.appName}] ${n} ${what}${plants.length ? ` – ${plants.slice(0, 6).join(', ')}${plants.length > 6 ? ', …' : ''}` : ''}`;

  const link = (id: string) => `${opts.baseUrl}/assets/${id}`;
  const rowsHtml = items
    .map((i) => {
      const urgent = i.days_left <= 7;
      const color = i.days_left <= 0 ? '#cf1322' : urgent ? '#d4380d' : '#1f2937';
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e9ef"><a href="${escapeHtml(link(i.id))}" style="color:#2563eb;font-weight:600;text-decoration:none">${escapeHtml(i.name)}</a></td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e9ef">${escapeHtml(ASSET_TYPES[i.type]?.label ?? i.type)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e9ef">${escapeHtml([i.plant_code, i.building_name].filter(Boolean).join(' / ') || '–')}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e9ef">${escapeHtml([i.manufacturer, i.model].filter(Boolean).join(' ') || '–')}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e9ef;font-family:Consolas,monospace;font-size:12px">${escapeHtml(i.serial_number ?? '–')}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e9ef;white-space:nowrap">${fmtDate(i.warranty_end)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e9ef;white-space:nowrap;color:${color};font-weight:${urgent ? 700 : 400}">${daysText(i.days_left)}</td>
      </tr>`;
    })
    .join('');

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f5f8;font-family:'Segoe UI',Arial,sans-serif;color:#1f2937">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8;padding:24px 0"><tr><td align="center">
    <table role="presentation" width="760" cellpadding="0" cellspacing="0" style="max-width:760px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;border:1px solid #e5e9ef">
      <tr><td style="background:#0b2a4a;color:#ffffff;padding:16px 24px">
        <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#a9bcd3">${escapeHtml(opts.brandName)}</div>
        <div style="font-size:18px;font-weight:600">${escapeHtml(opts.appName)} – warranty notification</div>
      </td></tr>
      <tr><td style="padding:20px 24px 8px">
        <p style="margin:0 0 12px;font-size:14px;line-height:1.5">The warranty or support contract of the following ${n === 1 ? 'device ends' : `${n} devices end`} soon${expired ? ' or has already ended' : ''}. Please plan a renewal or replacement.</p>
      </td></tr>
      <tr><td style="padding:0 24px 20px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f7f9fb;text-align:left;color:#4b5563">
            <th style="padding:8px 10px;border-bottom:1px solid #d9dee5">Device</th>
            <th style="padding:8px 10px;border-bottom:1px solid #d9dee5">Type</th>
            <th style="padding:8px 10px;border-bottom:1px solid #d9dee5">Location</th>
            <th style="padding:8px 10px;border-bottom:1px solid #d9dee5">Model</th>
            <th style="padding:8px 10px;border-bottom:1px solid #d9dee5">Serial</th>
            <th style="padding:8px 10px;border-bottom:1px solid #d9dee5">Warranty end</th>
            <th style="padding:8px 10px;border-bottom:1px solid #d9dee5">Remaining</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </td></tr>
      <tr><td style="padding:12px 24px 20px;font-size:12px;color:#6b7280;border-top:1px solid #e5e9ef">
        You receive this e-mail because you are a recipient of warranty notifications in the ${escapeHtml(opts.appName)}.
        Each device is reported once per reminder stage. <a href="${escapeHtml(opts.baseUrl)}/inventory?sort=warranty_end" style="color:#2563eb">Open all devices sorted by warranty</a>.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;

  const text = [
    `${opts.appName} – warranty notification`,
    '',
    `The warranty or support contract of the following ${n === 1 ? 'device ends' : `${n} devices end`} soon${expired ? ' or has already ended' : ''}:`,
    '',
    ...items.map(
      (i) =>
        `- ${i.name} (${ASSET_TYPES[i.type]?.label ?? i.type}, ${[i.plant_code, i.building_name].filter(Boolean).join(' / ') || 'no location'}) – warranty end ${fmtDate(i.warranty_end)}, ${daysText(i.days_left)}\n  ${link(i.id)}`,
    ),
    '',
    `All devices sorted by warranty: ${opts.baseUrl}/inventory?sort=warranty_end`,
  ].join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

async function finishRun(pool: Pool, id: string, patch: { status: NotificationRun['status']; items?: number; emails?: number; error?: string | null }) {
  const { rows } = await pool.query<NotificationRun>(
    `UPDATE notification_run SET status = $2, items = $3, emails = $4, error = $5, finished_at = now() WHERE id = $1
     RETURNING id::text, kind, started_at, finished_at, trigger, local_date::text, items, emails, status, error`,
    [id, patch.status, patch.items ?? 0, patch.emails ?? 0, patch.error ?? null],
  );
  return rows[0];
}

export async function runWarrantyJob(pool: Pool, config: Config, opts: { trigger: 'schedule' | 'manual'; now?: Date }): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const { settings } = await loadWarrantySettings(pool);
  const today = localParts(settings.timezone, now).date;
  const { rows: runRows } = await pool.query<{ id: string }>(
    `INSERT INTO notification_run (kind, trigger, local_date) VALUES ($1, $2, $3) RETURNING id::text`,
    [KIND, opts.trigger, today],
  );
  const runId = runRows[0].id;

  if (!settings.enabled) return { run: await finishRun(pool, runId, { status: 'skipped', error: 'Warranty notifications are disabled.' }), sent: [] };
  const { settings: smtp } = await loadSmtpSettings(pool);
  if (!isSmtpConfigured(smtp)) return { run: await finishRun(pool, runId, { status: 'skipped', error: 'The e-mail server (SMTP) is not configured.' }), sent: [] };
  if (!settings.recipients.length && !Object.values(settings.plantRecipients).some((l) => l.length))
    return { run: await finishRun(pool, runId, { status: 'skipped', error: 'No recipients configured.' }), sent: [] };

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await computeDue(client, settings, today);
    const { recipients, routed } = routeItems(due, settings);

    // Claim log rows; concurrent runs only send what they actually inserted
    const recipientsOf = new Map<WarrantyDueItem, string[]>();
    for (const r of recipients) for (const item of r.items) recipientsOf.set(item, [...(recipientsOf.get(item) ?? []), r.email]);
    const claimed = new Set<WarrantyDueItem>();
    for (const item of routed) {
      for (const threshold of item.thresholds) {
        const res = await client.query(
          `INSERT INTO notification_log (kind, asset_id, threshold_days, warranty_end, recipients)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (kind, asset_id, threshold_days, warranty_end) DO NOTHING RETURNING id`,
          [KIND, item.id, threshold, item.warranty_end, recipientsOf.get(item) ?? []],
        );
        if (res.rowCount) claimed.add(item);
      }
    }

    const sent: RunResult['sent'] = [];
    for (const r of recipients) {
      const items = r.items.filter((i) => claimed.has(i));
      if (!items.length) continue;
      const mail = renderWarrantyMail(items, { appName: config.ui.appName, brandName: config.ui.brandName, baseUrl: config.baseUrl });
      await sendMail(config, smtp, { to: r.email, ...mail });
      sent.push({ email: r.email, items: items.length });
    }
    await client.query('COMMIT');
    const run = await finishRun(pool, runId, { status: 'ok', items: claimed.size, emails: sent.length });
    if (sent.length) log.info('notifications: warranty digest sent', { items: claimed.size, emails: sent.length, trigger: opts.trigger });
    return { run, sent };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const message = describeMailError(err);
    log.error('notifications: warranty job failed', { error: message });
    return { run: await finishRun(pool, runId, { status: 'error', error: message }), sent: [] };
  } finally {
    client.release();
  }
}

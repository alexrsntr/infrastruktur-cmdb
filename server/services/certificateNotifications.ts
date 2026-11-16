import type { Pool, PoolClient } from 'pg';
import {
  CERT_KIND_META,
  CERT_WATCHED_STATUSES,
  DEFAULT_CERTIFICATE_NOTIFICATION_SETTINGS,
  daysLeftText,
  type CertKind,
  type CertificateDueItem,
  type CertificateNotificationSettings,
  type CertificatePreview,
  type CertificateResponsible,
  type CertificateRunResult,
  responsibleEmails,
  responsiblesText,
} from '../../shared/certificates';
import type { Config } from '../config';
import type { DbClient } from '../db/pool';
import { log } from '../lib/log';
import { describeMailError, escapeHtml, isSmtpConfigured, loadSmtpSettings, readSetting, sendMail } from './mailer';
import { localParts } from './warrantyNotifications';

export const CERTIFICATE_KEY = 'notifications.certificates';
const KIND = 'certificates';
const OVERVIEW_KIND = 'certificate-overview';

export async function loadCertificateSettings(db: DbClient): Promise<{ settings: CertificateNotificationSettings; updatedAt: string | null }> {
  const row = await readSetting<Partial<CertificateNotificationSettings>>(db, CERTIFICATE_KEY);
  return { settings: { ...DEFAULT_CERTIFICATE_NOTIFICATION_SETTINGS, ...(row?.value ?? {}) }, updatedAt: row?.updatedAt ?? null };
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date "YYYY-MM-DD" */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

const uniqueEmails = (list: (string | null | undefined)[]) => {
  const seen = new Map<string, string>();
  for (const e of list) {
    const v = e?.trim();
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()];
};

interface DueRow {
  id: string;
  name: string;
  kind: CertKind;
  common_name: string | null;
  expires_on: string;
  days_left: number;
  responsibles: CertificateResponsible[];
  notify_emails: string[];
  plant_code: string | null;
  application_name: string | null;
  installed_on: string | null;
  sent: number[];
}

/** Certificates that reached a reminder stage that has not been sent yet for their current expiry date. */
export async function computeReminders(db: DbClient, settings: CertificateNotificationSettings, today: string): Promise<(CertificateDueItem & { kind: CertKind; installed_on: string | null })[]> {
  const thresholds = [...new Set(settings.thresholds)].filter((t) => t > 0).sort((a, b) => b - a);
  if (!thresholds.length && !settings.includeExpired) return [];
  const maxDays = Math.max(0, ...thresholds);
  const { rows } = await db.query<DueRow>(
    `SELECT c.id, c.name, c.kind, c.common_name, c.expires_on::text AS expires_on, (c.expires_on - $1::date) AS days_left,
            c.responsibles, c.notify_emails, p.code AS plant_code, ap.name AS application_name, c.installed_on,
            ARRAY(SELECT n.threshold_days FROM certificate_notification n WHERE n.certificate_id = c.id AND n.expires_on = c.expires_on) AS sent
     FROM certificate c
     LEFT JOIN plant p ON p.id = c.plant_id
     LEFT JOIN application ap ON ap.id = c.application_id
     WHERE c.status = ANY($2::text[])
       AND c.expires_on - $1::date <= $3
       AND ($4 OR c.expires_on >= $1::date)
     ORDER BY c.expires_on, lower(c.name)`,
    [today, CERT_WATCHED_STATUSES, maxDays, settings.includeExpired],
  );
  const out: (CertificateDueItem & { kind: CertKind; installed_on: string | null })[] = [];
  for (const r of rows) {
    const applicable = thresholds.filter((t) => r.days_left <= t);
    if (settings.includeExpired && r.days_left < 0) applicable.push(0);
    const pending = applicable.filter((t) => !r.sent.includes(t));
    if (!pending.length) continue;
    const recipients = uniqueEmails([...(settings.notifyResponsible ? [...responsibleEmails(r.responsibles), ...r.notify_emails] : []), ...settings.recipients]);
    out.push({
      id: r.id,
      name: r.name,
      kind: r.kind,
      common_name: r.common_name,
      expires_on: r.expires_on,
      days_left: r.days_left,
      responsibles: r.responsibles,
      plant_code: r.plant_code,
      application_name: r.application_name,
      installed_on: r.installed_on,
      thresholds: pending,
      recipients,
    });
  }
  return out;
}

type OverviewItem = Omit<DueRow, 'sent' | 'notify_emails'>;

/** All watched certificates that are expired or expire within overviewDays (for the overview e-mail). */
export async function overviewItems(db: DbClient, settings: CertificateNotificationSettings, today: string): Promise<OverviewItem[]> {
  const { rows } = await db.query<OverviewItem>(
    `SELECT c.id, c.name, c.kind, c.common_name, c.expires_on::text AS expires_on, (c.expires_on - $1::date) AS days_left,
            c.responsibles, p.code AS plant_code, ap.name AS application_name, c.installed_on
     FROM certificate c LEFT JOIN plant p ON p.id = c.plant_id LEFT JOIN application ap ON ap.id = c.application_id
     WHERE c.status = ANY($2::text[]) AND c.expires_on - $1::date <= $3
     ORDER BY c.expires_on, lower(c.name)`,
    [today, CERT_WATCHED_STATUSES, settings.overviewDays],
  );
  return rows;
}

async function overviewDue(db: DbClient, settings: CertificateNotificationSettings, today: string, force: boolean): Promise<boolean> {
  if (!settings.overviewEnabled || !settings.recipients.length) return false;
  if (force) return true;
  if (isoWeekday(today) !== settings.overviewWeekday) return false;
  const { rows } = await db.query(`SELECT 1 FROM notification_run WHERE kind = $1 AND status = 'ok' AND local_date = $2 LIMIT 1`, [OVERVIEW_KIND, today]);
  return !rows[0];
}

export async function previewCertificates(db: DbClient, now: Date = new Date()): Promise<CertificatePreview> {
  const { settings } = await loadCertificateSettings(db);
  const today = localParts(settings.timezone, now).date;
  const reminders = await computeReminders(db, settings, today);
  const due = await overviewDue(db, settings, today, false);
  const items = await overviewItems(db, settings, today);
  return {
    today,
    reminders: reminders.map(({ kind: _k, installed_on: _i, ...r }) => r),
    unrouted: reminders.filter((r) => !r.recipients.length).length,
    overview: { due, recipients: settings.overviewEnabled ? settings.recipients : [], items: items.length },
  };
}

// ---------------------------------------------------------------------------
// E-mail rendering
// ---------------------------------------------------------------------------

function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

const CELL = 'padding:8px 10px;border-bottom:1px solid #e5e9ef';
const HEAD = 'padding:8px 10px;border-bottom:1px solid #d9dee5';

function frame(opts: { appName: string; brandName: string }, title: string, intro: string, table: string, footer: string) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f5f8;font-family:'Segoe UI',Arial,sans-serif;color:#1f2937">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8;padding:24px 0"><tr><td align="center">
    <table role="presentation" width="760" cellpadding="0" cellspacing="0" style="max-width:760px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;border:1px solid #e5e9ef">
      <tr><td style="background:#0b2a4a;color:#ffffff;padding:16px 24px">
        <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#a9bcd3">${escapeHtml(opts.brandName)}</div>
        <div style="font-size:18px;font-weight:600">${escapeHtml(opts.appName)} – ${escapeHtml(title)}</div>
      </td></tr>
      <tr><td style="padding:20px 24px 8px"><p style="margin:0 0 12px;font-size:14px;line-height:1.5">${intro}</p></td></tr>
      <tr><td style="padding:0 24px 20px">${table}</td></tr>
      <tr><td style="padding:12px 24px 20px;font-size:12px;color:#6b7280;border-top:1px solid #e5e9ef">${footer}</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function certTable(items: OverviewItem[], baseUrl: string, withResponsible: boolean): string {
  const rows = items
    .map((i) => {
      const color = i.days_left < 0 ? '#cf1322' : i.days_left <= 14 ? '#d4380d' : '#1f2937';
      const what = [i.common_name && i.common_name !== i.name ? i.common_name : null, CERT_KIND_META[i.kind]?.label].filter(Boolean).join(' · ');
      return `<tr>
        <td style="${CELL}"><a href="${escapeHtml(`${baseUrl}/certificates?open=${i.id}`)}" style="color:#2563eb;font-weight:600;text-decoration:none">${escapeHtml(i.name)}</a>
          <div style="font-size:12px;color:#6b7280">${escapeHtml(what)}</div></td>
        <td style="${CELL}">${escapeHtml([i.plant_code, i.application_name].filter(Boolean).join(' / ') || i.installed_on || '–')}</td>
        ${withResponsible ? `<td style="${CELL}">${escapeHtml(responsiblesText(i.responsibles) || '–')}</td>` : ''}
        <td style="${CELL};white-space:nowrap">${fmtDate(i.expires_on)}</td>
        <td style="${CELL};white-space:nowrap;color:${color};font-weight:${i.days_left <= 14 ? 700 : 400}">${daysLeftText(i.days_left)}</td>
      </tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">
    <thead><tr style="background:#f7f9fb;text-align:left;color:#4b5563">
      <th style="${HEAD}">Certificate</th><th style="${HEAD}">Used for</th>${withResponsible ? `<th style="${HEAD}">Responsible</th>` : ''}
      <th style="${HEAD}">Expires</th><th style="${HEAD}">Remaining</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function textLines(items: OverviewItem[], baseUrl: string): string[] {
  return items.map(
    (i) =>
      `- ${i.name}${i.common_name && i.common_name !== i.name ? ` (${i.common_name})` : ''} – expires ${fmtDate(i.expires_on)}, ${daysLeftText(i.days_left)}${i.responsibles.length ? `, responsible: ${responsiblesText(i.responsibles)}` : ''}\n  ${baseUrl}/certificates?open=${i.id}`,
  );
}

export function renderReminderMail(items: OverviewItem[], opts: { appName: string; brandName: string; baseUrl: string }) {
  const n = items.length;
  const expired = items.filter((i) => i.days_left < 0).length;
  const first = items[0];
  const subject =
    n === 1
      ? `[${opts.appName}] Certificate ${first.name} ${first.days_left < 0 ? 'has expired' : `expires on ${fmtDate(first.expires_on)}`}`
      : `[${opts.appName}] ${n} certificates ${expired === n ? 'have expired' : expired ? 'expire soon or have expired' : 'expire soon'}`;
  const intro = `${n === 1 ? 'The following certificate' : `The following ${n} certificates`} ${expired === n ? (n === 1 ? 'has' : 'have') : n === 1 ? 'expires soon or has' : 'expire soon or have'} expired. You receive this reminder as the responsible person – please renew or replace ${n === 1 ? 'it' : 'them'} in time and update the expiry date afterwards.`;
  const footer = `Each certificate is reminded once per reminder stage. After the renewal, enter the new expiry date in the ${escapeHtml(opts.appName)} – the reminders then start again for the new date. <a href="${escapeHtml(opts.baseUrl)}/certificates" style="color:#2563eb">Open all certificates</a>.`;
  const html = frame(opts, 'certificate reminder', intro, certTable(items, opts.baseUrl, false), footer);
  const text = [`${opts.appName} – certificate reminder`, '', intro, '', ...textLines(items, opts.baseUrl), '', `All certificates: ${opts.baseUrl}/certificates`].join('\n');
  return { subject, html, text };
}

export function renderOverviewMail(items: OverviewItem[], days: number, opts: { appName: string; brandName: string; baseUrl: string }) {
  const expired = items.filter((i) => i.days_left < 0).length;
  const soon = items.length - expired;
  const subject = `[${opts.appName}] Certificate overview: ${expired ? `${expired} expired, ` : ''}${soon} expiring within ${days} days`;
  const intro = `Overview of all certificates that ${expired ? 'have expired or ' : ''}expire within the next ${days} days (${items.length} in total). Certificates with the status “Replaced” or “Retired” are not listed.`;
  const footer = `You receive this overview because you are a recipient of certificate notifications in the ${escapeHtml(opts.appName)}. <a href="${escapeHtml(opts.baseUrl)}/certificates" style="color:#2563eb">Open all certificates</a>.`;
  const html = frame(opts, 'certificate overview', intro, certTable(items, opts.baseUrl, true), footer);
  const text = [`${opts.appName} – certificate overview`, '', intro, '', ...textLines(items, opts.baseUrl), '', `All certificates: ${opts.baseUrl}/certificates`].join('\n');
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

async function startRun(pool: Pool, kind: string, trigger: 'schedule' | 'manual', today: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`INSERT INTO notification_run (kind, trigger, local_date) VALUES ($1, $2, $3) RETURNING id::text`, [kind, trigger, today]);
  return rows[0].id;
}

async function finishRun(pool: Pool, id: string, patch: { status: 'ok' | 'error' | 'skipped'; items?: number; emails?: number; error?: string | null }) {
  await pool.query(`UPDATE notification_run SET status = $2, items = $3, emails = $4, error = $5, finished_at = now() WHERE id = $1`, [
    id,
    patch.status,
    patch.items ?? 0,
    patch.emails ?? 0,
    patch.error ?? null,
  ]);
}

/**
 * Sends the due reminders (to the responsible persons and the general recipients) and – on the configured weekday or
 * when forced – the overview e-mail to the general recipients.
 */
export async function runCertificateJob(
  pool: Pool,
  config: Config,
  opts: { trigger: 'schedule' | 'manual'; now?: Date; /** auto = on the configured weekday (scheduler), force = now, skip = reminders only */ overview?: 'auto' | 'force' | 'skip' },
): Promise<CertificateRunResult> {
  const now = opts.now ?? new Date();
  const { settings } = await loadCertificateSettings(pool);
  const today = localParts(settings.timezone, now).date;
  const runId = await startRun(pool, KIND, opts.trigger, today);
  const skip = async (error: string): Promise<CertificateRunResult> => {
    await finishRun(pool, runId, { status: 'skipped', error });
    return { status: 'skipped', error, reminders: 0, emails: 0, overview: false };
  };

  if (!settings.enabled) return skip('Certificate notifications are disabled.');
  const { settings: smtp } = await loadSmtpSettings(pool);
  if (!isSmtpConfigured(smtp)) return skip('The e-mail server (SMTP) is not configured.');
  const mailOpts = { appName: config.ui.appName, brandName: config.ui.brandName, baseUrl: config.baseUrl };

  const client: PoolClient = await pool.connect();
  let emails = 0;
  let reminded = 0;
  try {
    await client.query('BEGIN');
    const due = await computeReminders(client, settings, today);
    // claim the reminder stages first – concurrent runs only send what they inserted
    const claimed: typeof due = [];
    for (const item of due) {
      if (!item.recipients.length) continue;
      let any = false;
      for (const threshold of item.thresholds) {
        const res = await client.query(
          `INSERT INTO certificate_notification (certificate_id, threshold_days, expires_on, recipients) VALUES ($1,$2,$3,$4)
           ON CONFLICT (certificate_id, threshold_days, expires_on) DO NOTHING RETURNING id`,
          [item.id, threshold, item.expires_on, item.recipients],
        );
        if (res.rowCount) any = true;
      }
      if (any) claimed.push(item);
    }
    const byRecipient = new Map<string, { email: string; items: typeof due }>();
    for (const item of claimed) {
      for (const email of item.recipients) {
        const key = email.toLowerCase();
        if (!byRecipient.has(key)) byRecipient.set(key, { email, items: [] });
        byRecipient.get(key)!.items.push(item);
      }
    }
    for (const r of byRecipient.values()) {
      await sendMail(config, smtp, { to: r.email, ...renderReminderMail(r.items as unknown as OverviewItem[], mailOpts) });
      emails++;
    }
    await client.query('COMMIT');
    reminded = claimed.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const message = describeMailError(err);
    log.error('notifications: certificate reminders failed', { error: message });
    await finishRun(pool, runId, { status: 'error', error: message });
    return { status: 'error', error: message, reminders: 0, emails: 0, overview: false };
  } finally {
    client.release();
  }

  // weekly overview to the general recipients
  let overview = false;
  try {
    const mode = opts.overview ?? 'auto';
    if (mode !== 'skip' && (await overviewDue(pool, settings, today, mode === 'force'))) {
      const items = await overviewItems(pool, settings, today);
      if (items.length) {
        const overviewRun = await startRun(pool, OVERVIEW_KIND, opts.trigger, today);
        const mail = renderOverviewMail(items, settings.overviewDays, mailOpts);
        for (const to of settings.recipients) {
          await sendMail(config, smtp, { to, ...mail });
          emails++;
        }
        await finishRun(pool, overviewRun, { status: 'ok', items: items.length, emails: settings.recipients.length });
        overview = true;
      }
    }
  } catch (err) {
    const message = describeMailError(err);
    log.error('notifications: certificate overview failed', { error: message });
    await finishRun(pool, runId, { status: 'error', items: reminded, emails, error: `Overview: ${message}` });
    return { status: 'error', error: message, reminders: reminded, emails, overview: false };
  }

  await finishRun(pool, runId, { status: 'ok', items: reminded, emails });
  if (emails) log.info('notifications: certificate e-mails sent', { reminders: reminded, emails, overview, trigger: opts.trigger });
  return { status: 'ok', error: null, reminders: reminded, emails, overview };
}

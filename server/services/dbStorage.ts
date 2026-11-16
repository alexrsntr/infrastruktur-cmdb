import type { Pool } from 'pg';
import {
  DB_STORAGE_LEVEL_RANK,
  DEFAULT_DB_STORAGE_SETTINGS,
  READ_ONLY_PERCENT,
  formatLimit,
  formatStorage,
  gbToBytes,
  storageLevel,
  storagePercent,
  type DbStorageCheckResult,
  type DbStorageDetails,
  type DbStorageLevel,
  type DbStorageNotification,
  type DbStorageSettings,
  type DbStorageStatus,
  type DbStorageTable,
} from '../../shared/dbStorage';
import type { Config } from '../config';
import type { DbClient } from '../db/pool';
import { log } from '../lib/log';
import { describeMailError, escapeHtml, isSmtpConfigured, loadSmtpSettings, readSetting, sendMail, writeSetting } from './mailer';

export const DB_STORAGE_KEY = 'monitoring.db-storage';
/** Level of the last e-mail – a new e-mail is only sent when the level rises above it */
const STATE_KEY = 'monitoring.db-storage.state';
/** The level only drops (and can be reported again) once the fill level is this far below its threshold */
const HYSTERESIS_PERCENT = 5;

interface StoredState {
  /** level that was last reported (or that the fill level dropped back to) */
  level: DbStorageLevel;
  last: DbStorageNotification | null;
}

export async function loadDbStorageSettings(db: DbClient, config: Config): Promise<{ settings: DbStorageSettings; updatedAt: string | null }> {
  const row = await readSetting<Partial<DbStorageSettings>>(db, DB_STORAGE_KEY);
  return {
    settings: { ...DEFAULT_DB_STORAGE_SETTINGS, limitGb: config.db.storageLimitGb, ...(row?.value ?? {}) },
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function saveDbStorageSettings(db: DbClient, settings: DbStorageSettings, userId: string | null) {
  await writeSetting(db, DB_STORAGE_KEY, settings, userId);
}

/**
 * Space used on the server: all databases the app can see plus the write-ahead log (when the app may list it).
 * Azure counts a little more (server logs, system databases), which the thresholds leave room for.
 */
export async function measureDbStorage(db: DbClient): Promise<{ database: number; otherDatabases: number; wal: number | null; used: number }> {
  const { rows } = await db.query<{ own: number; other: number }>(
    `SELECT coalesce(sum(pg_database_size(oid)) FILTER (WHERE datname = current_database()), 0)::bigint AS own,
            coalesce(sum(pg_database_size(oid)) FILTER (WHERE datname <> current_database()), 0)::bigint AS other
     FROM pg_database WHERE datallowconn AND has_database_privilege(oid, 'CONNECT')`,
  );
  let wal: number | null = null;
  try {
    const res = await db.query<{ wal: number }>('SELECT coalesce(sum(size), 0)::bigint AS wal FROM pg_ls_waldir()');
    wal = res.rows[0].wal;
  } catch {
    // needs the pg_monitor role – without it the thresholds have to cover the log
  }
  const database = Number(rows[0].own);
  const otherDatabases = Number(rows[0].other);
  return { database, otherDatabases, wal, used: database + otherDatabases + (wal ?? 0) };
}

const TABLE_LABELS: Record<string, string> = {
  file_blob: 'Files (photos, plans, documents)',
  floor: 'Floors incl. floor plan images',
  audit_log: 'Audit log',
  activity: 'Activity log',
  asset: 'Devices',
  asset_port: 'Device ports',
  user_session: 'Sign-in sessions',
  discovery_item: 'Discovered devices',
  event_outbox: 'Webhook queue',
  webhook_delivery: 'Webhook deliveries',
  notification_log: 'Sent notifications',
  note: 'Notes',
  attachment: 'File list',
  asset_relation: 'Device relations',
  asset_external_ref: 'External device references',
  plan_marker: 'Plan markers',
  plant: 'Plants',
  building: 'Buildings',
  rack: 'Racks',
  rack_item: 'Rack items',
  certificate: 'Certificates',
  certificate_notification: 'Certificate reminders sent',
  application: 'Applications',
  application_asset: 'Application devices',
  datacenter: 'Server rooms / data centers',
  subnet: 'Subnets',
  vlan: 'VLANs',
  plant_score: 'Scorecards',
  wan_line: 'WAN lines',
  notification_run: 'Notification runs',
  app_user: 'Users',
  app_setting: 'Settings',
};

/** The largest tables including their indexes and TOAST data – shows what fills the database */
export async function largestTables(db: DbClient, limit = 8): Promise<DbStorageTable[]> {
  const { rows } = await db.query<{ name: string; bytes: number }>(
    `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'm') AND n.nspname = current_schema()
     ORDER BY 2 DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ name: r.name, label: TABLE_LABELS[r.name] ?? r.name, bytes: Number(r.bytes) }));
}

function toStatus(used: number, settings: DbStorageSettings, now: Date): DbStorageStatus {
  const percent = storagePercent(used, settings.limitGb);
  return {
    level: storageLevel(percent, settings),
    usedBytes: used,
    limitBytes: settings.limitGb > 0 ? gbToBytes(settings.limitGb) : null,
    percent,
    warnPercent: settings.warnPercent,
    criticalPercent: settings.criticalPercent,
    checkedAt: now.toISOString(),
  };
}

export async function dbStorageStatus(db: DbClient, config: Config, now: Date = new Date()): Promise<DbStorageStatus> {
  const { settings } = await loadDbStorageSettings(db, config);
  const { used } = await measureDbStorage(db);
  return toStatus(used, settings, now);
}

export async function dbStorageDetails(db: DbClient, config: Config, now: Date = new Date()): Promise<DbStorageDetails> {
  const { settings, updatedAt } = await loadDbStorageSettings(db, config);
  const measured = await measureDbStorage(db);
  const state = await readSetting<StoredState>(db, STATE_KEY);
  const { settings: smtp } = await loadSmtpSettings(db);
  return {
    ...toStatus(measured.used, settings, now),
    settings,
    updatedAt,
    breakdown: { database: measured.database, otherDatabases: measured.otherDatabases, wal: measured.wal },
    tables: await largestTables(db),
    lastNotification: state?.value.last ?? null,
    smtpConfigured: isSmtpConfigured(smtp),
  };
}

async function recipientsFor(db: DbClient, settings: DbStorageSettings): Promise<string[]> {
  const list = [...settings.recipients];
  if (settings.notifyAdmins) {
    const { rows } = await db.query<{ email: string }>(`SELECT email FROM app_user WHERE role = 'admin' AND active AND email IS NOT NULL AND email <> '' ORDER BY email`);
    list.push(...rows.map((r) => r.email));
  }
  const seen = new Map<string, string>();
  for (const e of list) if (!seen.has(e.toLowerCase())) seen.set(e.toLowerCase(), e);
  return [...seen.values()];
}

export function renderDbStorageMail(status: DbStorageStatus, opts: { appName: string; brandName: string; baseUrl: string; limitGb: number; tables: DbStorageTable[] }) {
  const critical = status.level === 'critical';
  const pct = `${status.percent} %`;
  const subject = `[${opts.appName}] ${critical ? 'Critical: ' : ''}database storage ${pct} full`;
  const used = `${formatStorage(status.usedBytes)} of ${formatLimit(opts.limitGb)}`;
  const advice =
    'Increase the storage of the PostgreSQL server in the Azure portal (server → Compute + storage) or enable storage auto-grow, ' +
    `then enter the new size in ${opts.appName} under Settings → Database storage.`;
  const readOnly = `At ${READ_ONLY_PERCENT} % Azure switches the database to read-only: nothing can be saved anymore and nobody can sign in.`;
  const settingsUrl = `${opts.baseUrl}/admin/settings?tab=storage`;
  const color = critical ? '#cf1322' : '#d48806';
  const rows = opts.tables
    .slice(0, 5)
    .map((t) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e9ef">${escapeHtml(t.label)}</td><td style="padding:6px 10px;border-bottom:1px solid #e5e9ef;text-align:right">${escapeHtml(formatStorage(t.bytes))}</td></tr>`)
    .join('');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f5f8;font-family:'Segoe UI',Arial,sans-serif;color:#1f2937">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8;padding:24px 0"><tr><td align="center">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;border:1px solid #e5e9ef">
      <tr><td style="background:#0b2a4a;color:#ffffff;padding:16px 24px">
        <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#a9bcd3">${escapeHtml(opts.brandName)}</div>
        <div style="font-size:18px;font-weight:600">${escapeHtml(opts.appName)} – database storage</div>
      </td></tr>
      <tr><td style="padding:20px 24px 8px;font-size:14px;line-height:1.5">
        <p style="margin:0 0 12px;font-size:22px;font-weight:700;color:${color}">${escapeHtml(pct)} full</p>
        <p style="margin:0 0 12px">The database uses <b>${escapeHtml(used)}</b>.</p>
        <p style="margin:0 0 12px">${escapeHtml(advice)}</p>
        <p style="margin:0 0 12px;color:${color}">${escapeHtml(readOnly)}</p>
      </td></tr>
      ${rows ? `<tr><td style="padding:0 24px 16px"><div style="font-size:13px;color:#6b7280;margin-bottom:4px">Largest tables</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">${rows}</table></td></tr>` : ''}
      <tr><td style="padding:12px 24px 20px;font-size:12px;color:#6b7280;border-top:1px solid #e5e9ef"><a href="${escapeHtml(settingsUrl)}" style="color:#2563eb">Open the storage settings</a> · You get this e-mail once per level (warning, critical).</td></tr>
    </table>
  </td></tr></table></body></html>`;
  const text = [`${opts.appName} – database storage ${pct} full`, '', `The database uses ${used}.`, '', advice, '', readOnly, '', settingsUrl].join('\n');
  return { subject, html, text };
}

/**
 * Measures the storage and e-mails the recipients when the fill level reaches a higher level than the last e-mail
 * (ok → warning → critical). Falling below a threshold (minus a small margin) re-arms the e-mail.
 * Callers serialise runs (scheduler advisory lock), so two instances never send the same e-mail.
 */
export async function checkDbStorage(pool: Pool, config: Config, now: Date = new Date()): Promise<DbStorageCheckResult> {
  const { settings } = await loadDbStorageSettings(pool, config);
  const measured = await measureDbStorage(pool);
  const status = toStatus(measured.used, settings, now);
  if (status.level === 'off' || status.percent == null) return { status, emails: 0, error: null };

  const level: DbStorageLevel = status.level;
  const state = (await readSetting<StoredState>(pool, STATE_KEY))?.value ?? null;
  const notified: DbStorageLevel = state?.level ?? 'ok';

  if (DB_STORAGE_LEVEL_RANK[level] < DB_STORAGE_LEVEL_RANK[notified]) {
    const threshold = notified === 'critical' ? settings.criticalPercent : settings.warnPercent;
    if (status.percent < threshold - HYSTERESIS_PERCENT) {
      await writeSetting(pool, STATE_KEY, { level, last: state?.last ?? null } satisfies StoredState, null);
    }
    return { status, emails: 0, error: null };
  }
  if (DB_STORAGE_LEVEL_RANK[level] === DB_STORAGE_LEVEL_RANK[notified]) return { status, emails: 0, error: null };

  // the level rose
  const remember = (recipients: number) =>
    writeSetting(pool, STATE_KEY, { level, last: recipients ? { level, percent: status.percent!, at: now.toISOString(), recipients } : (state?.last ?? null) } satisfies StoredState, null);
  if (!settings.emailEnabled) {
    await remember(0);
    return { status, emails: 0, error: null };
  }
  const { settings: smtp } = await loadSmtpSettings(pool);
  // without an e-mail server only the banner warns; the e-mail follows once SMTP is configured
  if (!isSmtpConfigured(smtp)) return { status, emails: 0, error: 'The e-mail server (SMTP) is not configured.' };
  const recipients = await recipientsFor(pool, settings);
  if (!recipients.length) {
    // nothing remembered: the e-mail follows once a recipient exists
    return { status, emails: 0, error: 'No recipients: no administrator has an e-mail address and no additional recipient is set.' };
  }
  const mail = renderDbStorageMail(status, {
    appName: config.ui.appName,
    brandName: config.ui.brandName,
    baseUrl: config.baseUrl,
    limitGb: settings.limitGb,
    tables: await largestTables(pool, 5),
  });
  let emails = 0;
  try {
    for (const to of recipients) {
      await sendMail(config, smtp, { to, ...mail });
      emails++;
    }
  } catch (err) {
    const message = describeMailError(err);
    log.error('db storage: e-mail failed', { error: message, sent: emails });
    if (emails) await remember(emails);
    return { status, emails, error: message };
  }
  await remember(emails);
  log.warn('db storage: threshold reached', { level, percent: status.percent, emails });
  return { status, emails, error: null };
}

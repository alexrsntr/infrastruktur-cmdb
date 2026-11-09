import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ASSET_STATUSES } from '../../shared/model';
import { SMTP_SECURITY, type NotificationLogEntry, type NotificationRun, type NotificationSettingsDto } from '../../shared/notifications';
import type { Config } from '../config';
import { requirePermission } from '../auth/context';
import { audit, diff } from '../lib/audit';
import { badRequest, clampInt, parse } from '../lib/http';
import { encryptSecret } from '../lib/secrets';
import {
  SMTP_KEY,
  describeMailError,
  escapeHtml,
  loadSmtpSettings,
  sendMail,
  smtpToDto,
  writeSetting,
  type StoredSmtpSettings,
} from '../services/mailer';
import { ASSET_TYPES_KEY, assetTypeSettingsSchema, loadAssetTypeSettings, normaliseAssetTypeSettings } from '../services/assetTypes';
import { WARRANTY_KEY, isValidTimezone, loadWarrantySettings, localParts, nextRunAt, previewWarranty, runWarrantyJob } from '../services/warrantyNotifications';

const email = z.string().trim().toLowerCase().email('Invalid e-mail address').max(254);

const emailSettingsSchema = z.object({
  host: z.string().trim().max(255).default(''),
  port: z.number().int().min(1).max(65535),
  security: z.enum(SMTP_SECURITY),
  username: z.string().trim().max(255).default(''),
  password: z.string().max(1024).nullish(),
  fromAddress: z.union([email, z.literal('')]).default(''),
  fromName: z.string().trim().max(120).default(''),
  allowInvalidCertificates: z.boolean().default(false),
});

const warrantySettingsSchema = z.object({
  enabled: z.boolean(),
  thresholds: z
    .array(z.number().int().min(0).max(730))
    .max(12)
    .transform((t) => [...new Set(t)].sort((a, b) => b - a)),
  includeExpired: z.boolean(),
  sendHour: z.number().int().min(0).max(23),
  timezone: z.string().refine(isValidTimezone, 'Unknown time zone'),
  recipients: z.array(email).max(100).transform((l) => [...new Set(l)]),
  plantRecipients: z.record(z.string().uuid(), z.array(email).max(50)).default({}),
  excludeStatuses: z.array(z.enum(ASSET_STATUSES)).default(['retired']),
});

const RUN_SELECT = `id::text, kind, started_at, finished_at, trigger, local_date::text, items, emails, status, error`;

export function settingsRouter(pool: Pool, config: Config): Router {
  const r = Router();

  // ------------------------------------------------------------ device types
  // readable by everyone: forms and lists need the hidden types and the additional fields
  r.get('/asset-types', async (_req, res) => {
    res.json(await loadAssetTypeSettings(pool));
  });
  r.use(['/settings', '/notifications'], requirePermission('settings.manage'));

  r.put('/settings/asset-types', async (req, res) => {
    const next = normaliseAssetTypeSettings(parse(assetTypeSettingsSchema, req.body));
    const before = await loadAssetTypeSettings(pool);
    await writeSetting(pool, ASSET_TYPES_KEY, next, req.user!.id);
    const changes = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    if (Object.keys(changes).length) await audit(pool, req, { action: 'settings.update', entityType: 'settings', entityLabel: 'Device types', changes });
    res.json(await loadAssetTypeSettings(pool));
  });

  // ------------------------------------------------------------ e-mail (SMTP)
  r.get('/settings/email', async (_req, res) => {
    const { settings, updatedAt } = await loadSmtpSettings(pool);
    res.json(smtpToDto(config, settings, updatedAt));
  });

  r.put('/settings/email', async (req, res) => {
    const input = parse(emailSettingsSchema, req.body);
    const { settings: before } = await loadSmtpSettings(pool);
    let passwordEnc = before.passwordEnc;
    let passwordChange: string | null = null;
    if (input.password === null) {
      passwordChange = before.passwordEnc ? 'removed' : null;
      passwordEnc = null;
    } else if (typeof input.password === 'string' && input.password !== '') {
      passwordEnc = encryptSecret(config, input.password);
      passwordChange = 'changed';
    }
    const next: StoredSmtpSettings = {
      host: input.host,
      port: input.port,
      security: input.security,
      username: input.username,
      passwordEnc: input.username ? passwordEnc : null,
      fromAddress: input.fromAddress,
      fromName: input.fromName,
      allowInvalidCertificates: input.allowInvalidCertificates,
    };
    if (!next.username && before.passwordEnc) passwordChange = 'removed';
    await writeSetting(pool, SMTP_KEY, next, req.user!.id);

    const strip = ({ passwordEnc: _p, ...rest }: StoredSmtpSettings) => rest;
    const changes: Record<string, unknown> = diff(strip(before), strip(next));
    if (passwordChange) changes.password = { from: '••••', to: passwordChange };
    if (Object.keys(changes).length)
      await audit(pool, req, { action: 'settings.update', entityType: 'settings', entityLabel: 'E-mail server (SMTP)', changes });
    const { settings, updatedAt } = await loadSmtpSettings(pool);
    res.json(smtpToDto(config, settings, updatedAt));
  });

  r.post('/settings/email/test', async (req, res) => {
    const { to } = parse(z.object({ to: email }), req.body);
    const { settings } = await loadSmtpSettings(pool);
    try {
      const info = await sendMail(config, settings, {
        to,
        subject: `[${config.ui.appName}] Test e-mail`,
        text: `This is a test e-mail from the ${config.ui.appName}.\n\nSMTP server: ${settings.host}:${settings.port} (${settings.security})\nSent by: ${req.user!.displayName}\n\nIf you can read this, e-mail notifications are configured correctly.`,
        html: `<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:14px;color:#1f2937">
          <p><strong>This is a test e-mail from the ${escapeHtml(config.ui.appName)}.</strong></p>
          <p>SMTP server: ${escapeHtml(settings.host)}:${settings.port} (${escapeHtml(settings.security)})<br>Sent by: ${escapeHtml(req.user!.displayName)}</p>
          <p>If you can read this, e-mail notifications are configured correctly.</p></div>`,
      });
      await audit(pool, req, { action: 'settings.test-mail', entityType: 'settings', entityLabel: 'E-mail server (SMTP)', changes: { to, result: 'sent' } });
      res.json({ ok: true, message: `Test e-mail sent to ${to}${info.messageId ? ` (message id ${info.messageId})` : ''}.` });
    } catch (err) {
      const message = describeMailError(err);
      await audit(pool, req, { action: 'settings.test-mail', entityType: 'settings', entityLabel: 'E-mail server (SMTP)', changes: { to, result: 'failed', error: message } });
      throw badRequest(message);
    }
  });

  // ------------------------------------------------- warranty notifications
  async function notificationDto(): Promise<NotificationSettingsDto> {
    const { settings, updatedAt } = await loadWarrantySettings(pool);
    const { rows } = await pool.query<NotificationRun>(`SELECT ${RUN_SELECT} FROM notification_run WHERE kind = 'warranty' ORDER BY started_at DESC LIMIT 1`);
    const today = localParts(settings.timezone).date;
    const done = await pool.query(`SELECT 1 FROM notification_run WHERE kind = 'warranty' AND trigger = 'schedule' AND status = 'ok' AND local_date = $1 LIMIT 1`, [today]);
    return { ...settings, updatedAt, lastRun: rows[0] ?? null, nextRun: nextRunAt(settings, !!done.rows[0]) };
  }

  r.get('/settings/notifications', async (_req, res) => {
    res.json(await notificationDto());
  });

  r.put('/settings/notifications', async (req, res) => {
    const input = parse(warrantySettingsSchema, req.body);
    const plantIds = Object.keys(input.plantRecipients);
    if (plantIds.length) {
      const { rows } = await pool.query<{ id: string }>('SELECT id FROM plant WHERE id = ANY($1::uuid[])', [plantIds]);
      const known = new Set(rows.map((x) => x.id));
      const unknown = plantIds.filter((id) => !known.has(id));
      if (unknown.length) throw badRequest(`Unknown plant(s): ${unknown.join(', ')}`);
    }
    // Drop empty plant entries
    const plantRecipients = Object.fromEntries(Object.entries(input.plantRecipients).filter(([, l]) => l.length).map(([k, l]) => [k, [...new Set(l)]]));
    const next = { ...input, plantRecipients };
    const { settings: before } = await loadWarrantySettings(pool);
    await writeSetting(pool, WARRANTY_KEY, next, req.user!.id);
    const changes = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    if (Object.keys(changes).length)
      await audit(pool, req, { action: 'settings.update', entityType: 'settings', entityLabel: 'Warranty notifications', changes });
    res.json(await notificationDto());
  });

  r.get('/notifications/warranty/preview', async (_req, res) => {
    res.json(await previewWarranty(pool));
  });

  r.post('/notifications/warranty/run', async (req, res) => {
    const result = await runWarrantyJob(pool, config, { trigger: 'manual' });
    await audit(pool, req, {
      action: 'notifications.run',
      entityType: 'settings',
      entityLabel: 'Warranty notifications',
      changes: { status: result.run.status, items: result.run.items, emails: result.run.emails, error: result.run.error },
    });
    res.json(result);
  });

  r.get('/notifications/runs', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const { rows } = await pool.query<NotificationRun>(`SELECT ${RUN_SELECT} FROM notification_run ORDER BY started_at DESC LIMIT ${limit}`);
    res.json(rows);
  });

  r.get('/notifications/log', async (req, res) => {
    const limit = clampInt(req.query.limit, 100, 1, 1000);
    const { rows } = await pool.query<NotificationLogEntry>(
      `SELECT l.id::text, l.kind, l.asset_id, a.name AS asset_name, a.type AS asset_type, p.code AS plant_code,
              l.threshold_days, l.warranty_end::text, l.recipients, l.sent_at
       FROM notification_log l LEFT JOIN asset a ON a.id = l.asset_id LEFT JOIN plant p ON p.id = a.plant_id
       ORDER BY l.sent_at DESC, a.name LIMIT ${limit}`,
    );
    res.json(rows);
  });

  return r;
}

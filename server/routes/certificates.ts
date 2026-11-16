import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  CERT_DAYS,
  CERT_KINDS,
  CERT_STATUSES,
  CERT_WATCHED_STATUSES,
  MAX_CERT_RESPONSIBLES,
  type Certificate,
  type CertificateCounts,
  type CertificateList,
  type CertificateNotificationSettingsDto,
} from '../../shared/certificates';
import type { CurrentUser } from '../../shared/model';
import type { Config } from '../config';
import { requirePermission } from '../auth/context';
import { withTransaction, type DbClient } from '../db/pool';
import { audit, diff, snapshot } from '../lib/audit';
import { badRequest, likePattern, notFound, parse, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { optDate, optText, optUuid, reqText } from '../lib/schemas';
import { assertPlantAccess, hasPlantAccess, isUnscoped } from '../lib/scope';
import { writeSetting } from '../services/mailer';
import { CERTIFICATE_KEY, loadCertificateSettings, previewCertificates, runCertificateJob } from '../services/certificateNotifications';
import { isValidTimezone } from '../services/warrantyNotifications';

const email = z.string().trim().toLowerCase().email('Invalid e-mail address').max(254);

const responsibleSchema = z
  .object({
    name: optText(200),
    email: z.union([email, z.literal(''), z.null()]).optional().transform((v) => v || null),
  })
  .transform((r) => ({ name: r.name ?? null, email: r.email ?? null }));

/** At least one responsible person has an e-mail address (otherwise nobody of them is reminded) */
const SQL_HAS_RESPONSIBLE_EMAIL = `jsonb_path_exists(c.responsibles, '$[*] ? (@.email != null && @.email != "")')`;

const certificateSchema = z
  .object({
    name: reqText(200),
    kind: z.enum(CERT_KINDS).default('tls'),
    status: z.enum(CERT_STATUSES).default('active'),
    common_name: optText(500),
    sans: optText(4000),
    issuer: optText(300),
    serial_number: optText(200),
    valid_from: optDate,
    expires_on: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected date YYYY-MM-DD'),
    auto_renew: z.boolean().default(false),
    installed_on: optText(1000),
    plant_id: optUuid,
    application_id: optUuid,
    asset_id: optUuid,
    responsibles: z.array(responsibleSchema).max(MAX_CERT_RESPONSIBLES, `At most ${MAX_CERT_RESPONSIBLES} responsible persons`).optional(),
    // earlier API version: one person
    responsible: optText(200),
    responsible_email: z.union([email, z.literal(''), z.null()]).optional().transform((v) => v || null),
    notify_emails: z.array(email).max(20).default([]).transform((l) => [...new Set(l)]),
    description: optText(8000),
  })
  .refine((v) => !v.valid_from || v.valid_from <= v.expires_on, { message: 'The certificate must be valid before it expires', path: ['valid_from'] })
  .transform(({ responsible, responsible_email, ...v }) => {
    const list = v.responsibles ?? (responsible || responsible_email ? [{ name: responsible ?? null, email: responsible_email ?? null }] : []);
    // empty rows are dropped, the same address only once
    const seen = new Set<string>();
    const responsibles = list.filter((r) => {
      if (!r.name && !r.email) return false;
      if (!r.email) return true;
      if (seen.has(r.email)) return false;
      seen.add(r.email);
      return true;
    });
    return { ...v, responsibles };
  });

const settingsSchema = z.object({
  enabled: z.boolean(),
  thresholds: z
    .array(z.number().int().min(1).max(730))
    .max(12)
    .transform((t) => [...new Set(t)].sort((a, b) => b - a)),
  includeExpired: z.boolean(),
  notifyResponsible: z.boolean(),
  recipients: z.array(email).max(100).transform((l) => [...new Set(l)]),
  overviewEnabled: z.boolean(),
  overviewWeekday: z.number().int().min(1).max(7),
  overviewDays: z.number().int().min(7).max(730),
  sendHour: z.number().int().min(0).max(23),
  timezone: z.string().refine(isValidTimezone, 'Unknown time zone'),
});

const CERT_SELECT = `c.id, c.name, c.kind, c.status, c.common_name, c.sans, c.issuer, c.serial_number, c.valid_from::text AS valid_from,
  c.expires_on::text AS expires_on, c.auto_renew, c.installed_on, c.plant_id, p.code AS plant_code, p.name AS plant_name,
  c.application_id, ap.name AS application_name, c.asset_id, a.name AS asset_name, c.responsibles, c.notify_emails,
  c.description, (c.expires_on - CURRENT_DATE) AS days_left,
  (SELECT max(n.sent_at) FROM certificate_notification n WHERE n.certificate_id = c.id) AS last_notified_at,
  c.created_at, c.updated_at`;
const CERT_FROM = `FROM certificate c LEFT JOIN plant p ON p.id = c.plant_id LEFT JOIN application ap ON ap.id = c.application_id LEFT JOIN asset a ON a.id = c.asset_id`;

/** Certificates without a plant (central, e.g. the wildcard certificate) are visible to everyone, the others within the plant scope. */
function scopeCerts(sql: SqlBuilder, user: CurrentUser) {
  if (isUnscoped(user)) return;
  sql.and(`(c.plant_id IS NULL OR c.plant_id = ANY(${sql.p(user.plantScope)}::uuid[]))`);
}

async function loadCert(db: DbClient, user: CurrentUser, id: string): Promise<Certificate> {
  const { rows } = await db.query<Certificate>(`SELECT ${CERT_SELECT} ${CERT_FROM} WHERE c.id = $1`, [id]);
  const cert = rows[0];
  if (!cert || (cert.plant_id && !hasPlantAccess(user, cert.plant_id))) throw notFound('Certificate');
  return cert;
}

/** The linked application and device must exist and be visible to the user */
async function checkLinks(db: DbClient, user: CurrentUser, input: { application_id: string | null; asset_id: string | null }) {
  if (input.application_id) {
    const { rows } = await db.query('SELECT plant_id FROM application WHERE id = $1', [input.application_id]);
    if (!rows[0] || (rows[0].plant_id && !hasPlantAccess(user, rows[0].plant_id))) throw badRequest('The application does not exist');
  }
  if (input.asset_id) {
    const { rows } = await db.query('SELECT plant_id FROM asset WHERE id = $1', [input.asset_id]);
    if (!rows[0] || !hasPlantAccess(user, rows[0].plant_id)) throw badRequest('The device does not exist');
  }
}

export function certificatesRouter(pool: Pool, config: Config): Router {
  const r = Router();

  r.get('/certificates', async (req, res) => {
    const user = req.user!;
    const base = new SqlBuilder();
    scopeCerts(base, user);
    const plantId = queryString(req.query.plantId);
    if (plantId) base.and(`c.plant_id = ${base.p(requireUuid(plantId, 'plantId'))}`);
    const applicationId = queryString(req.query.applicationId);
    if (applicationId) base.and(`c.application_id = ${base.p(requireUuid(applicationId, 'applicationId'))}`);
    const assetId = queryString(req.query.assetId);
    if (assetId) base.and(`c.asset_id = ${base.p(requireUuid(assetId, 'assetId'))}`);

    // counters over the watched certificates (independent of search and the due filter)
    const { rows: countRows } = await pool.query<CertificateCounts>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE c.status = ANY(${base.p(CERT_WATCHED_STATUSES)}::text[]) AND c.expires_on < CURRENT_DATE)::int AS expired,
              count(*) FILTER (WHERE c.status = ANY($${base.params.length}::text[]) AND c.expires_on >= CURRENT_DATE AND c.expires_on - CURRENT_DATE <= ${CERT_DAYS.critical})::int AS critical,
              count(*) FILTER (WHERE c.status = ANY($${base.params.length}::text[]) AND c.expires_on - CURRENT_DATE > ${CERT_DAYS.critical} AND c.expires_on - CURRENT_DATE <= ${CERT_DAYS.warning})::int AS warning,
              count(*) FILTER (WHERE c.status = ANY($${base.params.length}::text[]) AND NOT ${SQL_HAS_RESPONSIBLE_EMAIL})::int AS no_responsible
       ${CERT_FROM} ${base.whereSql()}`,
      base.params,
    );

    const sql = new SqlBuilder();
    scopeCerts(sql, user);
    if (plantId) sql.and(`c.plant_id = ${sql.p(plantId)}`);
    if (applicationId) sql.and(`c.application_id = ${sql.p(applicationId)}`);
    if (assetId) sql.and(`c.asset_id = ${sql.p(assetId)}`);
    const q = queryString(req.query.q);
    if (q) {
      const like = sql.p(likePattern(q));
      sql.and(`(c.name ILIKE ${like} OR c.common_name ILIKE ${like} OR c.sans ILIKE ${like} OR c.responsibles::text ILIKE ${like}
                OR c.issuer ILIKE ${like} OR c.installed_on ILIKE ${like} OR ap.name ILIKE ${like} OR a.name ILIKE ${like})`);
    }
    const status = queryString(req.query.status);
    if (status) {
      if (!CERT_STATUSES.includes(status as never)) throw badRequest('Unknown status');
      sql.and(`c.status = ${sql.p(status)}`);
    }
    const due = queryString(req.query.due);
    if (due === 'expired') sql.and(`c.status = ANY(${sql.p(CERT_WATCHED_STATUSES)}::text[]) AND c.expires_on < CURRENT_DATE`);
    else if (due === 'soon') sql.and(`c.status = ANY(${sql.p(CERT_WATCHED_STATUSES)}::text[]) AND c.expires_on - CURRENT_DATE <= ${CERT_DAYS.warning}`);
    else if (due === 'no_responsible') sql.and(`c.status = ANY(${sql.p(CERT_WATCHED_STATUSES)}::text[]) AND NOT ${SQL_HAS_RESPONSIBLE_EMAIL}`);
    else if (due) throw badRequest('Unknown filter');

    const { rows } = await pool.query<Certificate>(
      `SELECT ${CERT_SELECT} ${CERT_FROM} ${sql.whereSql()}
       ORDER BY (c.status = ANY(ARRAY['replaced','retired'])), c.expires_on, lower(c.name)`,
      sql.params,
    );
    const body: CertificateList = { items: rows, counts: countRows[0] };
    res.json(body);
  });

  r.get('/certificates/:id', async (req, res) => {
    res.json(await loadCert(pool, req.user!, requireUuid(req.params.id)));
  });

  r.post('/certificates', requirePermission('asset.write'), async (req, res) => {
    const input = parse(certificateSchema, req.body);
    assertPlantAccess(req.user!, input.plant_id);
    const cert = await withTransaction(pool, async (db) => {
      await checkLinks(db, req.user!, input);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO certificate (name, kind, status, common_name, sans, issuer, serial_number, valid_from, expires_on, auto_renew, installed_on,
           plant_id, application_id, asset_id, responsibles, notify_emails, description, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18) RETURNING id`,
        [input.name, input.kind, input.status, input.common_name, input.sans, input.issuer, input.serial_number, input.valid_from, input.expires_on,
          input.auto_renew, input.installed_on, input.plant_id, input.application_id, input.asset_id, JSON.stringify(input.responsibles),
          input.notify_emails, input.description, req.user!.id],
      );
      const created = await loadCert(db, req.user!, rows[0].id);
      await audit(db, req, { action: 'create', entityType: 'certificate', entityId: created.id, entityLabel: created.name, plantId: created.plant_id, changes: snapshot(input) });
      return created;
    });
    res.status(201).json(cert);
  });

  r.put('/certificates/:id', requirePermission('asset.edit'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(certificateSchema, req.body);
    const cert = await withTransaction(pool, async (db) => {
      const before = await loadCert(db, req.user!, id);
      assertPlantAccess(req.user!, before.plant_id);
      assertPlantAccess(req.user!, input.plant_id);
      await checkLinks(db, req.user!, input);
      await db.query(
        `UPDATE certificate SET name=$2, kind=$3, status=$4, common_name=$5, sans=$6, issuer=$7, serial_number=$8, valid_from=$9, expires_on=$10,
           auto_renew=$11, installed_on=$12, plant_id=$13, application_id=$14, asset_id=$15, responsibles=$16,
           notify_emails=$17, description=$18, updated_by=$19, updated_at=now() WHERE id=$1`,
        [id, input.name, input.kind, input.status, input.common_name, input.sans, input.issuer, input.serial_number, input.valid_from, input.expires_on,
          input.auto_renew, input.installed_on, input.plant_id, input.application_id, input.asset_id, JSON.stringify(input.responsibles),
          input.notify_emails, input.description, req.user!.id],
      );
      const after = await loadCert(db, req.user!, id);
      const changes = diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
      for (const k of ['days_left', 'last_notified_at', 'plant_code', 'application_name', 'asset_name']) delete changes[k];
      if (Object.keys(changes).length)
        await audit(db, req, { action: 'update', entityType: 'certificate', entityId: id, entityLabel: after.name, plantId: after.plant_id, changes });
      return after;
    });
    res.json(cert);
  });

  r.delete('/certificates/:id', requirePermission('asset.delete'), async (req, res) => {
    const id = requireUuid(req.params.id);
    await withTransaction(pool, async (db) => {
      const before = await loadCert(db, req.user!, id);
      assertPlantAccess(req.user!, before.plant_id);
      await db.query('DELETE FROM certificate WHERE id = $1', [id]);
      await audit(db, req, { action: 'delete', entityType: 'certificate', entityId: id, entityLabel: before.name, plantId: before.plant_id, changes: { name: before.name, expires_on: before.expires_on } });
    });
    res.status(204).end();
  });

  r.get('/certificates/:id/history', async (req, res) => {
    const cert = await loadCert(pool, req.user!, requireUuid(req.params.id));
    const { rows } = await pool.query(
      `SELECT id::text, at, user_id, user_name, action, entity_type, entity_id, entity_label, changes, NULL AS ip
       FROM audit_log WHERE entity_type = 'certificate' AND entity_id = $1 ORDER BY at DESC LIMIT 200`,
      [cert.id],
    );
    const { rows: sent } = await pool.query(
      `SELECT threshold_days, expires_on::text AS expires_on, recipients, sent_at FROM certificate_notification WHERE certificate_id = $1 ORDER BY sent_at DESC LIMIT 50`,
      [cert.id],
    );
    res.json({ changes: rows, reminders: sent });
  });

  // ------------------------------------------------------------ e-mail reminders (administrators)
  const admin = requirePermission('settings.manage');

  async function settingsDto(): Promise<CertificateNotificationSettingsDto> {
    const { settings, updatedAt } = await loadCertificateSettings(pool);
    const { rows } = await pool.query(
      `SELECT started_at, status, emails, items, error FROM notification_run WHERE kind = 'certificates' ORDER BY started_at DESC LIMIT 1`,
    );
    return { ...settings, updatedAt, lastRun: rows[0] ?? null };
  }

  r.get('/settings/certificate-notifications', admin, async (_req, res) => {
    res.json(await settingsDto());
  });

  r.put('/settings/certificate-notifications', admin, async (req, res) => {
    const input = parse(settingsSchema, req.body);
    const { settings: before } = await loadCertificateSettings(pool);
    await writeSetting(pool, CERTIFICATE_KEY, input, req.user!.id);
    const changes = diff(before as unknown as Record<string, unknown>, input as unknown as Record<string, unknown>);
    if (Object.keys(changes).length) await audit(pool, req, { action: 'settings.update', entityType: 'settings', entityLabel: 'Certificate notifications', changes });
    res.json(await settingsDto());
  });

  r.get('/notifications/certificates/preview', admin, async (_req, res) => {
    res.json(await previewCertificates(pool));
  });

  /** Send the due reminders now – and the overview, independent of the weekday */
  r.post('/notifications/certificates/run', admin, async (req, res) => {
    const result = await runCertificateJob(pool, config, { trigger: 'manual', overview: req.body?.overview === false ? 'skip' : 'force' });
    await audit(pool, req, { action: 'notifications.run', entityType: 'settings', entityLabel: 'Certificate notifications', changes: { ...result } });
    res.json(result);
  });

  return r;
}

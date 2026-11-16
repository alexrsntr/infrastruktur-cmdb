import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../server/config';
import { login, setupTestApp, type Session } from './helpers';
import { checkAndRunCertificates } from '../server/services/scheduler';
import { isoWeekday } from '../server/services/certificateNotifications';
import { localParts } from '../server/services/warrantyNotifications';
import type { Certificate, CertificateList, CertificatePreview, CertificateRunResult } from '../shared/certificates';
import { certificateResponsiblesMigration } from '../server/db/migrations/022_certificate_responsibles';

interface Captured {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

let app: Express;
let pool: Pool;
let config: Config;
let admin: Session;
let editor: Session;
let local: Session;
let viewer: Session;
let smtp: SMTPServer;
const inbox: Captured[] = [];
let muc: { id: string };
let ham: { id: string };

const inDays = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const cert = (overrides: Record<string, unknown> = {}) => ({
  name: 'portal.example.com',
  kind: 'tls',
  common_name: 'portal.example.com',
  issuer: 'DigiCert',
  expires_on: inDays(200),
  responsible: 'Rita Responsible',
  responsible_email: 'rita@example.local',
  ...overrides,
});

const notificationSettings = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  thresholds: [60, 30, 14, 7, 1],
  includeExpired: true,
  notifyResponsible: true,
  recipients: ['pki-team@example.local'],
  overviewEnabled: true,
  overviewWeekday: 1,
  overviewDays: 90,
  sendHour: 7,
  timezone: 'Europe/Berlin',
  ...overrides,
});

beforeAll(async () => {
  ({ app, pool, config } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  local = await login(app, 'local');
  viewer = await login(app, 'viewer');
  const plants = (await admin.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
  ham = plants.find((p) => p.code === 'HAM')!;
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, session, cb) {
      simpleParser(stream)
        .then((mail) => {
          inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), subject: mail.subject ?? '', html: typeof mail.html === 'string' ? mail.html : '', text: mail.text ?? '' });
          cb();
        })
        .catch(cb);
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', () => resolve()));
  const port = (smtp.server.address() as AddressInfo).port;
  await admin
    .put('/api/settings/email', { host: '127.0.0.1', port, security: 'none', username: '', fromAddress: 'infra@example.local', fromName: 'IT Infrastructure', allowInvalidCertificates: false })
    .expect(200);
});

afterAll(async () => {
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
  await pool.end();
});

beforeEach(() => {
  inbox.length = 0;
});

describe('certificates', () => {
  let central: Certificate;
  let mucCert: Certificate;

  it('are created by editors with expiry date and responsible person', async () => {
    await viewer.post('/api/certificates', cert()).expect(403);
    await local.post('/api/certificates', cert({ plant_id: muc.id })).expect(403);
    const bad = await editor.post('/api/certificates', cert({ responsible_email: 'not-an-address' })).expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/Invalid e-mail address/);
    await editor.post('/api/certificates', cert({ valid_from: inDays(10), expires_on: inDays(5) })).expect(400);

    central = (await editor.post('/api/certificates', cert({ name: '*.example.com', kind: 'wildcard', expires_on: inDays(20), notify_emails: ['web-team@example.local'] })).expect(201)).body;
    expect(central).toMatchObject({ name: '*.example.com', plant_id: null, days_left: 20, status: 'active', notify_emails: ['web-team@example.local'] });
    mucCert = (await editor.post('/api/certificates', cert({ name: 'muc-vpn', kind: 'vpn', plant_id: muc.id, expires_on: inDays(-3), responsible_email: 'lars.localadmin@example.local' })).expect(201)).body;
    await editor.post('/api/certificates', cert({ name: 'ham-printer', kind: 'client', plant_id: ham.id, expires_on: inDays(400), responsible_email: null })).expect(201);
  });

  it('are listed with counters and filters, within the plant scope', async () => {
    const all = (await viewer.get('/api/certificates').expect(200)).body as CertificateList;
    expect(all.items.map((c) => c.name)).toEqual(['muc-vpn', '*.example.com', 'ham-printer']);
    expect(all.counts).toMatchObject({ total: 3, expired: 1, critical: 0, warning: 1, no_responsible: 1 });

    const soon = (await viewer.get('/api/certificates?due=soon').expect(200)).body as CertificateList;
    expect(soon.items.map((c) => c.name)).toEqual(['muc-vpn', '*.example.com']);
    const found = (await viewer.get('/api/certificates?q=wildcard-nope').expect(200)).body as CertificateList;
    expect(found.items).toEqual([]);

    // the local administrator of MUC sees the central certificate and the MUC one, not the HAM one
    const scoped = (await local.get('/api/certificates').expect(200)).body as CertificateList;
    expect(scoped.items.map((c) => c.name).sort()).toEqual(['*.example.com', 'muc-vpn']);
  });

  it('local administrators renew certificates of their plant, but not central ones, and cannot delete', async () => {
    const renewed = (await local.put(`/api/certificates/${mucCert.id}`, { ...mucCert, expires_on: inDays(365), serial_number: '0A:1B' }).expect(200)).body as Certificate;
    expect(renewed.days_left).toBe(365);
    await local.put(`/api/certificates/${central.id}`, { ...central, expires_on: inDays(365) }).expect(403);
    await local.del(`/api/certificates/${mucCert.id}`).expect(403);
    const history = (await viewer.get(`/api/certificates/${mucCert.id}/history`).expect(200)).body;
    expect(history.changes[0].changes.expires_on.to).toBe(inDays(365));
    // back to expired for the e-mail tests
    await editor.put(`/api/certificates/${mucCert.id}`, { ...mucCert }).expect(200);
  });
});

describe('certificate e-mails', () => {
  it('only administrators change the notification settings', async () => {
    await editor.get('/api/settings/certificate-notifications').expect(403);
    await editor.post('/api/notifications/certificates/run').expect(403);
    const s = (await admin.put('/api/settings/certificate-notifications', notificationSettings()).expect(200)).body;
    expect(s).toMatchObject({ enabled: true, thresholds: [60, 30, 14, 7, 1], recipients: ['pki-team@example.local'] });
    await admin.put('/api/settings/certificate-notifications', notificationSettings({ timezone: 'Mars/Olympus' })).expect(400);
  });

  it('previews and sends reminders to the responsible persons once per stage', async () => {
    const preview = (await admin.get('/api/notifications/certificates/preview').expect(200)).body as CertificatePreview;
    expect(preview.reminders.map((r) => r.name).sort()).toEqual(['*.example.com', 'muc-vpn']);
    const wildcard = preview.reminders.find((r) => r.name === '*.example.com')!;
    expect(wildcard.thresholds).toEqual([60, 30]);
    expect(wildcard.recipients).toEqual(['rita@example.local', 'web-team@example.local', 'pki-team@example.local']);
    expect(preview.reminders.find((r) => r.name === 'muc-vpn')!.thresholds).toContain(0);

    const run = (await admin.post('/api/notifications/certificates/run', { overview: false }).expect(200)).body as CertificateRunResult;
    expect(run).toMatchObject({ status: 'ok', reminders: 2, overview: false });
    const to = (addr: string) => inbox.filter((m) => m.to.includes(addr));
    expect(to('rita@example.local')).toHaveLength(1);
    expect(to('rita@example.local')[0].subject).toMatch(/^\[IT Infrastructure\] Certificate \*\.example\.com expires on /);
    expect(to('lars.localadmin@example.local')[0].subject).toMatch(/muc-vpn has expired/);
    // the general recipient gets one e-mail with both certificates
    expect(to('pki-team@example.local')).toHaveLength(1);
    expect(to('pki-team@example.local')[0].subject).toMatch(/2 certificates expire soon or have expired/);
    expect(to('pki-team@example.local')[0].html).toContain('muc-vpn');

    // a second run sends nothing – every stage was reminded once
    inbox.length = 0;
    const again = (await admin.post('/api/notifications/certificates/run', { overview: false }).expect(200)).body as CertificateRunResult;
    expect(again).toMatchObject({ status: 'ok', reminders: 0, emails: 0 });
    expect(inbox).toHaveLength(0);
  });

  it('reminds again after the renewal date passes the next stage', async () => {
    const list = (await admin.get('/api/certificates?q=example.com').expect(200)).body as CertificateList;
    const wildcard = list.items.find((c) => c.name === '*.example.com')!;
    await admin.put(`/api/certificates/${wildcard.id}`, { ...wildcard, expires_on: inDays(10) }).expect(200);
    const preview = (await admin.get('/api/notifications/certificates/preview').expect(200)).body as CertificatePreview;
    // a new expiry date counts as a new certificate: all reached stages are pending again
    expect(preview.reminders.find((r) => r.name === '*.example.com')!.thresholds).toEqual([60, 30, 14]);
  });

  it('sends the overview to the general recipients', async () => {
    const run = (await admin.post('/api/notifications/certificates/run').expect(200)).body as CertificateRunResult;
    expect(run.overview).toBe(true);
    const overview = inbox.find((m) => m.subject.includes('Certificate overview'))!;
    expect(overview.to).toEqual(['pki-team@example.local']);
    expect(overview.subject).toMatch(/1 expired, 1 expiring within 90 days/);
    expect(overview.html).toContain('Rita Responsible');
    expect(overview.html).not.toContain('ham-printer');
  });

  it('runs once a day from the scheduler, the overview only on its weekday', async () => {
    await pool.query(`DELETE FROM notification_run WHERE kind LIKE 'certificate%'`);
    const now = new Date();
    const { date, hour } = localParts('Europe/Berlin', now);
    await admin.put('/api/settings/certificate-notifications', notificationSettings({ sendHour: hour, overviewWeekday: isoWeekday(date) })).expect(200);
    inbox.length = 0;
    expect(await checkAndRunCertificates(pool, config, now)).toBe('ran');
    expect(inbox.some((m) => m.subject.includes('Certificate overview'))).toBe(true);
    expect(await checkAndRunCertificates(pool, config, now)).toBe('not-due');

    await pool.query(`DELETE FROM notification_run WHERE kind LIKE 'certificate%'`);
    await admin.put('/api/settings/certificate-notifications', notificationSettings({ sendHour: hour, overviewWeekday: (isoWeekday(date) % 7) + 1 })).expect(200);
    inbox.length = 0;
    expect(await checkAndRunCertificates(pool, config, now)).toBe('ran');
    expect(inbox.some((m) => m.subject.includes('Certificate overview'))).toBe(false);

    await admin.put('/api/settings/certificate-notifications', notificationSettings({ enabled: false })).expect(200);
    expect(await checkAndRunCertificates(pool, config, now)).toBe('disabled');
  });
});

describe('several responsible persons', () => {
  it('are stored as a list without empty rows and duplicate addresses', async () => {
    const created = (
      await editor
        .post('/api/certificates', {
          name: 'erp.example.com',
          kind: 'tls',
          expires_on: inDays(5),
          responsibles: [
            { name: 'Anna Owner', email: 'anna.owner@example.local' },
            { name: 'Ben Deputy', email: 'Ben.Deputy@example.local' },
            { name: '', email: '' },
            { name: 'Carl (phone only)', email: null },
            { name: 'Anna again', email: 'anna.owner@example.local' },
          ],
        })
        .expect(201)
    ).body as Certificate;
    expect(created.responsibles).toEqual([
      { name: 'Anna Owner', email: 'anna.owner@example.local' },
      { name: 'Ben Deputy', email: 'ben.deputy@example.local' },
      { name: 'Carl (phone only)', email: null },
    ]);
    expect(created).not.toHaveProperty('responsible');

    const found = (await viewer.get('/api/certificates?q=deputy').expect(200)).body as CertificateList;
    expect(found.items.map((c) => c.name)).toEqual(['erp.example.com']);

    const tooMany = Array.from({ length: 21 }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.local` }));
    await editor.post('/api/certificates', { name: 'too-many', expires_on: inDays(5), responsibles: tooMany }).expect(400);
    await editor.post('/api/certificates', { name: 'bad', expires_on: inDays(5), responsibles: [{ name: 'X', email: 'nope' }] }).expect(400);
  });

  it('reminds every responsible person with an address', async () => {
    await admin.put('/api/settings/certificate-notifications', notificationSettings({ recipients: [] })).expect(200);
    const preview = (await admin.get('/api/notifications/certificates/preview').expect(200)).body as CertificatePreview;
    const erp = preview.reminders.find((r) => r.name === 'erp.example.com')!;
    expect(erp.recipients).toEqual(['anna.owner@example.local', 'ben.deputy@example.local']);

    inbox.length = 0;
    await admin.post('/api/notifications/certificates/run', { overview: false }).expect(200);
    for (const addr of ['anna.owner@example.local', 'ben.deputy@example.local']) {
      const mails = inbox.filter((m) => m.to.includes(addr));
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toMatch(/erp\.example\.com/);
    }
  });

  it('keeps the person of certificates created before (migration 022)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE SCHEMA mig022');
      await client.query('SET LOCAL search_path TO mig022');
      await client.query('CREATE TABLE certificate (id int PRIMARY KEY, responsible text, responsible_email text)');
      await client.query(`INSERT INTO certificate VALUES (1, 'Rita', 'rita@example.local'), (2, NULL, 'team@example.local'), (3, ' ', NULL), (4, 'Tom', '')`);
      await client.query(certificateResponsiblesMigration.sql);
      const { rows } = await client.query('SELECT id, responsibles FROM certificate ORDER BY id');
      expect(rows).toEqual([
        { id: 1, responsibles: [{ name: 'Rita', email: 'rita@example.local' }] },
        { id: 2, responsibles: [{ name: null, email: 'team@example.local' }] },
        { id: 3, responsibles: [] },
        { id: 4, responsibles: [{ name: 'Tom', email: null }] },
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});


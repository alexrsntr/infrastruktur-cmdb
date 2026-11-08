import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import net, { type AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../server/config';
import { login, setupTestApp, type Session } from './helpers';
import { checkAndRun } from '../server/services/scheduler';
import { localParts } from '../server/services/warrantyNotifications';

const PASSWORD = 'S3cret-SMTP-Passw0rd!';

interface Captured {
  to: string[];
  subject: string;
  html: string;
  text: string;
  user?: string;
}

let app: Express;
let pool: Pool;
let config: Config;
let admin: Session;
let editor: Session;
let viewer: Session;
let smtp: SMTPServer;
let smtpPort: number;
const inbox: Captured[] = [];
let plants: { id: string; code: string }[];

function startSmtp(): Promise<void> {
  smtp = new SMTPServer({
    authOptional: true,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === 'cmdb' && auth.password === PASSWORD) return cb(null, { user: auth.username });
      cb(new Error('Invalid username or password'));
    },
    onData(stream, session, cb) {
      simpleParser(stream)
        .then((mail) => {
          inbox.push({
            to: session.envelope.rcptTo.map((r) => r.address),
            subject: mail.subject ?? '',
            html: typeof mail.html === 'string' ? mail.html : '',
            text: mail.text ?? '',
            user: session.user as string | undefined,
          });
          cb();
        })
        .catch(cb);
    },
  });
  return new Promise((resolve) => smtp.listen(0, '127.0.0.1', () => resolve()));
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const smtpSettings = (overrides: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port: smtpPort,
  security: 'none',
  username: 'cmdb',
  password: PASSWORD,
  fromAddress: 'cmdb@example.local',
  fromName: 'IT CMDB',
  allowInvalidCertificates: false,
  ...overrides,
});

const notificationSettings = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  thresholds: [90, 30, 7],
  includeExpired: false,
  sendHour: 7,
  timezone: 'Europe/Berlin',
  recipients: ['it-infra@example.local'],
  plantRecipients: { [plants.find((p) => p.code === 'HAM')!.id]: ['it-ham@example.local'] },
  excludeStatuses: ['retired'],
  ...overrides,
});

async function setWarranty(name: string, daysFromNow: number) {
  const asset = (await admin.get(`/api/assets?q=${name}`).expect(200)).body.items.find((a: { name: string }) => a.name === name);
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  const full = (await admin.get(`/api/assets/${asset.id}`).expect(200)).body;
  await admin.put(`/api/assets/${asset.id}`, { ...full, warranty_end: d.toISOString().slice(0, 10) }).expect(200);
  return asset.id as string;
}

const logCount = async () => (await pool.query('SELECT count(*) AS n FROM notification_log')).rows[0].n as number;

beforeAll(async () => {
  ({ app, pool, config } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  plants = (await admin.get('/api/plants').expect(200)).body;
  await startSmtp();
  smtpPort = (smtp.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
  await pool.end();
});

beforeEach(() => {
  inbox.length = 0;
});

describe('settings access', () => {
  it('is restricted to administrators', async () => {
    await editor.get('/api/settings/email').expect(403);
    await viewer.get('/api/settings/notifications').expect(403);
    await editor.put('/api/settings/email', smtpSettings()).expect(403);
    await editor.post('/api/notifications/warranty/run').expect(403);
    await viewer.get('/api/notifications/log').expect(403);
  });

  it('requires a CSRF token', async () => {
    await admin.agent.put('/api/settings/email').send(smtpSettings()).expect(403);
  });
});

describe('SMTP settings', () => {
  it('stores the password encrypted and never returns it', async () => {
    const res = await admin.put('/api/settings/email', smtpSettings()).expect(200);
    expect(res.body).toMatchObject({ host: '127.0.0.1', port: smtpPort, passwordSet: true, passwordUnreadable: false, configured: true });
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(res.body).not.toHaveProperty('password');
    expect(res.body).not.toHaveProperty('passwordEnc');

    const raw = await pool.query(`SELECT value::text AS v FROM app_setting WHERE key = 'smtp'`);
    expect(raw.rows[0].v).not.toContain(PASSWORD);
    expect(raw.rows[0].v).toMatch(/"passwordEnc": "v1:/);

    const get = await admin.get('/api/settings/email').expect(200);
    expect(JSON.stringify(get.body)).not.toContain(PASSWORD);
  });

  it('keeps the password when it is omitted and audits changes without the secret', async () => {
    const { password: _omit, ...withoutPassword } = smtpSettings({ fromName: 'CMDB Notifications' });
    const res = await admin.put('/api/settings/email', withoutPassword).expect(200);
    expect(res.body).toMatchObject({ passwordSet: true, fromName: 'CMDB Notifications' });
    const auditRows = await pool.query(`SELECT changes::text AS c FROM audit_log WHERE action = 'settings.update'`);
    expect(auditRows.rows.length).toBeGreaterThan(0);
    for (const row of auditRows.rows) expect(row.c).not.toContain(PASSWORD);
  });

  it('validates input', async () => {
    const res = await admin.put('/api/settings/email', smtpSettings({ port: 0, fromAddress: 'not-an-email', security: 'ssl' })).expect(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['port', 'fromAddress', 'security']));
  });

  it('sends a test e-mail through the configured server (with authentication)', async () => {
    const res = await admin.post('/api/settings/email/test', { to: 'anna.admin@example.local' }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ to: ['anna.admin@example.local'], subject: '[IT CMDB] Test e-mail', user: 'cmdb' });
  });

  it('reports SMTP errors in a readable way', async () => {
    const closed = await freePort();
    await admin.put('/api/settings/email', smtpSettings({ port: closed })).expect(200);
    const res = await admin.post('/api/settings/email/test', { to: 'anna.admin@example.local' }).expect(400);
    expect(res.body.error).toMatch(/Connection refused/);
    await admin.put('/api/settings/email', smtpSettings()).expect(200);
  });

  it('can remove the stored password', async () => {
    const res = await admin.put('/api/settings/email', smtpSettings({ password: null })).expect(200);
    expect(res.body.passwordSet).toBe(false);
    await admin.put('/api/settings/email', smtpSettings()).expect(200);
  });
});

describe('warranty notifications', () => {
  it('validates notification settings', async () => {
    await admin.put('/api/settings/notifications', notificationSettings({ recipients: ['nope'] })).expect(400);
    await admin.put('/api/settings/notifications', notificationSettings({ timezone: 'Mars/Olympus' })).expect(400);
    await admin.put('/api/settings/notifications', notificationSettings({ plantRecipients: { '00000000-0000-4000-8000-000000000000': ['a@b.de'] } })).expect(400);
    const res = await admin.put('/api/settings/notifications', notificationSettings({ thresholds: [7, 90, 30, 30] })).expect(200);
    expect(res.body.thresholds).toEqual([90, 30, 7]);
  });

  it('previews the devices that are due', async () => {
    const res = await admin.get('/api/notifications/warranty/preview').expect(200);
    const names = res.body.items.map((i: { name: string }) => i.name);
    // seed: the first ESX host of every plant has a warranty ending in ~45 days
    for (const p of plants) expect(names).toContain(`${p.code.toLowerCase()}-esx01`);
    const esx = res.body.items.find((i: { name: string }) => i.name === 'muc-esx01');
    expect(esx).toMatchObject({ thresholds: [90], plant_code: 'MUC' });
    expect(esx.days_left).toBeGreaterThan(30);
    // includeExpired = false → nothing already expired
    expect(res.body.items.every((i: { days_left: number }) => i.days_left > 0)).toBe(true);
    const infra = res.body.recipients.find((r: { email: string }) => r.email === 'it-infra@example.local');
    const hamR = res.body.recipients.find((r: { email: string }) => r.email === 'it-ham@example.local');
    expect(infra.count).toBe(res.body.items.length);
    expect(hamR.count).toBe(res.body.items.filter((i: { plant_code: string }) => i.plant_code === 'HAM').length);
  });

  it('sends one digest per recipient; plant recipients only get their plant', async () => {
    const preview = (await admin.get('/api/notifications/warranty/preview').expect(200)).body;
    const res = await admin.post('/api/notifications/warranty/run').expect(200);
    expect(res.body.run).toMatchObject({ status: 'ok', trigger: 'manual', emails: 2, items: preview.items.length });
    expect(inbox).toHaveLength(2);

    const infra = inbox.find((m) => m.to.includes('it-infra@example.local'))!;
    expect(infra.subject).toMatch(new RegExp(`^\\[IT CMDB\\] ${preview.items.length} warranties expiring – `));
    const muc = preview.items.find((i: { name: string }) => i.name === 'muc-esx01');
    expect(infra.html).toContain(`http://localhost:5173/assets/${muc.id}`);
    expect(infra.text).toContain('muc-esx01');

    const ham = inbox.find((m) => m.to.includes('it-ham@example.local'))!;
    expect(ham.text).toContain('ham-esx01');
    expect(ham.text).not.toContain('muc-esx01');
    expect(ham.subject).toMatch(/– HAM$/);

    expect(await logCount()).toBeGreaterThanOrEqual(preview.items.length);
  });

  it('does not notify the same device and threshold twice', async () => {
    const preview = (await admin.get('/api/notifications/warranty/preview').expect(200)).body;
    expect(preview.items).toEqual([]);
    const res = await admin.post('/api/notifications/warranty/run').expect(200);
    expect(res.body.run).toMatchObject({ status: 'ok', items: 0, emails: 0 });
    expect(inbox).toHaveLength(0);
  });

  it('notifies again when the next threshold is reached or the warranty date changes', async () => {
    await setWarranty('muc-esx01', 20); // new date → thresholds 90 and 30 apply, reported once
    const res = await admin.post('/api/notifications/warranty/run').expect(200);
    expect(res.body.run).toMatchObject({ status: 'ok', items: 1, emails: 1 });
    expect(inbox).toHaveLength(1);
    expect(inbox[0].to).toEqual(['it-infra@example.local']);
    expect(inbox[0].text).toContain('muc-esx01');
    expect(inbox[0].subject).toMatch(/1 warranty expiring – MUC$/);
    const rows = await pool.query(
      `SELECT threshold_days FROM notification_log l JOIN asset a ON a.id = l.asset_id WHERE a.name = 'muc-esx01' AND l.warranty_end = (SELECT warranty_end FROM asset WHERE name = 'muc-esx01') ORDER BY threshold_days DESC`,
    );
    expect(rows.rows.map((r) => r.threshold_days)).toEqual([90, 30]);
  });

  it('notifies expired warranties once when enabled', async () => {
    await admin.put('/api/settings/notifications', notificationSettings({ includeExpired: true })).expect(200);
    const preview = (await admin.get('/api/notifications/warranty/preview').expect(200)).body;
    expect(preview.items.length).toBeGreaterThan(0);
    expect(preview.items.every((i: { days_left: number; thresholds: number[] }) => i.days_left <= 0 && i.thresholds.includes(0))).toBe(true);
    const res = await admin.post('/api/notifications/warranty/run').expect(200);
    expect(res.body.run.status).toBe('ok');
    expect(inbox.find((m) => m.to.includes('it-infra@example.local'))!.subject).toMatch(/expired/);
    await admin.post('/api/notifications/warranty/run').expect(200);
    expect(inbox).toHaveLength(res.body.run.emails);
  });

  it('rolls back when sending fails so the devices are retried', async () => {
    await setWarranty('kec-esx02', 5);
    const before = await logCount();
    await admin.put('/api/settings/email', smtpSettings({ port: await freePort() })).expect(200);
    const res = await admin.post('/api/notifications/warranty/run').expect(200);
    expect(res.body.run.status).toBe('error');
    expect(res.body.run.error).toMatch(/Connection refused/);
    expect(await logCount()).toBe(before);

    await admin.put('/api/settings/email', smtpSettings()).expect(200);
    const retry = await admin.post('/api/notifications/warranty/run').expect(200);
    expect(retry.body.run).toMatchObject({ status: 'ok', items: 1 });
    expect(inbox.some((m) => m.text.includes('kec-esx02'))).toBe(true);
  });

  it('skips when disabled and lists runs and sent notifications', async () => {
    await admin.put('/api/settings/notifications', notificationSettings({ enabled: false })).expect(200);
    const res = await admin.post('/api/notifications/warranty/run').expect(200);
    expect(res.body.run).toMatchObject({ status: 'skipped', error: 'Warranty notifications are disabled.' });
    const runs = await admin.get('/api/notifications/runs').expect(200);
    expect(runs.body[0].status).toBe('skipped');
    const sent = await admin.get('/api/notifications/log').expect(200);
    expect(sent.body[0]).toHaveProperty('asset_name');
    expect(sent.body.some((l: { asset_name: string }) => l.asset_name === 'muc-esx01')).toBe(true);
  });
});

describe('scheduler', () => {
  it('runs once per local day after the configured hour', async () => {
    await admin.put('/api/settings/notifications', notificationSettings({ enabled: true, sendHour: 0, timezone: 'UTC' })).expect(200);
    expect(await checkAndRun(pool, config)).toBe('ran');
    expect(await checkAndRun(pool, config)).toBe('not-due');
    const today = localParts('UTC').date;
    const runs = await pool.query(`SELECT status FROM notification_run WHERE trigger = 'schedule' AND local_date = $1`, [today]);
    expect(runs.rows).toEqual([{ status: 'ok' }]);
  });

  it('waits until the send hour', async () => {
    await admin.put('/api/settings/notifications', notificationSettings({ sendHour: 23, timezone: 'UTC' })).expect(200);
    const early = new Date();
    early.setUTCHours(1, 0, 0, 0);
    early.setUTCDate(early.getUTCDate() + 1); // tomorrow 01:00 UTC – no run for that date yet
    expect(await checkAndRun(pool, config, early)).toBe('not-due');
  });

  it('does nothing when disabled', async () => {
    await admin.put('/api/settings/notifications', notificationSettings({ enabled: false })).expect(200);
    expect(await checkAndRun(pool, config)).toBe('disabled');
  });
});

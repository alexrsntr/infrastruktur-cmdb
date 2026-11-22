import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../server/config';
import { login, setupTestApp, type Session } from './helpers';
import { checkAndRunDbStorage } from '../server/services/scheduler';
import { LOCKS } from '../server/lib/locks';
import type { DbStorageCheckResult, DbStorageDetails, DbStorageSettings, DbStorageStatus } from '../shared/dbStorage';

/** The app warns its administrators (banner + e-mail) before the PostgreSQL server runs out of space. */

interface Captured {
  to: string[];
  subject: string;
  text: string;
}

let app: Express;
let pool: Pool;
let config: Config;
let admin: Session;
let editor: Session;
let viewer: Session;
let smtp: SMTPServer;
const inbox: Captured[] = [];

const GB = 1024 ** 3;
const settings = (overrides: Partial<DbStorageSettings> = {}): DbStorageSettings => ({
  limitGb: 32,
  warnPercent: 80,
  criticalPercent: 90,
  emailEnabled: true,
  notifyAdmins: true,
  recipients: ['storage@example.local'],
  ...overrides,
});

const status = async () => (await admin.get('/api/system/db-storage').expect(200)).body as DbStorageStatus;
/** storage size (GB) at which the database is filled to the given percentage */
const limitFor = async (percent: number) => (await status()).usedBytes / (percent / 100) / GB;
const check = async () => (await admin.post('/api/settings/db-storage/check', {}).expect(200)).body as DbStorageCheckResult & { details: DbStorageDetails };

beforeAll(async () => {
  ({ app, pool, config } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, session, cb) {
      simpleParser(stream)
        .then((mail) => {
          inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), subject: mail.subject ?? '', text: mail.text ?? '' });
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

describe('database storage', () => {
  it('shows the fill level to administrators only', async () => {
    const s = await status();
    expect(s.level).toBe('ok');
    expect(s.usedBytes).toBeGreaterThan(1024 * 1024);
    expect(s.limitBytes).toBe(32 * GB);
    expect(s.percent).toBeLessThan(5);

    const d = (await admin.get('/api/settings/db-storage').expect(200)).body as DbStorageDetails;
    expect(d.settings).toMatchObject({ limitGb: 32, warnPercent: 80, criticalPercent: 90, emailEnabled: true, notifyAdmins: true });
    expect(d.smtpConfigured).toBe(true);
    expect(d.breakdown.database).toBeGreaterThan(0);
    expect(d.tables.length).toBeGreaterThan(0);
    expect(d.tables.every((t) => t.bytes >= 0 && t.label)).toBe(true);
    expect(d.lastNotification).toBeNull();

    await editor.get('/api/system/db-storage').expect(403);
    await viewer.get('/api/settings/db-storage').expect(403);
    await editor.put('/api/settings/db-storage', settings()).expect(403);
    await editor.post('/api/settings/db-storage/check', {}).expect(403);
  });

  it('validates the settings', async () => {
    const bad = await admin.put('/api/settings/db-storage', settings({ warnPercent: 85, criticalPercent: 80 })).expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/higher than the warning/);
    await admin.put('/api/settings/db-storage', settings({ limitGb: -1 })).expect(400);
    await admin.put('/api/settings/db-storage', settings({ recipients: ['not-an-address'] })).expect(400);
  });

  it('e-mails once per level and again after the level dropped', async () => {
    // warning
    await admin.put('/api/settings/db-storage', settings({ limitGb: await limitFor(85) })).expect(200);
    expect((await status()).level).toBe('warning');
    const first = await check();
    expect(first).toMatchObject({ emails: 2, error: null });
    expect(inbox.map((m) => m.to[0]).sort()).toEqual(['anna.admin@example.local', 'storage@example.local']);
    expect(inbox[0].subject).toMatch(/^\[IT Infrastructure\] database storage \d+(\.\d)? % full$/);
    expect(inbox[0].text).toMatch(/Compute \+ storage/);
    expect(inbox[0].text).toMatch(/read-only/);
    expect(first.details.lastNotification).toMatchObject({ level: 'warning', recipients: 2 });

    // same level: no second e-mail
    inbox.length = 0;
    expect((await check()).emails).toBe(0);
    expect(inbox).toHaveLength(0);

    // critical
    await admin.put('/api/settings/db-storage', settings({ limitGb: await limitFor(94) })).expect(200);
    expect((await check()).emails).toBe(2);
    expect(inbox[0].subject).toMatch(/Critical: database storage/);

    // storage enlarged: back to ok, nothing sent – and the next rise is reported again
    inbox.length = 0;
    await admin.put('/api/settings/db-storage', settings()).expect(200);
    expect(await check()).toMatchObject({ emails: 0, status: { level: 'ok' } });
    await admin.put('/api/settings/db-storage', settings({ limitGb: await limitFor(85) })).expect(200);
    expect((await check()).emails).toBe(2);
    expect(inbox.every((m) => !m.subject.includes('Critical'))).toBe(true);
  });

  it('keeps quiet without e-mail and switches off with size 0', async () => {
    await admin.put('/api/settings/db-storage', settings()).expect(200);
    await check(); // re-arm
    inbox.length = 0;
    await admin.put('/api/settings/db-storage', settings({ limitGb: await limitFor(95), emailEnabled: false })).expect(200);
    const res = await check();
    expect(res).toMatchObject({ emails: 0, error: null, status: { level: 'critical' } });
    expect(inbox).toHaveLength(0);

    await admin.put('/api/settings/db-storage', settings({ limitGb: 0 })).expect(200);
    const off = await status();
    expect(off).toMatchObject({ level: 'off', percent: null, limitBytes: null });
  });

  it('runs from the scheduler under a lock and records the settings change', async () => {
    await admin.put('/api/settings/db-storage', settings()).expect(200);
    expect(await checkAndRunDbStorage(pool, config)).toBe('ran');
    const audit = await admin.get('/api/audit?entityType=settings').expect(200);
    expect(JSON.stringify(audit.body)).toMatch(/Database storage/);
  });

  it('is not blocked by the webhook dispatcher (every background job has its own lock)', async () => {
    const other = await pool.connect();
    try {
      // another instance is delivering webhooks right now
      await other.query('SELECT pg_advisory_lock($1)', [LOCKS.webhooks]);
      expect(await checkAndRunDbStorage(pool, config)).toBe('ran');
    } finally {
      await other.query('SELECT pg_advisory_unlock($1)', [LOCKS.webhooks]);
      other.release();
    }
  });
});

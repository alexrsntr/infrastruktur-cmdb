import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadConfig } from '../server/config';
import { createPool } from '../server/db/pool';
import { migrate } from '../server/db/migrate';
import { seedDemoDataOnce } from '../server/db/seed';

// DEMO_DATA=true (Windows test package) fills a new database with demo data – once, never into data in use.
describe('demo data for the Windows test package', () => {
  process.env.NODE_ENV = 'test';
  process.env.AUTH_MODE = 'dev';
  process.env.DB_AUTH = 'password';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://cmdb:cmdb@localhost:5432/cmdb_test';
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123';
  const pool = createPool(loadConfig());
  const count = async (table: string) => Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

  afterAll(async () => {
    await pool.end();
  });

  it('loads the demo data into a new, empty database exactly once', async () => {
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await admin.end();
    await migrate(pool);

    const first = await seedDemoDataOnce(pool);
    expect(first).toMatchObject({ skipped: false, plants: 6 });
    const assets = await count('asset');
    expect(assets).toBeGreaterThan(100);
    // no users: the first visitor still creates the administrator account
    expect(await count('app_user')).toBe(0);

    expect(await seedDemoDataOnce(pool)).toMatchObject({ skipped: true });
    expect(await count('asset')).toBe(assets);
  });

  it('does not bring the demo data back after it was deleted', async () => {
    await pool.query('TRUNCATE plant, asset CASCADE');
    expect(await count('plant')).toBe(0);
    expect(await seedDemoDataOnce(pool)).toMatchObject({ skipped: true, reason: expect.stringMatching(/before/) });
    expect(await count('plant')).toBe(0);
  });

  it('never touches a database that already has plants of its own', async () => {
    await pool.query('TRUNCATE audit_log');
    await pool.query(`INSERT INTO plant (code, name) VALUES ('OWN', 'Own plant')`);
    expect(await seedDemoDataOnce(pool)).toMatchObject({ skipped: true, reason: expect.stringMatching(/already contains plants/) });
    expect(await count('plant')).toBe(1);
  });
});

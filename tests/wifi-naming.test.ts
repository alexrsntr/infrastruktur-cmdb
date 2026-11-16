import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';
import { ASSET_TYPES, assetTypeByName, assetTypeBySlug, type ImportReport } from '../shared/model';
import { DEFAULT_SCORECARD_AREAS } from '../shared/scorecard';

/** International naming: "Wi-Fi" instead of "WLAN" – former names keep working. */
let app: Express;
let pool: Pool;
let editor: Session;

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  editor = await login(app, 'editor');
});

afterAll(async () => {
  await pool.end();
});

describe('Wi-Fi naming', () => {
  it('names the controller type and the scorecard area "Wi-Fi"', () => {
    expect(ASSET_TYPES.wlan_controller).toMatchObject({ label: 'Wi-Fi Controller', plural: 'Wi-Fi Controllers', slug: 'wifi-controllers' });
    expect(DEFAULT_SCORECARD_AREAS).toContain('Wi-Fi');
    expect(DEFAULT_SCORECARD_AREAS.some((a) => /wlan/i.test(a))).toBe(false);
  });

  it('still understands the former names in links and import files', async () => {
    expect(assetTypeBySlug('wifi-controllers')).toBe('wlan_controller');
    expect(assetTypeBySlug('wlan-controllers')).toBe('wlan_controller');
    expect(assetTypeByName('WLAN Controller')).toBe('wlan_controller');
    expect(assetTypeByName('Wi-Fi Controllers')).toBe('wlan_controller');
    expect(assetTypeByName('access point')).toBe('access_point');

    const csv = ['Type;Name;Plant', 'WLAN Controller;muc-wlc-legacy;MUC', 'Wi-Fi Controller;muc-wlc-new;MUC'].join('\n');
    const report = (await editor.agent.post('/api/import/assets?dryRun=true').set('x-csrf-token', editor.csrf).attach('file', Buffer.from(csv), 'wifi.csv').expect(200))
      .body as ImportReport;
    expect(report).toMatchObject({ created: 2, errors: [] });
  });
});

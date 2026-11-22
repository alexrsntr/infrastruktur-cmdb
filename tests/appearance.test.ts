import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';
import { drawFloorPlan, OFFICE_LAYOUT } from '../server/db/floorplan';

/** Administration → Settings → Appearance: names, primary colour, header style, density and logo. */

function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

const png = drawFloorPlan(240, 80, OFFICE_LAYOUT.slice(0, 1));
const uploadLogo = (s: Session, variant: string, file: Buffer, name: string) =>
  s.agent.put(`/api/settings/appearance/logo/${variant}`).set('x-csrf-token', s.csrf).attach('file', file, name);

const LOOK = { brandName: 'Example Corp', appName: 'Plant IT', primaryColor: '#0F766E', headerStyle: 'primary', density: 'compact' };

describe('appearance settings', () => {
  let app: Express;
  let pool: Pool;
  let admin: Session;
  let editor: Session;

  beforeAll(async () => {
    ({ app, pool } = await setupTestApp());
    admin = await login(app, 'admin');
    editor = await login(app, 'editor');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('looks like before until something is configured', async () => {
    const cfg = await request(app).get('/api/public-config').expect(200);
    expect(cfg.body).toMatchObject({
      brandName: 'Infrastruktur',
      appName: 'IT Infrastructure',
      primaryColor: '#2563eb',
      headerStyle: 'dark',
      density: 'comfortable',
      logoUrl: { light: null, dark: null },
    });
  });

  it('can only be changed by administrators', async () => {
    await editor.get('/api/settings/appearance').expect(403);
    await editor.put('/api/settings/appearance', LOOK).expect(403);
    await editor.agent.put('/api/settings/appearance/logo/light').set('x-csrf-token', editor.csrf).attach('file', png, 'logo.png').expect(403);
  });

  it('saves names, colour, header style and density, validates them and writes the audit log', async () => {
    await admin.put('/api/settings/appearance', { ...LOOK, primaryColor: 'blue' }).expect(400);
    await admin.put('/api/settings/appearance', { ...LOOK, headerStyle: 'neon' }).expect(400);
    await admin.put('/api/settings/appearance', { ...LOOK, appName: 'x'.repeat(61) }).expect(400);

    const saved = await admin.put('/api/settings/appearance', LOOK).expect(200);
    expect(saved.body.settings).toEqual({ ...LOOK, primaryColor: '#0f766e' });
    expect(saved.body.env).toEqual({ brandName: false, appName: false, primaryColor: false });

    const cfg = await request(app).get('/api/public-config').expect(200);
    expect(cfg.body).toMatchObject({ brandName: 'Example Corp', appName: 'Plant IT', primaryColor: '#0f766e', headerStyle: 'primary', density: 'compact' });
    const me = await admin.get('/api/me').expect(200);
    expect(me.body.config).toMatchObject({ appName: 'Plant IT', headerStyle: 'primary' });

    const { rows } = await pool.query(`SELECT changes FROM audit_log WHERE action = 'settings.update' AND entity_label = 'Appearance' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].changes).toMatchObject({ appName: { from: null, to: 'Plant IT' }, headerStyle: { from: 'dark', to: 'primary' } });

    // empty names fall back to the defaults
    await admin.put('/api/settings/appearance', { ...LOOK, brandName: '  ', appName: '' }).expect(200);
    expect((await request(app).get('/api/public-config').expect(200)).body).toMatchObject({ brandName: 'Infrastruktur', appName: 'IT Infrastructure' });
  });

  it('accepts PNG, JPEG or WebP logos and serves them publicly with a version and an ETag', async () => {
    const up = await uploadLogo(admin, 'light', png, 'logo.png').expect(200);
    expect(up.body.logos.light).toMatchObject({ mime: 'image/png', width: 240, height: 80 });
    expect(up.body.logos.dark).toBeNull();

    const cfg = await request(app).get('/api/public-config').expect(200);
    const url = cfg.body.logoUrl.light as string;
    expect(url).toMatch(/^\/api\/branding\/logo\/light\?v=[0-9a-f]{16}$/);
    expect(cfg.body.logoUrl.dark).toBeNull();

    // no sign-in needed – the sign-in page shows the logo
    const img = await request(app).get(url).buffer(true).parse(binary).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(img.body as Buffer, png)).toBe(0);
    const etag = img.headers.etag as string;
    expect(etag).toBeTruthy();
    await request(app).get(url).set('if-none-match', etag).expect(304);

    const { rows } = await pool.query(`SELECT changes FROM audit_log WHERE entity_label = 'Appearance' ORDER BY id DESC LIMIT 1`);
    expect(JSON.stringify(rows[0].changes)).toContain('240 × 80 px');
  });

  it('refuses SVG, broken and too large files', async () => {
    await uploadLogo(admin, 'dark', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'), 'evil.svg').expect(400);
    await uploadLogo(admin, 'dark', Buffer.from('not an image at all, just text'), 'logo.png').expect(400);
    const huge = Buffer.concat([png, Buffer.alloc(300 * 1024)]);
    await uploadLogo(admin, 'dark', huge, 'huge.png').expect(413);
    await uploadLogo(admin, 'sideways', png, 'logo.png').expect(404);
    await admin.agent.put('/api/settings/appearance/logo/dark').set('x-csrf-token', admin.csrf).expect(400);
    const status = await admin.get('/api/settings/appearance').expect(200);
    expect(status.body.logos.dark).toBeNull();
  });

  it('removes a logo again', async () => {
    const url = (await request(app).get('/api/public-config').expect(200)).body.logoUrl.light as string;
    const res = await admin.del('/api/settings/appearance/logo/light').expect(200);
    expect(res.body.logos.light).toBeNull();
    await request(app).get(url).expect(404);
    expect((await request(app).get('/api/public-config').expect(200)).body.logoUrl.light).toBeNull();
  });
});

describe('appearance with environment variables', () => {
  let app: Express;
  let pool: Pool;
  let admin: Session;

  beforeAll(async () => {
    ({ app, pool } = await setupTestApp({ env: { BRAND_NAME: 'Env Corp', BRAND_PRIMARY_COLOR: '#15803d' } }));
    admin = await login(app, 'admin');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('lets variables that are set win over the settings in the app', async () => {
    const status = await admin.put('/api/settings/appearance', LOOK).expect(200);
    expect(status.body.env).toEqual({ brandName: true, appName: false, primaryColor: true });
    expect(status.body.effective).toMatchObject({ brandName: 'Env Corp', appName: 'Plant IT', primaryColor: '#15803d', headerStyle: 'primary' });
    const cfg = await request(app).get('/api/public-config').expect(200);
    expect(cfg.body).toMatchObject({ brandName: 'Env Corp', appName: 'Plant IT', primaryColor: '#15803d' });
  });
});

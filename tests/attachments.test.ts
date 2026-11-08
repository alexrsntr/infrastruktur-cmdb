import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type request from 'supertest';
import { login, setupTestApp, type Session } from './helpers';
import { drawFloorPlan, OFFICE_LAYOUT } from '../server/db/floorplan';

let app: Express;
let pool: Pool;
let admin: Session;
let editor: Session;
let operator: Session;
let viewer: Session;
let muc: { id: string };
let ham: { id: string };
let mucAsset: { id: string; name: string };
let hamAsset: { id: string; name: string };

const png = drawFloorPlan(320, 200, OFFICE_LAYOUT.slice(0, 1));
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

function upload(s: Session, fields: Record<string, string>, file: Buffer, name: string) {
  let req = s.agent.post('/api/attachments').set('x-csrf-token', s.csrf);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', file, name);
}

beforeAll(async () => {
  process.env.ATTACHMENT_MAX_MB = '1';
  ({ app, pool } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  operator = await login(app, 'operator');
  viewer = await login(app, 'viewer');
  const plants = (await admin.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
  ham = plants.find((p) => p.code === 'HAM')!;
  mucAsset = (await admin.get(`/api/assets?plantId=${muc.id}&type=switch&pageSize=1`).expect(200)).body.items[0];
  hamAsset = (await admin.get(`/api/assets?plantId=${ham.id}&type=switch&pageSize=1`).expect(200)).body.items[0];
});

afterAll(async () => {
  delete process.env.ATTACHMENT_MAX_MB;
  await pool.end();
});

describe('upload & detection', () => {
  it('lets operators upload, detects images and never trusts the client type', async () => {
    const res = await upload(operator, { entityType: 'asset', entityId: mucAsset.id }, png, 'rack-front.jpg').expect(201);
    expect(res.body).toMatchObject({
      file_name: 'rack-front.jpg',
      content_type: 'image/png',
      image_width: 320,
      image_height: 200,
      category: 'photo',
      is_plan: false,
      created_by_name: expect.stringMatching(/Olga/),
      entity_label: mucAsset.name,
    });
    expect(res.body).not.toHaveProperty('sha256');
    expect(res.body).not.toHaveProperty('storage_key');
  });

  it('picks sensible default categories', async () => {
    const doc = await upload(operator, { entityType: 'asset', entityId: mucAsset.id }, pdf, 'datasheet.pdf').expect(201);
    expect(doc.body).toMatchObject({ content_type: 'application/pdf', category: 'document' });
    const cfg = await upload(operator, { entityType: 'asset', entityId: mucAsset.id }, Buffer.from('hostname sw01\n'), 'running-config.cfg').expect(201);
    expect(cfg.body).toMatchObject({ content_type: 'text/plain', category: 'config' });
    const bin = await upload(operator, { entityType: 'asset', entityId: mucAsset.id, category: 'other', title: 'Firmware' }, Buffer.from([0, 1, 2, 3, 4]), 'firmware.bin').expect(201);
    expect(bin.body).toMatchObject({ content_type: 'application/octet-stream', category: 'other', title: 'Firmware' });
    // a PDF name without PDF content is not treated as PDF
    const fake = await upload(operator, { entityType: 'asset', entityId: mucAsset.id }, Buffer.from('<script>alert(1)</script>'), 'fake.pdf').expect(201);
    expect(fake.body.content_type).toBe('application/octet-stream');
  });

  it('blocks executables, scripts and web pages', async () => {
    for (const name of ['evil.html', 'drawing.svg', 'setup.exe', 'run.ps1', 'x.js']) {
      const res = await upload(operator, { entityType: 'asset', entityId: mucAsset.id }, Buffer.from('x'), name).expect(400);
      expect(res.body.error).toMatch(/not allowed/);
    }
  });

  it('enforces the size limit', async () => {
    const res = await upload(operator, { entityType: 'asset', entityId: mucAsset.id }, Buffer.alloc(1024 * 1024 + 10, 1), 'big.bin').expect(413);
    expect(res.body.error).toMatch(/1 MB/);
  });

  it('validates fields and permissions', async () => {
    await upload(viewer, { entityType: 'asset', entityId: mucAsset.id }, png, 'x.png').expect(403);
    await upload(operator, { entityType: 'toaster', entityId: mucAsset.id }, png, 'x.png').expect(400);
    await upload(operator, { entityType: 'asset', entityId: hamAsset.id }, png, 'x.png').expect(403);
    await upload(operator, { entityType: 'asset', entityId: mucAsset.id, isPlan: 'true' }, pdf, 'plan.pdf').expect(400);
  });

  it('accepts pictures as plans', async () => {
    const res = await upload(editor, { entityType: 'plant', entityId: muc.id, isPlan: 'true', title: 'Aerial view' }, png, 'aerial.png').expect(201);
    expect(res.body).toMatchObject({ is_plan: true, category: 'plan', title: 'Aerial view', entity_type: 'plant' });
  });
});

describe('download', () => {
  it('serves images and PDFs inline with safe headers', async () => {
    const list = (await viewer.get(`/api/attachments?entityType=asset&entityId=${mucAsset.id}`).expect(200)).body;
    const img = list.find((a: { file_name: string }) => a.file_name === 'rack-front.jpg');
    const res = await viewer.get(`/api/attachments/${img.id}/file`).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="rack-front.jpg"/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/sandbox/);
    expect(Buffer.compare(res.body as Buffer, png)).toBe(0);

    const again = await viewer.get(`/api/attachments/${img.id}/file`).set('If-None-Match', res.headers.etag).expect(304);
    expect(again.body).toEqual({});

    const doc = list.find((a: { file_name: string }) => a.file_name === 'datasheet.pdf');
    const pdfRes = await viewer.get(`/api/attachments/${doc.id}/file`).buffer(true).parse(binary).expect(200);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    expect(pdfRes.headers['content-disposition']).toMatch(/^inline/);
    const forced = await viewer.get(`/api/attachments/${doc.id}/file?download=1`).buffer(true).parse(binary).expect(200);
    expect(forced.headers['content-disposition']).toMatch(/^attachment/);
    expect(forced.headers['content-type']).toBe('application/octet-stream');
  });

  it('forces download for other types', async () => {
    const list = (await viewer.get(`/api/attachments?entityType=asset&entityId=${mucAsset.id}`).expect(200)).body;
    for (const name of ['firmware.bin', 'fake.pdf']) {
      const a = list.find((x: { file_name: string }) => x.file_name === name);
      const res = await viewer.get(`/api/attachments/${a.id}/file`).buffer(true).parse(binary).expect(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toMatch(/^attachment/);
    }
  });

  it('encodes non-ASCII file names (RFC 5987)', async () => {
    const up = await upload(operator, { entityType: 'asset', entityId: mucAsset.id }, pdf, 'Prüfbericht Schaltschrank.pdf').expect(201);
    expect(up.body.file_name).toBe('Prüfbericht Schaltschrank.pdf');
    const res = await viewer.get(`/api/attachments/${up.body.id}/file?download=1`).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Pr_fbericht Schaltschrank.pdf"; filename*=UTF-8''Pr%C3%BCfbericht%20Schaltschrank.pdf`,
    );
  });

  it('respects the plant scope', async () => {
    const hamFile = await upload(admin, { entityType: 'asset', entityId: hamAsset.id }, png, 'ham.png').expect(201);
    await operator.get(`/api/attachments?entityType=asset&entityId=${hamAsset.id}`).expect(403);
    await operator.get(`/api/attachments/${hamFile.body.id}`).expect(403);
    await operator.get(`/api/attachments/${hamFile.body.id}/file`).expect(403);
    await operator.get(`/api/export/files.zip?entityType=asset&entityId=${hamAsset.id}`).expect(403);
    await operator.get(`/api/export/files.zip?plantId=${ham.id}`).expect(403);
    const csv = await operator.get('/api/export/attachments?format=json').expect(200);
    const rows = JSON.parse(csv.text).data.Attachments as { file_name: string }[];
    expect(rows.some((r) => r.file_name === 'ham.png')).toBe(false);
    await viewer.get(`/api/attachments/${hamFile.body.id}/file`).expect(200);
  });
});

describe('edit & delete', () => {
  it('edits metadata and allows plans only for pictures', async () => {
    const list = (await operator.get(`/api/attachments?entityType=asset&entityId=${mucAsset.id}`).expect(200)).body;
    const img = list.find((a: { file_name: string }) => a.file_name === 'rack-front.jpg');
    const doc = list.find((a: { file_name: string }) => a.file_name === 'datasheet.pdf');
    await viewer.put(`/api/attachments/${img.id}`, { category: 'photo', is_plan: true }).expect(403);
    await operator.put(`/api/attachments/${doc.id}`, { category: 'document', is_plan: true }).expect(400);
    const res = await operator.put(`/api/attachments/${img.id}`, { title: 'Rack R01 front', category: 'photo', is_plan: true }).expect(200);
    expect(res.body).toMatchObject({ title: 'Rack R01 front', is_plan: true });

    await pool.query('INSERT INTO plan_marker (attachment_id, label, x, y) VALUES ($1, $2, 0.5, 0.5)', [img.id, 'Patch panel']);
    await operator.put(`/api/attachments/${img.id}`, { title: 'Rack R01 front', category: 'photo', is_plan: false }).expect(200);
    const markers = await pool.query('SELECT count(*) AS n FROM plan_marker WHERE attachment_id = $1', [img.id]);
    expect(markers.rows[0].n).toBe(0);
    const history = (await viewer.get(`/api/history?entityType=asset&entityId=${mucAsset.id}`).expect(200)).body;
    const upd = history.find((h: { action: string }) => h.action === 'attachment.update');
    expect(upd.changes).toMatchObject({ is_plan: { from: true, to: false }, plan_markers_removed: 1 });
    expect(history.filter((h: { action: string }) => h.action === 'attachment.add').length).toBeGreaterThan(3);
  });

  it('lets uploaders, editors and admins delete – nobody else', async () => {
    const own = await upload(operator, { entityType: 'asset', entityId: mucAsset.id }, png, 'own.png').expect(201);
    const foreign = await upload(admin, { entityType: 'asset', entityId: mucAsset.id }, png, 'admins.png').expect(201);
    await viewer.del(`/api/attachments/${own.body.id}`).expect(403);
    await operator.del(`/api/attachments/${foreign.body.id}`).expect(403);
    await operator.del(`/api/attachments/${own.body.id}`).expect(204);
    await editor.del(`/api/attachments/${foreign.body.id}`).expect(204);
    const blobs = await pool.query(`SELECT count(*) AS n FROM file_blob WHERE storage_key LIKE '%' || $1 || '%' OR storage_key LIKE '%' || $2 || '%'`, [own.body.id, foreign.body.id]);
    expect(blobs.rows[0].n).toBe(0);
    await viewer.get(`/api/attachments/${own.body.id}`).expect(404);
  });

  it('removes files when their object is deleted', async () => {
    const asset = (await editor.post('/api/assets', { type: 'server', name: 'muc-attach-test', plant_id: muc.id }).expect(201)).body;
    const att = await upload(editor, { entityType: 'asset', entityId: asset.id }, pdf, 'contract.pdf').expect(201);
    await editor.del(`/api/assets/${asset.id}`).expect(204);
    expect((await pool.query('SELECT count(*) AS n FROM attachment WHERE id = $1', [att.body.id])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*) AS n FROM file_blob WHERE storage_key LIKE '%' || $1 || '%'`, [att.body.id])).rows[0].n).toBe(0);

    const building = (await editor.post('/api/buildings', { plant_id: muc.id, code: 'ATT', name: 'Attachment test' }).expect(201)).body;
    const floor = (await editor.post('/api/floors', { building_id: building.id, name: 'EG', level: 0 }).expect(201)).body;
    const rack = (await editor.post('/api/racks', { building_id: building.id, name: 'R9' }).expect(201)).body;
    const ids = [
      (await upload(editor, { entityType: 'building', entityId: building.id }, png, 'b.png').expect(201)).body.id,
      (await upload(editor, { entityType: 'floor', entityId: floor.id }, png, 'f.png').expect(201)).body.id,
      (await upload(editor, { entityType: 'rack', entityId: rack.id }, png, 'r.png').expect(201)).body.id,
    ];
    await editor.del(`/api/buildings/${building.id}`).expect(204);
    expect((await pool.query('SELECT count(*) AS n FROM attachment WHERE id = ANY($1::uuid[])', [ids])).rows[0].n).toBe(0);
    const left = await pool.query(`SELECT count(*) AS n FROM file_blob WHERE ${ids.map((_, i) => `storage_key LIKE '%' || $${i + 1} || '%'`).join(' OR ')}`, ids);
    expect(left.rows[0].n).toBe(0);
  });
});

describe('exports', () => {
  it('exports attachment metadata with download links', async () => {
    const res = await viewer.get(`/api/export/attachments?format=csv&entityType=asset&entityId=${mucAsset.id}`).expect(200);
    expect(res.text).toContain('datasheet.pdf');
    expect(res.text).toMatch(/http:\/\/localhost:5173\/api\/attachments\/[0-9a-f-]+\/file\?download=1/);
    expect(res.text).not.toMatch(/storage_key|sha256/);
  });

  it('downloads all files of an object as ZIP with unique names', async () => {
    await upload(operator, { entityType: 'asset', entityId: mucAsset.id }, Buffer.from('v2'), 'running-config.cfg').expect(201);
    const res = await viewer.get(`/api/export/files.zip?entityType=asset&entityId=${mucAsset.id}`).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const names = new AdmZip(res.body as Buffer).getEntries().map((e) => e.entryName);
    expect(names).toEqual(expect.arrayContaining([`Asset ${mucAsset.name}/datasheet.pdf`, `Asset ${mucAsset.name}/running-config.cfg`, `Asset ${mucAsset.name}/running-config (2).cfg`]));
    const zip = new AdmZip(res.body as Buffer);
    expect(zip.getEntry(`Asset ${mucAsset.name}/datasheet.pdf`)!.getData().toString()).toContain('%PDF-1.4');
  });

  it('includes a plant ZIP and an Attachments sheet in the dossiers', async () => {
    const plantZip = await viewer.get(`/api/export/files.zip?plantId=${muc.id}`).buffer(true).parse(binary).expect(200);
    const names = new AdmZip(plantZip.body as Buffer).getEntries().map((e) => e.entryName);
    expect(names.some((n) => n.startsWith('Plant MUC') && n.endsWith('aerial.png'))).toBe(true);
    expect(names.some((n) => n.startsWith(`Asset ${mucAsset.name}/`))).toBe(true);

    const full = JSON.parse((await viewer.get('/api/export/full?format=json').expect(200)).text);
    expect(full.data.Attachments.length).toBeGreaterThan(5);
    const dossier = JSON.parse((await viewer.get(`/api/export/full?format=json&plantId=${ham.id}`).expect(200)).text);
    expect(dossier.data.Attachments.map((a: { file_name: string }) => a.file_name)).toEqual(['ham.png']);
    const assetDossier = JSON.parse((await viewer.get(`/api/export/asset/${mucAsset.id}?format=json`).expect(200)).text);
    expect(assetDossier.data.Attachments.length).toBeGreaterThan(3);
    await viewer.get('/api/export/files.zip').expect(400);
  });

  it('audits exports and uploads', async () => {
    const log = (await admin.get('/api/audit?action=export&entityType=files').expect(200)).body;
    expect(log.total).toBeGreaterThan(0);
    const adds = await pool.query(`SELECT count(*) AS n FROM audit_log WHERE action = 'attachment.add'`);
    expect(adds.rows[0].n).toBeGreaterThan(8);
  });
});

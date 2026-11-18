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
let sap: { id: string; name: string };
let mesMuc: { id: string; name: string };
let mesHam: { id: string; name: string };

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

const files = async (appId: string) =>
  (await pool.query(`SELECT id, plant_id, storage_key FROM attachment WHERE entity_type = 'application' AND entity_id = $1`, [appId])).rows as {
    id: string;
    plant_id: string | null;
    storage_key: string;
  }[];
const blobCount = async (keys: string[]) => Number((await pool.query('SELECT count(*) AS n FROM file_blob WHERE storage_key = ANY($1::text[])', [keys])).rows[0].n);

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  operator = await login(app, 'operator');
  viewer = await login(app, 'viewer');
  const plants = (await admin.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
  ham = plants.find((p) => p.code === 'HAM')!;
  const apps = (await admin.get('/api/applications').expect(200)).body as { id: string; name: string }[];
  sap = apps.find((a) => a.name === 'SAP ERP')!;
  mesMuc = apps.find((a) => a.name === 'MES MUC')!;
  mesHam = apps.find((a) => a.name === 'MES HAM')!;
});

afterAll(async () => {
  await pool.end();
});

describe('files on applications', () => {
  it('uploads contracts and documents to an application', async () => {
    const res = await upload(editor, { entityType: 'application', entityId: sap.id, category: 'contract', title: 'SAP maintenance contract' }, pdf, 'SAP Wartungsvertrag 2026.pdf').expect(201);
    expect(res.body).toMatchObject({
      entity_type: 'application',
      entity_id: sap.id,
      entity_label: 'SAP ERP',
      plant_id: null,
      file_name: 'SAP Wartungsvertrag 2026.pdf',
      content_type: 'application/pdf',
      category: 'contract',
      title: 'SAP maintenance contract',
      is_plan: false,
    });
    const auto = await upload(operator, { entityType: 'application', entityId: mesMuc.id }, pdf, 'MES manual.pdf').expect(201);
    expect(auto.body).toMatchObject({ category: 'document', plant_id: muc.id, entity_label: 'MES MUC' });

    const list = (await viewer.get(`/api/attachments?entityType=application&entityId=${sap.id}`).expect(200)).body;
    expect(list.map((a: { file_name: string }) => a.file_name)).toEqual(['SAP Wartungsvertrag 2026.pdf']);
    const file = await viewer.get(`/api/attachments/${list[0].id}/file`).buffer(true).parse(binary).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(file.body as Buffer, pdf)).toBe(0);
  });

  it('rejects unknown applications and never makes application pictures plans', async () => {
    await upload(editor, { entityType: 'application', entityId: '00000000-0000-4000-8000-000000000000' }, pdf, 'x.pdf').expect(404);
    const plan = await upload(editor, { entityType: 'application', entityId: sap.id, isPlan: 'true' }, png, 'architecture.png').expect(400);
    expect(plan.body.error).toMatch(/cannot be used as a plan/);
    const pic = await upload(editor, { entityType: 'application', entityId: sap.id }, png, 'architecture.png').expect(201);
    expect(pic.body).toMatchObject({ category: 'photo', is_plan: false });
    await editor.put(`/api/attachments/${pic.body.id}`, { category: 'plan', is_plan: true }).expect(400);
    // the database refuses it as well
    await expect(pool.query('UPDATE attachment SET is_plan = true WHERE id = $1', [pic.body.id])).rejects.toThrow(/attachment_application_no_plan_check/);
    expect((await viewer.get(`/api/plans?plantId=${muc.id}`).expect(200)).body.some((p: { id: string }) => p.id === pic.body.id)).toBe(false);
  });

  it('follows the plant scope: central applications can be read by everyone but only changed by unrestricted users', async () => {
    const sapFiles = (await operator.get(`/api/attachments?entityType=application&entityId=${sap.id}`).expect(200)).body as { id: string; file_name: string }[];
    expect(sapFiles.length).toBeGreaterThan(0);
    const contract = sapFiles.find((f) => f.file_name === 'SAP Wartungsvertrag 2026.pdf')!;
    await operator.get(`/api/attachments/${contract.id}`).expect(200);
    await operator.get(`/api/attachments/${contract.id}/file`).expect(200);
    await upload(operator, { entityType: 'application', entityId: sap.id }, pdf, 'x.pdf').expect(403);
    await operator.put(`/api/attachments/${contract.id}`, { category: 'document', is_plan: false }).expect(403);
    await operator.del(`/api/attachments/${contract.id}`).expect(403);

    // another plant's application is out of reach completely
    const hamFile = await upload(admin, { entityType: 'application', entityId: mesHam.id }, pdf, 'MES HAM contract.pdf').expect(201);
    await operator.get(`/api/attachments?entityType=application&entityId=${mesHam.id}`).expect(403);
    await operator.get(`/api/attachments/${hamFile.body.id}/file`).expect(403);
    await upload(operator, { entityType: 'application', entityId: mesHam.id }, pdf, 'x.pdf').expect(403);
    await operator.get(`/api/export/files.zip?entityType=application&entityId=${mesHam.id}`).expect(403);

    // exports: the central application's files are included, the other plant's are not
    const json = JSON.parse((await operator.get('/api/export/attachments?format=json').expect(200)).text).data.Attachments as { file_name: string; entity_type: string }[];
    expect(json.some((r) => r.file_name === 'SAP Wartungsvertrag 2026.pdf' && r.entity_type === 'application')).toBe(true);
    expect(json.some((r) => r.file_name === 'MES HAM contract.pdf')).toBe(false);

    // viewers (unrestricted) read everything but cannot upload
    await viewer.get(`/api/attachments/${hamFile.body.id}/file`).expect(200);
    await upload(viewer, { entityType: 'application', entityId: sap.id }, pdf, 'x.pdf').expect(403);
  });

  it('downloads all files of an application as ZIP', async () => {
    const res = await operator.get(`/api/export/files.zip?entityType=application&entityId=${sap.id}`).buffer(true).parse(binary).expect(200);
    const zip = new AdmZip(res.body as Buffer);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toEqual(expect.arrayContaining(['Application SAP ERP/SAP Wartungsvertrag 2026.pdf', 'Application SAP ERP/architecture.png']));
    expect(zip.getEntry('Application SAP ERP/SAP Wartungsvertrag 2026.pdf')!.getData().toString()).toContain('%PDF-1.4');

    // the files of a plant's application are part of the plant ZIP
    const plantZip = await viewer.get(`/api/export/files.zip?plantId=${muc.id}`).buffer(true).parse(binary).expect(200);
    expect(new AdmZip(plantZip.body as Buffer).getEntries().map((e) => e.entryName)).toContain('Application MES MUC/MES manual.pdf');
  });

  it('shows file changes in the application history', async () => {
    const history = (await viewer.get(`/api/applications/${sap.id}/history`).expect(200)).body as { action: string; changes: { file?: string } }[];
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'attachment.add', changes: expect.objectContaining({ file: 'SAP Wartungsvertrag 2026.pdf' }) })]));
  });

  it('moves the files along when the application changes its plant', async () => {
    const created = (await editor.post('/api/applications', { name: 'Move me', plant_id: muc.id }).expect(201)).body;
    await upload(editor, { entityType: 'application', entityId: created.id }, pdf, 'offer.pdf').expect(201);
    expect((await files(created.id))[0].plant_id).toBe(muc.id);
    await editor.put(`/api/applications/${created.id}`, { name: 'Move me', plant_id: ham.id }).expect(200);
    expect((await files(created.id))[0].plant_id).toBe(ham.id);
    await editor.put(`/api/applications/${created.id}`, { name: 'Move me', plant_id: null }).expect(200);
    expect((await files(created.id))[0].plant_id).toBeNull();
  });

  it('deletes the files together with the application', async () => {
    const created = (await editor.post('/api/applications', { name: 'Short-lived', plant_id: muc.id }).expect(201)).body;
    await upload(editor, { entityType: 'application', entityId: created.id }, pdf, 'contract.pdf').expect(201);
    await upload(editor, { entityType: 'application', entityId: created.id }, png, 'diagram.png').expect(201);
    const keys = (await files(created.id)).map((f) => f.storage_key);
    expect(await blobCount(keys)).toBe(2);
    await editor.del(`/api/applications/${created.id}`).expect(204);
    expect(await files(created.id)).toEqual([]);
    expect(await blobCount(keys)).toBe(0);
    const audit = (await pool.query(`SELECT changes FROM audit_log WHERE entity_type = 'application' AND entity_id = $1 AND action = 'delete'`, [created.id])).rows[0];
    expect(audit.changes).toMatchObject({ name: 'Short-lived', files_deleted: 2 });
  });

  it('deletes the files of a plant’s applications together with the plant', async () => {
    const plant = (await admin.post('/api/plants', { code: 'TMP', name: 'Temporary plant' }).expect(201)).body;
    const created = (await admin.post('/api/applications', { name: 'TMP app', plant_id: plant.id }).expect(201)).body;
    // the application moved here from another plant: the stored plant is out of date, the files must still go
    await upload(admin, { entityType: 'application', entityId: created.id }, pdf, 'tmp.pdf').expect(201);
    await pool.query('UPDATE attachment SET plant_id = $2 WHERE entity_type = $3 AND entity_id = $1', [created.id, ham.id, 'application']);
    const keys = (await files(created.id)).map((f) => f.storage_key);
    await admin.del(`/api/plants/${plant.id}`).expect(204);
    expect(await files(created.id)).toEqual([]);
    expect(await blobCount(keys)).toBe(0);
  });
});

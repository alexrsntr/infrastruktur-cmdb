import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';
import type { ImportReport, Plant } from '../shared/model';

let app: Express;
let pool: Pool;
let admin: Session;
let editor: Session;
let operator: Session;
let local: Session;

const upload = (s: Session, body: string | Buffer, name: string, dryRun: boolean) =>
  s.agent
    .post(`/api/import/plants?dryRun=${dryRun}`)
    .set('x-csrf-token', s.csrf)
    .attach('file', typeof body === 'string' ? Buffer.from(body) : body, name);

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  operator = await login(app, 'operator');
  local = await login(app, 'local');
});

afterAll(async () => {
  await pool.end();
});

describe('plant import', () => {
  const csv = [
    'Code;Name;Country;City;Address;Time zone;Contact',
    'NEF;Neuffen;Germany;Neuffen;Daimlerstraße 6-8;Europe/Berlin;Andreas Example',
    'SAO;São Paulo;Brazil;São Paulo;;America/Sao_Paulo;',
    ';No code;Germany;;;;',
    'MUC;Munich (renamed);;;;;',
  ].join('\n');

  it('needs the import permission', async () => {
    await upload(operator, csv, 'plants.csv', true).expect(403);
  });

  it('validates in a dry run without saving anything', async () => {
    const before = (await admin.get('/api/plants').expect(200)).body.length;
    const report = (await upload(editor, csv, 'plants.csv', true).expect(200)).body as ImportReport;
    expect(report).toMatchObject({ dryRun: true, total: 4, created: 2, updated: 1 });
    expect(report.errors).toEqual([{ row: 4, message: 'Code missing' }]);
    expect((await admin.get('/api/plants').expect(200)).body.length).toBe(before);
  });

  it('creates new plants and updates existing ones by code, keeping columns that are not in the file', async () => {
    const mucBefore = ((await admin.get('/api/plants').expect(200)).body as Plant[]).find((p) => p.code === 'MUC')!;
    const report = (await upload(editor, csv, 'plants.csv', false).expect(200)).body as ImportReport;
    expect(report).toMatchObject({ dryRun: false, created: 2, updated: 1 });
    const plants = (await admin.get('/api/plants').expect(200)).body as Plant[];
    expect(plants.find((p) => p.code === 'NEF')).toMatchObject({ name: 'Neuffen', city: 'Neuffen', address: 'Daimlerstraße 6-8', timezone: 'Europe/Berlin', contact: 'Andreas Example' });
    expect(plants.find((p) => p.code === 'SAO')).toMatchObject({ name: 'São Paulo', country: 'Brazil', address: null });
    const muc = plants.find((p) => p.code === 'MUC')!;
    // the file has the columns Country/City/Address (empty) → cleared; Latitude/Longitude/Description are missing → kept
    expect(muc).toMatchObject({ name: 'Munich (renamed)', country: null, city: null, latitude: mucBefore.latitude, description: mucBefore.description });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'import' AND entity_type = 'plants'`);
    expect(rows[0].n).toBe(1);
  });

  it('reads Excel files with the export headers and checks coordinates', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Plants');
    ws.addRow(['Code', 'Name', 'Latitude', 'Longitude']);
    ws.addRow(['NEF', 'Neuffen', 48.5532, 9.3742]);
    ws.addRow(['BAD', 'Bad coordinates', 'north', 9]);
    ws.addRow(['FAR', 'Too far north', 95, 9]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const report = (await upload(editor, buffer, 'plants.xlsx', false).expect(200)).body as ImportReport;
    expect(report).toMatchObject({ updated: 1, created: 0 });
    expect(report.errors.map((e) => e.row)).toEqual([3, 4]);
    const nef = ((await admin.get('/api/plants').expect(200)).body as Plant[]).find((p) => p.code === 'NEF')!;
    expect(nef).toMatchObject({ latitude: 48.5532, longitude: 9.3742, city: 'Neuffen' });
  });

  it('users restricted to plants only update their plants', async () => {
    const file = ['Code;Name;Contact', 'MUC;Munich;Lars', 'HAM;Hamburg;Lars', 'NEW;New plant;Lars'].join('\n');
    // local administrators have no import permission at all
    await upload(local, file, 'plants.csv', true).expect(403);
    await pool.query(`UPDATE app_user SET plant_scope = (SELECT array_agg(id) FROM plant WHERE code = 'MUC') WHERE email = 'erik.editor@example.local'`);
    const report = (await upload(editor, file, 'plants.csv', true).expect(200)).body as ImportReport;
    expect(report.updated).toBe(1);
    expect(report.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/outside of your plant scope/),
      expect.stringMatching(/without plant restriction/),
    ]);
    await pool.query(`UPDATE app_user SET plant_scope = '{}' WHERE email = 'erik.editor@example.local'`);
  });

  it('offers an Excel template: fill in the first sheet, import, all plants are created', async () => {
    await operator.get('/api/import/plants/template.xlsx').expect(403);
    const res = await editor.agent
      .get('/api/import/plants/template.xlsx')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200)
      .expect('content-type', /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Plants', 'Example', 'Help']);
    const sheet = wb.worksheets[0];
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(['Code', 'Name', 'Country', 'City', 'Address', 'Latitude', 'Longitude', 'Time zone', 'Contact', 'Description']);
    expect(sheet.rowCount).toBe(1); // nothing to delete before importing

    // a whole list of plants at once
    sheet.addRow(['BCN', 'Barcelona', 'Spain', 'Barcelona', 'Carrer Example 5', null, null, 'Europe/Madrid', 'IT Barcelona']);
    sheet.addRow(['IND', 'Pune', 'India', 'Pune', null, 18.5204, 73.8567, 'Asia/Kolkata']);
    sheet.addRow(['MEX', 'Ramos Arizpe', 'Mexico', 'Ramos Arizpe']);
    const filled = Buffer.from(await wb.xlsx.writeBuffer());
    const dry = (await upload(editor, filled, 'plants.xlsx', true).expect(200)).body as ImportReport;
    expect(dry).toMatchObject({ created: 3, updated: 0, errors: [] });
    const report = (await upload(editor, filled, 'plants.xlsx', false).expect(200)).body as ImportReport;
    expect(report).toMatchObject({ created: 3, errors: [] });
    const plants = (await admin.get('/api/plants').expect(200)).body as Plant[];
    expect(plants.find((p) => p.code === 'BCN')).toMatchObject({ name: 'Barcelona', address: 'Carrer Example 5', timezone: 'Europe/Madrid', contact: 'IT Barcelona' });
    expect(plants.find((p) => p.code === 'IND')).toMatchObject({ latitude: 18.5204, longitude: 73.8567 });
    expect(plants.find((p) => p.code === 'MEX')).toMatchObject({ country: 'Mexico' });
  });
});

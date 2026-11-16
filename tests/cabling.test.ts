import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';
import { ASSET_TYPES, cableCategoriesFor, isPassiveType, type Asset } from '../shared/model';

/** Cabling is passive infrastructure: the forms ask for cable label, A/B side, medium … instead of hostname, IP and serial number. */
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

describe('cabling', () => {
  it('is the only passive type', () => {
    expect(isPassiveType('cabling')).toBe(true);
    expect(isPassiveType('switch')).toBe(false);
    expect(isPassiveType(null)).toBe(false);
    // the first six fields are asked on the first page of the wizard
    expect(ASSET_TYPES.cabling.fields.slice(0, 6).map((f) => f.key)).toEqual(['medium', 'cable_category', 'endpoint_a', 'endpoint_b', 'links', 'length_m']);
  });

  it('offers the categories that fit the medium', () => {
    const all = ASSET_TYPES.cabling.fields.find((f) => f.key === 'cable_category')!.options!;
    expect(cableCategoriesFor('Copper (twisted pair)', all)).toEqual(['Cat 5e', 'Cat 6', 'Cat 6A', 'Cat 7', 'Cat 7A', 'Cat 8']);
    expect(cableCategoriesFor('Fibre single-mode', all)).toEqual(['OS1', 'OS2']);
    expect(cableCategoriesFor('Fibre multi-mode', all)).toEqual(['OM2', 'OM3', 'OM4', 'OM5']);
    expect(cableCategoriesFor('Coax', all)).toEqual(all);
    expect(cableCategoriesFor(undefined, all)).toEqual(all);
  });

  it('is created with its route and without network data', async () => {
    const plants = (await editor.get('/api/plants').expect(200)).body as { id: string; code: string }[];
    const muc = plants.find((p) => p.code === 'MUC')!;
    const created = (
      await editor
        .post('/api/assets', {
          type: 'cabling',
          name: 'MUC-B01-FO-BACKBONE-01',
          status: 'active',
          plant_id: muc.id,
          ip_address: null,
          serial_number: null,
          mac_address: null,
          manufacturer: 'Corning',
          model: 'Trunk 24x LC',
          attributes: { medium: 'Fibre single-mode', cable_category: 'OS2', endpoint_a: 'Server room R01, PP03', endpoint_b: 'Hall 2, PP01', links: 24, length_m: 180 },
        })
        .expect(201)
    ).body as Asset;
    expect(created).toMatchObject({ type: 'cabling', ip_address: null, serial_number: null, attributes: { medium: 'Fibre single-mode', endpoint_b: 'Hall 2, PP01', links: 24 } });
  });
});

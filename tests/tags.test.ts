import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { login, setupTestApp, type Session } from './helpers';

let app: Express;
let pool: Pool;
let admin: Session;
let editor: Session;
let operator: Session;
let muc: { id: string };
let ham: { id: string };

beforeAll(async () => {
  ({ app, pool } = await setupTestApp());
  admin = await login(app, 'admin');
  editor = await login(app, 'editor');
  operator = await login(app, 'operator');
  const plants = (await admin.get('/api/plants').expect(200)).body as { id: string; code: string }[];
  muc = plants.find((p) => p.code === 'MUC')!;
  ham = plants.find((p) => p.code === 'HAM')!;
});

afterAll(async () => {
  await pool.end();
});

type TagCount = { tag: string; count: number };
const find = (list: TagCount[], tag: string) => list.find((t) => t.tag.toLowerCase() === tag.toLowerCase());

describe('tags', () => {
  let a: { id: string };
  let b: { id: string };

  it('normalises tags and reuses the existing spelling', async () => {
    a = (await editor.post('/api/assets', { type: 'vm', name: 'muc-tag-vm1', plant_id: muc.id, tags: [' Backup ', 'backup', 'Linux'] }).expect(201)).body;
    expect((await editor.get(`/api/assets/${a.id}`).expect(200)).body.tags).toEqual(['Backup', 'Linux']);

    // another device: "BACKUP" becomes the known "Backup", new tags are kept as typed
    b = (await editor.post('/api/assets', { type: 'vm', name: 'ham-tag-vm1', plant_id: ham.id, tags: ['BACKUP', 'Hamburg only'] }).expect(201)).body;
    expect((await editor.get(`/api/assets/${b.id}`).expect(200)).body.tags).toEqual(['Backup', 'Hamburg only']);
  });

  it('lets the spelling of a tag change while only one device uses it', async () => {
    const asset = (await editor.get(`/api/assets/${b.id}`).expect(200)).body;
    const res = await editor.put(`/api/assets/${b.id}`, { ...asset, tags: ['Backup', 'HAMBURG ONLY'] }).expect(200);
    expect(res.body.tags).toEqual(['Backup', 'HAMBURG ONLY']);
  });

  it('lists the tags in use with device counts, limited to the plant scope', async () => {
    const all = (await admin.get('/api/tags').expect(200)).body as TagCount[];
    expect(find(all, 'backup')).toEqual({ tag: 'Backup', count: 2 });
    expect(find(all, 'hamburg only')).toEqual({ tag: 'HAMBURG ONLY', count: 1 });
    expect(all.map((t) => t.tag.toLowerCase())).toEqual([...all.map((t) => t.tag.toLowerCase())].sort());

    // the operator only sees Munich
    const scoped = (await operator.get('/api/tags').expect(200)).body as TagCount[];
    expect(find(scoped, 'backup')).toEqual({ tag: 'Backup', count: 1 });
    expect(find(scoped, 'hamburg only')).toBeUndefined();
    expect(find(scoped, 'wifi')!.count).toBeLessThan(find(all, 'wifi')!.count);

    const filtered = (await admin.get('/api/tags?q=back').expect(200)).body as TagCount[];
    expect(filtered.map((t) => t.tag)).toEqual(['Backup']);
  });

  it('filters the device list by tag, ignoring case', async () => {
    const res = await admin.get('/api/assets?tag=BACKUP').expect(200);
    expect(res.body.items.map((x: { name: string }) => x.name).sort()).toEqual(['ham-tag-vm1', 'muc-tag-vm1']);
    expect((await operator.get('/api/assets?tag=backup').expect(200)).body.total).toBe(1);
    // the free-text search of the list finds tags as well
    expect((await admin.get('/api/assets?q=hamburg%20only').expect(200)).body.total).toBe(1);
  });

  it('finds tags and tagged devices in the global search', async () => {
    const res = (await admin.get('/api/search?q=backu').expect(200)).body as { kind: string; title: string; subtitle: string }[];
    expect(res).toEqual(expect.arrayContaining([{ kind: 'tag', id: 'Backup', title: 'Backup', subtitle: '2 devices' }]));
    expect(res.filter((r) => r.kind === 'asset').map((r) => r.title).sort()).toEqual(['ham-tag-vm1', 'muc-tag-vm1']);

    const scoped = (await operator.get('/api/search?q=backu').expect(200)).body as { kind: string; title: string; subtitle: string }[];
    expect(scoped.find((r) => r.kind === 'tag')).toMatchObject({ title: 'Backup', subtitle: '1 device' });
    expect(scoped.filter((r) => r.kind === 'asset').map((r) => r.title)).toEqual(['muc-tag-vm1']);
  });
});

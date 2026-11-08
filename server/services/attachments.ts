import type { Pool } from 'pg';
import type { Config } from '../config';
import type { DbClient } from '../db/pool';
import type { EntityType } from '../../shared/model';
import { log } from '../lib/log';
import { ENTITY_LABEL_SQL } from '../routes/journal';
import { createStorage, type FileStorage } from './storage';

// ---------------------------------------------------------------------------
// Per-app context (one storage instance per pool; set up when the router is created)
// ---------------------------------------------------------------------------

interface AttachmentContext {
  storage: FileStorage;
  config: Config;
}

const contexts = new WeakMap<Pool, AttachmentContext>();

export function initAttachments(pool: Pool, config: Config): AttachmentContext {
  let ctx = contexts.get(pool);
  if (!ctx) {
    ctx = { storage: createStorage(pool, config), config };
    contexts.set(pool, ctx);
  }
  return ctx;
}

export function attachmentContext(pool: Pool): AttachmentContext {
  const ctx = contexts.get(pool);
  if (!ctx) throw new Error('Attachments are not initialised for this pool');
  return ctx;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/**
 * The plant an attachment currently belongs to, derived from its object. Used for plant scoping so
 * that moving an asset/building to another plant is reflected immediately (the stored plant_id is
 * only used for the storage key and FK cleanup).
 */
export const ATTACHMENT_PLANT_SQL = (alias: string) => `
  CASE ${alias}.entity_type
    WHEN 'plant' THEN ${alias}.entity_id
    WHEN 'building' THEN (SELECT x.plant_id FROM building x WHERE x.id = ${alias}.entity_id)
    WHEN 'floor' THEN (SELECT b.plant_id FROM floor x JOIN building b ON b.id = x.building_id WHERE x.id = ${alias}.entity_id)
    WHEN 'rack' THEN (SELECT b.plant_id FROM rack x JOIN building b ON b.id = x.building_id WHERE x.id = ${alias}.entity_id)
    WHEN 'asset' THEN (SELECT x.plant_id FROM asset x WHERE x.id = ${alias}.entity_id)
  END`;

export const ATTACHMENT_SELECT = `
  att.id, att.entity_type, att.entity_id, ${ENTITY_LABEL_SQL('att')} AS entity_label, att.plant_id, att.file_name,
  att.content_type, att.size_bytes, att.sha256, att.category, att.title, att.description, att.image_width, att.image_height,
  att.is_plan, att.created_by, u.display_name AS created_by_name, att.created_at, att.updated_at`;
export const ATTACHMENT_FROM = `FROM attachment att LEFT JOIN app_user u ON u.id = att.created_by`;

/**
 * Deletes the attachment rows of the given objects inside the caller's transaction and returns the
 * storage keys. Call purgeBlobs() with them after the transaction committed.
 */
export async function deleteAttachmentsFor(db: DbClient, entityType: EntityType, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<{ storage_key: string }>(
    'DELETE FROM attachment WHERE entity_type = $1 AND entity_id = ANY($2::uuid[]) RETURNING storage_key',
    [entityType, ids],
  );
  return rows.map((r) => r.storage_key);
}

/** All attachments that belong to a plant (any object inside it) – used before deleting the plant. */
export async function deleteAttachmentsForPlant(db: DbClient, plantId: string): Promise<string[]> {
  const { rows } = await db.query<{ storage_key: string }>(
    `DELETE FROM attachment att WHERE att.plant_id = $1 OR ${ATTACHMENT_PLANT_SQL('att')} = $1 RETURNING storage_key`,
    [plantId],
  );
  return rows.map((r) => r.storage_key);
}

/** Removes file contents after the metadata rows are gone. Best effort: failures are logged, never thrown. */
export async function purgeBlobs(pool: Pool, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const ctx = contexts.get(pool);
  if (!ctx) return;
  try {
    await ctx.storage.delete(keys);
  } catch (err) {
    log.error('attachments: could not delete files from storage', { error: (err as Error).message, count: keys.length });
  }
}

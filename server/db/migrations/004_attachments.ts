import type { Migration } from '../migrations';

/**
 * File attachments on plants, buildings, floors, racks and assets.
 * Metadata lives in `attachment`; file contents live in the configured storage
 * (Azure Blob Storage in production, table `file_blob` for local development/tests),
 * addressed by `storage_key`. Image attachments flagged `is_plan` can carry plan markers (migration 005).
 */
export const attachmentsMigration: Migration = {
  id: '004_attachments',
  sql: /* sql */ `
    CREATE TABLE attachment (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_type   text NOT NULL CHECK (entity_type IN ('plant','building','floor','rack','asset')),
      entity_id     uuid NOT NULL,
      plant_id      uuid REFERENCES plant(id) ON DELETE CASCADE,
      file_name     text NOT NULL,
      content_type  text NOT NULL,
      size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
      sha256        text NOT NULL,
      storage_key   text NOT NULL UNIQUE,
      category      text NOT NULL DEFAULT 'other' CHECK (category IN ('photo','plan','document','contract','config','other')),
      title         text,
      description   text,
      image_width   integer,
      image_height  integer,
      is_plan       boolean NOT NULL DEFAULT false,
      created_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CHECK (NOT is_plan OR (image_width IS NOT NULL AND image_height IS NOT NULL))
    );
    CREATE INDEX attachment_entity_idx ON attachment (entity_type, entity_id, created_at DESC);
    CREATE INDEX attachment_plant_idx ON attachment (plant_id);
    CREATE INDEX attachment_plan_idx ON attachment (plant_id) WHERE is_plan;

    -- Storage driver "database": file contents by storage key
    CREATE TABLE file_blob (
      storage_key  text PRIMARY KEY,
      data         bytea NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now()
    );
  `,
};

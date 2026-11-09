import type { Migration } from '../migrations';

/** Auto-discovery: sources (SNMP sweeps, Active Directory), runs and the inbox of discovered devices. */
export const discoveryMigration: Migration = {
  id: '016_discovery',
  sql: /* sql */ `
    CREATE TABLE discovery_source (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name            text NOT NULL,
      kind            text NOT NULL CHECK (kind IN ('snmp','ad')),
      enabled         boolean NOT NULL DEFAULT true,
      plant_id        uuid REFERENCES plant(id) ON DELETE SET NULL,
      schedule_hours  integer NOT NULL DEFAULT 0 CHECK (schedule_hours BETWEEN 0 AND 720),
      config          jsonb NOT NULL DEFAULT '{}',
      secrets_enc     text,
      last_run_at     timestamptz,
      last_status     text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX discovery_source_name_idx ON discovery_source (lower(name));

    CREATE TABLE discovery_run (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_id       uuid NOT NULL REFERENCES discovery_source(id) ON DELETE CASCADE,
      trigger         text NOT NULL DEFAULT 'manual',
      status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error')),
      started_at      timestamptz NOT NULL DEFAULT now(),
      finished_at     timestamptz,
      scanned         integer NOT NULL DEFAULT 0,
      found           integer NOT NULL DEFAULT 0,
      new_items       integer NOT NULL DEFAULT 0,
      updated_assets  integer NOT NULL DEFAULT 0,
      error           text
    );
    CREATE INDEX discovery_run_source_idx ON discovery_run (source_id, started_at DESC);

    CREATE TABLE discovery_item (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_id   uuid NOT NULL REFERENCES discovery_source(id) ON DELETE CASCADE,
      key         text NOT NULL,
      state       text NOT NULL DEFAULT 'new' CHECK (state IN ('new','linked','ignored')),
      asset_id    uuid REFERENCES asset(id) ON DELETE SET NULL,
      matched_by  text,
      data        jsonb NOT NULL,
      first_seen  timestamptz NOT NULL DEFAULT now(),
      last_seen   timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_id, key)
    );
    CREATE INDEX discovery_item_state_idx ON discovery_item (state);
    CREATE INDEX discovery_item_asset_idx ON discovery_item (asset_id);
  `,
};

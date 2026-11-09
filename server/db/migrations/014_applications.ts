import type { Migration } from '../migrations';

/** Business applications / IT services and the devices they run on (for the impact analysis). */
export const applicationsMigration: Migration = {
  id: '014_applications',
  sql: /* sql */ `
    CREATE TABLE application (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name         text NOT NULL,
      status       text NOT NULL DEFAULT 'production' CHECK (status IN ('planned','production','test','retired')),
      criticality  text NOT NULL DEFAULT 'medium' CHECK (criticality IN ('low','medium','high','critical')),
      plant_id     uuid REFERENCES plant(id) ON DELETE CASCADE,
      owner        text,
      url          text,
      description  text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
      updated_by   uuid REFERENCES app_user(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX application_name_idx ON application (lower(name));

    CREATE TABLE application_asset (
      application_id  uuid NOT NULL REFERENCES application(id) ON DELETE CASCADE,
      asset_id        uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
      role            text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (application_id, asset_id)
    );
    CREATE INDEX application_asset_asset_idx ON application_asset (asset_id);
    CREATE INDEX asset_relation_impact_idx ON asset_relation (target_id, relation);
  `,
};

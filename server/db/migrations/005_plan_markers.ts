import type { Migration } from '../migrations';

/**
 * Markers on plan images (site plans, aerial photos, hall pictures …): a marker points to an asset,
 * a building or is a free text label. Positions are normalised (0..1, origin top-left).
 */
export const planMarkersMigration: Migration = {
  id: '005_plan_markers',
  sql: /* sql */ `
    CREATE TABLE plan_marker (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      attachment_id  uuid NOT NULL REFERENCES attachment(id) ON DELETE CASCADE,
      asset_id       uuid REFERENCES asset(id) ON DELETE CASCADE,
      building_id    uuid REFERENCES building(id) ON DELETE CASCADE,
      label          text,
      x              double precision NOT NULL CHECK (x BETWEEN 0 AND 1),
      y              double precision NOT NULL CHECK (y BETWEEN 0 AND 1),
      created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      CHECK ((asset_id IS NOT NULL)::int + (building_id IS NOT NULL)::int + (label IS NOT NULL)::int = 1)
    );
    CREATE UNIQUE INDEX plan_marker_asset_uidx ON plan_marker (attachment_id, asset_id) WHERE asset_id IS NOT NULL;
    CREATE UNIQUE INDEX plan_marker_building_uidx ON plan_marker (attachment_id, building_id) WHERE building_id IS NOT NULL;
    CREATE INDEX plan_marker_attachment_idx ON plan_marker (attachment_id);
    CREATE INDEX plan_marker_asset_idx ON plan_marker (asset_id);
  `,
};

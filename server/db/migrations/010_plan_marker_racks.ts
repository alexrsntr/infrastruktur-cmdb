import type { Migration } from '../migrations';

/** Whole racks can be placed on plan images (site plans, hall pictures …), next to devices, buildings and labels. */
export const planMarkerRacksMigration: Migration = {
  id: '010_plan_marker_racks',
  sql: /* sql */ `
    ALTER TABLE plan_marker ADD COLUMN rack_id uuid REFERENCES rack(id) ON DELETE CASCADE;

    -- the unnamed "exactly one target" check from 005 – replaced by one that includes racks
    DO $$
    DECLARE c text;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'plan_marker'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%building_id IS NOT NULL%'
      LOOP
        EXECUTE format('ALTER TABLE plan_marker DROP CONSTRAINT %I', c);
      END LOOP;
    END $$;

    ALTER TABLE plan_marker ADD CONSTRAINT plan_marker_one_target_check
      CHECK ((asset_id IS NOT NULL)::int + (building_id IS NOT NULL)::int + (rack_id IS NOT NULL)::int + (label IS NOT NULL)::int = 1);
    CREATE UNIQUE INDEX plan_marker_rack_uidx ON plan_marker (attachment_id, rack_id) WHERE rack_id IS NOT NULL;
    CREATE INDEX plan_marker_rack_idx ON plan_marker (rack_id);
  `,
};

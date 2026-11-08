import type { Migration } from '../migrations';

/**
 * Racks as first-class objects:
 *  - rack (per building, optional floor/room, height in U, numbering direction)
 *  - rack_item for non-CI equipment (patch panels, cable management, UPS, shelves …)
 *  - asset.rack_id / rack_u (lowest occupied unit) / rack_height_u
 * Existing free-text asset.rack / asset.rack_unit values are converted into racks and positions.
 */
export const racksMigration: Migration = {
  id: '002_racks',
  sql: /* sql */ `
    CREATE TABLE rack (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      building_id   uuid NOT NULL REFERENCES building(id) ON DELETE CASCADE,
      floor_id      uuid REFERENCES floor(id) ON DELETE SET NULL,
      name          text NOT NULL,
      room          text,
      height_u      integer NOT NULL DEFAULT 42 CHECK (height_u BETWEEN 1 AND 60),
      numbering     text NOT NULL DEFAULT 'bottom_up' CHECK (numbering IN ('bottom_up','top_down')),
      manufacturer  text,
      model         text,
      description   text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
      updated_by    uuid REFERENCES app_user(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX rack_name_idx ON rack (building_id, lower(name));

    CREATE TABLE rack_item (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rack_id     uuid NOT NULL REFERENCES rack(id) ON DELETE CASCADE,
      kind        text NOT NULL CHECK (kind IN ('patch_panel','cable_management','ups','pdu','shelf','blank','other')),
      label       text NOT NULL,
      position_u  integer NOT NULL CHECK (position_u BETWEEN 1 AND 60),
      height_u    integer NOT NULL DEFAULT 1 CHECK (height_u BETWEEN 1 AND 20),
      note        text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX rack_item_rack_idx ON rack_item (rack_id);

    ALTER TABLE asset
      ADD COLUMN rack_id uuid REFERENCES rack(id) ON DELETE SET NULL,
      ADD COLUMN rack_u integer CHECK (rack_u BETWEEN 1 AND 60),
      ADD COLUMN rack_height_u integer NOT NULL DEFAULT 1 CHECK (rack_height_u BETWEEN 1 AND 20);
    CREATE INDEX asset_rack_idx ON asset (rack_id);

    -- 1) Convert existing free-text racks ("R01") into rack objects (one per building and name)
    INSERT INTO rack (building_id, floor_id, name, room)
    SELECT DISTINCT ON (a.building_id, lower(btrim(a.rack))) a.building_id, a.floor_id, btrim(a.rack), a.room
    FROM asset a
    WHERE a.rack IS NOT NULL AND btrim(a.rack) <> '' AND a.building_id IS NOT NULL
    ORDER BY a.building_id, lower(btrim(a.rack)), a.created_at;

    UPDATE asset a
       SET rack_id = r.id
      FROM rack r
     WHERE a.rack IS NOT NULL
       AND r.building_id = a.building_id
       AND lower(r.name) = lower(btrim(a.rack));

    -- 2) Convert unit texts like "12", "U12" or "40-41" into position + height
    UPDATE asset a
       SET rack_u = CASE WHEN p.lo BETWEEN 1 AND 60 THEN p.lo END,
           rack_height_u = LEAST(20, GREATEST(1, p.hi - p.lo + 1))
      FROM (
        SELECT id, LEAST(u1, COALESCE(u2, u1)) AS lo, GREATEST(u1, COALESCE(u2, u1)) AS hi
        FROM (
          SELECT id,
                 (substring(rack_unit from '^\\s*U?\\s*(\\d+)'))::int AS u1,
                 (substring(rack_unit from '^\\s*U?\\s*\\d+\\s*-\\s*U?\\s*(\\d+)'))::int AS u2
          FROM asset
          WHERE rack_id IS NOT NULL AND rack_unit ~ '^\\s*U?\\s*\\d+'
        ) s
      ) p
     WHERE p.id = a.id;

    -- 3) Make converted racks high enough for their content
    UPDATE rack r
       SET height_u = LEAST(60, GREATEST(r.height_u, x.top))
      FROM (SELECT rack_id, max(rack_u + rack_height_u - 1) AS top FROM asset WHERE rack_u IS NOT NULL GROUP BY rack_id) x
     WHERE x.rack_id = r.id;

    ALTER TABLE asset DROP COLUMN rack, DROP COLUMN rack_unit;

    -- Racks can carry notes and activities like plants, buildings, floors and assets
    ALTER TABLE note DROP CONSTRAINT note_entity_type_check;
    ALTER TABLE note ADD CONSTRAINT note_entity_type_check CHECK (entity_type IN ('plant','building','floor','rack','asset'));
    ALTER TABLE activity DROP CONSTRAINT activity_entity_type_check;
    ALTER TABLE activity ADD CONSTRAINT activity_entity_type_check CHECK (entity_type IN ('plant','building','floor','rack','asset'));
  `,
};

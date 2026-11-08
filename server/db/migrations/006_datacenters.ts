import type { Migration } from '../migrations';

/**
 * Data centers as a logical grouping of server rooms. A "stretched" data center spans two buildings
 * (site A / site B, optionally a witness site). Racks belong to a site through its building (and room),
 * site-to-site links (fibre trunks, WAN …) are documented in datacenter_link.
 */
export const datacentersMigration: Migration = {
  id: '006_datacenters',
  sql: /* sql */ `
    CREATE TABLE datacenter (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plant_id     uuid NOT NULL REFERENCES plant(id) ON DELETE CASCADE,
      name         text NOT NULL,
      kind         text NOT NULL DEFAULT 'stretched' CHECK (kind IN ('single','stretched')),
      description  text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
      updated_by   uuid REFERENCES app_user(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX datacenter_name_idx ON datacenter (plant_id, lower(name));

    CREATE TABLE datacenter_site (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      datacenter_id  uuid NOT NULL REFERENCES datacenter(id) ON DELETE CASCADE,
      name           text NOT NULL,
      role           text NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','secondary','witness')),
      building_id    uuid NOT NULL REFERENCES building(id) ON DELETE CASCADE,
      room           text,
      position       integer NOT NULL DEFAULT 0
    );
    CREATE INDEX datacenter_site_dc_idx ON datacenter_site (datacenter_id, position);
    CREATE INDEX datacenter_site_building_idx ON datacenter_site (building_id);

    CREATE TABLE datacenter_link (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      datacenter_id  uuid NOT NULL REFERENCES datacenter(id) ON DELETE CASCADE,
      site_a_id      uuid NOT NULL REFERENCES datacenter_site(id) ON DELETE CASCADE,
      site_b_id      uuid NOT NULL REFERENCES datacenter_site(id) ON DELETE CASCADE,
      kind           text NOT NULL DEFAULT 'fiber' CHECK (kind IN ('fiber','copper','wan','other')),
      label          text NOT NULL,
      capacity       text,
      length_m       integer CHECK (length_m IS NULL OR length_m >= 0),
      note           text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      CHECK (site_a_id <> site_b_id)
    );
    CREATE INDEX datacenter_link_dc_idx ON datacenter_link (datacenter_id);
  `,
};

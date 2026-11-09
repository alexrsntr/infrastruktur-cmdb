import type { Migration } from '../migrations';

/**
 * Network documentation: ports per device with a symmetric port-to-port connection (cable label on both ends),
 * VLANs per plant and IP subnets (IPAM). Used and free addresses are derived from asset.ip_address.
 */
export const networkMigration: Migration = {
  id: '013_network',
  sql: /* sql */ `
    -- asset.ip_address is free text ("10.1.2.3" or "10.1.2.3/24"); NULL instead of an error for anything else
    CREATE FUNCTION cmdb_inet(v text) RETURNS inet LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;
      RETURN host(split_part(btrim(v), '/', 1)::inet)::inet;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END $$;
    CREATE INDEX asset_inet_idx ON asset USING gist (cmdb_inet(ip_address) inet_ops);

    CREATE TABLE vlan (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plant_id     uuid NOT NULL REFERENCES plant(id) ON DELETE CASCADE,
      vid          integer NOT NULL CHECK (vid BETWEEN 1 AND 4094),
      name         text NOT NULL,
      description  text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX vlan_plant_vid_idx ON vlan (plant_id, vid);

    CREATE TABLE subnet (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plant_id     uuid NOT NULL REFERENCES plant(id) ON DELETE CASCADE,
      cidr         cidr NOT NULL,
      name         text NOT NULL,
      vlan_id      uuid REFERENCES vlan(id) ON DELETE SET NULL,
      gateway      inet,
      dhcp_range   text,
      description  text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX subnet_plant_cidr_idx ON subnet (plant_id, cidr);
    CREATE INDEX subnet_cidr_idx ON subnet USING gist (cidr inet_ops);

    CREATE TABLE asset_port (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      asset_id           uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
      name               text NOT NULL,
      position           integer NOT NULL DEFAULT 0,
      kind               text NOT NULL DEFAULT 'ethernet' CHECK (kind IN ('ethernet','sfp','mgmt','console','wifi','other')),
      speed              text,
      description        text,
      enabled            boolean NOT NULL DEFAULT true,
      mode               text CHECK (mode IN ('access','trunk')),
      untagged_vlan      integer CHECK (untagged_vlan BETWEEN 1 AND 4094),
      tagged_vlans       integer[] NOT NULL DEFAULT '{}',
      mac_address        text,
      connected_port_id  uuid UNIQUE REFERENCES asset_port(id) ON DELETE SET NULL,
      cable_label        text,
      source             text NOT NULL DEFAULT 'manual',
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      CHECK (connected_port_id IS NULL OR connected_port_id <> id)
    );
    CREATE UNIQUE INDEX asset_port_name_idx ON asset_port (asset_id, lower(name));
    CREATE INDEX asset_port_cable_idx ON asset_port (lower(cable_label)) WHERE cable_label IS NOT NULL;
  `,
};

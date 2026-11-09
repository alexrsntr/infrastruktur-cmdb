// Database migrations. Each migration runs exactly once, in order, inside a transaction.
// Never edit a migration that has been deployed – add a new one instead.

import { racksMigration } from './migrations/002_racks';
import { notificationsMigration } from './migrations/003_notifications';
import { attachmentsMigration } from './migrations/004_attachments';
import { planMarkersMigration } from './migrations/005_plan_markers';
import { datacentersMigration } from './migrations/006_datacenters';
import { localAccountsMigration } from './migrations/007_local_accounts';
import { upsMigration } from './migrations/008_ups';
import { entraSettingsMigration } from './migrations/009_entra_settings';
import { planMarkerRacksMigration } from './migrations/010_plan_marker_racks';
import { assetTypesMigration } from './migrations/011_asset_types';
import { lifecycleMigration } from './migrations/012_lifecycle';
import { networkMigration } from './migrations/013_network';

export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: '001_initial_schema',
    sql: /* sql */ `
      CREATE TABLE app_user (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        oid             text UNIQUE,                 -- Entra object id
        tenant_id       text,
        email           text,
        display_name    text NOT NULL,
        role            text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','editor','operator','viewer')),
        role_source     text NOT NULL DEFAULT 'local' CHECK (role_source IN ('entra','local')),
        plant_scope     uuid[] NOT NULL DEFAULT '{}',
        active          boolean NOT NULL DEFAULT true,
        last_login_at   timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX app_user_email_idx ON app_user (lower(email)) WHERE oid IS NULL AND email IS NOT NULL;

      CREATE TABLE plant (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code         text NOT NULL,
        name         text NOT NULL,
        country      text,
        city         text,
        address      text,
        latitude     double precision CHECK (latitude BETWEEN -90 AND 90),
        longitude    double precision CHECK (longitude BETWEEN -180 AND 180),
        timezone     text,
        contact      text,
        description  text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by   uuid REFERENCES app_user(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX plant_code_idx ON plant (lower(code));

      CREATE TABLE building (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        plant_id     uuid NOT NULL REFERENCES plant(id) ON DELETE CASCADE,
        code         text NOT NULL,
        name         text NOT NULL,
        description  text,
        latitude     double precision CHECK (latitude BETWEEN -90 AND 90),
        longitude    double precision CHECK (longitude BETWEEN -180 AND 180),
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by   uuid REFERENCES app_user(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX building_code_idx ON building (plant_id, lower(code));

      CREATE TABLE floor (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        building_id      uuid NOT NULL REFERENCES building(id) ON DELETE CASCADE,
        name             text NOT NULL,
        level            integer NOT NULL DEFAULT 0,
        plan_image       bytea,
        plan_mime        text,
        plan_width       integer,
        plan_height      integer,
        plan_updated_at  timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX floor_building_idx ON floor (building_id, level);

      CREATE TABLE asset (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        type           text NOT NULL CHECK (type IN ('switch','access_point','server','vm')),
        name           text NOT NULL,
        status         text NOT NULL DEFAULT 'active' CHECK (status IN ('planned','active','maintenance','defective','retired')),
        criticality    text NOT NULL DEFAULT 'medium' CHECK (criticality IN ('low','medium','high','critical')),
        plant_id       uuid REFERENCES plant(id) ON DELETE RESTRICT,
        building_id    uuid REFERENCES building(id) ON DELETE SET NULL,
        floor_id       uuid REFERENCES floor(id) ON DELETE SET NULL,
        room           text,
        rack           text,
        rack_unit      text,
        map_x          double precision CHECK (map_x BETWEEN 0 AND 1),
        map_y          double precision CHECK (map_y BETWEEN 0 AND 1),
        manufacturer   text,
        model          text,
        serial_number  text,
        asset_tag      text,
        ip_address     text,
        mac_address    text,
        fqdn           text,
        os             text,
        owner          text,
        cost_center    text,
        purchase_date  date,
        warranty_end   date,
        description    text,
        tags           text[] NOT NULL DEFAULT '{}',
        attributes     jsonb NOT NULL DEFAULT '{}',
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by     uuid REFERENCES app_user(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX asset_type_name_idx ON asset (type, lower(name));
      CREATE INDEX asset_plant_idx ON asset (plant_id);
      CREATE INDEX asset_building_idx ON asset (building_id);
      CREATE INDEX asset_floor_idx ON asset (floor_id);
      CREATE INDEX asset_status_idx ON asset (status);
      CREATE INDEX asset_serial_idx ON asset (lower(serial_number));
      CREATE INDEX asset_ip_idx ON asset (ip_address);

      CREATE TABLE asset_relation (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id    uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
        target_id    uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
        relation     text NOT NULL CHECK (relation IN ('uplink','runs_on','connected_to','depends_on','redundant_with')),
        source_port  text,
        target_port  text,
        note         text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
        CHECK (source_id <> target_id)
      );
      CREATE UNIQUE INDEX asset_relation_unique_idx ON asset_relation (source_id, target_id, relation);
      CREATE INDEX asset_relation_target_idx ON asset_relation (target_id);

      CREATE TABLE note (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type  text NOT NULL CHECK (entity_type IN ('plant','building','floor','asset')),
        entity_id    uuid NOT NULL,
        plant_id     uuid REFERENCES plant(id) ON DELETE CASCADE,
        body         text NOT NULL,
        pinned       boolean NOT NULL DEFAULT false,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL
      );
      CREATE INDEX note_entity_idx ON note (entity_type, entity_id);
      CREATE INDEX note_plant_idx ON note (plant_id);

      CREATE TABLE activity (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type   text NOT NULL CHECK (entity_type IN ('plant','building','floor','asset')),
        entity_id     uuid NOT NULL,
        plant_id      uuid REFERENCES plant(id) ON DELETE CASCADE,
        kind          text NOT NULL CHECK (kind IN ('maintenance','incident','change','installation','inspection','replacement','other')),
        status        text NOT NULL DEFAULT 'open' CHECK (status IN ('planned','open','in_progress','done','cancelled')),
        title         text NOT NULL,
        description   text,
        assignee      text,
        due_date      date,
        completed_at  timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        created_by    uuid REFERENCES app_user(id) ON DELETE SET NULL
      );
      CREATE INDEX activity_entity_idx ON activity (entity_type, entity_id);
      CREATE INDEX activity_plant_idx ON activity (plant_id);
      CREATE INDEX activity_status_idx ON activity (status, due_date);

      CREATE TABLE audit_log (
        id            bigserial PRIMARY KEY,
        at            timestamptz NOT NULL DEFAULT now(),
        user_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
        user_name     text,
        action        text NOT NULL,
        entity_type   text,
        entity_id     uuid,
        entity_label  text,
        plant_id      uuid,
        changes       jsonb,
        ip            text
      );
      CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id, at DESC);
      CREATE INDEX audit_at_idx ON audit_log (at DESC);
      CREATE INDEX audit_user_idx ON audit_log (user_id, at DESC);

      CREATE TABLE user_session (
        sid     varchar NOT NULL PRIMARY KEY,
        sess    json NOT NULL,
        expire  timestamp(6) NOT NULL
      );
      CREATE INDEX user_session_expire_idx ON user_session (expire);
    `,
  },
  racksMigration,
  notificationsMigration,
  attachmentsMigration,
  planMarkersMigration,
  datacentersMigration,
  localAccountsMigration,
  upsMigration,
  entraSettingsMigration,
  planMarkerRacksMigration,
  assetTypesMigration,
  lifecycleMigration,
  networkMigration,
];

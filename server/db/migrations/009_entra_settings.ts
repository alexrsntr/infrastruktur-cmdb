import type { Migration } from '../migrations';

/**
 * Microsoft Entra ID configured in the app (settings key "entra" in app_setting):
 * - entra_group_role: Entra group -> CMDB role (optionally restricted to plants), evaluated at sign-in
 * - app_user.role_source 'group': role comes from such a group mapping; role_detail names the group(s)
 */
export const entraSettingsMigration: Migration = {
  id: '009_entra_settings',
  sql: /* sql */ `
    CREATE TABLE entra_group_role (
      group_id      text PRIMARY KEY,
      display_name  text NOT NULL,
      role          text NOT NULL CHECK (role IN ('admin','editor','operator','viewer')),
      plant_scope   uuid[] NOT NULL DEFAULT '{}',
      created_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
      updated_at    timestamptz NOT NULL DEFAULT now(),
      updated_by    uuid REFERENCES app_user(id) ON DELETE SET NULL
    );

    ALTER TABLE app_user DROP CONSTRAINT app_user_role_source_check;
    ALTER TABLE app_user ADD CONSTRAINT app_user_role_source_check CHECK (role_source IN ('entra','group','local'));
    ALTER TABLE app_user ADD COLUMN role_detail text;
  `,
};

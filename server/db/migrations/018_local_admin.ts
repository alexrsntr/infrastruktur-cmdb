import type { Migration } from '../migrations';

/** Role "local_admin": sees only the assigned plants and changes existing entries there, but creates and deletes nothing. */
export const localAdminMigration: Migration = {
  id: '018_local_admin',
  sql: /* sql */ `
    ALTER TABLE app_user DROP CONSTRAINT app_user_role_check;
    ALTER TABLE app_user ADD CONSTRAINT app_user_role_check CHECK (role IN ('admin','editor','local_admin','operator','viewer'));
    ALTER TABLE entra_group_role DROP CONSTRAINT entra_group_role_role_check;
    ALTER TABLE entra_group_role ADD CONSTRAINT entra_group_role_role_check CHECK (role IN ('admin','editor','local_admin','operator','viewer'));
  `,
};

import type { Migration } from '../migrations';

/**
 * Local accounts (AUTH_MODE=local): sign-in with e-mail address and password, for installations
 * without Microsoft Entra ID (Docker, small sites). The hash format is described in server/auth/password.ts.
 */
export const localAccountsMigration: Migration = {
  id: '007_local_accounts',
  sql: /* sql */ `
    ALTER TABLE app_user ADD COLUMN password_hash text;
    ALTER TABLE app_user ADD COLUMN password_changed_at timestamptz;
  `,
};

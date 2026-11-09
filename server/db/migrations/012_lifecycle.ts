import type { Migration } from '../migrations';

/**
 * Lifecycle data: end of vendor support, end of life and the support contract, plus when the device was last seen
 * on the network (set by discovery and the API) – the basis for "Needs attention" on the home page.
 */
export const lifecycleMigration: Migration = {
  id: '012_lifecycle',
  sql: /* sql */ `
    ALTER TABLE asset ADD COLUMN support_end date;
    ALTER TABLE asset ADD COLUMN end_of_life date;
    ALTER TABLE asset ADD COLUMN support_contract text;
    ALTER TABLE asset ADD COLUMN last_seen_at timestamptz;
    CREATE INDEX asset_warranty_idx ON asset (warranty_end) WHERE warranty_end IS NOT NULL;
    CREATE INDEX asset_support_end_idx ON asset (support_end) WHERE support_end IS NOT NULL;
    CREATE INDEX asset_eol_idx ON asset (end_of_life) WHERE end_of_life IS NOT NULL;
  `,
};

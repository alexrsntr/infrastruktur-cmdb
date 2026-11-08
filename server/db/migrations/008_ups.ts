import type { Migration } from '../migrations';

/** UPS (uninterruptible power supply) as asset type and the relation "powered by" (device → UPS). */
export const upsMigration: Migration = {
  id: '008_ups',
  sql: /* sql */ `
    ALTER TABLE asset DROP CONSTRAINT asset_type_check;
    ALTER TABLE asset ADD CONSTRAINT asset_type_check CHECK (type IN ('switch','access_point','server','ups','vm'));
    ALTER TABLE asset_relation DROP CONSTRAINT asset_relation_relation_check;
    ALTER TABLE asset_relation ADD CONSTRAINT asset_relation_relation_check
      CHECK (relation IN ('uplink','runs_on','connected_to','depends_on','redundant_with','powered_by'));
  `,
};

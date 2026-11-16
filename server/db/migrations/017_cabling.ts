import type { Migration } from '../migrations';

/** Device type "Cabling": copper and fibre cabling documented like a device (backbone, riser, trunk, patch cabling). */
export const cablingMigration: Migration = {
  id: '017_cabling',
  sql: /* sql */ `
    ALTER TABLE asset DROP CONSTRAINT asset_type_check;
    ALTER TABLE asset ADD CONSTRAINT asset_type_check CHECK (type IN (
      'switch','router','firewall','access_point','wlan_controller','server','storage','vm','ups','pdu','ot_device','printer','camera','cabling','other'
    ));
  `,
};

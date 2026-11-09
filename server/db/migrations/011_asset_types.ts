import type { Migration } from '../migrations';

/** More device types: router, firewall, WLAN controller, storage, PDU, OT device, printer, camera, other. */
export const assetTypesMigration: Migration = {
  id: '011_asset_types',
  sql: /* sql */ `
    ALTER TABLE asset DROP CONSTRAINT asset_type_check;
    ALTER TABLE asset ADD CONSTRAINT asset_type_check CHECK (type IN (
      'switch','router','firewall','access_point','wlan_controller','server','storage','vm','ups','pdu','ot_device','printer','camera','other'
    ));
  `,
};

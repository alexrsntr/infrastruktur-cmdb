import type { Migration } from '../migrations';

/** International naming: the scorecard area "WLAN" becomes "Wi-Fi" (unless the plant already has a "Wi-Fi" area). */
export const wifiNamingMigration: Migration = {
  id: '021_wifi_naming',
  sql: /* sql */ `
    UPDATE plant_score s SET category = 'Wi-Fi'
    WHERE lower(s.category) = 'wlan'
      AND NOT EXISTS (SELECT 1 FROM plant_score o WHERE o.plant_id = s.plant_id AND lower(o.category) = 'wi-fi');
  `,
};

import type { Migration } from '../migrations';

/**
 * Racks can be positioned on the floor plan of their floor (building overview), like devices.
 * Positions are normalised (0..1, origin top-left); both are set or both are empty.
 */
export const rackFloorPositionMigration: Migration = {
  id: '024_rack_floor_position',
  sql: /* sql */ `
    ALTER TABLE rack
      ADD COLUMN map_x double precision CHECK (map_x BETWEEN 0 AND 1),
      ADD COLUMN map_y double precision CHECK (map_y BETWEEN 0 AND 1);
    ALTER TABLE rack ADD CONSTRAINT rack_map_position_check CHECK ((map_x IS NULL) = (map_y IS NULL));
  `,
};

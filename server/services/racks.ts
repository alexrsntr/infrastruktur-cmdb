import type { DbClient } from '../db/pool';
import { badRequest, conflict } from '../lib/http';

export function unitLabel(u: number, height: number): string {
  return height > 1 ? `U${u}–U${u + height - 1}` : `U${u}`;
}

/**
 * Ensures that units [u, u + height - 1] exist in the rack and are not used by another
 * device or rack item. `assetId` / `itemId` exclude the object that is being moved.
 */
export async function assertRackSlot(
  db: DbClient,
  rackId: string,
  u: number,
  height: number,
  opts: { assetId?: string | null; itemId?: string | null } = {},
) {
  const { rows: racks } = await db.query<{ name: string; height_u: number }>('SELECT name, height_u FROM rack WHERE id = $1', [rackId]);
  const rack = racks[0];
  if (!rack) throw badRequest('Rack does not exist');
  const top = u + height - 1;
  if (u < 1 || top > rack.height_u) {
    throw badRequest(`${unitLabel(u, height)} does not fit into rack ${rack.name} (${rack.height_u} U)`);
  }
  const { rows } = await db.query<{ label: string }>(
    `SELECT name AS label FROM asset
      WHERE rack_id = $1 AND rack_u IS NOT NULL AND id IS DISTINCT FROM $4::uuid
        AND rack_u <= $3 AND rack_u + rack_height_u - 1 >= $2
     UNION ALL
     SELECT label FROM rack_item
      WHERE rack_id = $1 AND id IS DISTINCT FROM $5::uuid
        AND position_u <= $3 AND position_u + height_u - 1 >= $2`,
    [rackId, u, top, opts.assetId ?? null, opts.itemId ?? null],
  );
  if (rows.length) {
    throw conflict(`${unitLabel(u, height)} in rack ${rack.name} is already occupied by ${rows.map((r) => r.label).join(', ')}`);
  }
}

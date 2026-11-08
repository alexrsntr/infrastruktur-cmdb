import type { CurrentUser, EntityType } from '../../shared/model';
import type { DbClient } from '../db/pool';
import { forbidden, notFound, type SqlBuilder } from './http';

/** True if the user can see every plant (admins, or users without a plant restriction). */
export function isUnscoped(user: CurrentUser): boolean {
  return user.role === 'admin' || user.plantScope.length === 0;
}

/**
 * Adds a WHERE clause restricting `column` (a plant_id column) to the user's plant scope.
 * Rows with a NULL plant are only visible to unscoped users.
 */
export function applyScope(sql: SqlBuilder, user: CurrentUser, column: string) {
  if (isUnscoped(user)) return;
  sql.and(`${column} = ANY(${sql.p(user.plantScope)}::uuid[])`);
}

export function hasPlantAccess(user: CurrentUser, plantId: string | null | undefined): boolean {
  if (isUnscoped(user)) return true;
  return !!plantId && user.plantScope.includes(plantId);
}

export function assertPlantAccess(user: CurrentUser, plantId: string | null | undefined) {
  if (!hasPlantAccess(user, plantId)) throw forbidden('This item is outside of your plant scope');
}

export interface EntityRef {
  plantId: string | null;
  label: string;
}

/** Resolves the owning plant and a human readable label for any entity notes/activities can be attached to. */
export async function resolveEntity(db: DbClient, type: EntityType, id: string): Promise<EntityRef> {
  let sql: string;
  switch (type) {
    case 'plant':
      sql = `SELECT id AS plant_id, code || ' – ' || name AS label FROM plant WHERE id = $1`;
      break;
    case 'building':
      sql = `SELECT b.plant_id, p.code || ' / ' || b.name AS label FROM building b JOIN plant p ON p.id = b.plant_id WHERE b.id = $1`;
      break;
    case 'floor':
      sql = `SELECT b.plant_id, p.code || ' / ' || b.name || ' / ' || f.name AS label
             FROM floor f JOIN building b ON b.id = f.building_id JOIN plant p ON p.id = b.plant_id WHERE f.id = $1`;
      break;
    case 'rack':
      sql = `SELECT b.plant_id, p.code || ' / ' || b.name || ' / ' || r.name AS label
             FROM rack r JOIN building b ON b.id = r.building_id JOIN plant p ON p.id = b.plant_id WHERE r.id = $1`;
      break;
    case 'asset':
      sql = `SELECT plant_id, name AS label FROM asset WHERE id = $1`;
      break;
  }
  const { rows } = await db.query<{ plant_id: string | null; label: string }>(sql, [id]);
  if (!rows[0]) throw notFound(type.charAt(0).toUpperCase() + type.slice(1));
  return { plantId: rows[0].plant_id, label: rows[0].label };
}

/** Resolves an entity and checks that the user may access it. */
export async function resolveEntityWithAccess(db: DbClient, user: CurrentUser, type: EntityType, id: string) {
  const ref = await resolveEntity(db, type, id);
  assertPlantAccess(user, ref.plantId);
  return ref;
}

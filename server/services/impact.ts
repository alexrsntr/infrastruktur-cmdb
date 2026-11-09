import { IMPACT_RELATIONS, type ImpactAsset, type ImpactResult } from '../../shared/applications';
import type { CurrentUser } from '../../shared/model';
import type { DbClient } from '../db/pool';
import { hasPlantAccess } from '../lib/scope';

const MAX_DEPTH = 25;

/**
 * Walks the dependency graph. direction "dependents": who fails when the start devices fail
 * (follow relations from target to source); "dependencies": what the start devices need (source to target).
 * Cycles are cut by the path array; every device is reported once with its shortest distance.
 */
export async function walkDependencies(db: DbClient, startIds: string[], direction: 'dependents' | 'dependencies'): Promise<(ImpactAsset & { plant_id: string | null; start_id: string })[]> {
  if (!startIds.length) return [];
  const [from, to] = direction === 'dependents' ? ['target_id', 'source_id'] : ['source_id', 'target_id'];
  const { rows } = await db.query(
    `WITH RECURSIVE walk(id, depth, relation, via_id, start_id, path) AS (
       SELECT r.${to}, 1, r.relation, r.${from}, r.${from}, ARRAY[r.${from}, r.${to}]
       FROM asset_relation r WHERE r.${from} = ANY($1::uuid[]) AND r.relation = ANY($2::text[])
       UNION ALL
       SELECT r.${to}, w.depth + 1, r.relation, r.${from}, w.start_id, w.path || r.${to}
       FROM walk w JOIN asset_relation r ON r.${from} = w.id AND r.relation = ANY($2::text[])
       WHERE NOT r.${to} = ANY(w.path) AND w.depth < ${MAX_DEPTH}
     ),
     best AS (
       SELECT DISTINCT ON (id) id, depth, relation, via_id, start_id FROM walk
       WHERE NOT id = ANY($1::uuid[]) ORDER BY id, depth
     )
     SELECT a.id, a.name, a.type, a.status, a.criticality, a.plant_id, p.code AS plant_code,
            b.depth, b.relation, b.via_id, v.name AS via_name, b.start_id
     FROM best b JOIN asset a ON a.id = b.id JOIN asset v ON v.id = b.via_id LEFT JOIN plant p ON p.id = a.plant_id
     ORDER BY b.depth, array_position(ARRAY['critical','high','medium','low'], a.criticality), a.name`,
    [startIds, IMPACT_RELATIONS],
  );
  return rows;
}

/** "If this device fails": affected devices and applications */
export async function impactOf(db: DbClient, user: CurrentUser, assetId: string): Promise<ImpactResult> {
  const affectedAll = await walkDependencies(db, [assetId], 'dependents');
  const affected = affectedAll.filter((a) => hasPlantAccess(user, a.plant_id));
  const ids = [assetId, ...affectedAll.map((a) => a.id)];
  const { rows: apps } = await db.query(
    `SELECT ap.id, ap.name, ap.status, ap.criticality, ap.plant_id, array_agg(a.name ORDER BY a.name) AS assets
     FROM application ap JOIN application_asset aa ON aa.application_id = ap.id JOIN asset a ON a.id = aa.asset_id
     WHERE aa.asset_id = ANY($1::uuid[]) AND ap.status <> 'retired'
     GROUP BY ap.id ORDER BY array_position(ARRAY['critical','high','medium','low'], ap.criticality), ap.name`,
    [ids],
  );
  const { rows: redundant } = await db.query(
    `SELECT a.id, a.name, a.plant_id FROM asset_relation r
     JOIN asset a ON a.id = CASE WHEN r.source_id = $1 THEN r.target_id ELSE r.source_id END
     WHERE r.relation = 'redundant_with' AND (r.source_id = $1 OR r.target_id = $1) ORDER BY a.name`,
    [assetId],
  );
  return {
    affected: affected.map(({ plant_id: _p, start_id: _s, ...a }) => a),
    applications: apps.filter((a) => hasPlantAccess(user, a.plant_id) || !a.plant_id).map(({ plant_id: _p, ...a }) => a),
    redundant: redundant.filter((r) => hasPlantAccess(user, r.plant_id)).map(({ id, name }) => ({ id, name })),
  };
}

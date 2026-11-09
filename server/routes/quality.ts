import { Router } from 'express';
import type { Pool } from 'pg';
import { ASSET_TYPE_KEYS } from '../../shared/model';
import { QUALITY_ISSUES, qualityScore, type QualityAsset, type QualityIssue, type QualityReport } from '../../shared/quality';
import { badRequest, clampInt, notFound, queryString, requireUuid, SqlBuilder } from '../lib/http';
import { applyScope, assertPlantAccess } from '../lib/scope';
import { QUALITY_ISSUES_SQL } from '../services/quality';

export function qualityRouter(pool: Pool): Router {
  const r = Router();

  r.get('/data-quality', async (req, res) => {
    const sql = new SqlBuilder();
    applyScope(sql, req.user!, 'a.plant_id');
    sql.and(`a.status <> 'retired'`);
    const plantId = queryString(req.query.plantId);
    if (plantId) sql.and(`a.plant_id = ${sql.p(requireUuid(plantId, 'plantId'))}`);
    const type = queryString(req.query.type);
    if (type) {
      if (!ASSET_TYPE_KEYS.includes(type as never)) throw badRequest('Unknown type');
      sql.and(`a.type = ${sql.p(type)}`);
    }
    const limit = clampInt(req.query.limit, 100, 1, 2000);
    const { rows } = await pool.query<{ id: string; name: string; type: QualityAsset['type']; plant_code: string | null; issues: QualityIssue[] }>(
      `SELECT a.id, a.name, a.type, p.code AS plant_code, ${QUALITY_ISSUES_SQL} AS issues
       FROM asset a LEFT JOIN plant p ON p.id = a.plant_id ${sql.whereSql()}`,
      sql.params,
    );
    const counts = Object.fromEntries(QUALITY_ISSUES.map((k) => [k, 0])) as Record<QualityIssue, number>;
    const assets = rows.map((a) => {
      for (const i of a.issues) counts[i]++;
      return { ...a, score: qualityScore(a.issues) };
    });
    assets.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

    // groups of duplicates (same plant scope as above)
    const dup = async (kind: 'serial' | 'mac' | 'ip', expr: string) => {
      const { rows: g } = await pool.query(
        `SELECT ${expr} AS value, json_agg(json_build_object('id', a.id, 'name', a.name, 'type', a.type, 'plant_code', p.code) ORDER BY a.name) AS assets
         FROM asset a LEFT JOIN plant p ON p.id = a.plant_id ${sql.whereSql()} AND ${expr} IS NOT NULL AND ${expr} <> ''
         GROUP BY ${kind === 'ip' ? 'a.plant_id, ' : ''}${expr} HAVING count(*) > 1 ORDER BY 1 LIMIT 200`,
        sql.params,
      );
      return g.map((x) => ({ kind, value: x.value, assets: x.assets }));
    };
    const duplicates = [
      ...(await dup('serial', `lower(btrim(a.serial_number))`)),
      ...(await dup('mac', `lower(regexp_replace(a.mac_address, '[^0-9a-fA-F]', '', 'g'))`)),
      ...(await dup('ip', `host(cmdb_inet(a.ip_address))`)),
    ];
    const body: QualityReport = {
      score: assets.length ? Math.round(assets.reduce((s, a) => s + a.score, 0) / assets.length) : 100,
      total: assets.length,
      complete: assets.filter((a) => !a.issues.length).length,
      counts,
      assets: assets.filter((a) => a.issues.length).slice(0, limit),
      duplicates,
    };
    res.json(body);
  });

  r.get('/assets/:id/quality', async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query<{ plant_id: string | null; issues: QualityIssue[]; status: string }>(
      `SELECT a.plant_id, a.status, ${QUALITY_ISSUES_SQL} AS issues FROM asset a WHERE a.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('Asset');
    assertPlantAccess(req.user!, rows[0].plant_id);
    const issues = rows[0].status === 'retired' ? [] : rows[0].issues;
    res.json({ score: qualityScore(issues), issues });
  });

  return r;
}

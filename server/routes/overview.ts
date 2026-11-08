import { Router } from 'express';
import type { Pool } from 'pg';
import { ROLE_PERMISSIONS, type MeResponse } from '../../shared/model';
import type { Config } from '../config';
import { ensureCsrfToken } from '../auth/context';
import { likePattern, queryString, SqlBuilder } from '../lib/http';
import { applyScope, isUnscoped } from '../lib/scope';
import { ACTIVITY_FROM, ACTIVITY_SELECT } from './journal';

export function publicConfig(config: Config) {
  return {
    brandName: config.ui.brandName,
    appName: config.ui.appName,
    primaryColor: config.ui.primaryColor,
    mapTileUrl: config.ui.mapTileUrl,
    mapTileAttribution: config.ui.mapTileAttribution,
    authMode: config.authMode,
  };
}

export function overviewRouter(pool: Pool, config: Config): Router {
  const r = Router();

  r.get('/me', (req, res) => {
    const user = req.user!;
    const body: MeResponse = {
      user,
      permissions: ROLE_PERMISSIONS[user.role],
      csrfToken: ensureCsrfToken(req),
      config: publicConfig(config),
    };
    res.json(body);
  });

  r.get('/search', async (req, res) => {
    const q = queryString(req.query.q);
    if (!q || q.length < 2) return res.json([]);
    const user = req.user!;

    const ps = new SqlBuilder();
    const like = ps.p(likePattern(q));
    applyScope(ps, user, 'p.id');
    const plants = pool.query(
      `SELECT 'plant' AS kind, p.id, p.code || ' – ' || p.name AS title, concat_ws(', ', p.city, p.country) AS subtitle
       FROM plant p WHERE (p.name ILIKE ${like} OR p.code ILIKE ${like} OR p.city ILIKE ${like}) ${ps.where.length ? 'AND ' + ps.where.join(' AND ') : ''}
       ORDER BY p.name LIMIT 5`,
      ps.params,
    );

    const bs = new SqlBuilder();
    const blike = bs.p(likePattern(q));
    applyScope(bs, user, 'b.plant_id');
    const buildings = pool.query(
      `SELECT 'building' AS kind, b.id, b.name AS title, p.code || ' – ' || p.name AS subtitle
       FROM building b JOIN plant p ON p.id = b.plant_id
       WHERE (b.name ILIKE ${blike} OR b.code ILIKE ${blike}) ${bs.where.length ? 'AND ' + bs.where.join(' AND ') : ''}
       ORDER BY b.name LIMIT 5`,
      bs.params,
    );

    const as = new SqlBuilder();
    const alike = as.p(likePattern(q));
    applyScope(as, user, 'a.plant_id');
    const assets = pool.query(
      `SELECT 'asset' AS kind, a.id, a.name AS title, a.type AS "assetType",
              concat_ws(' · ', a.ip_address, a.model, p.code, b.name) AS subtitle
       FROM asset a LEFT JOIN plant p ON p.id = a.plant_id LEFT JOIN building b ON b.id = a.building_id
       WHERE (a.name ILIKE ${alike} OR a.ip_address ILIKE ${alike} OR a.serial_number ILIKE ${alike} OR a.asset_tag ILIKE ${alike}
              OR a.mac_address ILIKE ${alike} OR a.fqdn ILIKE ${alike} OR a.model ILIKE ${alike})
             ${as.where.length ? 'AND ' + as.where.join(' AND ') : ''}
       ORDER BY (lower(a.name) = lower(${as.p(q)})) DESC, a.name LIMIT 12`,
      as.params,
    );

    const [p, b, a] = await Promise.all([plants, buildings, assets]);
    res.json([...p.rows, ...b.rows, ...a.rows]);
  });

  r.get('/dashboard', async (req, res) => {
    const user = req.user!;
    const scoped = (column: string) => {
      const sql = new SqlBuilder();
      applyScope(sql, user, column);
      return sql;
    };

    const s1 = scoped('a.plant_id');
    const s2 = scoped('p.id');
    const s3 = scoped('b.plant_id');
    const s4 = scoped('act.plant_id');
    s4.and(`act.status IN ('planned','open','in_progress')`);
    const s5 = scoped('a.plant_id');
    s5.and(`a.warranty_end IS NOT NULL AND a.warranty_end <= CURRENT_DATE + 90 AND a.status <> 'retired'`);
    const s6 = scoped('l.plant_id');
    s6.and(`l.action NOT IN ('login','logout','export')`);
    if (!isUnscoped(user)) s6.and('l.plant_id IS NOT NULL');

    const [byType, byStatus, byPlant, plants, buildings, openActs, warranty, upcoming, recent] = await Promise.all([
      pool.query(`SELECT a.type, count(*) AS count FROM asset a ${s1.whereSql()} GROUP BY a.type`, s1.params),
      pool.query(`SELECT a.status, count(*) AS count FROM asset a ${s1.whereSql()} GROUP BY a.status`, s1.params),
      pool.query(
        `SELECT p.id AS plant_id, p.name AS plant_name, p.code AS plant_code, count(a.id) AS count
         FROM plant p LEFT JOIN asset a ON a.plant_id = p.id ${s2.whereSql()} GROUP BY p.id ORDER BY count(a.id) DESC, p.name`,
        s2.params,
      ),
      pool.query(`SELECT count(*) AS n FROM plant p ${s2.whereSql()}`, s2.params),
      pool.query(`SELECT count(*) AS n FROM building b ${s3.whereSql()}`, s3.params),
      pool.query(`SELECT count(*) AS n FROM activity act ${s4.whereSql()}`, s4.params),
      pool.query(
        `SELECT a.id, a.name, a.type, a.warranty_end, p.name AS plant_name FROM asset a LEFT JOIN plant p ON p.id = a.plant_id
         ${s5.whereSql()} ORDER BY a.warranty_end LIMIT 10`,
        s5.params,
      ),
      pool.query(`SELECT ${ACTIVITY_SELECT} ${ACTIVITY_FROM} ${s4.whereSql()} ORDER BY act.due_date ASC NULLS LAST, act.created_at DESC LIMIT 10`, s4.params),
      pool.query(
        `SELECT l.id::text, l.at, l.user_id, l.user_name, l.action, l.entity_type, l.entity_id, l.entity_label, l.changes, NULL AS ip
         FROM audit_log l ${s6.whereSql()} ORDER BY l.at DESC LIMIT 12`,
        s6.params,
      ),
    ]);

    res.json({
      totals: {
        plants: plants.rows[0].n,
        buildings: buildings.rows[0].n,
        assets: byType.rows.reduce((sum, r) => sum + Number(r.count), 0),
        openActivities: openActs.rows[0].n,
      },
      byType: byType.rows,
      byStatus: byStatus.rows,
      byPlant: byPlant.rows,
      warrantyExpiring: warranty.rows,
      upcomingActivities: upcoming.rows,
      recentChanges: recent.rows,
    });
  });

  return r;
}

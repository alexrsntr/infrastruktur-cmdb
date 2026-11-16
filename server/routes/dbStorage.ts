import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Config } from '../config';
import { requirePermission } from '../auth/context';
import { audit, diff } from '../lib/audit';
import { parse } from '../lib/http';
import { checkDbStorage, dbStorageDetails, dbStorageStatus, loadDbStorageSettings, saveDbStorageSettings } from '../services/dbStorage';

const email = z.string().trim().toLowerCase().email('Invalid e-mail address').max(254);

const settingsSchema = z
  .object({
    limitGb: z.number().min(0).max(65536),
    warnPercent: z.number().int().min(10).max(99),
    criticalPercent: z.number().int().min(10).max(99),
    emailEnabled: z.boolean(),
    notifyAdmins: z.boolean(),
    recipients: z.array(email).max(50).transform((l) => [...new Set(l)]),
  })
  .refine((s) => s.criticalPercent > s.warnPercent, { message: 'The critical level must be higher than the warning level', path: ['criticalPercent'] });

/** Database storage monitoring – administrators only */
export function dbStorageRouter(pool: Pool, config: Config): Router {
  const r = Router();
  r.use(['/system/db-storage', '/settings/db-storage'], requirePermission('settings.manage'));

  // small status for the banner on every page
  r.get('/system/db-storage', async (_req, res) => {
    res.json(await dbStorageStatus(pool, config));
  });

  r.get('/settings/db-storage', async (_req, res) => {
    res.json(await dbStorageDetails(pool, config));
  });

  r.put('/settings/db-storage', async (req, res) => {
    const next = parse(settingsSchema, req.body);
    const { settings: before } = await loadDbStorageSettings(pool, config);
    await saveDbStorageSettings(pool, next, req.user!.id);
    const changes = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    if (Object.keys(changes).length) await audit(pool, req, { action: 'settings.update', entityType: 'settings', entityLabel: 'Database storage', changes });
    res.json(await dbStorageDetails(pool, config));
  });

  // measure now and send the e-mail if a threshold was reached (otherwise the scheduler does this every hour)
  r.post('/settings/db-storage/check', async (_req, res) => {
    const result = await checkDbStorage(pool, config);
    res.json({ ...result, details: await dbStorageDetails(pool, config) });
  });

  return r;
}

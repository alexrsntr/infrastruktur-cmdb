import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import compression from 'compression';
import type { Pool } from 'pg';
import type { Config } from './config';
import { csrfProtection, loadUser, requireAuth } from './auth/context';
import { authRouter } from './auth/routes';
import { errorHandler, HttpError } from './lib/http';
import { locationsRouter } from './routes/locations';
import { assetsRouter } from './routes/assets';
import { journalRouter } from './routes/journal';
import { adminRouter } from './routes/admin';
import { overviewRouter, publicConfig } from './routes/overview';
import { exportsRouter } from './routes/exports';
import { importsRouter } from './routes/imports';
import { racksRouter } from './routes/racks';
import { settingsRouter } from './routes/settings';
import { attachmentsRouter } from './routes/attachments';
import { plansRouter } from './routes/plans';
import { datacentersRouter } from './routes/datacenters';
import { entraRouter } from './routes/entra';
import { EntraService, type EntraDeps } from './entra/service';

function tileHosts(tileUrl: string): string[] {
  try {
    const u = new URL(tileUrl.replace('{s}', 'a').replace(/\{[a-z]+\}/gi, '0'));
    const host = tileUrl.includes('{s}') ? u.host.replace(/^a\./, '*.') : u.host;
    return [`${u.protocol}//${host}`];
  } catch {
    return [];
  }
}

function resolveStaticDir(): string | null {
  const candidates = [
    process.env.STATIC_DIR,
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'),
    path.join(process.cwd(), 'dist', 'public'),
  ].filter(Boolean) as string[];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}

export interface AppDeps {
  /** Replacements for MSAL / Microsoft Graph (tests) */
  entra?: EntraDeps;
}

export function createApp(pool: Pool, config: Config, deps: AppDeps = {}) {
  const entra = new EntraService(pool, config, deps.entra);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Azure App Service front end

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // Ant Design injects runtime styles
          imgSrc: ["'self'", 'data:', 'blob:', ...tileHosts(config.ui.mapTileUrl)],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'", 'https://login.microsoftonline.com'],
          upgradeInsecureRequests: config.httpsOnly ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.httpsOnly ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  app.use(compression());

  // ---- health probes (no auth, no session) ----
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch (err) {
      res.status(503).json({ status: 'error', db: (err as Error).message });
    }
  });

  // ---- sessions (stored in PostgreSQL so App Service can scale out) ----
  const PgStore = connectPgSimple(session);
  app.use(
    session({
      name: 'cmdb.sid',
      secret: config.sessionSecret,
      store: new PgStore({
        pool,
        tableName: 'user_session',
        createTableIfMissing: false,
        pruneSessionInterval: config.env === 'test' ? false : 15 * 60,
      }),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.httpsOnly,
        maxAge: 10 * 60 * 60 * 1000, // 10 h sliding
      },
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(loadUser(pool));

  // ---- auth ----
  app.use('/auth', authRouter(pool, config, entra));

  // ---- API ----
  app.get('/api/public-config', async (_req, res) => res.json(await publicConfig(config, entra)));
  const api = Router();
  api.use(requireAuth, csrfProtection);
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(overviewRouter(pool, config, entra));
  api.use(locationsRouter(pool));
  api.use(assetsRouter(pool));
  api.use(journalRouter(pool));
  api.use(adminRouter(pool));
  api.use(exportsRouter(pool));
  api.use(importsRouter(pool));
  api.use(racksRouter(pool));
  api.use(settingsRouter(pool, config));
  api.use(entraRouter(pool, config, entra));
  api.use(attachmentsRouter(pool, config));
  api.use(plansRouter(pool));
  api.use(datacentersRouter(pool));
  api.use((_req, _res, next) => next(new HttpError(404, 'API endpoint not found')));
  app.use('/api', api);

  // ---- SPA ----
  const staticDir = resolveStaticDir();
  if (staticDir) {
    app.use(express.static(staticDir, { index: false, maxAge: '1y', immutable: true }));
    app.get(/^(?!\/(api|auth)\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}

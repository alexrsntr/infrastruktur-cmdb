import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { can, type CurrentUser, type Permission, type Role, type RoleSource } from '../../shared/model';
import { HttpError, forbidden } from '../lib/http';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    csrfToken?: string;
    oidc?: {
      state: string;
      nonce: string;
      codeVerifier: string;
      returnTo: string;
      /** test = admin checks the Entra configuration before activating it (does not change the session) */
      purpose?: 'login' | 'test';
      /** test: the administrator who started it */
      userId?: string;
    };
    /** How the user signed in (logout of Microsoft only after a Microsoft sign-in) */
    authMethod?: 'entra' | 'local' | 'dev';
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: CurrentUser;
      /** Set when the request is authenticated with an API token (Authorization: Bearer …) instead of a session */
      apiToken?: { id: string; name: string };
    }
  }
}

interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  role: Role;
  role_source: RoleSource;
  plant_scope: string[];
  active: boolean;
}

export function toCurrentUser(row: UserRow): CurrentUser {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    roleSource: row.role_source,
    plantScope: row.role === 'admin' ? [] : row.plant_scope ?? [],
  };
}

export const API_TOKEN_PREFIX = 'cmdb_';

export function hashApiToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** API token → its service user. Expired or revoked tokens and deactivated service users are rejected. */
async function loadTokenUser(pool: Pool, req: Request): Promise<boolean> {
  const header = req.get('authorization');
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  if (!m) return false;
  if (!m[1].startsWith(API_TOKEN_PREFIX)) throw new HttpError(401, 'Invalid API token');
  const { rows } = await pool.query<UserRow & { token_id: string; token_name: string }>(
    `SELECT u.id, u.display_name, u.email, u.role, u.role_source, u.plant_scope, u.active, t.id AS token_id, t.name AS token_name
     FROM api_token t JOIN app_user u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())`,
    [hashApiToken(m[1])],
  );
  const row = rows[0];
  if (!row || !row.active) throw new HttpError(401, 'Invalid, expired or revoked API token');
  req.user = toCurrentUser(row);
  req.apiToken = { id: row.token_id, name: row.token_name };
  // remember the last use (at most once a minute per token)
  pool
    .query(`UPDATE api_token SET last_used_at = now(), last_used_ip = $2 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [row.token_id, req.ip ?? null])
    .catch(() => undefined);
  return true;
}

/** Loads the current user from the session (or API token) on every request so role/scope changes apply immediately. */
export function loadUser(pool: Pool) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (req.path.startsWith('/api/') && (await loadTokenUser(pool, req))) return next();
    } catch (err) {
      return next(err);
    }
    const userId = req.session?.userId;
    if (!userId) return next();
    const { rows } = await pool.query<UserRow>(
      'SELECT id, display_name, email, role, role_source, plant_scope, active FROM app_user WHERE id = $1',
      [userId],
    );
    const row = rows[0];
    if (!row || !row.active) {
      delete req.session.userId;
      return next();
    }
    req.user = toCurrentUser(row);
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Not signed in'));
  next();
}

export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Not signed in'));
    for (const p of permissions) {
      if (!can(req.user.role, p)) return next(forbidden());
    }
    next();
  };
}

/** Only signed-in people – not API tokens (e.g. creating new API tokens). */
export function requireSession(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Not signed in'));
  if (req.apiToken) return next(forbidden('Not possible with an API token'));
  next();
}

/** Administrators only – in addition to the permission checks (admin-only features such as the Entra configuration). */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Not signed in'));
  if (req.user.role !== 'admin') return next(forbidden());
  next();
}

export function assertCan(user: CurrentUser | undefined, permission: Permission) {
  if (!user) throw new HttpError(401, 'Not signed in');
  if (!can(user.role, permission)) throw forbidden();
}

export function ensureCsrfToken(req: Request): string {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('base64url');
  return req.session.csrfToken;
}

/** Double-submit style CSRF protection for state changing API calls (token lives in the session). */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // API tokens are sent explicitly in a header – browsers never attach them on their own, so no CSRF risk
  if (req.apiToken) return next();
  const expected = req.session?.csrfToken;
  const actual = req.get('x-csrf-token');
  if (!expected || !actual) return next(new HttpError(403, 'Missing CSRF token'));
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(new HttpError(403, 'Invalid CSRF token'));
  next();
}

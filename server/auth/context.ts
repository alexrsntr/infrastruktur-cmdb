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

/** Loads the current user from the session on every request so role/scope changes apply immediately. */
export function loadUser(pool: Pool) {
  return async (req: Request, _res: Response, next: NextFunction) => {
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
  const expected = req.session?.csrfToken;
  const actual = req.get('x-csrf-token');
  if (!expected || !actual) return next(new HttpError(403, 'Missing CSRF token'));
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(new HttpError(403, 'Invalid CSRF token'));
  next();
}

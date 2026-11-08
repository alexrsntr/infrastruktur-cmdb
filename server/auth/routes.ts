import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import rateLimit from 'express-rate-limit';
import { CryptoProvider } from '@azure/msal-node';
import { z } from 'zod';
import { roleFromEntraAppRoles, type Role, type RoleSource } from '../../shared/model';
import type { EntraLoginCheck } from '../../shared/entra';
import type { Config } from '../config';
import { audit } from '../lib/audit';
import { log } from '../lib/log';
import { HttpError } from '../lib/http';
import { explainEntraError } from '../entra/errors';
import { decideRole, groupRoleFor, type GroupRoleResult } from '../entra/roles';
import type { EntraService } from '../entra/service';
import { effectiveLocalLogin, type EntraRuntime } from '../entra/settings';
import { ensureCsrfToken } from './context';
import { dummyPasswordHash, hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from './password';

interface LoginIdentity {
  oid: string;
  tenantId: string | null;
  email: string | null;
  displayName: string;
  /** Role from Entra app roles in the token (null = none assigned) */
  entraRole: Role | null;
  /** Role from an Entra group mapping (null = none) */
  groupRole?: Role | null;
  groupScope?: string[];
  groupNames?: string[];
  /** Dev mode: force this role */
  forcedRole?: Role;
  forcedScopeCodes?: string[];
}

interface UserRecord {
  id: string;
  role: Role;
  role_source: RoleSource;
  display_name: string;
}

export class LoginRejectedError extends Error {}

const SETTINGS_URL = '/admin/settings?tab=entra';

export function isBootstrapAdmin(config: Config, email: string | null): boolean {
  return !!email && config.bootstrapAdmins.includes(email.toLowerCase());
}

/**
 * Creates or updates the user record on sign-in and returns it. An existing account without Microsoft account
 * (pre-provisioned or local password account) is linked by its e-mail address (= UPN), so history and plant
 * scope stay. Role: see decideRole (app role > group mapping > role set in the CMDB > DEFAULT_ROLE).
 */
export async function upsertLoginUser(pool: Pool, config: Config, id: LoginIdentity, opts: { requireAppRole?: boolean } = {}): Promise<UserRecord> {
  const emailLc = id.email?.toLowerCase() ?? null;
  const bootstrap = isBootstrapAdmin(config, emailLc);

  if (opts.requireAppRole && !id.entraRole && !id.groupRole && !bootstrap) {
    throw new LoginRejectedError(
      'Your account has not been assigned a role for this application. Please request access from the CMDB administrators.',
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let { rows } = await client.query<UserRecord & { active: boolean }>(
      'SELECT id, role, role_source, display_name, active FROM app_user WHERE oid = $1 FOR UPDATE',
      [id.oid],
    );
    if (!rows[0] && emailLc) {
      // Pre-provisioned by an administrator (by e-mail) or a local password account – link it at the first sign-in
      ({ rows } = await client.query(
        'SELECT id, role, role_source, display_name, active FROM app_user WHERE oid IS NULL AND lower(email) = $1 FOR UPDATE',
        [emailLc],
      ));
    }
    const existing = rows[0];

    const decided: { role: Role; source: RoleSource } = id.forcedRole
      ? { role: id.forcedRole, source: 'local' }
      : decideRole({ appRole: id.entraRole, groupRole: id.groupRole ?? null, existing: existing ?? null, defaultRole: config.defaultRole, isBootstrapAdmin: bootstrap });
    const roleDetail = decided.source === 'group' ? (id.groupNames ?? []).join(', ') || null : null;

    let user: UserRecord;
    if (existing) {
      if (!existing.active) throw new LoginRejectedError('Your CMDB account has been deactivated.');
      const res = await client.query<UserRecord>(
        // accounts with a password keep their e-mail address – it is their user name for the password sign-in
        `UPDATE app_user SET oid = $2, tenant_id = $3, email = CASE WHEN password_hash IS NULL THEN $4 ELSE email END,
                display_name = $5, role = $6, role_source = $7, role_detail = $8, last_login_at = now(), updated_at = now()
         WHERE id = $1 RETURNING id, role, role_source, display_name`,
        [existing.id, id.oid, id.tenantId, id.email, id.displayName, decided.role, decided.source, roleDetail],
      );
      user = res.rows[0];
    } else {
      const res = await client.query<UserRecord>(
        `INSERT INTO app_user (oid, tenant_id, email, display_name, role, role_source, role_detail, last_login_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING id, role, role_source, display_name`,
        [id.oid, id.tenantId, id.email, id.displayName, decided.role, decided.source, roleDetail],
      );
      user = res.rows[0];
    }
    if (decided.source === 'group') {
      // the plant scope of group-managed users follows the group mapping
      await client.query('UPDATE app_user SET plant_scope = $2::uuid[] WHERE id = $1', [user.id, id.groupScope ?? []]);
    }
    if (id.forcedScopeCodes) {
      await client.query(
        `UPDATE app_user SET plant_scope = COALESCE((SELECT array_agg(id) FROM plant WHERE lower(code) = ANY($2::text[])), '{}')
         WHERE id = $1`,
        [user.id, id.forcedScopeCodes.map((c) => c.toLowerCase())],
      );
    }
    await client.query('COMMIT');
    return user;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

async function establishSession(req: Request, userId: string, method: 'entra' | 'local' | 'dev'): Promise<void> {
  await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = userId;
  req.session.authMethod = method;
  ensureCsrfToken(req);
  await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

function errorPage(res: Response, status: number, title: string, message: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
      <style>body{font-family:Segoe UI,system-ui,sans-serif;background:#f3f5f8;display:grid;place-items:center;height:100vh;margin:0}
      .c{background:#fff;padding:32px 40px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:480px}
      h1{font-size:20px;margin:0 0 12px;color:#1f2937}p{color:#4b5563;line-height:1.5}a{color:#2563eb}</style></head>
      <body><div class="c"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Back to start page</a></p></div></body></html>`,
    );
}

// ---------------------------------------------------------------------------

export function authRouter(pool: Pool, config: Config, entra: EntraService): Router {
  const router = Router();
  router.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }));

  router.post('/logout', async (req, res) => {
    const viaMicrosoft = config.authMode === 'entra' || req.session.authMethod === 'entra';
    if (req.user) await audit(pool, req, { action: 'logout', entityType: 'user', entityId: req.user.id, entityLabel: req.user.displayName });
    const tenantId = viaMicrosoft ? (await entra.runtime()).tenantId : '';
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('cmdb.sid');
    const logoutUrl = tenantId
      ? `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(config.baseUrl + '/')}`
      : '/';
    res.json({ logoutUrl });
  });

  mountEntra(router, pool, config, entra);
  if (config.authMode === 'local') mountLocal(router, pool, config, entra);
  if (config.authMode === 'dev') mountDev(router, pool, config);

  return router;
}

// ---------------------------------------------------------------------------
// Microsoft Entra ID: sign-in and the administrator's test sign-in (configuration read per request)

const SCOPES = ['openid', 'profile', 'email'];

function mountEntra(router: Router, pool: Pool, config: Config, entra: EntraService) {
  const redirectUri = `${config.baseUrl}/auth/callback`;
  const pkce = new CryptoProvider();

  async function startFlow(req: Request, res: Response, rt: EntraRuntime, purpose: 'login' | 'test', returnTo: string, prompt?: 'select_account') {
    const { verifier, challenge } = await pkce.generatePkceCodes();
    const state = pkce.createNewGuid();
    const nonce = pkce.createNewGuid();
    req.session.oidc = { state, nonce, codeVerifier: verifier, returnTo, purpose, userId: purpose === 'test' ? req.user?.id : undefined };
    const url = await entra.client(rt).getAuthCodeUrl({ scopes: SCOPES, redirectUri, codeChallenge: challenge, state, nonce, prompt });
    await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
    res.redirect(url);
  }

  async function saveLoginCheck(req: Request, rt: EntraRuntime, check: Omit<EntraLoginCheck, 'at' | 'userId' | 'userName'>) {
    const admin = req.user!;
    const full: EntraLoginCheck = { ...check, at: new Date().toISOString(), userId: admin.id, userName: admin.displayName };
    const { stored } = await entra.settings.load();
    const sameConfig = stored.checks?.fingerprint === rt.fingerprint;
    await entra.settings.save({ ...stored, checks: { fingerprint: rt.fingerprint, connection: sameConfig ? (stored.checks?.connection ?? null) : null, login: full } }, admin.id);
    await audit(pool, req, {
      action: 'settings.entra-test-login',
      entityType: 'settings',
      entityLabel: 'Microsoft Entra ID',
      changes: { result: check.ok ? 'ok' : 'failed', account: check.account, role: check.role, message: check.message },
    });
  }

  router.get('/login', async (req, res) => {
    const returnTo = safeReturnTo(req.query.returnTo);
    const rt = await entra.runtime();
    if (!rt.enabled) return res.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    try {
      await startFlow(req, res, rt, 'login', returnTo, req.query.prompt === 'select_account' ? 'select_account' : undefined);
    } catch (err) {
      const e = explainEntraError(err);
      log.error('auth: could not start the Microsoft sign-in', { code: e.code });
      return errorPage(res, 502, 'Sign-in not available', 'The sign-in with Microsoft could not be started. Please try again later.');
    }
  });

  /** Administrator checks the configuration with their own Microsoft account before activating it. */
  router.get('/entra/test-login', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return errorPage(res, 403, 'Not allowed', 'Only administrators can test the sign-in with Microsoft.');
    const rt = await entra.runtime();
    if (rt.source !== 'database' || !rt.configured) return res.redirect(SETTINGS_URL);
    try {
      await startFlow(req, res, rt, 'test', SETTINGS_URL, 'select_account');
    } catch (err) {
      const e = explainEntraError(err);
      await saveLoginCheck(req, rt, { ok: false, account: null, role: null, message: [e.error, e.hint].filter(Boolean).join(' ') });
      res.redirect(SETTINGS_URL);
    }
  });

  router.get('/callback', async (req, res) => {
    const pending = req.session.oidc;
    const { code, state, error, error_description: errorDescription } = req.query as Record<string, string | undefined>;
    const isTest = pending?.purpose === 'test';
    const rt = await entra.runtime();

    const fail = async (status: number, title: string, message: string) => {
      if (isTest && req.user?.id === pending?.userId && req.user?.role === 'admin') {
        await saveLoginCheck(req, rt, { ok: false, account: null, role: null, message });
        return res.redirect(SETTINGS_URL);
      }
      return errorPage(res, status, title, message);
    };

    if (error) {
      log.warn('auth: Entra returned an error', { error });
      delete req.session.oidc;
      return fail(401, 'Sign-in failed', errorDescription ?? error);
    }
    if (!pending || !code || !state || state !== pending.state) {
      return errorPage(res, 400, 'Sign-in failed', 'The sign-in request expired or is invalid. Please try again.');
    }
    delete req.session.oidc;
    if (isTest) {
      if (!req.user || req.user.id !== pending.userId || req.user.role !== 'admin') return errorPage(res, 403, 'Not allowed', 'The test sign-in must be finished by the administrator who started it.');
    } else if (!rt.enabled) {
      return errorPage(res, 403, 'Sign-in failed', 'Sign-in with Microsoft is not enabled.');
    }

    try {
      const result = await entra.client(rt).acquireTokenByCode({ code, scopes: SCOPES, redirectUri, codeVerifier: pending.codeVerifier });
      const claims = result.idTokenClaims;
      if (claims.nonce !== pending.nonce) throw new HttpError(400, 'Invalid nonce');
      if (String(claims.tid ?? '').toLowerCase() !== rt.tenantId.toLowerCase()) throw new HttpError(403, 'Sign-ins from other tenants are not allowed');
      const oid = String(claims.oid ?? '');
      if (!oid) throw new HttpError(400, 'ID token has no oid claim');
      const email = (claims.preferred_username as string) ?? (claims.email as string) ?? null;
      const displayName = (claims.name as string) ?? (claims.preferred_username as string) ?? 'Unknown user';
      const appRole = roleFromEntraAppRoles(claims.roles as string[] | undefined);
      const bootstrap = isBootstrapAdmin(config, email);

      const group = await groupRoleFor(pool, entra, rt, oid);
      if (group.failed && !appRole && !bootstrap) {
        throw new LoginRejectedError(
          'Your group memberships in Microsoft Entra ID could not be checked right now. Please try again in a few minutes or contact the CMDB administrators.',
        );
      }

      if (isTest) return await finishTestLogin(req, res, { rt, oid, tenantId: String(claims.tid), email, appRole, group, bootstrap });

      const user = await upsertLoginUser(
        pool,
        config,
        { oid, tenantId: String(claims.tid), email, displayName, entraRole: appRole, groupRole: group.role, groupScope: group.scope, groupNames: group.groupNames },
        { requireAppRole: rt.requireAppRole },
      );
      await establishSession(req, user.id, 'entra');
      req.user = { id: user.id, displayName: user.display_name, email: null, role: user.role, roleSource: user.role_source, plantScope: [] };
      await audit(pool, req, { action: 'login', entityType: 'user', entityId: user.id, entityLabel: user.display_name, changes: { role: user.role, source: user.role_source } });
      res.redirect(pending.returnTo || '/');
    } catch (err) {
      if (err instanceof LoginRejectedError) return fail(403, 'Access denied', err.message);
      if (err instanceof HttpError) {
        log.warn('auth: callback rejected', { status: err.status, reason: err.message });
        return fail(err.status, 'Sign-in failed', isTest ? err.message : 'We could not complete the sign-in. Please try again.');
      }
      const e = explainEntraError(err);
      log.error('auth: callback failed', { code: e.code });
      return fail(401, 'Sign-in failed', isTest ? [e.error, e.hint].filter(Boolean).join(' ') : 'We could not complete the sign-in. Please try again.');
    }
  });

  /**
   * Test sign-in result: links the Microsoft account to the administrator's CMDB account (both sign-ins are proven)
   * and checks that it would sign in as administrator – otherwise activating could lock the administrator out.
   */
  async function finishTestLogin(
    req: Request,
    res: Response,
    t: { rt: EntraRuntime; oid: string; tenantId: string; email: string | null; appRole: Role | null; group: GroupRoleResult; bootstrap: boolean },
  ) {
    const admin = req.user!;
    const { rows: others } = await pool.query<{ display_name: string }>('SELECT display_name FROM app_user WHERE oid = $1 AND id <> $2', [t.oid, admin.id]);
    if (others[0]) {
      await saveLoginCheck(req, t.rt, {
        ok: false,
        account: t.email,
        role: null,
        message: `This Microsoft account is already linked to the CMDB user "${others[0].display_name}". Test with your own Microsoft account.`,
      });
      return res.redirect(SETTINGS_URL);
    }
    const { rows } = await pool.query<{ role: Role; role_source: RoleSource }>('SELECT role, role_source FROM app_user WHERE id = $1', [admin.id]);
    const decided = decideRole({ appRole: t.appRole, groupRole: t.group.role, existing: rows[0] ?? null, defaultRole: config.defaultRole, isBootstrapAdmin: t.bootstrap });
    const rejected = t.rt.requireAppRole && !t.appRole && !t.group.role && !t.bootstrap;
    const ok = !rejected && decided.role === 'admin';
    const origin = decided.source === 'entra' ? 'its app role' : decided.source === 'group' ? `the group ${t.group.groupNames.join(', ')}` : 'your CMDB account';
    const message = ok
      ? null
      : rejected
        ? '"Only users with an app role" is switched on, but this Microsoft account has neither an app role nor a mapped group.'
        : `This Microsoft account would sign in as ${decided.role} (from ${origin}), not as administrator. Assign it the app role CMDB.Admin or remove the lower app role.`;
    if (ok) {
      await pool.query('UPDATE app_user SET oid = $2, tenant_id = $3, updated_at = now() WHERE id = $1', [admin.id, t.oid, t.tenantId]);
    }
    await saveLoginCheck(req, t.rt, { ok, account: t.email, role: rejected ? null : decided.role, message });
    res.redirect(SETTINGS_URL);
  }
}

// ---------------------------------------------------------------------------
// Local accounts (AUTH_MODE=local): e-mail + password, for installations without Entra ID

const localLoginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().max(PASSWORD_MAX_LENGTH),
});

const setupSchema = z.object({
  display_name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

/** True while no account can sign in with a password yet – the first visitor creates the administrator. */
export async function needsSetup(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM app_user WHERE password_hash IS NOT NULL LIMIT 1');
  return rows.length === 0;
}

const MICROSOFT_ONLY = 'Sign-in with e-mail and password is turned off. Please use "Sign in with Microsoft".';

function mountLocal(router: Router, pool: Pool, config: Config, entra: EntraService) {
  // brute-force protection: 10 failed attempts per 15 minutes and client address
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' },
  });

  const localMode = async () => effectiveLocalLogin(config, await entra.runtime());

  router.get('/setup', async (_req, res) => {
    res.json({ needsSetup: (await localMode()) !== 'off' && (await needsSetup(pool)) });
  });

  /** First start: create the first administrator (only possible while no password account exists). */
  router.post('/setup', loginLimiter, async (req, res) => {
    if ((await localMode()) === 'off') return res.status(403).json({ error: MICROSOFT_ONLY });
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: `Please enter a name, a valid e-mail address and a password with at least ${PASSWORD_MIN_LENGTH} characters.` });
    }
    const input = parsed.data;
    const hash = await hashPassword(input.password);
    const client = await pool.connect();
    let userId: string;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['cmdb-local-setup']);
      const done = await client.query('SELECT 1 FROM app_user WHERE password_hash IS NOT NULL LIMIT 1');
      if (done.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'The administrator account has already been created. Please sign in.' });
      }
      const existing = await client.query<{ id: string }>('SELECT id FROM app_user WHERE lower(email) = $1 ORDER BY oid NULLS FIRST LIMIT 1', [input.email]);
      const { rows } = existing.rows[0]
        ? await client.query<{ id: string }>(
            `UPDATE app_user SET display_name = $2, role = 'admin', role_source = 'local', active = true, plant_scope = '{}',
                    password_hash = $3, password_changed_at = now(), last_login_at = now(), updated_at = now()
             WHERE id = $1 RETURNING id`,
            [existing.rows[0].id, input.display_name, hash],
          )
        : await client.query<{ id: string }>(
            `INSERT INTO app_user (email, display_name, role, role_source, password_hash, password_changed_at, last_login_at)
             VALUES ($1, $2, 'admin', 'local', $3, now(), now()) RETURNING id`,
            [input.email, input.display_name, hash],
          );
      userId = rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await establishSession(req, userId, 'local');
    req.user = { id: userId, displayName: input.display_name, email: input.email, role: 'admin', roleSource: 'local', plantScope: [] };
    await audit(pool, req, { action: 'login', entityType: 'user', entityId: userId, entityLabel: input.display_name, changes: { role: 'admin', mode: 'setup' } });
    res.status(201).json({ ok: true });
  });

  router.post('/local-login', loginLimiter, async (req, res) => {
    const mode = await localMode();
    if (mode === 'off') return res.status(403).json({ error: MICROSOFT_ONLY });
    const parsed = localLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Please enter your e-mail address and password.' });
    const { email, password } = parsed.data;
    const { rows } = await pool.query<{ id: string; display_name: string; role: Role; active: boolean; password_hash: string }>(
      `SELECT id, display_name, role, active, password_hash FROM app_user
       WHERE lower(email) = $1 AND password_hash IS NOT NULL ORDER BY oid NULLS FIRST LIMIT 1`,
      [email],
    );
    const user = rows[0];
    // always run the hash function so response times do not reveal which e-mail addresses exist
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !ok) {
      log.warn('auth: local sign-in failed', { email });
      return res.status(401).json({ error: 'E-mail address or password is incorrect.' });
    }
    if (!user.active) return res.status(403).json({ error: 'Your CMDB account has been deactivated.' });
    if (mode === 'admins' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only administrators can sign in with a password. Please use "Sign in with Microsoft".' });
    }
    await pool.query('UPDATE app_user SET last_login_at = now() WHERE id = $1', [user.id]);
    await establishSession(req, user.id, 'local');
    req.user = { id: user.id, displayName: user.display_name, email, role: user.role, roleSource: 'local', plantScope: [] };
    await audit(pool, req, { action: 'login', entityType: 'user', entityId: user.id, entityLabel: user.display_name, changes: { role: user.role, mode: 'local' } });
    res.json({ ok: true });
  });
}

/** Development personas – only available when AUTH_MODE=dev (refused in production by config validation). */
export const DEV_PERSONAS: Record<string, { name: string; email: string; role: Role; scope?: string[] }> = {
  admin: { name: 'Anna Admin', email: 'anna.admin@example.local', role: 'admin' },
  editor: { name: 'Erik Editor', email: 'erik.editor@example.local', role: 'editor' },
  operator: { name: 'Olga Operator (MUC only)', email: 'olga.operator@example.local', role: 'operator', scope: ['MUC'] },
  local: { name: 'Lars Local Admin (MUC)', email: 'lars.localadmin@example.local', role: 'editor', scope: ['MUC'] },
  viewer: { name: 'Viktor Viewer', email: 'viktor.viewer@example.local', role: 'viewer' },
};

function mountDev(router: Router, pool: Pool, config: Config) {
  router.get('/dev-login', async (req, res) => {
    const key = String(req.query.persona ?? '');
    const persona = DEV_PERSONAS[key];
    if (!persona) return errorPage(res, 400, 'Unknown persona', `Use one of: ${Object.keys(DEV_PERSONAS).join(', ')}`);
    const user = await upsertLoginUser(pool, config, {
      oid: `dev-${key}`,
      tenantId: null,
      email: persona.email,
      displayName: persona.name,
      entraRole: null,
      forcedRole: persona.role,
      forcedScopeCodes: persona.scope ?? [],
    });
    await establishSession(req, user.id, 'dev');
    req.user = { id: user.id, displayName: user.display_name, email: persona.email, role: user.role, roleSource: 'local', plantScope: [] };
    await audit(pool, req, { action: 'login', entityType: 'user', entityId: user.id, entityLabel: user.display_name, changes: { role: user.role, mode: 'dev' } });
    res.redirect(safeReturnTo(req.query.returnTo));
  });
}

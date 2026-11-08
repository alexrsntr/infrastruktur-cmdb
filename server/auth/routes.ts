import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import rateLimit from 'express-rate-limit';
import { ConfidentialClientApplication, CryptoProvider, type Configuration } from '@azure/msal-node';
import { ManagedIdentityCredential } from '@azure/identity';
import { roleFromEntraAppRoles, type Role } from '../../shared/model';
import type { Config } from '../config';
import { audit } from '../lib/audit';
import { log } from '../lib/log';
import { HttpError } from '../lib/http';
import { ensureCsrfToken } from './context';

interface LoginIdentity {
  oid: string;
  tenantId: string | null;
  email: string | null;
  displayName: string;
  /** Role from Entra app roles (null = none assigned) */
  entraRole: Role | null;
  /** Dev mode: force this role */
  forcedRole?: Role;
  forcedScopeCodes?: string[];
}

interface UserRecord {
  id: string;
  role: Role;
  role_source: 'entra' | 'local';
  display_name: string;
}

export class LoginRejectedError extends Error {}

/** Creates or updates the local user record on sign-in and returns it. */
export async function upsertLoginUser(pool: Pool, config: Config, id: LoginIdentity): Promise<UserRecord> {
  const emailLc = id.email?.toLowerCase() ?? null;
  const isBootstrapAdmin = !!emailLc && config.bootstrapAdmins.includes(emailLc);

  if (config.authMode === 'entra' && config.entra.requireAppRole && !id.entraRole && !isBootstrapAdmin) {
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
      // Pre-provisioned by an administrator (by e-mail) before the first sign-in
      ({ rows } = await client.query(
        'SELECT id, role, role_source, display_name, active FROM app_user WHERE oid IS NULL AND lower(email) = $1 FOR UPDATE',
        [emailLc],
      ));
    }
    const existing = rows[0];

    let role: Role;
    let roleSource: 'entra' | 'local';
    if (id.forcedRole) {
      role = id.forcedRole;
      roleSource = 'local';
    } else if (id.entraRole) {
      role = id.entraRole;
      roleSource = 'entra';
    } else if (existing && existing.role_source === 'local') {
      role = existing.role;
      roleSource = 'local';
    } else {
      // new user, or the Entra app role assignment was removed
      role = config.defaultRole;
      roleSource = 'local';
    }
    if (isBootstrapAdmin) role = 'admin';

    let user: UserRecord;
    if (existing) {
      if (!existing.active) throw new LoginRejectedError('Your CMDB account has been deactivated.');
      const res = await client.query<UserRecord>(
        `UPDATE app_user SET oid = $2, tenant_id = $3, email = $4, display_name = $5, role = $6, role_source = $7,
                last_login_at = now(), updated_at = now()
         WHERE id = $1 RETURNING id, role, role_source, display_name`,
        [existing.id, id.oid, id.tenantId, id.email, id.displayName, role, roleSource],
      );
      user = res.rows[0];
    } else {
      const res = await client.query<UserRecord>(
        `INSERT INTO app_user (oid, tenant_id, email, display_name, role, role_source, last_login_at)
         VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id, role, role_source, display_name`,
        [id.oid, id.tenantId, id.email, id.displayName, role, roleSource],
      );
      user = res.rows[0];
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

async function establishSession(req: Request, userId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = userId;
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

export function authRouter(pool: Pool, config: Config): Router {
  const router = Router();
  router.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }));

  router.post('/logout', async (req, res) => {
    if (req.user) await audit(pool, req, { action: 'logout', entityType: 'user', entityId: req.user.id, entityLabel: req.user.displayName });
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('cmdb.sid');
    const logoutUrl =
      config.authMode === 'entra'
        ? `https://login.microsoftonline.com/${encodeURIComponent(config.entra.tenantId)}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(config.baseUrl + '/')}`
        : '/';
    res.json({ logoutUrl });
  });

  if (config.authMode === 'entra') mountEntra(router, pool, config);
  else mountDev(router, pool, config);

  return router;
}

function mountEntra(router: Router, pool: Pool, config: Config) {
  const { tenantId, clientId, clientSecret, useManagedIdentity } = config.entra;
  const redirectUri = `${config.baseUrl}/auth/callback`;
  const scopes = ['openid', 'profile', 'email'];

  const msalConfig: Configuration = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  };
  if (useManagedIdentity) {
    // Secretless: the app's managed identity is a federated credential of the app registration.
    const credential = new ManagedIdentityCredential(
      config.managedIdentityClientId ? { clientId: config.managedIdentityClientId } : undefined,
    );
    msalConfig.auth.clientAssertion = async () => {
      const token = await credential.getToken('api://AzureADTokenExchange/.default');
      if (!token) throw new Error('Managed identity did not return a token for api://AzureADTokenExchange');
      return token.token;
    };
  } else {
    msalConfig.auth.clientSecret = clientSecret;
  }
  const msal = new ConfidentialClientApplication(msalConfig);
  const crypto = new CryptoProvider();

  router.get('/login', async (req, res) => {
    const { verifier, challenge } = await crypto.generatePkceCodes();
    const state = crypto.createNewGuid();
    const nonce = crypto.createNewGuid();
    req.session.oidc = { state, nonce, codeVerifier: verifier, returnTo: safeReturnTo(req.query.returnTo) };
    const url = await msal.getAuthCodeUrl({
      scopes,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      state,
      nonce,
      responseMode: 'query',
      prompt: req.query.prompt === 'select_account' ? 'select_account' : undefined,
    });
    req.session.save(() => res.redirect(url));
  });

  router.get('/callback', async (req, res) => {
    const pending = req.session.oidc;
    const { code, state, error, error_description: errorDescription } = req.query as Record<string, string | undefined>;
    if (error) {
      log.warn('auth: Entra returned an error', { error, errorDescription });
      return errorPage(res, 401, 'Sign-in failed', errorDescription ?? error);
    }
    if (!pending || !code || !state || state !== pending.state) {
      return errorPage(res, 400, 'Sign-in failed', 'The sign-in request expired or is invalid. Please try again.');
    }
    delete req.session.oidc;

    try {
      const result = await msal.acquireTokenByCode({ code, scopes, redirectUri, codeVerifier: pending.codeVerifier });
      const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
      if (claims.nonce !== pending.nonce) throw new HttpError(400, 'Invalid nonce');
      if (claims.tid !== tenantId) throw new HttpError(403, 'Sign-ins from other tenants are not allowed');
      const oid = String(claims.oid ?? '');
      if (!oid) throw new HttpError(400, 'ID token has no oid claim');

      const user = await upsertLoginUser(pool, config, {
        oid,
        tenantId: String(claims.tid),
        email: (claims.preferred_username as string) ?? (claims.email as string) ?? null,
        displayName: (claims.name as string) ?? (claims.preferred_username as string) ?? 'Unknown user',
        entraRole: roleFromEntraAppRoles(claims.roles as string[] | undefined),
      });
      await establishSession(req, user.id);
      req.user = { id: user.id, displayName: user.display_name, email: null, role: user.role, roleSource: user.role_source, plantScope: [] };
      await audit(pool, req, { action: 'login', entityType: 'user', entityId: user.id, entityLabel: user.display_name, changes: { role: user.role } });
      res.redirect(pending.returnTo || '/');
    } catch (err) {
      if (err instanceof LoginRejectedError) return errorPage(res, 403, 'Access denied', err.message);
      log.error('auth: callback failed', { error: (err as Error).message });
      return errorPage(res, 401, 'Sign-in failed', 'We could not complete the sign-in. Please try again.');
    }
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
  router.get('/login', (req, res) => {
    const returnTo = safeReturnTo(req.query.returnTo);
    res.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  });

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
    await establishSession(req, user.id);
    req.user = { id: user.id, displayName: user.display_name, email: persona.email, role: user.role, roleSource: 'local', plantScope: [] };
    await audit(pool, req, { action: 'login', entityType: 'user', entityId: user.id, entityLabel: user.display_name, changes: { role: user.role, mode: 'dev' } });
    res.redirect(safeReturnTo(req.query.returnTo));
  });
}

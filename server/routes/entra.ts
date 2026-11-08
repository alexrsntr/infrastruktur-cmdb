import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ROLES, roleFromEntraAppRoles, type Role } from '../../shared/model';
import {
  ENTRA_CREDENTIALS,
  LOCAL_LOGIN_MODES,
  type AppRoleAssignmentDto,
  type DirectoryGroup,
  type DirectoryPage,
  type DirectoryUser,
  type EntraField,
  type EntraSettingsDto,
  type GroupRoleMapping,
} from '../../shared/entra';
import type { Config } from '../config';
import { requireAdmin } from '../auth/context';
import { audit } from '../lib/audit';
import { HttpError, badRequest, parse } from '../lib/http';
import { encryptSecret } from '../lib/secrets';
import { explainEntraError } from '../entra/errors';
import type { EntraService, GraphUser } from '../entra/service';
import { effectiveLocalLogin, entraFingerprint, type EntraRuntime, type StoredEntraSettings } from '../entra/settings';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guidOrEmpty = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => v === '' || GUID.test(v), 'Enter an ID in GUID format (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)');
const guid = z.string().trim().regex(GUID, 'Invalid ID');

const settingsSchema = z.object({
  tenantId: guidOrEmpty.optional(),
  clientId: guidOrEmpty.optional(),
  credential: z.enum(ENTRA_CREDENTIALS).optional(),
  managedIdentityClientId: guidOrEmpty.optional(),
  /** '' or undefined = keep, null = remove */
  clientSecret: z.string().max(1024).nullish(),
  requireAppRole: z.boolean().optional(),
});

const localLoginSchema = z.object({ mode: z.enum(LOCAL_LOGIN_MODES) });

const groupRoleSchema = z.object({
  display_name: z.string().trim().min(1).max(256),
  role: z.enum(ROLES),
  plant_scope: z.array(z.string().uuid()).max(500).default([]),
});

const provisionSchema = z.object({
  role: z.enum(ROLES),
  plant_scope: z.array(z.string().uuid()).max(500).default([]),
});

const ENV_NAMES: Record<EntraField, string> = {
  tenantId: 'ENTRA_TENANT_ID',
  clientId: 'ENTRA_CLIENT_ID',
  credential: 'ENTRA_USE_MANAGED_IDENTITY',
  clientSecret: 'ENTRA_CLIENT_SECRET',
  managedIdentityClientId: 'AZURE_CLIENT_ID',
  requireAppRole: 'ENTRA_REQUIRE_APP_ROLE',
};

const NOT_CONFIGURED = 'Microsoft Entra ID is not configured yet (Administration → Settings → Microsoft Entra ID).';

export function entraRouter(pool: Pool, config: Config, entra: EntraService): Router {
  const r = Router();
  r.use(['/settings/entra', '/entra'], requireAdmin);

  const testLimiter = rateLimit({
    windowMs: 60_000,
    limit: 6,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many tests. Please wait a minute.' },
  });
  const directoryLimiter = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false });

  async function counts() {
    const { rows } = await pool.query<{ entra_admins: number; local_admins: number }>(
      `SELECT count(*) FILTER (WHERE oid IS NOT NULL AND oid NOT LIKE 'dev-%')::int AS entra_admins,
              count(*) FILTER (WHERE password_hash IS NOT NULL)::int AS local_admins
       FROM app_user WHERE role = 'admin' AND active`,
    );
    return rows[0];
  }

  async function dto(req: Request, rt: EntraRuntime): Promise<EntraSettingsDto> {
    const c = await counts();
    const checks = rt.stored.checks?.fingerprint === rt.fingerprint ? rt.stored.checks : null;
    const blockers: string[] = [];
    if (rt.source === 'env') blockers.push('Configured by environment variables (AUTH_MODE=entra).');
    else {
      if (config.authMode === 'entra') blockers.push('AUTH_MODE=entra');
      if (!rt.configured) blockers.push('Enter tenant ID, application (client) ID and the credential, then save.');
      if (!checks?.connection) blockers.push('Run "Test connection" successfully.');
      if (!checks?.login?.ok) blockers.push('Sign in once with your Microsoft account ("Test sign-in") as administrator.');
      else if (checks.login.userId !== req.user!.id) blockers.push(`The test sign-in was done by ${checks.login.userName} – the administrator who activates must test it.`);
    }
    return {
      source: rt.source,
      authMode: config.authMode,
      locked: rt.locked,
      tenantId: rt.tenantId,
      clientId: rt.clientId,
      credential: rt.credential,
      managedIdentityClientId: rt.managedIdentityClientId,
      clientSecretSet: !!rt.clientSecret,
      clientSecretSetAt: rt.locked.clientSecret ? null : rt.stored.clientSecretSetAt,
      requireAppRole: rt.requireAppRole,
      configured: rt.configured,
      enabled: rt.enabled,
      localLogin: rt.localLogin === 'none' ? 'all' : rt.localLogin,
      emergencyLocalLogin: config.localLoginEmergency,
      redirectUris: [`${config.baseUrl}/auth/callback`, `${config.baseUrl}/`],
      connection: checks?.connection ?? null,
      login: checks?.login ?? null,
      canActivate: !rt.enabled && blockers.length === 0,
      activationBlockers: rt.enabled ? [] : blockers,
      entraAdminCount: c.entra_admins,
      localAdminCount: c.local_admins,
      updatedAt: rt.updatedAt,
    };
  }

  async function requireConfigured(): Promise<EntraRuntime> {
    const rt = await entra.runtime();
    if (!rt.configured) throw new HttpError(409, NOT_CONFIGURED);
    return rt;
  }

  /** Graph call with a readable error (and the permission to grant on 403). */
  async function graphCall<T>(permission: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e = explainEntraError(err, permission);
      throw new HttpError(e.status, e.hint ? `${e.error} ${e.hint}` : e.error);
    }
  }

  // ------------------------------------------------------------------ settings

  r.get('/settings/entra', async (req, res) => {
    res.json(await dto(req, await entra.runtime()));
  });

  r.put('/settings/entra', async (req, res) => {
    const input = parse(settingsSchema, req.body);
    const rt = await entra.runtime();
    if (rt.source === 'env') throw new HttpError(409, 'Microsoft Entra ID is configured by environment variables (AUTH_MODE=entra) and cannot be changed here.');
    const { stored } = await entra.settings.load();

    // environment variables win: a value set there cannot be changed in the app
    for (const field of ['tenantId', 'clientId', 'credential', 'managedIdentityClientId', 'requireAppRole'] as const) {
      const value = input[field];
      if (value !== undefined && rt.locked[field] && value !== rt[field]) {
        throw badRequest(`This value is set by the environment variable ${ENV_NAMES[field]} – change it there.`);
      }
    }
    if (rt.locked.clientSecret && input.clientSecret !== undefined && input.clientSecret !== '') {
      throw badRequest('The client secret is set by the environment variable ENTRA_CLIENT_SECRET – change it there.');
    }

    const next: StoredEntraSettings = {
      ...stored,
      tenantId: rt.locked.tenantId ? stored.tenantId : (input.tenantId ?? stored.tenantId),
      clientId: rt.locked.clientId ? stored.clientId : (input.clientId ?? stored.clientId),
      credential: rt.locked.credential ? stored.credential : (input.credential ?? stored.credential),
      managedIdentityClientId: rt.locked.managedIdentityClientId ? stored.managedIdentityClientId : (input.managedIdentityClientId ?? stored.managedIdentityClientId),
      requireAppRole: rt.locked.requireAppRole ? stored.requireAppRole : (input.requireAppRole ?? stored.requireAppRole),
    };
    let secretChange: 'changed' | 'removed' | null = null;
    if (!rt.locked.clientSecret) {
      if (input.clientSecret === null && stored.clientSecretEnc) {
        next.clientSecretEnc = null;
        next.clientSecretSetAt = null;
        secretChange = 'removed';
      } else if (typeof input.clientSecret === 'string' && input.clientSecret.trim() !== '') {
        next.clientSecretEnc = encryptSecret(config, input.clientSecret.trim());
        next.clientSecretSetAt = new Date().toISOString();
        secretChange = 'changed';
      }
    }

    const effective = {
      tenantId: rt.locked.tenantId ? rt.tenantId : next.tenantId,
      clientId: rt.locked.clientId ? rt.clientId : next.clientId,
      credential: rt.locked.credential ? rt.credential : next.credential,
      managedIdentityClientId: rt.locked.managedIdentityClientId ? rt.managedIdentityClientId : next.managedIdentityClientId,
    };
    const identityChanged = entraFingerprint(effective) !== rt.fingerprint;
    if (rt.enabled && identityChanged) {
      throw new HttpError(409, 'Microsoft sign-in is active. Deactivate it before changing tenant, application or credential type.');
    }
    if (rt.enabled && secretChange === 'removed' && effective.credential === 'secret') {
      throw new HttpError(409, 'Microsoft sign-in is active and needs the client secret. Enter a new secret instead of removing it.');
    }
    if (rt.enabled && next.requireAppRole && !rt.requireAppRole && effectiveLocalLogin(config, rt) === 'off' && req.user!.roleSource === 'local') {
      throw new HttpError(
        409,
        'You would lock yourself out: your role is set in the CMDB, not by an app role or group, and password sign-in is off. Assign yourself the app role CMDB.Admin or a mapped group first.',
      );
    }
    if (identityChanged) next.checks = null;
    else if (secretChange && next.checks) next.checks = { ...next.checks, connection: null };

    const changes: Record<string, unknown> = {};
    for (const k of ['tenantId', 'clientId', 'credential', 'managedIdentityClientId', 'requireAppRole'] as const) {
      if (next[k] !== stored[k]) changes[k] = { from: stored[k], to: next[k] };
    }
    if (secretChange) changes.clientSecret = secretChange;
    const saved = await entra.settings.save(next, req.user!.id);
    if (Object.keys(changes).length) {
      await audit(pool, req, { action: 'settings.update', entityType: 'settings', entityLabel: 'Microsoft Entra ID', changes });
    }
    res.json(await dto(req, saved));
  });

  r.post('/settings/entra/test', testLimiter, async (req, res) => {
    const rt = await requireConfigured();
    const { result, check, code } = await entra.testConnection(rt);
    if (check && rt.source === 'database') {
      const { stored } = await entra.settings.load();
      const sameConfig = stored.checks?.fingerprint === rt.fingerprint;
      await entra.settings.save({ ...stored, checks: { fingerprint: rt.fingerprint, connection: check, login: sameConfig ? (stored.checks?.login ?? null) : null } }, req.user!.id);
    }
    await audit(pool, req, {
      action: 'settings.entra-test',
      entityType: 'settings',
      entityLabel: 'Microsoft Entra ID',
      changes: { result: result.ok ? 'ok' : 'failed', code, tenant: result.tenantName ?? null, missingPermissions: result.missingPermissions ?? [] },
    });
    res.json(result);
  });

  r.post('/settings/entra/activate', async (req, res) => {
    const rt = await entra.runtime();
    const current = await dto(req, rt);
    if (rt.enabled) return res.json(current);
    if (!current.canActivate) throw new HttpError(409, `Microsoft sign-in cannot be activated yet: ${current.activationBlockers.join(' ')}`);
    const { stored } = await entra.settings.load();
    const saved = await entra.settings.save({ ...stored, enabled: true }, req.user!.id);
    await audit(pool, req, { action: 'settings.entra-activate', entityType: 'settings', entityLabel: 'Microsoft Entra ID', changes: { enabled: true } });
    res.json(await dto(req, saved));
  });

  r.post('/settings/entra/deactivate', async (req, res) => {
    const rt = await entra.runtime();
    if (rt.source === 'env') throw new HttpError(409, 'Configured by environment variables (AUTH_MODE=entra).');
    if (config.authMode === 'local' && (await counts()).local_admins === 0) {
      throw new HttpError(409, 'No administrator has a password, so nobody could sign in afterwards. Set a password for an administrator first (Users & permissions).');
    }
    const { stored } = await entra.settings.load();
    const saved = await entra.settings.save({ ...stored, enabled: false, localLogin: 'all' }, req.user!.id);
    await audit(pool, req, { action: 'settings.entra-deactivate', entityType: 'settings', entityLabel: 'Microsoft Entra ID', changes: { enabled: false, localLogin: 'all' } });
    res.json(await dto(req, saved));
  });

  r.put('/settings/entra/local-login', async (req, res) => {
    const { mode } = parse(localLoginSchema, req.body);
    const rt = await entra.runtime();
    if (config.authMode !== 'local') throw badRequest('Password sign-in exists only with AUTH_MODE=local.');
    if (mode !== 'all') {
      if (!rt.enabled) throw new HttpError(409, 'Activate the sign-in with Microsoft first.');
      if ((await counts()).entra_admins === 0) throw new HttpError(409, 'No administrator has signed in with Microsoft yet – you could lock yourself out.');
    }
    const { stored } = await entra.settings.load();
    const saved = await entra.settings.save({ ...stored, localLogin: mode }, req.user!.id);
    if (stored.localLogin !== mode) {
      await audit(pool, req, { action: 'settings.update', entityType: 'settings', entityLabel: 'Password sign-in', changes: { localLogin: { from: stored.localLogin, to: mode } } });
    }
    res.json(await dto(req, saved));
  });

  // ------------------------------------------------------------------ directory (Microsoft Graph, read-only)

  async function withCmdbUsers(users: GraphUser[]): Promise<DirectoryUser[]> {
    const ids = users.map((u) => u.id);
    const emails = users.flatMap((u) => [u.userPrincipalName, u.mail]).filter((e): e is string => !!e).map((e) => e.toLowerCase());
    const { rows } = await pool.query<{ id: string; oid: string | null; email: string | null; role: Role }>(
      'SELECT id, oid, email, role FROM app_user WHERE oid = ANY($1::text[]) OR (oid IS NULL AND lower(email) = ANY($2::text[]))',
      [ids, emails],
    );
    return users.map((u) => {
      const match =
        rows.find((r) => r.oid === u.id) ??
        rows.find((r) => !r.oid && !!r.email && [u.userPrincipalName, u.mail].some((e) => e?.toLowerCase() === r.email!.toLowerCase()));
      return {
        id: u.id,
        displayName: u.displayName,
        userPrincipalName: u.userPrincipalName,
        mail: u.mail,
        jobTitle: u.jobTitle ?? null,
        department: u.department ?? null,
        accountEnabled: u.accountEnabled ?? null,
        cmdbUserId: match?.id ?? null,
        cmdbRole: match?.role ?? null,
      };
    });
  }

  const pageQuery = (req: Request) => ({
    q: typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '',
    next: typeof req.query.next === 'string' && req.query.next ? req.query.next : undefined,
  });

  r.get('/entra/users', directoryLimiter, async (req, res) => {
    const rt = await requireConfigured();
    const { q, next } = pageQuery(req);
    const page = await graphCall('User.Read.All', () => entra.searchUsers(rt, q, next));
    const body: DirectoryPage<DirectoryUser> = { items: await withCmdbUsers(page.items), next: page.next };
    res.json(body);
  });

  r.get('/entra/groups', directoryLimiter, async (req, res) => {
    const rt = await requireConfigured();
    const { q, next } = pageQuery(req);
    const page = await graphCall('GroupMember.Read.All', () => entra.searchGroups(rt, q, next));
    const { rows } = await pool.query<{ group_id: string; role: Role }>('SELECT group_id, role FROM entra_group_role WHERE group_id = ANY($1::text[])', [
      page.items.map((g) => g.id),
    ]);
    const body: DirectoryPage<DirectoryGroup> = {
      items: page.items.map((g) => ({
        id: g.id,
        displayName: g.displayName,
        description: g.description ?? null,
        mail: g.mail ?? null,
        securityEnabled: g.securityEnabled ?? null,
        mappedRole: rows.find((m) => m.group_id === g.id)?.role ?? null,
      })),
      next: page.next,
    };
    res.json(body);
  });

  r.get('/entra/groups/:id/members', directoryLimiter, async (req, res) => {
    const id = parse(guid, req.params.id);
    const rt = await requireConfigured();
    const { next } = pageQuery(req);
    const page = await graphCall('GroupMember.Read.All', () => entra.groupMembers(rt, id, next));
    const body: DirectoryPage<DirectoryUser> = { items: await withCmdbUsers(page.items), next: page.next };
    res.json(body);
  });

  /** Add a Microsoft Entra user to the CMDB before their first sign-in (role and plant scope set by the administrator). */
  r.post('/entra/users/:id/provision', async (req, res) => {
    const id = parse(guid, req.params.id);
    const input = parse(provisionSchema, req.body);
    const rt = await requireConfigured();
    const user = await graphCall('User.Read.All', () => entra.getUser(rt, id));
    const email = (user.userPrincipalName ?? user.mail ?? '').toLowerCase();
    if (!email) throw badRequest('This Entra user has neither a user principal name nor an e-mail address.');
    const { rows: existing } = await pool.query<{ display_name: string }>(
      'SELECT display_name FROM app_user WHERE oid = $1 OR (oid IS NULL AND lower(email) = $2)',
      [user.id, email],
    );
    if (existing[0]) throw new HttpError(409, `"${existing[0].display_name}" is already a CMDB user – it is linked automatically at the first sign-in with Microsoft.`);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO app_user (oid, tenant_id, email, display_name, role, role_source, plant_scope) VALUES ($1,$2,$3,$4,$5,'local',$6::uuid[]) RETURNING id`,
      [user.id, rt.tenantId, email, user.displayName, input.role, input.plant_scope],
    );
    await audit(pool, req, {
      action: 'user.create',
      entityType: 'user',
      entityId: rows[0].id,
      entityLabel: user.displayName,
      changes: { email, role: input.role, plant_scope: input.plant_scope, source: 'Microsoft Entra ID' },
    });
    res.status(201).json({ id: rows[0].id });
  });

  r.get('/entra/app-role-assignments', directoryLimiter, async (_req, res) => {
    const rt = await requireConfigured();
    const assignments = await graphCall('Application.Read.All', () => entra.appRoleAssignments(rt));
    const body: AppRoleAssignmentDto[] = assignments.map((a) => ({ ...a, role: a.appRoleValue ? roleFromEntraAppRoles([a.appRoleValue]) : null }));
    res.json(body);
  });

  // ------------------------------------------------------------------ group -> role mapping (stored in the CMDB)

  r.get('/entra/group-roles', async (_req, res) => {
    const { rows } = await pool.query<{ group_id: string; display_name: string; role: Role; plant_scope: string[]; updated_at: Date }>(
      'SELECT group_id, display_name, role, plant_scope, updated_at FROM entra_group_role ORDER BY display_name',
    );
    const body: GroupRoleMapping[] = rows.map((m) => ({
      groupId: m.group_id,
      displayName: m.display_name,
      role: m.role,
      plantScope: m.plant_scope ?? [],
      updatedAt: m.updated_at.toISOString(),
    }));
    res.json(body);
  });

  r.put('/entra/group-roles/:groupId', async (req, res) => {
    const groupId = parse(guid, req.params.groupId).toLowerCase();
    const input = parse(groupRoleSchema, req.body);
    const { rows: before } = await pool.query('SELECT role, plant_scope FROM entra_group_role WHERE group_id = $1', [groupId]);
    await pool.query(
      `INSERT INTO entra_group_role (group_id, display_name, role, plant_scope, created_by, updated_by) VALUES ($1,$2,$3,$4::uuid[],$5,$5)
       ON CONFLICT (group_id) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, plant_scope = EXCLUDED.plant_scope,
         updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [groupId, input.display_name, input.role, input.role === 'admin' ? [] : input.plant_scope, req.user!.id],
    );
    await audit(pool, req, {
      action: before[0] ? 'entra.group-role.update' : 'entra.group-role.create',
      entityType: 'settings',
      entityLabel: `Entra group ${input.display_name}`,
      changes: { group: groupId, role: input.role, plant_scope: input.plant_scope, ...(before[0] ? { previous: before[0] } : {}) },
    });
    res.json({ ok: true });
  });

  r.delete('/entra/group-roles/:groupId', async (req, res) => {
    const groupId = parse(guid, req.params.groupId).toLowerCase();
    const { rows } = await pool.query<{ display_name: string; role: Role }>('DELETE FROM entra_group_role WHERE group_id = $1 RETURNING display_name, role', [groupId]);
    if (!rows[0]) throw new HttpError(404, 'Group mapping not found');
    await audit(pool, req, { action: 'entra.group-role.delete', entityType: 'settings', entityLabel: `Entra group ${rows[0].display_name}`, changes: { group: groupId, role: rows[0].role } });
    res.status(204).end();
  });

  return r;
}

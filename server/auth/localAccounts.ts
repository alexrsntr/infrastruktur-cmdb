import type { Pool } from 'pg';
import type { Role } from '../../shared/model';
import { withTransaction } from '../db/pool';
import { audit } from '../lib/audit';
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password';

/** A problem the person running the command can fix (unknown e-mail address, password too short …). */
export class LocalAccountError extends Error {}

export interface PasswordSetResult {
  id: string;
  displayName: string;
  email: string;
  role: Role;
  active: boolean;
}

/**
 * Sets the password of a local account without signing in – the way back in when nobody can sign in any more
 * (e.g. the Microsoft sign-in fails and the administrator password is lost). Used by `cli.ts set-password`.
 *
 * Picks the account exactly like the password sign-in does, signs it out everywhere and writes an audit entry –
 * all in one transaction, so the password is never changed without a trace.
 */
export async function setLocalPassword(pool: Pool, email: string, password: string): Promise<PasswordSetResult> {
  const address = email.trim();
  if (!address) throw new LocalAccountError('Please give the e-mail address of the account.');
  if (password.length < PASSWORD_MIN_LENGTH) throw new LocalAccountError(`The password must have at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (password.length > PASSWORD_MAX_LENGTH) throw new LocalAccountError(`The password must have at most ${PASSWORD_MAX_LENGTH} characters.`);
  const hash = await hashPassword(password);

  return withTransaction(pool, async (db) => {
    // same choice as the password sign-in (auth/routes.ts): the local account first, then a linked Microsoft account
    const { rows } = await db.query<{ id: string; display_name: string; email: string; role: Role; active: boolean }>(
      `SELECT id, display_name, email, role, active FROM app_user
       WHERE lower(email) = lower($1) ORDER BY oid NULLS FIRST LIMIT 1 FOR UPDATE`,
      [address],
    );
    const user = rows[0];
    if (!user) throw new LocalAccountError(`There is no account with the e-mail address ${address}.`);
    await db.query('UPDATE app_user SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1', [user.id, hash]);
    await db.query(`DELETE FROM user_session WHERE sess->>'userId' = $1`, [user.id]);
    await audit(db, null, {
      action: 'user.password',
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.display_name,
      changes: { password: 'set on the command line' },
    });
    return { id: user.id, displayName: user.display_name, email: user.email, role: user.role, active: user.active };
  });
}

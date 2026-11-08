import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing for local accounts (AUTH_MODE=local) with scrypt from node:crypto.
 * Stored format: "scrypt$<N>$<r>$<p>$<salt>$<hash>" (salt and hash base64url).
 */

const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions) => Promise<Buffer>;

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isInteger)) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  const actual = await scrypt(password, Buffer.from(parts[4], 'base64url'), expected.length, { N: n, r, p, maxmem: MAXMEM });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Hash of a random password, used to spend the same time on unknown e-mail addresses as on known ones. */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

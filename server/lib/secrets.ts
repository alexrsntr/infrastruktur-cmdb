import crypto from 'node:crypto';
import type { Config } from '../config';
import { log } from './log';

/**
 * AES-256-GCM encryption for secrets stored in app settings (e.g. the SMTP password).
 * Key = HKDF-SHA256(SETTINGS_ENCRYPTION_KEY, falling back to SESSION_SECRET).
 * Stored format: "v1:<iv>:<tag>:<ciphertext>" (base64url).
 */

const SALT = 'infrastruktur-cmdb';
const INFO = 'settings-encryption-v1';
let warned = false;

function deriveKey(config: Config): Buffer {
  const material = config.settingsEncryptionKey || config.sessionSecret;
  if (!config.settingsEncryptionKey && config.isProduction && !warned) {
    warned = true;
    log.warn('SETTINGS_ENCRYPTION_KEY is not set – stored secrets are encrypted with a key derived from SESSION_SECRET. Rotating SESSION_SECRET will require re-entering them.');
  }
  return Buffer.from(crypto.hkdfSync('sha256', material, SALT, INFO, 32));
}

export function encryptSecret(config: Config, plaintext: string): string {
  const key = deriveKey(config);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

/** Returns the plaintext, or null if the value cannot be decrypted (wrong key, tampered, unknown format). */
export function decryptSecret(config: Config, value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const key = deriveKey(config);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Call once at startup to emit the fallback warning early. */
export function checkSecretsKey(config: Config) {
  deriveKey(config);
}

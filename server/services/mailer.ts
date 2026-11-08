import nodemailer from 'nodemailer';
import type { Config } from '../config';
import type { DbClient } from '../db/pool';
import { decryptSecret } from '../lib/secrets';
import type { EmailSettingsDto, SmtpSecurity } from '../../shared/notifications';

// ---------------------------------------------------------------------------
// Generic app_setting access
// ---------------------------------------------------------------------------

export async function readSetting<T>(db: DbClient, key: string): Promise<{ value: T; updatedAt: string | null } | null> {
  const { rows } = await db.query<{ value: T; updated_at: Date }>('SELECT value, updated_at FROM app_setting WHERE key = $1', [key]);
  if (!rows[0]) return null;
  return { value: rows[0].value, updatedAt: rows[0].updated_at ? rows[0].updated_at.toISOString() : null };
}

export async function writeSetting(db: DbClient, key: string, value: unknown, userId: string | null) {
  await db.query(
    `INSERT INTO app_setting (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId],
  );
}

// ---------------------------------------------------------------------------
// SMTP settings
// ---------------------------------------------------------------------------

export const SMTP_KEY = 'smtp';

/** SMTP settings as stored in app_setting (password encrypted with lib/secrets) */
export interface StoredSmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  passwordEnc: string | null;
  fromAddress: string;
  fromName: string;
  allowInvalidCertificates: boolean;
}

export const EMPTY_SMTP: StoredSmtpSettings = {
  host: '',
  port: 587,
  security: 'starttls',
  username: '',
  passwordEnc: null,
  fromAddress: '',
  fromName: 'IT CMDB',
  allowInvalidCertificates: false,
};

export async function loadSmtpSettings(db: DbClient): Promise<{ settings: StoredSmtpSettings; updatedAt: string | null }> {
  const row = await readSetting<Partial<StoredSmtpSettings>>(db, SMTP_KEY);
  return { settings: { ...EMPTY_SMTP, ...(row?.value ?? {}) }, updatedAt: row?.updatedAt ?? null };
}

export function isSmtpConfigured(s: StoredSmtpSettings): boolean {
  return !!s.host && !!s.port && !!s.fromAddress;
}

export function smtpToDto(config: Config, s: StoredSmtpSettings, updatedAt: string | null): EmailSettingsDto {
  const passwordSet = !!s.passwordEnc;
  return {
    host: s.host,
    port: s.port,
    security: s.security,
    username: s.username,
    passwordSet,
    passwordUnreadable: passwordSet && decryptSecret(config, s.passwordEnc) === null,
    fromAddress: s.fromAddress,
    fromName: s.fromName,
    allowInvalidCertificates: s.allowInvalidCertificates,
    configured: isSmtpConfigured(s),
    updatedAt,
  };
}

export class MailConfigError extends Error {}

export function createTransport(config: Config, s: StoredSmtpSettings) {
  if (!isSmtpConfigured(s)) throw new MailConfigError('The e-mail server (SMTP) is not configured yet.');
  let auth: { user: string; pass: string } | undefined;
  if (s.username) {
    const pass = decryptSecret(config, s.passwordEnc);
    if (s.passwordEnc && pass === null)
      throw new MailConfigError('The stored SMTP password cannot be decrypted (the encryption key changed). Please enter the password again.');
    auth = { user: s.username, pass: pass ?? '' };
  }
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth,
    tls: { rejectUnauthorized: !s.allowInvalidCertificates, servername: s.host },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

export function fromHeader(s: StoredSmtpSettings) {
  return s.fromName ? { name: s.fromName, address: s.fromAddress } : s.fromAddress;
}

/** Turns nodemailer / socket errors into a message an administrator can act on. */
export function describeMailError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; response?: string; message?: string; command?: string };
  if (err instanceof MailConfigError) return err.message;
  if (e.message?.includes('ECONNREFUSED'))
    return 'Connection refused – check host and port, and that the app may reach the SMTP server (firewall).';
  if (e.message?.includes('ENOTFOUND') || e.message?.includes('EAI_AGAIN')) return 'SMTP host name could not be resolved.';
  switch (e.code) {
    case 'ECONNREFUSED':
      return 'Connection refused – check host and port, and that the app may reach the SMTP server (firewall).';
    case 'ETIMEDOUT':
    case 'ETIMEOUT':
    case 'ESOCKET':
      if (e.message?.includes('certificate') || e.message?.includes('self-signed') || e.message?.includes('self signed'))
        return `TLS certificate not trusted (${e.message}). Use a trusted certificate or enable "Allow self-signed certificates".`;
      return `Connection to the SMTP server failed or timed out (${e.message ?? e.code}).`;
    case 'ENOTFOUND':
    case 'EDNS':
      return 'SMTP host name could not be resolved.';
    case 'EAUTH':
      return `Authentication failed${e.response ? `: ${e.response}` : ''}. Check username and password (Exchange Online needs SMTP AUTH enabled for the mailbox, or use a relay).`;
    case 'EENVELOPE':
      return `The server rejected the sender or recipient${e.response ? `: ${e.response}` : ''}.`;
    case 'EMESSAGE':
      return `The server rejected the message${e.response ? `: ${e.response}` : ''}.`;
    default:
      if (e.message?.match(/certificate|self.signed/i))
        return `TLS certificate not trusted (${e.message}). Use a trusted certificate or enable "Allow self-signed certificates".`;
      return e.response ? `${e.message} (${e.response})` : (e.message ?? String(err));
  }
}

export interface OutgoingMail {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
}

export async function sendMail(config: Config, s: StoredSmtpSettings, mail: OutgoingMail) {
  const transport = createTransport(config, s);
  try {
    return await transport.sendMail({ from: fromHeader(s), ...mail });
  } finally {
    transport.close();
  }
}

export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

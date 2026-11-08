// DTOs for application settings and e-mail notifications (shared by API and UI)

import type { AssetStatus, AssetType } from './model';

export const SMTP_SECURITY = ['starttls', 'tls', 'none'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

export const SMTP_SECURITY_META: Record<SmtpSecurity, { label: string; port: number }> = {
  starttls: { label: 'STARTTLS (587)', port: 587 },
  tls: { label: 'SSL/TLS (465)', port: 465 },
  none: { label: 'None – relay (25)', port: 25 },
};

/** SMTP settings as returned to the UI – the password itself is never returned. */
export interface EmailSettingsDto {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  passwordSet: boolean;
  /** True when a password is stored but cannot be decrypted (encryption key changed) */
  passwordUnreadable: boolean;
  fromAddress: string;
  fromName: string;
  allowInvalidCertificates: boolean;
  configured: boolean;
  updatedAt: string | null;
}

/** Body of PUT /api/settings/email. password: undefined = keep, null = remove, string = set */
export interface EmailSettingsInput {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password?: string | null;
  fromAddress: string;
  fromName: string;
  allowInvalidCertificates: boolean;
}

export interface WarrantyNotificationSettings {
  enabled: boolean;
  /** Days before warranty end, sorted descending, e.g. [90, 30, 7] */
  thresholds: number[];
  /** Also notify once when the warranty has expired */
  includeExpired: boolean;
  /** Local hour (0–23) at which the daily digest is sent */
  sendHour: number;
  timezone: string;
  /** Receive all due devices */
  recipients: string[];
  /** Receive only the devices of a plant: plantId → e-mail addresses */
  plantRecipients: Record<string, string[]>;
  /** Assets in these statuses are ignored */
  excludeStatuses: AssetStatus[];
}

export const DEFAULT_WARRANTY_SETTINGS: WarrantyNotificationSettings = {
  enabled: false,
  thresholds: [90, 30, 7],
  includeExpired: true,
  sendHour: 7,
  timezone: 'Europe/Berlin',
  recipients: [],
  plantRecipients: {},
  excludeStatuses: ['retired'],
};

export interface NotificationSettingsDto extends WarrantyNotificationSettings {
  updatedAt: string | null;
  lastRun: NotificationRun | null;
  nextRun: string | null;
}

export interface WarrantyDueItem {
  id: string;
  name: string;
  type: AssetType;
  status: AssetStatus;
  plant_id: string | null;
  plant_code: string | null;
  plant_name: string | null;
  building_name: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  warranty_end: string;
  days_left: number;
  /** Thresholds that are reached and not yet notified (0 = expired) */
  thresholds: number[];
}

export interface WarrantyPreview {
  today: string;
  items: WarrantyDueItem[];
  recipients: { email: string; count: number }[];
  /** Items no recipient would receive (no global recipients and no recipients for their plant) */
  unrouted: number;
}

export interface NotificationRun {
  id: string;
  kind: string;
  started_at: string;
  finished_at: string | null;
  trigger: 'schedule' | 'manual';
  local_date: string | null;
  items: number;
  emails: number;
  status: 'running' | 'ok' | 'error' | 'skipped';
  error: string | null;
}

export interface NotificationLogEntry {
  id: string;
  kind: string;
  asset_id: string;
  asset_name: string | null;
  asset_type: AssetType | null;
  plant_code: string | null;
  threshold_days: number;
  warranty_end: string;
  recipients: string[];
  sent_at: string;
}

export interface RunResult {
  run: NotificationRun;
  sent: { email: string; items: number }[];
}

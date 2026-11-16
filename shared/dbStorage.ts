// Database storage monitoring: the app warns its administrators before the PostgreSQL server runs out of space.

export const DB_STORAGE_LEVELS = ['ok', 'warning', 'critical'] as const;
export type DbStorageLevel = (typeof DB_STORAGE_LEVELS)[number];

export const DB_STORAGE_LEVEL_RANK: Record<DbStorageLevel, number> = { ok: 0, warning: 1, critical: 2 };

/** Azure Database for PostgreSQL switches the server to read-only at this fill level: nothing can be saved, not even a sign-in. */
export const READ_ONLY_PERCENT = 95;

const GB = 1024 ** 3;

export interface DbStorageSettings {
  /** Storage size of the PostgreSQL server in GB (Azure portal: server → Compute + storage). 0 = no monitoring. */
  limitGb: number;
  warnPercent: number;
  criticalPercent: number;
  /** Send an e-mail when the warning or the critical level is reached */
  emailEnabled: boolean;
  /** E-mail all active administrators that have an e-mail address */
  notifyAdmins: boolean;
  /** Additional recipients */
  recipients: string[];
}

export const DEFAULT_DB_STORAGE_SETTINGS: DbStorageSettings = {
  limitGb: 32,
  warnPercent: 80,
  criticalPercent: 90,
  emailEnabled: true,
  notifyAdmins: true,
  recipients: [],
};

/** Small status for the banner that administrators see on every page */
export interface DbStorageStatus {
  /** off = no storage size configured */
  level: DbStorageLevel | 'off';
  usedBytes: number;
  limitBytes: number | null;
  /** can exceed 100 when the configured size is too small */
  percent: number | null;
  warnPercent: number;
  criticalPercent: number;
  checkedAt: string;
}

export interface DbStorageTable {
  name: string;
  label: string;
  bytes: number;
}

export interface DbStorageNotification {
  level: DbStorageLevel;
  percent: number;
  at: string;
  recipients: number;
}

export interface DbStorageDetails extends DbStorageStatus {
  settings: DbStorageSettings;
  updatedAt: string | null;
  /** this database, the other databases on the server and the write-ahead log (null = not readable with the app's rights) */
  breakdown: { database: number; otherDatabases: number; wal: number | null };
  tables: DbStorageTable[];
  lastNotification: DbStorageNotification | null;
  /** the e-mail server is configured (otherwise only the banner warns) */
  smtpConfigured: boolean;
}

export interface DbStorageCheckResult {
  status: DbStorageStatus;
  /** e-mails sent by this check */
  emails: number;
  error: string | null;
}

export function gbToBytes(gb: number): number {
  return Math.round(gb * GB);
}

export function storagePercent(usedBytes: number, limitGb: number): number | null {
  if (!(limitGb > 0)) return null;
  return Math.round((usedBytes / gbToBytes(limitGb)) * 1000) / 10;
}

export function storageLevel(percent: number | null, s: Pick<DbStorageSettings, 'warnPercent' | 'criticalPercent'>): DbStorageLevel | 'off' {
  if (percent == null) return 'off';
  if (percent >= s.criticalPercent) return 'critical';
  if (percent >= s.warnPercent) return 'warning';
  return 'ok';
}

/** "26.4 GB", "812 MB" */
export function formatStorage(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function formatLimit(limitGb: number): string {
  return `${Number.isInteger(limitGb) ? limitGb : limitGb.toFixed(2)} GB`;
}

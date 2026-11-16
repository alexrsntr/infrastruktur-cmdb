// Certificates (TLS, internal CA, client, code signing …) with expiry date, responsible persons and e-mail reminders.
// Shared by API and web client.

export const CERT_KINDS = ['tls', 'wildcard', 'ca', 'client', 'code_signing', 'smime', 'vpn', 'other'] as const;
export type CertKind = (typeof CERT_KINDS)[number];
export const CERT_KIND_META: Record<CertKind, { label: string }> = {
  tls: { label: 'SSL/TLS server' },
  wildcard: { label: 'Wildcard / SAN' },
  ca: { label: 'Root / intermediate CA' },
  client: { label: 'Client / device' },
  code_signing: { label: 'Code signing' },
  smime: { label: 'E-mail (S/MIME)' },
  vpn: { label: 'VPN / IPsec' },
  other: { label: 'Other' },
};

export const CERT_STATUSES = ['active', 'renewal', 'replaced', 'retired'] as const;
export type CertStatus = (typeof CERT_STATUSES)[number];
export const CERT_STATUS_META: Record<CertStatus, { label: string; color: string; description: string }> = {
  active: { label: 'Active', color: 'success', description: 'In use – reminders are sent' },
  renewal: { label: 'Renewal in progress', color: 'processing', description: 'Ordered or being replaced – reminders are still sent' },
  replaced: { label: 'Replaced', color: 'default', description: 'A newer certificate replaced it – no reminders' },
  retired: { label: 'Retired', color: 'default', description: 'No longer used – no reminders' },
};
/** Statuses that still get reminders and count as "expiring" */
export const CERT_WATCHED_STATUSES: CertStatus[] = ['active', 'renewal'];

/** Expiry windows (days) */
export const CERT_DAYS = { critical: 14, warning: 60 } as const;

export type CertExpiry = 'expired' | 'critical' | 'warning' | 'ok';
export const CERT_EXPIRY_META: Record<CertExpiry, { label: string; color: string }> = {
  expired: { label: 'Expired', color: 'red' },
  critical: { label: `Expires within ${CERT_DAYS.critical} days`, color: 'volcano' },
  warning: { label: `Expires within ${CERT_DAYS.warning} days`, color: 'orange' },
  ok: { label: 'Valid', color: 'green' },
};

export function certExpiry(daysLeft: number): CertExpiry {
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= CERT_DAYS.critical) return 'critical';
  if (daysLeft <= CERT_DAYS.warning) return 'warning';
  return 'ok';
}

export function daysLeftText(days: number): string {
  if (days < 0) return `expired ${-days} day${days === -1 ? '' : 's'} ago`;
  if (days === 0) return 'expires today';
  if (days === 1) return 'expires tomorrow';
  return `${days} days left`;
}

export interface Certificate {
  id: string;
  name: string;
  kind: CertKind;
  status: CertStatus;
  /** Subject / common name, e.g. "portal.example.com" */
  common_name: string | null;
  /** Further host names (SAN), comma separated */
  sans: string | null;
  issuer: string | null;
  serial_number: string | null;
  valid_from: string | null;
  expires_on: string;
  /** Renewed automatically (ACME, Intune …) – reminders are still sent unless the status says otherwise */
  auto_renew: boolean;
  /** Where it is installed (free text), e.g. "Load balancer VIP 10.1.2.3, IIS on muc-app10" */
  installed_on: string | null;
  plant_id: string | null;
  plant_code?: string | null;
  plant_name?: string | null;
  application_id: string | null;
  application_name?: string | null;
  asset_id: string | null;
  asset_name?: string | null;
  /** Responsible persons – each one with an e-mail address gets the reminders */
  responsibles: CertificateResponsible[];
  /** Further addresses that get the reminders (team mailbox …) */
  notify_emails: string[];
  description: string | null;
  /** Days until expiry (negative = expired), computed in the plant-independent server time zone */
  days_left: number;
  last_notified_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CertificateCounts {
  total: number;
  expired: number;
  critical: number;
  warning: number;
  /** watched certificates without any responsible e-mail address */
  no_responsible: number;
}

export interface CertificateList {
  items: Certificate[];
  counts: CertificateCounts;
}

// ---------------------------------------------------------------------------
// E-mail reminders and overview
// ---------------------------------------------------------------------------

export interface CertificateNotificationSettings {
  enabled: boolean;
  /** Reminder stages: days before expiry, e.g. [60, 30, 14, 7, 1] */
  thresholds: number[];
  /** One more reminder once the certificate has expired */
  includeExpired: boolean;
  /** Send the reminders to the responsible person and the further addresses of the certificate */
  notifyResponsible: boolean;
  /** Receive every reminder (in addition to the responsible persons) and the overview */
  recipients: string[];
  /** Overview e-mail: all certificates expired or expiring within overviewDays */
  overviewEnabled: boolean;
  /** ISO weekday of the overview: 1 = Monday … 7 = Sunday */
  overviewWeekday: number;
  overviewDays: number;
  sendHour: number;
  timezone: string;
}

export const DEFAULT_CERTIFICATE_NOTIFICATION_SETTINGS: CertificateNotificationSettings = {
  enabled: false,
  thresholds: [60, 30, 14, 7, 1],
  includeExpired: true,
  notifyResponsible: true,
  recipients: [],
  overviewEnabled: true,
  overviewWeekday: 1,
  overviewDays: 90,
  sendHour: 7,
  timezone: 'Europe/Berlin',
};

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export interface CertificateNotificationSettingsDto extends CertificateNotificationSettings {
  updatedAt: string | null;
  lastRun: { started_at: string; status: string; emails: number; items: number; error: string | null } | null;
}

export interface CertificateDueItem extends Pick<Certificate, 'id' | 'name' | 'common_name' | 'expires_on' | 'days_left' | 'responsibles' | 'plant_code' | 'application_name'> {
  /** reminder stages reached and not yet sent (0 = expired) */
  thresholds: number[];
  recipients: string[];
}

export interface CertificatePreview {
  today: string;
  reminders: CertificateDueItem[];
  /** certificates without any recipient (no responsible e-mail and no general recipients) */
  unrouted: number;
  overview: { due: boolean; recipients: string[]; items: number };
}

export interface CertificateRunResult {
  status: 'ok' | 'skipped' | 'error';
  error: string | null;
  reminders: number;
  emails: number;
  overview: boolean;
}

export interface CertificateResponsible {
  name: string | null;
  /** gets the reminders */
  email: string | null;
}

export const MAX_CERT_RESPONSIBLES = 20;

/** "Rita Responsible, Tom (tom@example.com)" – for lists and e-mails */
export function responsiblesText(list: readonly CertificateResponsible[] | null | undefined): string {
  return (list ?? []).map((r) => r.name || r.email || '').filter(Boolean).join(', ');
}

/** E-mail addresses of the responsible persons */
export function responsibleEmails(list: readonly CertificateResponsible[] | null | undefined): string[] {
  return (list ?? []).map((r) => r.email).filter((e): e is string => !!e);
}

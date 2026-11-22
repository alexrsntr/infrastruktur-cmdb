/**
 * PostgreSQL advisory lock IDs of the background jobs – all in one place.
 *
 * Every job that must run on only one app instance at a time takes its own session-level advisory lock
 * (pg_try_advisory_lock). Two jobs with the same ID block each other: the second one thinks "another instance is
 * already doing this" and skips its run. Add new jobs here with a new, unused number (tests/locks.test.ts checks
 * that all IDs are unique).
 */
export const LOCKS = {
  /** Database migrations at start (serialised across instances) */
  migrate: 727_001,
  /** Daily warranty digest */
  warrantyNotifications: 727_002,
  /** Daily certificate reminders and weekly overview */
  certificateNotifications: 727_003,
  /** Hourly database storage check */
  dbStorage: 727_004,
  /** Scheduled auto-discovery runs */
  discovery: 727_005,
  /** Webhook dispatcher (was 727_004 before – the same ID as the storage check, which then skipped its runs) */
  webhooks: 727_006,
} as const;

export type LockName = keyof typeof LOCKS;

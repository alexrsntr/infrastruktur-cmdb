import type { Migration } from '../migrations';

export const notificationsMigration: Migration = {
  id: '003_notifications',
  sql: /* sql */ `
    -- Key/value application settings (SMTP server, notification rules, ...). Secrets inside values are encrypted.
    CREATE TABLE app_setting (
      key         text PRIMARY KEY,
      value       jsonb NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  uuid REFERENCES app_user(id) ON DELETE SET NULL
    );

    -- One row per asset/threshold/warranty date that has been notified (deduplication)
    CREATE TABLE notification_log (
      id              bigserial PRIMARY KEY,
      kind            text NOT NULL,
      asset_id        uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
      threshold_days  integer NOT NULL,
      warranty_end    date NOT NULL,
      recipients      text[] NOT NULL DEFAULT '{}',
      sent_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (kind, asset_id, threshold_days, warranty_end)
    );
    CREATE INDEX notification_log_sent_idx ON notification_log (sent_at DESC);

    -- Every execution of a notification job (scheduled or manual)
    CREATE TABLE notification_run (
      id           bigserial PRIMARY KEY,
      kind         text NOT NULL DEFAULT 'warranty',
      started_at   timestamptz NOT NULL DEFAULT now(),
      finished_at  timestamptz,
      trigger      text NOT NULL CHECK (trigger IN ('schedule','manual')),
      local_date   date,
      items        integer NOT NULL DEFAULT 0,
      emails       integer NOT NULL DEFAULT 0,
      status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error','skipped')),
      error        text
    );
    CREATE INDEX notification_run_started_idx ON notification_run (started_at DESC);
    CREATE INDEX notification_run_schedule_idx ON notification_run (kind, trigger, local_date) WHERE status = 'ok';
  `,
};

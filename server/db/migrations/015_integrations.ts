import type { Migration } from '../migrations';

/**
 * Integrations: API tokens (each token acts as its own service user), webhooks fed by a transactional
 * outbox written together with the audit log, external references (tickets, monitoring links) and the
 * monitoring status reported by external systems.
 */
export const integrationsMigration: Migration = {
  id: '015_integrations',
  sql: /* sql */ `
    ALTER TABLE app_user ADD COLUMN is_service boolean NOT NULL DEFAULT false;

    CREATE TABLE api_token (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       uuid NOT NULL UNIQUE REFERENCES app_user(id) ON DELETE CASCADE,
      name          text NOT NULL,
      token_hash    text NOT NULL UNIQUE,
      token_prefix  text NOT NULL,
      expires_at    timestamptz,
      last_used_at  timestamptz,
      last_used_ip  text,
      revoked_at    timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid REFERENCES app_user(id) ON DELETE SET NULL
    );

    CREATE TABLE webhook (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name              text NOT NULL,
      url               text NOT NULL,
      secret_enc        text NOT NULL,
      events            text[] NOT NULL DEFAULT '{*}',
      active            boolean NOT NULL DEFAULT true,
      last_delivery_at  timestamptz,
      last_status       text,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      created_by        uuid REFERENCES app_user(id) ON DELETE SET NULL
    );

    -- written in the same transaction as the audit entry; the dispatcher fans it out to the webhooks
    CREATE TABLE event_outbox (
      id           bigserial PRIMARY KEY,
      event        text NOT NULL,
      payload      jsonb NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      fanned_out   boolean NOT NULL DEFAULT false
    );
    CREATE INDEX event_outbox_pending_idx ON event_outbox (id) WHERE NOT fanned_out;

    CREATE TABLE webhook_delivery (
      id               bigserial PRIMARY KEY,
      webhook_id       uuid NOT NULL REFERENCES webhook(id) ON DELETE CASCADE,
      event_id         bigint NOT NULL REFERENCES event_outbox(id) ON DELETE CASCADE,
      status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed')),
      attempts         integer NOT NULL DEFAULT 0,
      next_attempt_at  timestamptz NOT NULL DEFAULT now(),
      response_status  integer,
      last_error       text,
      delivered_at     timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      UNIQUE (webhook_id, event_id)
    );
    CREATE INDEX webhook_delivery_due_idx ON webhook_delivery (next_attempt_at) WHERE status = 'pending';

    CREATE TABLE asset_external_ref (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      asset_id    uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
      system      text NOT NULL,
      ref         text NOT NULL,
      url         text,
      title       text,
      status      text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid REFERENCES app_user(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX asset_external_ref_idx ON asset_external_ref (asset_id, lower(system), lower(ref));

    ALTER TABLE asset ADD COLUMN monitoring_status text CHECK (monitoring_status IN ('up','warning','down','unknown'));
    ALTER TABLE asset ADD COLUMN monitoring_message text;
    ALTER TABLE asset ADD COLUMN monitoring_source text;
    ALTER TABLE asset ADD COLUMN monitoring_checked_at timestamptz;
  `,
};

import type { Migration } from '../migrations';

/**
 * Certificates with expiry date and responsible person; certificate_notification remembers which reminder stage
 * was sent for which expiry date (a renewed certificate with a new date is reminded again).
 */
export const certificatesMigration: Migration = {
  id: '020_certificates',
  sql: /* sql */ `
    CREATE TABLE certificate (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name               text NOT NULL,
      kind               text NOT NULL DEFAULT 'tls' CHECK (kind IN ('tls','wildcard','ca','client','code_signing','smime','vpn','other')),
      status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','renewal','replaced','retired')),
      common_name        text,
      sans               text,
      issuer             text,
      serial_number      text,
      valid_from         date,
      expires_on         date NOT NULL,
      auto_renew         boolean NOT NULL DEFAULT false,
      installed_on       text,
      plant_id           uuid REFERENCES plant(id) ON DELETE CASCADE,
      application_id     uuid REFERENCES application(id) ON DELETE SET NULL,
      asset_id           uuid REFERENCES asset(id) ON DELETE SET NULL,
      responsible        text,
      responsible_email  text,
      notify_emails      text[] NOT NULL DEFAULT '{}',
      description        text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      created_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
      updated_by         uuid REFERENCES app_user(id) ON DELETE SET NULL
    );
    CREATE INDEX certificate_expires_idx ON certificate (expires_on) WHERE status IN ('active','renewal');
    CREATE INDEX certificate_plant_idx ON certificate (plant_id);
    CREATE INDEX certificate_application_idx ON certificate (application_id);
    CREATE INDEX certificate_asset_idx ON certificate (asset_id);

    CREATE TABLE certificate_notification (
      id              bigserial PRIMARY KEY,
      certificate_id  uuid NOT NULL REFERENCES certificate(id) ON DELETE CASCADE,
      threshold_days  integer NOT NULL,
      expires_on      date NOT NULL,
      recipients      text[] NOT NULL DEFAULT '{}',
      sent_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (certificate_id, threshold_days, expires_on)
    );
    CREATE INDEX certificate_notification_sent_idx ON certificate_notification (sent_at DESC);
  `,
};

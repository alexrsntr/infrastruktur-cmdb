import type { Migration } from '../migrations';

/**
 * A certificate can have several responsible persons (name + e-mail each) instead of one.
 * The existing person is carried over as the first entry of the list.
 */
export const certificateResponsiblesMigration: Migration = {
  id: '022_certificate_responsibles',
  sql: /* sql */ `
    ALTER TABLE certificate ADD COLUMN responsibles jsonb NOT NULL DEFAULT '[]'::jsonb
      CHECK (jsonb_typeof(responsibles) = 'array');
    UPDATE certificate
       SET responsibles = jsonb_build_array(jsonb_build_object('name', nullif(btrim(responsible), ''), 'email', nullif(btrim(responsible_email), '')))
     WHERE coalesce(btrim(responsible), '') <> '' OR coalesce(btrim(responsible_email), '') <> '';
    ALTER TABLE certificate DROP COLUMN responsible, DROP COLUMN responsible_email;
  `,
};

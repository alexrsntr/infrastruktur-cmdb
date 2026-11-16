import type { Migration } from '../migrations';

/**
 * Plant scorecard: every infrastructure area (WAN, network, switches, racks …) gets 1–5 points and a comment.
 * Only administrators create and rate it; everyone with access to the plant sees it.
 * WAN lines: the WAN / internet connections of a plant (technology, provider / product, bandwidth).
 */
export const scorecardWanMigration: Migration = {
  id: '019_scorecard_wan',
  sql: /* sql */ `
    CREATE TABLE plant_score (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plant_id    uuid NOT NULL REFERENCES plant(id) ON DELETE CASCADE,
      category    text NOT NULL,
      score       smallint CHECK (score BETWEEN 1 AND 5),
      comment     text,
      position    integer NOT NULL DEFAULT 0,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  uuid REFERENCES app_user(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX plant_score_category_idx ON plant_score (plant_id, lower(category));

    CREATE TABLE wan_line (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plant_id      uuid NOT NULL REFERENCES plant(id) ON DELETE CASCADE,
      name          text NOT NULL,
      technology    text,
      provider      text,
      bandwidth     text,
      circuit_id    text,
      contract_end  date,
      note          text,
      position      integer NOT NULL DEFAULT 0,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
      updated_by    uuid REFERENCES app_user(id) ON DELETE SET NULL
    );
    CREATE INDEX wan_line_plant_idx ON wan_line (plant_id, position);
  `,
};

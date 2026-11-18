import type { Migration } from '../migrations';

/**
 * Files on applications (contracts, licenses, manuals …). The attachment table gets "application" as an
 * additional object type. Pictures of an application are never plans: plans are site pictures to place
 * devices on and are listed per plant.
 */
export const applicationAttachmentsMigration: Migration = {
  id: '023_application_attachments',
  sql: /* sql */ `
    DO $$
    DECLARE c text;
    BEGIN
      FOR c IN SELECT conname FROM pg_constraint
               WHERE conrelid = 'attachment'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%entity_type%'
      LOOP
        EXECUTE format('ALTER TABLE attachment DROP CONSTRAINT %I', c);
      END LOOP;
    END $$;
    ALTER TABLE attachment ADD CONSTRAINT attachment_entity_type_check
      CHECK (entity_type IN ('plant','building','floor','rack','asset','application'));
    ALTER TABLE attachment ADD CONSTRAINT attachment_application_no_plan_check
      CHECK (entity_type <> 'application' OR NOT is_plan);
  `,
};

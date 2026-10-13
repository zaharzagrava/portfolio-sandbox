import type { QueryInterface } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';

/**
 * A real Postgres trigger that raises on every insert of the given event type into the outbox (S30 AS-56): the
 * rollback check forces the failure at the database, not with a mock. Always remove it in `finally` (L-013).
 */
export async function failOutboxInserts(
  sequelize: Sequelize,
  eventType: string,
): Promise<() => Promise<void>> {
  const name = `video_test_fail_${eventType.replace(/\W/g, '_')}`;
  await sequelize.query(`
    CREATE OR REPLACE FUNCTION "${name}"() RETURNS trigger AS $$
    BEGIN
      IF NEW."type" = '${eventType}' THEN
        RAISE EXCEPTION 'test: outbox insert refused for ${eventType}';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS "${name}" ON "Outbox";
    CREATE TRIGGER "${name}" BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION "${name}"();
  `);
  return async () => {
    await sequelize.query(`
      DROP TRIGGER IF EXISTS "${name}" ON "Outbox";
      DROP FUNCTION IF EXISTS "${name}"();
    `);
  };
}

export type { QueryInterface };

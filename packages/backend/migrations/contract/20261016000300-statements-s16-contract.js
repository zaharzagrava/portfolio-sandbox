'use strict';

/**
 * S16 seller statements, contract step (III.11). Shipped for a LATER release and kept in this subfolder, so `db:migrate`
 * does not run it with the expand step: run it by hand (`npx sequelize-cli db:migrate --migrations-path
 * migrations/contract`) only after the legacy reader and the `statements.retro-adjust` queue are gone.
 *
 * It refuses to change anything unless the new identity is complete: every adjustment has a cause kind and reference,
 * the old `UNIQUE(shopId, refersToMonth, reason)` is dropped (the expand step already drops it; this makes sure of it),
 * and no `statements.retro-adjust` job is waiting. Then the identity of an adjustment is `(shopId, refersToMonth,
 * causeKind, causeRef)` only, and the finished legacy jobs are removed. The legacy snapshot and adjustment columns
 * (`gross`, `commission`, `net`, `lines`, `commissionDelta`) stay: the current writers still fill them, and dropping
 * them is its own change.
 */
async function assertSafe(q) {
  const [[check]] = await q(`
    SELECT
      (SELECT count(*) FROM "StatementAdjustment" WHERE "causeKind" IS NULL OR "causeRef" IS NULL OR "causeRef" = '')::text AS no_cause,
      (SELECT count(*) FROM "Job" WHERE "type" = 'statements.retro-adjust' AND "status" IN ('QUEUED', 'RUNNING'))::text AS waiting
  `);
  if (check.no_cause !== '0')
    throw new Error(`${check.no_cause} adjustments have no cause identity yet`);
  if (check.waiting !== '0')
    throw new Error(`${check.waiting} statements.retro-adjust jobs are still waiting: drain the queue first`);
}

module.exports = {
  assertSafe,

  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await assertSafe(q);
      await q(`DO $$
        DECLARE c text;
        BEGIN
          FOR c IN
            SELECT conname FROM pg_constraint
             WHERE conrelid = '"StatementAdjustment"'::regclass AND contype = 'u'
               AND pg_get_constraintdef(oid) LIKE '%refersToMonth%reason%'
          LOOP
            EXECUTE format('ALTER TABLE "StatementAdjustment" DROP CONSTRAINT %I', c);
          END LOOP;
        END $$`);
      await q(`DELETE FROM "Job" WHERE "type" = 'statements.retro-adjust'`);
    });
  },

  async down() {
    // The retired unique key and the finished legacy jobs are not restored: a forward-only step.
  },
};

'use strict';

/**
 * S17 expand step 2: which charge attempt is in flight. `Invoice.attemptRef` is `'1'`..`'4'` for a numbered attempt
 * and `'manual:<k>'` for an extra one, `NULL` while none is claimed; a crashed claim is then resolved by looking up
 * exactly that reference, never by guessing which kind it was. Additive and idempotent; the immutability trigger of
 * the first step learns that the column may change.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const sql = (text) => queryInterface.sequelize.query(text, { transaction });
      await sql(`SET LOCAL lock_timeout = '5s'`);
      await sql(`ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "attemptRef" TEXT NULL`);
      await sql(`CREATE OR REPLACE FUNCTION billing_invoice_immutable() RETURNS trigger AS $fn$
       DECLARE
         mutable text[] := ARRAY['status','attempts','attemptStartedAt','attemptRef','attemptUnknown','manualAttempts',
                                 'firstFailedAt','nextAttemptAt','paidAt','updatedAt'];
       BEGIN
         IF TG_OP = 'DELETE' THEN
           RAISE EXCEPTION 'billing_invoice_immutable: an invoice is a financial record and is never deleted';
         END IF;
         IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
           RAISE EXCEPTION 'billing_invoice_immutable: an issued invoice never changes except its status and attempt fields';
         END IF;
         IF NEW."status" <> OLD."status" AND NOT (
              (OLD."status" = 'OPEN' AND NEW."status" IN ('PAID','UNCOLLECTIBLE')) OR
              (OLD."status" = 'UNCOLLECTIBLE' AND NEW."status" = 'PAID')) THEN
           RAISE EXCEPTION 'billing_invoice_immutable: invoice status % -> % is not allowed', OLD."status", NEW."status";
         END IF;
         RETURN NEW;
       END
       $fn$ LANGUAGE plpgsql`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "attemptRef"`);
  },
};

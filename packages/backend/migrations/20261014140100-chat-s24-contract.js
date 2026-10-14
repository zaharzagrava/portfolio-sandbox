'use strict';

/**
 * S24 contract (specs/domains/S24-product-chat/data-model.md section 4, step 3). Run it only after
 * scripts/chat/chat-s24-backfill.ts has completed; it refuses to swap while rows are missing.
 *
 *  - guarded swap of `ChatMessage` for the partitioned `ChatMessage_new` (ACCESS EXCLUSIVE with `lock_timeout 3s`
 *    and a bounded retry; the old table is kept as `ChatMessage_old` until the scheduled drop, see
 *    migrations-scheduled/20261215000000-chat-s24-drop-old.js); the swap copies only the tail written since the
 *    backfill and the deletions made since
 *  - the trigger `chat_message_assign_seq_trg` moves to the new parent (the function was replaced by the expand migration)
 *  - the chat tables lose their foreign keys to `Product`, `Shop` and `User` (IX.4: plain ids across owners)
 *  - `ChatChannel.shopId` is filled from the product where the product has a shop and is made required for new rows
 *    (`CHECK … NOT VALID`); when no NULL remains the column becomes NOT NULL. Channels of legacy sellers get their
 *    shop from the `chat.backfill-shops` job; the constraint is validated when the job reports zero rows left.
 *
 * `down` swaps back and is meant for a throwaway database only.
 */
const TAIL_COLUMNS = `id, "channelId", seq, "authorId", body, "replyToId", "clientMessageId", "createdAt", "deletedAt", "deletedBy"`;
const MAX_BACKFILL_GAP_ROWS = 50_000;
const ATTEMPTS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLockTimeout = (e) =>
  e?.original?.code === '55P03' || e?.parent?.code === '55P03' || /lock timeout/i.test(String(e?.message));

async function assertBackfilled(sequelize) {
  const [[row]] = await sequelize.query(`
    SELECT (SELECT id FROM "ChatMessage_new" ORDER BY id DESC LIMIT 1) AS last_new,
           (SELECT count(*) FROM "ChatMessage_new") AS new_total,
           (SELECT count(*) FROM "ChatMessage") AS old_total
  `);
  const oldTotal = Number(row.old_total);
  if (!row.last_new) {
    if (oldTotal > MAX_BACKFILL_GAP_ROWS) {
      throw new Error(
        `ChatMessage has ${oldTotal} rows and ChatMessage_new is empty: run scripts/chat/chat-s24-backfill.ts first`,
      );
    }
    return;
  }
  const [[cmp]] = await sequelize.query(
    `SELECT (SELECT count(*) FROM "ChatMessage" WHERE id <= :last) AS old_n,
            (SELECT count(*) FROM "ChatMessage_new" WHERE id <= :last) AS new_n`,
    { replacements: { last: row.last_new } },
  );
  if (Number(cmp.old_n) !== Number(cmp.new_n)) {
    throw new Error(
      `ChatMessage_new is missing ${Number(cmp.old_n) - Number(cmp.new_n)} rows: run scripts/chat/chat-s24-backfill.ts to completion first`,
    );
  }
}

async function swapOnce(sequelize) {
  await sequelize.transaction(async (transaction) => {
    const q = (sql, options = {}) => sequelize.query(sql, { transaction, ...options });
    await q(`SET LOCAL lock_timeout = '3s'`);
    await q(`LOCK TABLE "ChatMessage" IN ACCESS EXCLUSIVE MODE`);

    // the tail written since the backfill (ids are uuidv7: time ordered) and the deletions made since
    await q(`
      WITH tail AS (
        SELECT ${TAIL_COLUMNS} FROM "ChatMessage"
         WHERE id > coalesce((SELECT id FROM "ChatMessage_new" ORDER BY id DESC LIMIT 1), '00000000-0000-0000-0000-000000000000')
      ), ins AS (
        INSERT INTO "ChatMessage_new" (${TAIL_COLUMNS}) SELECT ${TAIL_COLUMNS} FROM tail
        ON CONFLICT (id, "createdAt") DO NOTHING
        RETURNING 1
      )
      INSERT INTO "ChatMessageIndex" ("channelId", seq, "messageId", "createdAt", "authorId", "clientMessageId", "bodyHash")
      SELECT "channelId", seq, id, "createdAt", "authorId", "clientMessageId",
             sha256(convert_to(body || chr(31) || coalesce("replyToId"::text, ''), 'UTF8'))
        FROM tail
      ON CONFLICT DO NOTHING
    `);
    await q(`
      UPDATE "ChatMessage_new" n SET "deletedAt" = o."deletedAt", "deletedBy" = o."deletedBy"
        FROM "ChatMessage" o
       WHERE o.id = n.id AND o."createdAt" = n."createdAt" AND o."deletedAt" IS NOT NULL AND n."deletedAt" IS NULL
    `);

    await q(`DROP TRIGGER IF EXISTS chat_message_assign_seq_trg ON "ChatMessage"`);
    await q(`ALTER INDEX IF EXISTS "ChatMessage_pkey" RENAME TO "ChatMessage_old_pkey"`);
    await q(`ALTER TABLE "ChatMessage" RENAME TO "ChatMessage_old"`);
    await q(`ALTER TABLE "ChatMessage_new" RENAME TO "ChatMessage"`);
    await q(`ALTER INDEX IF EXISTS "ChatMessage_new_pkey" RENAME TO "ChatMessage_pkey"`);
    await q(`
      CREATE TRIGGER chat_message_assign_seq_trg BEFORE INSERT ON "ChatMessage"
        FOR EACH ROW EXECUTE FUNCTION chat_message_assign_seq()
    `);
  });
}

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;
    const q = (sql) => sequelize.query(sql);

    const [[present]] = await sequelize.query(`SELECT to_regclass('"ChatMessage_new"') IS NOT NULL AS has_new`);
    if (present.has_new) {
      await assertBackfilled(sequelize);
      for (let attempt = 1; ; attempt++) {
        try {
          await swapOnce(sequelize);
          break;
        } catch (e) {
          if (!isLockTimeout(e) || attempt >= ATTEMPTS) throw e;
          await sleep(1000 * attempt);
        }
      }
    }

    // plain ids across owners: no foreign key from the chat tables to Product, Shop or User
    await q(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT c.conname, c.conrelid::regclass::text AS tbl
            FROM pg_constraint c
           WHERE c.contype = 'f'
             AND c.conrelid IN ('"ChatChannel"'::regclass, '"ChatChannelMember"'::regclass)
             AND (SELECT relname FROM pg_class WHERE oid = c.confrelid) IN ('Product', 'Shop', 'User')
        LOOP
          EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
        END LOOP;
      END $$;
    `);

    // shop of the channel: from the product where it has one (a one-time read inside this migration only)
    await q(`
      SET lock_timeout = '3s';
      UPDATE "ChatChannel" c SET "shopId" = p."shopId"
        FROM "Product" p WHERE c."productId" = p.id AND c."shopId" IS NULL AND p."shopId" IS NOT NULL;
      ALTER TABLE "ChatChannel" DROP CONSTRAINT IF EXISTS "ChatChannel_shop_required";
      ALTER TABLE "ChatChannel" ADD CONSTRAINT "ChatChannel_shop_required" CHECK ("shopId" IS NOT NULL) NOT VALID;
    `);
    await q(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM "ChatChannel" WHERE "shopId" IS NULL) THEN
          ALTER TABLE "ChatChannel" VALIDATE CONSTRAINT "ChatChannel_shop_required";
          ALTER TABLE "ChatChannel" ALTER COLUMN "shopId" SET NOT NULL;
          ALTER TABLE "ChatChannel" DROP CONSTRAINT "ChatChannel_shop_required";
        ELSE
          RAISE NOTICE 'ChatChannel.shopId: channels without a shop remain; the chat.backfill-shops job fills them, then validates the constraint';
        END IF;
      END $$;
    `);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      ALTER TABLE "ChatChannel" DROP CONSTRAINT IF EXISTS "ChatChannel_shop_required";
      ALTER TABLE "ChatChannel" ALTER COLUMN "shopId" DROP NOT NULL;
    `);
    const [[state]] = await queryInterface.sequelize.query(
      `SELECT to_regclass('"ChatMessage_old"') IS NOT NULL AS has_old`,
    );
    if (!state.has_old) return;
    await q(`
      DROP TRIGGER IF EXISTS chat_message_assign_seq_trg ON "ChatMessage";
      ALTER INDEX IF EXISTS "ChatMessage_pkey" RENAME TO "ChatMessage_new_pkey";
      ALTER TABLE "ChatMessage" RENAME TO "ChatMessage_new";
      ALTER TABLE "ChatMessage_old" RENAME TO "ChatMessage";
      ALTER INDEX IF EXISTS "ChatMessage_old_pkey" RENAME TO "ChatMessage_pkey";
      CREATE TRIGGER chat_message_assign_seq_trg BEFORE INSERT ON "ChatMessage"
        FOR EACH ROW EXECUTE FUNCTION chat_message_assign_seq();
    `);
  },
};

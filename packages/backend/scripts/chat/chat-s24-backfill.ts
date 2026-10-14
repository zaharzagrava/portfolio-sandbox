/**
 * S24 backfill (specs/domains/S24-product-chat/data-model.md section 4, step 2). Repeatable and safe to stop: every
 * statement is idempotent, every transaction short (at most `batch` rows, default 500), ascending by id.
 *
 *   pnpm exec ts-node -r tsconfig-paths/register scripts/chat/chat-s24-backfill.ts
 *
 * 1. copies `ChatMessage` into the partitioned `ChatMessage_new` and builds the `ChatMessageIndex` rows (the new
 *    insert trigger already writes the index for messages sent since the expand migration: `ON CONFLICT DO NOTHING`);
 * 2. computes `ChatChannel.activeMemberCount`.
 * The contract migration refuses to swap while rows are missing, so run this to completion first.
 */
import 'dotenv/config';
import { Client } from 'pg';

type Queryable = Pick<Client, 'query'>;

const BODY_HASH = `sha256(convert_to(body || chr(31) || coalesce("replyToId"::text, ''), 'UTF8'))`;

export interface BackfillResult {
  messages: number;
  channels: number;
}

async function inTx<T>(db: Queryable, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    const out = await fn();
    await db.query('COMMIT');
    return out;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

export async function backfillMessages(
  db: Queryable,
  batch = 500,
): Promise<number> {
  let after = '00000000-0000-0000-0000-000000000000';
  let total = 0;
  for (;;) {
    const res = await inTx(db, () =>
      db.query<{ last: string | null; n: string }>(
        `WITH b AS (
           SELECT id, "channelId", seq, "authorId", body, "replyToId", "clientMessageId", "createdAt", "deletedAt", "deletedBy"
             FROM "ChatMessage" WHERE id > $1 ORDER BY id LIMIT $2
         ), ins AS (
           INSERT INTO "ChatMessage_new" (id, "channelId", seq, "authorId", body, "replyToId", "clientMessageId", "createdAt", "deletedAt", "deletedBy")
           SELECT id, "channelId", seq, "authorId", body, "replyToId", "clientMessageId", "createdAt", "deletedAt", "deletedBy" FROM b
           ON CONFLICT (id, "createdAt") DO UPDATE SET "deletedAt" = EXCLUDED."deletedAt", "deletedBy" = EXCLUDED."deletedBy"
           RETURNING 1
         ), idx AS (
           INSERT INTO "ChatMessageIndex" ("channelId", seq, "messageId", "createdAt", "authorId", "clientMessageId", "bodyHash")
           SELECT "channelId", seq, id, "createdAt", "authorId", "clientMessageId", ${BODY_HASH} FROM b
           ON CONFLICT DO NOTHING
           RETURNING 1
         )
         SELECT (SELECT id FROM b ORDER BY id DESC LIMIT 1) AS last, (SELECT count(*) FROM b) AS n`,
        [after, batch],
      ),
    );
    const { last, n } = res.rows[0];
    if (!last) return total;
    total += Number(n);
    after = last;
  }
}

export async function backfillMemberCounts(
  db: Queryable,
  batch = 500,
): Promise<number> {
  let after = '00000000-0000-0000-0000-000000000000';
  let total = 0;
  for (;;) {
    const res = await inTx(db, () =>
      db.query<{ last: string | null; n: string }>(
        `WITH b AS (SELECT id FROM "ChatChannel" WHERE id > $1 ORDER BY id LIMIT $2),
         upd AS (
           UPDATE "ChatChannel" c
              SET "activeMemberCount" = (SELECT count(*) FROM "ChatChannelMember" m WHERE m."channelId" = c.id AND m.status = 'ACTIVE')
             FROM b WHERE c.id = b.id
           RETURNING 1
         )
         SELECT (SELECT id FROM b ORDER BY id DESC LIMIT 1) AS last, (SELECT count(*) FROM b) AS n`,
        [after, batch],
      ),
    );
    const { last, n } = res.rows[0];
    if (!last) return total;
    total += Number(n);
    after = last;
  }
}

export async function runChatBackfill(
  db: Queryable,
  batch = 500,
): Promise<BackfillResult> {
  const messages = await backfillMessages(db, batch);
  const channels = await backfillMemberCounts(db, batch);
  return { messages, channels };
}

async function main(): Promise<void> {
  const db = new Client(
    process.env.DB_URI
      ? { connectionString: process.env.DB_URI }
      : {
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT ?? 5432),
          user: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
        },
  );
  await db.connect();
  try {
    const result = await runChatBackfill(db);
    console.log(JSON.stringify({ event: 'chat-s24-backfill', ...result }));
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

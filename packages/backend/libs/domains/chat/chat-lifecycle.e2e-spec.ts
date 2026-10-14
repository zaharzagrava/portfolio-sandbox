import { QueryTypes, Sequelize } from 'sequelize';
import { Sequelize as SequelizeTs } from 'sequelize-typescript';
import { v4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { recordStatements } from '@app/test/utils/catalog-fixtures';
import { ShopProvisioningService } from '@app/domains/tenancy';
import { runChatBackfill } from '../../../scripts/chat/chat-s24-backfill';
import { ChatShopBackfillService } from './application/chat-shop-backfill.service';
import { PORTS, type ProductLookup } from './domain/ports';
import { ChatShopPurgeConsumer } from './infra/chat-shop-purge.consumer';
import * as barrel from './index';
import {
  clearRateLimits,
  createChatApp,
  exec as run,
  fastStoreOf,
  gatewayInsert,
  joinedBuyer,
  newId,
  openChannel,
  rows as tableRows,
  seedWorld,
  sendMessage,
  type ChatTestApp,
  type FastStore,
  type TestUser,
} from './testing/chat-app';

const T = new Date('2026-10-14T12:00:00.000Z');

/* eslint-disable @typescript-eslint/no-require-imports -- sequelize-cli migrations are CommonJS files */
const legacyOutboxFunction = require('../../../migrations/20261009150000-chat-outbox-envelope.js');
const expandMigration = require('../../../migrations/20261014140000-chat-s24-expand.js');
const contractMigration = require('../../../migrations/20261014140100-chat-s24-contract.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const LEGACY_DDL = `
  CREATE TABLE "User" (id UUID PRIMARY KEY);
  CREATE TABLE "Shop" (id UUID PRIMARY KEY);
  CREATE TABLE "Product" (id UUID PRIMARY KEY, "shopId" UUID NULL REFERENCES "Shop"(id));
  CREATE TABLE "Outbox" (
    id UUID PRIMARY KEY, topic TEXT, "aggregateId" TEXT, "aggregateType" TEXT, "type" TEXT, "eventName" TEXT,
    payload JSONB, attempts INT, "nextAttemptAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ
  );
  CREATE TABLE "ChatChannel" (
    id UUID PRIMARY KEY,
    "productId" UUID NOT NULL UNIQUE REFERENCES "Product"(id) ON DELETE CASCADE,
    "sellerId" UUID NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    "shopId" UUID NULL REFERENCES "Shop"(id),
    title TEXT NOT NULL, "isArchived" BOOLEAN NOT NULL DEFAULT false, "archivedAt" TIMESTAMPTZ NULL,
    "lastSeq" BIGINT NOT NULL DEFAULT 0, "lastMessageAt" TIMESTAMPTZ NULL,
    "createdAt" TIMESTAMPTZ NOT NULL, "updatedAt" TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE "ChatChannelMember" (
    id UUID PRIMARY KEY,
    "channelId" UUID NOT NULL REFERENCES "ChatChannel"(id) ON DELETE CASCADE,
    "userId" UUID NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'MEMBER', status TEXT NOT NULL DEFAULT 'ACTIVE', "mutedUntil" TIMESTAMPTZ NULL,
    "lastReadSeq" BIGINT NOT NULL DEFAULT 0, "lastReadAt" TIMESTAMPTZ NULL,
    "createdAt" TIMESTAMPTZ NOT NULL, "updatedAt" TIMESTAMPTZ NOT NULL
  );
  CREATE UNIQUE INDEX chat_channel_member_channel_user_uq ON "ChatChannelMember" ("channelId", "userId");
  CREATE TABLE "ChatMessage" (
    id UUID PRIMARY KEY,
    "channelId" UUID NOT NULL REFERENCES "ChatChannel"(id) ON DELETE CASCADE,
    "authorId" UUID NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    "replyToId" UUID NULL REFERENCES "ChatMessage"(id) ON DELETE SET NULL,
    body TEXT NOT NULL, "editedAt" TIMESTAMPTZ NULL, "deletedAt" TIMESTAMPTZ NULL, "createdAt" TIMESTAMPTZ NOT NULL,
    seq BIGINT NULL, "clientMessageId" UUID NULL
  );
  CREATE UNIQUE INDEX "ChatMessage_channel_seq_uq" ON "ChatMessage" ("channelId", seq);
  CREATE UNIQUE INDEX "ChatMessage_channel_client_id_uq" ON "ChatMessage" ("channelId", "clientMessageId") WHERE "clientMessageId" IS NOT NULL;
  CREATE TRIGGER chat_message_assign_seq_trg BEFORE INSERT ON "ChatMessage" FOR EACH ROW EXECUTE FUNCTION chat_message_assign_seq();
`;

describe('Product chat: shop lifecycle, backfill and domain isolation', () => {
  let db: Sequelize;
  let t: ChatTestApp;
  let fast: FastStore;

  beforeAll(async () => {
    t = await createChatApp();
    fast = fastStoreOf(t.app);
    db = t.app.get(SequelizeTs) as unknown as Sequelize;
  });

  afterAll(async () => {
    await fast.allow();
    await t.close();
  });

  beforeEach(async () => {
    await fast.allow();
    await t.reset();
    await clearRateLimits(t.app);
    await t.setTime(T);
  });

  /** A single-connection Sequelize whose search path is a throwaway schema: the migrations name tables unqualified. */
  const scratchSchema = async () => {
    const schema = `chat_mig_${v4().replace(/-/g, '').slice(0, 12)}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    const s = new Sequelize({
      ...(db as unknown as { options: object }).options,
      pool: { max: 1, min: 1 },
      logging: false,
    } as never);
    await s.query(`SET search_path TO ${schema}, public`);
    return {
      s,
      schema,
      drop: async () => {
        await s.close();
        await db.query(`DROP SCHEMA ${schema} CASCADE`);
      },
    };
  };
  /** Message ids are uuidv7 (time ordered), as the application and the gateway generate them. */
  const v7 = async (s: Sequelize) =>
    (
      await s.query<{ id: string }>('SELECT uuidv7() AS id', {
        type: QueryTypes.SELECT,
      })
    )[0].id;
  const rows = <T extends object>(
    s: Sequelize,
    sql: string,
    replacements: object = {},
  ) =>
    s.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements: replacements as Record<string, unknown>,
    });
  const backfillClient = (s: Sequelize) => ({
    query: async (sql: string, params?: unknown[]) => {
      const [out] = await s.query(sql, params ? { bind: params as never } : {});
      return { rows: out as never[] };
    },
  });

  describe('schema of the real database (the migrations ran on an empty database)', () => {
    it('S24 AS-28: ChatMessage is partitioned by month with a default partition and the index table exists', async () => {
      const [{ kind }] = await rows<{ kind: string }>(
        db,
        `SELECT relkind AS kind FROM pg_class WHERE relname = 'ChatMessage' AND relnamespace = current_schema()::regnamespace`,
      );
      expect(kind).toBe('p');
      const parts = await rows<{ relname: string }>(
        db,
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = '"ChatMessage"'::regclass ORDER BY c.relname`,
      );
      const names = parts.map((p) => p.relname);
      expect(names).toContain('ChatMessage_default');
      const now = new Date();
      for (let ahead = 0; ahead <= 3; ahead++) {
        const d = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1),
        );
        expect(names).toContain(
          `ChatMessage_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        );
      }
      const [{ has }] = await rows<{ has: boolean }>(
        db,
        `SELECT to_regclass('"ChatMessageIndex"') IS NOT NULL AS has`,
      );
      expect(has).toBe(true);
    });

    it('S24 AS-58: seq is NOT NULL and no chat table has a foreign key to Shop, User, Product or itself', async () => {
      const [{ nullable }] = await rows<{ nullable: string }>(
        db,
        `SELECT is_nullable AS nullable FROM information_schema.columns
          WHERE table_name = 'ChatMessage' AND column_name = 'seq' AND table_schema = current_schema()`,
      );
      expect(nullable).toBe('NO');
      const fks = await rows<{ tbl: string; target: string }>(
        db,
        `SELECT c.conrelid::regclass::text AS tbl, (SELECT relname FROM pg_class WHERE oid = c.confrelid) AS target
           FROM pg_constraint c
          WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('"ChatChannel"', '"ChatChannelMember"', '"ChatMessage"', '"ChatMessageIndex"')`,
      );
      const foreign = fks.filter((f) =>
        ['Shop', 'User', 'Product', 'ChatMessage'].includes(f.target),
      );
      expect(foreign).toEqual([]);
    });
  });

  describe('migration on a legacy-populated database', () => {
    it('S24 AS-28: expand, backfill and contract keep every message, sequence number and deletion', async () => {
      const { s, drop } = await scratchSchema();
      try {
        await s.query(
          `CREATE OR REPLACE FUNCTION chat_message_assign_seq() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql`,
        );
        await legacyOutboxFunction.up({ sequelize: s });
        await s.query(LEGACY_DDL);

        const shop = v4();
        const seller = v4();
        const buyer = v4();
        const product = v4();
        const productWithoutShop = v4();
        const channel = v4();
        const channel2 = v4();
        await s.query(
          `INSERT INTO "User" (id) VALUES ('${seller}'), ('${buyer}');
           INSERT INTO "Shop" (id) VALUES ('${shop}');
           INSERT INTO "Product" (id, "shopId") VALUES ('${product}', '${shop}'), ('${productWithoutShop}', NULL);
           INSERT INTO "ChatChannel" (id, "productId", "sellerId", title, "createdAt", "updatedAt")
             VALUES ('${channel}', '${product}', '${seller}', 'A', now(), now()), ('${channel2}', '${productWithoutShop}', '${seller}', 'B', now(), now());
           INSERT INTO "ChatChannelMember" (id, "channelId", "userId", role, status, "createdAt", "updatedAt")
             VALUES (gen_random_uuid(), '${channel}', '${seller}', 'OWNER', 'ACTIVE', now(), now()),
                    (gen_random_uuid(), '${channel}', '${buyer}', 'MEMBER', 'ACTIVE', now(), now()),
                    (gen_random_uuid(), '${channel2}', '${buyer}', 'MEMBER', 'BANNED', now(), now())`,
        );
        const insertOld = (
          id: string,
          ch: string,
          author: string,
          at: string,
          body: string,
        ) =>
          s.query(
            `INSERT INTO "ChatMessage" (id, "channelId", "authorId", body, "createdAt") VALUES (:id, :ch, :author, :body, :at)`,
            { replacements: { id, ch, author, body, at } },
          );
        const ids = [await v7(s), await v7(s), await v7(s)];
        await insertOld(
          ids[0],
          channel,
          seller,
          '2026-08-10T10:00:00Z',
          'august',
        );
        await insertOld(
          ids[1],
          channel,
          buyer,
          '2026-09-20T10:00:00Z',
          'september',
        );
        await insertOld(
          ids[2],
          channel,
          seller,
          new Date().toISOString(),
          'now',
        );
        await s.query(
          `UPDATE "ChatMessage" SET "deletedAt" = now() WHERE id = '${ids[1]}'`,
        );

        await expandMigration.up({ sequelize: s });

        // written while the backfill is running: the (replaced) trigger on the old table already indexes it
        const during = await v7(s);
        await insertOld(
          during,
          channel,
          buyer,
          new Date().toISOString(),
          'during backfill',
        );
        const result = await runChatBackfill(backfillClient(s) as never, 2);
        expect(result.messages).toBe(4);

        // written and deleted after the backfill: only the swap's tail step can bring these over
        const tail = await v7(s);
        await insertOld(
          tail,
          channel,
          seller,
          new Date().toISOString(),
          'tail',
        );
        await s.query(
          `UPDATE "ChatMessage" SET "deletedAt" = now(), "deletedBy" = '${seller}' WHERE id = '${ids[0]}'`,
        );

        await contractMigration.up({ sequelize: s });

        const [{ kind }] = await rows<{ kind: string }>(
          s,
          `SELECT relkind AS kind FROM pg_class WHERE oid = '"ChatMessage"'::regclass`,
        );
        expect(kind).toBe('p');
        const all = await rows<{ id: string; seq: string; deleted: boolean }>(
          s,
          `SELECT id, seq, "deletedAt" IS NOT NULL AS deleted FROM "ChatMessage" WHERE "channelId" = :channel ORDER BY seq`,
          { channel },
        );
        expect(all.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4, 5]);
        expect(all.map((r) => r.id)).toEqual([
          ids[0],
          ids[1],
          ids[2],
          during,
          tail,
        ]);
        expect(all.map((r) => r.deleted)).toEqual([
          true,
          true,
          false,
          false,
          false,
        ]);
        const [{ n }] = await rows<{ n: string }>(
          s,
          `SELECT count(*) AS n FROM "ChatMessageIndex" WHERE "channelId" = :channel`,
          { channel },
        );
        expect(Number(n)).toBe(5);

        // activeMemberCount came from the backfill; shopId from the product, the product without a shop stays open
        const counts = await rows<{
          id: string;
          count: number;
          shop: string | null;
        }>(
          s,
          `SELECT id, "activeMemberCount" AS count, "shopId" AS shop FROM "ChatChannel" ORDER BY title`,
        );
        expect(counts.map((c) => [c.count, c.shop])).toEqual([
          [2, shop],
          [0, null],
        ]);
        const [{ convalidated }] = await rows<{ convalidated: boolean }>(
          s,
          `SELECT convalidated FROM pg_constraint WHERE conname = 'ChatChannel_shop_required'`,
        );
        expect(convalidated).toBe(false);

        // the swapped table keeps numbering: the trigger sits on the new parent
        const after = await v7(s);
        await s.query(
          `INSERT INTO "ChatMessage" (id, "channelId", "authorId", body, "createdAt") VALUES (:after, :channel, :seller, 'after swap', now())`,
          { replacements: { after, channel, seller } },
        );
        const [{ seq }] = await rows<{ seq: string }>(
          s,
          `SELECT seq FROM "ChatMessage" WHERE id = :after`,
          { after },
        );
        expect(Number(seq)).toBe(6);
        const events = await rows<{ id: string }>(
          s,
          `SELECT id FROM "Outbox" WHERE "aggregateId" = :channel AND payload->'payload'->>'messageId' = :after`,
          { channel, after },
        );
        expect(events).toHaveLength(1);
        expect(events[0].id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      } finally {
        await drop();
      }
    });

    it('S24 AS-28: the contract migration refuses while the backfill is incomplete', async () => {
      const { s, drop } = await scratchSchema();
      try {
        await s.query(
          `CREATE OR REPLACE FUNCTION chat_message_assign_seq() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql`,
        );
        await legacyOutboxFunction.up({ sequelize: s });
        await s.query(LEGACY_DDL);
        const [seller, product, channel] = [v4(), v4(), v4()];
        await s.query(
          `INSERT INTO "User" (id) VALUES ('${seller}');
           INSERT INTO "Product" (id) VALUES ('${product}');
           INSERT INTO "ChatChannel" (id, "productId", "sellerId", title, "createdAt", "updatedAt") VALUES ('${channel}', '${product}', '${seller}', 'A', now(), now())`,
        );
        const ids = [await v7(s), await v7(s), await v7(s)];
        for (const [i, id] of ids.entries()) {
          await s.query(
            `INSERT INTO "ChatMessage" (id, "channelId", "authorId", body, "createdAt") VALUES ('${id}', '${channel}', '${seller}', 'm${i}', now())`,
          );
        }
        await expandMigration.up({ sequelize: s });
        await runChatBackfill(backfillClient(s) as never, 10);
        // a row below the high-water mark is lost from the copy
        await s.query(
          `DELETE FROM "ChatMessage_new" WHERE id = '${[...ids].sort()[0]}'`,
        );
        await expect(contractMigration.up({ sequelize: s })).rejects.toThrow(
          /missing 1 rows/,
        );
        const [{ kind }] = await rows<{ kind: string }>(
          s,
          `SELECT relkind AS kind FROM pg_class WHERE oid = '"ChatMessage"'::regclass`,
        );
        expect(kind).toBe('r');
      } finally {
        await drop();
      }
    });
  });

  describe('shop deleted: purge (AS-56)', () => {
    const purge = (_shopId?: string) => t.app.get(ChatShopPurgeConsumer);
    const shopDeleted = (
      shopId: unknown,
      over: Partial<EventEnvelope> = {},
    ): EventEnvelope =>
      ({
        eventId: newId(),
        type: 'tenancy.shop_deleted',
        version: 1,
        aggregateType: 'tenancy',
        aggregateId: String(shopId),
        aggregateVersion: 2,
        occurredAt: T.toISOString(),
        payload: { shopId, shopVersion: 2 },
        ...over,
      }) as EventEnvelope;
    const counts = async (shopId: string) => {
      const [row] = await tableRows<{
        channels: string;
        members: string;
        messages: string;
        indexed: string;
      }>(
        t.app,
        `SELECT (SELECT count(*) FROM "ChatChannel" WHERE "shopId" = :shopId)::text AS channels,
                (SELECT count(*) FROM "ChatChannelMember" WHERE "channelId" IN (SELECT id FROM "ChatChannel" WHERE "shopId" = :shopId))::text AS members,
                (SELECT count(*) FROM "ChatMessage" WHERE "channelId" IN (SELECT id FROM "ChatChannel" WHERE "shopId" = :shopId))::text AS messages,
                (SELECT count(*) FROM "ChatMessageIndex" WHERE "channelId" IN (SELECT id FROM "ChatChannel" WHERE "shopId" = :shopId))::text AS indexed`,
        { shopId },
      );
      return [row.channels, row.members, row.messages, row.indexed].map(Number);
    };
    /** A shop with `n` channels, each with a buyer and a few messages (API and gateway rows). */
    const shopWithChats = async (n: number) => {
      const w = await seedWorld(t);
      const channels: Array<{ id: string; buyer: TestUser }> = [];
      for (let i = 0; i < n; i++) {
        const product =
          i === 0 ? w.product : await createProduct(t.app, w.shop, {});
        const res = await t
          .as(w.owner)
          .post('/api/chat/channels')
          .send({ productId: product.id });
        const buyer = await joinedBuyer(t, res.body.id);
        await sendMessage(t, w.owner, res.body.id, 'hello');
        await sendMessage(t, buyer, res.body.id, 'question');
        await gatewayInsert(t.app, res.body.id, buyer.id, 'from the gateway');
        channels.push({ id: res.body.id as string, buyer });
      }
      return { w, channels };
    };
    const purged = () => MetricsRegistry.value('chat_purge_noop_total') ?? 0;

    it('S24 AS-56: both channels, their members and messages go; another shop is untouched; nothing cached stays readable', async () => {
      const a = await shopWithChats(2);
      const b = await shopWithChats(1);
      const warm = await t
        .as(a.channels[0].buyer)
        .post('/api/chat/sync')
        .send({ cursors: { [a.channels[0].id]: 0 } });
      expect(warm.body[0].messages).toHaveLength(3);
      const keep = await counts(b.w.shop.id);
      expect(keep[0]).toBe(1);

      await purge(a.w.shop.id).project([shopDeleted(a.w.shop.id)]);
      expect(await counts(a.w.shop.id)).toEqual([0, 0, 0, 0]);
      expect(await counts(b.w.shop.id)).toEqual(keep);
      const after = await t
        .as(a.channels[0].buyer)
        .post('/api/chat/sync')
        .send({ cursors: { [a.channels[0].id]: 0 } });
      expect(after.body).toEqual([]);
      expect(
        (
          await t
            .as(a.channels[0].buyer)
            .get(`/api/chat/channels/${a.channels[0].id}/messages`)
        ).status,
      ).toBe(404);
    });

    it('S24 AS-56: the same event again, or two consumers at once, is no error and no further change (20 repeats)', async () => {
      for (let i = 0; i < 20; i++) {
        const a = await shopWithChats(1);
        const consumer = purge(a.w.shop.id);
        await Promise.all([
          consumer.project([shopDeleted(a.w.shop.id)]),
          consumer.project([shopDeleted(a.w.shop.id)]),
        ]);
        expect(await counts(a.w.shop.id)).toEqual([0, 0, 0, 0]);
        await consumer.project([shopDeleted(a.w.shop.id)]);
        expect(await counts(a.w.shop.id)).toEqual([0, 0, 0, 0]);
        await clearRateLimits(t.app);
      }
    });

    it('S24 AS-56: a shop with no channels does nothing and is counted', async () => {
      const before = purged();
      await purge(newId()).project([shopDeleted(newId())]);
      expect(purged()).toBe(before + 1);
    });

    it.each<[string, unknown]>([
      ['a missing shopId', undefined],
      ['a shopId that is not a UUID', 'not-a-uuid'],
      ['a shopId of the wrong type', 42],
    ])(
      'S24 AS-56: %s is dead-lettered and deletes nothing',
      async (_label, shopId) => {
        const a = await shopWithChats(1);
        const before = await counts(a.w.shop.id);
        await expect(
          purge(a.w.shop.id).project([
            shopDeleted(shopId ?? a.w.shop.id, {
              payload: { shopId, shopVersion: 2 } as never,
            }),
          ]),
        ).rejects.toBeInstanceOf(PermanentError);
        expect(await counts(a.w.shop.id)).toEqual(before);
      },
    );

    it('S24 AS-56: a big channel is removed in batches of at most 500 rows', async () => {
      const a = await shopWithChats(1);
      const [{ id }] = a.channels;
      await run(
        t.app,
        `INSERT INTO "ChatMessage" (id, "channelId", "authorId", body, "createdAt")
         SELECT uuidv7(), :id, :author, 'bulk ' || g, now() FROM generate_series(1, 1200) g`,
        { id, author: a.w.owner.id },
      );
      const { statements } = await recordStatements(
        t.app,
        () => purge(a.w.shop.id).project([shopDeleted(a.w.shop.id)]),
        /DELETE FROM "ChatMessage"/,
      );
      expect(statements.length).toBeGreaterThanOrEqual(3);
      for (const s of statements) expect(s).toMatch(/LIMIT 500/);
      expect(await counts(a.w.shop.id)).toEqual([0, 0, 0, 0]);
    });
  });

  describe('shop backfill (AS-57)', () => {
    const service = () => t.app.get(ChatShopBackfillService);
    /** The state the contract migration leaves while legacy channels without a shop exist: nullable, required for new rows only. */
    const legacyState = async () => {
      await run(
        t.app,
        `ALTER TABLE "ChatChannel" DROP CONSTRAINT IF EXISTS "ChatChannel_shop_required"`,
      );
      await run(
        t.app,
        `ALTER TABLE "ChatChannel" ALTER COLUMN "shopId" DROP NOT NULL`,
      );
    };
    /** After the legacy rows exist: the check applies to new rows only (`NOT VALID`), as the contract migration leaves it. */
    const sealLegacy = () =>
      run(
        t.app,
        `ALTER TABLE "ChatChannel" ADD CONSTRAINT "ChatChannel_shop_required" CHECK ("shopId" IS NOT NULL) NOT VALID`,
      );
    const restoreState = async () => {
      await run(
        t.app,
        `UPDATE "ChatChannel" SET "shopId" = uuidv7() WHERE "shopId" IS NULL`,
      );
      await run(
        t.app,
        `ALTER TABLE "ChatChannel" DROP CONSTRAINT IF EXISTS "ChatChannel_shop_required"`,
      );
      await run(
        t.app,
        `ALTER TABLE "ChatChannel" ALTER COLUMN "shopId" SET NOT NULL`,
      );
    };
    const shopOf = async (channelId: string) =>
      (
        await tableRows<{ shopId: string | null }>(
          t.app,
          `SELECT "shopId" FROM "ChatChannel" WHERE id = :channelId`,
          { channelId },
        )
      )[0]?.shopId;
    const notNull = async () =>
      (
        await tableRows<{ nullable: string }>(
          t.app,
          `SELECT is_nullable AS nullable FROM information_schema.columns WHERE table_name = 'ChatChannel' AND column_name = 'shopId' AND table_schema = current_schema()`,
        )
      )[0].nullable;

    it("S24 AS-57: a channel gets its product's shop; a legacy seller without a shop gets one; a gone product is skipped; a second run changes nothing", async () => {
      const lookup = t.app.get<ProductLookup>(PORTS.ProductLookup);
      const original = lookup.findMany.bind(lookup);
      try {
        const w = await seedWorld(t);
        const withShop = await openChannel(t, w);
        const legacyOwner = await t.user();
        const legacyProduct = await createProduct(t.app, w.shop, {});
        const legacy = await openChannel(t, {
          ...w,
          owner: w.owner,
          product: legacyProduct,
        });
        const goneProduct = await createProduct(t.app, w.shop, {});
        const gone = await openChannel(t, {
          ...w,
          owner: w.owner,
          product: goneProduct,
        });

        await legacyState();
        await run(
          t.app,
          `UPDATE "ChatChannel" SET "shopId" = NULL WHERE id IN (:ids)`,
          { ids: [withShop.id, legacy.id, gone.id] },
        );
        await run(
          t.app,
          `UPDATE "ChatChannel" SET "sellerId" = :seller WHERE id = :id`,
          { seller: legacyOwner.id, id: legacy.id },
        );
        await run(t.app, `DELETE FROM "Product" WHERE id = :id`, {
          id: goneProduct.id,
        });
        await sealLegacy();
        // a product that predates shops: the catalog answers it without a shop (its own column is NOT NULL now, and a
        // spec does not change another owner's schema)
        lookup.findMany = async (ids) => {
          const found = await original(ids);
          const p = found.get(legacyProduct.id);
          if (p) found.set(legacyProduct.id, { ...p, shopId: null });
          return found;
        };

        const first = await service().run();
        expect(first).toMatchObject({ updated: 2, skipped: 1 });
        expect(await shopOf(withShop.id)).toBe(w.shop.id);
        const provisioned = await shopOf(legacy.id);
        expect(provisioned).toBeTruthy();
        expect(provisioned).not.toBe(w.shop.id);
        expect(await shopOf(gone.id)).toBeNull();
        // the legacy seller owns the shop that was provisioned for them
        expect(
          (
            await t.app
              .get(ShopProvisioningService)
              .ensureShopsForLegacySellers([legacyOwner.id])
          ).get(legacyOwner.id),
        ).toBe(provisioned);

        const second = await service().run();
        expect(second).toMatchObject({ updated: 0, skipped: 1 });
        expect(await shopOf(withShop.id)).toBe(w.shop.id);
        expect(await shopOf(legacy.id)).toBe(provisioned);
      } finally {
        lookup.findMany = original;
        await restoreState();
      }
    });

    it('S24 AS-57: batches are at most 200 channels; when none is left the shop becomes required and a channel without one is refused', async () => {
      try {
        const w = await seedWorld(t);
        await legacyState();
        // 205 products of the shop, one legacy channel each
        const products: Awaited<ReturnType<typeof createProduct>>[] = [];
        for (let i = 0; i < 205; i++)
          products.push(await createProduct(t.app, w.shop, {}));
        for (const p of products) {
          await run(
            t.app,
            `INSERT INTO "ChatChannel" (id, "productId", "sellerId", "shopId", title, "isArchived", "lastSeq", "activeMemberCount", "deleteEpoch", "createdAt", "updatedAt")
             VALUES (uuidv7(), :product, :seller, NULL, 'legacy', false, 0, 0, 0, now(), now())`,
            { product: p.id, seller: w.owner.id },
          );
        }
        await sealLegacy();
        const one = await service().runBatch();
        expect(one).toMatchObject({ updated: 200, skipped: 0 });
        expect(await notNull()).toBe('YES');
        const rest = await service().run();
        expect(rest.remaining).toBe(0);
        expect(await notNull()).toBe('NO');
        await expect(
          run(
            t.app,
            `INSERT INTO "ChatChannel" (id, "productId", "sellerId", title, "createdAt", "updatedAt") VALUES (uuidv7(), :p, :s, 'no shop', now(), now())`,
            { p: newId(), s: w.owner.id },
          ),
        ).rejects.toThrow();
      } finally {
        await run(t.app, `DELETE FROM "ChatChannel" WHERE title = 'legacy'`);
        await restoreState();
      }
    });

    it('S24 AS-57: the job type takes no payload and is declared', async () => {
      await expect(
        t.app.get(JobsService).upsertSchedule({
          name: 'chat.backfill-shops-bad',
          cron: '0 */10 * * * *',
          jobType: 'chat.backfill-shops',
          payload: { x: 1 } as never,
          overlap: 'skip',
        }),
      ).rejects.toThrow();
    });
  });

  describe('isolation and the gateway (AS-58)', () => {
    it("S24 AS-58: the gateway's three statements still work against the final schema and the message gets its sequence and event", async () => {
      const w = await seedWorld(t);
      const channel = await openChannel(t, w);
      const user = await t.user();
      const memberId = newId();
      // 1. create a membership on first contact (db.rs ensure_membership)
      const [member] = await tableRows<{ role: string; status: string }>(
        t.app,
        `INSERT INTO "ChatChannelMember" ("id", "channelId", "userId", "role", "status", "createdAt", "updatedAt")
         VALUES (:id, :channelId, :userId, 'MEMBER', 'ACTIVE', now(), now())
         ON CONFLICT ("channelId", "userId") DO UPDATE SET "updatedAt" = EXCLUDED."updatedAt"
         RETURNING "role"::text AS role, "status"::text AS status`,
        { id: memberId, channelId: channel.id, userId: user.id },
      );
      expect(member).toEqual({ role: 'MEMBER', status: 'ACTIVE' });
      const [{ n }] = await tableRows<{ n: number }>(
        t.app,
        `SELECT "activeMemberCount" AS n FROM "ChatChannel" WHERE id = :id`,
        { id: channel.id },
      );
      expect(n).toBe(2);
      // 2. insert a message without a sequence or client id (db.rs insert_message)
      const [message] = await tableRows<{ id: string }>(
        t.app,
        `INSERT INTO "ChatMessage" ("id", "channelId", "authorId", "body", "replyToId", "createdAt")
         VALUES (uuidv7(), :channelId, :userId, 'via gateway', NULL, now()) RETURNING "id"`,
        { channelId: channel.id, userId: user.id },
      );
      const [stored] = await tableRows<{ seq: string }>(
        t.app,
        `SELECT seq FROM "ChatMessage" WHERE id = :id`,
        { id: message.id },
      );
      expect(stored.seq).toBe('1');
      expect(
        await tableRows(
          t.app,
          `SELECT 1 FROM "Outbox" WHERE "type" = 'chat.message_posted' AND payload->'payload'->>'messageId' = :id`,
          { id: message.id },
        ),
      ).toHaveLength(1);
      // 3. update the last-read time (db.rs update_last_read)
      await run(
        t.app,
        `UPDATE "ChatChannelMember" SET "lastReadAt" = now() WHERE "channelId" = :channelId AND "userId" = :userId`,
        { channelId: channel.id, userId: user.id },
      );
      expect(
        (
          await tableRows<{ at: Date | null }>(
            t.app,
            `SELECT "lastReadAt" AS at FROM "ChatChannelMember" WHERE "channelId" = :channelId AND "userId" = :userId`,
            { channelId: channel.id, userId: user.id },
          )
        )[0].at,
      ).not.toBeNull();
    });

    it('S24 AS-58: the public entry point exports modules, rate-limit policies and event definitions, and no model or infrastructure class', () => {
      expect(Object.keys(barrel).sort()).toEqual([
        'ChatMessageEscalated',
        'ChatMessagePosted',
        'ChatModule',
        'ChatOfflineWorkerModule',
        'ChatProjectorModule',
        'ChatSyncModule',
        'ChatTopicsModule',
        'chatRatePolicies',
      ]);
    });

    it('S24 AS-58: no source file of the domain names a table of another owner', () => {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((f) => {
          const p = join(dir, f);
          return statSync(p).isDirectory()
            ? f === 'testing'
              ? []
              : walk(p)
            : /\.ts$/.test(f) && !/\.(e2e-)?spec\.ts$/.test(f)
              ? [p]
              : [];
        });
      const foreign =
        /(FROM|JOIN|INTO|UPDATE)\s+"(User|Shop|ShopMembership|Product|Order|BisOrder|Outbox)"/;
      const offenders = walk(__dirname).filter((f) =>
        foreign.test(readFileSync(f, 'utf8')),
      );
      expect(offenders).toEqual([]);
    });
  });
});

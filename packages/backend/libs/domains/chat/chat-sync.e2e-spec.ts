import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { inParallel } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { NotificationRouter } from '@app/domains/notifications';
import { ChatSyncModule } from './chat-sync.module';
import { ChatOfflineWorkerModule } from './chat-offline-worker.module';
import { ChatSyncService } from './application/chat-sync.service';
import { ChatOfflineWorker } from './infra/chat-offline';

/** SD-14 against real Postgres (trigger-assigned seqs) + Redis + ElasticMQ. */
describe('Chat sync, receipts, presence, offline push (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let db: Sequelize;
  let chat: ChatSyncService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [ChatSyncModule, ChatOfflineWorkerModule, SeedsModule],
      { stores: ['redis', 'cassandra', 'sqs'] },
    );
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    db = app.get(getConnectionToken());
    chat = app.get(ChatSyncService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
  });

  /** Seller + buyer in a product channel. */
  const channel = async () => {
    const [seller, buyer] = await seeds.createTreelike([
      { __type__: TableName.User },
      { __type__: TableName.User },
    ]);
    const [product] = await seeds.createTreelike([
      { __type__: TableName.Product, title: 'iPhone 17' },
    ]);
    const channelId = v4();
    await db.query(
      `INSERT INTO "ChatChannel" (id, "productId", "sellerId", title, "isArchived", "createdAt", "updatedAt") VALUES (:channelId, :productId, :sellerId, 'iPhone 17', false, now(), now());
       INSERT INTO "ChatChannelMember" (id, "channelId", "userId", role, status, "createdAt", "updatedAt") VALUES
         (:m1, :channelId, :sellerId, 'OWNER', 'ACTIVE', now(), now()), (:m2, :channelId, :buyerId, 'MEMBER', 'ACTIVE', now(), now())`,
      {
        replacements: {
          channelId,
          productId: product.id,
          sellerId: seller.id,
          buyerId: buyer.id,
          m1: v4(),
          m2: v4(),
        },
      },
    );
    return {
      channelId,
      seller: seller.id as string,
      buyer: buyer.id as string,
    };
  };

  /** Exactly the statement the Rust gateway runs (packages/hft-platform/src/db.rs) - no seq supplied. */
  const rustInsert = (channelId: string, authorId: string, body: string) =>
    db.query(
      `INSERT INTO "ChatMessage" (id, "channelId", "authorId", body, "replyToId", "createdAt") VALUES (uuidv7(), :channelId, :authorId, :body, NULL, now())`,
      {
        replacements: { channelId, authorId, body },
      },
    );

  it('the database assigns gap-free per-channel seqs even for concurrent Rust inserts, and emits outbox events', async () => {
    const { channelId, seller } = await channel();
    await inParallel(20, (i) => rustInsert(channelId, seller, `m${i}`));
    const seqs = (
      await db.query<{ seq: string }>(
        `SELECT seq FROM "ChatMessage" WHERE "channelId" = :channelId ORDER BY seq`,
        { type: QueryTypes.SELECT, replacements: { channelId } },
      )
    ).map((r) => Number(r.seq));
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const [{ count }] = await db.query<{ count: string }>(
      `SELECT count(*) FROM "Outbox" WHERE "eventName" = 'chat.message_posted' AND "aggregateId" = :channelId`,
      { type: QueryTypes.SELECT, replacements: { channelId } },
    );
    expect(Number(count)).toBe(20);
  });

  it('sync returns exactly what the client missed: tail cache for small gaps, DB for large ones', async () => {
    const { channelId, seller, buyer } = await channel();
    for (let i = 1; i <= 5; i++) await rustInsert(channelId, seller, `m${i}`);

    const [small] = await chat.sync(buyer, { [channelId]: 3 });
    expect(small.messages.map((m) => [m.seq, m.body])).toEqual([
      [4, 'm4'],
      [5, 'm5'],
    ]);
    expect(small.lastSeq).toBe(5);

    for (let i = 6; i <= 80; i++) await rustInsert(channelId, seller, `m${i}`);
    const [large] = await chat.sync(buyer, { [channelId]: 2 });
    expect(large.messages.map((m) => m.seq)).toEqual(
      Array.from({ length: 78 }, (_, i) => i + 3),
    );
    expect(large.hasMore).toBe(false);

    // Non-members get nothing back for that channel (no existence leak either).
    const [outsider] = await seeds.createTreelike([
      { __type__: TableName.User },
    ]);
    expect(await chat.sync(outsider.id, { [channelId]: 0 })).toEqual([]);
  });

  it('HTTP send is idempotent per clientMessageId; someone else reusing the id gets 403', async () => {
    const { channelId, seller, buyer } = await channel();
    const clientMessageId = v4();
    const first = await chat.send(
      channelId,
      buyer,
      'Is it unlocked?',
      clientMessageId,
    );
    const retry = await chat.send(
      channelId,
      buyer,
      'Is it unlocked?',
      clientMessageId,
    );
    expect(retry).toMatchObject({
      duplicate: true,
      message: { id: first.message.id, seq: first.message.seq },
    });
    await expect(
      chat.send(channelId, seller, 'hijack', clientMessageId),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('read state is monotonic and capped; unread = lastSeq − lastReadSeq', async () => {
    const { channelId, seller, buyer } = await channel();
    for (let i = 1; i <= 5; i++) await rustInsert(channelId, seller, `m${i}`);
    expect(await chat.markRead(channelId, buyer, 3)).toEqual({
      lastReadSeq: 3,
      unread: 2,
    });
    expect(await chat.markRead(channelId, buyer, 1)).toEqual({
      lastReadSeq: 3,
      unread: 2,
    }); // stale tab
    expect(await chat.markRead(channelId, buyer, 999)).toEqual({
      lastReadSeq: 5,
      unread: 0,
    }); // capped
    expect(
      (await chat.unread(seller)).find((c) => c.channelId === channelId),
    ).toMatchObject({ unread: 5 });
  });

  it('offline push: only unread + offline recipients, coalesced per channel', async () => {
    const { channelId, seller, buyer } = await channel();
    await rustInsert(channelId, seller, 'Yes, unlocked');
    const dispatch = jest
      .spyOn(app.get(NotificationRouter), 'dispatch')
      .mockResolvedValue();
    const worker = app.get(ChatOfflineWorker);
    const check = (seq: number) =>
      worker.check({
        body: {
          channelId,
          messageId: v4(),
          seq,
          authorId: seller,
          recipientId: buyer,
          preview: 'Yes, unlocked',
        },
      });

    expect(await check(1)).toBe('notified');
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'chat.message',
        userId: buyer,
        data: expect.objectContaining({ channelId, preview: 'Yes, unlocked' }),
      }),
    ]);
    expect(await check(1)).toBe('coalesced');

    await chat.markRead(channelId, buyer, 1);
    expect(await check(1)).toBe('read');

    await rustInsert(channelId, seller, 'Still there?');
    await chat.heartbeat(buyer);
    expect(await check(2)).toBe('online');
  });
});

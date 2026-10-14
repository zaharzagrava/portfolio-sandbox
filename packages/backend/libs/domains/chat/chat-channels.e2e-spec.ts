import { chatChannelSchema } from '@marketplace-sandbox/contracts';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  addShopMember,
  clearRateLimits,
  createChatApp,
  exec,
  joinedBuyer,
  newId,
  openChannel,
  rows,
  seedWorld,
  type ChatTestApp,
  type ChatWorld,
} from './testing/chat-app';

const T = new Date('2026-10-14T12:00:00.000Z');
const REPEATS = 20;

describe('Product chat: channels, membership and access', () => {
  let t: ChatTestApp;

  beforeAll(async () => {
    t = await createChatApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    await clearRateLimits(t.app);
    await t.setTime(T);
  });

  const create = (user: Parameters<ChatTestApp['as']>[0], body: unknown) =>
    t
      .as(user)
      .post('/api/chat/channels')
      .send(body as object);
  const channelRows = (productId: string) =>
    rows<{
      id: string;
      lastSeq: string;
      sellerId: string;
      shopId: string;
      title: string;
    }>(
      t.app,
      `SELECT id, "lastSeq", "sellerId", "shopId", title FROM "ChatChannel" WHERE "productId" = :productId`,
      { productId },
    );
  const members = (channelId: string) =>
    rows<{ userId: string; role: string; status: string; lastReadSeq: string }>(
      t.app,
      `SELECT "userId", role::text AS role, status::text AS status, "lastReadSeq" FROM "ChatChannelMember" WHERE "channelId" = :channelId ORDER BY "createdAt"`,
      { channelId },
    );
  const world = (title = 'Phone 17'): Promise<ChatWorld> =>
    seedWorld(t, { title });

  describe('create (AS-01 to AS-04)', () => {
    it('S24 AS-01: shop staff open the chat; the shop comes from the product, the creator is OWNER, the title defaults to the product title', async () => {
      const w = await world('Phone 17');
      const res = await create(w.owner, { productId: w.product.id });
      expect(res.status).toBe(201);
      const body = chatChannelSchema.parse(res.body);
      expect(body).toMatchObject({
        productId: w.product.id,
        shopId: w.shop.id,
        sellerId: w.owner.id,
        title: 'Phone 17',
        isArchived: false,
        archivedAt: null,
        myRole: 'OWNER',
      });
      const stored = await channelRows(w.product.id);
      expect(stored).toHaveLength(1);
      expect(Number(stored[0].lastSeq)).toBe(0);
      expect(await members(body.id)).toEqual([
        {
          userId: w.owner.id,
          role: 'OWNER',
          status: 'ACTIVE',
          lastReadSeq: '0',
        },
      ]);
    });

    it('S24 AS-01: a title in the request wins over the product title', async () => {
      const w = await world();
      const res = await create(w.owner, {
        productId: w.product.id,
        title: 'Ask about the phone',
      });
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Ask about the phone');
    });

    it('S24 AS-01: a member of the shop with products.write who is not the owner may open it too', async () => {
      const w = await world();
      const staff = await addShopMember(t, w.shop.id, 'STAFF');
      const res = await create(staff, { productId: w.product.id });
      expect(res.status).toBe(201);
      expect(res.body.sellerId).toBe(staff.id);
      expect(res.body.myRole).toBe('OWNER');
    });

    it('S24 AS-02: no credentials is 401; a stranger, a member without products.write and a member of another shop are 403 permission_denied and nothing is stored', async () => {
      const w = await world();
      const stranger = await t.user();
      const viewer = await addShopMember(t, w.shop.id, 'VIEWER');
      const otherOwner = await t.user();
      await createShop(t.app, otherOwner);

      expect(
        (
          await t
            .http()
            .post('/api/chat/channels')
            .send({ productId: w.product.id })
        ).status,
      ).toBe(401);
      for (const user of [stranger, viewer, otherOwner]) {
        const res = await create(user, { productId: w.product.id });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('permission_denied');
      }
      expect(await channelRows(w.product.id)).toHaveLength(0);
    });

    it('S24 AS-02: an unknown product is 404 product_not_found', async () => {
      const w = await world();
      const res = await create(w.owner, { productId: newId() });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('product_not_found');
    });

    it('S24 AS-03: a second channel for the product is 409 channel_exists and the first is untouched', async () => {
      const w = await world();
      const first = await openChannel(t, w, 'First');
      const again = await create(w.owner, {
        productId: w.product.id,
        title: 'Second',
      });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('channel_exists');
      const stored = await channelRows(w.product.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ id: first.id, title: 'First' });
    });

    it(`S24 AS-03: two staff creating at once give exactly one 201 and one 409 channel_exists, one row and one OWNER (${REPEATS} repeats)`, async () => {
      for (let i = 0; i < REPEATS; i++) {
        const w = await world();
        const staff = await addShopMember(t, w.shop.id, 'STAFF');
        const results = await Promise.all([
          create(w.owner, { productId: w.product.id }),
          create(staff, { productId: w.product.id }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(results.find((r) => r.status === 409)!.body.code).toBe(
          'channel_exists',
        );
        const stored = await channelRows(w.product.id);
        expect(stored).toHaveLength(1);
        const owners = (await members(stored[0].id)).filter(
          (m) => m.role === 'OWNER',
        );
        expect(owners).toHaveLength(1);
        expect(await members(stored[0].id)).toHaveLength(1);
      }
    });

    it.each<[string, (productId: string) => object]>([
      ['no productId', () => ({})],
      ['productId not a UUID', () => ({ productId: 'nope' })],
      ['empty title', (productId) => ({ productId, title: '' })],
      [
        'title of 121 characters',
        (productId) => ({ productId, title: 'x'.repeat(121) }),
      ],
      ['title not a string', (productId) => ({ productId, title: 5 })],
      ['unknown field', (productId) => ({ productId, extra: true })],
    ])(
      'S24 AS-04: %s is 400 validation_failed and nothing is stored',
      async (_label, payload) => {
        const w = await world();
        const res = await create(w.owner, payload(w.product.id));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await channelRows(w.product.id)).toHaveLength(0);
      },
    );

    it('S24 AS-04: an ARCHIVED product is 409 product_archived', async () => {
      const w = await world();
      const archived = await createProduct(t.app, w.shop, {
        status: 'ARCHIVED',
      });
      const res = await create(w.owner, { productId: archived.id });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('product_archived');
      expect(await channelRows(archived.id)).toHaveLength(0);
    });
  });

  describe('join (AS-05, AS-06)', () => {
    it('S24 AS-05: a buyer joins as MEMBER and starts at the channel sequence, with no backlog', async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      await exec(
        t.app,
        `UPDATE "ChatChannel" SET "lastSeq" = 7 WHERE id = :id`,
        { id: channel.id },
      );
      const buyer = await t.user();
      const res = await t
        .as(buyer)
        .post(`/api/chat/channels/${channel.id}/join`);
      expect(res.status).toBe(200);
      expect(chatChannelSchema.parse(res.body).myRole).toBe('MEMBER');
      expect(
        (await members(channel.id)).find((m) => m.userId === buyer.id),
      ).toEqual({
        userId: buyer.id,
        role: 'MEMBER',
        status: 'ACTIVE',
        lastReadSeq: '7',
      });
    });

    it(`S24 AS-05: joining again, or ten joins at once, is 200 every time with one row and an unchanged position (${REPEATS} repeats)`, async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      await exec(
        t.app,
        `UPDATE "ChatChannel" SET "lastSeq" = 7 WHERE id = :id`,
        { id: channel.id },
      );
      for (let i = 0; i < REPEATS; i++) {
        const buyer = await t.user();
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            t.as(buyer).post(`/api/chat/channels/${channel.id}/join`),
          ),
        );
        expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
        const mine = (await members(channel.id)).filter(
          (m) => m.userId === buyer.id,
        );
        expect(mine).toHaveLength(1);
        expect(mine[0].lastReadSeq).toBe('7');
        expect(mine[0].role).toBe('MEMBER');
      }
    });

    it('S24 AS-05: a repeated join never overwrites role, status or read position', async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      const buyer = await joinedBuyer(t, channel.id);
      await exec(
        t.app,
        `UPDATE "ChatChannel" SET "lastSeq" = 9 WHERE id = :id`,
        { id: channel.id },
      );
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET role = 'MODERATOR', "lastReadSeq" = 4 WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: buyer.id },
      );
      const res = await t
        .as(buyer)
        .post(`/api/chat/channels/${channel.id}/join`);
      expect(res.status).toBe(200);
      expect(res.body.myRole).toBe('MODERATOR');
      expect(
        (await members(channel.id)).find((m) => m.userId === buyer.id),
      ).toMatchObject({
        role: 'MODERATOR',
        lastReadSeq: '4',
      });
    });

    it('S24 AS-06: a banned member is 403 banned and stays BANNED', async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      const buyer = await joinedBuyer(t, channel.id);
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        {
          id: channel.id,
          userId: buyer.id,
        },
      );
      const res = await t
        .as(buyer)
        .post(`/api/chat/channels/${channel.id}/join`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('banned');
      expect(
        (await members(channel.id)).find((m) => m.userId === buyer.id)!.status,
      ).toBe('BANNED');
    });

    it('S24 AS-06: an archived channel is 409 channel_archived and no membership is created', async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      await exec(
        t.app,
        `UPDATE "ChatChannel" SET "isArchived" = true, "archivedAt" = now() WHERE id = :id`,
        { id: channel.id },
      );
      const buyer = await t.user();
      const res = await t
        .as(buyer)
        .post(`/api/chat/channels/${channel.id}/join`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('channel_archived');
      expect(
        (await members(channel.id)).filter((m) => m.userId === buyer.id),
      ).toHaveLength(0);
    });

    it('S24 AS-06: an unknown channel is 404, a malformed ID 400 validation_failed, no credentials 401', async () => {
      const buyer = await t.user();
      const unknown = await t
        .as(buyer)
        .post(`/api/chat/channels/${newId()}/join`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('channel_not_found');
      const bad = await t.as(buyer).post('/api/chat/channels/not-a-uuid/join');
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('validation_failed');
      expect(
        (await t.http().post(`/api/chat/channels/${newId()}/join`)).status,
      ).toBe(401);
    });
  });

  describe('read (AS-07)', () => {
    it('S24 AS-07: a member reads the channel by id with their role; a stranger gets 404 channel_not_found', async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      const buyer = await joinedBuyer(t, channel.id);
      const stranger = await t.user();

      const own = await t.as(w.owner).get(`/api/chat/channels/${channel.id}`);
      expect(own.status).toBe(200);
      expect(chatChannelSchema.parse(own.body).myRole).toBe('OWNER');
      expect(
        (await t.as(buyer).get(`/api/chat/channels/${channel.id}`)).body.myRole,
      ).toBe('MEMBER');

      const denied = await t
        .as(stranger)
        .get(`/api/chat/channels/${channel.id}`);
      expect(denied.status).toBe(404);
      expect(denied.body.code).toBe('channel_not_found');
      const unknown = await t.as(stranger).get(`/api/chat/channels/${newId()}`);
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({
        code: 'channel_not_found',
        title: denied.body.title,
        detail: denied.body.detail,
      });
    });

    it('S24 AS-07: a banned member does not read the channel by id either', async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      const buyer = await joinedBuyer(t, channel.id);
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        {
          id: channel.id,
          userId: buyer.id,
        },
      );
      expect(
        (await t.as(buyer).get(`/api/chat/channels/${channel.id}`)).status,
      ).toBe(404);
    });

    it('S24 AS-07: discovery by product is open to any signed-in user with only the public fields and myRole null', async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      const stranger = await t.user();
      const res = await t
        .as(stranger)
        .get(`/api/chat/channels/by-product/${w.product.id}`);
      expect(res.status).toBe(200);
      const body = chatChannelSchema.parse(res.body);
      expect(body).toMatchObject({ id: channel.id, myRole: null });
      expect(Object.keys(res.body).sort()).toEqual([
        'archivedAt',
        'createdAt',
        'id',
        'isArchived',
        'myRole',
        'productId',
        'sellerId',
        'shopId',
        'title',
        'updatedAt',
      ]);
      const member = await t
        .as(w.owner)
        .get(`/api/chat/channels/by-product/${w.product.id}`);
      expect(member.body.myRole).toBe('OWNER');
      expect(
        (await t.http().get(`/api/chat/channels/by-product/${w.product.id}`))
          .status,
      ).toBe(401);
    });

    it('S24 AS-07: discovery answers 404 channel_not_found for a product without a channel and 400 for a malformed ID', async () => {
      const w = await world();
      const user = await t.user();
      const none = await t
        .as(user)
        .get(`/api/chat/channels/by-product/${w.product.id}`);
      expect(none.status).toBe(404);
      expect(none.body.code).toBe('channel_not_found');
      const bad = await t.as(user).get('/api/chat/channels/by-product/nope');
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('validation_failed');
      expect((await t.as(user).get('/api/chat/channels/nope')).status).toBe(
        400,
      );
    });
  });

  describe('update and archive (AS-08)', () => {
    const patch = (
      user: Parameters<ChatTestApp['as']>[0],
      channelId: string,
      body: unknown,
    ) =>
      t
        .as(user)
        .patch(`/api/chat/channels/${channelId}`)
        .send(body as object);

    it('S24 AS-08: staff rename the channel', async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      const res = await patch(w.owner, channel.id, { title: 'New title' });
      expect(res.status).toBe(200);
      expect(chatChannelSchema.parse(res.body)).toMatchObject({
        title: 'New title',
        isArchived: false,
        archivedAt: null,
      });
    });

    it('S24 AS-08: archive sets archivedAt from the clock and publishes channel_archived after commit; unarchive clears it', async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      const archived = await patch(w.owner, channel.id, { isArchived: true });
      expect(archived.status).toBe(200);
      expect(archived.body).toMatchObject({
        isArchived: true,
        archivedAt: T.toISOString(),
      });
      expect(t.live.eventsOf(channel.id, 'channel_archived')).toEqual([
        { type: 'channel_archived', channelId: channel.id },
      ]);

      const restored = await patch(w.owner, channel.id, { isArchived: false });
      expect(restored.status).toBe(200);
      expect(restored.body).toMatchObject({
        isArchived: false,
        archivedAt: null,
      });
      expect(t.live.eventsOf(channel.id, 'channel_archived')).toHaveLength(1);
    });

    it('S24 AS-08: repeating a state is 409 invalid_transition and changes nothing', async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      const again = await patch(w.owner, channel.id, { isArchived: false });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('invalid_transition');
      await patch(w.owner, channel.id, { isArchived: true });
      const twice = await patch(w.owner, channel.id, { isArchived: true });
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('invalid_transition');
      expect(t.live.eventsOf(channel.id, 'channel_archived')).toHaveLength(1);
    });

    it(`S24 AS-08: two archives at once give one 200 and one 409 invalid_transition, one event (${REPEATS} repeats)`, async () => {
      for (let i = 0; i < REPEATS; i++) {
        const w = await world();
        const staff = await addShopMember(t, w.shop.id, 'STAFF');
        const channel = await openChannel(t, w);
        const results = await Promise.all([
          patch(w.owner, channel.id, { isArchived: true }),
          patch(staff, channel.id, { isArchived: true }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(results.find((r) => r.status === 409)!.body.code).toBe(
          'invalid_transition',
        );
        expect(t.live.eventsOf(channel.id, 'channel_archived')).toHaveLength(1);
      }
    });

    it('S24 AS-08: a member without manager authority is 403 permission_denied, a stranger 404 channel_not_found', async () => {
      const w = await world();
      const channel = await openChannel(t, w);
      const buyer = await joinedBuyer(t, channel.id);
      const stranger = await t.user();
      const denied = await patch(buyer, channel.id, { title: 'Mine now' });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('permission_denied');
      const hidden = await patch(stranger, channel.id, { title: 'Mine now' });
      expect(hidden.status).toBe(404);
      expect(hidden.body.code).toBe('channel_not_found');
      expect(
        (await t.as(w.owner).get(`/api/chat/channels/${channel.id}`)).body
          .title,
      ).toBe(channel.title);
    });

    it.each([
      ['an empty title', { title: '' }],
      ['a title of 121 characters', { title: 'x'.repeat(121) }],
      ['an empty body', {}],
      ['an unknown field', { title: 'ok', extra: 1 }],
      ['isArchived not a boolean', { isArchived: 'yes' }],
    ])('S24 AS-08: %s is 400 validation_failed', async (_label, body) => {
      const w = await world();
      const channel = await openChannel(t, w);
      const res = await patch(w.owner, channel.id, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });
  });
});

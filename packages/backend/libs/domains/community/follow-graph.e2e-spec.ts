import { Sequelize } from 'sequelize-typescript';
import { v4 as uuidv4 } from 'uuid';
import {
  followStatusSchema,
  followingPageSchema,
} from '@marketplace-sandbox/contracts';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { FeedReconcileService } from './application/feed-reconcile.service';
import {
  createFeedApp,
  type FeedTestApp,
  type TestUser,
} from './testing/feed-fixtures';

/**
 * S26 US1: follow graph (AS-01..AS-12, AS-51). Real HTTP pipeline, real PostgreSQL (sessions, shops), ScyllaDB and Redis.
 * Every response is parsed with the contract schemas; every test also asserts the persisted rows of both directions and
 * the counters.
 */
describe('Follow graph: follow, unfollow, limits and privacy', () => {
  let t: FeedTestApp;

  beforeAll(async () => {
    t = await createFeedApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  // ---- persisted state ------------------------------------------------------------------------------------------
  const buyerRow = async (user: TestUser, accountId: string) =>
    (
      await t.cql(
        'SELECT active, rel_ts, followed_at FROM following_by_user WHERE user_id = ? AND account_id = ?',
        [user.id, accountId],
      )
    ).first();
  const activeRelation = async (user: TestUser, accountId: string) => {
    const row = await buyerRow(user, accountId);
    return !!row && row.active !== false;
  };
  const followerRows = async (accountId: string) =>
    (
      await t.cql(
        'SELECT follower_id, followed_at FROM followers_by_account WHERE account_id = ?',
        [accountId],
      )
    ).rows;
  const timeRows = async (user: TestUser) =>
    (
      await t.cql(
        'SELECT account_id, followed_at FROM following_by_time WHERE user_id = ?',
        [user.id],
      )
    ).rows;
  const storedCount = async (accountId: string) => {
    const row = (
      await t.cql(
        'SELECT followers FROM follower_counts WHERE account_id = ?',
        [accountId],
      )
    ).first();
    return row ? Number(row.followers) : 0;
  };
  const reservation = async (user: TestUser) => {
    const row = (
      await t.cql('SELECT n FROM following_counts WHERE user_id = ?', [user.id])
    ).first();
    return row ? Number(row.n) : 0;
  };
  const status = async (user: TestUser, ids: string[]) =>
    followStatusSchema.parse(
      (await t.followStatus(user, ids).expect(200)).body,
    );
  const listed = async (user: TestUser) =>
    followingPageSchema.parse((await t.following(user).expect(200)).body);

  /** Both directions and the list index agree on whether `user` follows `accountId`. */
  const expectAgreement = async (
    user: TestUser,
    accountId: string,
    expected: boolean,
  ) => {
    expect(await activeRelation(user, accountId)).toBe(expected);
    expect(
      (await followerRows(accountId)).some(
        (r) => r.follower_id.toString() === user.id,
      ),
    ).toBe(expected);
    expect((await timeRows(user)).some((r) => r.account_id === accountId)).toBe(
      expected,
    );
  };

  describe('follow', () => {
    it('S26 AS-01: following a shop is 204 with no body; the list, both directions and the count show it', async () => {
      const [user] = await t.users(1);
      const shop = await t.seedShop();

      const res = await t.follow(user, shop.accountId).expect(204);
      expect(res.text).toBe('');

      const page = await listed(user);
      expect(page.items).toEqual([
        {
          accountId: shop.accountId,
          followedAt: t.clock.now().toISOString(),
        },
      ]);
      expect(page.nextCursor).toBeNull();
      await expectAgreement(user, shop.accountId, true);
      expect(await followerRows(shop.accountId)).toHaveLength(1);
      expect(await storedCount(shop.accountId)).toBe(1);
      expect(await reservation(user)).toBe(1);
      expect(await status(user, [shop.accountId])).toEqual([
        { accountId: shop.accountId, following: true, followerCount: 1 },
      ]);
    });

    it('S26 AS-02: following again is 204; followedAt and the count do not change', async () => {
      const [user] = await t.users(1);
      const shop = await t.seedShop();
      await t.follow(user, shop.accountId).expect(204);
      const first = (await listed(user)).items[0].followedAt;

      t.clock.advance(5_000);
      await t.follow(user, shop.accountId).expect(204);

      expect((await listed(user)).items).toEqual([
        { accountId: shop.accountId, followedAt: first },
      ]);
      expect(await storedCount(shop.accountId)).toBe(1);
      expect(await followerRows(shop.accountId)).toHaveLength(1);
      expect(await reservation(user)).toBe(1);
    });

    it('S26 AS-03: 20 concurrent identical follows are all 204 and leave one relation per direction and a count of 1', async () => {
      const [user] = await t.users(1);
      const shop = await t.seedShop();

      const results = await Promise.all(
        Array.from({ length: 20 }, () => t.follow(user, shop.accountId)),
      );

      expect(results.map((r) => r.status)).toEqual(Array(20).fill(204));
      await expectAgreement(user, shop.accountId, true);
      expect(await followerRows(shop.accountId)).toHaveLength(1);
      expect(await timeRows(user)).toHaveLength(1);
      expect(await storedCount(shop.accountId)).toBe(1);
      expect(await reservation(user)).toBe(1);
    });

    it.each([
      ['a short id', 'shop:123'],
      ['an unknown type', `team:${uuidv4()}`],
      ['an uppercase uuid', `shop:${uuidv4().toUpperCase()}`],
      ['a 100-character string', `shop:${'a'.repeat(95)}`],
    ])(
      'S26 AS-04: %s is 400 validation_failed and nothing is stored',
      async (_label, accountId) => {
        const [user] = await t.users(1);
        const res = await t.follow(user, accountId).expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(res.headers['content-type']).toContain('problem+json');
        expect(await timeRows(user)).toHaveLength(0);
        expect(await reservation(user)).toBe(0);
      },
    );

    it('S26 AS-04: an unknown shop, an unknown user, a deleted user and a DELETING or DELETED shop are 404 account_not_found', async () => {
      const [user, gone] = await t.users(2);
      await t.app
        .get(Sequelize)
        .query('UPDATE "User" SET "deletedAt" = now() WHERE "id" = :id', {
          replacements: { id: gone.id },
        });
      const closing = await t.seedShop({ status: 'DELETING' });
      const deleted = await t.seedShop({ status: 'DELETED' });
      const cases = [
        `shop:${uuidv4()}`,
        `user:${uuidv4()}`,
        `user:${gone.id}`,
        closing.accountId,
        deleted.accountId,
      ];
      for (const accountId of cases) {
        const res = await t.follow(user, accountId).expect(404);
        expect(res.body.code).toBe('account_not_found');
        expect(res.headers['content-type']).toContain('problem+json');
        expect(await storedCount(accountId)).toBe(0);
      }
      expect(await timeRows(user)).toHaveLength(0);
      expect(await reservation(user)).toBe(0);
    });

    it('S26 AS-04: following oneself is 422 cannot_follow_self; a suspended shop and another user can be followed', async () => {
      const [user, other] = await t.users(2);
      const self = await t.follow(user, `user:${user.id}`).expect(422);
      expect(self.body.code).toBe('cannot_follow_self');
      expect(await timeRows(user)).toHaveLength(0);
      expect(await storedCount(`user:${user.id}`)).toBe(0);

      const suspended = await t.seedShop({ status: 'SUSPENDED' });
      await t.follow(user, suspended.accountId).expect(204);
      await t.follow(user, `user:${other.id}`).expect(204);
      expect((await listed(user)).items.map((i) => i.accountId).sort()).toEqual(
        [suspended.accountId, `user:${other.id}`].sort(),
      );
    });
  });

  describe('unfollow', () => {
    it('S26 AS-05: unfollowing removes both directions and the count; a repeat, a never-followed shop and a vanished shop are 204 and the count stays 0', async () => {
      const [user] = await t.users(1);
      const shop = await t.seedShop();
      await t.follow(user, shop.accountId).expect(204);
      expect(await storedCount(shop.accountId)).toBe(1);

      await t.unfollow(user, shop.accountId).expect(204);
      await expectAgreement(user, shop.accountId, false);
      expect(await storedCount(shop.accountId)).toBe(0);
      expect((await listed(user)).items).toEqual([]);
      expect(await reservation(user)).toBe(0);
      expect(await status(user, [shop.accountId])).toEqual([
        { accountId: shop.accountId, following: false, followerCount: 0 },
      ]);

      await t.unfollow(user, shop.accountId).expect(204);
      const never = await t.seedShop();
      await t.unfollow(user, never.accountId).expect(204);
      await t.unfollow(user, `shop:${uuidv4()}`).expect(204);
      expect(await storedCount(shop.accountId)).toBe(0);
      expect(await storedCount(never.accountId)).toBe(0);
      expect(await reservation(user)).toBe(0);
      expect(
        (await status(user, [shop.accountId, never.accountId])).map(
          (s) => s.followerCount,
        ),
      ).toEqual([0, 0]);

      const bad = await t.unfollow(user, 'shop:123').expect(400);
      expect(bad.body.code).toBe('validation_failed');
    });

    it('S26 AS-05: a shop deleted after the follow can still be unfollowed', async () => {
      const [user] = await t.users(1);
      const shop = await t.seedShop();
      await t.follow(user, shop.accountId).expect(204);
      await t.app
        .get(Sequelize)
        .query(`UPDATE "Shop" SET "status" = 'DELETED' WHERE "id" = :id`, {
          replacements: { id: shop.shopId },
        });
      await t.unfollow(user, shop.accountId).expect(204);
      await expectAgreement(user, shop.accountId, false);
      expect(await storedCount(shop.accountId)).toBe(0);
    });

    it('S26 AS-05: a re-follow after an unfollow is active again with a fresh followedAt and a count of 1', async () => {
      const [user] = await t.users(1);
      const shop = await t.seedShop();
      await t.follow(user, shop.accountId).expect(204);
      await t.unfollow(user, shop.accountId).expect(204);
      t.clock.advance(3_000);
      await t.follow(user, shop.accountId).expect(204);

      await expectAgreement(user, shop.accountId, true);
      expect(await timeRows(user)).toHaveLength(1);
      expect(await storedCount(shop.accountId)).toBe(1);
      expect(await reservation(user)).toBe(1);
      expect((await listed(user)).items).toEqual([
        {
          accountId: shop.accountId,
          followedAt: t.clock.now().toISOString(),
        },
      ]);
    });

    it('S26 AS-06: a follow racing an unfollow, 20 fresh pairs: all 204, the directions agree and the count equals the relations', async () => {
      const users = await t.users(20);
      const shops = await Promise.all(users.map(() => t.seedShop()));
      for (let i = 0; i < users.length; i++) {
        const [follow, unfollow] = await Promise.all([
          t.follow(users[i], shops[i].accountId),
          t.unfollow(users[i], shops[i].accountId),
        ]);
        expect([follow.status, unfollow.status]).toEqual([204, 204]);

        const present = await activeRelation(users[i], shops[i].accountId);
        await expectAgreement(users[i], shops[i].accountId, present);
        expect(await storedCount(shops[i].accountId)).toBe(present ? 1 : 0);
        expect(await reservation(users[i])).toBe(present ? 1 : 0);
      }
    });

    it('S26 AS-06: repeated follow/unfollow races on one relation always end consistent', async () => {
      const [user] = await t.users(1);
      const shop = await t.seedShop();
      // 12 rounds x 2 writes stay inside the 30-per-minute budget
      for (let round = 0; round < 12; round++) {
        t.clock.advance(1);
        await Promise.all([
          t.follow(user, shop.accountId),
          t.unfollow(user, shop.accountId),
        ]);
        const present = await activeRelation(user, shop.accountId);
        await expectAgreement(user, shop.accountId, present);
        expect(await storedCount(shop.accountId)).toBe(present ? 1 : 0);
      }
    });
  });

  describe('limit', () => {
    it('S26 AS-07: at the limit a new follow is 422 following_limit_reached {limit} and stores nothing; a re-follow is 204', async () => {
      t.config.set('feed_following_limit', 3);
      const [user] = await t.users(1);
      const shops = await Promise.all([1, 2, 3, 4].map(() => t.seedShop()));
      for (const shop of shops.slice(0, 3))
        await t.follow(user, shop.accountId).expect(204);

      const refused = await t.follow(user, shops[3].accountId).expect(422);
      expect(refused.body.code).toBe('following_limit_reached');
      expect(refused.body.limit).toBe(3);
      await expectAgreement(user, shops[3].accountId, false);
      expect(await storedCount(shops[3].accountId)).toBe(0);
      expect(await reservation(user)).toBe(3);

      await t.follow(user, shops[0].accountId).expect(204);
      expect(await reservation(user)).toBe(3);

      // unfollowing frees a slot
      await t.unfollow(user, shops[1].accountId).expect(204);
      await t.follow(user, shops[3].accountId).expect(204);
      expect((await listed(user)).items).toHaveLength(3);
    });

    it('S26 AS-07: two different follows racing for the last slot: exactly one is 204 and the other 422, repeated 10 times', async () => {
      t.config.set('feed_following_limit', 3);
      const users = await t.users(10);
      const shops = await Promise.all(
        Array.from({ length: 4 }, () => t.seedShop()),
      );
      for (const user of users) {
        await t.follow(user, shops[0].accountId).expect(204);
        await t.follow(user, shops[1].accountId).expect(204);
        const results = await Promise.all([
          t.follow(user, shops[2].accountId),
          t.follow(user, shops[3].accountId),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([204, 422]);
        expect(await timeRows(user)).toHaveLength(3);
        expect(await reservation(user)).toBe(3);
        const loser = results.find((r) => r.status === 422)!;
        expect(loser.body.code).toBe('following_limit_reached');
      }
    });
  });

  describe('authentication, rate limits and privacy', () => {
    it('S26 AS-08: every route answers 401 problem+json without credentials or with a tampered session, and changes nothing', async () => {
      const shop = await t.seedShop();
      const [user] = await t.users(1);
      const routes = [
        (r: ReturnType<FeedTestApp['http']>) =>
          r.post(`/api/follow/${shop.accountId}`),
        (r: ReturnType<FeedTestApp['http']>) =>
          r.delete(`/api/follow/${shop.accountId}`),
        (r: ReturnType<FeedTestApp['http']>) => r.get('/api/feed'),
        (r: ReturnType<FeedTestApp['http']>) => r.get('/api/me/following'),
        (r: ReturnType<FeedTestApp['http']>) =>
          r.get('/api/follow-status').query({ accountIds: shop.accountId }),
      ];
      for (const route of routes) {
        const anonymous = await route(t.http());
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers['content-type']).toContain('problem+json');
        const tampered = await route(t.http()).set(
          'Authorization',
          `${user.bearer.slice(0, -3)}abc`,
        );
        expect(tampered.status).toBe(401);
      }
      expect(await followerRows(shop.accountId)).toHaveLength(0);
      expect(await storedCount(shop.accountId)).toBe(0);
    });

    it('S26 AS-09: the 31st follow write in a minute is 429 with the rate-limit headers and stores nothing; the next minute allows a write', async () => {
      const [user] = await t.users(1);
      const shop = await t.seedShop();
      const other = await t.seedShop();
      for (let i = 0; i < 30; i++)
        await t.follow(user, shop.accountId).expect(204);

      const refused = await t.follow(user, other.accountId).expect(429);
      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      expect(refused.headers['ratelimit']).toBeDefined();
      expect(refused.headers['ratelimit-policy']).toBeDefined();
      expect(refused.headers['content-type']).toContain('problem+json');
      expect(await storedCount(other.accountId)).toBe(0);
      await expectAgreement(user, other.accountId, false);

      // unfollow shares the profile
      await t.unfollow(user, shop.accountId).expect(429);
      expect(await activeRelation(user, shop.accountId)).toBe(true);

      t.clock.advance(61_000);
      await t.follow(user, other.accountId).expect(204);
      expect(await storedCount(other.accountId)).toBe(1);
    });

    it('S26 AS-09: the 121st read in a minute is 429; the next minute allows a read', async () => {
      const [user] = await t.users(1);
      const shop = await t.seedShop();
      for (let i = 0; i < 120; i++)
        await t.followStatus(user, [shop.accountId]).expect(200);
      const refused = await t.followStatus(user, [shop.accountId]).expect(429);
      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      expect(refused.headers['ratelimit']).toBeDefined();
      expect(refused.headers['ratelimit-policy']).toBeDefined();
      t.clock.advance(61_000);
      await t.followStatus(user, [shop.accountId]).expect(200);
    });

    it('S26 AS-10: another buyer sees only their own list; the status shows the real count with following false; their unfollow changes nothing for the first buyer', async () => {
      const [a, b] = await t.users(2);
      const shop = await t.seedShop();
      await t.follow(a, shop.accountId).expect(204);

      expect((await listed(b)).items).toEqual([]);
      expect(await status(b, [shop.accountId])).toEqual([
        { accountId: shop.accountId, following: false, followerCount: 1 },
      ]);
      await t.unfollow(b, shop.accountId).expect(204);
      expect(await activeRelation(a, shop.accountId)).toBe(true);
      expect(await storedCount(shop.accountId)).toBe(1);
      const feed = await t.feed(b).expect(200);
      expect(feed.body.items).toEqual([]);
    });
  });

  describe('following list and follow status', () => {
    it('S26 AS-11: the list is newest first with an opaque cursor; invalid parameters and cursors are 400', async () => {
      const [user, other] = await t.users(2);
      const shops = await Promise.all([1, 2, 3].map(() => t.seedShop()));
      for (const shop of shops) {
        await t.follow(user, shop.accountId).expect(204);
        t.clock.advance(1_000);
      }
      const newestFirst = [...shops].reverse().map((s) => s.accountId);

      const first = followingPageSchema.parse(
        (await t.following(user, { limit: 2 }).expect(200)).body,
      );
      expect(first.items.map((i) => i.accountId)).toEqual(
        newestFirst.slice(0, 2),
      );
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = followingPageSchema.parse(
        (
          await t
            .following(user, { limit: 2, cursor: first.nextCursor! })
            .expect(200)
        ).body,
      );
      expect(second.items.map((i) => i.accountId)).toEqual(
        newestFirst.slice(2),
      );
      expect(second.nextCursor).toBeNull();

      for (const limit of ['0', '101', 'abc', '-1', '1.5']) {
        const res = await t.following(user, { limit }).expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
      const unknown = await t.following(user, { sort: 'asc' }).expect(400);
      expect(unknown.body.code).toBe('validation_failed');

      const tampered = await t
        .following(user, { cursor: `${first.nextCursor!.slice(0, -2)}xx` })
        .expect(400);
      expect(tampered.body.code).toBe('invalid_cursor');
      const garbage = await t.following(user, { cursor: 'nope' }).expect(400);
      expect(garbage.body.code).toBe('invalid_cursor');
      // a cursor is bound to its list and cannot be carried over to another buyer's request as a position
      const foreign = await t
        .following(other, { cursor: first.nextCursor! })
        .expect(200);
      expect(followingPageSchema.parse(foreign.body).items).toEqual([]);

      // the default limit serves everything for a short list
      expect((await listed(user)).items).toHaveLength(3);
    });

    it('S26 AS-12: one entry per requested id in request order; unknown ids are false/0; duplicates collapse; bad batches are 400', async () => {
      const [user, f2, f3] = await t.users(3);
      const s1 = await t.seedShop();
      const s2 = await t.seedShop();
      const unknown = `shop:${uuidv4()}`;
      for (const u of [user, f2, f3])
        await t.follow(u, s1.accountId).expect(204);
      await t.follow(f2, s2.accountId).expect(204);

      expect(await status(user, [s1.accountId, s2.accountId, unknown])).toEqual(
        [
          { accountId: s1.accountId, following: true, followerCount: 3 },
          { accountId: s2.accountId, following: false, followerCount: 1 },
          { accountId: unknown, following: false, followerCount: 0 },
        ],
      );
      expect(await status(user, [s1.accountId, s1.accountId])).toEqual([
        { accountId: s1.accountId, following: true, followerCount: 3 },
      ]);

      const tooMany = Array.from({ length: 101 }, () => `shop:${uuidv4()}`);
      expect((await t.followStatus(user, tooMany).expect(400)).body.code).toBe(
        'validation_failed',
      );
      const hundred = Array.from({ length: 100 }, () => `shop:${uuidv4()}`);
      expect(await status(user, hundred)).toHaveLength(100);
      expect(
        (await t.followStatus(user, [s1.accountId, 'shop:123']).expect(400))
          .body.code,
      ).toBe('validation_failed');
      expect((await t.followStatus(user, []).expect(400)).body.code).toBe(
        'validation_failed',
      );
    });
  });

  describe('reconciliation', () => {
    it('S26 AS-51: counts are recomputed from the follower records and half-written relations are completed from the buyer side; a second run changes nothing', async () => {
      const [u1, u2, u3, u4, u5, half, ghost] = await t.users(7);
      const shop = await t.seedShop();
      const other = await t.seedShop();
      for (const u of [u1, u2, u3, u4, u5])
        await t.follow(u, shop.accountId).expect(204);
      await t.follow(u1, other.accountId).expect(204);
      const longAgo = new Date(t.clock.nowMs() - 3_600_000);

      // drift: the stored count says 7 while 5 follower records exist
      await t.cql(
        'UPDATE follower_counts SET followers = followers + 2 WHERE account_id = ?',
        [shop.accountId],
      );
      // buyer-side only (a crash between the conditional write and the derived writes): no follower record, no list entry
      await t.cql(
        'INSERT INTO following_by_user (user_id, account_id, followed_at, active, rel_ts) VALUES (?, ?, ?, true, ?)',
        [half.id, shop.accountId, longAgo, longAgo.getTime() * 1000],
      );
      // follower-side only: a record without a buyer-side relation (a crashed unfollow) must go
      await t.cql(
        'INSERT INTO followers_by_account (account_id, follower_id, followed_at) VALUES (?, ?, ?)',
        [shop.accountId, ghost.id, longAgo],
      );
      // an index entry without a buyer-side relation
      await t.cql(
        'INSERT INTO following_by_time (user_id, followed_at, account_id) VALUES (?, ?, ?)',
        [ghost.id, longAgo, other.accountId],
      );
      // the reservation counter drifted too
      await t.cql('UPDATE following_counts SET n = 9 WHERE user_id = ?', [
        u1.id,
      ]);
      expect(await storedCount(shop.accountId)).toBe(7);

      const reconcile = t.app.get(FeedReconcileService);
      const first = await reconcile.run({ graceMs: 60_000, paceMs: 0 });
      expect(first.finished).toBe(true);

      // 5 completed relations + the half-written one the buyer side vouches for; the ghost record is gone
      expect(first.repaired).toBeGreaterThanOrEqual(6);
      expect(await storedCount(shop.accountId)).toBe(6);
      expect(await storedCount(other.accountId)).toBe(1);
      const followers = (await followerRows(shop.accountId))
        .map((r) => r.follower_id.toString())
        .sort();
      expect(followers).toEqual(
        [u1.id, u2.id, u3.id, u4.id, u5.id, half.id].sort(),
      );
      expect((await timeRows(half)).map((r) => r.account_id)).toEqual([
        shop.accountId,
      ]);
      expect(await timeRows(ghost)).toHaveLength(0);
      expect(await reservation(u1)).toBe(2);

      const snapshot = async () => ({
        count: await storedCount(shop.accountId),
        followers: (await followerRows(shop.accountId))
          .map((r) => r.follower_id.toString())
          .sort(),
        times: (await timeRows(half)).length,
        reserved: await reservation(u1),
      });
      const before = await snapshot();
      const second = await reconcile.run({ graceMs: 60_000, paceMs: 0 });
      expect(second.finished).toBe(true);
      expect(second.repaired).toBe(0);
      expect(await snapshot()).toEqual(before);
      expect(await status(u2, [shop.accountId])).toEqual([
        { accountId: shop.accountId, following: true, followerCount: 6 },
      ]);
    });
  });
});

describe('Follow graph: the limiter store is down', () => {
  let proxy: TcpFaultProxy;
  let t: FeedTestApp;

  beforeAll(async () => {
    proxy = await TcpFaultProxy.start({ host: 'localhost', port: 6400 });
    t = await createFeedApp({
      env: { REDIS_URL: `redis://127.0.0.1:${proxy.port}/${new URL(process.env.REDIS_URL ?? "redis://localhost:6400/0").pathname.slice(1) || "0"}` },
    });
  });
  afterAll(async () => {
    await t.close();
    await proxy.close();
  });

  it('S26 AS-09: follow writes fail closed with 503 rate_limiter_unavailable and store nothing; feed reads fail open', async () => {
    await t.reset();
    const [user] = await t.users(1);
    const shop = await t.seedShop();
    await t.follow(user, shop.accountId).expect(204);

    proxy.mode = 'refuse';
    try {
      const other = await t.seedShop();
      const res = await t.follow(user, other.accountId);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('rate_limiter_unavailable');

      const read = await t.followStatus(user, [
        shop.accountId,
        other.accountId,
      ]);
      expect(read.status).toBe(200);
      expect(followStatusSchema.parse(read.body)).toEqual([
        { accountId: shop.accountId, following: true, followerCount: 1 },
        { accountId: other.accountId, following: false, followerCount: 0 },
      ]);
    } finally {
      proxy.mode = 'pass';
    }
    const stored = await t.cql(
      'SELECT account_id FROM following_by_time WHERE user_id = ?',
      [user.id],
    );
    expect(stored.rows.map((r) => r.account_id)).toEqual([shop.accountId]);
  });
});

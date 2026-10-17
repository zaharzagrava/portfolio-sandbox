import { apiKeyListSchema } from '@marketplace-sandbox/contracts';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  addShopMember,
  clearRateLimits,
  createKey,
  createPublicApiKit,
  exec,
  outboxEvents,
  rows,
  type PublicApiKit,
} from './testing/public-api-kit';
import { KeyUsageFlusher } from './application/key-usage.flusher';
import { KEY_CACHE_PREFIX, LAST_USED_KEY } from './infra/redis-key-cache';

const KEYS = (shopId: string) => `/api/shops/${shopId}/developers/keys`;
const HOUR = 3_600_000;

describe('Developer platform: API key lifecycle (dashboard)', () => {
  let t: PublicApiKit;
  let pub2: Awaited<ReturnType<PublicApiKit['publicInstance']>>;

  beforeAll(async () => {
    t = await createPublicApiKit();
    pub2 = await t.publicInstance();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  /** `n` keys written straight to the table (a shop at the limit needs 24 of them, and a spec may not wait on 24 requests). */
  const seedKeys = (
    shopId: string,
    userId: string,
    n: number,
    state: { revoked?: boolean; expired?: boolean } = {},
  ) =>
    exec(
      t.app,
      `INSERT INTO "ApiKey" (id, "shopId", prefix, hash, name, scopes, livemode, "createdBy", "expiresAt", "revokedAt")
       SELECT uuidv7(), :shopId, substr(md5(random()::text || g::text || clock_timestamp()::text), 1, 12), 'seed-hash',
              'seed ' || g, ARRAY['products:read'], true, :userId,
              CASE WHEN :expired THEN CAST(:past AS timestamptz) END, CASE WHEN :revoked THEN CAST(:past AS timestamptz) END
         FROM generate_series(1, :n) g`,
      {
        shopId,
        userId,
        n,
        expired: state.expired ?? false,
        revoked: state.revoked ?? false,
        // a day before the frozen test clock, not before the machine's clock
        past: new Date(t.clock.now().getTime() - 86_400_000),
      },
    );
  const keyRows = (shopId: string) =>
    rows<{
      id: string;
      hash: string;
      hashVersion: number;
      successorId: string | null;
      revokedAt: Date | null;
      expiresAt: Date | null;
      lastUsedAt: Date | null;
    }>(t.app, `SELECT * FROM "ApiKey" WHERE "shopId" = :shopId`, { shopId });
  const call = (inst: typeof t.pub, key: string) =>
    inst.withKey(key).get('/v1/products');

  describe('AS-01…AS-04 create, validate, authorize', () => {
    it('W04 B-4: GET keys answers {items, nextCursor} (apiKeyListSchema) and accepts limit and cursor', async () => {
      const w = await t.seedWorld();
      for (const name of ['one', 'two', 'three'])
        await createKey(t, w, { name });
      const first = await t
        .as(w.owner)
        .get(`${KEYS(w.shop.id)}?limit=2`)
        .expect(200);
      const page1 = apiKeyListSchema.parse(first.body);
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toEqual(expect.any(String));
      const second = await t
        .as(w.owner)
        .get(
          `${KEYS(w.shop.id)}?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        )
        .expect(200);
      const page2 = apiKeyListSchema.parse(second.body);
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
    });

    it('S42 AS-01: the secret is shown once, only a keyed hash is stored, and one event is committed with the row', async () => {
      const w = await t.seedWorld();
      const res = await t
        .as(w.ownerMfa)
        .post(KEYS(w.shop.id))
        .send({
          name: 'ERP',
          scopes: ['products:read', 'stock:write'],
          livemode: true,
        })
        .expect(201);
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.body).toMatchObject({
        name: 'ERP',
        scopes: ['products:read', 'stock:write'],
        livemode: true,
        status: 'active',
        expiresAt: null,
      });
      expect(res.body.key).toMatch(/^sk_live_[0-9A-Za-z]{12}_[0-9A-Za-z]{32}$/);
      expect(res.body.key.split('_')[2]).toBe(res.body.prefix);
      expect(res.body.prefix).toHaveLength(12);

      const list = await t.as(w.owner).get(KEYS(w.shop.id)).expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({
        id: res.body.id,
        prefix: res.body.prefix,
        name: 'ERP',
        livemode: true,
        status: 'active',
        expiresAt: null,
        lastUsedAt: null,
        createdBy: w.owner.id,
      });
      const secret = res.body.key.split('_')[3];
      const wire = JSON.stringify(list.body);
      for (const forbidden of [secret, 'secret', 'hash', res.body.key])
        expect(wire).not.toContain(forbidden);
      expect(list.body.items[0]).not.toHaveProperty('key');

      const [stored] = await keyRows(w.shop.id);
      expect(stored.hash).not.toContain(secret);
      expect(stored.hash).not.toBe(secret);
      expect(stored.hashVersion).toBe(1);

      const events = await outboxEvents(
        t.app,
        'developerplatform.api_key_created',
        {
          shopId: w.shop.id,
        },
      );
      expect(events).toHaveLength(1);
      expect(events[0].aggregateId).toBe(res.body.id);
      expect(events[0].payload).toEqual({
        keyId: res.body.id,
        shopId: w.shop.id,
        prefix: res.body.prefix,
        livemode: true,
        scopes: ['products:read', 'stock:write'],
        actorId: w.owner.id,
      });
      expect(JSON.stringify(events)).not.toContain(secret);
      // same commit: the event row and the key row were written by one transaction
      const [same] = await rows<{ same: boolean }>(
        t.app,
        `SELECT k.xmin::text = o.xmin::text AS same FROM "ApiKey" k, "Outbox" o
          WHERE k.id = :id AND o."eventName" = 'developerplatform.api_key_created' AND o."aggregateId" = :id`,
        { id: res.body.id },
      );
      expect(same.same).toBe(true);
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['an empty name', { name: '' }, 'name'],
      ['a name of 61 characters', { name: 'n'.repeat(61) }, 'name'],
      ['empty scopes', { scopes: [] }, 'scopes'],
      ['an unknown scope', { scopes: ['admin:all'] }, 'scopes'],
      [
        'duplicate scopes',
        { scopes: ['products:read', 'products:read'] },
        'scopes',
      ],
      ['a non-boolean livemode', { livemode: 'yes' }, 'livemode'],
      [
        'an expiry in the past',
        { expiresAt: '2026-10-06T11:59:59.000Z' },
        'expiresAt',
      ],
      [
        'an expiry more than 365 days away',
        { expiresAt: '2027-10-07T12:00:01.000Z' },
        'expiresAt',
      ],
      ['an unknown property', { sandbox: true }, 'sandbox'],
    ])(
      'S42 AS-02: %s is 400 validation_failed naming the field, and nothing is created',
      async (_n, patch, field) => {
        const w = await t.seedWorld();
        const res = await t
          .as(w.ownerMfa)
          .post(KEYS(w.shop.id))
          .send({
            name: 'ERP',
            scopes: ['products:read'],
            livemode: false,
            ...patch,
          })
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(
          res.body.errors.map((e: { field: string }) => e.field),
        ).toContain(field);
        expect(await keyRows(w.shop.id)).toHaveLength(0);
        expect(
          await outboxEvents(t.app, 'developerplatform.api_key_created', {
            shopId: w.shop.id,
          }),
        ).toHaveLength(0);
      },
    );

    it('S42 AS-02: an expiry exactly 365 days away is accepted and listed as that instant', async () => {
      const w = await t.seedWorld();
      const expiresAt = '2027-10-06T12:00:00.000Z';
      const res = await t
        .as(w.ownerMfa)
        .post(KEYS(w.shop.id))
        .send({
          name: 'ERP',
          scopes: ['products:read'],
          livemode: true,
          expiresAt,
        })
        .expect(201);
      expect(res.body.expiresAt).toBe(expiresAt);
    });

    it('S42 AS-03: no session is 401, a member without shop.manage 403, another shop’s member 404, and a foreign key id 404 resource_missing', async () => {
      const a = await t.seedWorld();
      const b = await t.seedWorld();
      const created = await createKey(t, a);
      const foreign = await createKey(t, b);

      await t.http().post(KEYS(a.shop.id)).send({}).expect(401);
      const staff = await addShopMember(t, a.shop.id, 'STAFF');
      const body = { name: 'x', scopes: ['products:read'], livemode: false };
      await t.as(staff).post(KEYS(a.shop.id)).send(body).expect(403);
      await t
        .as(staff)
        .post(`${KEYS(a.shop.id)}/${created.id}/rotate`)
        .send({})
        .expect(403);
      await t
        .as(staff)
        .delete(`${KEYS(a.shop.id)}/${created.id}`)
        .expect(403);

      await t.as(b.owner).get(KEYS(a.shop.id)).expect(404);
      await t.as(b.owner).post(KEYS(a.shop.id)).send(body).expect(404);

      const rotate = await t
        .as(a.ownerMfa)
        .post(`${KEYS(a.shop.id)}/${foreign.id}/rotate`)
        .send({})
        .expect(404);
      expect(rotate.body.code).toBe('resource_missing');
      await t
        .as(a.ownerMfa)
        .delete(`${KEYS(a.shop.id)}/${foreign.id}`)
        .expect(404);
      const [unchanged] = await keyRows(b.shop.id);
      expect(unchanged.revokedAt).toBeNull();
      expect(unchanged.successorId).toBeNull();
    });

    it('S42 AS-04: a logged-out session is 401 at once on every key route and the pin route', async () => {
      const w = await t.seedWorld();
      const key = await createKey(t, w);
      const session = await t.withMfa(w.owner);
      await t
        .as(session)
        .post('/api/auth/logout')
        .expect((r) => {
          if (r.status >= 300) throw new Error(`logout ${r.status}`);
        });
      const base = KEYS(w.shop.id);
      await t.as(session).get(base).expect(401);
      await t
        .as(session)
        .post(base)
        .send({ name: 'x', scopes: ['products:read'], livemode: false })
        .expect(401);
      await t.as(session).post(`${base}/${key.id}/rotate`).send({}).expect(401);
      await t.as(session).delete(`${base}/${key.id}`).expect(401);
      await t
        .as(session)
        .put(`/api/shops/${w.shop.id}/developers/api-version`)
        .send({ version: '2026-10-01' })
        .expect(401);
    });

    it('S42 AS-04: a live key needs a second factor to be created or rotated; a test key does not; revoking is never blocked', async () => {
      const w = await t.seedWorld();
      const live = await createKey(t, w);
      const body = { name: 'ERP', scopes: ['products:read'] };

      const refusedCreate = await t
        .as(w.owner)
        .post(KEYS(w.shop.id))
        .send({ ...body, livemode: true })
        .expect(403);
      expect(refusedCreate.body.code).toBe('mfa_required');
      const refusedRotate = await t
        .as(w.owner)
        .post(`${KEYS(w.shop.id)}/${live.id}/rotate`)
        .send({})
        .expect(403);
      expect(refusedRotate.body.code).toBe('mfa_required');
      expect(await keyRows(w.shop.id)).toHaveLength(1);

      const test = await t
        .as(w.owner)
        .post(KEYS(w.shop.id))
        .send({ ...body, livemode: false })
        .expect(201);
      await t
        .as(w.owner)
        .post(`${KEYS(w.shop.id)}/${test.body.id}/rotate`)
        .send({})
        .expect(201);
      await t
        .as(w.owner)
        .delete(`${KEYS(w.shop.id)}/${live.id}`)
        .expect(204);
    });
  });

  describe('AS-05 limit', () => {
    it('S42 AS-05: with 24 active keys, 5 parallel creations give exactly one 201 and four 422 key_limit_reached (20 repeats)', async () => {
      for (let i = 0; i < 20; i += 1) {
        const w = await t.seedWorld();
        await seedKeys(w.shop.id, w.owner.id, 24);
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            t
              .as(w.ownerMfa)
              .post(KEYS(w.shop.id))
              .send({
                name: 'ERP',
                scopes: ['products:read'],
                livemode: true,
              }),
          ),
        );
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        const refused = results.filter((r) => r.status === 422);
        expect(refused).toHaveLength(4);
        expect(refused.every((r) => r.body.code === 'key_limit_reached')).toBe(
          true,
        );
        expect(await keyRows(w.shop.id)).toHaveLength(25);
      }
    });

    it('S42 AS-05: revoked and expired keys do not count, and a rotating key counts once', async () => {
      const w = await t.seedWorld();
      await seedKeys(w.shop.id, w.owner.id, 10, { revoked: true });
      await seedKeys(w.shop.id, w.owner.id, 10, { expired: true });
      await seedKeys(w.shop.id, w.owner.id, 22);
      const first = await createKey(t, w, { name: 'to rotate' });
      // 23 active; rotating one of them must not add a second slot
      await t
        .as(w.ownerMfa)
        .post(`${KEYS(w.shop.id)}/${first.id}/rotate`)
        .send({})
        .expect(201);
      await createKey(t, w, { name: 'twenty-fourth' });
      await createKey(t, w, { name: 'twenty-fifth' });
      const refused = await t
        .as(w.ownerMfa)
        .post(KEYS(w.shop.id))
        .send({ name: 'x', scopes: ['products:read'], livemode: true })
        .expect(422);
      expect(refused.body.code).toBe('key_limit_reached');
    });
  });

  describe('AS-06…AS-09 rotate, revoke, race', () => {
    it('S42 AS-06: rotation keeps the old key for the overlap, then only the successor works', async () => {
      const w = await t.seedWorld();
      const old = await createKey(t, w, {
        name: 'ERP',
        scopes: ['products:read'],
      });
      expect((await call(t.pub, old.key)).status).toBe(200);

      const rotated = await t
        .as(w.ownerMfa)
        .post(`${KEYS(w.shop.id)}/${old.id}/rotate`)
        .send({ overlapHours: 24 })
        .expect(201);
      expect(rotated.body).toMatchObject({
        name: 'ERP (rotated)',
        scopes: ['products:read'],
        livemode: true,
        status: 'active',
        previousExpiresAt: '2026-10-07T12:00:00.000Z',
      });
      expect(rotated.body.key).toMatch(/^sk_live_/);
      const list = await t.as(w.owner).get(KEYS(w.shop.id)).expect(200);
      const listed = list.body.items.find(
        (k: { id: string }) => k.id === old.id,
      );
      expect(listed).toMatchObject({
        status: 'rotating',
        expiresAt: '2026-10-07T12:00:00.000Z',
        successorId: rotated.body.id,
      });

      t.clock.advance(24 * HOUR - 1000);
      expect((await call(t.pub, old.key)).status).toBe(200);
      expect((await call(pub2, rotated.body.key)).status).toBe(200);
      t.clock.advance(1000);
      const expired = await call(t.pub, old.key);
      expect(expired.status).toBe(401);
      expect(expired.body.code).toBe('invalid_api_key');
      expect((await call(t.pub, rotated.body.key)).status).toBe(200);

      const events = await outboxEvents(
        t.app,
        'developerplatform.api_key_rotated',
        {
          shopId: w.shop.id,
        },
      );
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        keyId: old.id,
        successorId: rotated.body.id,
        actorId: w.owner.id,
      });
      expect(JSON.stringify(events)).not.toContain(
        rotated.body.key.split('_')[3],
      );
    });

    it('S42 AS-06: overlapHours 0 expires the old key at once; values outside 0…168 or fractional are 400', async () => {
      const w = await t.seedWorld();
      const old = await createKey(t, w);
      for (const overlapHours of [-1, 169, 1.5, '24'])
        await t
          .as(w.ownerMfa)
          .post(`${KEYS(w.shop.id)}/${old.id}/rotate`)
          .send({ overlapHours })
          .expect(400)
          .expect((r) => expect(r.body.code).toBe('validation_failed'));
      expect(await keyRows(w.shop.id)).toHaveLength(1);

      const res = await t
        .as(w.ownerMfa)
        .post(`${KEYS(w.shop.id)}/${old.id}/rotate`)
        .send({ overlapHours: 0 })
        .expect(201);
      expect(res.body.previousExpiresAt).toBe('2026-10-06T12:00:00.000Z');
      expect((await call(t.pub, old.key)).status).toBe(401);
      expect((await call(t.pub, res.body.key)).status).toBe(200);
    });

    it('S42 AS-07: a revoked, an expired and an already rotating key cannot be rotated', async () => {
      const w = await t.seedWorld();
      const revoked = await createKey(t, w);
      await t
        .as(w.owner)
        .delete(`${KEYS(w.shop.id)}/${revoked.id}`)
        .expect(204);
      const expiring = await createKey(t, w, {
        expiresAt: '2026-10-07T00:00:00.000Z',
      });
      const rotating = await createKey(t, w);
      await t
        .as(w.ownerMfa)
        .post(`${KEYS(w.shop.id)}/${rotating.id}/rotate`)
        .send({})
        .expect(201);
      const before = (await keyRows(w.shop.id)).length;

      const r1 = await t
        .as(w.ownerMfa)
        .post(`${KEYS(w.shop.id)}/${revoked.id}/rotate`)
        .send({})
        .expect(409);
      expect(r1.body.code).toBe('key_revoked');
      const r3 = await t
        .as(w.ownerMfa)
        .post(`${KEYS(w.shop.id)}/${rotating.id}/rotate`)
        .send({})
        .expect(409);
      expect(r3.body.code).toBe('key_already_rotating');
      t.clock.advance(13 * HOUR);
      const user = await t.withMfa(w.owner);
      const r2 = await t
        .as(user)
        .post(`${KEYS(w.shop.id)}/${expiring.id}/rotate`)
        .send({})
        .expect(409);
      expect(r2.body.code).toBe('key_expired');
      expect((await keyRows(w.shop.id)).length).toBe(before);
    });

    it('S42 AS-07: two parallel rotations of an active key give one 201 and one 409 key_already_rotating, one successor (20 repeats)', async () => {
      for (let i = 0; i < 20; i += 1) {
        const w = await t.seedWorld();
        const key = await createKey(t, w);
        const results = await Promise.all(
          [0, 1].map(() =>
            t
              .as(w.ownerMfa)
              .post(`${KEYS(w.shop.id)}/${key.id}/rotate`)
              .send({}),
          ),
        );
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(results.find((r) => r.status === 409)!.body.code).toBe(
          'key_already_rotating',
        );
        const all = await keyRows(w.shop.id);
        expect(all).toHaveLength(2);
        expect(all.filter((k) => k.successorId !== null)).toHaveLength(1);
      }
    });

    it('S42 AS-08: revoke is immediate on every instance and idempotent, with exactly one event; the successor of a rotating key is untouched', async () => {
      const w = await t.seedWorld();
      const key = await createKey(t, w);
      expect((await call(t.pub, key.key)).status).toBe(200);
      expect((await call(pub2, key.key)).status).toBe(200);

      await t
        .as(w.owner)
        .delete(`${KEYS(w.shop.id)}/${key.id}`)
        .expect(204);
      expect((await call(t.pub, key.key)).status).toBe(401);
      expect((await call(pub2, key.key)).status).toBe(401);
      const list = await t.as(w.owner).get(KEYS(w.shop.id)).expect(200);
      expect(list.body.items[0].status).toBe('revoked');

      await t
        .as(w.owner)
        .delete(`${KEYS(w.shop.id)}/${key.id}`)
        .expect(204);
      const events = await outboxEvents(
        t.app,
        'developerplatform.api_key_revoked',
        {
          shopId: w.shop.id,
        },
      );
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        keyId: key.id,
        reason: 'manual',
        actorId: w.owner.id,
      });

      const old = await createKey(t, w);
      const rotated = await t
        .as(w.ownerMfa)
        .post(`${KEYS(w.shop.id)}/${old.id}/rotate`)
        .send({})
        .expect(201);
      await t
        .as(w.owner)
        .delete(`${KEYS(w.shop.id)}/${old.id}`)
        .expect(204);
      expect((await call(t.pub, old.key)).status).toBe(401);
      expect((await call(t.pub, rotated.body.key)).status).toBe(200);
    });

    it('S42 AS-09: after the revoke returned 204 no call with the key answers 2xx, even when it raced a cold cache fill (20 repeats)', async () => {
      const redis = t.app.get(RedisService).client;
      for (let i = 0; i < 20; i += 1) {
        const w = await t.seedWorld();
        const key = await createKey(t, w);
        await redis.del(`${KEY_CACHE_PREFIX}${key.prefix}`);
        const [, , revoked] = await Promise.all([
          call(t.pub, key.key),
          call(pub2, key.key),
          t.as(w.owner).delete(`${KEYS(w.shop.id)}/${key.id}`),
        ]);
        expect(revoked.status).toBe(204);
        await clearRateLimits(t.app); // 80 refused calls from one address would meet the failed-auth throttle (AS-14)
        for (let n = 0; n < 4; n += 1) {
          expect((await call(n % 2 ? t.pub : pub2, key.key)).status).toBe(401);
        }
      }
    });
  });

  describe('AS-10, AS-11 expiry and last use', () => {
    it('S42 AS-10: a key works until its expiry instant and is expired from it on', async () => {
      const w = await t.seedWorld();
      const key = await createKey(t, w, {
        expiresAt: '2026-10-07T00:00:00.000Z',
      });
      t.clock.set(new Date('2026-10-06T23:59:59.000Z'));
      expect((await call(t.pub, key.key)).status).toBe(200);
      t.clock.set(new Date('2026-10-07T00:00:00.000Z'));
      const res = await call(t.pub, key.key);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_api_key');
      await t.reauth(w.owner);
      const list = await t.as(w.owner).get(KEYS(w.shop.id)).expect(200);
      expect(list.body.items[0].status).toBe('expired');
    });

    describe('last use', () => {
      const flusher = () => t.app.get(KeyUsageFlusher);
      const lastUsed = async (shopId: string) =>
        (await keyRows(shopId))[0].lastUsedAt?.toISOString() ?? null;
      afterEach(async () => {
        await exec(
          t.app,
          `DROP TRIGGER IF EXISTS s42_fail_last_used ON "ApiKey"`,
        );
        await exec(t.app, `DROP FUNCTION IF EXISTS s42_fail_last_used()`);
      });

      it('S42 AS-11: the minute flush stores the latest use, never moves backwards and never into the future', async () => {
        const w = await t.seedWorld();
        const key = await createKey(t, w);
        expect(await lastUsed(w.shop.id)).toBeNull();
        expect((await call(t.pub, key.key)).status).toBe(200);
        t.clock.advance(20_000);
        expect((await call(pub2, key.key)).status).toBe(200);
        await flusher().flush();
        expect(await lastUsed(w.shop.id)).toBe('2026-10-06T12:00:20.000Z');

        // an older batch flushed late: a use record from T + 5 s arrives after T + 20 s was stored
        await t.app
          .get(RedisService)
          .client.zadd(
            LAST_USED_KEY,
            Date.parse('2026-10-06T12:00:05.000Z'),
            key.id,
          );
        await flusher().flush();
        expect(await lastUsed(w.shop.id)).toBe('2026-10-06T12:00:20.000Z');

        // a record dated after the flush instant is clamped to it
        await t.app
          .get(RedisService)
          .client.zadd(
            LAST_USED_KEY,
            Date.parse('2026-10-06T13:00:00.000Z'),
            key.id,
          );
        await flusher().flush();
        expect(await lastUsed(w.shop.id)).toBe('2026-10-06T12:00:20.000Z');
      });

      it('S42 AS-11: a call whose use record is lost still succeeds and only leaves lastUsedAt older', async () => {
        const w = await t.seedWorld();
        const key = await createKey(t, w);
        expect((await call(t.pub, key.key)).status).toBe(200);
        await t.app.get(RedisService).client.del(LAST_USED_KEY);
        await flusher().flush();
        expect(await lastUsed(w.shop.id)).toBeNull();
        expect((await call(t.pub, key.key)).status).toBe(200);
      });

      it('S42 AS-11: a failed flush gives the drained records back, so the next flush stores them', async () => {
        const w = await t.seedWorld();
        const key = await createKey(t, w, { name: 'trigger-fail' });
        expect((await call(t.pub, key.key)).status).toBe(200);
        await exec(
          t.app,
          `CREATE FUNCTION s42_fail_last_used() RETURNS trigger AS $$
           BEGIN IF NEW.name = 'trigger-fail' THEN RAISE EXCEPTION 'last-used write refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
           CREATE TRIGGER s42_fail_last_used BEFORE UPDATE OF "lastUsedAt" ON "ApiKey"
             FOR EACH ROW EXECUTE FUNCTION s42_fail_last_used()`,
        );
        await expect(flusher().flush()).rejects.toThrow();
        expect(await lastUsed(w.shop.id)).toBeNull();
        await exec(t.app, `DROP TRIGGER s42_fail_last_used ON "ApiKey"`);
        await flusher().flush();
        expect(await lastUsed(w.shop.id)).toBe('2026-10-06T12:00:00.000Z');
      });
    });
  });
});

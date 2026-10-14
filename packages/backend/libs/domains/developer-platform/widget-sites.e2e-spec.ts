import {
  widgetSiteCreatedSchema,
  widgetSiteHistoryPageSchema,
  widgetSitePageSchema,
  widgetSiteSchema,
  widgetSecretRotatedSchema,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { SecretBox } from '@app/domains/identity';
import { v4 as uuidv4 } from 'uuid';
import {
  clearRateLimits,
  createWidgetKit,
  type CreatedSite,
  exec,
  ORIGIN,
  ORIGIN_2,
  outboxEvents,
  rows,
  type WidgetKit,
  type WidgetWorld,
} from './testing/widget-kit';

const EVENT = 'developerplatform.widget_site_changed';

describe('Widget: site management (dashboard)', () => {
  let t: WidgetKit;
  let w: WidgetWorld;

  beforeAll(async () => {
    t = await createWidgetKit();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
  });

  const base = (shopId = w.shop.id) => `/api/shops/${shopId}/widget/sites`;
  const owner = () => t.as(w.owner);
  const stored = (id: string) =>
    rows<{
      identitySecretSealed: string;
      previousIdentitySecretSealed: string | null;
      previousSecretExpiresAt: Date | null;
      allowedOrigins: string[];
      shopName: string;
      shopStatus: string;
      shopVersion: number;
      version: number;
      theme: Record<string, string>;
      killSwitch: boolean;
      name: string;
    }>(
      t.app,
      `SELECT "identitySecretSealed", "previousIdentitySecretSealed", "previousSecretExpiresAt", "allowedOrigins",
              "shopName", "shopStatus", "shopVersion"::int AS "shopVersion", version, theme, "killSwitch", name
         FROM "WidgetSite" WHERE id = :id`,
      { id },
    ).then((r) => r[0]);
  const count = async (shopId = w.shop.id) =>
    (
      await rows<{ n: number }>(
        t.app,
        `SELECT count(*)::int AS n FROM "WidgetSite" WHERE "shopId" = :shopId`,
        { shopId },
      )
    )[0].n;

  describe('create (AS-01, AS-02, AS-03, AS-04)', () => {
    it('S44 AS-01: an admin creates a site; the secret is shown once, sealed at rest, with the shop copy and one event', async () => {
      const product = await t.product(w);
      const second = await t.product(w);
      const res = await t
        .as(w.admin)
        .post(base())
        .send({
          name: 'Main blog',
          origins: [ORIGIN, ORIGIN_2],
          featuredProductIds: [product.id, second.id],
        })
        .expect(201);
      const site = widgetSiteCreatedSchema.parse(res.body);
      expect(site).toMatchObject({
        shopId: w.shop.id,
        name: 'Main blog',
        allowedOrigins: [ORIGIN, ORIGIN_2],
        featuredProductIds: [product.id, second.id],
        theme: {},
        killSwitch: false,
        hasPreviousSecret: false,
        previousSecretExpiresAt: null,
        version: 1,
      });
      expect(site.publishableKey).toMatch(/^pk_live_[A-Za-z0-9_-]{24}$/);
      expect(site.identitySecret).toMatch(/^wis_[A-Za-z0-9_-]{43}$/);

      const row = await stored(site.id);
      expect(row.identitySecretSealed).not.toContain(site.identitySecret);
      const box = t.app.get(SecretBox);
      expect(box.open(row.identitySecretSealed, `widget-site:${site.id}`)).toBe(
        site.identitySecret,
      );
      expect(() =>
        box.open(row.identitySecretSealed, 'widget-site:other'),
      ).toThrow();
      expect(row).toMatchObject({
        shopName: 'My Shop',
        shopStatus: 'ACTIVE',
        shopVersion: 1,
      });
      for (const table of ['WidgetSite', 'WidgetSiteChange', 'Outbox']) {
        const hits = await rows<{ n: number }>(
          t.app,
          `SELECT count(*)::int AS n FROM "${table}" x WHERE x::text LIKE :needle`,
          { needle: `%${site.identitySecret}%` },
        );
        expect(hits[0].n).toBe(0);
      }

      const events = await outboxEvents(t.app, EVENT, { aggregateId: site.id });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        siteId: site.id,
        shopId: w.shop.id,
        change: 'created',
        actorId: w.admin.id,
      });
      expect(JSON.stringify(events[0].payload)).not.toContain(
        site.publishableKey,
      );

      const read = await owner().get(`${base()}/${site.id}`).expect(200);
      expect(read.body).not.toHaveProperty('identitySecret');
      expect(widgetSiteSchema.parse(read.body).id).toBe(site.id);
    });

    it('S44 AS-02: a rejected origin answers one wired 422 origin_invalid with the origin and the reason, and nothing is stored', async () => {
      const res = await owner()
        .post(base())
        .send({ origins: [ORIGIN, 'http://insecure.example'] })
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'origin_invalid',
        details: { origin: 'http://insecure.example', reason: 'not_https' },
      });
      expect(await count()).toBe(0);
    });

    it.each([
      ['no origins', { origins: undefined }],
      ['an empty list', { origins: [] }],
      [
        'more than 10 origins',
        {
          origins: Array.from(
            { length: 11 },
            (_, i) => `https://s${i}.example`,
          ),
        },
      ],
      ['a non-array', { origins: 'https://a.example' }],
      ['a non-string element', { origins: [42] }],
      [
        'more than 12 products',
        { featuredProductIds: Array.from({ length: 13 }, () => uuidv4()) },
      ],
      ['a non-UUID product', { featuredProductIds: ['not-a-uuid'] }],
      ['a name over 60 characters', { name: 'x'.repeat(61) }],
      ['an empty name', { name: '' }],
      ['an unknown property killSwitch', { killSwitch: true }],
      [
        'an unknown property publishableKey',
        { publishableKey: 'pk_live_abcdefghijklmnopqrstuvwx' },
      ],
      ['a non-object theme (not accepted on create)', { theme: 'dark' }],
    ])(
      'S44 AS-03: %s -> 400 validation_failed, nothing stored',
      async (_n, patch) => {
        const res = await owner()
          .post(base())
          .send({ origins: [ORIGIN], ...patch })
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await count()).toBe(0);
      },
    );

    it('S44 AS-03: duplicate origins collapse after normalisation, and an update to the same set is not a change', async () => {
      const site = await t.site(w, {
        origins: [
          'https://Shop.com',
          'https://shop.com:443',
          'https://other.example',
        ],
      });
      expect(site.allowedOrigins).toEqual([
        'https://shop.com',
        'https://other.example',
      ]);
      const same = await owner()
        .patch(`${base()}/${site.id}`)
        .send({
          allowedOrigins: ['https://other.example', 'https://SHOP.com'],
          expectedVersion: 1,
        })
        .expect(200);
      expect(same.body.version).toBe(1);
      expect(
        await outboxEvents(t.app, EVENT, { aggregateId: site.id }),
      ).toHaveLength(1);
    });

    it('S44 AS-04: a valid theme is stored as given, one wired reject leaves it unchanged', async () => {
      const site = await t.site(w);
      const theme = {
        primaryColor: '#0a0B0c',
        textColor: '#000000',
        backgroundColor: '#ffffff',
        borderRadius: '8px',
        fontFamily: 'serif',
        buttonLabel: 'Buy now',
      };
      const ok = await owner()
        .patch(`${base()}/${site.id}`)
        .send({ theme, expectedVersion: 1 })
        .expect(200);
      expect(ok.body.theme).toEqual(theme);
      expect((await stored(site.id)).theme).toEqual(theme);

      for (const bad of [
        { primaryColor: 'red' },
        { borderRadius: '25px' },
        { buttonLabel: '<b>x</b>' },
        { unknownKey: '#000000' },
        { primaryColor: 5 },
      ]) {
        const res = await owner()
          .patch(`${base()}/${site.id}`)
          .send({ theme: bad, expectedVersion: 2 })
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
      expect((await stored(site.id)).theme).toEqual(theme);
      expect((await stored(site.id)).version).toBe(2);
    });
  });

  describe('limits (AS-05)', () => {
    it('S44 AS-05: with 9 sites 20 concurrent creates give exactly one 201 and 19 site_limit_reached; a delete frees a slot', async () => {
      for (let i = 0; i < 9; i += 1) await t.site(w);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          owner()
            .post(base())
            .send({ origins: [ORIGIN] }),
        ),
      );
      const created = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status === 422);
      expect(created).toHaveLength(1);
      expect(refused).toHaveLength(19);
      for (const r of refused) expect(r.body.code).toBe('site_limit_reached');
      expect(await count()).toBe(10);

      await owner()
        .post(base())
        .send({ origins: [ORIGIN] })
        .expect(422);
      expect(await count()).toBe(10);

      await owner().delete(`${base()}/${created[0].body.id}`).expect(204);
      await owner()
        .post(base())
        .send({ origins: [ORIGIN] })
        .expect(201);
      expect(await count()).toBe(10);
    });
  });

  describe('list and read (AS-06)', () => {
    it('S44 AS-06: keyset pages cover every site of the shop once, none of another shop, never a secret', async () => {
      const other = await t.world();
      const mine: CreatedSite[] = [];
      for (let i = 0; i < 5; i += 1) mine.push(await t.site(w));
      for (let i = 0; i < 2; i += 1) await t.site(other);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await owner()
          .get(`${base()}?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
          .expect(200);
        const page = widgetSitePageSchema.parse(res.body);
        expect(page.items.length).toBeLessThanOrEqual(2);
        for (const item of page.items) {
          expect(item).not.toHaveProperty('identitySecret');
          expect(item.shopId).toBe(w.shop.id);
          seen.push(item.id);
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect([...seen].sort()).toEqual(mine.map((s) => s.id).sort());
      expect(new Set(seen).size).toBe(5);
      // createdAt descending, then id descending
      const dtos = await Promise.all(
        seen.map((id) =>
          owner()
            .get(`${base()}/${id}`)
            .then((r) => r.body),
        ),
      );
      for (let i = 1; i < dtos.length; i += 1) {
        const a = dtos[i - 1];
        const b = dtos[i];
        expect(
          a.createdAt > b.createdAt ||
            (a.createdAt === b.createdAt && a.id > b.id),
        ).toBe(true);
      }
    });

    it.each([['limit=0'], ['limit=101'], ['limit=abc'], ['cursor=tampered']])(
      'S44 AS-06: %s -> 400 validation_failed',
      async (query) => {
        await t.site(w);
        const res = await owner().get(`${base()}?${query}`).expect(400);
        expect(res.body.code).toBe('validation_failed');
      },
    );
  });

  describe('update (AS-07)', () => {
    it('S44 AS-07: an update bumps the version and emits one event per changed group; a rename emits none', async () => {
      const site = await t.site(w);
      const product = await t.product(w);
      const res = await owner()
        .patch(`${base()}/${site.id}`)
        .send({
          allowedOrigins: ['https://new.example'],
          featuredProductIds: [product.id],
          expectedVersion: 1,
        })
        .expect(200);
      expect(widgetSiteSchema.parse(res.body)).toMatchObject({
        version: 2,
        allowedOrigins: ['https://new.example'],
        featuredProductIds: [product.id],
      });
      expect(res.body.updatedAt >= res.body.createdAt).toBe(true);
      const events = await outboxEvents(t.app, EVENT, { aggregateId: site.id });
      expect(events.map((e) => e.payload.change)).toEqual([
        'created',
        'origins_changed',
        'products_changed',
      ]);

      await owner()
        .patch(`${base()}/${site.id}`)
        .send({ name: 'Renamed', expectedVersion: 2 })
        .expect(200);
      expect(
        await outboxEvents(t.app, EVENT, { aggregateId: site.id }),
      ).toHaveLength(3);
      expect((await stored(site.id)).version).toBe(3);
    });

    it('S44 AS-07: 20 concurrent updates with the same expectedVersion: exactly one wins, the losers store nothing', async () => {
      const site = await t.site(w);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          owner()
            .patch(`${base()}/${site.id}`)
            .send({ name: `name-${i}`, expectedVersion: 1 }),
        ),
      );
      const winners = results.filter((r) => r.status === 200);
      expect(winners).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 200)) {
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('site_version_conflict');
      }
      const row = await stored(site.id);
      expect(row.version).toBe(2);
      expect(row.name).toBe(winners[0].body.name);
    });

    it('S44 AS-07: a missing expectedVersion is 400, a stale one 409', async () => {
      const site = await t.site(w);
      const missing = await owner()
        .patch(`${base()}/${site.id}`)
        .send({ name: 'x' })
        .expect(400);
      expect(missing.body.code).toBe('validation_failed');
      const stale = await owner()
        .patch(`${base()}/${site.id}`)
        .send({ name: 'x', expectedVersion: 7 })
        .expect(409);
      expect(stale.body.code).toBe('site_version_conflict');
    });
  });

  describe('featured products (AS-08)', () => {
    it('S44 AS-08: own products pass (archived too); a foreign, an unknown and a deleted id are one refusal; one R1 batch', async () => {
      const other = await t.world();
      const own = await t.product(w);
      const archived = await t.product(w);
      await t.archive(w, archived.id);
      const foreign = await t.product(other);

      t.faults.catalogCalls.length = 0;
      await owner()
        .post(base())
        .send({ origins: [ORIGIN], featuredProductIds: [own.id, archived.id] })
        .expect(201);
      expect(t.faults.catalogCalls).toHaveLength(1);
      expect(t.faults.catalogCalls[0].shopId).toBe(w.shop.id);

      const bodies: string[] = [];
      for (const id of [foreign.id, uuidv4()]) {
        const res = await owner()
          .post(base())
          .send({ origins: [ORIGIN], featuredProductIds: [id] })
          .expect(422);
        expect(res.body.code).toBe('featured_product_invalid');
        bodies.push(JSON.stringify(res.body).split(id).join('<id>'));
      }
      expect(bodies[0].replace(/"requestId":"[^"]*"/, '')).toBe(
        bodies[1].replace(/"requestId":"[^"]*"/, ''),
      );
    });
  });

  describe('permission, IDOR, authentication (AS-09)', () => {
    it('S44 AS-09: owner and admin may use every route; staff and viewer 403; a member of another shop 404; anonymous 401', async () => {
      const mkSite = () => t.site(w);
      const routes: {
        name: string;
        call: (
          agent: ReturnType<WidgetKit['as']> | null,
          siteId: string,
        ) => ReturnType<ReturnType<WidgetKit['as']>['get']>;
        ok: number;
      }[] = [];
      const bearer = (agent: ReturnType<WidgetKit['as']> | null) =>
        agent ?? {
          get: (u: string) => t.http().get(u),
          post: (u: string) => t.http().post(u),
          put: (u: string) => t.http().put(u),
          patch: (u: string) => t.http().patch(u),
          delete: (u: string) => t.http().delete(u),
        };
      routes.push(
        {
          name: 'create',
          ok: 201,
          call: (a) =>
            bearer(a)
              .post(base())
              .send({ origins: [ORIGIN] }),
        },
        { name: 'list', ok: 200, call: (a) => bearer(a).get(base()) },
        {
          name: 'read',
          ok: 200,
          call: (a, id) => bearer(a).get(`${base()}/${id}`),
        },
        {
          name: 'update',
          ok: 200,
          call: (a, id) =>
            bearer(a)
              .patch(`${base()}/${id}`)
              .send({ name: 'n', expectedVersion: 1 }),
        },
        {
          name: 'rotate',
          ok: 201,
          call: (a, id) =>
            bearer(a).post(`${base()}/${id}/rotate-secret`).send({}),
        },
        {
          name: 'expire',
          ok: 409, // no previous secret on a fresh site: the permission passed, the state refuses
          call: (a, id) =>
            bearer(a).post(`${base()}/${id}/expire-previous-secret`).send({}),
        },
        {
          name: 'kill',
          ok: 200,
          call: (a, id) =>
            bearer(a).put(`${base()}/${id}/kill-switch`).send({ on: true }),
        },
        {
          name: 'history',
          ok: 200,
          call: (a, id) => bearer(a).get(`${base()}/${id}/history`),
        },
        {
          name: 'delete',
          ok: 204,
          call: (a, id) => bearer(a).delete(`${base()}/${id}`),
        },
      );
      const actors: [
        string,
        ReturnType<WidgetKit['as']> | null,
        number | 'ok',
      ][] = [
        ['owner', t.as(w.owner), 'ok'],
        ['admin', t.as(w.admin), 'ok'],
        ['staff', t.as(w.staff), 403],
        ['viewer', t.as(w.viewer), 403],
        ['outsider', t.as(w.outsider), 404],
        ['anonymous', null, 401],
      ];
      for (const route of routes) {
        for (const [who, agent, expected] of actors) {
          // every call starts from a shop with exactly one fresh site and a fresh limiter
          await exec(
            t.app,
            `DELETE FROM "WidgetSite" WHERE "shopId" = :shopId`,
            {
              shopId: w.shop.id,
            },
          );
          await clearRateLimits(t.app);
          const site = await mkSite();
          const res = await route.call(agent, site.id);
          const want = expected === 'ok' ? route.ok : expected;
          if (res.status !== want)
            throw new Error(
              `${route.name} as ${who}: expected ${want}, got ${res.status} ${JSON.stringify(res.body)}`,
            );
          if (expected === 403) expect(res.body.code).toBe('permission_denied');
          if (expected === 404) expect(res.body.code).toBe('shop_not_found');
        }
      }
    });

    it("S44 AS-09: another shop's site id and an unknown id give the same 404 widget_site_not_found and change nothing", async () => {
      const other = await t.world();
      const foreign = await t.site(other);
      const calls = (siteId: string) => [
        owner().get(`${base()}/${siteId}`),
        owner()
          .patch(`${base()}/${siteId}`)
          .send({ name: 'x', expectedVersion: 1 }),
        owner().post(`${base()}/${siteId}/rotate-secret`).send({}),
        owner().post(`${base()}/${siteId}/expire-previous-secret`).send({}),
        owner().put(`${base()}/${siteId}/kill-switch`).send({ on: true }),
        owner().delete(`${base()}/${siteId}`),
        owner().get(`${base()}/${siteId}/history`),
      ];
      const strip = (b: Record<string, unknown>) => ({
        ...b,
        requestId: undefined,
        instance: undefined,
      });
      const cross = await Promise.all(calls(foreign.id));
      const unknown = await Promise.all(calls(uuidv4()));
      cross.forEach((res, i) => {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('widget_site_not_found');
        expect(strip(res.body)).toEqual(strip(unknown[i].body));
      });
      const row = await stored(foreign.id);
      expect(row).toMatchObject({
        killSwitch: false,
        version: 1,
        name: 'Storefront widget',
      });
    });

    it('S44 AS-09: a suspended shop refuses write routes with 403 shop_suspended; an offboarding shop with 409 shop_offboarding', async () => {
      const site = await t.site(w);
      await exec(
        t.app,
        `UPDATE "Shop" SET status = 'SUSPENDED' WHERE id = :id`,
        {
          id: w.shop.id,
        },
      );
      const suspended = await owner()
        .put(`${base()}/${site.id}/kill-switch`)
        .send({ on: true });
      expect(suspended.status).toBe(403);
      expect(suspended.body.code).toBe('shop_suspended');
      await exec(
        t.app,
        `UPDATE "Shop" SET status = 'DELETING' WHERE id = :id`,
        {
          id: w.shop.id,
        },
      );
      const offboarding = await owner()
        .post(base())
        .send({ origins: [ORIGIN] });
      expect(offboarding.status).toBe(409);
      expect(offboarding.body.code).toBe('shop_offboarding');
    });
  });

  describe('secret rotation (AS-10, AS-11)', () => {
    it('S44 AS-10: rotation returns a new secret once, keeps the old one until the expiry, and emits secret_rotated', async () => {
      const site = await t.site(w);
      const before = await stored(site.id);
      const res = await owner()
        .post(`${base()}/${site.id}/rotate-secret`)
        .send({ overlapHours: 24 })
        .expect(201);
      const rotated = widgetSecretRotatedSchema.parse(res.body);
      expect(rotated.identitySecret).toMatch(/^wis_[A-Za-z0-9_-]{43}$/);
      expect(rotated.identitySecret).not.toBe(site.identitySecret);
      expect(rotated.previousSecretExpiresAt).toBe('2026-10-07T12:00:00.000Z');

      const after = await stored(site.id);
      const box = t.app.get(SecretBox);
      const ctx = `widget-site:${site.id}`;
      expect(box.open(after.identitySecretSealed, ctx)).toBe(
        rotated.identitySecret,
      );
      expect(after.previousIdentitySecretSealed).toBe(
        before.identitySecretSealed,
      );
      expect(box.open(after.previousIdentitySecretSealed!, ctx)).toBe(
        site.identitySecret,
      );

      const read = await owner().get(`${base()}/${site.id}`).expect(200);
      expect(read.body).toMatchObject({
        hasPreviousSecret: true,
        previousSecretExpiresAt: '2026-10-07T12:00:00.000Z',
      });
      const events = await outboxEvents(t.app, EVENT, { aggregateId: site.id });
      expect(events.map((e) => e.payload.change)).toEqual([
        'created',
        'secret_rotated',
      ]);
      expect(JSON.stringify(events)).not.toContain(rotated.identitySecret);
    });

    it('S44 AS-10: overlapHours defaults to 24, accepts 0 (the old secret stops at once) and refuses anything else', async () => {
      const site = await t.site(w);
      for (const bad of [73, -1, 1.5, '24']) {
        const res = await owner()
          .post(`${base()}/${site.id}/rotate-secret`)
          .send({ overlapHours: bad })
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
      const none = await owner()
        .post(`${base()}/${site.id}/rotate-secret`)
        .send({ overlapHours: 0 })
        .expect(201);
      expect(none.body.previousSecretExpiresAt).toBeNull();
      expect((await stored(site.id)).previousIdentitySecretSealed).toBeNull();
      const dflt = await owner()
        .post(`${base()}/${site.id}/rotate-secret`)
        .send({})
        .expect(201);
      expect(dflt.body.previousSecretExpiresAt).toBe(
        '2026-10-07T12:00:00.000Z',
      );
    });

    it('S44 AS-11: a second rotation during the overlap is rotation_in_progress; early expiry works once; the overlap can end by time', async () => {
      const site = await t.site(w);
      const first = await owner()
        .post(`${base()}/${site.id}/rotate-secret`)
        .send({})
        .expect(201);
      const sealedBefore = (await stored(site.id)).identitySecretSealed;
      const again = await owner()
        .post(`${base()}/${site.id}/rotate-secret`)
        .send({})
        .expect(409);
      expect(again.body.code).toBe('rotation_in_progress');
      expect((await stored(site.id)).identitySecretSealed).toBe(sealedBefore);

      const expired = await owner()
        .post(`${base()}/${site.id}/expire-previous-secret`)
        .send({})
        .expect(200);
      expect(widgetSiteSchema.parse(expired.body)).toMatchObject({
        hasPreviousSecret: false,
        previousSecretExpiresAt: null,
      });
      const twice = await owner()
        .post(`${base()}/${site.id}/expire-previous-secret`)
        .send({})
        .expect(409);
      expect(twice.body.code).toBe('rotation_not_in_progress');
      const events = await outboxEvents(t.app, EVENT, { aggregateId: site.id });
      expect(events.map((e) => e.payload.change)).toEqual([
        'created',
        'secret_rotated',
        'previous_secret_expired',
      ]);
      expect(first.body.identitySecret).toBeDefined();

      // after the overlap time passed, a new rotation is allowed again
      await owner()
        .post(`${base()}/${site.id}/rotate-secret`)
        .send({ overlapHours: 1 })
        .expect(201);
      await owner()
        .post(`${base()}/${site.id}/rotate-secret`)
        .send({})
        .expect(409);
      t.advance(3_600_000);
      await t.reauth(w.owner); // the access token is 5 minutes old by the test clock
      await owner()
        .post(`${base()}/${site.id}/rotate-secret`)
        .send({})
        .expect(201);
    });

    it('S44 AS-11: two rotations at once on a site without a previous secret: exactly one 201, one rotation_in_progress, 20 rounds', async () => {
      for (let round = 0; round < 20; round += 1) {
        await clearRateLimits(t.app);
        const site = await t.site(w);
        const results = await Promise.all([
          owner().post(`${base()}/${site.id}/rotate-secret`).send({}),
          owner().post(`${base()}/${site.id}/rotate-secret`).send({}),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        const row = await stored(site.id);
        expect(row.previousIdentitySecretSealed).not.toBeNull();
        expect(row.previousIdentitySecretSealed).not.toBe(
          row.identitySecretSealed,
        );
        const winner = results.find((r) => r.status === 201)!;
        expect(
          t.app
            .get(SecretBox)
            .open(row.identitySecretSealed, `widget-site:${site.id}`),
        ).toBe(winner.body.identitySecret);
        await owner().delete(`${base()}/${site.id}`).expect(204);
      }
    });
  });

  describe('delete (AS-12)', () => {
    it('S44 AS-12: delete removes the row and applies on every instance at the next request', async () => {
      const second = await t.instance();
      const site = await t.site(w);
      const config = (http: () => ReturnType<typeof t.http>) =>
        http()
          .get(`/api/widget/v1/config?key=${site.publishableKey}`)
          .set('Origin', ORIGIN);
      await config(t.http).expect(200);
      await config(second.http).expect(200);

      await owner().delete(`${base()}/${site.id}`).expect(204);
      expect(
        await rows(t.app, `SELECT 1 FROM "WidgetSite" WHERE id = :id`, {
          id: site.id,
        }),
      ).toHaveLength(0);
      const events = await outboxEvents(t.app, EVENT, { aggregateId: site.id });
      expect(events.map((e) => e.payload.change)).toEqual([
        'created',
        'deleted',
      ]);

      for (const http of [t.http, second.http]) {
        const cfg = await config(http).expect(404);
        expect(cfg.body.code).toBe('widget_site_not_found');
        const embed = await http()
          .get(`/api/widget/v1/embed?key=${site.publishableKey}`)
          .expect(404);
        expect(embed.body.code).toBe('widget_site_not_found');
        const identify = await http()
          .post('/api/widget/v1/identify')
          .set('Origin', ORIGIN)
          .send({ key: site.publishableKey, token: t.handoff(site) })
          .expect(404);
        expect(identify.body.code).toBe('widget_site_not_found');
      }
      const again = await owner().delete(`${base()}/${site.id}`).expect(404);
      expect(again.body.code).toBe('widget_site_not_found');
    });
  });

  describe('CSRF on the dashboard (AS-13)', () => {
    const front = () => t.app.get(ApiConfigService).get('front_host');

    it('S44 AS-13: a cookie-authenticated mutation needs the CSRF token; bearer calls need none; same on every mutation route', async () => {
      const { cookie, csrf } = t.cookieSession(w.owner);
      const withCookie = (
        method: 'post' | 'patch' | 'put' | 'delete',
        url: string,
        token?: string,
      ) => {
        const req = t
          .http()
          [method](url)
          .set('Cookie', cookie)
          .set('Origin', front());
        return token ? req.set('X-CSRF-Token', token) : req;
      };

      const refused = await withCookie('post', base())
        .send({ origins: [ORIGIN] })
        .expect(403);
      expect(refused.body.code).toBe('csrf_invalid');
      expect(await count()).toBe(0);
      const ok = await withCookie('post', base(), csrf)
        .send({ origins: [ORIGIN] })
        .expect(201);
      expect(ok.body.id).toBeDefined();
      const bearer = await owner()
        .post(base())
        .send({ origins: [ORIGIN] })
        .expect(201);
      expect(bearer.body.id).toBeDefined();

      const id = ok.body.id as string;
      const mutations: [
        string,
        'post' | 'patch' | 'put' | 'delete',
        string,
        object,
        number,
      ][] = [
        [
          'update',
          'patch',
          `${base()}/${id}`,
          { name: 'csrf', expectedVersion: 1 },
          200,
        ],
        ['rotate', 'post', `${base()}/${id}/rotate-secret`, {}, 201],
        ['expire', 'post', `${base()}/${id}/expire-previous-secret`, {}, 200],
        [
          'kill switch',
          'put',
          `${base()}/${id}/kill-switch`,
          { on: true },
          200,
        ],
        ['delete', 'delete', `${base()}/${id}`, {}, 204],
      ];
      for (const [name, method, url, body, success] of mutations) {
        const denied = await withCookie(method, url).send(body);
        if (denied.status !== 403 || denied.body.code !== 'csrf_invalid')
          throw new Error(
            `${name} without token: ${denied.status} ${JSON.stringify(denied.body)}`,
          );
        const allowed = await withCookie(method, url, csrf).send(body);
        if (allowed.status !== success)
          throw new Error(
            `${name} with token: ${allowed.status} ${JSON.stringify(allowed.body)}`,
          );
      }
      expect(
        await rows(t.app, `SELECT 1 FROM "WidgetSite" WHERE id = :id`, { id }),
      ).toHaveLength(0);
    });
  });

  describe('history', () => {
    it('S44 AS-39: the history lists kill switch changes newest first with an opaque cursor, shop scoped', async () => {
      const site = await t.site(w);
      for (const on of [true, false, true]) {
        await owner()
          .put(`${base()}/${site.id}/kill-switch`)
          .send({ on })
          .expect(200);
        t.advance(1000);
      }
      const first = await owner()
        .get(`${base()}/${site.id}/history?limit=2`)
        .expect(200);
      const page = widgetSiteHistoryPageSchema.parse(first.body);
      expect(page.items.map((i) => i.change)).toEqual([
        'kill_switch_on',
        'kill_switch_off',
      ]);
      expect(page.items[0]).toMatchObject({
        from: 'false',
        to: 'true',
        actorId: w.owner.id,
      });
      expect(page.nextCursor).toBeTruthy();
      const second = await owner()
        .get(`${base()}/${site.id}/history?limit=2&cursor=${page.nextCursor}`)
        .expect(200);
      expect(
        widgetSiteHistoryPageSchema
          .parse(second.body)
          .items.map((i) => i.change),
      ).toEqual(['kill_switch_on']);
      expect(second.body.nextCursor).toBeNull();
    });
  });
});

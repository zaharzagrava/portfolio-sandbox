import { widgetConfigSchema } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { v4 as uuidv4 } from 'uuid';
import * as siteRules from './domain/site-rules';
import { WidgetSiteCache } from './application/widget-site.cache';
import {
  clearRateLimits,
  createWidgetKit,
  exec,
  fastStoreOf,
  ORIGIN,
  ORIGIN_2,
  restoreFastStore,
  rows,
  type CreatedSite,
  type WidgetKit,
  type WidgetWorld,
} from './testing/widget-kit';

const STRIP = (body: Record<string, unknown>) => ({
  ...body,
  requestId: undefined,
  instance: undefined,
});

describe('Widget: origin binding, config and CORS', () => {
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
  afterEach(async () => {
    jest.restoreAllMocks();
    await restoreFastStore(t);
  });

  const config = (key: string, origin: string | string[] | null = ORIGIN) => {
    const req = t
      .http()
      .get(`/api/widget/v1/config?key=${encodeURIComponent(key)}`);
    return origin === null ? req : req.set('Origin', origin as string);
  };
  const dashboard = (site: CreatedSite) =>
    `/api/shops/${w.shop.id}/widget/sites/${site.id}`;

  describe('config (AS-14, AS-19)', () => {
    it('S44 AS-14: a registered origin gets the shaped configuration with the exact headers, from one catalog batch', async () => {
      const inStock = await t.product(w, {
        title: 'Earbuds',
        priceMinor: 12_900,
        quantity: 3,
      });
      const soldOut = await t.product(w, {
        title: 'Case',
        priceMinor: 500,
        quantity: 0,
      });
      const site = await t.site(w, {
        featuredProductIds: [inStock.id, soldOut.id],
      });

      t.faults.catalogCalls.length = 0;
      const res = await config(site.publishableKey).expect(200);
      const body = widgetConfigSchema.parse(res.body);
      expect(body).toMatchObject({
        version: 'v1',
        shop: { name: 'My Shop' },
        theme: {},
        products: [
          {
            id: inStock.id,
            title: 'Earbuds',
            price: { amountMinor: 12_900, currency: 'USD' },
            inStock: true,
          },
          {
            id: soldOut.id,
            title: 'Case',
            price: { amountMinor: 500, currency: 'USD' },
            inStock: false,
          },
        ],
      });
      expect(Number.isInteger(body.products[0].price.amountMinor)).toBe(true);
      expect(body.checkoutUrl).toBe(
        `${t.app.get(ApiConfigService).get('front_host')}/embed/checkout`,
      );

      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(res.headers.vary).toMatch(/Origin/);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=60, s-maxage=60',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();

      expect(t.faults.catalogCalls).toEqual([
        { shopId: w.shop.id, ids: [inStock.id, soldOut.id] },
      ]);
      const text = JSON.stringify(res.body);
      for (const secret of [
        w.shop.id,
        ORIGIN,
        ORIGIN_2,
        site.identitySecret,
        site.id,
      ])
        expect(text).not.toContain(secret);
    });

    it('S44 AS-19: only live products of the shop appear, in the configured order; stale lists shrink; none left is []', async () => {
      const other = await t.world();
      const p3 = await t.product(w);
      const p1 = await t.product(w);
      const p2 = await t.product(w);
      const foreign = await t.product(other);
      const site = await t.site(w, {
        featuredProductIds: [p3.id, p1.id, p2.id],
      });
      await t.archive(w, p2.id);
      // a product of another shop and an unknown one "somehow" sit in the list (written behind the API)
      await exec(
        t.app,
        `UPDATE "WidgetSite" SET "featuredProductIds" = CAST(:ids AS uuid[]) WHERE id = :id`,
        {
          id: site.id,
          ids: `{${[p3.id, foreign.id, p1.id, p2.id, uuidv4()].join(',')}}`,
        },
      );
      await t.app.get(WidgetSiteCache).invalidate([site.publishableKey]);

      const res = await config(site.publishableKey).expect(200);
      expect(res.body.products.map((p: { id: string }) => p.id)).toEqual([
        p3.id,
        p1.id,
      ]);

      await exec(
        t.app,
        `UPDATE "WidgetSite" SET "featuredProductIds" = CAST(:ids AS uuid[]) WHERE id = :id`,
        { id: site.id, ids: `{${p2.id}}` },
      );
      await t.app.get(WidgetSiteCache).invalidate([site.publishableKey]);
      const none = await config(site.publishableKey).expect(200);
      expect(none.body.products).toEqual([]);
    });

    it('S44 AS-19: price and stock are the current values once the 60 second fresh window has passed', async () => {
      const product = await t.product(w, { quantity: 3 });
      const site = await t.site(w, { featuredProductIds: [product.id] });
      expect(
        (await config(site.publishableKey).expect(200)).body.products[0]
          .inStock,
      ).toBe(true);
      const read = await t
        .as(w.owner)
        .get(`/api/shops/${w.shop.id}/products/${product.id}`);
      await t
        .as(w.owner)
        .patch(`/api/shops/${w.shop.id}/products/${product.id}`)
        .send({
          expectedVersion: read.body.version,
          quantity: 0,
          priceMinor: 700,
        })
        .expect(200);
      t.advance(61_000);
      const fresh = await config(site.publishableKey).expect(200);
      expect(fresh.body.products[0]).toMatchObject({
        inStock: false,
        price: { amountMinor: 700 },
      });
    });
  });

  describe('origin matching and refusals (AS-15, AS-16)', () => {
    it('S44 AS-15: a scheme, a port and a suffix look-alike mismatch are each refused on config', async () => {
      const site = await t.site(w);
      for (const origin of [
        'http://www.my-shop.com',
        'https://shop.example',
        'https://evil-www.my-shop.com',
      ]) {
        const res = await config(site.publishableKey, origin).expect(403);
        expect(res.body.code).toBe('origin_not_allowed');
      }
    });

    it('S44 AS-15: SC-001, 30+ wrong-origin variants are refused on config, identify and preflight, without any shop data', async () => {
      const product = await t.product(w, { title: 'Earbuds' });
      const site = await t.site(w, { featuredProductIds: [product.id] });
      const wrong = [
        'http://www.my-shop.com',
        'https://my-shop.com',
        'https://evil-www.my-shop.com',
        'https://www.my-shop.com.evil.com',
        'https://www.my-shop.com@evil.com',
        'https://evilwww.my-shop.com',
        'https://shop.example',
        'https://shop.example:8444',
        'https://sub.www.my-shop.com',
        'null',
        '',
        'https://www.my-shop.com/',
        'https://www.my-shop.com/path',
        'https://www.my-shop.com, https://shop.example:8443',
        'ftp://www.my-shop.com',
        'https://www.my-shop.com:8443',
        'https://WWW.MY-SHOP.COM.',
        'https://localhost',
        'https://127.0.0.1',
        'https://xn--ww-ymc.my-shop.com',
        'https://[::1]',
        'file://',
        'chrome-extension://abcdef',
        'https://*.my-shop.com',
        'https://my-shop.com.www.my-shop.com',
        'https://www.my-shop.co',
        'https://www.my-shop.comx',
        'https://xwww.my-shop.com',
        'https://www-my-shop.com',
        'https://shop.example:84430',
        'https://shop.example:80',
        'HTTP://WWW.MY-SHOP.COM',
      ];
      expect(wrong.length).toBeGreaterThanOrEqual(30);
      for (const origin of wrong) {
        await clearRateLimits(t.app); // 3 calls per variant would meet the 30 a minute of identify
        const cfg =
          origin === ''
            ? await config(site.publishableKey, null)
            : await config(site.publishableKey, origin);
        const identify = await t
          .http()
          .post('/api/widget/v1/identify')
          .set('Origin', origin)
          .send({ key: site.publishableKey, token: t.handoff(site) });
        const preflight = await t
          .http()
          .options(`/api/widget/v1/identify?key=${site.publishableKey}`)
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST');
        for (const res of [cfg, identify, preflight]) {
          if (res.status !== 403 || res.body.code !== 'origin_not_allowed')
            throw new Error(
              `origin ${JSON.stringify(origin)} -> ${res.status} ${JSON.stringify(res.body)}`,
            );
          expect(res.headers['access-control-allow-origin']).toBeUndefined();
          expect(JSON.stringify(res.body)).not.toMatch(
            /My Shop|Earbuds|identitySecret/,
          );
        }
      }
    });

    it('S44 AS-16: no Origin, Origin null, a wrong host, http and two Origin headers are the same 403, uncached, with no CORS header', async () => {
      const site = await t.site(w);
      const attempts: Awaited<ReturnType<typeof config>>[] = [];
      for (const origin of [
        'https://evil.example',
        'http://www.my-shop.com',
        null,
        'null',
        [ORIGIN, 'https://evil.example'],
      ])
        attempts.push(await config(site.publishableKey, origin));
      const first = STRIP(attempts[0].body);
      for (const res of attempts) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('origin_not_allowed');
        expect(STRIP(res.body)).toEqual(first);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect(res.headers['cache-control']).toBe('no-store');
        expect(JSON.stringify(res.body)).not.toContain('My Shop');
      }
    });

    it('S44 AS-16: the order of checks is key, origin, switch: an unregistered origin cannot learn that a site is off', async () => {
      const site = await t.site(w);
      await t
        .as(w.owner)
        .put(`${dashboard(site)}/kill-switch`)
        .send({ on: true })
        .expect(200);
      expect(
        (await config(site.publishableKey, 'https://evil.example')).status,
      ).toBe(403);
      expect((await config(site.publishableKey, ORIGIN)).status).toBe(410);
      expect((await config(`pk_live_${'x'.repeat(24)}`, ORIGIN)).status).toBe(
        404,
      );
    });
  });

  describe('unknown and malformed keys (AS-17)', () => {
    it('S44 AS-17: every unknown or malformed key is the same 404, uncached', async () => {
      const keys = [
        '',
        'pk_live_x',
        'x'.repeat(500),
        `pk_test_${'a'.repeat(24)}`,
        `pk_live_${'a'.repeat(23)}!`,
        `pk_live_${'a'.repeat(24)}`,
      ];
      const bodies: Record<string, unknown>[] = [];
      for (const key of keys) {
        const res = await config(key);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('widget_site_not_found');
        expect(res.headers['cache-control']).toBe('no-store');
        bodies.push(STRIP(res.body));
      }
      const none = await t
        .http()
        .get('/api/widget/v1/config')
        .set('Origin', ORIGIN)
        .expect(404);
      bodies.push(STRIP(none.body));
      for (const b of bodies) expect(b).toEqual(bodies[0]);
    });

    it('S44 AS-17: a malformed key never becomes a cache key; a well-formed unknown key is remembered for at most 30 seconds', async () => {
      const redis = t.app.get(RedisService).client;
      const before = await redis.keys('widget-*');
      await config('x'.repeat(100)).expect(404);
      await config('pk_live_short').expect(404);
      expect(await redis.keys('widget-*')).toEqual(before);

      const key = `pk_live_${'q'.repeat(24)}`;
      await config(key).expect(404);
      expect((await redis.keys('widget-site*')).length).toBe(before.length + 1);
      // a site with that key appears behind the API: the memory hides it, but not for long
      const site = await t.site(w);
      await exec(
        t.app,
        `UPDATE "WidgetSite" SET "publishableKey" = :key WHERE id = :id`,
        { key, id: site.id },
      );
      expect((await config(key)).status).toBe(404);
      t.advance(31_000);
      expect((await config(key)).status).toBe(200);
    });
  });

  describe('preflight (AS-18)', () => {
    it('S44 AS-18: a registered origin gets exactly the grant of the three routes; unknown keys and origins get 403 and no header', async () => {
      const site = await t.site(w);
      for (const route of ['identify', 'config', 'session']) {
        const res = await t
          .http()
          .options(`/api/widget/v1/${route}?key=${site.publishableKey}`)
          .set('Origin', ORIGIN)
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'content-type')
          .expect(204);
        expect(res.headers).toMatchObject({
          'access-control-allow-origin': ORIGIN,
          'access-control-allow-methods': 'GET, POST',
          'access-control-allow-headers': 'Content-Type, Authorization',
          'access-control-max-age': '600',
        });
        expect(res.headers.vary).toMatch(/Origin/);
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      }
      for (const [key, origin] of [
        [site.publishableKey, 'https://evil.example'],
        [`pk_live_${'z'.repeat(24)}`, ORIGIN],
        ['malformed', ORIGIN],
      ]) {
        const res = await t
          .http()
          .options(`/api/widget/v1/identify?key=${key}`)
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST')
          .expect(403);
        expect(res.body.code).toBe('origin_not_allowed');
        expect(
          Object.keys(res.headers).filter((h) =>
            h.startsWith('access-control-'),
          ),
        ).toEqual([]);
      }
    });
  });

  describe('changes are visible at once on every instance (AS-20)', () => {
    it('S44 AS-20: an origin removal, a kill switch and a creation after a negative lookup apply on the next request on both instances', async () => {
      const second = await t.instance();
      const site = await t.site(w);
      const both = (origin = ORIGIN) => [
        config(site.publishableKey, origin),
        t.instance === undefined
          ? config(site.publishableKey, origin)
          : second
              .http()
              .get(`/api/widget/v1/config?key=${site.publishableKey}`)
              .set('Origin', origin),
      ];
      for (const r of await Promise.all(both())) expect(r.status).toBe(200);

      await t
        .as(w.owner)
        .patch(dashboard(site))
        .send({ allowedOrigins: [ORIGIN_2], expectedVersion: 1 })
        .expect(200);
      for (const r of await Promise.all(both())) expect(r.status).toBe(403);
      const embed = await second
        .http()
        .get(`/api/widget/v1/embed?key=${site.publishableKey}`)
        .expect(200);
      expect(embed.headers['content-security-policy']).toContain(
        `frame-ancestors ${ORIGIN_2};`.replace(';', ''),
      );
      expect(embed.headers['content-security-policy']).not.toContain(ORIGIN);

      for (const r of await Promise.all(both(ORIGIN_2)))
        expect(r.status).toBe(200);
      await t
        .as(w.owner)
        .put(`${dashboard(site)}/kill-switch`)
        .send({ on: true })
        .expect(200);
      for (const r of await Promise.all(both(ORIGIN_2)))
        expect(r.status).toBe(410);
    });

    it('S44 AS-20: a key looked up and not found a moment ago resolves as soon as the site is created', async () => {
      const key = `pk_live_${'k'.repeat(24)}`;
      expect((await config(key)).status).toBe(404);
      jest.spyOn(siteRules, 'generatePublishableKey').mockReturnValue(key);
      const site = await t.site(w);
      expect(site.publishableKey).toBe(key);
      expect((await config(key)).status).toBe(200);
    });
  });

  describe('degradation (AS-21)', () => {
    it('S44 AS-21: with the product lookup down the last good response is served stale for 10 minutes, then 503; recovery is immediate', async () => {
      const product = await t.product(w);
      const site = await t.site(w, { featuredProductIds: [product.id] });
      const good = await config(site.publishableKey).expect(200);

      t.advance(61_000);
      t.faults.catalogDown = true;
      const stale = await config(site.publishableKey).expect(200);
      expect(stale.body).toEqual(good.body);
      expect(stale.headers['cache-control']).toBe(
        'public, max-age=0, s-maxage=15',
      );
      expect(stale.headers.warning).toBe('110 - "Response is Stale"');

      t.advance(600_000);
      const gone = await config(site.publishableKey).expect(503);
      expect(gone.body.code).toBe('service_unavailable');
      expect(gone.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(gone.body)).not.toContain('catalog is down');

      t.faults.catalogDown = false;
      const recovered = await config(site.publishableKey).expect(200);
      expect(recovered.headers['cache-control']).toBe(
        'public, max-age=60, s-maxage=60',
      );
    });

    it('S44 AS-21: with no copy at all a failing lookup is 503 and is never cached as success', async () => {
      const product = await t.product(w);
      const site = await t.site(w, { featuredProductIds: [product.id] });
      t.faults.catalogDown = true;
      const down = await config(site.publishableKey).expect(503);
      expect(down.body.code).toBe('service_unavailable');
      t.faults.catalogDown = false;
      await config(site.publishableKey).expect(200);
    });
  });

  describe('rate limits and fail modes (AS-22)', () => {
    const scan = async (pattern: string) =>
      t.app.get(RedisService).client.keys(pattern);

    it('S44 AS-22: identify is limited per address (30 a minute) with Retry-After and RateLimit headers, on its own policy', async () => {
      const site = await t.site(w);
      let last;
      for (let i = 0; i < 31; i += 1)
        last = await t
          .http()
          .post('/api/widget/v1/identify')
          .set('Origin', ORIGIN)
          .send({ key: site.publishableKey, token: 'not-a-token' });
      expect(last!.status).toBe(429);
      expect(last!.body.code).toBe('rate_limited');
      expect(last!.headers['retry-after']).toBeDefined();
      expect(last!.headers.ratelimit).toBeDefined();
      expect((await scan('rl:*widget.identify.ip*')).length).toBeGreaterThan(0);
      expect((await scan('rl:*widget.identify.site*')).length).toBeGreaterThan(
        0,
      );
      expect(await scan('rl:*auth.login*')).toEqual([]);
    });

    it('S44 AS-22: config is limited per address (600 a minute) and keeps its own counter', async () => {
      const site = await t.site(w);
      let refused = 0;
      for (let batch = 0; batch < 7; batch += 1) {
        const results = await Promise.all(
          Array.from({ length: 100 }, () => config(site.publishableKey)),
        );
        refused += results.filter((r) => r.status === 429).length;
      }
      expect(refused).toBeGreaterThan(0);
      expect((await scan('rl:*widget.config.ip*')).length).toBeGreaterThan(0);
    });

    it('S44 AS-22: with the limiter store down config is still served and identify answers 503 without minting a token', async () => {
      const site = await t.site(w);
      await fastStoreOf(t.app).deny('rl:');
      const cfg = await config(site.publishableKey);
      expect(cfg.status).toBe(200);
      const identify = await t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .send({ key: site.publishableKey, token: t.handoff(site) });
      expect(identify.status).toBe(503);
      expect(identify.body.widgetToken).toBeUndefined();
      expect(identify.body.code).toBe('rate_limiter_unavailable');
      await restoreFastStore(t);
      const ok = await t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .send({ key: site.publishableKey, token: t.handoff(site) });
      expect([ok.status, ok.body.code]).toEqual([200, undefined]);
    });
  });

  it('S44 AS-53: a GET ignores a request body and changes no stored state', async () => {
    const site = await t.site(w);
    const before = await rows(
      t.app,
      `SELECT * FROM "WidgetSite" WHERE id = :id`,
      { id: site.id },
    );
    await t
      .http()
      .get(`/api/widget/v1/config?key=${site.publishableKey}`)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send({ killSwitch: true, key: 'other' })
      .expect(200);
    expect(
      await rows(t.app, `SELECT * FROM "WidgetSite" WHERE id = :id`, {
        id: site.id,
      }),
    ).toEqual(before);
  });
});

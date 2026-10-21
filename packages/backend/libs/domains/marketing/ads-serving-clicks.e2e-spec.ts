import * as http from 'node:http';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import {
  adClickRecordSchema,
  problemDetailsSchema,
  sponsoredSlotsResponseSchema,
  type AdCampaign,
  type SponsoredSlot,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { inParallel } from '@app/test/utils/async-helpers';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  hashAddress,
  hashViewer,
  keyIdOf,
  signClickToken,
  verifyClickToken,
  type ClickClaims,
  type TokenKeys,
} from './domain/click-token';
import { TOKEN_TTL_MS } from './domain/ads-constants';
import { formatReceivedAt } from './domain/click-record';
import { clickKey } from './domain/hot-key-salt';
import {
  FRONT,
  createAdsApp,
  type AdsTestApp,
  type Team,
} from './testing/ads.fixtures';

/** The one address the app is configured to trust as a proxy (`TRUSTED_PROXIES`); the test's own peer, 127.0.0.1, is not. */
const PROXY = '127.0.0.2';

describe('Sponsored listings: serving and clicks', () => {
  let t: AdsTestApp;

  beforeAll(async () => {
    t = await createAdsApp({
      redisProxy: true,
      env: { TRUSTED_PROXIES: PROXY },
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const problem = (res: { body: unknown }) =>
    problemDetailsSchema.parse(res.body);
  const impressions = (result: string) =>
    MetricsRegistry.value('ads_impressions_total', { result }) ?? 0;
  const keys = () => ({ current: t.config.get('ads_click_secret') });
  const tokenOf = (slot: SponsoredSlot) => slot.clickUrl.split('/').pop()!;
  const claimsOf = (slot: SponsoredSlot) => {
    const verdict = verifyClickToken(tokenOf(slot), keys(), t.clock.nowMs());
    if (!verdict.ok)
      throw new Error(`token does not verify: ${verdict.reason}`);
    return verdict.claims;
  };

  const serve = (query = '', headers: Record<string, string> = {}) => {
    let req = t.http().get(`/api/ads/sponsored${query}`);
    for (const [name, value] of Object.entries(headers))
      req = req.set(name, value);
    return req;
  };
  const slotsOf = (res: { body: unknown }) =>
    sponsoredSlotsResponseSchema.parse(res.body).items as SponsoredSlot[];

  /** A campaign of its own shop (the diversity rule gives one slot per shop). */
  const shopCampaign = async (
    cpcMinor: number,
    over: { category?: string; dailyBudgetMinor?: number; title?: string } = {},
  ): Promise<{ team: Team; campaign: AdCampaign }> => {
    const team = await t.team();
    const { campaign } = await t.campaign(team, {
      cpcMinor,
      dailyBudgetMinor: over.dailyBudgetMinor,
      product: { category: over.category ?? 'audio', title: over.title },
    });
    return { team, campaign };
  };

  describe('serving', () => {
    it('S36 AS-16: three eligible campaigns are served by CPC, labelled, with verifiable tokens and no CPC or budget in the body', async () => {
      const a = await shopCampaign(30);
      const b = await shopCampaign(20);
      const c = await shopCampaign(10);
      const served = impressions('served');

      const res = await serve('?category=audio');

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const body = sponsoredSlotsResponseSchema.parse(res.body);
      expect(body.generatedAt).toBe(t.clock.now().toISOString());
      expect(body.items.map((i) => i.campaignId)).toEqual([
        a.campaign.id,
        b.campaign.id,
        c.campaign.id,
      ]);
      for (const [i, item] of body.items.entries()) {
        const expected = [a, b, c][i];
        expect(item).toMatchObject({
          campaignId: expected.campaign.id,
          productId: expected.campaign.productId,
          shopId: expected.team.shop.id,
          currency: expect.any(String),
          sponsored: true,
          expiresAt: new Date(t.clock.nowMs() + TOKEN_TTL_MS).toISOString(),
        });
        expect(item.clickUrl).toMatch(/^\/api\/ads\/click\/[A-Za-z0-9_.-]+$/);
        expect(item.priceMinor).toBeGreaterThan(0);
        expect(claimsOf(item)).toMatchObject({
          c: item.campaignId,
          s: item.shopId,
          p: item.productId,
          e: t.clock.nowMs() + TOKEN_TTL_MS,
        });
      }
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/cpc|budget|viewer/i);
      expect(impressions('served')).toBe(served + 3);
    });

    it('S36 AS-17: category all (or none) serves every category, an unknown one serves none, an invalid one is 400', async () => {
      const audio = await shopCampaign(30, { category: 'audio' });
      const video = await shopCampaign(20, { category: 'video' });

      for (const query of ['?category=all', '']) {
        const items = slotsOf(await serve(query));
        expect(items.map((i) => i.campaignId)).toEqual([
          audio.campaign.id,
          video.campaign.id,
        ]);
      }
      expect(
        slotsOf(await serve('?category=video')).map((i) => i.campaignId),
      ).toEqual([video.campaign.id]);
      const none = await serve('?category=garden');
      expect(none.status).toBe(200);
      expect(none.body.items).toEqual([]);

      for (const bad of ['Audio', 'two%20words', 'x'.repeat(41), '']) {
        const res = await serve(`?category=${bad}`);
        expect(res.status).toBe(400);
        expect(problem(res).code).toBe('validation_failed');
      }
    });

    describe('S36 AS-18: eligibility filters and their reversal', () => {
      it.each([
        [
          'the campaign is paused',
          async (x: { team: Team; campaign: AdCampaign }) =>
            void (await t.act(
              x.team.owner,
              x.team.shop.id,
              x.campaign.id,
              'pause',
            )),
          async (x: { team: Team; campaign: AdCampaign }) =>
            void (await t.act(
              x.team.owner,
              x.team.shop.id,
              x.campaign.id,
              'resume',
            )),
        ],
        [
          'its product is archived',
          async (x: { campaign: AdCampaign }) =>
            t.setProductSnapshot(x.campaign.productId, { status: 'ARCHIVED' }),
          async (x: { campaign: AdCampaign }) =>
            t.setProductSnapshot(x.campaign.productId, { status: 'ACTIVE' }),
        ],
        [
          'its product is out of stock',
          async (x: { campaign: AdCampaign }) =>
            t.setProductSnapshot(x.campaign.productId, { inStock: false }),
          async (x: { campaign: AdCampaign }) =>
            t.setProductSnapshot(x.campaign.productId, { inStock: true }),
        ],
        [
          'its product is a sandbox product',
          async (x: { campaign: AdCampaign }) =>
            t.setProductSnapshot(x.campaign.productId, { isSandbox: true }),
          async (x: { campaign: AdCampaign }) =>
            t.setProductSnapshot(x.campaign.productId, { isSandbox: false }),
        ],
        [
          'its shop is suspended',
          async (x: { campaign: AdCampaign }) =>
            t.setShopSnapshot(x.campaign.shopId, { status: 'SUSPENDED' }),
          async (x: { campaign: AdCampaign }) =>
            t.setShopSnapshot(x.campaign.shopId, { status: 'ACTIVE' }),
        ],
        [
          'its shop is offboarding',
          async (x: { campaign: AdCampaign }) =>
            t.setShopSnapshot(x.campaign.shopId, { offboarding: true }),
          async (x: { campaign: AdCampaign }) =>
            t.setShopSnapshot(x.campaign.shopId, { offboarding: false }),
        ],
        [
          'today’s spend plus one click would exceed the daily budget',
          async (x: { campaign: AdCampaign }) => {
            // budget 1000 at CPC 25: 40 counted clicks leave no room for a 41st
            await t.redis.set(
              `adspend:{${x.campaign.id}}:${t.clock.now().toISOString().slice(0, 10)}`,
              '40',
            );
          },
          async (x: { campaign: AdCampaign }) => {
            await t.redis.set(
              `adspend:{${x.campaign.id}}:${t.clock.now().toISOString().slice(0, 10)}`,
              '39',
            );
          },
        ],
      ])('%s', async (_name, apply, revert) => {
        const x = await shopCampaign(25, { dailyBudgetMinor: 1000 });
        expect(slotsOf(await serve('?category=audio'))).toHaveLength(1);

        await apply(x as never);
        expect(slotsOf(await serve('?category=audio'))).toEqual([]);

        await revert(x as never);
        expect(
          slotsOf(await serve('?category=audio')).map((i) => i.campaignId),
        ).toEqual([x.campaign.id]);
      });

      it('an ended campaign is not served, and a product without a read model yet is not served', async () => {
        const ended = await shopCampaign(25);
        await t.act(
          ended.team.owner,
          ended.team.shop.id,
          ended.campaign.id,
          'end',
        );
        const unseen = await shopCampaign(25);
        await t.sql(
          `DELETE FROM "AdProductSnapshot" WHERE "productId" = :id RETURNING 1`,
          {
            id: unseen.campaign.productId,
          },
        );
        expect(slotsOf(await serve('?category=audio'))).toEqual([]);
      });
    });

    it('S36 AS-19: one slot per shop, equal CPC ordered by campaign id, limit bounds', async () => {
      const team = await t.team();
      const first = await t.campaign(team, { cpcMinor: 40 });
      await t.campaign(team, { cpcMinor: 35 });
      const b = await shopCampaign(30);
      const c = await shopCampaign(30);

      const ordered = [b.campaign.id, c.campaign.id].sort();
      const expected = [first.campaign.id, ...ordered];
      const one = slotsOf(await serve('?category=audio'));
      expect(one.map((i) => i.campaignId)).toEqual(expected);
      expect(
        slotsOf(await serve('?category=audio')).map((i) => i.campaignId),
      ).toEqual(expected);

      expect(
        slotsOf(await serve('?category=audio&limit=1')).map(
          (i) => i.campaignId,
        ),
      ).toEqual([first.campaign.id]);
      for (const limit of ['0', '4', 'x', '-1']) {
        const res = await serve(`?category=audio&limit=${limit}`);
        expect(res.status).toBe(400);
        expect(problem(res).code).toBe('validation_failed');
      }
    });

    it('S36 AS-20: every response carries fresh tokens, and the readable claims hold no user, anonymous id or address', async () => {
      await shopCampaign(25);
      const viewer: TestUser = await t.user();
      const headers = { 'x-anonymous-id': 'anon-secret-id-123' };

      const first = slotsOf(
        await t
          .as(viewer)
          .get('/api/ads/sponsored?category=audio')
          .set(headers),
      );
      const second = slotsOf(
        await t
          .as(viewer)
          .get('/api/ads/sponsored?category=audio')
          .set(headers),
      );

      expect(claimsOf(first[0]).i).not.toBe(claimsOf(second[0]).i);
      expect(tokenOf(first[0])).not.toBe(tokenOf(second[0]));
      const payload = Buffer.from(
        tokenOf(first[0]).split('.')[2],
        'base64url',
      ).toString();
      expect(Object.keys(JSON.parse(payload)).sort()).toEqual([
        'c',
        'e',
        'i',
        'p',
        's',
        'v',
      ]);
      for (const forbidden of [
        viewer.id,
        'anon-secret-id-123',
        '127.0.0.1',
        '::1',
        viewer.email,
      ])
        expect(payload).not.toContain(forbidden);
      expect(claimsOf(first[0]).v).toMatch(/^[0-9a-f]{32}$/);
      // the same viewer is the same hash on both responses; an anonymous viewer is another one
      expect(claimsOf(first[0]).v).toBe(claimsOf(second[0]).v);
      const anonymous = slotsOf(await serve('?category=audio', headers));
      expect(claimsOf(anonymous[0]).v).not.toBe(claimsOf(first[0]).v);
    });

    it('S36 AS-21: counters that are down or too slow serve no ads (and count it), a database that is down is a generic 503', async () => {
      await shopCampaign(25);
      const degraded = impressions('degraded');

      t.faults.set('spend', { kind: 'down' });
      let res = await serve('?category=audio');
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(impressions('degraded')).toBe(degraded + 1);
      t.faults.clear();

      t.redisProxy!.mode = 'hang'; // the store accepts and never answers: the 100 ms limit decides
      try {
        const started = Date.now();
        res = await serve('?category=audio');
        expect(res.status).toBe(200);
        expect(res.body.items).toEqual([]);
        expect(Date.now() - started).toBeLessThan(3_000);
      } finally {
        t.redisProxy!.mode = 'pass';
      }
      expect(impressions('degraded')).toBe(degraded + 2);

      t.faults.set('campaigns.serveCandidates', { kind: 'down' });
      res = await serve('?category=audio');
      expect(res.status).toBe(503);
      expect(problem(res).code).toBe('service_unavailable');
      expect(JSON.stringify(res.body)).not.toMatch(
        /campaign|sequelize|postgres|select/i,
      );
    });

    it('S36 AS-22: the 121st request in a minute is 429; a limiter that is down still serves', async () => {
      await shopCampaign(25);
      // 120 requests in waves of 30 at once (was one by one)
      for (let wave = 0; wave < 4; wave++) {
        const answers = await Promise.all(
          Array.from({ length: 30 }, () => serve('?category=audio')),
        );
        answers.forEach((ok, i) => {
          if (ok.status !== 200)
            throw new Error(`request ${wave * 30 + i + 1}: ${ok.status}`);
        });
      }
      const limited = await serve('?category=audio');
      expect(limited.status).toBe(429);
      expect(problem(limited).code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();

      t.redisProxy!.mode = 'refuse';
      try {
        const res = await serve('?category=audio');
        expect(res.status).toBe(200);
      } finally {
        t.redisProxy!.mode = 'pass';
      }
    });
  });

  describe('clicks', () => {
    const secret = () => t.config.get('ads_click_secret');
    const counter = (outcome: string) =>
      MetricsRegistry.value('ads_clicks_total', { outcome }) ?? 0;
    const location = (campaignProductId: string) =>
      `${FRONT}/p/${campaignProductId}?ad=1`;
    const HOME = `${FRONT}/`;

    /** A token signed like the serving endpoint would: the click path reads no database, so the ids need not exist. */
    const mint = (
      over: Partial<ClickClaims> = {},
      signWith: TokenKeys = { current: secret() },
    ) => {
      const claims: ClickClaims = {
        i: uuidv7(),
        c: uuidv4(),
        s: uuidv4(),
        p: uuidv4(),
        e: t.clock.nowMs() + TOKEN_TTL_MS,
        v: hashViewer(secret(), `anon:${uuidv4()}`),
        ...over,
      };
      return { claims, token: signClickToken(claims, signWith) };
    };
    const click = (
      token: string,
      headers: Record<string, string> = {},
      query = '',
    ) => {
      let req = t.http().get(`/api/ads/click/${token}${query}`).redirects(0);
      for (const [name, value] of Object.entries(headers))
        req = req.set(name, value);
      return req;
    };
    const records = () =>
      t.published
        .filter((m) => m.topic === 'ads.clicks')
        .map((m) => ({
          key: m.key,
          record: adClickRecordSchema.parse(m.value),
        }));
    const marker = (impressionId: string) =>
      t.redis.exists(`adclick:${impressionId}`);
    /** The address the socket shows, as the platform resolves it. */
    const PEER = '127.0.0.1';
    /**
     * A click that reaches the app through the configured trusted proxy: the app trusts 127.0.0.2 (`TRUSTED_PROXIES`), so
     * a request whose socket peer is 127.0.0.2 carries a believed `X-Forwarded-For`; the default supertest peer is
     * 127.0.0.1 and is not trusted.
     */
    const clickViaProxy = (token: string, forwardedFor: string) =>
      new Promise<{ status?: number; headers: Record<string, unknown> }>(
        (resolve, reject) => {
          const { port } = t.app.getHttpServer().address() as { port: number };
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: `/api/ads/click/${token}`,
              localAddress: PROXY,
              headers: { 'x-forwarded-for': forwardedFor },
            },
            (res) => {
              res.resume();
              res.on('end', () =>
                resolve({ status: res.statusCode, headers: res.headers }),
              );
            },
          );
          req.on('error', reject);
          req.end();
        },
      );

    it('S36 AS-26: a served impression clicked: 302 to the product, no-store, one salted record, a marker with its lifetime, no raw address', async () => {
      const x = await shopCampaign(25);
      const [slot] = slotsOf(await serve('?category=audio'));
      const claims = claimsOf(slot);
      const counted = counter('counted');

      const res = await click(tokenOf(slot));

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(location(x.campaign.productId));
      expect(res.headers['cache-control']).toBe('no-store');
      const [{ key, record }] = records();
      expect(records()).toHaveLength(1);
      expect(key).toMatch(new RegExp(`^${x.campaign.id}#[0-9]$`));
      expect(key).toBe(clickKey(x.campaign.id, claims.i));
      expect(record).toEqual({
        click_id: claims.i,
        campaign_id: x.campaign.id,
        shop_id: x.team.shop.id,
        product_id: x.campaign.productId,
        received_at: formatReceivedAt(t.clock.now()),
        ip_hash: hashAddress(secret(), PEER),
        viewer_hash: claims.v,
        valid: 1,
        invalid_reason: null,
      });
      const ttl = await t.redis.ttl(`adclick:${claims.i}`);
      expect(ttl).toBeGreaterThanOrEqual(2090);
      expect(ttl).toBeLessThanOrEqual(2100);
      expect(counter('counted')).toBe(counted + 1);
      // no raw address in any record, key, metric label or counter
      expect(JSON.stringify(records())).not.toContain(PEER);
      for (const redisKey of await t.redis.keys('ad*'))
        expect(redisKey).not.toContain(PEER);
    });

    describe('S36 AS-25: key rotation', () => {
      const OLD = 'previous-ads-click-secret-0123456789abcdef';

      it('a token of the previous key is counted while it is configured and invalid once removed; new tokens carry the current key id', async () => {
        const { claims, token } = mint({}, { current: OLD });
        t.config.set('ads_click_secret_previous', OLD);

        const ok = await click(token);
        expect(ok.status).toBe(302);
        expect(ok.headers.location).toBe(location(claims.p));
        expect(records()).toHaveLength(1);

        t.config.set('ads_click_secret_previous', undefined);
        const again = mint({}, { current: OLD });
        const refused = await click(again.token);
        expect(refused.status).toBe(302);
        expect(refused.headers.location).toBe(HOME);
        expect(records()).toHaveLength(1);

        await shopCampaign(25);
        const [slot] = slotsOf(await serve('?category=audio'));
        const verdict = verifyClickToken(
          tokenOf(slot),
          keys(),
          t.clock.nowMs(),
        );
        expect(verdict.ok && verdict.keyId).toBe(keyIdOf(secret()));
      });
    });

    it('S36 AS-27: the same token clicked again is a duplicate: the same redirect, nothing published', async () => {
      const { claims, token } = mint();
      expect((await click(token)).status).toBe(302);
      const duplicates = counter('duplicate');

      const second = await click(token, { 'x-forwarded-for': '198.51.100.9' });

      expect(second.status).toBe(302);
      expect(second.headers.location).toBe(location(claims.p));
      expect(records()).toHaveLength(1);
      expect(counter('duplicate')).toBe(duplicates + 1);
    });

    it('S36 AS-28: twenty simultaneous clicks on one token: all 302, exactly one record', async () => {
      const { claims, token } = mint();
      const counted = counter('counted');
      const duplicates = counter('duplicate');

      const results = await inParallel(20, () => click(token));

      for (const r of results) {
        const res = (
          r as PromiseFulfilledResult<{
            status: number;
            headers: Record<string, string>;
          }>
        ).value;
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(location(claims.p));
      }
      expect(records()).toHaveLength(1);
      expect(counter('counted')).toBe(counted + 1);
      expect(counter('duplicate')).toBe(duplicates + 19);
    });

    describe('S36 AS-29: invalid tokens always land on the storefront home', () => {
      const flip = (s: string, at: number) =>
        s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1);

      it('forged, altered, garbage, oversized, wrongly keyed and expired tokens: 302 home, nothing published, no marker, reason counted', async () => {
        const good = mint().token;
        const [v, kid, payload, signature] = good.split('.');
        const altered = mint({ c: uuidv4() }).token.split('.');
        const cases: Array<[string, string]> = [
          ['forged signature', [v, kid, payload, flip(signature, 3)].join('.')],
          [
            'payload altered after signing',
            [v, kid, altered[2], signature].join('.'),
          ],
          ['garbage', 'garbage'],
          ['x', 'x'],
          [
            'longer than 2,048 characters',
            `v1.${kid}.${'A'.repeat(2100)}.${signature}`,
          ],
          [
            'signed with an unknown secret',
            mint({}, { current: 'unknown-secret-0123456789abcdefghijklmnop' })
              .token,
          ],
        ];
        const invalid = counter('invalid_token');
        const expired = counter('expired');

        for (const [, token] of cases) {
          const res = await click(token);
          expect(res.status).toBe(302);
          expect(res.headers.location).toBe(HOME);
        }
        const old = mint();
        t.clock.advance(TOKEN_TTL_MS + 1_000); // T + 30 min + 1 s
        const late = await click(old.token);
        expect(late.status).toBe(302);
        expect(late.headers.location).toBe(HOME);

        expect(records()).toHaveLength(0);
        expect(await t.redis.keys('adclick:*')).toEqual([]);
        expect(counter('invalid_token')).toBe(invalid + cases.length);
        expect(counter('expired')).toBe(expired + 1);
      });

      it('an empty-looking token and a missing token also redirect home', async () => {
        const res = await t.http().get('/api/ads/click/x').redirects(0);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(HOME);
      });
    });

    it('S36 AS-30: injected redirect parameters and a spoofed host never change the target', async () => {
      const { claims, token } = mint();
      const res = await click(
        token,
        { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
        '?redirect=https://evil.example&next=//evil.example&url=//evil.example',
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(location(claims.p));
    });

    it.each([
      [
        'HEAD',
        (token: string) =>
          t.http().head(`/api/ads/click/${token}`).redirects(0),
      ],
      [
        'Sec-Purpose: prefetch',
        (token: string) => click(token, { 'sec-purpose': 'prefetch' }),
      ],
      [
        'Purpose: prefetch',
        (token: string) => click(token, { purpose: 'prefetch' }),
      ],
    ])(
      'S36 AS-31: %s is answered with the redirect, records nothing and leaves the impression unconsumed',
      async (_name, request) => {
        const { claims, token } = mint();
        const res = await request(token);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(location(claims.p));
        expect(records()).toHaveLength(0);
        expect(await marker(claims.i)).toBe(0);

        expect((await click(token)).status).toBe(302);
        expect(records()).toHaveLength(1);
        expect(records()[0].record.valid).toBe(1);
      },
    );

    describe('S36 AS-32: the client address is the platform’s, never a header’s', () => {
      it('behind no trusted proxy, forged CF-Connecting-IP / X-Forwarded-For collapse to the socket’s address and the burst filter applies', async () => {
        for (let i = 0; i < 30; i++)
          await click(mint().token, {
            'cf-connecting-ip': `203.0.113.${i + 1}`,
            'x-forwarded-for': `198.51.100.${i + 1}`,
          });
        const all = records().map((r) => r.record);
        expect(all).toHaveLength(30);
        expect(new Set(all.map((r) => r.ip_hash))).toEqual(
          new Set([hashAddress(secret(), PEER)]),
        );
        expect(all.filter((r) => r.valid === 1)).toHaveLength(20);
        expect(all.filter((r) => r.invalid_reason === 'ip_burst')).toHaveLength(
          10,
        );
      });

      it('behind a configured trusted proxy, the forwarded address it supplies is used', async () => {
        await clickViaProxy(mint().token, '203.0.113.7');
        // the first address that does not come from a trusted proxy, walking from the right
        await clickViaProxy(
          mint().token,
          '198.51.100.8, 203.0.113.9, 127.0.0.2',
        );
        expect(records().map((r) => r.record.ip_hash)).toEqual([
          hashAddress(secret(), '203.0.113.7'),
          hashAddress(secret(), '203.0.113.9'),
        ]);
      });
    });

    it.each(['pause', 'end'] as const)(
      'S36 AS-33: a click after the campaign was %sd is still recorded valid',
      async (action) => {
        const x = await shopCampaign(25);
        const [slot] = slotsOf(await serve('?category=audio'));
        await t.act(x.team.owner, x.team.shop.id, x.campaign.id, action);

        const res = await click(tokenOf(slot));

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(location(x.campaign.productId));
        expect(records().map((r) => r.record.valid)).toEqual([1]);
      },
    );

    describe('S36 AS-34: recording fails', () => {
      it.each(['down', 'hang'] as const)(
        'a stream that is %s: 302, the marker is removed, the click is counted once when the stream is back',
        async (mode) => {
          const { claims, token } = mint();
          const failed = counter('record_failed');
          t.producer(mode);

          const started = Date.now();
          const res = await click(token);

          expect(res.status).toBe(302);
          expect(res.headers.location).toBe(location(claims.p));
          expect(Date.now() - started).toBeLessThan(2_500);
          expect(await marker(claims.i)).toBe(0);
          expect(counter('record_failed')).toBe(failed + 1);
          expect(records()).toHaveLength(0);

          t.producer(null);
          expect((await click(token)).status).toBe(302);
          expect(records()).toHaveLength(1);
          expect(records()[0].record.valid).toBe(1);
        },
      );
    });

    describe('S36 AS-35: the dedupe and filter store is down', () => {
      it.each([
        [
          'the marker store fails',
          () => t.faults.set('marker', { kind: 'down' }),
        ],
        [
          'the spam counters fail',
          () => t.faults.set('spam', { kind: 'down' }),
        ],
      ])(
        '%s: 302, never a 5xx, recorded invalid filter_unavailable',
        async (_name, breakIt) => {
          const { claims, token } = mint();
          const before = counter('filter_unavailable');
          breakIt();

          const res = await click(token);

          expect(res.status).toBe(302);
          expect(res.headers.location).toBe(location(claims.p));
          expect(
            records().map((r) => [r.record.valid, r.record.invalid_reason]),
          ).toEqual([[0, 'filter_unavailable']]);
          expect(counter('filter_unavailable')).toBe(before + 1);
        },
      );

      it('a Redis that is unreachable gives the same answer', async () => {
        const { claims, token } = mint();
        t.redisProxy!.mode = 'refuse';
        try {
          const res = await click(token);
          expect(res.status).toBe(302);
          expect(res.headers.location).toBe(location(claims.p));
          expect(records().map((r) => r.record.invalid_reason)).toEqual([
            'filter_unavailable',
          ]);
        } finally {
          t.redisProxy!.mode = 'pass';
        }
      });
    });

    describe('S36 AS-38: an address burst is exact under concurrency', () => {
      it('25 simultaneous clicks from one address: all 302, exactly 20 valid and 5 ip_burst', async () => {
        const tokens = Array.from({ length: 25 }, () => mint().token); // distinct impressions, distinct campaigns
        const burst = counter('ip_burst');

        const results = await inParallel(25, (i) => click(tokens[i]));

        expect(
          results.every(
            (r) => r.status === 'fulfilled' && r.value.status === 302,
          ),
        ).toBe(true);
        const all = records().map((r) => r.record);
        expect(all).toHaveLength(25);
        expect(all.filter((r) => r.valid === 1)).toHaveLength(20);
        expect(
          all.filter((r) => r.valid === 0).map((r) => r.invalid_reason),
        ).toEqual(Array(5).fill('ip_burst'));
        expect(counter('ip_burst')).toBe(burst + 5);
      });

      it('sequentially the 20th click is valid and the 21st is not; the next UTC minute starts again', async () => {
        for (let i = 1; i <= 21; i++) await click(mint().token);
        const verdicts = records().map((r) => r.record.invalid_reason);
        expect(verdicts.slice(0, 20)).toEqual(Array(20).fill(null));
        expect(verdicts[20]).toBe('ip_burst');

        t.clock.advance(60_000);
        await click(mint().token);
        expect(records()[21].record).toMatchObject({
          valid: 1,
          invalid_reason: null,
        });
      });
    });

    describe('S36 AS-39: a repeat clicker on one campaign is recorded invalid', () => {
      it('the 4th impression of a campaign from one address within an hour; another campaign is unaffected; the next hour starts again', async () => {
        const campaign = uuidv4();
        for (let i = 0; i < 4; i++) await click(mint({ c: campaign }).token);
        expect(records().map((r) => r.record.invalid_reason)).toEqual([
          null,
          null,
          null,
          'repeat_clicker',
        ]);

        await click(mint({ c: uuidv4() }).token); // another campaign, same address
        expect(records()[4].record.valid).toBe(1);

        t.clock.advance(3_600_000);
        await click(mint({ c: campaign }).token);
        expect(records()[5].record.valid).toBe(1);
      });

      it('the same viewer clicking from four different addresses is caught by the viewer rule', async () => {
        const campaign = uuidv4();
        const viewer = hashViewer(secret(), 'anon:one-visitor');
        for (const address of [
          '203.0.113.1',
          '203.0.113.2',
          '203.0.113.3',
          '203.0.113.4',
        ])
          await clickViaProxy(mint({ c: campaign, v: viewer }).token, address);
        const all = records().map((r) => r.record);
        expect(new Set(all.map((r) => r.ip_hash)).size).toBe(4);
        expect(all.map((r) => r.invalid_reason)).toEqual([
          null,
          null,
          null,
          'repeat_clicker',
        ]);
      });
    });

    it('S36 AS-40: replays leave the counters alone: 100 replays publish nothing and a fresh token is still valid', async () => {
      const first = mint();
      await click(first.token);
      expect(records()).toHaveLength(1);

      for (let wave = 0; wave < 5; wave++)
        await inParallel(20, () =>
          click(first.token, { 'x-forwarded-for': '198.51.100.20' }),
        );
      expect(records()).toHaveLength(1);

      await click(mint().token);
      expect(records()).toHaveLength(2);
      expect(records()[1].record).toMatchObject({
        valid: 1,
        invalid_reason: null,
      });
    });

    it('S36 AS-36: 300 clicks with distinct tokens in one burst from one address all answer 302', async () => {
      const tokens = Array.from({ length: 300 }, () => mint().token);
      const statuses: number[] = [];
      for (let wave = 0; wave < 6; wave++) {
        const results = await inParallel(50, (i) =>
          click(tokens[wave * 50 + i]),
        );
        for (const r of results)
          statuses.push(r.status === 'fulfilled' ? r.value.status : -1);
      }
      expect(statuses.filter((s) => s !== 302)).toEqual([]);
      expect(statuses).toHaveLength(300);
      expect(records()).toHaveLength(300);
      expect(records().filter((r) => r.record.valid === 1)).toHaveLength(20);
    });
  });
});

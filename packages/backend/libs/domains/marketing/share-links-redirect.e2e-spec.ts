import { Logger } from '@nestjs/common';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { inParallel, waitFor } from '@app/test/utils/async-helpers';
import type { TestUser } from '@app/test/utils/catalog-app';
import { KafkaClickPublisher } from './infra/kafka-click.publisher';
import {
  FRONT,
  createShareLinksApp,
  type ShareLinksTestApp,
} from './testing/share-links.fixtures';

describe('Share links: redirect, caching and degradation', () => {
  let t: ShareLinksTestApp;
  let u1: TestUser;

  beforeAll(async () => {
    t = await createShareLinksApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    u1 = await t.user();
  });

  const metric = (name: string, labels: Record<string, string> = {}) =>
    MetricsRegistry.value(name, labels) ?? 0;
  const oneEvent = (code: string) =>
    waitFor(async () => {
      const events = t.eventsFor(code);
      return events.length > 0 ? events : null;
    });
  const quiet = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  /** A link whose row is written straight to the store, so no cache entry and no filter entry exist for it. */
  const planted = (over: Record<string, unknown> = {}) =>
    t.plant({
      code: t.alias('planted'),
      ownerId: u1.id,
      destination: t.destination(),
      ...over,
    });
  /** The error body without what differs per request. */
  const shape = (body: any) => {
    const { requestId, instance, traceId, ...rest } =
      problemDetailsSchema.parse(body);
    void requestId;
    void instance;
    void traceId;
    return rest;
  };

  it('S37 AS-23: an alias that did not exist answers 404 and, once claimed, 302 at once (no remembered miss)', async () => {
    const alias = t.alias();
    expect((await t.follow(alias)).status).toBe(404);
    expect(
      (await t.create(u1, { destination: t.destination(), alias })).status,
    ).toBe(201);
    expect((await t.follow(alias)).status).toBe(302);
  });

  describe('S37 AS-24 / AS-25: following a link', () => {
    it('S37 AS-24: 302 with ref, the exact Cache-Control, no cookie, an empty body and one click event after the response', async () => {
      const destination = t.destination('/p/iphone-17?color=blue');
      const code = await t.newLink(u1, { destination });

      const res = await t.follow(code, {
        'cf-ipcountry': 'DE',
        referer: 'https://news.example/some/path?token=secret',
      });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${destination}&ref=${code}`);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=0, s-maxage=10',
      );
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.text).toBe('');
      const [event] = await oneEvent(code);
      expect(event.value).toMatchObject({
        type: 'link.clicked',
        payload: {
          code,
          country: 'DE',
          referer: 'https://news.example',
          viaEdge: false,
        },
      });
      expect(t.eventsFor(code)).toHaveLength(1);
    });

    it('S37 AS-25: the reference goes after the query and before the fragment; other parameters stay as they were', async () => {
      const code = await t.newLink(u1, {
        destination: `${FRONT}/p/x?a=1&b=two%20words#reviews`,
      });
      expect((await t.follow(code)).headers.location).toBe(
        `${FRONT}/p/x?a=1&b=two%20words&ref=${code}#reviews`,
      );
    });
  });

  describe('S37 AS-26 / AS-27: codes that do not lead anywhere', () => {
    it('S37 AS-26: an unknown code answers 404 no-store, with no event and no store read once the filter is trusted', async () => {
      await t.rebuildFilter();
      const before = metric('link_resolve_total', { source: 'filter_reject' });
      t.calls.clear();

      const res = await t.follow('Zz9Zz9Z');

      expect(res.status).toBe(404);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(problemDetailsSchema.parse(res.body).code).toBe('link_not_found');
      expect(t.calls.get('repo.get') ?? 0).toBe(0);
      expect(metric('link_resolve_total', { source: 'filter_reject' })).toBe(
        before + 1,
      );
      await quiet();
      expect(t.published).toEqual([]);
    });

    it('S37 AS-27: malformed codes answer the same 404, read no store and record nothing', async () => {
      const unknown = await t.follow('Zz9Zz9Z');
      for (const code of [
        'abc',
        'a'.repeat(33),
        'a%24b',
        '..%2F..',
        'dr%C3%B3',
      ]) {
        t.calls.clear();
        const res = await t.follow(code);
        expect(res.status).toBe(404);
        expect(shape(res.body)).toEqual(shape(unknown.body));
        expect(t.calls.get('repo.get') ?? 0).toBe(0);
      }
      await quiet();
      expect(t.published).toEqual([]);
    });
  });

  describe('S37 AS-28 / AS-29: links that ended', () => {
    it('S37 AS-28: 302 at T+9 s, 410 with s-maxage=60 at T+10 s exactly and after; no click for the 410', async () => {
      const code = t.alias('expiring');
      const expiresAt = new Date(
        t.clock.now().getTime() + 10_000,
      ).toISOString();
      await planted({ code, expiresAt });

      t.clock.advance(9_000);
      expect((await t.follow(code)).status).toBe(302);
      await oneEvent(code);
      t.published.length = 0;

      t.clock.advance(1_000); // T + 10 s: the expiry instant itself
      const gone = await t.follow(code);
      expect(gone.status).toBe(410);
      expect(gone.headers['cache-control']).toBe('public, s-maxage=60');
      expect(problemDetailsSchema.parse(gone.body).code).toBe('link_gone');
      t.clock.advance(60_000);
      expect((await t.follow(code)).status).toBe(410);
      await quiet();
      expect(t.published).toEqual([]);
    });

    it('S37 AS-29: a disabled link answers the same 410 body as an expired one and records nothing', async () => {
      const code = await t.newLink(u1);
      await t.as(u1).post(`/api/links/${code}/disable`).expect(200);
      const expired = t.alias('expired');
      await planted({
        code: expired,
        expiresAt: new Date(t.clock.now().getTime() - 1).toISOString(),
      });

      const disabled = await t.follow(code);
      const lapsed = await t.follow(expired);

      expect(disabled.status).toBe(410);
      expect(shape(disabled.body)).toEqual(shape(lapsed.body));
      expect(disabled.headers['cache-control']).toBe('public, s-maxage=60');
      await quiet();
      expect(t.published).toEqual([]);
    });
  });

  describe('S37 AS-41 / AS-42: the origin side of the edge cache (the edge side is packages/edge-be/test/short-link.spec.ts)', () => {
    it('S37 AS-41: only the 302 the edge may cache yields a click; the answers the edge must not cache (404, 410) yield none and carry no 302 cache lifetime', async () => {
      const live = await t.newLink(u1);
      const gone = await t.newLink(u1);
      await t.as(u1).post(`/api/links/${gone}/disable`).expect(200);

      const ok = await t.follow(live);
      const missing = await t.follow('Zz9Zz9Z');
      const lapsed = await t.follow(gone);

      expect([ok.status, missing.status, lapsed.status]).toEqual([
        302, 404, 410,
      ]);
      expect(ok.headers['cache-control']).toBe(
        'public, max-age=0, s-maxage=10',
      );
      expect(missing.headers['cache-control']).toBe('no-store');
      await oneEvent(live);
      await quiet();
      expect(t.eventsFor(live)).toHaveLength(1);
      expect(t.eventsFor(gone)).toHaveLength(0);
      expect(t.published).toHaveLength(1);
    });

    it('S37 AS-42: the 302 allows an edge copy of at most 10 s, and after a disable the origin answers 410 at once', async () => {
      const code = await t.newLink(u1);
      const first = await t.follow(code);
      expect(first.status).toBe(302);
      expect(first.headers['cache-control']).toMatch(/s-maxage=10$/);

      await t.as(u1).post(`/api/links/${code}/disable`).expect(200);

      const after = await t.follow(code);
      expect(after.status).toBe(410);
      expect(after.headers['cache-control']).toBe('public, s-maxage=60');
    });
  });

  it('S37 AS-30: HEAD answers like GET without a click; other methods answer 405', async () => {
    const code = await t.newLink(u1);
    const head = await t.http().head(`/api/l/${code}`);
    expect(head.status).toBe(302);
    expect(head.headers.location).toContain(`ref=${code}`);
    expect(head.headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=10',
    );
    await quiet();
    expect(t.eventsFor(code)).toHaveLength(0);

    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await t.http()[method](`/api/l/${code}`).send({});
      expect(res.status).toBe(405);
    }
    expect(await t.stored(code)).toMatchObject({ status: 'ACTIVE' });
    await quiet();
    expect(t.eventsFor(code)).toHaveLength(0);
  });

  describe('S37 AS-31 / AS-32: the cache', () => {
    it('S37 AS-31: with the filter bypassed, a missing code is read once in 60 s and again after that', async () => {
      const code = t.alias('missing');
      t.calls.clear();
      for (let i = 0; i < 100; i++)
        expect((await t.follow(code)).status).toBe(404);
      expect(t.calls.get('repo.get')).toBe(1);

      t.clock.advance(67_000); // 60 s plus the cache's 10 % jitter
      expect((await t.follow(code)).status).toBe(404);
      expect(t.calls.get('repo.get')).toBe(2);
    });

    it('S37 AS-32: 500 simultaneous requests for a cold link cause one store read and the same Location', async () => {
      const warm = await planted();
      await t.follow(warm.code); // first use of the HTTP stack outlasts the store timers
      const link = await planted();
      t.calls.clear();

      const results = await inParallel(500, () => t.follow(link.code));

      const responses = results.map(
        (r) => (r as PromiseFulfilledResult<any>).value,
      );
      expect(responses.map((r) => r.status)).toEqual(Array(500).fill(302));
      expect(new Set(responses.map((r) => r.headers.location)).size).toBe(1);
      expect(t.calls.get('repo.get')).toBe(1);
    });
  });

  describe('S37 AS-33: the existence filter is lost', () => {
    it('serves a link while bypassed (and counts it), then a rebuild restores rejection without a store read', async () => {
      const link = await planted();
      const bypassed = metric('link_filter_bypassed_total');

      expect((await t.follow(link.code)).status).toBe(302);
      expect(metric('link_filter_bypassed_total')).toBe(bypassed + 1);

      expect(await t.rebuildFilter()).toMatchObject({ status: 'rebuilt' });
      t.calls.clear();
      expect((await t.follow('Zz9Zz9Z')).status).toBe(404);
      expect(t.calls.get('repo.get') ?? 0).toBe(0);
      expect(metric('link_filter_bypassed_total')).toBe(bypassed + 1);
      expect((await t.follow(link.code)).status).toBe(302); // re-added: not hidden
    });

    it('two simultaneous rebuilds → one runs and the other is a no-op', async () => {
      await planted();
      const results = await inParallel(2, () => t.rebuildFilter());
      const statuses = results
        .map(
          (r) => (r as PromiseFulfilledResult<{ status: string }>).value.status,
        )
        .sort();
      expect(statuses).toEqual(['rebuilt', 'skipped']);
    });

    it('an interrupted rebuild leaves the marker unset and the filter bypassed', async () => {
      await planted();
      t.faults.set('repo.scanCodes', { kind: 'down' });
      await expect(t.rebuildFilter()).rejects.toBeDefined();
      t.faults.clear();
      const bypassed = metric('link_filter_bypassed_total');
      t.calls.clear();
      expect((await t.follow('Zz9Zz9Z')).status).toBe(404);
      expect(t.calls.get('repo.get')).toBe(1); // not trusted: the store was asked
      expect(metric('link_filter_bypassed_total')).toBe(bypassed + 1);
    });
  });

  describe('S37 AS-34: the link store is down', () => {
    it('a warm cache keeps serving, a stale entry is served for up to 24 h and recovery needs nothing', async () => {
      const link = await planted();
      expect((await t.follow(link.code)).status).toBe(302);
      t.faults.set('repo', { kind: 'down' });

      expect((await t.follow(link.code)).status).toBe(302);
      t.clock.advance(2 * 3_600_000); // past the fresh hour
      expect((await t.follow(link.code)).status).toBe(302);
      t.clock.advance(24 * 3_600_000); // 26 h after the load: past 24 h of staleness even with the 10 % jitter
      const dead = await t.follow(link.code);
      expect(dead.status).toBe(503);
    });

    it('a cold cache answers 503 with Retry-After, never 404, remembers nothing and recovers at once', async () => {
      const link = await planted();
      t.faults.set('repo', { kind: 'down' });

      const res = await t.follow(link.code);

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'service_unavailable',
      );
      t.faults.clear();
      expect((await t.follow(link.code)).status).toBe(302);
    });
  });

  it('S37 AS-35: a stored destination that is no longer allowed answers 410, records nothing and is counted', async () => {
    const link = await planted({
      destination: 'https://elsewhere.example/phish',
    });
    const before = metric('link_destination_rejected_total');

    const res = await t.follow(link.code);

    expect(res.status).toBe(410);
    expect(res.headers.location).toBeUndefined();
    expect(metric('link_destination_rejected_total')).toBe(before + 1);
    await quiet();
    expect(t.published).toEqual([]);
  });

  describe('S37 AS-36: the click pipeline is degraded', () => {
    it('a refused publish still answers 302, counts one failure and logs one warning without visitor data', async () => {
      const code = await t.newLink(u1);
      t.producer('down');
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const before = metric('link_click_publish_failed_total');
      try {
        const res = await t.follow(code, {
          'cf-ipcountry': 'FR',
          referer: 'https://visitor.example/private/path?q=1',
        });
        expect(res.status).toBe(302);
        await waitFor(
          async () => metric('link_click_publish_failed_total') > before,
        );
        expect(metric('link_click_publish_failed_total')).toBe(before + 1);
        const lines = warn.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => /click event/.test(m));
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toMatch(
          /visitor\.example|private|FR|shop\.example|127\.0\.0\.1/,
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('a hanging publish does not delay the response', async () => {
      const code = await t.newLink(u1);
      await t.follow(code); // warm
      const started = Date.now();
      t.producer('hang');
      const res = await t.follow(code);
      expect(res.status).toBe(302);
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  describe('S37 AS-37: graceful shutdown', () => {
    it('waits for in-flight publishes (at most 5 s) before the pools close', async () => {
      const code = await t.newLink(u1);
      t.producer('slow');
      expect((await t.follow(code)).status).toBe(302);
      expect(t.eventsFor(code)).toHaveLength(0); // still in flight

      // the publisher registers its drain with the shutdown registry; run the stop phase of a registry it owns
      const registry = new ShutdownRegistry();
      const publisher = new KafkaClickPublisher(
        t.app.get(KafkaProducerService),
        registry,
      );
      const second = await planted();
      publisher.publish({
        eventId: '01a13679-0000-7000-8000-000000000001',
        type: 'link.clicked',
        version: 1,
        aggregateType: 'links',
        aggregateId: second.code,
        aggregateVersion: 1,
        occurredAt: t.clock.now().toISOString(),
        payload: {
          clickId: '01a13679-0000-7000-8000-000000000001',
          code: second.code,
          ts: t.clock.now().toISOString(),
          country: '',
          referer: '',
          viaEdge: false,
        },
      });
      const result = await registry.run('stop');

      expect(result.failed).toEqual([]);
      expect(t.eventsFor(second.code)).toHaveLength(1); // finished before shutdown went on
      await t.app.get(KafkaClickPublisher).drain(5_000);
      expect(t.eventsFor(code)).toHaveLength(1);
    });

    it('gives up on a hanging publish after the drain limit instead of blocking shutdown', async () => {
      const code = await t.newLink(u1);
      t.producer('hang');
      await t.follow(code);
      const started = Date.now();
      await t.app.get(KafkaClickPublisher).drain(300);
      expect(Date.now() - started).toBeLessThan(1_500);
    });
  });
});

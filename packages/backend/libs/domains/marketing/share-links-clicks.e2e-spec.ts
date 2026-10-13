import {
  linkClickedEventSchema,
  linkStatsSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { waitFor } from '@app/test/utils/async-helpers';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  AttributionUnavailableError,
  TooManyCodesError,
} from './application/link-attribution.service';
import { LinkClicksProjector } from './infra/link-clicks.projector';
import {
  createShareLinksApp,
  type ShareLinksTestApp,
} from './testing/share-links.fixtures';

describe('Share links: click events and attribution', () => {
  let t: ShareLinksTestApp;
  let u1: TestUser;

  beforeAll(async () => {
    t = await createShareLinksApp({ consumer: true });
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
  const quiet = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  const stats = async (user: TestUser, code: string, range = '24h') => {
    const res = await t.as(user).get(`/api/links/${code}/stats?range=${range}`);
    expect(res.status).toBe(200);
    return linkStatsSchema.parse(res.body);
  };
  /** Waits until the consumer has written `n` rows for the code. */
  const rows = (code: string, n: number) =>
    waitFor(
      async () => {
        const found = await t.clickRows(code);
        return found.length >= n ? found : null;
      },
      { description: `${n} click rows for ${code}`, timeoutMs: 30_000 },
    );

  describe('S37 AS-38: the click event', () => {
    it('carries the envelope, the code as key, the click id as event id and no visitor data', async () => {
      const destination = t.destination('/p/secret-product?token=abc');
      const code = await t.newLink(u1, { destination });

      const res = await t.follow(code, {
        'cf-ipcountry': 'FR',
        referer: 'https://news.example/path?private=1',
        'user-agent': 'UA-MARKER-123',
        cookie: 'sid=COOKIE-MARKER',
        'x-forwarded-for': '203.0.113.77',
      });
      expect(res.status).toBe(302);
      await waitFor(async () => t.eventsFor(code)[0]);
      const [message] = t.eventsFor(code);
      const event = message.value;

      expect(message.key).toBe(code);
      expect(linkClickedEventSchema.parse(event.payload)).toEqual({
        clickId: event.payload.clickId,
        code,
        ts: t.clock.now().toISOString(),
        country: 'FR',
        referer: 'https://news.example',
        viaEdge: false,
      });
      expect(event).toMatchObject({
        eventId: event.payload.clickId,
        type: 'link.clicked',
        version: 1,
        aggregateType: 'links',
        aggregateId: code,
        occurredAt: t.clock.now().toISOString(),
      });
      expect(event.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
      const text = JSON.stringify(event);
      for (const leaked of [
        'UA-MARKER-123',
        'COOKIE-MARKER',
        '203.0.113.77',
        u1.id,
        'secret-product',
        'token=abc',
        'private=1',
        '/path',
      ])
        expect(text).not.toContain(leaked);
    });
  });

  describe('S37 AS-40: the "already counted at the edge" flag', () => {
    const secret = () => t.config.get('share_link_edge_secret');

    it('is honoured with the shared credential: 302 and no event', async () => {
      const code = await t.newLink(u1);
      const res = await t.follow(code, {
        'x-edge-click-recorded': '1',
        'x-edge-credential': secret(),
      });
      expect(res.status).toBe(302);
      await quiet();
      expect(t.eventsFor(code)).toHaveLength(0);
    });

    it.each([
      ['missing', undefined],
      ['wrong', 'not-the-edge-secret-not-the-edge-secret'],
      ['a prefix of the real one', 'test-share-link-edge'],
    ])(
      'is ignored with a %s credential: one event with viaEdge false',
      async (_name, credential) => {
        const code = await t.newLink(u1);
        const res = await t.follow(code, {
          'x-edge-click-recorded': '1',
          ...(credential && { 'x-edge-credential': credential }),
        });
        expect(res.status).toBe(302);
        await waitFor(async () => t.eventsFor(code)[0]);
        expect(t.eventsFor(code)).toHaveLength(1);
        expect(t.eventsFor(code)[0].value.payload.viaEdge).toBe(false);
      },
    );
  });

  describe('S37 AS-43: duplicate delivery', () => {
    it('counts one click whatever the delivery count, before any merge, also after a restart', async () => {
      const code = await t.newLink(u1);
      const event = t.clickEvent(code);

      await t.deliver([event, event]);
      await rows(code, 1);
      await t.deliver([event]);
      await quiet(1_000);
      // a restarted consumer applies the same event again
      const restarted = new LinkClicksProjector(
        t.app.get(ClickHouseService),
        t.clock,
      );
      await restarted.project([event as never]);

      expect((await stats(u1, code)).total).toBe(1);
      expect((await t.clickRows(code)).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('S37 AS-44: invalid payloads', () => {
    const farFuture = () =>
      new Date(t.clock.now().getTime() + 10 * 60_000).toISOString();
    const cases: Array<[string, (code: string) => object | string]> = [
      [
        'no clickId',
        (c) => {
          const e = t.clickEvent(c);
          delete e.payload.clickId;
          return e;
        },
      ],
      [
        'clickId not a UUID',
        (c) => t.clickEvent(c, { payload: { clickId: 'not-a-uuid' } }),
      ],
      ['code failing the format', () => t.clickEvent('a$b')],
      [
        'ts not an instant',
        (c) => t.clickEvent(c, { payload: { ts: 'yesterday' } }),
      ],
      [
        'ts more than 5 minutes ahead',
        (c) => t.clickEvent(c, { payload: { ts: farFuture() } }),
      ],
      [
        'country of three letters',
        (c) => t.clickEvent(c, { payload: { country: 'DEU' } }),
      ],
      [
        'referer longer than 300 characters',
        (c) =>
          t.clickEvent(c, {
            payload: { referer: `https://${'a'.repeat(300)}.example` },
          }),
      ],
      ['version 2', (c) => t.clickEvent(c, { envelope: { version: 2 } })],
      ['a body that is not JSON', () => '{not json'],
    ];

    it.each(cases)(
      '%s is dead-lettered with a reason and has no effect; the valid event beside it is counted',
      async (_name, make) => {
        const code = await t.newLink(u1);
        const valid = t.clickEvent(code);
        const before = (await t.deadLetters()).length;

        await t.deliver([make(code), valid]);

        await rows(code, 1);
        await waitFor(async () => (await t.deadLetters()).length > before, {
          description: 'a dead letter',
          timeoutMs: 30_000,
        });
        const letters = (await t.deadLetters()).slice(before);
        expect(letters).toHaveLength(1);
        expect(letters[0].headers['x-dlq-reason']).toBeTruthy();
        expect((await t.clickRows(code)).map((r) => r.click_id)).toEqual([
          valid.payload.clickId,
        ]);
        expect(MetricsRegistry.labelSets('dlq_total').length).toBeGreaterThan(
          0,
        );
      },
    );

    it('an unknown event type is skipped by the consumer framework and has no effect (the framework skips what it does not handle)', async () => {
      const code = await t.newLink(u1);
      const valid = t.clickEvent(code);
      await t.deliver([
        t.clickEvent(code, { envelope: { type: 'link.unknown' } }),
        valid,
      ]);
      await rows(code, 1);
      expect(await t.clickRows(code)).toHaveLength(1);
    });
  });

  describe('S37 AS-45: late and out-of-order events', () => {
    it('counts each click in the minute of its own ts; shuffled delivery gives identical statistics', async () => {
      const now = t.clock.now().getTime();
      const minute = (offsetMin: number) =>
        new Date(
          Math.floor(now / 60_000) * 60_000 + offsetMin * 60_000,
        ).toISOString();
      const [a, b] = [await t.newLink(u1), await t.newLink(u1)];
      const make = (code: string, offsetMin: number) =>
        t.clickEvent(code, { payload: { ts: minute(offsetMin) } });
      // minutes M+1, M and M-120, M = ten minutes ago
      const offsets = [-9, -10, -130];

      await t.deliver(offsets.map((o) => make(a, o)));
      await t.deliver([...offsets].reverse().map((o) => make(b, o)));
      await rows(a, 3);
      await rows(b, 3);

      const [sa, sb] = [await stats(u1, a), await stats(u1, b)];
      expect(sa.total).toBe(3);
      expect(sa.series.map((s) => s.start)).toEqual(
        offsets.map((o) => minute(o)).sort(),
      );
      expect(sa.series.every((s) => s.clicks === 1)).toBe(true);
      expect(sb.series).toEqual(sa.series);
    });
  });

  describe('S37 AS-46 / AS-47: attribution lookup (R1)', () => {
    it('resolves active, expired and disabled links and omits unknown and malformed codes', async () => {
      const u2 = await t.user();
      const active = await t.newLink(u1);
      const expiring = t.alias('lapsed');
      await t.plant({
        code: expiring,
        ownerId: u1.id,
        expiresAt: new Date(t.clock.now().getTime() + 1_000).toISOString(),
      });
      const disabled = await t.newLink(u2);
      await t.as(u2).post(`/api/links/${disabled}/disable`).expect(200);
      t.clock.advance(5_000);
      t.calls.clear();

      const result = await t.attribution.resolveAttributions([
        active,
        expiring,
        disabled,
        'Nope123',
        'a$b',
        '',
      ]);

      expect(result).toEqual({
        [active]: { code: active, ownerId: u1.id, status: 'ACTIVE' },
        [expiring]: { code: expiring, ownerId: u1.id, status: 'EXPIRED' },
        [disabled]: { code: disabled, ownerId: u2.id, status: 'DISABLED' },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /destination|shop\.example|click/,
      );
      expect(t.calls.get('repo.batchGet')).toBe(1);
      expect(t.calls.get('repo.get') ?? 0).toBe(0);
    });

    it('an empty list gives {} and more than 100 codes are refused', async () => {
      expect(await t.attribution.resolveAttributions([])).toEqual({});
      const many = Array.from(
        { length: 101 },
        (_, i) => `code${String(i).padStart(3, '0')}`,
      );
      await expect(
        t.attribution.resolveAttributions(many),
      ).rejects.toBeInstanceOf(TooManyCodesError);
      expect(
        await t.attribution.resolveAttributions(many.slice(0, 100)),
      ).toEqual({});
    });

    it('S37 AS-47: a store that is down is an error, never an empty result', async () => {
      const code = await t.newLink(u1);
      t.faults.set('repo', { kind: 'down' });
      await expect(
        t.attribution.resolveAttributions([code]),
      ).rejects.toBeInstanceOf(AttributionUnavailableError);
    });
  });

  it('the consumer counts what it projects and exposes its lag', async () => {
    const code = await t.newLink(u1);
    const before = metric('link_click_projected_total');
    await t.deliver([t.clickEvent(code)]);
    await rows(code, 1);
    expect(metric('link_click_projected_total')).toBeGreaterThan(before);
    expect(MetricsRegistry.value('link_click_consumer_lag')).toBeDefined();
  });
});

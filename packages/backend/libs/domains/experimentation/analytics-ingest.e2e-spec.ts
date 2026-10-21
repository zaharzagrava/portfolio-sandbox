import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  INGEST_CODES,
  ingestResultSchema,
  storedAnalyticsEventSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import type { TestUser } from '@app/test/utils/catalog-app';
import { readTopic } from '@app/test/utils/kafka-test';
import {
  T0,
  chTime,
  createAnalyticsApp,
  freshAnalyticsTopic,
  type AnalyticsTestApp,
} from './testing/analytics.fixtures';
import { ANALYTICS_TOPIC } from './domain/event-schema';

const EDGE_SECRET = 'test-analytics-edge-secret-0123456789abcdef';
const DAY = 86_400_000;

interface Vector {
  name: string;
  now: number;
  request: {
    headers: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  expect: {
    status: number;
    accepted: number;
    rejected: { index: number; code: string }[];
    stored: Record<string, unknown>[];
  };
}
const VECTORS: Vector[] = JSON.parse(
  readFileSync(
    join(process.cwd(), '../contracts/src/analytics/ingest-vectors.json'),
    'utf8',
  ),
);

const metric = (name: string, labels: Record<string, string> = {}): number =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Analytics ingest API (S39)', () => {
  let t: AnalyticsTestApp;
  let buyer: TestUser;

  beforeAll(async () => {
    await freshAnalyticsTopic();
    t = await createAnalyticsApp({
      env: { FLAGS_EDGE_SECRET: EDGE_SECRET },
      redisProxy: true,
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(T0);
    buyer = await t.newUser();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Messages on the topic whose event ids are in `ids`, in log order. */
  const produced = async (ids: string[]) =>
    (await t.topic()).filter((m) => ids.includes(m.json<any>().event_id));
  const topicSize = async () => (await readTopic(ANALYTICS_TOPIC)).length;

  it('S39 AS-01: three valid events are accepted, produced with a key, the stored shape and the frozen receive time', async () => {
    const anonymousId = 'anon-as01-12345678';
    const events = [
      t.event({ name: 'page_view', anonymous_id: anonymousId, page: '/home' }),
      t.event({
        name: 'product_view',
        anonymous_id: anonymousId,
        props: {
          product_id: '5d7d1b2e-2a53-4d5e-9d5c-1f2f3a4b5c6d',
          category: 'audio',
          price: 129.5,
          in_stock: true,
        },
      }),
      t.event({ name: 'add_to_cart', anonymous_id: anonymousId }),
    ];
    const res = await t.postEvents({ events });
    expect(res.status).toBe(202);
    expect(ingestResultSchema.parse(res.body)).toEqual({
      accepted: 3,
      rejected: [],
    });

    const messages = await produced(events.map((e) => e.event_id));
    expect(messages).toHaveLength(3);
    for (const [i, message] of messages.entries()) {
      expect(message.key).toBe(anonymousId);
      const e = events[i];
      expect(message.json()).toEqual({
        event_id: e.event_id,
        name: e.name,
        anonymous_id: anonymousId,
        user_id: '',
        ts: chTime(e.ts),
        received_at: '2026-10-14 12:00:00.000',
        country: '',
        platform: 'web',
        page: e.page ?? '',
        props: Object.fromEntries(
          Object.entries(e.props ?? {}).map(([k, v]) => [k, String(v)]),
        ),
      });
      expect(storedAnalyticsEventSchema.safeParse(message.json()).success).toBe(
        true,
      );
    }
    expect(messages[1].json<any>().props).toEqual({
      product_id: '5d7d1b2e-2a53-4d5e-9d5c-1f2f3a4b5c6d',
      category: 'audio',
      price: '129.5',
      in_stock: 'true',
    });
  });

  describe('identity', () => {
    it('S39 AS-02: a signed-in caller gets its own user id stored, a forged field rejects only its event', async () => {
      const good = t.event();
      const forged = [
        t.event({ user_id: 'someone-else' }),
        t.event({ received_at: '2020-01-01 00:00:00.000' }),
        t.event({ country: 'DE' }),
        t.event({ platform: 'server' }),
      ];
      const res = await t.postEvents(
        { events: [good, ...forged] },
        { user: buyer },
      );
      expect(res.status).toBe(202);
      expect(ingestResultSchema.parse(res.body)).toEqual({
        accepted: 1,
        rejected: [1, 2, 3, 4].map((index) => ({
          index,
          code: 'forbidden_field',
        })),
      });
      const messages = await produced([good, ...forged].map((e) => e.event_id));
      expect(messages.map((m) => m.json<any>().event_id)).toEqual([
        good.event_id,
      ]);
      expect(messages[0].json<any>().user_id).toBe(buyer.id);
    });

    it('S39 AS-02: an expired token, a malformed token and a user header leave the event anonymous but accepted', async () => {
      const expiredUser = await t.newUser();
      t.clock.advance(10 * 60_000);
      const events = [t.event(), t.event(), t.event()];
      const expired = await t.postEvents(
        { events: [events[0]] },
        { user: expiredUser },
      );
      const malformed = await t.postEvents(
        { events: [events[1]] },
        { headers: { Authorization: 'Bearer not.a.token' } },
      );
      const header = await t.postEvents(
        { events: [events[2]] },
        { headers: { 'X-User-Id': buyer.id } },
      );
      for (const res of [expired, malformed, header]) {
        expect(res.status).toBe(202);
        expect(res.body.accepted).toBe(1);
      }
      const messages = await produced(events.map((e) => e.event_id));
      expect(messages).toHaveLength(3);
      expect(messages.map((m) => m.json<any>().user_id)).toEqual(['', '', '']);
    });
  });

  describe('validation', () => {
    const invalid: [string, Record<string, unknown>, string][] = [
      ['invalid_event_id', { event_id: 'nope' }, 'not a uuid'],
      ['unknown_event_name', { name: 'login' }, 'outside the set'],
      ['unknown_event_name', { name: 'purchase' }, 'server-only'],
      ['invalid_anonymous_id', { anonymous_id: 'a'.repeat(7) }, '7 characters'],
      [
        'invalid_anonymous_id',
        { anonymous_id: 'a'.repeat(65) },
        '65 characters',
      ],
      ['invalid_anonymous_id', { anonymous_id: 'anon 12345678' }, 'a space'],
      ['invalid_timestamp', { ts: -1 }, 'negative'],
      ['invalid_timestamp', { ts: 'yesterday' }, 'a string'],
      ['invalid_timestamp', { ts: 1.5 }, 'a fraction'],
      ['invalid_props', { props: { a: { b: 1 } } }, 'nested object'],
      ['invalid_props', { props: { a: [1] } }, 'an array value'],
      [
        'invalid_props',
        {
          props: Object.fromEntries(
            Array.from({ length: 31 }, (_, i) => [`k${i}`, 'v']),
          ),
        },
        '31 keys',
      ],
      [
        'invalid_props',
        { props: { ['k'.repeat(65)]: 'v' } },
        'a 65-character key',
      ],
      ['invalid_props', { props: { 'a b': 'v' } }, 'a key with a space'],
      [
        'invalid_props',
        { props: { a: 'v'.repeat(501) } },
        'a 501-character value',
      ],
      ['invalid_page', { page: '/'.repeat(501) }, '501 characters'],
      [
        'invalid_exposure',
        { name: 'exposure', props: { variant: 'a' } },
        'no experiment',
      ],
      ['forbidden_field', { user_id: 'u' }, 'user_id'],
      ['event_too_old', { ts: T0.getTime() - 8 * DAY }, 'eight days old'],
    ];

    it.each(invalid)('S39 AS-03: %s for %s', async (code, patch) => {
      const good = t.event();
      const bad = t.event(patch);
      const res = await t.postEvents({ events: [good, bad] });
      expect(res.status).toBe(202);
      expect(ingestResultSchema.parse(res.body)).toEqual({
        accepted: 1,
        rejected: [{ index: 1, code }],
      });
      const messages = await produced([good.event_id, bad.event_id]);
      expect(messages.map((m) => m.json<any>().event_id)).toEqual([
        good.event_id,
      ]);
    });

    it('S39 AS-03: every code of the closed list is reachable and rejected events are counted by reason', async () => {
      const before = metric('analytics_events_total', {
        outcome: 'rejected',
        reason: 'invalid_page',
      });
      const res = await t.postEvents({
        events: [t.event({ page: '/'.repeat(501) })],
      });
      expect(res.body.rejected).toEqual([{ index: 0, code: 'invalid_page' }]);
      expect(
        metric('analytics_events_total', {
          outcome: 'rejected',
          reason: 'invalid_page',
        }),
      ).toBe(before + 1);
      expect(INGEST_CODES).toContain('invalid_page');
    });

    it('S39 AS-26: both valid exposure shapes are accepted and every invalid class is invalid_exposure', async () => {
      const valid = [
        t.event({
          name: 'exposure',
          props: { experiment: 'free-shipping', variant: 'free' },
        }),
        t.event({
          name: 'exposure',
          props: { flag_key: 'new-checkout', variant: 'on', flag_version: '4' },
        }),
      ];
      const invalidShapes = [
        { experiment: 'e' },
        { experiment: 'e', variant: '' },
        { experiment: 'e', variant: 'v'.repeat(33) },
        { experiment: 'e', flag_key: 'f', variant: 'a', flag_version: '1' },
        { variant: 'a' },
        { flag_key: 'f', variant: 'a' },
        { experiment: 'e', variant: 1 },
      ].map((props) => t.event({ name: 'exposure', props }));
      const res = await t.postEvents({ events: [...valid, ...invalidShapes] });
      expect(res.status).toBe(202);
      expect(ingestResultSchema.parse(res.body)).toEqual({
        accepted: 2,
        rejected: invalidShapes.map((_, i) => ({
          index: i + 2,
          code: 'invalid_exposure',
        })),
      });
      const messages = await produced(valid.map((e) => e.event_id));
      expect(messages).toHaveLength(2);
      expect(messages[1].json<any>().props).toEqual({
        flag_key: 'new-checkout',
        variant: 'on',
        flag_version: '4',
      });
    });
  });

  describe('envelope', () => {
    it.each([
      ['text/plain', 'not json at all'],
      ['text/plain', '{"events": ['],
      ['text/plain', '{}'],
      ['text/plain', '{"events": "x"}'],
      ['text/plain', '{"events": []}'],
    ])(
      'S39 AS-04: %s body %j is 400 validation_failed and nothing is produced',
      async (contentType, raw) => {
        const before = await topicSize();
        const res = await t.postEvents(undefined, { contentType, raw });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await topicSize()).toBe(before);
      },
    );

    it('S39 AS-04: JSON bodies that are not an envelope are 400 validation_failed', async () => {
      const before = await topicSize();
      for (const body of [
        {},
        { events: 'x' },
        { events: [] },
        { events: Array.from({ length: 51 }, () => t.event()) },
        [t.event()],
      ]) {
        const res = await t.postEvents(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      }
      expect(await topicSize()).toBe(before);
    });

    it('S39 AS-04: a JSON body that does not parse is refused by the platform parser as 400 malformed_body', async () => {
      const res = await t.postEvents(undefined, { raw: '{"events": [' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('malformed_body');
    });

    it('S39 AS-04: a body over 128 KiB is 413 payload_too_large, as JSON and as text', async () => {
      const before = await topicSize();
      const padding = 'x'.repeat(130 * 1024);
      const json = await t.postEvents({ events: [t.event()], padding });
      expect(json.status).toBe(413);
      expect(json.body.code).toBe('payload_too_large');
      const text = await t.postEvents(undefined, {
        contentType: 'text/plain',
        raw: JSON.stringify({ events: [t.event()], padding }),
      });
      expect(text.status).toBe(413);
      expect(text.body.code).toBe('payload_too_large');
      expect(await topicSize()).toBe(before);
    });

    it('S39 AS-04: a content type other than JSON or text is 415 unsupported_media_type', async () => {
      const before = await topicSize();
      for (const contentType of [
        'application/xml',
        'application/x-www-form-urlencoded',
        'image/png',
      ]) {
        const res = await t.postEvents(undefined, {
          contentType,
          raw: JSON.stringify({ events: [t.event()] }),
        });
        expect(res.status).toBe(415);
        expect(res.body.code).toBe('unsupported_media_type');
      }
      expect(await topicSize()).toBe(before);
    });

    it('S39 AS-06: a text/plain body (what sendBeacon sends) gives the outcome of the same JSON', async () => {
      const events = [
        t.event(),
        t.event({ name: 'product_view', props: { product_id: 'p' } }),
      ];
      const res = await t.postEvents(
        { events: [...events, t.event({ name: 'login' })] },
        { contentType: 'text/plain;charset=UTF-8' },
      );
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        accepted: 2,
        rejected: [{ index: 2, code: 'unknown_event_name' }],
      });
      expect(await produced(events.map((e) => e.event_id))).toHaveLength(2);
    });

    it('S39 AS-07: a repeated event_id in one batch is reported duplicate_in_batch and produced once', async () => {
      const first = t.event({ name: 'click' });
      const again = { ...first, name: 'search' };
      const res = await t.postEvents({ events: [first, again] });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        accepted: 1,
        rejected: [{ index: 1, code: 'duplicate_in_batch' }],
      });
      const messages = await produced([first.event_id]);
      expect(messages).toHaveLength(1);
      expect(messages[0].json<any>().name).toBe('click');
    });

    it('S39 AS-03: a batch of only invalid events is 202 with accepted 0', async () => {
      const before = await topicSize();
      const res = await t.postEvents({
        events: [t.event({ name: 'nope' }), t.event({ event_id: 'x' })],
      });
      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(0);
      expect(res.body.rejected).toHaveLength(2);
      expect(await topicSize()).toBe(before);
    });
  });

  it('S39 AS-05: an event ahead of the clock reaches the topic with ts equal to the receive time, an old one keeps its time', async () => {
    const ahead = t.event({ ts: T0.getTime() + 600_001 });
    const exactly = t.event({ ts: T0.getTime() + 600_000 });
    const old = t.event({ ts: T0.getTime() - 2 * DAY });
    const tooOld = t.event({ ts: T0.getTime() - 7 * DAY - 1 });
    const res = await t.postEvents({ events: [ahead, exactly, old, tooOld] });
    expect(res.body).toEqual({
      accepted: 3,
      rejected: [{ index: 3, code: 'event_too_old' }],
    });
    const [a, e, o] = await produced(
      [ahead, exactly, old].map((x) => x.event_id),
    );
    expect(a.json<any>().ts).toBe(a.json<any>().received_at);
    expect(a.json<any>().ts).toBe('2026-10-14 12:00:00.000');
    expect(e.json<any>().ts).toBe(chTime(T0.getTime() + 600_000));
    expect(o.json<any>().ts).toBe(chTime(T0.getTime() - 2 * DAY));
  });

  describe('stream failure', () => {
    it('S39 AS-08: a broker error is 503 ingest_unavailable with Retry-After, nothing accepted, counted; the same batch is accepted after recovery', async () => {
      const events = [t.event(), t.event()];
      const failures = metric('analytics_produce_failures_total');
      const spy = jest
        .spyOn(t.producer, 'sendMany')
        .mockRejectedValueOnce(new Error('broker down'));
      const res = await t.postEvents({ events });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ingest_unavailable');
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body.accepted).toBeUndefined();
      expect(metric('analytics_produce_failures_total')).toBe(failures + 1);
      expect(
        metric('analytics_ingest_requests_total', { status: '503' }),
      ).toBeGreaterThanOrEqual(1);
      spy.mockRestore();

      const retry = await t.postEvents({ events });
      expect(retry.status).toBe(202);
      expect(retry.body.accepted).toBe(2);
      expect(await produced(events.map((e) => e.event_id))).toHaveLength(2);
    });

    it('S39 AS-08: a broker that does not acknowledge within 2 seconds is the same 503', async () => {
      const events = [t.event()];
      const failures = metric('analytics_produce_failures_total');
      jest
        .spyOn(t.producer, 'sendMany')
        .mockImplementationOnce(() => new Promise<void>(() => undefined));
      const started = Date.now();
      const res = await t.postEvents({ events });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ingest_unavailable');
      expect(res.headers['retry-after']).toBe('5');
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(metric('analytics_produce_failures_total')).toBe(failures + 1);
    });

    it('S39 AS-08: the producer is given only a key and a value for the standard topic (no FIFO option)', async () => {
      const spy = jest.spyOn(t.producer, 'sendMany');
      await t.postEvents({ events: [t.event()] });
      expect(spy).toHaveBeenCalledTimes(1);
      const [topic, messages, options] = spy.mock.calls[0] as any[];
      expect(topic).toBe(ANALYTICS_TOPIC);
      expect(options).toBeUndefined();
      for (const message of messages)
        expect(Object.keys(message).sort()).toEqual(['key', 'value']);
    });
  });

  describe('rate limit', () => {
    it('S39 AS-09: the 121st request in the window is 429 with Retry-After and nothing produced; another caller is unaffected', async () => {
      const limited = await t.newUser();
      const other = await t.newUser();
      const probe = t.event();
      // 120 requests, 30 at a time (the counter is atomic, so the 121st is still the first refused)
      for (let batch = 0; batch < 4; batch++) {
        const results = await Promise.all(
          Array.from({ length: 30 }, () =>
            t.postEvents(
              { events: [t.event({ name: 'nope' })] },
              { user: limited },
            ),
          ),
        );
        for (const res of results) expect(res.status).toBe(202);
      }
      const before = await topicSize();
      const rateLimited = metric('analytics_rate_limited_total');
      const refused = await t.postEvents(
        { events: [probe] },
        { user: limited },
      );
      expect(refused.status).toBe(429);
      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      expect(await topicSize()).toBe(before);
      expect(metric('analytics_rate_limited_total')).toBe(rateLimited + 1);

      const fine = await t.postEvents({ events: [t.event()] }, { user: other });
      expect(fine.status).toBe(202);
      expect(fine.body.accepted).toBe(1);
    }, 120_000);

    it('S39 AS-09: with the limiter store down the request is accepted and the degradation is counted', async () => {
      const unavailable = () =>
        metric('rate_limit_store_unavailable_total', {
          policy: 'analytics.ingest',
          fail_mode: 'open',
        });
      const degraded = metric('analytics_rate_limiter_degraded_total');
      const before = unavailable();
      const event = t.event();
      t.redisProxy!.mode = 'refuse';
      t.redisProxy!.sever();
      try {
        // The client notices the cut on its first commands; poke until the limiter reports its store unavailable.
        const deadline = Date.now() + 15_000;
        while (unavailable() === before) {
          if (Date.now() > deadline) throw new Error('limiter never noticed');
          await t.postEvents({ events: [t.event({ name: 'nope' })] });
          await new Promise((r) => setTimeout(r, 50));
        }
        const res = await t.postEvents({ events: [event] });
        expect(res.status).toBe(202);
        expect(res.body.accepted).toBe(1);
        expect(await produced([event.event_id])).toHaveLength(1);
        expect(metric('analytics_rate_limiter_degraded_total')).toBeGreaterThan(
          degraded,
        );
      } finally {
        t.redisProxy!.mode = 'pass';
      }
    });
  });

  describe('country and platform', () => {
    it('S39 AS-11: country needs the edge credential and platform is one of web, ios, android', async () => {
      const cases: [string, Record<string, string>, string, string][] = [
        [
          'no credential, toaster',
          { 'CF-IPCountry': 'DE', 'X-Client-Platform': 'toaster' },
          '',
          'web',
        ],
        [
          'wrong credential, server',
          {
            'CF-IPCountry': 'DE',
            'X-Edge-Credential': 'wrong',
            'X-Client-Platform': 'server',
          },
          '',
          'web',
        ],
        [
          'credential, ios',
          {
            'CF-IPCountry': 'DE',
            'X-Edge-Credential': EDGE_SECRET,
            'X-Client-Platform': 'ios',
          },
          'DE',
          'ios',
        ],
        [
          'credential, unknown country XX',
          { 'CF-IPCountry': 'XX', 'X-Edge-Credential': EDGE_SECRET },
          '',
          'web',
        ],
        [
          'no credential, android',
          { 'X-Client-Platform': 'android' },
          '',
          'android',
        ],
      ];
      for (const [label, headers, country, platform] of cases) {
        const event = t.event();
        const res = await t.postEvents({ events: [event] }, { headers });
        expect(res.status).toBe(202);
        const [message] = await produced([event.event_id]);
        expect({
          label,
          country: message.json<any>().country,
          platform: message.json<any>().platform,
        }).toEqual({
          label,
          country,
          platform,
        });
      }
    });
  });

  describe('edge parity', () => {
    it('S39 AS-10: every shared vector gives the same decision, per-index codes and stored event as the edge worker', async () => {
      const answers: { vector: Vector; status: number; body: unknown }[] = [];
      for (const vector of VECTORS.filter((v) => v.expect.status === 202)) {
        t.clock.set(new Date(vector.now));
        const res = await t.postEvents(vector.request.body, {
          contentType: vector.request.headers['content-type'],
        });
        answers.push({ vector, status: res.status, body: res.body });
      }
      // One read of the topic for all vectors: each vector owns its event ids.
      const byId = new Map<string, Record<string, unknown>[]>();
      for (const message of await t.topic()) {
        const { user_id, country, platform, ...core } = message.json<any>();
        byId.set(core.event_id, [...(byId.get(core.event_id) ?? []), core]);
      }
      const mismatches = answers.flatMap(({ vector, status, body }) => {
        const sent = (vector.request.body as { events: { event_id: string }[] })
          .events;
        const stored = vector.expect.stored.map((e) => ({
          ...e,
          copies: byId.get(e.event_id as string)?.length ?? 0,
        }));
        const found = [...new Set(sent.map((e) => e.event_id))].flatMap(
          (id) => byId.get(id) ?? [],
        );
        const problems = [
          status !== vector.expect.status && `status ${status}`,
          !isDeepStrictEqual(body, {
            accepted: vector.expect.accepted,
            rejected: vector.expect.rejected,
          }) && `body ${JSON.stringify(body)}`,
          !isDeepStrictEqual(found, vector.expect.stored) &&
            `stored ${JSON.stringify(found)}`,
          stored.some((s) => s.copies !== 1) && 'an event was produced twice',
        ].filter(Boolean);
        return problems.length
          ? [`${vector.name}: ${problems.join('; ')}`]
          : [];
      });
      expect(mismatches).toEqual([]);
    }, 120_000);

    it.each(
      VECTORS.filter((v) => v.expect.status === 400).map(
        (v) => [v.name, v] as const,
      ),
    )(
      'S39 AS-10: shared envelope vector %s is refused with 400',
      async (_name, vector) => {
        const res = await t.postEvents(vector.request.body, {
          raw: vector.request.rawBody,
          contentType: 'text/plain',
        });
        expect(res.status).toBe(400);
      },
    );
  });
});

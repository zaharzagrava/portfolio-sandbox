import { Logger } from '@nestjs/common';
import {
  problemDetailsSchema,
  suggestResponseSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { QueryIndexService } from './application/query-index.service';
import {
  closeNodes,
  createAutocompleteApp,
  startNode,
  type AutocompleteTestApp,
} from './testing/autocomplete-app';
import { newId } from './testing/search-events';
import { seedProducts } from './testing/search-fixtures';

const LONG_QUERY = 'wireless noise cancelling headphones case'; // a shorter query sharing the prefix
const LONGER = 'wireless noise cancelling headphones case xl x'; // 46 characters

describe('Search autocomplete API', () => {
  let t: AutocompleteTestApp;
  let engineCalls: jest.SpyInstance;

  beforeAll(async () => {
    t = await createAutocompleteApp({ redisProxy: true });
    await t.resetSearch();
    await seedProducts(t, newId(), [
      { title: 'iPhone 17 Pro Case' },
      { title: 'iPhone Charger Dock' },
      { title: 'Cheap iPhone Stand' },
    ]);
  });
  afterAll(() => closeNodes(t));

  beforeEach(async () => {
    await t.resetAutocomplete();
    engineCalls = jest.spyOn(t.engine, 'search');
  });
  afterEach(() => jest.restoreAllMocks());

  const get = (q: string, params: Record<string, string> = {}) =>
    t
      .http()
      .get('/api/suggest')
      .query({ q, ...params });

  /** The query index of this node, rebuilt from a log of `queries` (text → distinct searchers). */
  const publish = async (queries: Record<string, number>) => {
    for (const [query, searchers] of Object.entries(queries))
      await t.logQuery(query, searchers);
    expect(await t.publish()).toMatchObject({ outcome: 'published' });
  };

  const problem = (body: unknown) => {
    const parsed = problemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    return body as { code: string; status: number; errors?: unknown[] };
  };

  it('S33 AS-01: a blended answer with the response schema, a cacheable header, no cookie, and the snapshot untouched', async () => {
    await publish({ 'iphone case': 8, 'iphone 17': 6, 'iphone charger': 6 });
    const before = {
      pointer: await t.pointer(),
      objects: await t.snapshotVersions(),
    };

    const res = await get('iph').expect(200);

    const body = suggestResponseSchema.parse(res.body);
    expect(body.prefix).toBe('iph');
    expect(body.degraded).toEqual([]);
    expect(body.suggestions.slice(0, 3)).toEqual([
      { text: 'iphone case', source: 'query' },
      { text: 'iphone 17', source: 'query' },
      { text: 'iphone charger', source: 'query' },
    ]);
    expect(
      body.suggestions
        .slice(3)
        .map((s) => s.text)
        .sort(),
    ).toEqual([
      'Cheap iPhone Stand',
      'iPhone 17 Pro Case',
      'iPhone Charger Dock',
    ]);
    expect(body.suggestions.slice(3).every((s) => s.source === 'catalog')).toBe(
      true,
    );
    expect(res.headers['cache-control']).toBe(
      'public, max-age=60, s-maxage=60',
    );
    expect(res.headers['set-cookie']).toBeUndefined();
    expect({
      pointer: await t.pointer(),
      objects: await t.snapshotVersions(),
    }).toEqual(before);
  });

  // AS-55 and AS-56 are owned by W02 (the browser half is its Playwright and component tests); these prove the server half the UI relies on.
  it('S33 AS-55: the answer for iph is the ordered list the search page renders, and each entry text is usable as the q of a search', async () => {
    await publish({ 'iphone 17': 9, 'iphone charger': 7 });

    const body = suggestResponseSchema.parse(
      (await get('iph').expect(200)).body,
    );

    expect(body.suggestions.slice(0, 2).map((s) => s.text)).toEqual([
      'iphone 17',
      'iphone charger',
    ]);
    const chosen = body.suggestions[0].text;
    const search = await t
      .http()
      .get('/api/products/search')
      .query({ q: chosen });
    expect(search.status).toBe(200);
  });

  it('S33 AS-56: every answer names its own prefix so a client can drop a stale one, and is cacheable for the 60 seconds the client caches', async () => {
    await publish({ 'iphone 17': 9, 'iphone charger': 7 });

    // the answer for the longer prefix may arrive first; the prefix inside each body identifies which request it answers
    const longer = await get('ipho').expect(200);
    const shorter = await get('iph').expect(200);

    expect(longer.body.prefix).toBe('ipho');
    expect(shorter.body.prefix).toBe('iph');
    for (const res of [longer, shorter])
      expect(res.headers['cache-control']).toBe(
        'public, max-age=60, s-maxage=60',
      );
  });

  it('S33 AS-02: equal counts are ordered by text and a replay is byte-identical', async () => {
    await publish({ 'zz beta': 7, 'zz alpha': 7, 'zz gamma': 7 });
    const first = await get('zz').expect(200);
    const second = await get('zz').expect(200);
    expect(
      suggestResponseSchema.parse(first.body).suggestions.map((s) => s.text),
    ).toEqual(['zz alpha', 'zz beta', 'zz gamma']);
    expect(second.text).toBe(first.text);
  });

  it('S33 AS-03: the default is eight, limit narrows it, and each invalid limit is a 400', async () => {
    await publish(
      Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          `qqq item ${String(i).padStart(2, '0')}`,
          6 + i,
        ]),
      ),
    );
    expect(
      suggestResponseSchema.parse((await get('qqq').expect(200)).body)
        .suggestions,
    ).toHaveLength(8);
    expect(
      suggestResponseSchema.parse(
        (await get('qqq', { limit: '3' }).expect(200)).body,
      ).suggestions,
    ).toHaveLength(3);
    expect(
      suggestResponseSchema.parse(
        (await get('qqq', { limit: '10' }).expect(200)).body,
      ).suggestions,
    ).toHaveLength(10);
    for (const limit of ['0', '11', 'abc', '-1', '1.5', '', '1e1']) {
      const res = await get('qqq', { limit }).expect(400);
      expect(problem(res.body).code).toBe('validation_failed');
      expect(JSON.stringify(res.body.errors)).toContain('limit');
    }
  });

  it('S33 AS-04: spacing, case, control characters and compatibility forms reduce to the same prefix', async () => {
    await publish({ 'iphone case': 8, 'iphone 17': 6 });
    const plain = suggestResponseSchema.parse(
      (await get('iph').expect(200)).body,
    );
    for (const input of [
      '  IPH  ',
      'iPh',
      'iph\u0000',
      'ｉｐｈ',
      'i\tph'.replace('\t', ''),
    ]) {
      const body = suggestResponseSchema.parse(
        (await get(input).expect(200)).body,
      );
      expect(body.prefix).toBe('iph');
      expect(body.suggestions).toEqual(plain.suggestions);
    }
    const spaced = suggestResponseSchema.parse(
      (await get('iphone   CASE ').expect(200)).body,
    );
    expect(spaced.prefix).toBe('iphone case');
  });

  it('S33 AS-05: nothing typed is an empty 200 and touches neither the engine nor the index', async () => {
    await publish({ 'iphone case': 8 });
    const lookup = jest.spyOn(t.app.get(QueryIndexService), 'lookup');
    engineCalls.mockClear();
    for (const q of ['', ' ', '   ', '\u0000', '\u0001\u0002']) {
      const body = suggestResponseSchema.parse((await get(q).expect(200)).body);
      expect(body).toEqual({ prefix: '', suggestions: [], degraded: [] });
    }
    expect(engineCalls).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('S33 AS-06: a missing q, a 101-character q and an unknown parameter are 400 problem+json naming the parameter', async () => {
    engineCalls.mockClear();
    const missing = await t.http().get('/api/suggest').expect(400);
    const tooLong = await get('a'.repeat(101)).expect(400);
    const unknown = await get('iph', { debug: '1' }).expect(400);
    for (const [res, field] of [
      [missing, 'q'],
      [tooLong, 'q'],
      [unknown, 'debug'],
    ] as const) {
      expect(res.headers['content-type']).toContain('problem+json');
      const body = problem(res.body);
      expect(body.code).toBe('validation_failed');
      expect(body.status).toBe(400);
      expect(JSON.stringify(body.errors)).toContain(field);
    }
    // exactly 100 characters is fine
    await get('a'.repeat(100)).expect(200);
    expect(engineCalls.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('S33 AS-07: hostile text is an ordinary answer, never an engine error or a wildcard expansion', async () => {
    await publish({ 'iphone case': 8 });
    const payloads = [
      '*',
      '?',
      'i*',
      'title:iphone AND NOT x',
      '" OR 1=1 --',
      '\\',
      '${jndi:ldap://x}',
      '<script>alert(1)</script>',
      '(((',
      '/iph.*/',
    ];
    for (const q of payloads) {
      const res = await get(q).expect(200);
      const body = suggestResponseSchema.parse(res.body);
      expect(JSON.stringify(res.body)).not.toMatch(
        /exception|stack|elastic|lucene|parse/i,
      );
      if (['*', '?', '(((', '\\'].includes(q))
        expect(body.suggestions).toEqual([]);
    }
  });

  it('S33 AS-08: no token, a valid token and an invalid token give the same answer', async () => {
    await publish({ 'iphone case': 8 });
    const user = await t.newUser();
    const anonymous = await get('iph').expect(200);
    const signedIn = await t.as(user).get('/api/suggest?q=iph').expect(200);
    const invalid = await get('iph')
      .set('Authorization', 'Bearer not-a-token')
      .expect(200);
    expect(signedIn.text).toBe(anonymous.text);
    expect(invalid.text).toBe(anonymous.text);
  });

  it('S33 AS-10: a 400 and a 429 are never cached and keep their problem body', async () => {
    const bad = await get('a'.repeat(101)).expect(400);
    expect(bad.headers['cache-control']).toBe('no-store');
    problem(bad.body);
  });

  it('S33 AS-11: a 24- and a 35-character prefix still find the 46-character query', async () => {
    await publish({ [LONGER]: 6, [LONG_QUERY]: 5 });
    for (const length of [24, 35]) {
      const prefix = LONGER.slice(0, length);
      const body = suggestResponseSchema.parse(
        (await get(prefix).expect(200)).body,
      );
      expect(body.suggestions).toContainEqual({
        text: LONGER,
        source: 'query',
      });
    }
  });

  it('S33 AS-48: two users and an anonymous caller get the same bytes, no cookie, no credential Vary, and no raw q in the logs', async () => {
    await publish({ 'iphone case': 8 });
    const marker = `zq${Date.now().toString(36)}marker`;
    const lines: string[] = [];
    const capture = (...args: unknown[]) =>
      void lines.push(args.map(String).join(' '));
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(capture as never);
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: unknown,
    ) => {
      lines.push(String(chunk));
      return true;
    }) as never);

    const [a, b] = [await t.newUser(), await t.newUser()];
    const anonymous = await get('iph').expect(200);
    const asA = await t.as(a).get('/api/suggest?q=iph').expect(200);
    const asB = await t.as(b).get('/api/suggest?q=iph').expect(200);
    await get(marker).expect(200);
    await get(`${marker} ${marker}`, { limit: '2' }).expect(200);
    out.mockRestore();

    expect(asA.text).toBe(anonymous.text);
    expect(asB.text).toBe(anonymous.text);
    for (const res of [anonymous, asA, asB]) {
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(String(res.headers.vary ?? '').toLowerCase()).not.toMatch(
        /authorization|cookie/,
      );
    }
    expect(lines.join('\n')).not.toContain(marker);
  });

  describe('serve-time blocklist (AS-12)', () => {
    it('S33 AS-12: a changed blocklist applies after a restart with no build, to every source', async () => {
      await publish({ 'cheap iphone': 9, 'iphone case': 8 });
      const version = await t.pointer();
      const before = suggestResponseSchema.parse(
        (await get('cheap').expect(200)).body,
      );
      expect(before.suggestions.map((s) => s.text)).toEqual(
        expect.arrayContaining(['cheap iphone', 'Cheap iPhone Stand']),
      );

      const restarted = await startNode({
        env: { AUTOCOMPLETE_BLOCKLIST: 'fake,cheap' },
      });
      await restarted.index.refresh();
      expect(restarted.index.version).toBe(version);
      const ask = async (q: string) =>
        suggestResponseSchema.parse(
          (await restarted.http().get('/api/suggest').query({ q }).expect(200))
            .body,
        );
      for (const q of ['cheap', 'iph', 'cheap iphone'])
        expect(
          (await ask(q)).suggestions.map((s) => s.text.toLowerCase()).join('|'),
        ).not.toContain('cheap');
      expect((await ask('iph')).suggestions.map((s) => s.text)).toContain(
        'iphone case',
      );
    });
  });

  describe('rate limit (AS-09)', () => {
    it('S33 AS-09: the 601st request in a minute is a 429 rate_limited with Retry-After; a downed limiter store still answers', async () => {
      await t.redis.client.flushdb();
      let last;
      for (let i = 0; i < 600; i++) last = await get('iph');
      expect(last!.status).toBe(200);
      const limited = await get('iph').expect(429);
      expect(problem(limited.body).code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.headers['cache-control']).toBe('no-store');

      await t.redis.client.flushdb();
      t.redisProxy!.mode = 'refuse';
      t.redisProxy!.sever();
      try {
        const res = await get('iph').expect(200);
        suggestResponseSchema.parse(res.body);
      } finally {
        t.redisProxy!.mode = 'pass';
      }
      expect(
        MetricsRegistry.value('autocomplete_requests_total', {
          status: 'invalid',
        }),
      ).toBeGreaterThan(0);
    });
  });
});

import { Logger } from '@nestjs/common';
import { suggestResponseSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { EngineUnavailableError } from '@app/infrastructure/elasticsearch/search-engine.errors';
import {
  closeNodes,
  createAutocompleteApp,
  startNode,
  type AutocompleteTestApp,
} from './testing/autocomplete-app';
import {
  deliver,
  newId,
  productEvent,
  shopStatusEvent,
  snapshot,
} from './testing/search-events';
import { seedProducts } from './testing/search-fixtures';

const degraded = (reason: string) =>
  MetricsRegistry.value('autocomplete_degraded_total', { reason }) ?? 0;

describe('Autocomplete source budgets and typo fallback', () => {
  let t: AutocompleteTestApp;
  let engine: jest.SpyInstance;

  beforeAll(async () => {
    t = await createAutocompleteApp();
  });
  afterAll(() => closeNodes(t));

  beforeEach(async () => {
    await t.resetSearch();
    await t.resetAutocomplete();
    await t.logQuery('iphone case', 6);
    await t.publish();
    // every test starts with a closed breaker: let any open one reach its probe, and let a healthy call close it
    t.clock.advance(10_000);
    await get(`warm${Date.now()}`).expect(200);
    engine = jest.spyOn(t.engine, 'search');
  });
  afterEach(() => jest.restoreAllMocks());

  const get = (q: string) => t.http().get('/api/suggest').query({ q });
  const body = async (q: string) => {
    const res = await get(q).expect(200);
    return { res, body: suggestResponseSchema.parse(res.body) };
  };
  /** Makes every engine call fail the way `fail` says; counts the calls. */
  const failWith = (fail: () => unknown) =>
    engine.mockImplementation(() => Promise.reject(fail()));
  const hang = () => {
    const aborted: boolean[] = [];
    engine.mockImplementation(
      (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_, reject) =>
          options?.signal?.addEventListener('abort', () => {
            aborted.push(true);
            reject(new Error('aborted'));
          }),
        ),
    );
    return aborted;
  };

  it('S33 AS-13: only visible products are suggested, and one letter does not reach the engine', async () => {
    const shopId = newId();
    const suspendedShop = newId();
    const [visible, archived, sandbox, suspended] = [
      newId(),
      newId(),
      newId(),
      newId(),
    ];
    await deliver(t.app).products(
      productEvent(
        'created',
        snapshot({ productId: visible, shopId, title: 'Lumen desk lamp' }),
      ),
      productEvent(
        'created',
        snapshot({ productId: archived, shopId, title: 'Lumen archived lamp' }),
      ),
      productEvent(
        'created',
        snapshot({
          productId: sandbox,
          shopId,
          title: 'Lumen sandbox lamp',
          isSandbox: true,
        }),
      ),
      productEvent(
        'created',
        snapshot({
          productId: suspended,
          shopId: suspendedShop,
          title: 'Lumen suspended lamp',
        }),
      ),
    );
    await deliver(t.app).products(
      productEvent(
        'archived',
        snapshot({
          productId: archived,
          shopId,
          title: 'Lumen archived lamp',
          status: 'ARCHIVED',
          productVersion: 2,
        }),
      ),
    );
    await deliver(t.app).shops(
      shopStatusEvent(suspendedShop, 'SUSPENDED', 2, t.clock.now()),
    );
    await t.refresh();
    engine.mockClear();

    const { body: answer } = await body('lum');
    expect(answer.suggestions).toEqual([
      { text: 'Lumen desk lamp', source: 'catalog' },
    ]);
    expect(answer.degraded).toEqual([]);
    expect(engine).toHaveBeenCalledTimes(1);

    engine.mockClear();
    const { body: one } = await body('l');
    expect(one.suggestions).toEqual([]);
    expect(engine).not.toHaveBeenCalled();
  });

  it('S33 AS-16: a catalog slower than its budget costs only its entries: 200 within 250 ms, catalog_timeout, no-store, call aborted, metric +1', async () => {
    const aborted = hang();
    const before = degraded('catalog_timeout');
    const started = Date.now();
    const { res, body: answer } = await body('hang');
    expect(Date.now() - started).toBeLessThanOrEqual(250);
    expect(answer.degraded).toEqual(['catalog_timeout']);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(aborted).toEqual([true]);
    expect(degraded('catalog_timeout')).toBe(before + 1);
    // the query half is still answered
    expect((await body('iph')).body.suggestions.map((s) => s.source)).toContain(
      'query',
    );
  });

  it.each([
    [
      'a rejected call',
      () => new Error('SECRET-ENGINE-TEXT connect ECONNREFUSED'),
      'catalog_unavailable',
    ],
    [
      'a 5xx from the engine',
      () => new EngineUnavailableError('SECRET-ENGINE-TEXT 503'),
      'catalog_unavailable',
    ],
    [
      'a typed engine timeout',
      () =>
        new EngineUnavailableError('SECRET-ENGINE-TEXT', {
          name: 'TimeoutError',
        }),
      'catalog_timeout',
    ],
  ])(
    'S33 AS-17: %s is named in degraded and no error text leaves the service',
    async (_name, fail, reason) => {
      failWith(fail);
      const lines: string[] = [];
      const capture = (...args: unknown[]) =>
        void lines.push(args.map(String).join(' '));
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation(capture as never);

      const { res, body: answer } = await body('failing');
      expect(answer.degraded).toEqual([reason]);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).not.toContain('SECRET-ENGINE-TEXT');
      expect(lines.join('\n')).not.toContain('SECRET-ENGINE-TEXT');
    },
  );

  it('S33 AS-18: no snapshot and a failing catalog is a 200 with an empty list and both reasons', async () => {
    await t.resetAutocomplete(); // the pointer is gone; a node that starts now has no index
    const fresh = await startNode();
    jest
      .spyOn(fresh.engine, 'search')
      .mockImplementation(() => Promise.reject(new Error('down')));
    const res = await fresh
      .http()
      .get('/api/suggest')
      .query({ q: 'iph' })
      .expect(200);
    expect(suggestResponseSchema.parse(res.body)).toEqual({
      prefix: 'iph',
      suggestions: [],
      degraded: ['query_index_unavailable', 'catalog_unavailable'],
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('S33 AS-19: five failures open the breaker, the sixth call is skipped, one probe after ten seconds, concurrent calls skip, success closes it', async () => {
    failWith(() => new Error('down'));
    for (const q of ['aa', 'ab', 'ac', 'ad', 'ae'])
      expect((await body(q)).body.degraded).toEqual(['catalog_unavailable']);
    expect(engine).toHaveBeenCalledTimes(5);

    expect((await body('af')).body.degraded).toEqual(['catalog_unavailable']);
    expect(engine).toHaveBeenCalledTimes(5); // skipped, not called

    t.clock.advance(10_000);
    expect((await body('ag')).body.degraded).toEqual(['catalog_unavailable']); // the probe fails: open again
    expect(engine).toHaveBeenCalledTimes(6);
    expect((await body('ah')).body.degraded).toEqual(['catalog_unavailable']);
    expect(engine).toHaveBeenCalledTimes(6);

    t.clock.advance(10_000);
    engine.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { hits: { hits: [{ _source: { title: 'Probe lamp' } }] } };
    });
    const [x, y] = await Promise.all([get('lamp1'), get('lamp2')]);
    const answers = [x, y].map((r) => suggestResponseSchema.parse(r.body));
    expect(answers.filter((a) => a.degraded.length > 0)).toHaveLength(1);
    expect(engine).toHaveBeenCalledTimes(7); // one probe, the other call skipped

    const closed = await body('lamp3'); // recovered
    expect(closed.body.degraded).toEqual([]);
    expect(closed.body.suggestions).toContainEqual({
      text: 'Probe lamp',
      source: 'catalog',
    });
    expect(MetricsRegistry.value('autocomplete_circuit_state')).toBe(0);
  });

  it('S33 AS-20: one call per prefix per minute, whatever the case; failures are never cached', async () => {
    await seedProducts(t, newId(), [{ title: 'Cacheable probe' }]);
    engine.mockClear();
    for (const q of ['cac', 'cac', 'cac', 'CAC']) await body(q);
    expect(engine).toHaveBeenCalledTimes(1);

    t.clock.advance(59_000);
    await body('cac');
    expect(engine).toHaveBeenCalledTimes(1);
    t.clock.advance(1_000);
    await body('cac');
    expect(engine).toHaveBeenCalledTimes(2);

    engine.mockClear();
    failWith(() => new Error('down'));
    await body('fail');
    await body('fail');
    expect(engine).toHaveBeenCalledTimes(2); // the failure was not remembered
  });
});

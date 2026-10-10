import {
  closeNodes,
  createAutocompleteApp,
  type AutocompleteTestApp,
} from './testing/autocomplete-app';

/**
 * SD-12 end to end against real ClickHouse + object storage + Redis: logs → build → snapshot → hot swap → /suggest.
 * The detailed rows live in the autocomplete-suggest, -sources and -snapshot specs; this file keeps the original
 * whole-journey checks (S33) against the new API.
 */
describe('Autocomplete (e2e)', () => {
  let t: AutocompleteTestApp;

  beforeAll(async () => {
    t = await createAutocompleteApp();
  });
  afterAll(() => closeNodes(t));
  beforeEach(async () => {
    await t.resetSearch();
    await t.resetAutocomplete();
    // an open breaker from an earlier test would hide the catalog half
    t.clock.advance(10_000);
  });
  afterEach(() => jest.restoreAllMocks());

  it('S33 SD-12: popular, successful queries become suggestions; rare, failed and blocklisted ones do not', async () => {
    await t.logQuery('iphone 17', 50);
    await t.logQuery('iphone charger', 20);
    await t.logQuery('iphne 17', 2); // typo: too rare
    await t.logQuery('iphone xyz9000', 30, { results: 0 }); // returns nothing
    await t.logQuery('iphone hacked', 40); // blocklisted

    const outcome = await t.publish();
    expect(outcome).toMatchObject({ outcome: 'published', queries: 2 });

    const res = await t
      .http()
      .get('/api/suggest')
      .query({ q: 'IPH' })
      .expect(200);
    const queries = (res.body.suggestions as { text: string; source: string }[])
      .filter((s) => s.source === 'query')
      .map((s) => s.text);
    expect(queries).toEqual(['iphone 17', 'iphone charger']);
    expect(res.body.prefix).toBe('iph');
    expect(res.headers['cache-control']).toContain('s-maxage=60');
  });

  it('S33 SD-12: a slow product index degrades to query suggestions within the budget', async () => {
    await t.logQuery('iphone 17', 50);
    await t.publish();
    jest
      .spyOn(t.engine, 'search')
      .mockImplementation(
        (_params: unknown, options?: { signal?: AbortSignal }) =>
          new Promise((_, reject) =>
            options?.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            ),
          ),
      );

    const started = Date.now();
    const result = await t.suggest('ipho');

    expect(result.degraded).toContain('catalog_timeout');
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

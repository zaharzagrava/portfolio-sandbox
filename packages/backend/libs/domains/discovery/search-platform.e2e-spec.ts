import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { boundaryCheck, ownershipCheck } from '@app/test/utils/static-checks';
import { productSearchResponseSchema } from '@marketplace-sandbox/contracts';
import { EventPublisher } from '@app/infrastructure/events/event-publisher';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { AuthApiModule } from '@app/domains/identity';
import * as discovery from './index';
import {
  ProductSearchModule,
  ProductSearchService,
  ProductTitleSuggester,
  SearchProjectorModule,
  SearchUnavailableError,
  SearchValidationError,
  SearchWorkerModule,
  SuggestionTimeoutError,
} from './index';
import { SEARCH_EVENT_PUBLISHER } from './domain/ports';
import { createSearchApp, type SearchTestApp } from './testing/search-app';
import {
  deliver,
  newId,
  productDeleted,
  shopStatusEvent,
} from './testing/search-events';
import { seedProducts } from './testing/search-fixtures';

const BACKEND = resolve(__dirname, '../../..');
const SEARCH_CODE = __dirname;

/** Code without its comments: a doc line may say "no ProductModel" without importing one. */
const code = (file: string): string =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Every non-spec source file of the discovery domain. */
const sources = (dir = SEARCH_CODE): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.(e2e-)?spec\.ts$/.test(name) ? [path] : [];
  });

describe('Search exported services and module boundary', () => {
  let t: SearchTestApp;
  let shopId: string;
  let published: jest.SpyInstance;

  beforeAll(async () => {
    t = await createSearchApp({ engineProxy: true });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetSearch();
    shopId = newId();
    const adapter = t.app.get(SEARCH_EVENT_PUBLISHER, {
      strict: false,
    }) as unknown as { publisher: EventPublisher };
    published = jest.spyOn(adapter.publisher, 'publish');
  });
  afterEach(() => jest.restoreAllMocks());

  describe('ProductSearchService for other domains (AS-78)', () => {
    it('S32 AS-78: returns the route\'s answer with the same visibility, no vectors, surface "internal", and refuses limit above 20 and any cursor or facets', async () => {
      const [visible] = await seedProducts(t, shopId, [
        { title: 'iPhone 17 Pro Case' },
        { title: 'iPhone Archived Case', status: 'ARCHIVED' },
        { title: 'iPhone Sandbox Case', isSandbox: true },
      ]);
      const service = t.app.get(ProductSearchService);

      const answer = await service.search({
        query: { q: 'iphone', limit: 20 },
        surface: 'internal',
        subject: 'service:assistant',
      });

      const route = productSearchResponseSchema.parse(
        (
          await t
            .http()
            .get('/api/products/search')
            .query({ q: 'iphone' })
            .expect(200)
        ).body,
      );
      expect(answer.items.map((i) => i.id)).toEqual([visible]);
      expect(answer.items).toEqual(route.items);
      expect(answer.total).toEqual(route.total);
      expect(JSON.stringify(answer)).not.toMatch(/embedding|vector/);
      const event = published.mock.calls
        .map(([e]) => e as { type: string; payload: Record<string, unknown> })
        .find((e) => e.type === 'search.performed');
      expect(event?.payload).toMatchObject({
        surface: 'internal',
        query: 'iphone',
      });

      for (const query of [
        { q: 'iphone', limit: 21 },
        { q: 'iphone', cursor: 'abc' },
        { q: 'iphone', facets: true },
      ])
        await expect(
          service.search({ query, surface: 'internal', subject: 's' }),
        ).rejects.toBeInstanceOf(SearchValidationError);
    });

    it('S32 AS-78: an engine outage is the exported SearchUnavailableError', async () => {
      const service = t.app.get(ProductSearchService);
      t.proxy!.mode = 'refuse';
      t.proxy!.sever();
      await expect(
        service.search({
          query: { q: 'x' },
          surface: 'internal',
          subject: 's',
        }),
      ).rejects.toBeInstanceOf(SearchUnavailableError);
    });
  });

  describe('ProductTitleSuggester (AS-79)', () => {
    it('S32 AS-79: suggests visible titles only, at most the size asked (never above 10), also for a typo', async () => {
      const hiddenShop = newId();
      const ids = await seedProducts(t, shopId, [
        { title: 'Alpine Parka' },
        { title: 'Alpine Boots' },
        { title: 'Alpine Archived', status: 'ARCHIVED' },
        { title: 'Alpine Sandbox', isSandbox: true },
        { title: 'Alpine Deleted' },
      ]);
      await seedProducts(t, hiddenShop, [{ title: 'Alpine Suspended' }]);
      await deliver(t.app).products(
        productDeleted(ids[4], shopId, 2, t.clock.now()),
      );
      await deliver(t.app).shops(
        shopStatusEvent(hiddenShop, 'SUSPENDED', 5, t.clock.now()),
      );
      await t.refresh();
      const suggester = t.app.get(ProductTitleSuggester);

      expect((await suggester.suggestTitles('alp', 10)).sort()).toEqual([
        'Alpine Boots',
        'Alpine Parka',
      ]);
      expect(await suggester.suggestTitles('alp', 1)).toHaveLength(1);
      expect(await suggester.suggestTitlesFuzzy('alpne par', 5)).toEqual([
        'Alpine Parka',
      ]);
      for (const size of [0, 11, 1.5])
        await expect(
          suggester.suggestTitles('alp', size),
        ).rejects.toBeInstanceOf(SearchValidationError);
    });

    it('S32 AS-79: an aborted signal, or an engine that never answers, ends in the typed SuggestionTimeoutError', async () => {
      await seedProducts(t, shopId, [{ title: 'Alpine Parka' }]);
      const suggester = t.app.get(ProductTitleSuggester);

      await expect(
        suggester.suggestTitles('alp', 5, AbortSignal.abort()),
      ).rejects.toBeInstanceOf(SuggestionTimeoutError);

      t.proxy!.mode = 'hang';
      const started = Date.now();
      await expect(
        suggester.suggestTitles('alp', 5, AbortSignal.timeout(300)),
      ).rejects.toBeInstanceOf(SuggestionTimeoutError);
      await expect(suggester.suggestTitles('alp', 5)).rejects.toBeInstanceOf(
        SuggestionTimeoutError,
      );
      expect(Date.now() - started).toBeLessThan(4_000);
    });
  });

  describe('module boundary (AS-80)', () => {
    it('S32 AS-80: the barrel exports modules, services, errors and event contracts, and no projector, consumer, logger or model', () => {
      const names = Object.keys(discovery);
      expect(names).toEqual(
        expect.arrayContaining([
          'ProductSearchModule',
          'SearchProjectorModule',
          'SearchWorkerModule',
          'ProductSearchService',
          'ProductTitleSuggester',
          'SearchPerformed',
          'SearchResultClicked',
          'SearchReindexCompleted',
        ]),
      );
      expect(
        names.filter((n) => /(Projector|Consumer|Logger|Model)$/.test(n)),
      ).toEqual([]);
      expect(names).not.toContain('SearchAdminModule');
      expect(names).not.toContain('SearchQueryLogger');
    });

    it('S32 AS-80: search code uses no foreign model, no deep import of another domain, and the catalog imports nothing from discovery', () => {
      const offenders: string[] = [];
      for (const file of sources()) {
        const text = code(file);
        if (
          /\b(ProductModel|ShopModel|ShopMembershipModel|MembershipService)\b/.test(
            text,
          )
        )
          offenders.push(`${file}: foreign model or service`);
        if (
          /@app\/domains\/[a-z-]+\/(infra|application|domain|api)\//.test(text)
        )
          offenders.push(`${file}: deep import of another domain`);
        if (
          /(FROM|JOIN|UPDATE|INTO)\s+"(Product|Shop|ShopMembership|BisOrder|ShopOrder)"/i.test(
            text,
          )
        )
          offenders.push(`${file}: SQL on a foreign table`);
      }
      expect(offenders).toEqual([]);

      const catalog = resolve(BACKEND, 'libs/domains/catalog');
      const catalogImports = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) return catalogImports(path);
          return /\.ts$/.test(name) &&
            /@app\/domains\/discovery/.test(readFileSync(path, 'utf8'))
            ? [path]
            : [];
        });
      expect(
        catalogImports(catalog).filter((f) => !/spec\.ts$/.test(f)),
      ).toEqual([]);
    });

    it('S32 AS-80: the generic engine client carries no product knowledge', () => {
      const dir = resolve(BACKEND, 'libs/infrastructure/elasticsearch');
      for (const name of [
        'search-engine.client.ts',
        'search-engine.errors.ts',
      ]) {
        expect(code(join(dir, name))).not.toMatch(
          /product|catalog|embedding|shopId/i,
        );
      }
    });

    it('S32 AS-80: check:boundaries is green and check:table-ownership reports nothing for discovery', async () => {
      // the two checks do not depend on each other: run them side by side
      const [boundaries, ownership] = await Promise.all([
        boundaryCheck(BACKEND),
        ownershipCheck(BACKEND),
      ]);
      expect(boundaries.status).toBe(0);
      expect(boundaries.stdout + boundaries.stderr).toMatch(
        /no dependency violations/i,
      );

      expect(ownership.stdout).not.toMatch(/^discovery\s/m);
      expect(ownership.stdout).not.toMatch(/libs\/domains\/discovery\//);
    }, 300_000);
  });
});

// Last in the file: closing a second application closes the models' shared connection, so the specs above are done first.
describe('Search exported services and module boundary: a lean application', () => {
  it('S32 AS-80: an application loading only the three search modules boots and searches', async () => {
    const moduleRef = await generateTestingModule(
      [
        AuthApiModule,
        ProductSearchModule,
        SearchProjectorModule,
        SearchWorkerModule,
      ],
      { stores: ['redis', 'dynamo'] },
    );
    const app = moduleRef.createNestApplication({ bufferLogs: false });
    await app.init();
    try {
      const answer = await app.get(ProductSearchService).search({
        query: { q: 'anything' },
        surface: 'internal',
        subject: 'boot-test',
      });
      expect(answer.items).toBeDefined();
    } finally {
      await app.close();
    }
  }, 120_000);
});

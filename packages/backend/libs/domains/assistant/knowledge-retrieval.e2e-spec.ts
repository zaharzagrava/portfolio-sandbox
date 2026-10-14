import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  KnowledgeSearchService,
  normalizeQuestion,
  questionCacheKey,
} from './application/knowledge-search.service';
import type { RetrievalScope } from './domain/scope';
import {
  createKnowledgeApp,
  type KnowledgeTestApp,
  type Seller,
} from './testing/knowledge.fixtures';

describe('RAG: hybrid retrieval and in-query permissions', () => {
  let t: KnowledgeTestApp;

  beforeAll(async () => {
    t = await createKnowledgeApp();
  }, 180_000);
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const search = (scope: RetrievalScope, question: string, k?: number) =>
    t.app.get(KnowledgeSearchService).search(scope, question, { k });
  const titles = (result: { items: { title: string }[] }) =>
    result.items.map((i) => i.title).sort();
  const redis = () => t.app.get(RedisService).client;

  describe('isolation table (AS-35, AS-36, AS-37)', () => {
    let a: Seller;
    let b: Seller;
    let pa2: string;

    const RETURNS = (tag: string) =>
      `# Returns\nThe return window for every order is thirty days. Tag ${tag}.`;
    const QUESTION = 'how long is the return window';

    beforeEach(async () => {
      a = await t.seller();
      b = await t.seller();
      pa2 = (await t.product(a.shopId)).id;
      const admin = await t.admin();
      await t.index(a, 'D1', RETURNS('d1'), { productId: a.product.id });
      await t.index(a, 'D2', RETURNS('d2'), { productId: pa2 });
      await t.index(a, 'D3', RETURNS('d3'));
      await t.index(a, 'D4', RETURNS('d4'), { visibility: 'SHOP_PRIVATE' });
      await t.index(b, 'D5', RETURNS('d5'), { productId: b.product.id });
      await t.index(b, 'D7', RETURNS('d7'), { visibility: 'SHOP_PRIVATE' });
      await t.platformArticle(admin, 'D6', RETURNS('d6'));
    });

    it('S47 AS-35: a buyer’s scope returns only the product’s and the shop-level public passages', async () => {
      const result = await search(
        { kind: 'product', productId: a.product.id, shopId: a.shopId },
        QUESTION,
      );
      expect(titles(result)).toEqual(['D1', 'D3']);
      expect(result.mode).toBe('hybrid');
    });

    it('S47 AS-35: the other product of the shop sees its own document and the shop-level one', async () => {
      const result = await search(
        { kind: 'product', productId: pa2, shopId: a.shopId },
        QUESTION,
      );
      expect(titles(result)).toEqual(['D2', 'D3']);
    });

    it('S47 AS-36: a member’s scope returns platform plus the shop’s public and private, never another shop’s', async () => {
      const result = await search({ kind: 'shop', shopId: a.shopId }, QUESTION);
      expect(titles(result)).toEqual(['D1', 'D2', 'D3', 'D4', 'D6']);
      const other = await search({ kind: 'shop', shopId: b.shopId }, QUESTION);
      expect(titles(other)).toEqual(['D5', 'D6', 'D7']);
    });

    it('S47 AS-35: every returned passage belongs to a document of the scope (hydration repeats the predicate)', async () => {
      const result = await search({ kind: 'shop', shopId: a.shopId }, QUESTION);
      const rows = await t.db.query<{
        id: string;
        shopId: string | null;
        visibility: string;
      }>(
        `SELECT id, "shopId", visibility FROM "KnowledgeChunk" WHERE id IN (:ids)`,
        {
          replacements: { ids: result.items.map((i) => i.id) },
          type: 'SELECT' as never,
        },
      );
      expect(rows.length).toBe(result.items.length);
      for (const r of rows)
        expect(r.shopId === a.shopId || r.visibility === 'PLATFORM').toBe(true);
    });

    it('S47 AS-37: 300 stronger foreign passages never starve the caller’s 3; an empty scope is empty, not an error', async () => {
      const heavy = Array.from(
        { length: 300 },
        (_, i) =>
          `# Section ${i}\n## c\nsupplier margin with Acme supplier margin with Acme supplier margin with Acme number ${i}`,
      ).join('\n');
      await t.index(b, 'Supplier sheets', heavy, {
        visibility: 'SHOP_PRIVATE',
      });
      const weak = [
        '# One\n## a\nOur supplier margin with Acme is 37 percent.',
        '# Two\n## b\nThe supplier margin with Acme is reviewed yearly.',
        '# Three\n## c\nAbout the supplier margin with Acme: ask finance.',
      ].join('\n');
      await t.index(a, 'Own notes', weak, { visibility: 'SHOP_PRIVATE' });
      const question = 'supplier margin with Acme';

      const own = await search(
        { kind: 'shop', shopId: a.shopId },
        question,
        20,
      );
      expect(own.items.filter((i) => i.title === 'Own notes')).toHaveLength(3);
      expect(own.items.every((i) => i.title !== 'Supplier sheets')).toBe(true);
      // The foreign passages really are the stronger matches: in their own scope they fill the whole result.
      const foreign = await search(
        { kind: 'shop', shopId: b.shopId },
        question,
        20,
      );
      expect(foreign.items.length).toBe(20);
      expect(foreign.items.every((i) => i.title === 'Supplier sheets')).toBe(
        true,
      );

      const empty = await t.seller();
      const none = await search(
        { kind: 'shop', shopId: empty.shopId },
        question,
      );
      expect(none.items).toEqual([]);
    }, 120_000);
  });

  describe('S47 AS-43: hybrid retrieval', () => {
    let s: Seller;
    beforeEach(async () => {
      s = await t.seller();
      await t.index(
        s,
        'Connectivity',
        '# Network\nThe handset accepts a virtual SIM.',
        {
          productId: s.product.id,
        },
      );
      await t.index(
        s,
        'Accessories',
        '# Chargers\nCompatible charger: model PX-45W-GAN2 only.',
        {
          productId: s.product.id,
        },
      );
      await t.index(s, 'Care', '# Charging\nPlug in the supplied cable.', {
        productId: s.product.id,
      });
    });
    const buyer = () =>
      ({ kind: 'product', productId: s.product.id, shopId: s.shopId }) as const;

    it('S47 AS-43: a paraphrase is found by meaning, not by words', async () => {
      t.config.set('rag_min_similarity', 0.05);
      const result = await search(buyer(), 'does it support eSIM');
      expect(result.mode).toBe('hybrid');
      expect(result.items[0]).toMatchObject({ title: 'Connectivity' });
      expect(result.items[0].similarity).toBeGreaterThan(0.05);
      // Keywords alone cannot find it: with the embedder down the same question (asked differently, so it is not
      // served from the embedding cache) finds nothing.
      t.embedder.failures = Infinity;
      const keywordOnly = await search(buyer(), 'does it support eSIM at all');
      expect(keywordOnly).toEqual({ mode: 'keyword', items: [] });
    });

    it('S47 AS-43: a model number is found by the keyword search alone when the meaning floor is raised', async () => {
      t.config.set('rag_min_similarity', 1.01); // nothing can pass the meaning floor
      const result = await search(buyer(), 'PX-45W-GAN2');
      expect(result.items.map((i) => i.title)).toEqual(['Accessories']);
      expect(result.items[0].content).toContain('PX-45W-GAN2');
    });

    it('S47 AS-43: a heading word that is not in the body still matches (headings weigh more than body text)', async () => {
      t.config.set('rag_min_similarity', 1.01);
      const result = await search(buyer(), 'charging');
      expect(result.items.map((i) => i.title)).toEqual(['Care']);
      expect(result.items[0].content).not.toMatch(/charging/i);
    });
  });

  describe('S47 AS-45: relevance floor', () => {
    it('S47 AS-45: a meaning hit below the floor counts only when the keyword search also found it; off-topic is empty', async () => {
      const s = await t.seller();
      await t.index(
        s,
        'Keyword doc',
        '# Network\nThe phone supports eSIM and dual SIM cards.',
        {
          productId: s.product.id,
        },
      );
      await t.index(
        s,
        'Meaning doc',
        '# Network\nThe handset accepts a virtual SIM.',
        {
          productId: s.product.id,
        },
      );
      const scope = {
        kind: 'product',
        productId: s.product.id,
        shopId: s.shopId,
      } as const;

      t.config.set('rag_min_similarity', 0.05);
      expect(titles(await search(scope, 'esim'))).toEqual([
        'Keyword doc',
        'Meaning doc',
      ]);

      t.config.set('rag_min_similarity', 0.9);
      const strict = await search(scope, 'esim');
      expect(titles(strict)).toEqual(['Keyword doc']); // found by keywords; the meaning-only hit is below the floor
      expect(strict.items[0].similarity).toBeLessThan(0.9);

      const offTopic = await search(scope, 'zebra migration patterns savanna');
      expect(offTopic.items).toEqual([]);
    });
  });

  describe('S47 AS-46: embedding provider down → keyword-only', () => {
    let s: Seller;
    const scope = () =>
      ({ kind: 'product', productId: s.product.id, shopId: s.shopId }) as const;
    beforeEach(async () => {
      s = await t.seller();
      await t.index(
        s,
        'Manual',
        '# Connectivity\nThe Pixel supports eSIM and dual SIM.',
        {
          productId: s.product.id,
        },
      );
      t.embedder.reset();
    });

    it('S47 AS-46: a failing embedder degrades to keywords, counts it and is not retried within the request', async () => {
      t.embedder.failures = Infinity;
      const before = t.metric('rag_retrieval_degraded_total', {
        reason: 'embed_failed',
      });

      const result = await search(scope(), 'does the Pixel support eSIM');

      expect(result.mode).toBe('keyword');
      expect(titles(result)).toEqual(['Manual']);
      expect(
        t.metric('rag_retrieval_degraded_total', { reason: 'embed_failed' }),
      ).toBe(before + 1);
      expect(t.embedder.queryCalls).toHaveLength(1);
    });

    it('S47 AS-46: a stalled embedder is cut off after the deadline and the question is still answered from keywords', async () => {
      t.config.set('rag_query_embed_timeout_ms', 250);
      t.embedder.stalled = true;
      const before = t.metric('rag_retrieval_degraded_total', {
        reason: 'embed_timeout',
      });
      const started = Date.now();

      const result = await search(scope(), 'does the Pixel support eSIM');

      expect(Date.now() - started).toBeLessThan(3_000);
      expect(result.mode).toBe('keyword');
      expect(titles(result)).toEqual(['Manual']);
      expect(
        t.metric('rag_retrieval_degraded_total', { reason: 'embed_timeout' }),
      ).toBe(before + 1);
      expect(t.embedder.queryCalls).toHaveLength(1);
    });

    it('S47 AS-46: with no keyword match the degraded search finds nothing', async () => {
      t.embedder.failures = Infinity;
      const result = await search(scope(), 'zebra migration patterns savanna');
      expect(result).toEqual({ mode: 'keyword', items: [] });
    });
  });

  describe('S47 AS-47: question-embedding cache', () => {
    let s: Seller;
    const scope = () =>
      ({ kind: 'product', productId: s.product.id, shopId: s.shopId }) as const;
    beforeEach(async () => {
      s = await t.seller();
      await t.index(
        s,
        'Manual',
        '# Connectivity\nThe Pixel supports eSIM and dual SIM.',
        {
          productId: s.product.id,
        },
      );
      t.embedder.reset();
    });

    it('S47 AS-47: case and whitespace variants embed once; the key holds the model and the entry expires after 24 h', async () => {
      const first = await search(scope(), 'Does it support eSIM?');
      const second = await search(scope(), '  does   IT support  esim?  ');

      expect(t.embedder.queryCalls).toHaveLength(1);
      expect(titles(first)).toEqual(['Manual']);
      expect(titles(second)).toEqual(['Manual']);
      const key = questionCacheKey(
        'hashing-1024',
        normalizeQuestion('Does it support eSIM?'),
      );
      expect(key).toMatch(/^rag:qe:v1:[0-9a-f]{64}$/);
      expect(await redis().exists(key)).toBe(1);
      const ttl = await redis().ttl(key);
      expect(ttl).toBeGreaterThan(86_000);
      expect(ttl).toBeLessThanOrEqual(86_400);

      t.embedder.model = 'another-model';
      await search(scope(), 'Does it support eSIM?');
      expect(t.embedder.queryCalls).toHaveLength(2); // another model → another key → embedded again
      expect(
        questionCacheKey(
          'another-model',
          normalizeQuestion('Does it support eSIM?'),
        ),
      ).not.toBe(key);
      expect(
        await redis().exists(
          questionCacheKey(
            'another-model',
            normalizeQuestion('Does it support eSIM?'),
          ),
        ),
      ).toBe(1);
    });

    it('S47 AS-47: with the cache store down the question is embedded again and answered correctly', async () => {
      const get = jest
        .spyOn(redis(), 'getBuffer')
        .mockRejectedValue(new Error('redis down'));
      const set = jest
        .spyOn(redis(), 'set')
        .mockRejectedValue(new Error('redis down'));
      const errors = t.metric('rag_cache_errors_total', { op: 'get' });

      const first = await search(scope(), 'Does it support eSIM?');
      const second = await search(scope(), 'Does it support eSIM?');

      expect(titles(first)).toEqual(['Manual']);
      expect(titles(second)).toEqual(['Manual']);
      expect(t.embedder.queryCalls).toHaveLength(2);
      expect(t.metric('rag_cache_errors_total', { op: 'get' })).toBe(
        errors + 2,
      );
      get.mockRestore();
      set.mockRestore();
    });
  });
});

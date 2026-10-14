import { Logger } from '@nestjs/common';
import {
  productSearchResponseSchema,
  synonymsPutResponseSchema,
  synonymsSchema,
} from '@marketplace-sandbox/contracts';
import { createSearchApp, type SearchTestApp } from './testing/search-app';
import { newId } from './testing/search-events';
import { seedProducts } from './testing/search-fixtures';

describe('Search synonyms administration', () => {
  let t: SearchTestApp;
  let adminUser: Awaited<ReturnType<SearchTestApp['admin']>>;
  let shopId: string;

  beforeAll(async () => {
    t = await createSearchApp({ engineProxy: true });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetSearch();
    adminUser = await t.admin();
    shopId = newId();
  });
  afterEach(() => jest.restoreAllMocks());

  const put = (body: unknown) =>
    t
      .as(adminUser)
      .put('/api/admin/search/synonyms')
      .send(body as object);
  const get = () => t.as(adminUser).get('/api/admin/search/synonyms');
  const found = async (q: string) =>
    productSearchResponseSchema
      .parse((await t.http().get('/api/products/search').query({ q })).body)
      .items.map((i) => i.title);
  const versions = () =>
    t.rows<{ version: number }>(
      `SELECT "version" FROM "SearchSynonymVersion" ORDER BY "version"`,
    );

  describe('applying rules (AS-53, AS-54)', () => {
    it('S32 AS-53: a rule makes the next search find the product without a reindex, a new index or a rewritten document', async () => {
      const [airpods] = await seedProducts(t, shopId, [
        { title: 'AirPods Pro' },
      ]);
      // version 1 holds the seeded defaults (which know "earbuds"); replace them with an unrelated rule
      await put({ rules: ['zzzfoo, zzzbar'], expectedVersion: 1 }).expect(200);
      expect(await found('earbuds')).toEqual([]);
      const before = await t.indices();
      const docBefore = await t.es.get({ index: 'products', id: airpods });

      const res = await put({
        rules: ['airpods, earbuds'],
        expectedVersion: 2,
      }).expect(200);

      const body = synonymsPutResponseSchema.parse(res.body);
      expect(body).toMatchObject({
        version: 3,
        ruleCount: 1,
        unchanged: false,
      });
      expect(await found('earbuds')).toEqual(['AirPods Pro']);
      expect(await t.indices()).toEqual(before);
      const docAfter = await t.es.get({ index: 'products', id: airpods });
      expect(docAfter._seq_no).toBe(docBefore._seq_no);
      const runs = await t.rows(`SELECT 1 FROM "SearchReindexRun"`);
      expect(runs).toEqual([]);

      // an empty set is a valid edit: the engine cannot hold zero rules, the service keeps an inert placeholder
      const cleared = await put({ rules: [], expectedVersion: 3 }).expect(200);
      expect(cleared.body).toMatchObject({ version: 4, ruleCount: 0 });
      expect(await found('earbuds')).toEqual([]);
      expect(synonymsSchema.parse((await get()).body).rules).toEqual([]);
    });

    it('S32 AS-54: one-way, two-way and multi-word rules match as written', async () => {
      await seedProducts(t, shopId, [
        { title: 'Television 55 inch' },
        { title: 'TV Stand 55 inch' },
        { title: 'Sneakers Pro' },
        { title: 'Trainers Pro' },
        { title: 'USB-C cable' },
      ]);
      await put({
        rules: [
          'tv => television',
          'sneakers, trainers',
          'usb c, usb-c, type c',
        ],
        expectedVersion: 1,
      }).expect(200);

      expect(await found('tv')).toContain('Television 55 inch');
      expect(await found('television')).not.toContain('TV Stand 55 inch');
      expect(await found('trainers')).toContain('Sneakers Pro');
      expect(await found('sneakers')).toContain('Trainers Pro');
      expect(await found('usb c')).toContain('USB-C cable');
    });
  });

  describe('validation (AS-55)', () => {
    const invalid: [string, string[], string][] = [
      ['empty rule', ['   '], 'empty'],
      ['one term', ['airpods'], 'too_few_terms'],
      ['empty side', ['tv =>'], 'empty_side'],
      ['disallowed characters', ['a, <script>'], 'invalid_character'],
      ['duplicate', ['a, b', 'b, a'], 'duplicate'],
      ['cycle', ['a => b', 'b => a'], 'cycle'],
      ['too long', [`a, ${'b'.repeat(250)}`], 'too_long'],
    ];

    it.each(invalid)(
      'S32 AS-55: %s answers 422 invalid_synonym_rules naming the rule and leaves state unchanged',
      async (_name, rules, code) => {
        const res = await put({ rules, expectedVersion: 1 }).expect(422);
        expect(res.body.code).toBe('invalid_synonym_rules');
        expect(res.body.errors.map((e: { code: string }) => e.code)).toContain(
          code,
        );
        expect(res.body.errors[0]).toHaveProperty('index');
        expect(
          synonymsSchema.parse((await get().expect(200)).body).version,
        ).toBe(1);
      },
    );

    it('S32 AS-55: more than 5,000 rules answer too_many; a body of the wrong shape answers 400', async () => {
      const rules = Array.from({ length: 5_001 }, (_, i) => `a${i}, b${i}`);
      const res = await put({ rules, expectedVersion: 1 }).expect(422);
      expect(res.body.errors).toEqual([{ index: 5_000, code: 'too_many' }]);
      for (const body of [
        {},
        { rules: 'x', expectedVersion: 1 },
        { rules: [], expectedVersion: '1' },
        { rules: [1], expectedVersion: 1 },
        { rules: [], expectedVersion: 1, extra: true },
      ]) {
        const bad = await put(body).expect(400);
        expect(bad.body.code).toBe('validation_failed');
      }
    });
  });

  describe('concurrency and replay (AS-56, AS-57)', () => {
    it('S32 AS-56: two edits at the same version produce one winner and one 409 with the current version; a stale version always conflicts', async () => {
      await put({ rules: ['a, b'], expectedVersion: 1 }).expect(200); // version 2
      const [one, two] = await Promise.all([
        put({ rules: ['c, d'], expectedVersion: 2 }),
        put({ rules: ['e, f'], expectedVersion: 2 }),
      ]);

      expect([one.status, two.status].sort()).toEqual([200, 409]);
      const winner = one.status === 200 ? one : two;
      const loser = one.status === 200 ? two : one;
      expect(winner.body.version).toBe(3);
      expect(loser.body.code).toBe('synonyms_version_conflict');
      expect(loser.body.currentVersion).toBe(3);
      const current = synonymsSchema.parse((await get().expect(200)).body);
      expect(current.version).toBe(3);
      expect(current.rules).toEqual(winner === one ? ['c, d'] : ['e, f']);

      const stale = await put({ rules: ['g, h'], expectedVersion: 2 }).expect(
        409,
      );
      expect(stale.body.currentVersion).toBe(3);
    });

    it('S32 AS-57: the same PUT twice, or a stale version with identical rules, answers unchanged without an engine call', async () => {
      await put({ rules: ['a, b'], expectedVersion: 1 }).expect(200); // version 2
      const engine = jest.spyOn(t.engine, 'putSynonyms');

      const again = await put({ rules: ['b, a'], expectedVersion: 1 }).expect(
        200,
      );
      expect(again.body).toMatchObject({ version: 2, unchanged: true });
      const same = await put({ rules: ['a, b'], expectedVersion: 2 }).expect(
        200,
      );
      expect(same.body).toMatchObject({ version: 2, unchanged: true });
      expect(engine).not.toHaveBeenCalled();
      expect(synonymsSchema.parse((await get()).body).version).toBe(2);
    });
  });

  describe('failure, survival, read and audit (AS-58 to AS-60)', () => {
    it('S32 AS-58: an unavailable engine answers 503 and keeps the previous rules and version; a later PUT succeeds', async () => {
      await seedProducts(t, shopId, [{ title: 'AirPods Pro' }]);
      await put({ rules: ['airpods, earbuds'], expectedVersion: 1 }).expect(
        200,
      );
      t.proxy!.mode = 'refuse';
      t.proxy!.sever();

      const failed = await put({
        rules: ['airpods, buds'],
        expectedVersion: 2,
      });
      expect(failed.status).toBe(503);
      expect(failed.body.code).toBe('search_unavailable');
      const current = synonymsSchema.parse((await get().expect(200)).body);
      expect(current).toMatchObject({
        version: 2,
        rules: ['airpods, earbuds'],
      });

      t.proxy!.mode = 'pass';
      expect(await found('earbuds')).toEqual(['AirPods Pro']);
      const again = await put({
        rules: ['airpods, buds'],
        expectedVersion: 2,
      }).expect(200);
      expect(again.body.version).toBe(3);
    });

    it('S32 AS-59: rules survive a reindex', async () => {
      await seedProducts(t, shopId, [{ title: 'AirPods Pro' }]);
      await put({ rules: ['airpods, earbuds'], expectedVersion: 1 }).expect(
        200,
      );
      await t.resetHistory();
      const before = Object.keys(await t.indices());

      await t.as(adminUser).post('/api/admin/search/reindex').expect(202);
      await t.worker.runOnce();
      await t.refresh();

      expect(Object.keys(await t.indices()).length).toBeGreaterThanOrEqual(
        before.length,
      );
      expect(await found('earbuds')).toEqual(['AirPods Pro']);
    });

    it('S32 AS-60: GET returns version, rules, time and author; a PUT writes an audit line; history keeps the last 20 versions and 90 days, never the current below', async () => {
      const lines: unknown[] = [];
      jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation((message: unknown) => {
          lines.push(message);
        });
      const res = await put({ rules: ['a, b'], expectedVersion: 1 }).expect(
        200,
      );
      expect(res.body.version).toBe(2);
      const body = synonymsSchema.parse((await get().expect(200)).body);
      expect(body).toMatchObject({
        version: 2,
        rules: ['a, b'],
        updatedBy: adminUser.id,
      });
      const audit = lines.find(
        (l) =>
          typeof l === 'object' &&
          l !== null &&
          (l as { action?: string }).action === 'search.synonyms.put',
      );
      expect(audit).toMatchObject({
        actorId: adminUser.id,
        version: 2,
        ruleCount: 1,
      });
      expect(JSON.stringify(audit)).not.toMatch(/secret|token|bearer/i);
      expect((await versions()).map((v) => v.version)).toEqual([1, 2]);

      for (let v = 2; v < 24; v++)
        await put({ rules: [`x${v}, y${v}`], expectedVersion: v }).expect(200);
      const kept = (await versions()).map((v) => v.version);
      expect(kept).toHaveLength(20);
      expect(kept.at(-1)).toBe(24);
      expect(kept[0]).toBe(5);

      await t.sequelize.query(
        `UPDATE "SearchSynonymVersion" SET "createdAt" = now() - interval '91 days'`,
      );
      await put({ rules: ['final, last'], expectedVersion: 24 }).expect(200);
      expect((await versions()).map((v) => v.version)).toEqual([25]);
    });
  });
});

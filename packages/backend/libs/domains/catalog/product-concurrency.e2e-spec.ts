import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { EntitlementsService } from '@app/domains/billing';
import { ProductStockService } from '@app/domains/catalog';
import {
  productCount,
  productEvents,
  productRow,
} from '@app/test/utils/catalog-fixtures';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';
import {
  impossibleProductRows,
  NOTHING_IMPOSSIBLE,
} from './testing/catalog-invariants';

const validBody = {
  title: 'Wool coat',
  description: 'Warm',
  brand: 'Nord',
  category: 'coats',
  priceMinor: 12_900,
  quantity: 5,
  tags: ['winter'],
};

/** Parallel and repeated requests on products (QA track 3): after each race the database must hold no impossible row. */
describe('Product concurrency', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;
  let stock: ProductStockService;
  let w: ShopWorld;
  let limit: number | null = null;

  const rows = <R extends object>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<R>(sql, { type: QueryTypes.SELECT, replacements });

  const base = (shopId = w.shop.id) => `/api/shops/${shopId}/products`;
  const statuses = (results: Array<{ status: number }>) =>
    results.map((r) => r.status).sort();
  const count = (results: Array<{ status: number }>, status: number) =>
    results.filter((r) => r.status === status).length;

  /** A product made through the API, so it has its event like a real one. */
  const make = async (over: Record<string, unknown> = {}) =>
    (
      await t
        .as(w.staff)
        .post(base())
        .send({ ...validBody, ...over })
        .expect(201)
    ).body as { id: string; version: number; quantity: number };
  const edit = (id: string, body: Record<string, unknown>) =>
    t
      .as(w.staff)
      .patch(`${base()}/${id}`)
      .send(body);
  const transition = (id: string, kind: 'archive' | 'restore', v: number) =>
    t
      .as(w.staff)
      .post(`${base()}/${id}/${kind}`)
      .send({ expectedVersion: v });
  const delta = (
    productId: string,
    d: number,
    operationId = `op-${randomUUID()}`,
  ) =>
    stock.applyStockDelta([
      { operationId, productId, shopId: w.shop.id, delta: d, reason: 'test' },
    ]);
  const noImpossibleRows = async () =>
    expect(await impossibleProductRows(t.app)).toEqual(NOTHING_IMPOSSIBLE);

  beforeAll(async () => {
    t = await createCatalogApp({
      overrides: [
        {
          provide: EntitlementsService,
          useValue: {
            checkLimit: async () => ({
              allowed: limit === null,
              limit,
              remaining: null,
            }),
          },
        },
      ],
    });
    sequelize = t.app.get(Sequelize);
    stock = t.app.get(ProductStockService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    limit = null;
    await t.reset();
    w = await createShopWorld(t);
  });

  describe('create with one Idempotency-Key', () => {
    it('S05 AS-01: eight parallel submits with the same key and body leave one product and one created event', async () => {
      const key = `create-${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          t.as(w.staff).post(base()).set('Idempotency-Key', key).send(validBody),
        ),
      );

      // the first claim runs the create; a request that meets it still in flight is told to retry (409), the rest replay
      expect(count(results, 201)).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(
        true,
      );
      const ids = new Set(
        results.filter((r) => r.status === 201).map((r) => r.body.id),
      );
      expect(ids.size).toBe(1);
      expect(await productCount(t.app)).toBe(1);
      const [id] = [...ids];
      expect(await productEvents(t.app, id)).toHaveLength(1);

      // a later retry (the client lost every answer) replays the first product and creates nothing
      const again = await t
        .as(w.staff)
        .post(base())
        .set('Idempotency-Key', key)
        .send(validBody)
        .expect(201);
      expect(again.body.id).toBe(id);
      expect(await productCount(t.app)).toBe(1);
      await noImpossibleRows();
    });

    it('S05 AS-01: the same key with two different bodies at once creates one product, never two', async () => {
      const key = `create-${randomUUID()}`;
      const results = await Promise.all(
        ['Coat A', 'Coat B', 'Coat C', 'Coat D'].map((title) =>
          t
            .as(w.staff)
            .post(base())
            .set('Idempotency-Key', key)
            .send({ ...validBody, title }),
        ),
      );
      expect(count(results, 201)).toBe(1);
      // the others are refused: key reuse with another body (422) or still in flight (409), none of them creates
      expect(results.every((r) => [201, 409, 422].includes(r.status))).toBe(
        true,
      );
      expect(await productCount(t.app)).toBe(1);
      const [stored] = await rows<{ id: string; title: string }>(
        `SELECT "id", "title" FROM "Product"`,
      );
      expect(results.find((r) => r.status === 201)!.body.title).toBe(
        stored.title,
      );
      expect(await productEvents(t.app, stored.id)).toHaveLength(1);
      await noImpossibleRows();
    });

    it('S05 AS-01: the key is kept per shop: the same key in two shops makes one product in each', async () => {
      const other = await createShopWorld(t);
      const key = `create-${randomUUID()}`;
      const results = await Promise.all([
        t.as(w.staff).post(base()).set('Idempotency-Key', key).send(validBody),
        t
          .as(other.staff)
          .post(base(other.shop.id))
          .set('Idempotency-Key', key)
          .send(validBody),
      ]);
      expect(statuses(results)).toEqual([201, 201]);
      expect(results[0].body.id).not.toBe(results[1].body.id);
      expect(await productCount(t.app, `"shopId" = :s`, { s: w.shop.id })).toBe(
        1,
      );
      expect(
        await productCount(t.app, `"shopId" = :s`, { s: other.shop.id }),
      ).toBe(1);
      await noImpossibleRows();
    });

    it('S05 AS-01: without a key a double submit makes two products, each with its own id and its own event', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          t.as(w.staff).post(base()).send(validBody),
        ),
      );
      expect(statuses(results)).toEqual([201, 201, 201, 201, 201, 201]);
      const ids = results.map((r) => r.body.id);
      expect(new Set(ids).size).toBe(6);
      expect(await productCount(t.app)).toBe(6);
      for (const id of ids) expect(await productEvents(t.app, id)).toHaveLength(1);
      await noImpossibleRows();
    });

    it('S05 AS-02: the plan limit holds when many creates arrive together: a cap of 3 leaves exactly 3 products', async () => {
      limit = 3;
      const results = await Promise.all(
        Array.from({ length: 9 }, (_, i) =>
          t
            .as(w.staff)
            .post(base())
            .send({ ...validBody, title: `Limited ${i}` }),
        ),
      );
      expect(count(results, 201)).toBe(3);
      expect(results.filter((r) => r.status !== 201).map((r) => r.body.code)).toEqual(
        Array(6).fill('plan_limit_reached'),
      );
      expect(await productCount(t.app, `"shopId" = :s`, { s: w.shop.id })).toBe(
        3,
      );
      await noImpossibleRows();
    });
  });

  describe('edit with expectedVersion from several clients', () => {
    it('S05 AS-09: two clients edit version 1 at once: one wins with version 2, the other gets 409 with the current version', async () => {
      const product = await make();
      const results = await Promise.all([
        edit(product.id, { expectedVersion: 1, title: 'From client one' }),
        edit(product.id, { expectedVersion: 1, title: 'From client two' }),
      ]);
      expect(statuses(results)).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)!;
      const loser = results.find((r) => r.status === 409)!;
      expect(winner.body.version).toBe(2);
      expect(loser.body.code).toBe('version_conflict');
      expect(loser.body.currentVersion ?? loser.body.extensions?.currentVersion).toBe(
        2,
      );

      const stored = await productRow<{ title: string; version: number }>(
        t.app,
        product.id,
      );
      expect(stored).toMatchObject({ version: 2, title: winner.body.title });
      // one created event and one updated event: the loser wrote nothing
      const events = await productEvents(t.app, product.id);
      expect(events.map((e) => e.aggregateVersion)).toEqual([1, 2]);
      await noImpossibleRows();
    });

    it('S05 AS-09: ten clients edit version 1 at once, each a different field: exactly one write lands and the row shows only that one', async () => {
      const product = await make();
      const edits: Array<Record<string, unknown>> = [
        { title: 'T' },
        { description: 'D' },
        { brand: 'B' },
        { category: 'C' },
        { priceMinor: 1_111 },
        { quantity: 77 },
        { tags: ['x'] },
        { title: 'T2', priceMinor: 2_222 },
        { quantity: 88, brand: 'B2' },
        { description: 'D2', category: 'C2' },
      ];
      const results = await Promise.all(
        edits.map((e) => edit(product.id, { expectedVersion: 1, ...e })),
      );
      expect(count(results, 200)).toBe(1);
      expect(count(results, 409)).toBe(9);

      const stored = (await productRow<Record<string, unknown>>(
        t.app,
        product.id,
      ))!;
      expect(stored.version).toBe(2);
      // the stored row equals the winner's answer, so no field of a loser leaked in
      const winner = results.find((r) => r.status === 200)!.body;
      expect({
        title: stored.title,
        description: stored.description,
        brand: stored.brand,
        category: stored.category,
        priceMinor: Number(stored.priceMinor),
        quantity: stored.quantity,
      }).toEqual({
        title: winner.title,
        description: winner.description,
        brand: winner.brand,
        category: winner.category,
        priceMinor: winner.priceMinor,
        quantity: winner.quantity,
      });
      expect(await productEvents(t.app, product.id)).toHaveLength(2);
      await noImpossibleRows();
    });

    it('S05 AS-09: six clients each read, add one to the price and retry on 409: no update is lost', async () => {
      const product = await make({ priceMinor: 1_000 });
      const bump = async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const current = (
            await t.as(w.staff).get(`${base()}/${product.id}`).expect(200)
          ).body;
          const res = await edit(product.id, {
            expectedVersion: current.version,
            priceMinor: current.priceMinor + 1,
          });
          if (res.status === 200) return;
          expect(res.status).toBe(409);
        }
        throw new Error('a client never got through');
      };
      await Promise.all(Array.from({ length: 6 }, bump));

      const stored = (await productRow<{ priceMinor: string; version: number }>(
        t.app,
        product.id,
      ))!;
      expect(Number(stored.priceMinor)).toBe(1_006);
      expect(stored.version).toBe(7);
      const versions = (await productEvents(t.app, product.id)).map(
        (e) => e.aggregateVersion,
      );
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
      await noImpossibleRows();
    });

    it('S05 AS-09: the same edit sent twice at once (a double click) changes the row once', async () => {
      const product = await make();
      const results = await Promise.all([
        edit(product.id, { expectedVersion: 1, title: 'Once' }),
        edit(product.id, { expectedVersion: 1, title: 'Once' }),
      ]);
      expect(statuses(results)).toEqual([200, 409]);
      expect((await productRow<{ version: number }>(t.app, product.id))!.version).toBe(
        2,
      );
      expect(await productEvents(t.app, product.id)).toHaveLength(2);
      await noImpossibleRows();
    });
  });

  describe('stock changes', () => {
    it('S05 AS-10: twelve parallel one-unit sales of a product with 5 in stock: five apply, seven are refused, stock ends at 0', async () => {
      const product = await make({ quantity: 5 });
      const results = await Promise.all(
        Array.from({ length: 12 }, () => delta(product.id, -1)),
      );
      expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(5);
      const refused = results.filter((r) => r.outcome === 'rejected');
      expect(refused).toHaveLength(7);
      for (const r of refused)
        expect(r.outcome === 'rejected' && r.failures[0].code).toBe(
          'insufficient_stock',
        );

      const stored = (await productRow<{ quantity: number; version: number }>(
        t.app,
        product.id,
      ))!;
      expect(stored).toMatchObject({ quantity: 0, version: 6 });
      const operations = await rows<{ quantityAfter: number; productVersion: number }>(
        `SELECT "quantityAfter", "productVersion" FROM "ProductStockOperation" WHERE "productId" = :id ORDER BY "productVersion"`,
        { id: product.id },
      );
      expect(operations.map((o) => o.quantityAfter)).toEqual([4, 3, 2, 1, 0]);
      expect(operations.map((o) => o.productVersion)).toEqual([2, 3, 4, 5, 6]);
      expect(await productEvents(t.app, product.id)).toHaveLength(6);
      await noImpossibleRows();
    });

    it('S05 AS-10: one operation id sent six times at once changes stock once; the others are replays', async () => {
      const product = await make({ quantity: 10 });
      const operationId = `op-${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => delta(product.id, -3, operationId)),
      );
      expect(results.every((r) => r.outcome === 'applied')).toBe(true);
      const applied = results.flatMap((r) =>
        r.outcome === 'applied' ? r.results : [],
      );
      expect(applied.filter((a) => !a.replayed)).toHaveLength(1);
      expect(applied.every((a) => a.quantityAfter === 7)).toBe(true);

      expect((await productRow<{ quantity: number }>(t.app, product.id))!.quantity).toBe(
        7,
      );
      expect(
        await rows(`SELECT 1 FROM "ProductStockOperation" WHERE "operationId" = :operationId`, {
          operationId,
        }),
      ).toHaveLength(1);
      expect(await productEvents(t.app, product.id)).toHaveLength(2);
      await noImpossibleRows();
    });

    it('S05 AS-10: a seller sets the stock while sales arrive: every stored step follows from the one before and stock never goes below 0', async () => {
      const product = await make({ quantity: 20 });
      const [patched] = await Promise.all([
        edit(product.id, { expectedVersion: 1, quantity: 100 }),
        ...Array.from({ length: 10 }, () => delta(product.id, -1)),
      ]);
      expect([200, 409]).toContain(patched.status);

      const stored = (await productRow<{ quantity: number; version: number }>(
        t.app,
        product.id,
      ))!;
      const operations = await rows<{ quantityAfter: number; productVersion: number }>(
        `SELECT "quantityAfter", "productVersion" FROM "ProductStockOperation" WHERE "productId" = :id ORDER BY "productVersion"`,
        { id: product.id },
      );
      // one version step per change: sales that applied + the seller's edit if it won
      expect(stored.version).toBe(1 + operations.length + (patched.status === 200 ? 1 : 0));
      expect(stored.quantity).toBeGreaterThanOrEqual(0);
      // two sales that follow each other in version took exactly one unit each
      for (let i = 1; i < operations.length; i += 1)
        if (operations[i].productVersion === operations[i - 1].productVersion + 1)
          expect(operations[i].quantityAfter).toBe(operations[i - 1].quantityAfter - 1);
      // the stored quantity is what the last change left
      const last = operations[operations.length - 1];
      if (last && last.productVersion === stored.version)
        expect(stored.quantity).toBe(last.quantityAfter);
      if (patched.status === 200 && !last) expect(stored.quantity).toBe(100);
      await noImpossibleRows();
    });
  });

  describe('archive and restore', () => {
    it('S05 AS-11: two archive clicks at once: one moves the product, the other gets 409; one history row, one event', async () => {
      const product = await make();
      const results = await Promise.all([
        transition(product.id, 'archive', 1),
        transition(product.id, 'archive', 1),
      ]);
      expect(statuses(results)).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe(
        'version_conflict',
      );
      expect(await productRow(t.app, product.id)).toMatchObject({
        status: 'ARCHIVED',
        version: 2,
      });
      expect(
        await rows(`SELECT 1 FROM "ProductStatusHistory" WHERE "productId" = :id`, {
          id: product.id,
        }),
      ).toHaveLength(1);
      expect(
        (await productEvents(t.app, product.id)).map((e) => e.type),
      ).toEqual(['catalog.product_created', 'catalog.product_archived']);
      await noImpossibleRows();
    });

    it('S05 AS-11: archive and edit of version 1 at once: exactly one wins, and an archived product keeps no edit made after it', async () => {
      const product = await make();
      const [archived, edited] = await Promise.all([
        transition(product.id, 'archive', 1),
        edit(product.id, { expectedVersion: 1, title: 'Edited' }),
      ]);
      expect([archived.status, edited.status].sort()).toEqual([200, 409]);
      const stored = (await productRow<{
        status: string;
        title: string;
        version: number;
      }>(t.app, product.id))!;
      expect(stored.version).toBe(2);
      if (archived.status === 200) {
        expect(stored).toMatchObject({ status: 'ARCHIVED', title: validBody.title });
        expect(edited.body.code).toBe('version_conflict');
      } else {
        expect(stored).toMatchObject({ status: 'ACTIVE', title: 'Edited' });
        expect(
          await rows(`SELECT 1 FROM "ProductStatusHistory" WHERE "productId" = :id`, {
            id: product.id,
          }),
        ).toHaveLength(0);
      }
      await noImpossibleRows();
    });

    it('S05 AS-11: three restore clicks on an archived product at once: one wins, history shows archive then restore', async () => {
      const product = await make();
      await transition(product.id, 'archive', 1).expect(200);
      const results = await Promise.all(
        Array.from({ length: 3 }, () => transition(product.id, 'restore', 2)),
      );
      expect(statuses(results)).toEqual([200, 409, 409]);
      expect(await productRow(t.app, product.id)).toMatchObject({
        status: 'ACTIVE',
        version: 3,
      });
      expect(
        (
          await rows<{ toStatus: string }>(
            `SELECT "toStatus" FROM "ProductStatusHistory" WHERE "productId" = :id ORDER BY "productVersion"`,
            { id: product.id },
          )
        ).map((h) => h.toStatus),
      ).toEqual(['ARCHIVED', 'ACTIVE']);
      await noImpossibleRows();
    });

    it('S05 AS-11: archive and restore sent together for the same version: only the one that fits the state succeeds', async () => {
      const product = await make();
      const results = await Promise.all([
        transition(product.id, 'archive', 1),
        transition(product.id, 'restore', 1),
      ]);
      // restoring an ACTIVE product is refused whatever the order; archive is the only possible winner
      expect(results[0].status).toBe(200);
      expect([404, 409]).toContain(results[1].status);
      expect(await productRow(t.app, product.id)).toMatchObject({
        status: 'ARCHIVED',
        version: 2,
      });
      await noImpossibleRows();
    });

    it('S05 AS-11: sales racing an archive: no sale is applied after the archive version, and stock matches the applied sales', async () => {
      const product = await make({ quantity: 50 });
      const [archived, sales] = await Promise.all([
        transition(product.id, 'archive', 1),
        Promise.all(Array.from({ length: 8 }, () => delta(product.id, -1))),
      ]);
      // the archive may lose to a sale that bumped the version first; retry once with the version it reports
      let archiveVersion: number;
      if (archived.status === 200) archiveVersion = archived.body.version;
      else {
        const current = (await productRow<{ version: number }>(t.app, product.id))!;
        const retry = await transition(product.id, 'archive', current.version).expect(200);
        archiveVersion = retry.body.version;
      }
      const applied = await rows<{ productVersion: number }>(
        `SELECT "productVersion" FROM "ProductStockOperation" WHERE "productId" = :id`,
        { id: product.id },
      );
      expect(applied.every((o) => o.productVersion < archiveVersion)).toBe(true);
      expect(sales.filter((s) => s.outcome === 'applied')).toHaveLength(applied.length);
      for (const s of sales.filter((x) => x.outcome === 'rejected'))
        expect(s.outcome === 'rejected' && s.failures[0].code).toBe('unavailable');
      expect((await productRow<{ quantity: number }>(t.app, product.id))!.quantity).toBe(
        50 - applied.length,
      );
      await noImpossibleRows();
    });
  });

  describe('reads while products change', () => {
    it('S05 AS-14: paging through 12 products while new ones are created and others archived shows no product twice and none from another shop', async () => {
      const mine: string[] = [];
      for (let i = 0; i < 12; i += 1) mine.push((await make({ title: `Mine ${i}` })).id);
      const other = await createShopWorld(t);
      await t
        .as(other.staff)
        .post(base(other.shop.id))
        .send({ ...validBody, title: 'Not mine' })
        .expect(201);

      const seen: string[] = [];
      let cursor: string | null = null;
      let round = 0;
      do {
        const query: string = `?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
        const [page] = await Promise.all([
          t.as(w.viewer).get(`${base()}${query}`).expect(200),
          // a new product and an archive land between every two pages
          make({ title: `Late ${round}` }),
          transition(mine[round], 'archive', 1),
        ]);
        seen.push(...page.body.items.map((p: { id: string }) => p.id));
        for (const item of page.body.items) expect(item.shopId).toBe(w.shop.id);
        cursor = page.body.nextCursor;
        round += 1;
      } while (cursor && round < 20);

      expect(new Set(seen).size).toBe(seen.length);
      // every product that stayed untouched during the walk was shown
      const untouched = mine.slice(round);
      for (const id of untouched) expect(seen).toContain(id);
      await noImpossibleRows();
    });

    it('S05 AS-14: forty parallel reads of list, product and archived list during writes all answer 200 and show only this shop', async () => {
      const product = await make();
      const other = await createShopWorld(t);
      await t.as(other.staff).post(base(other.shop.id)).send(validBody).expect(201);
      const urls = [base(), `${base()}/${product.id}`, `${base()}?status=ARCHIVED`];
      const [reads] = await Promise.all([
        Promise.all(
          Array.from({ length: 40 }, (_, i) =>
            t.as(w.viewer).get(urls[i % 3]),
          ),
        ),
        edit(product.id, { expectedVersion: 1, title: 'During reads' }),
        make({ title: 'During reads 2' }),
      ]);
      for (const r of reads) {
        expect(r.status).toBe(200);
        expect(JSON.stringify(r.body)).not.toContain(other.shop.id);
      }
      await noImpossibleRows();
    });
  });
});

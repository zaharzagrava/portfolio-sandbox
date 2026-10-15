import { v7 as uuidv7 } from 'uuid';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import {
  syncPushResponseSchema,
  type SyncOpResult,
} from '@marketplace-sandbox/contracts';
import {
  ProductCommandService,
  ProductQueryService,
} from '@app/domains/catalog';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import { productEvents } from '@app/test/utils/catalog-fixtures';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';
import {
  OfflineSyncModule,
  OfflineSyncProjectorModule,
  OfflineSyncWorkerModule,
} from './sync.module';
import { compareHlc, decodeHlc, encodeHlc, receive } from './domain/hlc';

const SECOND = 1_000;
const DAY = 86_400_000;

describe('Offline sync: per-field last-writer-wins', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let commands: ProductCommandService;
  let query: ProductQueryService;
  let logical = 0;

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [
        OfflineSyncModule,
        OfflineSyncWorkerModule,
        OfflineSyncProjectorModule,
      ],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    commands = ctx.app.get(ProductCommandService);
    query = ctx.app.get(ProductQueryService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  async function world() {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    return { owner, shopId: shop.id };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function product(w: World, quantity = 10) {
    const created = await commands.create(w.shopId, w.owner.id, {
      title: 'Hoodie',
      description: 'Warm',
      brand: 'Acme',
      category: 'clothes',
      priceMinor: 3_000,
      quantity,
    });
    return created.id;
  }

  const at = (node: string, offsetMs: number, counter = ++logical) =>
    encodeHlc({
      physical: ctx.clock.now().getTime() + offsetMs,
      logical: counter,
      node,
    });

  const edit = (
    productId: string,
    fields: Record<string, unknown>,
    hlc: string,
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'product.update',
    opId: uuidv7(),
    hlc,
    productId,
    fields,
    ...extra,
  });

  const stockOp = (productId: string, delta: number, hlc: string) => ({
    type: 'stock.adjust',
    opId: uuidv7(),
    hlc,
    productId,
    delta,
    reason: 'received',
  });

  const push = (w: World, device: string, ops: unknown[]) =>
    ctx
      .as(w.owner)
      .post(`/api/shops/${w.shopId}/sync/push`)
      .set('X-Device-Id', device)
      .send({ ops });

  async function pushOk(w: World, device: string, ops: unknown[]) {
    const res = await push(w, device, ops);
    expect(res.status).toBe(200);
    return syncPushResponseSchema.parse(res.body);
  }

  const current = async (w: World, productId: string) =>
    (await query.getProductsByIds([productId], { shopId: w.shopId })).get(
      productId,
    )!;

  const clockRows = (shopId: string, productId: string) =>
    db.query<{ field: string; hlc: string }>(
      `SELECT "field", "hlc" FROM "ProductFieldClock" WHERE "shopId" = :shopId AND "productId" = :productId ORDER BY "field"`,
      { type: QueryTypes.SELECT, replacements: { shopId, productId } },
    );

  const updateEvents = async (productId: string) =>
    (await productEvents(ctx.app, productId)).filter(
      (e) => e.type === 'catalog.product_updated',
    );

  const operationRows = (shopId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "SyncOperation" WHERE "shopId" = :shopId ORDER BY "createdAt", "opId"`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );

  // ---- US2 ----------------------------------------------------------------------------------------------------

  describe.each([
    ['title first', ['title', 'price']],
    ['price first', ['price', 'title']],
  ])('S09 AS-15: both edits survive (%s)', (_name, order) => {
    it('S09 AS-15: each device wins its own field, in either arrival order, and each field keeps its clock', async () => {
      const w = await world();
      const productId = await product(w);
      const titleOp = edit(
        productId,
        { title: 'Hoodie (black)' },
        at('dev-a', -10 * SECOND),
      );
      const priceOp = edit(
        productId,
        { priceMinor: 4_500 },
        at('dev-b', -5 * SECOND),
      );
      const ops = {
        title: ['dev-a', titleOp],
        price: ['dev-b', priceOp],
      } as const;

      const results: Record<string, SyncOpResult> = {};
      for (const key of order as Array<'title' | 'price'>) {
        const [device, op] = ops[key];
        results[key] = (await pushOk(w, device, [op])).results[0];
      }

      expect(results.title).toMatchObject({
        status: 'applied',
        applied: ['title'],
        superseded: [],
      });
      expect(results.price).toMatchObject({
        status: 'applied',
        applied: ['priceMinor'],
        superseded: [],
      });
      const stored = await current(w, productId);
      expect(stored.title).toBe('Hoodie (black)');
      expect(stored.priceMinor).toBe(4_500);
      expect(await clockRows(w.shopId, productId)).toEqual([
        { field: 'priceMinor', hlc: priceOp.hlc },
        { field: 'title', hlc: titleOp.hlc },
      ]);
    });
  });

  it('S09 AS-16: a stale edit loses its field only, changes nothing and emits no event', async () => {
    const w = await world();
    const productId = await product(w);
    await pushOk(w, 'dev-a', [
      edit(productId, { title: 'Hoodie (black)' }, at('dev-a', -10 * SECOND)),
    ]);
    await pushOk(w, 'dev-b', [
      edit(productId, { priceMinor: 4_500 }, at('dev-b', -5 * SECOND)),
    ]);
    const before = await current(w, productId);
    const events = (await updateEvents(productId)).length;
    const clocksBefore = await clockRows(w.shopId, productId);

    const stale = edit(
      productId,
      { title: 'Old title' },
      at('dev-c', -20 * SECOND),
    );
    const result = (await pushOk(w, 'dev-c', [stale])).results[0];

    expect(result).toMatchObject({
      status: 'merged',
      applied: [],
      superseded: ['title'],
    });
    const after = await current(w, productId);
    expect(after.title).toBe('Hoodie (black)');
    expect(after.version).toBe(before.version);
    expect((await updateEvents(productId)).length).toBe(events);
    expect(await clockRows(w.shopId, productId)).toEqual(clocksBefore);
    const recorded = (await operationRows(w.shopId)).find(
      (r) => r.opId === stale.opId,
    );
    expect(recorded).toMatchObject({ status: 'merged', productId });

    // A mixed edit applies only the field that is newer.
    const mixed = edit(
      productId,
      { title: 'Older still', description: 'Now with a hood' },
      at('dev-c', -15 * SECOND),
    );
    const mixedResult = (await pushOk(w, 'dev-c', [mixed])).results[0];
    expect(mixedResult).toMatchObject({
      status: 'merged',
      applied: ['description'],
      superseded: ['title'],
    });
    const final = await current(w, productId);
    expect(final.title).toBe('Hoodie (black)');
    expect(final.description).toBe('Now with a hood');
    expect((await updateEvents(productId)).length).toBe(events + 1);
  });

  it('S09 AS-18: concurrent edits of one field leave the greater clock, 20 times with random arrival order', async () => {
    const w = await world();
    for (let round = 0; round < 20; round++) {
      const productId = await product(w);
      const greaterFirst = Math.random() < 0.5;
      const lesser = edit(
        productId,
        { title: `lesser ${round}` },
        at('dev-a', -20 * SECOND),
      );
      const greater = edit(
        productId,
        { title: `greater ${round}` },
        at('dev-b', -10 * SECOND),
      );
      const send = (device: string, op: unknown, delayMs: number) =>
        new Promise<SyncOpResult>((resolve, reject) =>
          setTimeout(
            () =>
              pushOk(w, device, [op]).then(
                (b) => resolve(b.results[0]),
                reject,
              ),
            delayMs,
          ),
        );
      const [lesserResult, greaterResult] = await Promise.all([
        send('dev-a', lesser, greaterFirst ? 5 : 0),
        send('dev-b', greater, greaterFirst ? 0 : 5),
      ]);

      expect((await current(w, productId)).title).toBe(`greater ${round}`);
      expect(greaterResult).toMatchObject({
        status: 'applied',
        applied: ['title'],
      });
      // Either the lesser edit arrived first and was overwritten (two catalog writes) or it lost its field (one).
      const writes = (await updateEvents(productId)).length;
      if (lesserResult.status === 'merged') {
        expect(lesserResult).toMatchObject({
          applied: [],
          superseded: ['title'],
        });
        expect(writes).toBe(1);
      } else {
        expect(lesserResult).toMatchObject({
          status: 'applied',
          applied: ['title'],
        });
        expect(writes).toBe(2);
      }
      const rows = await clockRows(w.shopId, productId);
      expect(rows).toEqual([{ field: 'title', hlc: greater.hlc }]);
    }
  }, 120_000);

  it('S09 AS-19: a field edit with a clock more than 60 s ahead is refused, a stock operation with the same skew applies', async () => {
    const w = await world();
    const productId = await product(w);
    const now = ctx.clock.now().getTime();
    const skewed = (offsetMs: number) => at('dev-a', offsetMs);

    const refused = await pushOk(w, 'dev-a', [
      edit(productId, { title: 'Too far ahead' }, skewed(61 * SECOND)),
      stockOp(productId, 5, skewed(61 * SECOND)),
    ]);

    expect(refused.results[0]).toMatchObject({
      status: 'rejected',
      code: 'clock_implausible',
    });
    expect(refused.results[1]).toMatchObject({
      status: 'applied',
      quantityAfter: 15,
    });
    const stored = await current(w, productId);
    expect(stored.title).toBe('Hoodie');
    expect(await clockRows(w.shopId, productId)).toEqual([]);
    // Neither the refused edit nor the skewed stock operation moved the server clock.
    expect(decodeHlc(refused.serverHlc)!.physical).toBeLessThanOrEqual(now);

    const edge = await pushOk(w, 'dev-a', [
      edit(productId, { title: 'Just inside' }, skewed(60 * SECOND)),
    ]);
    expect(edge.results[0]).toMatchObject({
      status: 'applied',
      applied: ['title'],
    });
  });

  it('S09 AS-20: a clock that is malformed, or whose node is not the device, is refused and nothing is applied', async () => {
    const w = await world();
    const productId = await product(w);

    const body = await pushOk(w, 'dev-a', [
      edit(productId, { title: 'x' }, 'not-a-clock'),
      stockOp(productId, 3, '000000000001000-0001-dev-a'),
      edit(productId, { title: 'y' }, at('dev-other', 0)),
      stockOp(productId, 3, at('dev-other', 0)),
    ]);

    expect(body.results.map((r) => [r.status, r.code])).toEqual([
      ['rejected', 'invalid_hlc'],
      ['rejected', 'invalid_hlc'],
      ['rejected', 'hlc_node_mismatch'],
      ['rejected', 'hlc_node_mismatch'],
    ]);
    const stored = await current(w, productId);
    expect(stored.title).toBe('Hoodie');
    expect(stored.quantity).toBe(10);
    expect(await clockRows(w.shopId, productId)).toEqual([]);
  });

  it('S09 AS-21: an operation whose clock is more than 30 days old is refused', async () => {
    const w = await world();
    const productId = await product(w);

    const body = await pushOk(w, 'dev-a', [
      edit(productId, { title: 'Ancient' }, at('dev-a', -(30 * DAY + SECOND))),
      stockOp(productId, 4, at('dev-a', -(30 * DAY + SECOND))),
      stockOp(productId, 2, at('dev-a', -(30 * DAY - SECOND))),
    ]);

    expect(body.results.map((r) => [r.status, r.code])).toEqual([
      ['rejected', 'op_expired'],
      ['rejected', 'op_expired'],
      ['applied', undefined],
    ]);
    expect((await current(w, productId)).quantity).toBe(12);
  });

  it('S09 AS-22: values the schema or the catalog refuse are rejected alone, no clock advances, the valid operations apply', async () => {
    const w = await world();
    const productId = await product(w);
    const hlc = () => at('dev-a', -SECOND);

    const body = await pushOk(w, 'dev-a', [
      edit(productId, { title: '' }, hlc()),
      edit(productId, { title: 'x'.repeat(201) }, hlc()),
      edit(productId, { priceMinor: -1 }, hlc()),
      edit(productId, { priceMinor: 4.5 }, hlc()),
      edit(productId, { brand: 'Other' }, hlc()),
      edit(productId, { price: 450 }, hlc()),
      edit(productId, { title: '   ' }, hlc()),
      edit(productId, { title: 'Fine', priceMinor: 0 }, hlc()),
      edit(productId, { description: 'd'.repeat(4_001) }, hlc()),
      edit(productId, { title: 'Valid' }, hlc()),
    ]);

    const schemaFailures = body.results.slice(0, 6);
    expect(
      schemaFailures.every(
        (r) => r.status === 'rejected' && r.code === 'invalid_op',
      ),
    ).toBe(true);
    expect(JSON.stringify(schemaFailures[0].detail)).toContain('fields.title');
    expect(JSON.stringify(schemaFailures[2].detail)).toContain(
      'fields.priceMinor',
    );
    expect(JSON.stringify(schemaFailures[4].detail)).toContain('brand');
    expect(body.results[6]).toMatchObject({
      status: 'rejected',
      code: 'invalid_field',
    });
    expect(body.results[6].detail).toEqual({ fields: ['title'] });
    expect(body.results[7]).toMatchObject({
      status: 'rejected',
      code: 'invalid_field',
    });
    expect(body.results[7].detail).toEqual({ fields: ['priceMinor'] });
    expect(body.results[8]).toMatchObject({
      status: 'rejected',
      code: 'invalid_field',
    });
    expect(body.results[9]).toMatchObject({
      status: 'applied',
      applied: ['title'],
    });

    const stored = await current(w, productId);
    expect(stored.title).toBe('Valid');
    expect(stored.priceMinor).toBe(3_000);
    expect(stored.description).toBe('Warm');
    expect(await clockRows(w.shopId, productId)).toEqual([
      { field: 'title', hlc: expect.any(String) },
    ]);
  });

  it('S09 AS-23: serverHlc is after every accepted clock, never behind server time, and never decreases', async () => {
    const w = await world();
    const productId = await product(w);
    const ahead = at('dev-a', 30 * SECOND);

    const first = await pushOk(w, 'dev-a', [
      edit(productId, { title: 'A' }, at('dev-a', -SECOND)),
      edit(productId, { description: 'B' }, ahead),
    ]);

    const server = decodeHlc(first.serverHlc)!;
    expect(server.node).toMatch(/^server-/);
    expect(compareHlc(server, decodeHlc(ahead)!)).toBeGreaterThan(0);
    expect(server.physical).toBeGreaterThanOrEqual(ctx.clock.now().getTime());

    const second = await pushOk(w, 'dev-a', [
      stockOp(productId, 1, at('dev-a', 0)),
    ]);
    expect(compareHlc(decodeHlc(second.serverHlc)!, server)).toBeGreaterThan(0);
    const third = await pushOk(w, 'dev-a', [
      stockOp(productId, 1, at('dev-a', 0)),
    ]);
    expect(
      compareHlc(decodeHlc(third.serverHlc)!, decodeHlc(second.serverHlc)!),
    ).toBeGreaterThan(0);

    // A device that merges the server clock with the receive rule stamps after both its own clock and the server's.
    const device = {
      physical: ctx.clock.now().getTime(),
      logical: 3,
      node: 'dev-a',
    };
    const merged = receive(device, server, ctx.clock.now().getTime());
    expect(compareHlc(merged, device)).toBeGreaterThan(0);
    expect(compareHlc(merged, server)).toBeGreaterThan(0);
    expect(encodeHlc(merged) > first.serverHlc).toBe(true);
  });
});

import { randomUUID } from 'node:crypto';
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
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { productEvents } from '@app/test/utils/catalog-fixtures';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';
import {
  OfflineSyncModule,
  OfflineSyncProjectorModule,
  OfflineSyncWorkerModule,
} from './sync.module';
import { SyncLifecycleService } from './application/sync-lifecycle.service';
import { encodeHlc } from './domain/hlc';
import { SYNC_DEFAULTS } from './domain/sync-config';
import { fingerprint, parseOp } from './domain/sync-ops';
import {
  SYNC_CONFIG,
  SYNC_OPERATION_REPOSITORY,
  type SyncConfig,
  type SyncOperationRepository,
} from './domain/ports';

const SECOND = 1_000;
const testConfig: SyncConfig = { ...SYNC_DEFAULTS };

describe('Offline sync: push, operation idempotency and stock deltas', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let commands: ProductCommandService;
  let query: ProductQueryService;
  let operations: SyncOperationRepository;
  let lifecycle: SyncLifecycleService;
  let logical = 0;

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [
        OfflineSyncModule,
        OfflineSyncWorkerModule,
        OfflineSyncProjectorModule,
      ],
      overrides: [{ provide: SYNC_CONFIG, useValue: testConfig }],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    commands = ctx.app.get(ProductCommandService);
    query = ctx.app.get(ProductQueryService);
    operations = ctx.app.get(SYNC_OPERATION_REPOSITORY, { strict: false });
    lifecycle = ctx.app.get(SyncLifecycleService, { strict: false });
  });

  afterAll(async () => {
    await ctx.close();
  });

  afterEach(async () => {
    Object.assign(testConfig, SYNC_DEFAULTS);
    await dropFaults();
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  /** A shop with its owner, who pushes (the session is real; the shop and membership are fixtures). */
  async function world() {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    return { owner, shopId: shop.id };
  }

  async function product(
    w: { owner: TestUser; shopId: string },
    quantity: number,
  ) {
    const created = await commands.create(w.shopId, w.owner.id, {
      title: 'Mug',
      description: 'A mug',
      brand: 'Acme',
      category: 'home',
      priceMinor: 1_000,
      quantity,
    });
    return created.id;
  }

  const stamp = (node: string, offsetMs = 0) =>
    encodeHlc({
      physical: ctx.clock.now().getTime() + offsetMs,
      logical: ++logical,
      node,
    });

  const adjust = (
    productId: string,
    delta: number,
    device: string,
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'stock.adjust',
    opId: uuidv7(),
    hlc: stamp(device),
    productId,
    delta,
    reason: delta > 0 ? 'received' : 'sold',
    ...extra,
  });

  const count = (
    productId: string,
    counted: number,
    base: number,
    device: string,
  ) => ({
    type: 'stock.count',
    opId: uuidv7(),
    hlc: stamp(device),
    productId,
    counted,
    base,
  });

  function push(
    w: { owner: TestUser; shopId: string },
    device: string,
    ops: unknown[],
  ) {
    return ctx
      .as(w.owner)
      .post(`/api/shops/${w.shopId}/sync/push`)
      .set('X-Device-Id', device)
      .send({ ops });
  }

  async function pushOk(
    w: { owner: TestUser; shopId: string },
    device: string,
    ops: unknown[],
  ) {
    const res = await push(w, device, ops);
    expect(res.status).toBe(200);
    return syncPushResponseSchema.parse(res.body);
  }

  const quantityOf = async (w: { shopId: string }, productId: string) =>
    (await query.getProductsByIds([productId], { shopId: w.shopId })).get(
      productId,
    )!.quantity;

  const operationRows = (shopId: string, productId?: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "SyncOperation" WHERE "shopId" = :shopId ${productId ? 'AND "productId" = :productId' : ''} ORDER BY "createdAt", "opId"`,
      { type: QueryTypes.SELECT, replacements: { shopId, productId } },
    );

  const conflictRows = (shopId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "SyncConflict" WHERE "shopId" = :shopId ORDER BY "createdAt"`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );

  /** `catalog.product_updated` events with a stock change, as the catalog wrote them. */
  const quantityEvents = async (productId: string) =>
    (await productEvents(ctx.app, productId)).filter(
      (e) =>
        e.type === 'catalog.product_updated' &&
        (e.payload.changedFields as string[]).includes('quantity'),
    );

  /** A store rule (a real trigger) that makes one write fail. `once` consumes a sequence so a rollback cannot re-arm it. */
  async function injectFault(options: {
    on: 'INSERT' | 'UPDATE';
    opId?: string;
    shopId?: string;
    when: string;
    action: string;
  }) {
    await dropFaults();
    await db.query(`CREATE SEQUENCE s09_push_fault_seq`);
    await db.query(
      `CREATE FUNCTION s09_push_fault_fn() RETURNS trigger AS $$
       BEGIN ${options.action} RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await db.query(
      `CREATE TRIGGER s09_push_fault_trg BEFORE ${options.on} ON "SyncOperation" FOR EACH ROW
       WHEN (${options.when}) EXECUTE FUNCTION s09_push_fault_fn()`,
    );
  }
  async function dropFaults() {
    await db.query(
      `DROP TRIGGER IF EXISTS s09_push_fault_trg ON "SyncOperation"`,
    );
    await db.query(`DROP FUNCTION IF EXISTS s09_push_fault_fn()`);
    await db.query(`DROP SEQUENCE IF EXISTS s09_push_fault_seq`);
  }

  const omitIdentity = (r: SyncOpResult) => {
    const { index, opId, ...rest } = r;
    void index;
    void opId;
    return rest;
  };

  // ---- US1 ----------------------------------------------------------------------------------------------------

  describe.each([
    ['dev-b first', ['dev-b', 'dev-a'], [9, 12]],
    ['dev-a first', ['dev-a', 'dev-b'], [13, 12]],
  ])('S09 AS-01: two devices converge (%s)', (_name, order, expected) => {
    it('S09 AS-01: deltas commute: the stock is the start plus two, each operation is recorded once, the catalog writes one event each', async () => {
      const w = await world();
      const productId = await product(w, 10);
      const ops: Record<string, any> = {
        'dev-a': adjust(productId, 3, 'dev-a'),
        'dev-b': adjust(productId, -1, 'dev-b'),
      };
      const before = (await quantityEvents(productId)).length;

      const results: SyncOpResult[] = [];
      for (const device of order) {
        const body = await pushOk(w, device, [ops[device]]);
        results.push(...body.results);
      }

      expect(results.map((r) => r.status)).toEqual(['applied', 'applied']);
      expect(results.map((r) => r.replayed)).toEqual([false, false]);
      expect(results.map((r) => r.quantityAfter)).toEqual(expected);
      expect(results.every((r) => typeof r.productVersion === 'number')).toBe(
        true,
      );
      expect(await quantityOf(w, productId)).toBe(12);
      expect(await operationRows(w.shopId, productId)).toHaveLength(2);
      const events = await quantityEvents(productId);
      expect(events.length - before).toBe(2);
      const all = await productEvents(ctx.app, productId);
      expect(all.every((e) => e.type.startsWith('catalog.product_'))).toBe(
        true,
      );
      expect(all.map((e) => e.type)).not.toContain('catalog.product_changed');
    });
  });

  it('S09 AS-02: a replay returns the original outcome, ten times, and adds no record and no event', async () => {
    const w = await world();
    const productId = await product(w, 10);
    const op = adjust(productId, 3, 'dev-a');
    const first = (await pushOk(w, 'dev-a', [op])).results[0];
    const events = (await quantityEvents(productId)).length;

    for (let i = 0; i < 10; i++) {
      const again = (await pushOk(w, 'dev-a', [op])).results[0];
      expect(again).toMatchObject({
        status: 'applied',
        replayed: true,
        quantityAfter: first.quantityAfter,
        productVersion: first.productVersion,
      });
    }
    expect(first.replayed).toBe(false);
    expect(await quantityOf(w, productId)).toBe(13);
    expect(await operationRows(w.shopId, productId)).toHaveLength(1);
    expect((await quantityEvents(productId)).length).toBe(events);
  });

  it('S09 AS-03: the same batch pushed twice at once changes the stock once and one response says replayed false', async () => {
    const w = await world();
    const productId = await product(w, 10);
    const op = adjust(productId, 5, 'dev-a');

    const [a, b] = await Promise.all([
      pushOk(w, 'dev-a', [op]),
      pushOk(w, 'dev-a', [op]),
    ]);

    expect([a.results[0].status, b.results[0].status]).toEqual([
      'applied',
      'applied',
    ]);
    expect([a.results[0].replayed, b.results[0].replayed].sort()).toEqual([
      false,
      true,
    ]);
    expect(a.results[0].quantityAfter).toBe(15);
    expect(b.results[0].quantityAfter).toBe(15);
    expect(await quantityOf(w, productId)).toBe(15);
    expect(await operationRows(w.shopId, productId)).toHaveLength(1);
    expect((await quantityEvents(productId)).length).toBe(1);
  });

  it('S09 AS-04: the same id with other content is op_id_reused and changes nothing', async () => {
    const w = await world();
    const productId = await product(w, 10);
    const op = adjust(productId, 3, 'dev-a');
    await pushOk(w, 'dev-a', [op]);
    const events = (await quantityEvents(productId)).length;
    const before = await operationRows(w.shopId, productId);

    const reused = (await pushOk(w, 'dev-a', [{ ...op, delta: 30 }]))
      .results[0];

    expect(reused).toMatchObject({ status: 'rejected', code: 'op_id_reused' });
    expect(await quantityOf(w, productId)).toBe(13);
    expect(await operationRows(w.shopId, productId)).toEqual(before);
    expect((await quantityEvents(productId)).length).toBe(events);
  });

  it('S09 AS-05: operation ids are scoped to the shop, and a shop never learns another one used it', async () => {
    const a = await world();
    const b = await world();
    const productA = await product(a, 10);
    const productB = await product(b, 10);
    const opA = adjust(productA, 3, 'dev-a');
    await pushOk(a, 'dev-a', [opA]);
    const recordA = await operationRows(a.shopId);

    const resultB = (
      await pushOk(b, 'dev-a', [
        { ...adjust(productB, 4, 'dev-a'), opId: opA.opId },
      ])
    ).results[0];

    expect(resultB).toMatchObject({
      status: 'applied',
      replayed: false,
      quantityAfter: 14,
    });
    expect(await operationRows(a.shopId)).toEqual(recordA);
    expect(await quantityOf(a, productA)).toBe(13);
    expect(await operationRows(b.shopId)).toHaveLength(1);
  });

  it('S09 AS-06: a count becomes a delta of what the device saw change', async () => {
    const w = await world();
    const productId = await product(w, 10);
    await pushOk(w, 'dev-b', [adjust(productId, -1, 'dev-b')]); // quantity 9

    const result = (
      await pushOk(w, 'dev-a', [count(productId, 8, 10, 'dev-a')])
    ).results[0];

    expect(result).toMatchObject({ status: 'applied', quantityAfter: 7 });
    expect(result.detail).toMatchObject({ delta: -2 });
    expect(await quantityOf(w, productId)).toBe(7);
  });

  it('S09 AS-07: a count that confirms calls the catalog never, emits no event and is still recorded', async () => {
    const w = await world();
    const productId = await product(w, 10);
    const events = (await quantityEvents(productId)).length;
    const op = count(productId, 10, 10, 'dev-a');

    const result = (await pushOk(w, 'dev-a', [op])).results[0];
    const replay = (await pushOk(w, 'dev-a', [op])).results[0];

    expect(result).toMatchObject({
      status: 'applied',
      quantityAfter: 10,
      replayed: false,
    });
    expect(replay).toMatchObject({
      status: 'applied',
      quantityAfter: 10,
      replayed: true,
    });
    expect((await quantityEvents(productId)).length).toBe(events);
    expect(await operationRows(w.shopId, productId)).toHaveLength(1);
    expect(await quantityOf(w, productId)).toBe(10);
  });

  it('S09 AS-08: two devices selling the last unit at once: one applies, one is an oversold conflict, stock stays at zero', async () => {
    const w = await world();
    const productId = await product(w, 1);
    const sellA = adjust(productId, -1, 'dev-a');
    const sellB = adjust(productId, -1, 'dev-b');

    const [a, b] = await Promise.all([
      pushOk(w, 'dev-a', [sellA]),
      pushOk(w, 'dev-b', [sellB]),
    ]);

    const all = [a.results[0], b.results[0]];
    const applied = all.filter((r) => r.status === 'applied');
    const conflicts = all.filter((r) => r.status === 'conflict');
    expect(applied).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflict).toEqual({
      kind: 'oversold',
      requested: -1,
      applied: 0,
      shortfall: 1,
    });
    expect(await quantityOf(w, productId)).toBe(0);
    const stored = await conflictRows(w.shopId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      status: 'open',
      kind: 'oversold',
      shortfall: 1,
    });
    const events = await outboxRowsFor(ctx.app, stored[0].opId);
    expect(
      events.filter((e) => e.type === 'catalogsync.offline_conflict_opened'),
    ).toHaveLength(1);
  });

  it('S09 AS-09: a sale larger than the stock applies the part that fits and records the shortfall', async () => {
    const w = await world();
    const productId = await product(w, 2);
    await pushOk(w, 'dev-a', [adjust(productId, -1, 'dev-a')]); // 1 left

    const sell = adjust(productId, -3, 'dev-b');
    const result = (await pushOk(w, 'dev-b', [sell])).results[0];

    expect(result).toMatchObject({
      status: 'conflict',
      quantityAfter: 0,
      conflict: { kind: 'oversold', requested: -3, applied: -1, shortfall: 2 },
    });
    expect(await quantityOf(w, productId)).toBe(0);
    const stored = await conflictRows(w.shopId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      requested: -3,
      applied: -1,
      shortfall: 2,
      quantityAfter: 0,
    });
    // The clamp is replay safe: resending the same operation returns the same conflict and changes nothing more.
    const again = (await pushOk(w, 'dev-b', [sell])).results[0];
    expect(again).toMatchObject({
      status: 'conflict',
      replayed: true,
      quantityAfter: 0,
      conflict: { kind: 'oversold', requested: -3, applied: -1, shortfall: 2 },
    });
    expect(await quantityOf(w, productId)).toBe(0);
    expect(await conflictRows(w.shopId)).toHaveLength(1);
    const events = await outboxRowsFor(ctx.app, stored[0].opId);
    expect(
      events.filter((e) => e.type === 'catalogsync.offline_conflict_opened'),
    ).toHaveLength(1);
  });

  it('S09 AS-10: a delta past the quantity limit applies nothing and opens a quantity_limit conflict', async () => {
    const w = await world();
    const productId = await product(w, 1_000_000_000 - 10);

    const result = (
      await pushOk(w, 'dev-a', [adjust(productId, 100_000, 'dev-a')])
    ).results[0];

    expect(result).toMatchObject({
      status: 'conflict',
      conflict: { kind: 'quantity_limit', requested: 100_000, applied: 0 },
    });
    expect(await quantityOf(w, productId)).toBe(1_000_000_000 - 10);
    const stored = await conflictRows(w.shopId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'quantity_limit', status: 'open' });
  });

  it('S09 AS-11: an unknown and a foreign product are rejected with identical bodies and nothing is written', async () => {
    const a = await world();
    const b = await world();
    const foreign = await product(b, 10);
    const unknown = randomUUID();
    const eventsB = (await productEvents(ctx.app, foreign)).length;

    const body = await pushOk(a, 'dev-a', [
      adjust(unknown, 1, 'dev-a'),
      adjust(foreign, 1, 'dev-a'),
      {
        type: 'product.update',
        opId: uuidv7(),
        hlc: stamp('dev-a'),
        productId: unknown,
        fields: { title: 'x' },
      },
      {
        type: 'product.update',
        opId: uuidv7(),
        hlc: stamp('dev-a'),
        productId: foreign,
        fields: { title: 'x' },
      },
    ]);

    const [stockUnknown, stockForeign, fieldUnknown, fieldForeign] =
      body.results;
    expect(stockUnknown).toMatchObject({
      status: 'rejected',
      code: 'unknown_product',
    });
    expect(omitIdentity(stockForeign)).toEqual(omitIdentity(stockUnknown));
    expect(fieldUnknown).toMatchObject({
      status: 'rejected',
      code: 'unknown_product',
    });
    expect(omitIdentity(fieldForeign)).toEqual(omitIdentity(fieldUnknown));
    expect(await quantityOf(b, foreign)).toBe(10);
    expect((await productEvents(ctx.app, foreign)).length).toBe(eventsB);
    expect(await operationRows(b.shopId)).toHaveLength(0);
    // The rejections are this shop's own bookkeeping (a replay returns them); nothing reached the other shop.
    const own = await operationRows(a.shopId);
    expect(own).toHaveLength(4);
    expect(
      own.every((r) => r.status === 'rejected' && r.code === 'unknown_product'),
    ).toBe(true);
  });

  it('S09 AS-12: an archived product refuses stock operations and field edits', async () => {
    const w = await world();
    const productId = await product(w, 10);
    const created = (
      await query.getProductsByIds([productId], { shopId: w.shopId })
    ).get(productId)!;
    await commands.archive(w.shopId, productId, created.version, w.owner.id);

    const body = await pushOk(w, 'dev-a', [
      adjust(productId, -1, 'dev-a'),
      adjust(productId, 2, 'dev-a'),
      count(productId, 3, 10, 'dev-a'),
      {
        type: 'product.update',
        opId: uuidv7(),
        hlc: stamp('dev-a'),
        productId,
        fields: { title: 'x' },
      },
    ]);

    expect(body.results.map((r) => [r.status, r.code])).toEqual([
      ['rejected', 'product_unavailable'],
      ['rejected', 'product_unavailable'],
      ['rejected', 'product_unavailable'],
      ['rejected', 'product_unavailable'],
    ]);
    expect(await quantityOf(w, productId)).toBe(10);
  });

  it('S09 AS-13: a result the store refuses once is completed by the repeat, the stock changes once and one event exists', async () => {
    const w = await world();
    const productId = await product(w, 10);
    const op = adjust(productId, 4, 'dev-a');
    await injectFault({
      on: 'UPDATE',
      when: `NEW."opId" = '${op.opId}' AND NEW."status" <> 'pending'`,
      action: `IF nextval('s09_push_fault_seq') = 1 THEN RAISE EXCEPTION 's09 injected SyncOperation fault'; END IF;`,
    });

    const failed = await push(w, 'dev-a', [op]);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('sync_unavailable');
    expect(JSON.stringify(failed.body)).not.toMatch(
      /injected|SyncOperation|trigger/i,
    );
    expect(await quantityOf(w, productId)).toBe(14);
    expect((await operationRows(w.shopId))[0].status).toBe('pending');

    ctx.clock.advance(61 * SECOND);
    const repeat = (await pushOk(w, 'dev-a', [op])).results[0];
    expect(repeat).toMatchObject({
      status: 'applied',
      replayed: false,
      quantityAfter: 14,
    });
    const third = (await pushOk(w, 'dev-a', [op])).results[0];
    expect(third).toMatchObject({
      status: 'applied',
      replayed: true,
      quantityAfter: 14,
    });

    expect(await quantityOf(w, productId)).toBe(14);
    expect((await quantityEvents(productId)).length).toBe(1);
    expect((await operationRows(w.shopId))[0].status).toBe('applied');
  });

  describe('S09 AS-14: in flight, takeover and recovery', () => {
    /** What a request that never finished leaves behind: a committed claim. */
    async function abandonedClaim(
      w: { owner: TestUser; shopId: string },
      productId: string,
      delta: number,
    ) {
      const op = adjust(productId, delta, 'dev-a');
      const parsed = parseOp(op);
      if (!parsed.ok) throw new Error('fixture invalid');
      const claimed = await operations.claim({
        shopId: w.shopId,
        opId: op.opId,
        deviceId: 'dev-a',
        userId: w.owner.id,
        type: 'stock.adjust',
        productId,
        hlc: op.hlc,
        fingerprint: fingerprint(parsed.op),
        content: { delta, reason: op.reason },
        now: ctx.clock.now(),
      });
      expect(claimed.kind).toBe('claimed');
      return op;
    }

    it('S09 AS-14: a claim younger than the lease is in flight, an older one is taken over and completed once', async () => {
      const w = await world();
      const productId = await product(w, 10);
      const op = await abandonedClaim(w, productId, 2);

      ctx.clock.advance(45 * SECOND);
      const waiting = (await pushOk(w, 'dev-a', [op])).results[0];
      expect(waiting).toMatchObject({
        status: 'retry',
        code: 'in_flight',
        replayed: false,
      });
      expect(await quantityOf(w, productId)).toBe(10);

      ctx.clock.advance(16 * SECOND);
      const [first, second] = await Promise.all([
        pushOk(w, 'dev-a', [op]),
        pushOk(w, 'dev-a', [op]),
      ]);
      const results = [first.results[0], second.results[0]];
      expect(results.map((r) => r.status)).toEqual(['applied', 'applied']);
      expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(await quantityOf(w, productId)).toBe(12);
      expect((await quantityEvents(productId)).length).toBe(1);
      expect((await operationRows(w.shopId))[0].status).toBe('applied');
    });

    it('S09 AS-14: the recovery job completes claims older than five minutes exactly once, run twice and at once', async () => {
      const w = await world();
      const productId = await product(w, 10);
      const ops = [
        await abandonedClaim(w, productId, 1),
        await abandonedClaim(w, productId, 2),
        await abandonedClaim(w, productId, 3),
      ];
      ctx.clock.advance(4 * 60 * SECOND);
      await lifecycle.redriveStale();
      expect(await quantityOf(w, productId)).toBe(10);

      ctx.clock.advance(2 * 60 * SECOND);
      await Promise.all([lifecycle.redriveStale(), lifecycle.redriveStale()]);
      await lifecycle.redriveStale();

      expect(await quantityOf(w, productId)).toBe(16);
      expect((await quantityEvents(productId)).length).toBe(3);
      const rows = await operationRows(w.shopId, productId);
      expect(rows.map((r) => r.status)).toEqual([
        'applied',
        'applied',
        'applied',
      ]);
      await ctx.reauth(w.owner); // the access token did not outlive the clock the test moved
      for (const op of ops) {
        const replay = (await pushOk(w, 'dev-a', [op])).results[0];
        expect(replay).toMatchObject({ status: 'applied', replayed: true });
      }
    });
  });

  // ---- US4 ----------------------------------------------------------------------------------------------------

  it('S09 AS-33: a malformed operation is reported by position and the others are applied', async () => {
    const w = await world();
    const productId = await product(w, 10);
    const body = await pushOk(w, 'dev-a', [
      adjust(productId, 1, 'dev-a'),
      {
        type: 'stock.adjust',
        opId: uuidv7(),
        hlc: stamp('dev-a'),
        productId,
        delta: 0,
        reason: 'sold',
      },
      adjust(productId, 2, 'dev-a'),
    ]);

    expect(body.results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(body.results.map((r) => r.status)).toEqual([
      'applied',
      'rejected',
      'applied',
    ]);
    expect(body.results[1]).toMatchObject({ code: 'invalid_op' });
    expect(JSON.stringify(body.results[1].detail)).toContain('delta');
    expect(await quantityOf(w, productId)).toBe(13);
    expect(await operationRows(w.shopId, productId)).toHaveLength(2);
  });

  it('S09 AS-34: the same operation twice in a batch is replayed the second time, other content is op_id_reused', async () => {
    const w = await world();
    const productId = await product(w, 10);
    const op = adjust(productId, 3, 'dev-a');

    const body = await pushOk(w, 'dev-a', [op, op, { ...op, delta: 9 }]);

    expect(body.results[0]).toMatchObject({
      status: 'applied',
      replayed: false,
    });
    expect(body.results[1]).toMatchObject({
      status: 'applied',
      replayed: true,
      quantityAfter: 13,
    });
    expect(body.results[2]).toMatchObject({
      status: 'rejected',
      code: 'op_id_reused',
    });
    expect(await quantityOf(w, productId)).toBe(13);
  });

  it('S09 AS-37: a push that runs out of its budget reports the rest as deadline_exceeded and a resend finishes it once', async () => {
    const w = await world();
    const productId = await product(w, 0);
    const ops = Array.from({ length: 500 }, () =>
      adjust(productId, 1, 'dev-a'),
    );
    await injectFault({
      on: 'INSERT',
      when: `NEW."shopId" = '${w.shopId}'`,
      action: `PERFORM pg_sleep(0.02);`,
    });
    testConfig.pushBudgetMs = 1_500;

    const first = await pushOk(w, 'dev-a', ops);

    const done = first.results.filter((r) => r.status === 'applied');
    const late = first.results.filter((r) => r.code === 'deadline_exceeded');
    expect(done.length).toBeGreaterThan(0);
    expect(late.length).toBeGreaterThan(0);
    expect(done.length + late.length).toBe(500);
    expect(
      first.results.slice(0, done.length).every((r) => r.status === 'applied'),
    ).toBe(true);
    expect(late.every((r) => r.status === 'retry')).toBe(true);
    expect(await quantityOf(w, productId)).toBe(done.length);

    await dropFaults();
    Object.assign(testConfig, SYNC_DEFAULTS);
    const resend = await pushOk(w, 'dev-a', ops);
    expect(resend.results.slice(0, done.length).every((r) => r.replayed)).toBe(
      true,
    );
    expect(
      resend.results
        .slice(done.length)
        .every((r) => r.status === 'applied' && !r.replayed),
    ).toBe(true);
    expect(await quantityOf(w, productId)).toBe(500);
    expect(await operationRows(w.shopId, productId)).toHaveLength(500);
  });

  it('S09 AS-38: a store failure on the third operation is a generic 503, the first two stay and the resend applies the rest once', async () => {
    const w = await world();
    const productId = await product(w, 10);
    const ops = [
      adjust(productId, 1, 'dev-a'),
      adjust(productId, 2, 'dev-a'),
      adjust(productId, 4, 'dev-a'),
      adjust(productId, 8, 'dev-a'),
    ];
    await injectFault({
      on: 'INSERT',
      when: `NEW."opId" = '${ops[2].opId}'`,
      action: `RAISE EXCEPTION 's09 injected SyncOperation fault';`,
    });

    const failed = await push(w, 'dev-a', ops);

    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('sync_unavailable');
    expect(JSON.stringify(failed.body)).not.toMatch(
      /injected|SyncOperation|trigger|SELECT|INSERT/i,
    );
    expect(await quantityOf(w, productId)).toBe(13);
    expect(await operationRows(w.shopId, productId)).toHaveLength(2);

    await dropFaults();
    const resend = await pushOk(w, 'dev-a', ops);
    expect(resend.results.map((r) => r.replayed)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(resend.results.map((r) => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
    expect(await quantityOf(w, productId)).toBe(25);
    expect((await quantityEvents(productId)).length).toBe(4);
  });
});

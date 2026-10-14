import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { developerPlatformRatePolicies } from './rate-limit-policies';
import {
  createKey,
  createPublicApiKit,
  exec,
  newId,
  outboxEvents,
  rows,
  type CreatedKey,
  type PublicApiInstance,
  type PublicApiKit,
  type ShopWorld,
} from './testing/public-api-kit';
import { BulkPurger } from './application/bulk.purger';
import { PublicCatalogService } from './application/public-catalog.service';
import { PublicApiWorkerModule } from './public-api-worker.module';
import { BULK_CHUNK_QUEUE } from './infra/sequelize-bulk-job.repository';

const product = (over: Record<string, unknown> = {}) => ({
  title: 'Mug',
  price: { amount: 1_000, currency: 'USD' },
  stock: 5,
  category: 'kitchen',
  brand: 'Acme',
  ...over,
});
const limiterPolicy = developerPlatformRatePolicies.policies[
  'public-api.default'
] as {
  limit: number;
  localLeaseFraction?: number;
};

describe('Public API: batch and bulk stock', () => {
  let t: PublicApiKit;
  let pub: PublicApiInstance;

  beforeAll(async () => {
    t = await createPublicApiKit({ dashboardImports: [PublicApiWorkerModule] });
    pub = t.pub;
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.queue.sent.length = 0;
    t.queue.deadLettered.length = 0;
  });

  const world = async (
    scopes?: string[],
  ): Promise<{ w: ShopWorld; key: CreatedKey }> => {
    const w = await t.seedWorld();
    return { w, key: await createKey(t, w, scopes ? { scopes } : {}) };
  };
  const api = (key: CreatedKey) => pub.withKey(key.key);
  const create = (key: CreatedKey, body: object = product()) =>
    api(key).post('/v1/products').set('Idempotency-Key', newId()).send(body);
  const batch = (
    key: CreatedKey,
    operations: unknown[],
    idem: string = newId(),
    version?: string,
  ) => {
    const req = api(key).post('/v1/batch').set('Idempotency-Key', idem);
    return (version ? req.set('Marketplace-Version', version) : req).send({
      operations,
    });
  };
  const bulk = (key: CreatedKey, items: unknown[], idem: string = newId()) =>
    api(key)
      .post('/v1/stock/bulk')
      .set('Idempotency-Key', idem)
      .send({ items });
  const stockOf = async (id: string) =>
    (
      await rows<{ quantity: number }>(
        t.app,
        `SELECT quantity FROM "Product" WHERE id = :id`,
        { id },
      )
    )[0].quantity;
  const productCount = async (shopId: string) =>
    (
      await rows<{ n: number }>(
        t.app,
        `SELECT count(*)::int AS n FROM "Product" WHERE "shopId" = :shopId`,
        { shopId },
      )
    )[0].n;
  const newProduct = async (key: CreatedKey, stock = 5): Promise<string> =>
    (await create(key, product({ stock })).expect(201)).body.id;
  const draftOf = (title: string, idempotencyKey?: string) => ({
    method: 'POST',
    path: '/v1/products',
    ...(idempotencyKey ? { idempotencyKey } : {}),
    body: product({ title }),
  });

  describe('AS-43…AS-47 batch', () => {
    it('S42 AS-43: the operations run in order and each answers its own status, shaped for the requested version', async () => {
      const { key } = await world();
      const existing = await newProduct(key);
      const res = await batch(key, [
        draftOf('from batch', 'k1'),
        { method: 'GET', path: `/v1/products/${existing}` },
        {
          method: 'PATCH',
          path: `/v1/products/${existing}`,
          ifMatch: '1',
          body: { title: 'renamed' },
        },
      ]).expect(200);
      expect(res.body.object).toBe('batch');
      expect(res.body.results.map((r: { status: number }) => r.status)).toEqual(
        [201, 200, 200],
      );
      expect(res.body.results[0].body).toMatchObject({
        object: 'product',
        title: 'from batch',
        price: { amount: 1_000, currency: 'USD' },
      });
      expect(res.body.results[2].body).toMatchObject({
        title: 'renamed',
        version: 2,
      });

      const old = await batch(
        key,
        [{ method: 'GET', path: `/v1/products/${existing}` }],
        newId(),
        '2026-01-15',
      ).expect(200);
      expect(old.body.results[0].body).toMatchObject({
        price: 1_000,
        quantity: 5,
      });
    });

    it.each<[string, unknown[] | undefined]>([
      ['no operations', []],
      [
        '51 operations',
        Array.from({ length: 51 }, () => ({
          method: 'GET',
          path: '/v1/products',
        })),
      ],
      [
        'a method that is not GET, POST or PATCH',
        [{ method: 'DELETE', path: '/v1/products/x' }],
      ],
      [
        'a path that does not match',
        [{ method: 'GET', path: '/v1/products?limit=5' }],
      ],
      [
        'an absolute URL',
        [{ method: 'GET', path: 'https://evil.example/v1/products' }],
      ],
      [
        'an unknown property',
        [{ method: 'GET', path: '/v1/products', headers: {} }],
      ],
    ])(
      'S42 AS-44: %s is 400 validation_failed and no operation runs',
      async (_n, operations) => {
        const { w, key } = await world();
        const res = await batch(
          key,
          [draftOf('must not exist', 'k1'), ...(operations ?? [])].slice(
            operations?.length === 0 ? 1 : 0,
          ),
        );
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await productCount(w.shop.id)).toBe(0);
      },
    );

    it('S42 AS-44: a valid but non-batchable route is that operation’s own 422 unsupported_operation; the others run', async () => {
      const { key } = await world();
      const id = await newProduct(key);
      const res = await batch(key, [
        { method: 'GET', path: '/v1/batch' },
        { method: 'GET', path: '/v1/orders' },
        { method: 'POST', path: '/v1/stock/bulk', body: { items: [] } },
        { method: 'GET', path: `/v1/products/${id}/stock` },
        { method: 'GET', path: `/v1/products/${id}` },
      ]).expect(200);
      const results = res.body.results as {
        status: number;
        body: { code?: string };
      }[];
      expect(results.slice(0, 4).map((r) => [r.status, r.body.code])).toEqual(
        Array(4).fill([422, 'unsupported_operation']),
      );
      expect(results[4].status).toBe(200);
    });

    it('S42 AS-45: a missing scope or another shop’s product is that operation’s own 403 or 404; nothing is created', async () => {
      const a = await world(['products:read']);
      const b = await world();
      const own = await newProduct(b.key);
      const mine = (await create(await createKey(t, a.w), product())).body
        .id as string;
      const res = await batch(a.key, [
        { method: 'GET', path: `/v1/products/${mine}` },
        draftOf('forbidden', 'k1'),
        { method: 'GET', path: `/v1/products/${own}` },
      ]).expect(200);
      expect(res.body.results[0].status).toBe(200);
      expect(res.body.results[1]).toMatchObject({
        status: 403,
        body: { code: 'insufficient_scope', required: ['products:write'] },
      });
      expect(res.body.results[2]).toMatchObject({
        status: 404,
        body: { code: 'resource_missing' },
      });
      expect(await productCount(a.w.shop.id)).toBe(1);
    });

    it('S42 AS-46: failures are isolated: [201, 400 with errors, 200]; the first persists, the last ran; an internal error is a generic 500 and the batch continues', async () => {
      const { w, key } = await world();
      const existing = await newProduct(key);
      const res = await batch(key, [
        draftOf('first', 'k1'),
        {
          method: 'POST',
          path: '/v1/products',
          idempotencyKey: 'k2',
          body: { title: '' },
        },
        { method: 'GET', path: `/v1/products/${existing}` },
      ]).expect(200);
      expect(res.body.results.map((r: { status: number }) => r.status)).toEqual(
        [201, 400, 200],
      );
      const failed = res.body.results[1].body;
      expect(failed).toMatchObject({ code: 'validation_failed' });
      for (const member of ['type', 'title', 'status', 'detail', 'code'])
        expect(failed).toHaveProperty(member);
      expect(failed.errors.length).toBeGreaterThan(0);
      expect(await productCount(w.shop.id)).toBe(2);

      const catalog = pub.app.get(PublicCatalogService);
      const spy = jest
        .spyOn(catalog, 'get')
        .mockRejectedValueOnce(new Error('secret internal detail'));
      try {
        const boom = await batch(key, [
          { method: 'GET', path: `/v1/products/${existing}` },
          { method: 'GET', path: `/v1/products/${existing}` },
        ]).expect(200);
        expect(boom.body.results[0]).toMatchObject({
          status: 500,
          body: { code: 'internal_error' },
        });
        expect(JSON.stringify(boom.body.results[0])).not.toContain(
          'secret internal detail',
        );
        expect(boom.body.results[1].status).toBe(200);
      } finally {
        spy.mockRestore();
      }
    });

    it('S42 AS-47: the batch key replays the stored response; another body is 422; a missing key is 422; a running one is 409', async () => {
      const { w, key } = await world();
      const ops = [draftOf('once', 'k1')];
      const idem = newId();
      const first = await batch(key, ops, idem).expect(200);
      const again = await batch(key, ops, idem).expect(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(await productCount(w.shop.id)).toBe(1);

      const other = await batch(key, [draftOf('different', 'k9')], idem).expect(
        422,
      );
      expect(other.body.code).toBe('idempotency_key_reused');
      const none = await api(key)
        .post('/v1/batch')
        .send({ operations: ops })
        .expect(422);
      expect(none.body.code).toBe('idempotency_key_required');

      const catalog = pub.app.get(PublicCatalogService);
      const real = catalog.create.bind(catalog);
      const spy = jest
        .spyOn(catalog, 'create')
        .mockImplementation(async (...args) => {
          await new Promise((r) => setTimeout(r, 400));
          return real(...args);
        });
      try {
        const slow = newId();
        // supertest sends on `then`: this starts the first request now
        const running = batch(key, [draftOf('slow', 'k-slow')], slow).then(
          (r) => r,
        );
        await new Promise((r) => setTimeout(r, 120));
        const busy = await batch(key, [draftOf('slow', 'k-slow')], slow).expect(
          409,
        );
        expect(busy.body.code).toBe('request_in_progress');
        expect((await running).status).toBe(200);
      } finally {
        spy.mockRestore();
      }
    });

    it('S42 AS-47: a retried batch with the same operation keys replays what worked, runs what failed, and a POST operation needs its own key', async () => {
      const { w, key } = await world();
      const existing = await newProduct(key);
      const ops = [
        draftOf('one', 'op-1'),
        draftOf('two', 'op-2'),
        { method: 'GET', path: `/v1/products/${existing}` },
      ];
      const catalog = pub.app.get(PublicCatalogService);
      const real = catalog.create.bind(catalog);
      let calls = 0;
      const spy = jest
        .spyOn(catalog, 'create')
        .mockImplementation((...args) => {
          calls += 1;
          if (calls === 2) return Promise.reject(new Error('transient'));
          return real(...args);
        });
      let firstRun;
      try {
        firstRun = await batch(key, ops).expect(200);
      } finally {
        spy.mockRestore();
      }
      expect(
        firstRun.body.results.map((r: { status: number }) => r.status),
      ).toEqual([201, 500, 200]);
      expect(await productCount(w.shop.id)).toBe(2);

      const retry = await batch(key, ops).expect(200);
      const [r1, r2, r3] = retry.body.results;
      expect(r1.status).toBe(201);
      expect(r1.headers).toEqual({ 'Idempotent-Replayed': 'true' });
      expect(r1.body.id).toBe(firstRun.body.results[0].body.id);
      expect(r2.status).toBe(201);
      expect(r2.headers).toBeUndefined();
      expect(r3.status).toBe(200);
      expect(await productCount(w.shop.id)).toBe(3);

      const keyless = await batch(key, [draftOf('no key')]).expect(200);
      expect(keyless.body.results[0]).toMatchObject({
        status: 422,
        body: { code: 'idempotency_key_required' },
      });
      expect(await productCount(w.shop.id)).toBe(3);
    });
  });

  describe('AS-48, AS-49 cost and budget', () => {
    const remaining = (res: { headers: Record<string, string> }): number =>
      Number(/;r=(\d+)/.exec(res.headers['ratelimit'] ?? '')?.[1]);
    let original: { limit: number; localLeaseFraction?: number };
    beforeEach(() => {
      original = {
        limit: limiterPolicy.limit,
        localLeaseFraction: limiterPolicy.localLeaseFraction,
      };
      limiterPolicy.limit = 100;
      limiterPolicy.localLeaseFraction = undefined;
    });
    afterEach(() => {
      limiterPolicy.limit = original.limit;
      limiterPolicy.localLeaseFraction = original.localLeaseFraction;
    });

    it('S42 AS-48: a request costs 1, a batch its operation count, a bulk call ceil(items/100); too little left is 429 and nothing runs', async () => {
      const { w, key } = await world();
      const single = await api(key).get('/v1/products').expect(200);
      const afterSingle = remaining(single);
      expect(afterSingle).toBe(99);

      const fifty = Array.from({ length: 50 }, () => ({
        method: 'GET',
        path: '/v1/products',
      }));
      const first = await batch(key, fifty).expect(200);
      expect(remaining(first)).toBe(afterSingle - 50);

      const id = await newProduct(key); // 1 unit
      void id;
      const bulkRes = await bulk(
        key,
        Array.from({ length: 250 }, (_, i) => ({
          operationId: `c-${i}`,
          productId: newId(),
          delta: 1,
        })),
      );
      expect(bulkRes.status).toBe(202);
      expect(remaining(bulkRes)).toBe(afterSingle - 50 - 1 - 3);

      const before = await productCount(w.shop.id);
      const refused = await batch(key, [draftOf('x', 'k1'), ...fifty.slice(1)]);
      expect(refused.status).toBe(429);
      expect(refused.body.code).toBe('rate_limited');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(await productCount(w.shop.id)).toBe(before);
    });

    it('S42 AS-48: a call that costs more than the whole budget is 422 rate_limit_cost_exceeded', async () => {
      limiterPolicy.limit = 10;
      const { key } = await world();
      const res = await batch(
        key,
        Array.from({ length: 11 }, () => ({
          method: 'GET',
          path: '/v1/products',
        })),
      );
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('rate_limit_cost_exceeded');
    });

    it('S42 AS-49: operations not started within 10 s answer 503 batch_deadline_exceeded and do not run; the stored response is the same', async () => {
      limiterPolicy.limit = 6000;
      const { key } = await world();
      const catalog = pub.app.get(PublicCatalogService);
      const real = catalog.list.bind(catalog);
      const spy = jest
        .spyOn(catalog, 'list')
        .mockImplementation(async (...args) => {
          t.clock.advance(340);
          return real(...args);
        });
      const before =
        MetricsRegistry.value('public_api_batch_deadline_exceeded_total') ?? 0;
      const idem = newId();
      const fifty = Array.from({ length: 50 }, () => ({
        method: 'GET',
        path: '/v1/products',
      }));
      try {
        const res = await batch(key, fifty, idem).expect(200);
        const results = res.body.results as {
          status: number;
          body: { code?: string; retryable?: boolean };
        }[];
        expect(results.slice(0, 30).every((r) => r.status === 200)).toBe(true);
        expect(
          results
            .slice(30)
            .every(
              (r) =>
                r.status === 503 &&
                r.body.code === 'batch_deadline_exceeded' &&
                r.body.retryable === true,
            ),
        ).toBe(true);
        expect(spy).toHaveBeenCalledTimes(30);
        expect(
          (MetricsRegistry.value('public_api_batch_deadline_exceeded_total') ??
            0) - before,
        ).toBe(20);
        const replay = await batch(key, fifty, idem).expect(200);
        expect(replay.headers['idempotent-replayed']).toBe('true');
        expect(replay.body).toEqual(res.body);
        expect(spy).toHaveBeenCalledTimes(30);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('AS-50 bulk stock up to 100 items', () => {
    it('S42 AS-50: applies the shop’s products atomically, reports a foreign one as not_found, one stock event per product', async () => {
      const a = await world();
      const b = await world();
      const p1 = await newProduct(a.key, 5);
      const p2 = await newProduct(a.key, 3);
      const pb = await newProduct(b.key, 7);
      const events = async (id: string) =>
        (
          await outboxEvents(t.app, 'catalog.product_updated', {
            aggregateId: id,
          })
        ).length;
      const [e1, e2] = [await events(p1), await events(p2)];
      const res = await bulk(a.key, [
        { operationId: 'o1', productId: p1, delta: -2 },
        { operationId: 'o2', productId: p2, delta: 10 },
        { operationId: 'o3', productId: pb, delta: 1 },
      ]).expect(200);
      expect(res.body).toEqual({
        object: 'bulk_stock_update',
        status: 'succeeded',
        results: [
          {
            operation_id: 'o1',
            product_id: p1,
            outcome: 'applied',
            stock_after: 3,
          },
          {
            operation_id: 'o2',
            product_id: p2,
            outcome: 'applied',
            stock_after: 13,
          },
          { operation_id: 'o3', product_id: pb, outcome: 'not_found' },
        ],
      });
      expect([await stockOf(p1), await stockOf(p2), await stockOf(pb)]).toEqual(
        [3, 13, 7],
      );
      expect([(await events(p1)) - e1, (await events(p2)) - e2]).toEqual([
        1, 1,
      ]);
    });

    it('S42 AS-50: an item that would go below zero fails the call: status failed, nothing changes', async () => {
      const { key } = await world();
      const p1 = await newProduct(key, 5);
      const p2 = await newProduct(key, 3);
      const res = await bulk(key, [
        { operationId: 'o1', productId: p1, delta: -6 },
        { operationId: 'o2', productId: p2, delta: 1 },
      ]).expect(200);
      expect(res.body.status).toBe('failed');
      expect(
        res.body.results.map((r: { outcome: string }) => r.outcome),
      ).toEqual(['insufficient_stock', 'not_applied']);
      expect([await stockOf(p1), await stockOf(p2)]).toEqual([5, 3]);
    });

    it('S42 AS-50: the same operation ids under a new Idempotency-Key are replayed with the original stock_after; a reused id with another change is 422', async () => {
      const { key } = await world();
      const p1 = await newProduct(key, 5);
      const items = [{ operationId: 'o1', productId: p1, delta: -2 }];
      await bulk(key, items).expect(200);
      const again = await bulk(key, items).expect(200);
      expect(again.body.results).toEqual([
        {
          operation_id: 'o1',
          product_id: p1,
          outcome: 'replayed',
          stock_after: 3,
        },
      ]);
      expect(await stockOf(p1)).toBe(3);
      const conflict = await bulk(key, [
        { operationId: 'o1', productId: p1, delta: -1 },
      ]).expect(422);
      expect(conflict.body.code).toBe('operation_conflict');
    });

    it.each<[string, unknown[], string]>([
      [
        'duplicate operation ids',
        [
          { operationId: 'a', productId: newId(), delta: 1 },
          { operationId: 'a', productId: newId(), delta: 2 },
        ],
        'items',
      ],
      [
        'a delta of 0',
        [{ operationId: 'a', productId: newId(), delta: 0 }],
        'items.0.delta',
      ],
      [
        'a fractional delta',
        [{ operationId: 'a', productId: newId(), delta: 1.5 }],
        'items.0.delta',
      ],
      [
        'a delta above 1,000,000',
        [{ operationId: 'a', productId: newId(), delta: 1_000_001 }],
        'items.0.delta',
      ],
      ['an empty list', [], 'items'],
      [
        'a product id that is not a UUID',
        [{ operationId: 'a', productId: 'nope', delta: 1 }],
        'items.0.productId',
      ],
      [
        'an empty operation id',
        [{ operationId: '', productId: newId(), delta: 1 }],
        'items.0.operationId',
      ],
    ])(
      'S42 AS-50: %s is 400 validation_failed naming %s',
      async (_n, items, field) => {
        const { key } = await world();
        const res = await bulk(key, items).expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(
          res.body.errors.map((e: { field: string }) => e.field),
        ).toContain(field);
      },
    );

    it('S42 AS-50: more than 10,000 items is 400', async () => {
      const { key } = await world();
      const items = Array.from({ length: 10_001 }, (_, i) => ({
        operationId: `o${i}`,
        productId: newId(),
        delta: 1,
      }));
      await bulk(key, items).expect((r) =>
        expect([400, 413]).toContain(r.status),
      );
    });
  });

  describe('AS-51, AS-52 bulk jobs', () => {
    const chunkTasks = async (jobId: string) =>
      (await outboxRowsFor(t.app, jobId)).filter((r) => r.kind === 'task');
    /** What the outbox relay does: moves the job's chunk tasks to the queue, then the worker's consumer takes them. */
    const deliver = async (jobId: string, only?: number[]) => {
      const tasks = await chunkTasks(jobId);
      for (const task of tasks) {
        const body = (task.payload as { body: { index: number } }).body;
        if (only && !only.includes(body.index)) continue;
        await t.queue.enqueue(BULK_CHUNK_QUEUE, body);
      }
      await t.queue.drain(BULK_CHUNK_QUEUE);
    };
    const job = (key: CreatedKey, id: string) =>
      api(key).get(`/v1/stock/bulk/${id}`);
    const items = (n: number, productId: string, delta = 1) =>
      Array.from({ length: n }, (_, i) => ({
        operationId: `op-${i}`,
        productId,
        delta,
      }));

    it('S42 AS-51: 250 items become a job of 3 chunks, applied independently; the counters end exact', async () => {
      const { key } = await world();
      const p = await newProduct(key, 0);
      const res = await bulk(key, items(250, p)).expect(202);
      expect(res.body).toMatchObject({
        object: 'bulk_stock_update',
        status: 'processing',
        total: 250,
        chunks: 3,
      });
      expect(res.body.id).toMatch(/^bsu_[0-9a-f]{32}$/);
      expect(res.headers.location).toBe(`/v1/stock/bulk/${res.body.id}`);
      expect((await chunkTasks(res.body.id)).map((r) => r.topic)).toEqual(
        Array(3).fill(BULK_CHUNK_QUEUE),
      );

      const before = await job(key, res.body.id).expect(200);
      expect(before.body).toMatchObject({
        status: 'processing',
        total: 250,
        applied: 0,
        completed_chunks: 0,
      });
      await deliver(res.body.id);
      const after = await job(key, res.body.id).expect(200);
      expect(after.body).toMatchObject({
        status: 'succeeded',
        total: 250,
        applied: 250,
        replayed: 0,
        failed: 0,
        failures: [],
        completed_chunks: 3,
      });
      expect(await stockOf(p)).toBe(250);
    });

    it('S42 AS-51: a chunk delivered twice counts and changes stock once; an invalid chunk is dead-lettered and corrupts nothing', async () => {
      const { key } = await world();
      const p = await newProduct(key, 0);
      const res = await bulk(key, items(150, p)).expect(202);
      const before =
        MetricsRegistry.value('public_api_bulk_chunk_replayed_total') ?? 0;
      await deliver(res.body.id, [0]);
      await deliver(res.body.id, [0]);
      expect(
        (MetricsRegistry.value('public_api_bulk_chunk_replayed_total') ?? 0) -
          before,
      ).toBe(1);
      expect((await job(key, res.body.id).expect(200)).body).toMatchObject({
        status: 'processing',
        applied: 100,
        completed_chunks: 1,
      });
      expect(await stockOf(p)).toBe(100);

      await t.queue.enqueue(BULK_CHUNK_QUEUE, {
        jobId: res.body.id,
        shopId: 'not-a-uuid',
        index: 'x',
        items: [],
      });
      await t.queue.drain(BULK_CHUNK_QUEUE);
      expect(t.queue.deadLettered).toHaveLength(1);
      expect(t.queue.deadLettered[0].reason).toBe('SCHEMA_INVALID');
      await deliver(res.body.id, [1]);
      expect((await job(key, res.body.id).expect(200)).body).toMatchObject({
        status: 'succeeded',
        applied: 150,
        completed_chunks: 2,
      });
      expect(await stockOf(p)).toBe(150);
    });

    it('S42 AS-51: a worker that crashes after applying a chunk but before recording it ends with exact counters on redelivery', async () => {
      const { key } = await world();
      const p = await newProduct(key, 0);
      const res = await bulk(key, items(101, p)).expect(202);
      await exec(
        t.app,
        `CREATE FUNCTION s42_fail_chunk() RETURNS trigger AS $$
         BEGIN IF NEW.state = 'done' AND NEW."jobId" = '${res.body.id}' AND NEW."index" = 0 THEN RAISE EXCEPTION 'crash before the marker'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
         CREATE TRIGGER s42_fail_chunk BEFORE UPDATE ON "ApiBulkChunk" FOR EACH ROW EXECUTE FUNCTION s42_fail_chunk()`,
      );
      try {
        await expect(deliver(res.body.id, [0])).rejects.toThrow();
        expect(await stockOf(p)).toBe(100); // applied, not recorded
      } finally {
        await exec(
          t.app,
          `DROP TRIGGER IF EXISTS s42_fail_chunk ON "ApiBulkChunk"`,
        );
        await exec(t.app, `DROP FUNCTION IF EXISTS s42_fail_chunk()`);
      }
      t.queue.sent.length = 0;
      await deliver(res.body.id);
      const done = await job(key, res.body.id).expect(200);
      expect(done.body).toMatchObject({
        status: 'succeeded',
        total: 101,
        completed_chunks: 2,
        failed: 0,
      });
      expect(done.body.applied + done.body.replayed).toBe(101);
      expect(done.body.replayed).toBe(100);
      expect(await stockOf(p)).toBe(101);
    });

    it('S42 AS-51: another shop’s job is 404, a malformed id is 404, and a finished job is purged after 7 days', async () => {
      const a = await world();
      const b = await world();
      const p = await newProduct(a.key, 0);
      const res = await bulk(a.key, items(101, p)).expect(202);
      await job(b.key, res.body.id).expect(404);
      await job(a.key, 'bsu_nope').expect(404);
      await deliver(res.body.id);
      t.clock.advance(8 * 86_400_000);
      expect(
        await t.app.get(BulkPurger, { strict: false }).purge(),
      ).toBeGreaterThanOrEqual(1);
      await job(a.key, res.body.id).expect(404);
      const [{ n }] = await rows<{ n: number }>(
        t.app,
        `SELECT count(*)::int AS n FROM "ApiBulkChunk" WHERE "jobId" = :id`,
        { id: res.body.id },
      );
      expect(n).toBe(0);
    });

    it('S42 AS-52: 10,000 items with 3 unknown products become one replay-safe job that ends partially_failed', async () => {
      const { key } = await world();
      const p = await newProduct(key, 0);
      const unknown = [newId(), newId(), newId()];
      const all = items(10_000, p).map((item, i) =>
        i < 3 ? { ...item, productId: unknown[i] } : item,
      );
      const idem = newId();
      const res = await bulk(key, all, idem).expect(202);
      expect(res.body).toMatchObject({ total: 10_000, chunks: 100 });
      const again = await bulk(key, all, idem).expect((r) => {
        if (r.status !== 202)
          throw new Error(`replay: ${r.status} ${JSON.stringify(r.body)}`);
      });
      expect(again.body.id).toBe(res.body.id);
      expect(again.headers['idempotent-replayed']).toBe('true');
      const [{ n }] = await rows<{ n: number }>(
        t.app,
        `SELECT count(*)::int AS n FROM "ApiBulkJob"`,
      );
      expect(n).toBeGreaterThanOrEqual(1);

      await deliver(res.body.id);
      const done = await job(key, res.body.id).expect(200);
      expect(done.body).toMatchObject({
        status: 'partially_failed',
        applied: 9_997,
        failed: 3,
        completed_chunks: 100,
      });
      expect(
        done.body.failures.map(
          (f: { operation_id: string; outcome: string }) => [
            f.operation_id,
            f.outcome,
          ],
        ),
      ).toEqual([
        ['op-0', 'not_found'],
        ['op-1', 'not_found'],
        ['op-2', 'not_found'],
      ]);
      expect(await stockOf(p)).toBe(9_997);
    }, 300_000);
  });
});

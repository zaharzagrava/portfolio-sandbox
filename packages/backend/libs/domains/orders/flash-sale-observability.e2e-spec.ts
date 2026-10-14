import { trace, type Tracer } from '@opentelemetry/api';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createFlashApp, type FlashTestApp } from './testing/flash-kit';
import {
  MIN,
  T,
  addToCart,
  advance,
  at,
  checkoutAs,
  openDrop,
  sum,
} from './testing/flash-scenarios';

describe('Flash sales: metrics and logs', () => {
  let t: FlashTestApp;
  const written: string[] = [];
  let stdout: jest.SpyInstance;
  const spans: string[] = [];
  let tracerSpy: jest.SpyInstance;

  beforeAll(async () => {
    stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    const real = trace.getTracer.bind(trace);
    tracerSpy = jest
      .spyOn(trace, 'getTracer')
      .mockImplementation((name: string, version?: string) => {
        const tracer = real(name, version);
        if (name !== 'flash-sales') return tracer;
        return new Proxy(tracer, {
          get(target, prop, receiver) {
            if (prop === 'startActiveSpan')
              return (...args: unknown[]) => {
                spans.push(String(args[0]));
                return (target.startActiveSpan as (...a: unknown[]) => unknown)(
                  ...args,
                );
              };
            return Reflect.get(target, prop, receiver) as unknown;
          },
        }) as Tracer;
      });
    t = await createFlashApp({ structuredLogger: true });
  });
  afterAll(async () => {
    await t.close();
    tracerSpy.mockRestore();
    stdout.mockRestore();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(T);
    written.length = 0;
    spans.length = 0;
  });

  const metric = (name: string, labels: Record<string, string> = {}) =>
    MetricsRegistry.value(name, labels) ?? 0;
  const logs = () =>
    written
      .join('')
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, any>);

  it('S11 AS-42: reservation results and admission rejections are counted by outcome', async () => {
    const reserved = metric('flash_sale_reservations_total', {
      result: 'reserved',
    });
    const soldOut = metric('flash_sale_reservations_total', {
      result: 'sold_out',
    });
    const limit = metric('flash_sale_reservations_total', {
      result: 'limit_exceeded',
    });
    const rejected = metric('flash_sale_admission_rejected_total');

    // 8 buyers, 3 units, an allowance of 6: 3 reserved, 3 sold out, 2 held back by admission
    const d = await openDrop(t, { units: 3, buckets: 1, limit: 1, rate: 6 });
    const users = await Promise.all(
      Array.from({ length: 8 }, () => t.newUser()),
    );
    await Promise.all(users.map((u) => addToCart(t, u, d.productId, 1)));
    const results = await Promise.all(users.map((u) => checkoutAs(t, u)));
    expect(results.filter((r) => r.status === 202)).toHaveLength(3);
    expect(results.filter((r) => r.status === 422)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
    expect(
      metric('flash_sale_reservations_total', { result: 'reserved' }),
    ).toBe(reserved + 3);
    expect(
      metric('flash_sale_reservations_total', { result: 'sold_out' }),
    ).toBe(soldOut + 3);
    expect(metric('flash_sale_admission_rejected_total')).toBe(rejected + 2);

    // a per-buyer limit refusal
    const l = await openDrop(t, { units: 10, buckets: 2, limit: 1 });
    const buyer = await t.newUser();
    await addToCart(t, buyer, l.productId, 2);
    expect((await checkoutAs(t, buyer)).status).toBe(422);
    expect(
      metric('flash_sale_reservations_total', { result: 'limit_exceeded' }),
    ).toBe(limit + 1);
  });

  it('S11 AS-42: a loaded sale outside its window counts as not_open', async () => {
    const before = metric('flash_sale_reservations_total', {
      result: 'not_open',
    });
    const d = await openDrop(t, { units: 5, buckets: 1, limit: 1 });
    const user = await t.newUser();
    await addToCart(t, user, d.productId, 1);
    await advance(t, 80 * MIN - 10 * MIN, user); // after the end
    expect((await checkoutAs(t, user)).status).toBe(202); // the regular price applies
    expect(
      metric('flash_sale_reservations_total', { result: 'not_open' }),
    ).toBe(before + 1);
  });

  it('S11 AS-42: verification refreshes the remaining gauge and counts phantom units and oversell', async () => {
    const d = await openDrop(t, {
      units: 100,
      buckets: 4,
      limit: 5,
      regular: 0,
    });
    const buyer = await t.newUser();
    await addToCart(t, buyer, d.productId, 5);
    expect((await checkoutAs(t, buyer)).status).toBe(202);
    // 5 of 100 are sold, so 95 are possible; a restored snapshot shows 99
    for (let b = 0; b < 4; b++)
      await t.redis.set(`flash:{${d.id}:${b}}:stock`, b === 0 ? 99 : 0);
    const phantom = metric('flash_sale_phantom_stock_units_total');
    await t.jobs.verify();
    expect(metric('flash_sale_stock_remaining', { saleId: d.id })).toBe(99);
    expect(metric('flash_sale_phantom_stock_units_total')).toBe(phantom + 4);
    expect(sum(await t.buckets(d.id, 4))).toBe(95);
    await t.jobs.verify();
    expect(metric('flash_sale_stock_remaining', { saleId: d.id })).toBe(95);
  });

  it('S11 AS-42: every reservation log line carries requestId and saleId, and never an e-mail or a token', async () => {
    const d = await openDrop(t, { units: 1, buckets: 1, limit: 1 });
    const a = await t.newUser();
    const b = await t.newUser();
    await addToCart(t, a, d.productId, 1);
    await addToCart(t, b, d.productId, 1);
    expect((await checkoutAs(t, a)).status).toBe(202);
    expect((await checkoutAs(t, b)).status).toBe(422);

    const lines = logs().filter((l) =>
      String(l.event ?? '').startsWith('flash.'),
    );
    const reserve = lines.filter((l) => l.event === 'flash.reserve');
    expect(reserve.map((l) => l.result).sort()).toEqual([
      'reserved',
      'sold_out',
    ]);
    for (const l of reserve) {
      expect(l.saleId).toBe(d.id);
      expect(l.requestId).toEqual(expect.any(String));
    }
    const raw = written.join('');
    for (const secret of [
      a.email,
      b.email,
      a.bearer.replace('Bearer ', ''),
      b.bearer.replace('Bearer ', ''),
    ])
      expect(raw).not.toContain(secret);
  });

  it('S11 AS-42: spans cover admission, reserve, release and each job', async () => {
    const d = await openDrop(t, { units: 5, buckets: 1, limit: 5 });
    const user = await t.newUser();
    await addToCart(t, user, d.productId, 1);
    const res = await checkoutAs(t, user);
    expect(res.status).toBe(202);
    expect(
      (await t.as(user).post(`/api/orders/${res.body.orderId}/cancel`)).status,
    ).toBe(200);
    await t.jobs.verify();
    await t.jobs.sweepClaims();
    t.clock.set(at(70 * MIN));
    await t.jobs.end({ saleId: d.id });
    t.clock.set(at(87 * MIN));
    await t.jobs.reconcile({ saleId: d.id });

    for (const name of [
      'flash.admit',
      'flash.reserve',
      'flash.job.load',
      'flash.job.verify',
      'flash.job.sweep-claims',
      'flash.job.end',
      'flash.job.reconcile',
    ])
      expect(spans).toContain(name);
  });
});

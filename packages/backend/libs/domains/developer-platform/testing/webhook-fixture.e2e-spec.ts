import { FakeClock } from '@app/common/core/clock';
import { DEFAULT_WEBHOOK_SETTINGS } from '../domain/webhook-settings';
import {
  parseRetryAfter,
  SafeOutboundHttpAdapter,
} from '../infra/safe-outbound-http.adapter';
import {
  FakeResolver,
  FROZEN_NOW,
  netOptionsFor,
  orderPaidEvent,
  orderStatusEvent,
  payoutEvent,
  productEvent,
  shopDeletedEvent,
  WebhookReceiver,
} from './webhook-e2e.fixture';

/**
 * The fixture's own proof (T005) and the outbound adapter (T027) against real local HTTPS receivers: the receiver
 * scripts, the injected resolver and the S54 client wired the way the end-to-end specs use them.
 */
describe('Webhooks: e2e fixture and the outbound HTTP adapter', () => {
  const resolver = new FakeResolver();
  const receivers: WebhookReceiver[] = [];
  const clock = new FakeClock(FROZEN_NOW);
  let adapter: SafeOutboundHttpAdapter;

  const start = async () => {
    const receiver = await WebhookReceiver.start();
    receivers.push(receiver);
    resolver.set(receiver.host, [receiver.address]);
    return receiver;
  };
  const post = (
    receiver: WebhookReceiver,
    over: { timeoutMs?: number; path?: string } = {},
  ) =>
    adapter.post({
      url: receiver.url(over.path ?? '/in'),
      headers: {
        'content-type': 'application/json',
        'marketplace-event-id': 'evt_1',
        'marketplace-attempt': '2',
      },
      body: '{"id":"evt_1"}',
      timeoutMs: over.timeoutMs ?? 2000,
      maxResponseBytes: 1024,
    });

  beforeAll(() => {
    adapter = new SafeOutboundHttpAdapter(
      clock,
      { ...DEFAULT_WEBHOOK_SETTINGS },
      netOptionsFor(resolver, () => receivers),
    );
  });
  afterAll(() => Promise.all(receivers.map((r) => r.close())));

  it('S43 AS-35: a 2xx answer is a response result and the receiver saw the exact bytes and headers', async () => {
    const receiver = await start();
    const result = await post(receiver);
    expect(result).toMatchObject({ kind: 'response', status: 200 });
    expect(receiver.requests).toHaveLength(1);
    expect(receiver.requests[0]).toMatchObject({
      method: 'POST',
      path: '/in',
      body: '{"id":"evt_1"}',
      eventId: 'evt_1',
      attempt: 2,
      replay: false,
    });
  });

  it('S43 AS-39: a 500 and a 429 with Retry-After are responses carrying status and the wait', async () => {
    const receiver = await start();
    receiver.respondWith(
      { status: 500, body: 'oops' },
      { status: 429, headers: { 'retry-after': '7200' } },
    );
    expect(await post(receiver)).toMatchObject({
      kind: 'response',
      status: 500,
      snippet: 'oops',
    });
    expect(await post(receiver)).toMatchObject({
      kind: 'response',
      status: 429,
      retryAfterSec: 7200,
    });
  });

  it('S43 AS-39: a 301 is not followed: the second server receives nothing and the result is the 301', async () => {
    const target = await start();
    const receiver = await start();
    receiver.respondWith({ redirect: target.url('/elsewhere') });
    expect(await post(receiver)).toMatchObject({
      kind: 'response',
      status: 301,
    });
    expect(target.requests).toHaveLength(0);
  });

  it('S43 AS-38: a receiver that never answers is a timeout at the overall deadline', async () => {
    const receiver = await start();
    receiver.respondWith({ hang: true });
    const started = Date.now();
    const result = await post(receiver, { timeoutMs: 400 });
    expect(result).toMatchObject({ kind: 'failure', error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('S43 AS-38: a slow-drip receiver is cut at the overall deadline, not the idle one', async () => {
    const receiver = await start();
    receiver.respondWith({ slowDrip: true, intervalMs: 50 });
    const result = await post(receiver, { timeoutMs: 400 });
    expect(result).toMatchObject({ kind: 'failure', error: 'timeout' });
  });

  it('S43 AS-38: a 1 MiB answer is read to 1 KiB and the result is the status code', async () => {
    const receiver = await start();
    receiver.respondWith({ bigBody: 1024 * 1024 });
    const result = await post(receiver);
    expect(result).toMatchObject({ kind: 'response', status: 200 });
    expect((result as { snippet: string }).snippet).toHaveLength(1024);
  });

  it('S43 AS-51: a name that resolves to a private address makes no connection and is blocked_address', async () => {
    const receiver = await start();
    resolver.set(receiver.host, ['10.0.0.5']);
    expect(await post(receiver)).toMatchObject({
      kind: 'failure',
      error: 'blocked_address',
    });
    expect(receiver.connections).toBe(0);
    resolver.set(receiver.host, [receiver.address]); // public again: delivers
    expect(await post(receiver)).toMatchObject({
      kind: 'response',
      status: 200,
    });
  });

  it('S43 AS-52: mixed answers, mapped addresses and special ranges are all blocked without a connection', async () => {
    const receiver = await start();
    for (const answers of [
      ['127.0.0.1'],
      ['::1'],
      ['::ffff:10.0.0.1'],
      ['100.64.0.1'],
      ['fd00::1'],
      ['224.0.0.1'],
      ['0.0.0.0'],
      [receiver.address, '192.168.1.10'],
    ]) {
      resolver.set(receiver.host, answers);
      expect(await post(receiver)).toMatchObject({
        kind: 'failure',
        error: 'blocked_address',
      });
    }
    expect(receiver.connections).toBe(0);
  });

  it('S43 AS-03: a name that does not resolve is unresolvable', async () => {
    const receiver = await start();
    resolver.delete(receiver.host);
    expect(await post(receiver)).toMatchObject({
      kind: 'failure',
      error: 'unresolvable',
    });
  });

  it('S43 AS-36: the receiver records the highest number of requests in flight', async () => {
    const receiver = await start();
    receiver.respondWith({ status: 200, delayMs: 100 });
    await Promise.all([post(receiver), post(receiver), post(receiver)]);
    expect(receiver.requests).toHaveLength(3);
    expect(receiver.maxInFlight).toBeGreaterThan(1);
  });

  describe('Retry-After parsing', () => {
    it.each<[string | undefined, number | undefined]>([
      ['7200', 7200],
      [' 30 ', 30],
      ['0', 0],
      ['Tue, 06 Oct 2026 12:02:00 GMT', 120],
      ['Tue, 06 Oct 2026 11:00:00 GMT', 0],
      ['soon', undefined],
      ['-5', undefined],
      [undefined, undefined],
    ])('S43 AS-39: %j -> %j', (header, expected) => {
      expect(parseRetryAfter(header, FROZEN_NOW)).toBe(expected);
    });
  });

  describe('source event builders are schema-valid (they parse their own output)', () => {
    it('S43 AS-23: order, product, payout and shop events build', () => {
      const shopA = '0196a000-0000-7000-8000-0000000000a1';
      const shopB = '0196a000-0000-7000-8000-0000000000b1';
      expect(
        orderPaidEvent({
          shops: [
            { shopId: shopA },
            { shopId: shopB, lines: [{ quantity: 2 }] },
          ],
        }).type,
      ).toBe('order.paid');
      expect(
        orderStatusEvent('order.cancelled', { shopIds: [shopA] }).payload
          .shopIds,
      ).toEqual([shopA]);
      expect(orderStatusEvent('order.refunded', {}).payload).not.toHaveProperty(
        'shopIds',
      );
      for (const kind of [
        'created',
        'updated',
        'archived',
        'restored',
        'deleted',
      ] as const)
        expect(productEvent(kind, { shopId: shopA }).type).toBe(
          `catalog.product_${kind}`,
        );
      expect(payoutEvent('paid', { shopId: shopA }).type).toBe('payout.paid');
      expect(payoutEvent('failed', { shopId: shopA }).type).toBe(
        'payout.failed',
      );
      expect(shopDeletedEvent(shopA).payload.shopId).toBe(shopA);
    });
  });
});

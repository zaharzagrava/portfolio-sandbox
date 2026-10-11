import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/events', () => ({ sendEvents: vi.fn() }));

import { sendEvents } from '@/lib/api/events';
import { __resetTrackForTests } from '@/lib/analytics/track';
import { trackAddToCart, trackCheckoutStep } from './events';

const send = vi.mocked(sendEvents);
type Sent = Parameters<typeof sendEvents>[0];
const sent = (): Sent[number][] => send.mock.calls.flatMap((call) => call[0]);
const ORDER_ID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const PRODUCT_ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';

function setPrivacy(signal: 'gpc' | 'dnt' | 'none') {
  Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: signal === 'gpc' ? true : undefined });
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: signal === 'dnt' ? '1' : null });
}

beforeEach(() => {
  vi.useFakeTimers();
  send.mockReset();
  send.mockResolvedValue({ ok: true });
  setPrivacy('none');
  __resetTrackForTests();
});
afterEach(() => {
  __resetTrackForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('checkout events (W03 UE, FR-090)', () => {
  it('W03 AS-75: add_to_cart carries exactly product_id and category', async () => {
    trackAddToCart({ productId: PRODUCT_ID, category: 'audio' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].name).toBe('add_to_cart');
    expect(sent()[0].props).toEqual({ product_id: PRODUCT_ID, category: 'audio' });
  });

  it('W03 AS-75: add_to_cart without a category sends only product_id', async () => {
    trackAddToCart({ productId: PRODUCT_ID });
    trackAddToCart({ productId: PRODUCT_ID, category: '' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent().map((event) => event.props)).toEqual([{ product_id: PRODUCT_ID }, { product_id: PRODUCT_ID }]);
  });

  it.each([
    ['cart', 3, undefined, { step: 'cart', items: 3 }],
    ['review', 2, undefined, { step: 'review', items: 2 }],
    ['pay', 2, ORDER_ID, { step: 'pay', items: 2, order_id: ORDER_ID }],
    ['success', 1, ORDER_ID, { step: 'success', items: 1, order_id: ORDER_ID }],
  ] as const)('W03 AS-75: checkout_step %s has props %j', async (step, items, orderId, props) => {
    trackCheckoutStep({ step, items, ...(orderId ? { orderId } : {}) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].name).toBe('checkout_step');
    expect(sent()[0].props).toEqual(props);
  });

  it('W03 AS-75: items is a whole non-negative number', async () => {
    trackCheckoutStep({ step: 'review', items: 2.9 });
    trackCheckoutStep({ step: 'review', items: -4 });
    trackCheckoutStep({ step: 'review', items: Number.NaN });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent().map((event) => event.props?.items)).toEqual([2, 0, 0]);
  });

  it('W03 AS-75: no title, total or personal field can be added: extra input fields never reach the event', async () => {
    trackAddToCart({ productId: PRODUCT_ID, category: 'audio', title: 'Secret', priceMinor: 5 } as never);
    trackCheckoutStep({ step: 'pay', items: 1, orderId: ORDER_ID, totalMinor: 4200, email: 'a@b.c' } as never);
    await vi.advanceTimersByTimeAsync(5000);
    const text = JSON.stringify(sent().map((event) => event.props));
    expect(text).not.toMatch(/Secret|4200|a@b\.c|priceMinor|totalMinor|email|title/);
  });

  it.each(['gpc', 'dnt'] as const)('W03 AS-75: nothing is sent under %s', async (signal) => {
    setPrivacy(signal);
    trackAddToCart({ productId: PRODUCT_ID, category: 'audio' });
    trackCheckoutStep({ step: 'review', items: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
  });
});

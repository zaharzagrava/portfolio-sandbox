import { describe, expect, it } from 'vitest';
import { isCancellable, orderStats, type OrderSummary } from './orders';

const order = (status: OrderSummary['status']): OrderSummary => ({ id: status, status, total: '100', createdAt: '2026-10-03T00:00:00Z' });

describe('orderStats', () => {
  it('counts open (not yet delivered, not cancelled/refunded) and delivered orders', () => {
    const orders = ['RESERVED', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'].map((s) => order(s as OrderSummary['status']));
    expect(orderStats(orders)).toEqual({ total: 6, open: 3, delivered: 1 });
  });
});

describe('isCancellable', () => {
  it('allows cancelling only before payment', () => {
    expect(isCancellable('PENDING')).toBe(true);
    expect(isCancellable('RESERVED')).toBe(true);
    expect(isCancellable('PAID')).toBe(false);
    expect(isCancellable('SHIPPED')).toBe(false);
  });
});

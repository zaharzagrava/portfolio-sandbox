import { ORDER_STATUSES } from '@marketplace-sandbox/contracts';
import { describe, expect, it } from 'vitest';
import { isConfirmed } from './status';

const CONFIRMED = new Set(['PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED']);

describe('isConfirmed (W03 SC-003)', () => {
  describe.each(ORDER_STATUSES.map((status) => [status, CONFIRMED.has(status)] as const))('order status %s', (status, expected) => {
    it(`W03 AS-48: isConfirmed(${status}) is ${expected}`, () => {
      expect(isConfirmed(status)).toBe(expected);
    });
  });

  it('W03 AS-49: an unknown, missing or lower-case status is never confirmed', () => {
    for (const value of [undefined, null, '', 'paid', 'COMPLETED', 'UNKNOWN', 42]) expect(isConfirmed(value as never)).toBe(false);
  });
});

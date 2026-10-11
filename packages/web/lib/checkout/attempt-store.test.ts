import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let authHandler: ((type: 'signed-in' | 'signed-out') => void) | undefined;
const unsubscribe = vi.fn();
vi.mock('@/lib/auth/session-sync', () => ({
  subscribeAuth: (handler: typeof authHandler) => {
    authHandler = handler;
    return unsubscribe;
  },
}));

import { ATTEMPT_MAX_AGE_MS, type OrderAttempt, type PayAttempt } from './attempt';
import {
  CHECKOUT_ATTEMPT_KEY,
  clearAllAttempts,
  clearOrderAttempt,
  clearPayAttempt,
  loadOrderAttempt,
  loadPayAttempt,
  payAttemptKey,
  saveOrderAttempt,
  savePayAttempt,
  watchAuthForAttempts,
} from './attempt-store';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const K1 = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b';
const ORDER_1 = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const ORDER_2 = 'aaaaaaaa-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const attempt: OrderAttempt = { key: K1, expectedTotalMinor: 3998, cartFingerprint: 'abc123', createdAt: NOW - 1000 };
const payAttempt: PayAttempt = { key: K1, paymentMethodId: 'pm_a', createdAt: NOW - 1000 };

beforeEach(() => {
  sessionStorage.clear();
  authHandler = undefined;
  unsubscribe.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('attempt store (W03 UK2)', () => {
  it('W03 AS-20: the storage keys are the ones listed on the privacy page', () => {
    expect(CHECKOUT_ATTEMPT_KEY).toBe('w03.attempt.checkout');
    expect(payAttemptKey(ORDER_1)).toBe(`w03.attempt.pay:${ORDER_1}`);
  });

  it('W03 AS-20: an order attempt survives a reload (saved, then loaded again from the tab storage)', () => {
    saveOrderAttempt(attempt);
    expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY)).toContain(K1);
    expect(loadOrderAttempt(NOW)).toEqual(attempt);
  });

  it('W03 AS-19: an attempt older than 24 hours is dropped when loaded, and removed from the storage', () => {
    saveOrderAttempt({ ...attempt, createdAt: NOW - ATTEMPT_MAX_AGE_MS - 1 });
    expect(loadOrderAttempt(NOW)).toBeNull();
    expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY)).toBeNull();
  });

  it('W03 AS-20: damaged storage content is dropped and removed', () => {
    sessionStorage.setItem(CHECKOUT_ATTEMPT_KEY, '{"key":"nope"');
    expect(loadOrderAttempt(NOW)).toBeNull();
    expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY)).toBeNull();
  });

  it('W03 AS-17: clearing removes the order attempt', () => {
    saveOrderAttempt(attempt);
    clearOrderAttempt();
    expect(loadOrderAttempt(NOW)).toBeNull();
  });

  it('W03 AS-47: pay attempts are kept per order', () => {
    savePayAttempt(ORDER_1, payAttempt);
    savePayAttempt(ORDER_2, { ...payAttempt, paymentMethodId: 'pm_b' });
    expect(loadPayAttempt(ORDER_1, NOW)).toEqual(payAttempt);
    expect(loadPayAttempt(ORDER_2, NOW)?.paymentMethodId).toBe('pm_b');
    clearPayAttempt(ORDER_1);
    expect(loadPayAttempt(ORDER_1, NOW)).toBeNull();
    expect(loadPayAttempt(ORDER_2, NOW)).not.toBeNull();
  });

  it('W03 AS-47: an expired pay attempt is dropped', () => {
    savePayAttempt(ORDER_1, { ...payAttempt, createdAt: NOW - ATTEMPT_MAX_AGE_MS - 1 });
    expect(loadPayAttempt(ORDER_1, NOW)).toBeNull();
    expect(sessionStorage.getItem(payAttemptKey(ORDER_1))).toBeNull();
  });

  it('W03 AS-32: clearAllAttempts removes the order attempt and every pay attempt but nothing else', () => {
    sessionStorage.setItem('theme-like', 'keep');
    saveOrderAttempt(attempt);
    savePayAttempt(ORDER_1, payAttempt);
    savePayAttempt(ORDER_2, payAttempt);
    clearAllAttempts();
    expect(loadOrderAttempt(NOW)).toBeNull();
    expect(loadPayAttempt(ORDER_1, NOW)).toBeNull();
    expect(loadPayAttempt(ORDER_2, NOW)).toBeNull();
    expect(sessionStorage.getItem('theme-like')).toBe('keep');
  });

  it('W03 AS-32: the "signed-out" auth message deletes every attempt; "signed-in" keeps them', () => {
    const stop = watchAuthForAttempts();
    saveOrderAttempt(attempt);
    savePayAttempt(ORDER_1, payAttempt);
    authHandler?.('signed-in');
    expect(loadOrderAttempt(NOW)).toEqual(attempt);
    authHandler?.('signed-out');
    expect(loadOrderAttempt(NOW)).toBeNull();
    expect(loadPayAttempt(ORDER_1, NOW)).toBeNull();
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('W03 AS-20: storage that throws (private mode, quota) behaves like no storage and never breaks the page', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => saveOrderAttempt(attempt)).not.toThrow();
    expect(loadOrderAttempt(NOW)).toBeNull();
    expect(() => savePayAttempt(ORDER_1, payAttempt)).not.toThrow();
    expect(loadPayAttempt(ORDER_1, NOW)).toBeNull();
    expect(() => clearAllAttempts()).not.toThrow();
  });
});

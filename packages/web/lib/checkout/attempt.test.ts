import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_MAX_AGE_MS,
  acceptNewTotal,
  afterOrderResult,
  afterPayResult,
  attemptForPay,
  attemptForPress,
  cartFingerprint,
  classifyOrderResult,
  parsePayAttempt,
  parseOrderAttempt,
  type OrderAttempt,
} from './attempt';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const K1 = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b';
const K2 = '7a2e3d4c-5b6a-4798-9bac-1d2e3f4a5b6c';
const A = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const B = '4a3c9d2f-6b5e-4f70-8b8c-2d3e4f5a6b7c';

const FP = cartFingerprint([{ productId: A, quantity: 2 }]);
const attempt = (overrides: Partial<OrderAttempt> = {}): OrderAttempt => ({ key: K1, expectedTotalMinor: 3998, cartFingerprint: FP, createdAt: NOW - 60_000, ...overrides });
const press = (stored: OrderAttempt | null, ctx: Partial<{ fingerprint: string; expectedTotalMinor: number; now: number }> = {}) =>
  attemptForPress(stored, { fingerprint: FP, expectedTotalMinor: 3998, now: NOW, newKey: () => K2, ...ctx });

describe('cartFingerprint (W03 data-model "Order attempt")', () => {
  it('W03 AS-19: is the same for the same lines in any order', () => {
    expect(cartFingerprint([{ productId: A, quantity: 2 }, { productId: B, quantity: 1 }])).toBe(cartFingerprint([{ productId: B, quantity: 1 }, { productId: A, quantity: 2 }]));
  });

  it.each([
    ['another quantity', [{ productId: A, quantity: 3 }]],
    ['another product', [{ productId: B, quantity: 2 }]],
    ['an extra line', [{ productId: A, quantity: 2 }, { productId: B, quantity: 1 }]],
    ['no lines', []],
  ])('W03 AS-19: differs for %s', (_label, lines) => {
    expect(cartFingerprint(lines)).not.toBe(FP);
  });

  it('W03 AS-19: does not contain the ids or quantities in the clear', () => {
    expect(FP).not.toContain(A);
    expect(FP).toMatch(/^[0-9a-f]+$/);
  });
});

describe('attemptForPress (W03 UK2, AS-19, AS-20)', () => {
  it('W03 AS-19: the first press creates an attempt with a new key, the expected total and the fingerprint', () => {
    expect(press(null)).toEqual({ key: K2, expectedTotalMinor: 3998, cartFingerprint: FP, createdAt: NOW });
  });

  it('W03 AS-20: a press with a stored attempt for the same cart reuses its key (reload, retry)', () => {
    expect(press(attempt()).key).toBe(K1);
    expect(press(attempt()).createdAt).toBe(NOW - 60_000);
  });

  it('W03 AS-19: a changed cart gets a new key', () => {
    const changed = cartFingerprint([{ productId: A, quantity: 5 }]);
    expect(press(attempt(), { fingerprint: changed })).toEqual({ key: K2, expectedTotalMinor: 3998, cartFingerprint: changed, createdAt: NOW });
  });

  it('W03 AS-19: an attempt older than 24 hours is dropped and a new key is made', () => {
    expect(press(attempt({ createdAt: NOW - ATTEMPT_MAX_AGE_MS - 1 })).key).toBe(K2);
    expect(press(attempt({ createdAt: NOW - ATTEMPT_MAX_AGE_MS })).key).toBe(K1);
  });

  it('W03 AS-19: an attempt that is final (after out_of_stock) is not reused', () => {
    expect(press(attempt({ final: true })).key).toBe(K2);
  });

  it('W03 AS-23: the key stays when the expected total changes (the buyer accepted a new price: no order existed)', () => {
    const accepted = acceptNewTotal(attempt(), 4200);
    expect(accepted).toEqual({ ...attempt(), expectedTotalMinor: 4200 });
    expect(press(accepted, { expectedTotalMinor: 4200 }).key).toBe(K1);
    expect(press(accepted, { expectedTotalMinor: 4200 }).expectedTotalMinor).toBe(4200);
  });

  it('W03 AS-19: a stored attempt whose clock is in the future (clock change) is still reused, never negative-aged away', () => {
    expect(press(attempt({ createdAt: NOW + 5_000 })).key).toBe(K1);
  });
});

describe('classifyOrderResult / afterOrderResult (W03 data-model key lifecycle)', () => {
  type Row = [string, Parameters<typeof classifyOrderResult>[0], 'keep' | 'delete' | 'final'];
  const rows: Row[] = [
    // keep the key
    ['network failure', { ok: false, status: 0 }, 'keep'],
    ['503 checkout_unavailable', { ok: false, status: 503, code: 'checkout_unavailable' }, 'keep'],
    ['409 idempotency_in_flight', { ok: false, status: 409, code: 'idempotency_in_flight' }, 'keep'],
    ['409 price_changed', { ok: false, status: 409, code: 'price_changed' }, 'keep'],
    ['409 checkout_in_progress', { ok: false, status: 409, code: 'checkout_in_progress' }, 'keep'],
    ['401 (press after sign-in again)', { ok: false, status: 401, code: 'session_expired' }, 'keep'],
    ['429 rate_limited', { ok: false, status: 429, code: 'rate_limited' }, 'keep'],
    ['422 flash_sale_limit_exceeded', { ok: false, status: 422, code: 'flash_sale_limit_exceeded' }, 'keep'],
    // the key is spent
    ['422 out_of_stock', { ok: false, status: 422, code: 'out_of_stock' }, 'final'],
    // delete
    ['202', { ok: true }, 'delete'],
    ['422 cart_empty', { ok: false, status: 422, code: 'cart_empty' }, 'delete'],
    ['422 product_unavailable', { ok: false, status: 422, code: 'product_unavailable' }, 'delete'],
    ['422 mixed_currency', { ok: false, status: 422, code: 'mixed_currency' }, 'delete'],
    ['422 idempotency_key_reuse', { ok: false, status: 422, code: 'idempotency_key_reuse' }, 'delete'],
    ['422 idempotency_key_required', { ok: false, status: 422, code: 'idempotency_key_required' }, 'delete'],
    ['422 idempotency_key_invalid', { ok: false, status: 422, code: 'idempotency_key_invalid' }, 'delete'],
    ['400 validation_failed', { ok: false, status: 400, code: 'validation_failed' }, 'delete'],
    ['500', { ok: false, status: 500 }, 'delete'],
    ['502', { ok: false, status: 502 }, 'delete'],
  ];

  it.each(rows)('W03 AS-19/AS-31: %s -> %s', (_label, result, expected) => {
    expect(classifyOrderResult(result)).toBe(expected);
    const next = afterOrderResult(attempt(), result);
    if (expected === 'keep') expect(next).toEqual(attempt());
    if (expected === 'delete') expect(next).toBeNull();
    if (expected === 'final') expect(next).toEqual({ ...attempt(), final: true });
  });

  it('W03 AS-24: after out_of_stock the next press makes a new key (the old one is final for that key)', () => {
    const spent = afterOrderResult(attempt(), { ok: false, status: 422, code: 'out_of_stock' });
    expect(press(spent).key).toBe(K2);
  });

  it('W03 AS-20: after a network failure the next press reuses the same key', () => {
    const kept = afterOrderResult(attempt(), { ok: false, status: 0 });
    expect(press(kept).key).toBe(K1);
  });

  it('W03 AS-32: a 401 keeps the key, and after signing in with an unchanged cart the same key is used', () => {
    const kept = afterOrderResult(attempt(), { ok: false, status: 401, code: 'unauthenticated' });
    expect(press(kept).key).toBe(K1);
  });

  it('W03 AS-19: with no stored attempt the result changes nothing', () => {
    expect(afterOrderResult(null, { ok: false, status: 0 })).toBeNull();
  });
});

describe('storage parsing (W03 UK2)', () => {
  it('W03 AS-20: a stored order attempt round-trips through JSON', () => {
    expect(parseOrderAttempt(JSON.stringify(attempt()))).toEqual(attempt());
    expect(parseOrderAttempt(JSON.stringify({ ...attempt(), final: true }))).toEqual({ ...attempt(), final: true });
  });

  it.each([
    ['null', null],
    ['not JSON', '{nope'],
    ['not an object', '"x"'],
    ['key is not a UUID', JSON.stringify({ ...attempt(), key: 'abc' })],
    ['float total', JSON.stringify({ ...attempt(), expectedTotalMinor: 1.5 })],
    ['negative total', JSON.stringify({ ...attempt(), expectedTotalMinor: -1 })],
    ['missing fingerprint', JSON.stringify({ key: K1, expectedTotalMinor: 1, createdAt: NOW })],
    ['createdAt is a string', JSON.stringify({ ...attempt(), createdAt: 'yesterday' })],
  ])('W03 AS-20: %s is not an attempt', (_label, raw) => {
    expect(parseOrderAttempt(raw as string | null)).toBeNull();
  });

  it('W03 AS-47: a stored pay attempt round-trips and rejects junk', () => {
    const stored = { key: K1, paymentMethodId: 'pm_card_visa', createdAt: NOW };
    expect(parsePayAttempt(JSON.stringify(stored))).toEqual(stored);
    expect(parsePayAttempt(JSON.stringify({ ...stored, key: 'x' }))).toBeNull();
    expect(parsePayAttempt(JSON.stringify({ key: K1, createdAt: NOW }))).toBeNull();
    expect(parsePayAttempt(null)).toBeNull();
  });
});

describe('pay attempts (W03 UK2, AS-47)', () => {
  const ctx = (paymentMethodId: string, now = NOW) => ({ paymentMethodId, now, newKey: () => K2 });
  const stored = { key: K1, paymentMethodId: 'pm_a', createdAt: NOW - 1000 };

  it('W03 AS-47: the first pay press creates an attempt', () => {
    expect(attemptForPay(null, ctx('pm_a'))).toEqual({ key: K2, paymentMethodId: 'pm_a', createdAt: NOW });
  });

  it('W03 AS-47: a double press or a reload with the same method token reuses the key', () => {
    expect(attemptForPay(stored, ctx('pm_a')).key).toBe(K1);
  });

  it('W03 AS-47: a new method token gets a new key', () => {
    expect(attemptForPay(stored, ctx('pm_b'))).toEqual({ key: K2, paymentMethodId: 'pm_b', createdAt: NOW });
  });

  it('W03 AS-47: an attempt older than 24 hours is replaced', () => {
    expect(attemptForPay({ ...stored, createdAt: NOW - ATTEMPT_MAX_AGE_MS - 1 }, ctx('pm_a')).key).toBe(K2);
  });

  it.each([
    ['422 idempotency_key_reuse', { ok: false, status: 422, code: 'idempotency_key_reuse' }, 'delete'],
    ['422 idempotency_key_required', { ok: false, status: 422, code: 'idempotency_key_required' }, 'delete'],
    ['400 validation_failed', { ok: false, status: 400, code: 'validation_failed' }, 'delete'],
    ['422 amount_out_of_range', { ok: false, status: 422, code: 'amount_out_of_range' }, 'delete'],
    ['422 currency_unsupported', { ok: false, status: 422, code: 'currency_unsupported' }, 'delete'],
    ['202', { ok: true }, 'keep'],
    ['network failure', { ok: false, status: 0 }, 'keep'],
    ['409 idempotency_in_flight', { ok: false, status: 409, code: 'idempotency_in_flight' }, 'keep'],
    ['409 payment_already_exists', { ok: false, status: 409, code: 'payment_already_exists' }, 'keep'],
    ['404 order_not_found (ledger lag)', { ok: false, status: 404, code: 'order_not_found' }, 'keep'],
    ['429', { ok: false, status: 429, code: 'rate_limited' }, 'keep'],
    ['503', { ok: false, status: 503 }, 'keep'],
    ['500', { ok: false, status: 500 }, 'delete'],
  ] as const)('W03 AS-44: pay result %s -> %s', (_label, result, expected) => {
    const next = afterPayResult(stored, result);
    if (expected === 'delete') expect(next).toBeNull();
    else expect(next).toEqual(stored);
  });
});
